param (
    # No longer mandatory: omitting it starts the viewer (webserver + browser) straight
    # from existing snapshots, without running a crawl first - see the server-only branch
    # below. Pass it when you actually want a fresh crawl.
    [Parameter(HelpMessage="Starting IP address of the first switch - omit to launch the viewer against existing snapshots without crawling")]
    [string]$SwitchIP,

    [string[]]$AllowedScopes = @("131.30."),

    [int]$MaxConcurrent = 10,
    [switch]$Log,
    # Output encryption is on by default (topology, clients, and full device config
    # backups are sensitive enough that "on unless you opt in" was the wrong default).
    # Pass this to disable encryption entirely: no encryption-password prompt at all, THIS
    # run's topology output is written as plain .json, and Juniper credentials/app settings
    # are read from and saved to a plaintext Configuration.json instead of
    # Configuration.json.enc. An existing Configuration.json.enc from a non--NoEncryption
    # run is simply ignored (different filename) rather than migrated.
    [switch]$NoEncryption,

    # Bound to localhost only - see WebServer.ps1's header comment for why LAN
    # exposure was deliberately ruled out rather than gated behind auth.
    [int]$WebPort = 8787
)

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
$WorkerPath = Join-Path $ScriptDir "lib\Get-JunosNodeData.ps1"
$ConnectScriptPath = Join-Path $ScriptDir "lib\Connect-Switch.ps1"
# web-src/ (the multi-file visualizer source tree) is a sibling of this script - not shipped
# in a release, which is only ever Start-NetworkMapper.ps1 + lib/ (see lib/Network_Visualizer.html
# below).
$VisualizerRoot = Join-Path $ScriptDir "web-src"
# Portable/release deployment: web-src/tools/build-inline.mjs produces a single, genuinely
# self-contained lib/Network_Visualizer.html (no external .js/.css/image files at all - see
# that script's own header comment). A release ships only this script + lib/ (which
# includes that built file), never web-src/ - so $SingleFileVisualizerPath is what a real
# release actually serves from. Detected here, not hardcoded to always prefer it, so a full
# dev checkout (both web-src/ and lib/Network_Visualizer.html present) keeps using the
# multi-file $VisualizerRoot exactly as before. Start-MapperWebServer serves it directly,
# scoped to this one path (see its own SingleFileVisualizerPath handling) - never by
# widening $VisualizerRoot to $ScriptDir, which would expose every other file in lib/
# (the *.ps1 source itself, Mapper_Debug.log, ...) to any browser that can reach this server.
$SingleFileVisualizerPath = Join-Path $ScriptDir "lib\Network_Visualizer.html"
if (Test-Path $SingleFileVisualizerPath -PathType Leaf) {
    Write-Host "Using portable single-file visualizer: $SingleFileVisualizerPath" -ForegroundColor Cyan
} else {
    $SingleFileVisualizerPath = $null
}
# Juniper credentials + app settings live next to this script: Configuration.json.enc
# normally, or a plaintext Configuration.json under -NoEncryption (a distinct filename so
# the two modes never collide or get silently migrated into each other).
$ConfigPath = Join-Path $ScriptDir $(if ($NoEncryption) { "Configuration.json" } else { "Configuration.json.enc" })
. (Join-Path $ScriptDir "lib\WebServer.ps1")
. (Join-Path $ScriptDir "lib\TopologyCrypto.ps1")
$DebugLog = Join-Path $ScriptDir "Mapper_Debug.log"
# Snapshots live in the sibling Network_Maps/ folder.
$SnapshotDir = Join-Path $ScriptDir "Network_Maps"
if (-not (Test-Path $SnapshotDir)) { New-Item -ItemType Directory -Path $SnapshotDir -Force | Out-Null }

# Converts a SecureString to plaintext - the standard cross-runtime idiom (works
# identically on Windows PowerShell 5.1 and pwsh 7+, unlike manually marshaling the BSTR,
# which needs its own explicit ZeroFreeBSTR cleanup to avoid a leak).
function ConvertFrom-SecurePassword {
    param([Parameter(Mandatory=$true)][securestring]$SecureString)
    return [System.Net.NetworkCredential]::new('', $SecureString).Password
}

$EncryptionPassword = $null
$JunosUsername = $null
$JunosPassword = $null

if ($NoEncryption) {
    # No password prompt at all - Configuration.json is read (and later saved) as plain
    # JSON, no envelope/decrypt step involved.
    if (Test-Path $ConfigPath) {
        try {
            # -Encoding UTF8 explicit - see Invoke-GetConfigAction's (WebServer.ps1) own
            # comment on this same class of bug: Get-Content -Raw with no -Encoding falls
            # back to the system ANSI codepage on a BOM-less file, silently corrupting any
            # non-ASCII Building/Room/Notes text a -NoEncryption Configuration.json can hold.
            $ConfigParsed = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($ConfigParsed.credentials) {
                $JunosUsername = $ConfigParsed.credentials.username
                $JunosPassword = $ConfigParsed.credentials.password
            }
        } catch {
            Write-Host "Failed to read Configuration.json: $_" -ForegroundColor Red
        }
    }
} else {
    # Always interactively entered, in BOTH crawl and server-only modes.
    # Configuration.json.enc (Juniper credentials + app settings) lives ONLY behind this
    # password; there is no file-based fallback anymore (Auth.json is gone).
    Write-Host ""
    # Re-prompted rather than accepted: Read-Host -AsSecureString happily returns an empty
    # SecureString for a bare Enter, and an empty password reaches Start-MapperWebServer
    # (and, in crawl mode, the PBKDF2 key derivation) as a value nothing downstream can do
    # anything useful with - previously surfacing as a raw parameter-binding error instead
    # of a readable message.
    do {
        $EncryptionPassword = ConvertFrom-SecurePassword -SecureString (Read-Host -Prompt "Enter encryption password" -AsSecureString)
        if ([string]::IsNullOrEmpty($EncryptionPassword)) { Write-Host "Password cannot be empty." -ForegroundColor Red }
    } while ([string]::IsNullOrEmpty($EncryptionPassword))

    if (Test-Path $ConfigPath) {
        $Attempts = 0
        $DecryptedConfigJson = $null
        while ($null -eq $DecryptedConfigJson -and $Attempts -lt 3) {
            $Attempts++
            try {
                # -Encoding UTF8 explicit, same reasoning as the -NoEncryption branch above -
                # the envelope's own JSON fields (salt/iv/mac/ciphertext) are pure base64/
                # ASCII so this specific read can't itself corrupt them, but a consistent
                # encoding here is still correct and cheap insurance against this file ever
                # gaining a non-ASCII field.
                $Envelope = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
                $DecryptedConfigJson = Unprotect-TopologyPayload -Envelope $Envelope -Password $EncryptionPassword -ExpectedFormats @("PSNetworkMapper-EncryptedConfig")
            } catch {
                Write-Host "Failed to decrypt Configuration.json.enc: $_" -ForegroundColor Red
                if ($Attempts -lt 3) {
                    $EncryptionPassword = ConvertFrom-SecurePassword -SecureString (Read-Host -Prompt "Re-enter encryption password (attempt $($Attempts + 1) of 3)" -AsSecureString)
                }
            }
        }

        if ($DecryptedConfigJson) {
            $ConfigParsed = $DecryptedConfigJson | ConvertFrom-Json
            if ($ConfigParsed.credentials) {
                $JunosUsername = $ConfigParsed.credentials.username
                $JunosPassword = $ConfigParsed.credentials.password
            }
        } else {
            Write-Host "`nCould not decrypt Configuration.json.enc after $Attempts attempt(s)." -ForegroundColor Yellow
            $Continue = Read-Host "Continue without server-side Juniper credentials/settings? (y/N)"
            if ($Continue -notmatch '^(?i)y') { throw "Aborted: could not decrypt Configuration.json.enc." }

            # The password just typed failed to decrypt the file 3 times in a row - it's proven
            # wrong (or the file is corrupted), so it must not be allowed to silently REWRITE the
            # file under that wrong password the next time something calls /api/save-config. Blank
            # it; Invoke-SaveConfigAction (WebServer.ps1) refuses to save when this is empty.
            $EncryptionPassword = $null
        }
    }
}

# --- Output Encryption (AES-256-CBC, encrypt-then-MAC with HMAC-SHA256) ---
# Deliberately avoids AesGcm: it's .NET Core/5+ only, and this script also has to run
# under Windows PowerShell 5.1 (.NET Framework), which doesn't have it. CBC+HMAC needs
# nothing beyond Aes/Rfc2898DeriveBytes/HMACSHA256, all present on both runtimes, and
# both algorithms are natively available in the browser's Web Crypto API on the
# Network_Visualizer side, which decrypts this same format.
# Shared with WebServer.ps1's /api/save-config via TopologyCrypto.ps1's
# Get-TopologyPbkdf2Iterations (dot-sourced above) - see that function's own comment for the
# OWASP guidance and why this isn't a local literal.
# Runs unconditionally (both crawl mode and server-only mode) so a browser-triggered scan
# from server-only mode also has key material available to hand to Invoke-FleetCrawl.
# Guarded on $EncryptionPassword being non-empty, not just -NoEncryption: that guard is
# reachable now that this runs before the server-only early return (previously it wasn't -
# crawl mode's credential check threw first, and server-only mode returned before this ever
# ran) - the decrypt-failure-continue path above (line ~104) can leave $EncryptionPassword
# $null, and Get-TopologyKeyMaterial's -Password is Mandatory=$true, so an unguarded call
# would be a terminating parameter-binding error instead of "viewer launches unencrypted."
$PBKDF2_ITERATIONS = Get-TopologyPbkdf2Iterations
$EncKeyBytes = $null; $MacKeyBytes = $null; $SaltBytes = $null

if (-not $NoEncryption -and $EncryptionPassword) {
    Write-Host "Output encryption enabled - Network_Visualizer will prompt for this same password when the file is opened." -ForegroundColor Yellow

    $SaltBytes = [byte[]]::new(16)
    $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $Rng.GetBytes($SaltBytes)
    $Rng.Dispose()

    $KeyMaterial = Get-TopologyKeyMaterial -Password $EncryptionPassword -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS
    $EncKeyBytes = $KeyMaterial.EncKey
    $MacKeyBytes = $KeyMaterial.MacKey
}

# Server-only launch: no -SwitchIP means "just show me the viewer", not "crawl the
# fleet". Proceeds regardless of whether Juniper credentials are present - browsing
# existing snapshots needs no switch credentials at all, and Invoke-ConnectAction/
# Invoke-RescanAction already fail cleanly (pointing at the Settings tab) if the browser
# tries an action that needs them.
if (-not $SwitchIP) {
    Start-MapperWebServer -NoEncryption:$NoEncryption -VisualizerRoot $VisualizerRoot -SingleFileVisualizerPath $SingleFileVisualizerPath -ConnectScriptPath $ConnectScriptPath -WorkerPath $WorkerPath -Port $WebPort -ConfigPath $ConfigPath -EncryptionPassword $EncryptionPassword -JunosUsername $JunosUsername -JunosPassword $JunosPassword -MaxConcurrent $MaxConcurrent -AllowedScopes $AllowedScopes -SnapshotDir $SnapshotDir -EncKey $EncKeyBytes -MacKey $MacKeyBytes -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS
    return
}

# Crawling every device needs SSH credentials; there is no partial crawl to attempt
# without them, and this holds regardless of -NoEncryption (that flag only affects
# topology-write encryption, not whether credentials are needed to crawl at all).
if (-not $JunosUsername -or -not $JunosPassword) {
    throw "No Juniper login configured - set it in the Settings tab of the web viewer, then run a crawl."
}

Write-Host "Initializing Enterprise Orchestrator starting at $SwitchIP..." -ForegroundColor Cyan
if ($Log) { Write-Host "[LOGGING ENABLED] Raw payloads will be saved to .\RawDumps\" -ForegroundColor Yellow }

. (Join-Path $ScriptDir "lib\FleetCrawl.ps1")

if (-not (Test-Path $WorkerPath)) { Write-Host "Worker script missing at $WorkerPath!" -ForegroundColor Red; exit }

$CrawlProgress = @{}  # unused by the CLI path (nothing polls it) - passed only because Invoke-FleetCrawl requires it
$CrawlResult = Invoke-FleetCrawl -StartIP $SwitchIP -AllowedScopes $AllowedScopes -MaxConcurrent $MaxConcurrent `
    -WorkerPath $WorkerPath -Username $JunosUsername -Password $JunosPassword `
    -SnapshotDir $SnapshotDir -ProgressTable $CrawlProgress `
    -EncKey $EncKeyBytes -MacKey $MacKeyBytes -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS `
    -DebugLogPath $DebugLog -Log:$Log

# Once the crawl is done, launch the viewer: start the local webserver and open the
# default browser to it. Runs after the crawl (not instead of it) so the freshly-written
# snapshot is immediately available to "Load Folder of Snapshots" without a manual step -
# this call blocks (serving requests) until Ctrl+C.
Start-MapperWebServer -NoEncryption:$NoEncryption -VisualizerRoot $VisualizerRoot -SingleFileVisualizerPath $SingleFileVisualizerPath -ConnectScriptPath $ConnectScriptPath -WorkerPath $WorkerPath -Port $WebPort -ConfigPath $ConfigPath -EncryptionPassword $EncryptionPassword -JunosUsername $JunosUsername -JunosPassword $JunosPassword -MaxConcurrent $MaxConcurrent -AllowedScopes $AllowedScopes -SnapshotDir $SnapshotDir -EncKey $EncKeyBytes -MacKey $MacKeyBytes -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS

param (
    # Omit to launch the viewer against existing snapshots without crawling.
    [Parameter(HelpMessage="Starting IP address of the first switch - omit to launch the viewer against existing snapshots without crawling")]
    [string]$SwitchIP,

    [string[]]$AllowedScopes = @("131.30."),

    [ValidateRange(1, 64)]
    [int]$MaxConcurrent = 10,
    [switch]$Log,
    # Encryption is on by default. Disables it entirely: topology written as plain .json,
    # credentials/settings read from and saved to plaintext Configuration.json instead of
    # Configuration.json.enc (an existing .enc is simply ignored, not migrated).
    [switch]$NoEncryption,

    # Bound to localhost only - see WebServer.ps1's header comment.
    [int]$WebPort = 8787
)

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
$WorkerPath = Join-Path $ScriptDir "lib\Get-JunosNodeData.ps1"
$ConnectScriptPath = Join-Path $ScriptDir "lib\Connect-Switch.ps1"
# web-src/ (multi-file visualizer source) is a dev-only sibling; a release ships only this
# script + lib/ (including the built Network_Visualizer.html below).
$VisualizerRoot = Join-Path $ScriptDir "web-src"
# Prefer the built single-file visualizer if present (a real release); otherwise fall back to
# the multi-file $VisualizerRoot for a dev checkout. Served scoped to this one path, never by
# widening $VisualizerRoot to $ScriptDir, which would expose lib/'s *.ps1 source and logs too.
$SingleFileVisualizerPath = Join-Path $ScriptDir "lib\Network_Visualizer.html"
if (Test-Path $SingleFileVisualizerPath -PathType Leaf) {
    Write-Host "Using portable single-file visualizer: $SingleFileVisualizerPath" -ForegroundColor Cyan
} else {
    $SingleFileVisualizerPath = $null
}
# Configuration.json.enc normally, or plaintext Configuration.json under -NoEncryption -
# distinct filenames so the two modes never collide or silently migrate into each other.
$ConfigPath = Join-Path $ScriptDir $(if ($NoEncryption) { "Configuration.json" } else { "Configuration.json.enc" })
. (Join-Path $ScriptDir "lib\WebServer.ps1")
. (Join-Path $ScriptDir "lib\TopologyCrypto.ps1")
$DebugLog = Join-Path $ScriptDir "Mapper_Debug.log"
# Snapshots live in the sibling Network_Maps/ folder.
$SnapshotDir = Join-Path $ScriptDir "Network_Maps"
if (-not (Test-Path $SnapshotDir)) { New-Item -ItemType Directory -Path $SnapshotDir -Force | Out-Null }

# Converts a SecureString to plaintext - works identically on Windows PowerShell 5.1 and
# pwsh 7+, unlike manually marshaling the BSTR (which needs its own ZeroFreeBSTR cleanup).
function ConvertFrom-SecurePassword {
    param([Parameter(Mandatory=$true)][securestring]$SecureString)
    return [System.Net.NetworkCredential]::new('', $SecureString).Password
}

$EncryptionPassword = $null
$JunosUsername = $null
$JunosPassword = $null

if ($NoEncryption) {
    if (Test-Path $ConfigPath) {
        try {
            # -Encoding UTF8 explicit: Get-Content -Raw with no -Encoding falls back to the
            # system ANSI codepage on a BOM-less file, corrupting non-ASCII text.
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
    # Always interactively entered, in both crawl and server-only modes - there is no
    # file-based fallback.
    Write-Host ""
    # Re-prompt on empty input - Read-Host -AsSecureString happily accepts a bare Enter,
    # and an empty password breaks downstream key derivation with an unreadable error.
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
                # -Encoding UTF8 explicit for consistency, same as the -NoEncryption branch.
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

            # Blank the password so it can't silently rewrite the file on the next
            # /api/save-config call; Invoke-SaveConfigAction refuses to save when this is empty.
            $EncryptionPassword = $null
        }
    }
}

# --- Output Encryption (AES-256-CBC, encrypt-then-MAC with HMAC-SHA256) ---
# Avoids AesGcm (.NET Core/5+ only) since this must also run under Windows PowerShell 5.1
# (.NET Framework). CBC+HMAC works on both runtimes and is natively available in the
# browser's Web Crypto API on the Network_Visualizer side that decrypts this format.
# Runs unconditionally (crawl and server-only modes) so a browser-triggered scan from
# server-only mode also has key material for Invoke-FleetCrawl. Guarded on
# $EncryptionPassword being non-empty (not just -NoEncryption) since the decrypt-failure
# path above can leave it $null, and Get-TopologyKeyMaterial's -Password is Mandatory.
$PBKDF2_ITERATIONS = Get-TopologyPbkdf2Iterations
$EncKeyBytes = $null; $MacKeyBytes = $null; $SaltBytes = $null

if (-not $NoEncryption -and $EncryptionPassword) {
    Write-Host "Output encryption enabled - the viewer will use this password automatically while this server is running; opening the file elsewhere (or after a restart) will prompt for it." -ForegroundColor Yellow

    $SaltBytes = [byte[]]::new(16)
    $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $Rng.GetBytes($SaltBytes)
    $Rng.Dispose()

    $KeyMaterial = Get-TopologyKeyMaterial -Password $EncryptionPassword -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS
    $EncKeyBytes = $KeyMaterial.EncKey
    $MacKeyBytes = $KeyMaterial.MacKey
}

# Server-only launch: no -SwitchIP means "just show me the viewer". Proceeds regardless of
# credentials - browsing snapshots needs none, and Invoke-ConnectAction/Invoke-RescanAction
# fail cleanly pointing at the Settings tab if the browser tries an action that needs them.
if (-not $SwitchIP) {
    Start-MapperWebServer -NoEncryption:$NoEncryption -VisualizerRoot $VisualizerRoot -SingleFileVisualizerPath $SingleFileVisualizerPath -ConnectScriptPath $ConnectScriptPath -WorkerPath $WorkerPath -Port $WebPort -ConfigPath $ConfigPath -EncryptionPassword $EncryptionPassword -JunosUsername $JunosUsername -JunosPassword $JunosPassword -MaxConcurrent $MaxConcurrent -AllowedScopes $AllowedScopes -SnapshotDir $SnapshotDir -EncKey $EncKeyBytes -MacKey $MacKeyBytes -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS -DebugLogPath $DebugLog
    return
}

# Crawling needs SSH credentials regardless of -NoEncryption (which only affects
# topology-write encryption).
if (-not $JunosUsername -or -not $JunosPassword) {
    throw "No Juniper login configured - set it in the Settings tab of the web viewer, then run a crawl."
}

Write-Host "Initializing Enterprise Orchestrator starting at $SwitchIP..." -ForegroundColor Cyan
if ($Log) { Write-Host "[LOGGING ENABLED] Raw payloads will be saved to .\RawDumps\" -ForegroundColor Yellow }

. (Join-Path $ScriptDir "lib\FleetCrawl.ps1")

# AllowedScopes is enforced on every crawl-discovered neighbor IP (FleetCrawl.ps1's
# Test-IpInAllowedScopes) and on the web UI's manual-entry equivalents (WebServer.ps1's
# /api/scan-network and /api/rescan) - this CLI entry point must be held to the same fence,
# or a typo'd/out-of-scope -SwitchIP would reach an SSH login with saved credentials before
# the crawl ever gets a chance to apply scope filtering.
if (-not (Test-IpInAllowedScopes -IP $SwitchIP -AllowedScopes $AllowedScopes)) {
    Write-Host "SwitchIP '$SwitchIP' is outside the configured AllowedScopes ($($AllowedScopes -join ', ')). Adjust -AllowedScopes if this IP should be permitted." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $WorkerPath)) { Write-Host "Worker script missing at $WorkerPath!" -ForegroundColor Red; exit }

$CrawlProgress = @{}  # unused by the CLI path - passed only because Invoke-FleetCrawl requires it
$CrawlResult = Invoke-FleetCrawl -StartIP $SwitchIP -AllowedScopes $AllowedScopes -MaxConcurrent $MaxConcurrent `
    -WorkerPath $WorkerPath -Username $JunosUsername -Password $JunosPassword `
    -SnapshotDir $SnapshotDir -ProgressTable $CrawlProgress `
    -EncKey $EncKeyBytes -MacKey $MacKeyBytes -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS `
    -DebugLogPath $DebugLog -Log:$Log

# Launch the viewer after the crawl so the freshly-written snapshot is immediately
# available; blocks serving requests until Ctrl+C.
Start-MapperWebServer -NoEncryption:$NoEncryption -VisualizerRoot $VisualizerRoot -SingleFileVisualizerPath $SingleFileVisualizerPath -ConnectScriptPath $ConnectScriptPath -WorkerPath $WorkerPath -Port $WebPort -ConfigPath $ConfigPath -EncryptionPassword $EncryptionPassword -JunosUsername $JunosUsername -JunosPassword $JunosPassword -MaxConcurrent $MaxConcurrent -AllowedScopes $AllowedScopes -SnapshotDir $SnapshotDir -EncKey $EncKeyBytes -MacKey $MacKeyBytes -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS -DebugLogPath $DebugLog

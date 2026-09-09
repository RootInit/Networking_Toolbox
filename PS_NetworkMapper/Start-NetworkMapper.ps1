param (
    # Omit to launch the viewer against existing snapshots without crawling.
    [Parameter(HelpMessage="Starting IP address of the first switch - omit to launch the viewer against existing snapshots without crawling")]
    [string]$SwitchIP,

    [string[]]$AllowedScopes = @("131.30."),

    [ValidateRange(1, 64)]
    [int]$MaxConcurrent = 25,
    [switch]$Log,
    # Encryption is on by default. Disabling it writes plain .json topology and reads/saves a
    # plaintext Configuration.json; an existing .enc is ignored, not migrated.
    [switch]$NoEncryption,

    # Bound to localhost only - see WebServer.ps1's header comment.
    [int]$WebPort = 8787
)

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
$WorkerPath = Join-Path $ScriptDir "lib\Get-JunosNodeData.ps1"
$ConnectScriptPath = Join-Path $ScriptDir "lib\Connect-Switch.ps1"
# web-src/ (multi-file visualizer source) is a dev-only sibling; a release ships only this
# script + lib/, including the built Network_Visualizer.html preferred below.
$VisualizerRoot = Join-Path $ScriptDir "web-src"
# Served scoped to this one path - never widen $VisualizerRoot to $ScriptDir, which would
# expose lib/'s *.ps1 source and logs too.
$SingleFileVisualizerPath = Join-Path $ScriptDir "lib\Network_Visualizer.html"
if (Test-Path $SingleFileVisualizerPath -PathType Leaf) {
    Write-Host "Using portable single-file visualizer: $SingleFileVisualizerPath" -ForegroundColor Cyan
} else {
    $SingleFileVisualizerPath = $null
}
# Distinct filenames per mode so the two never collide or silently migrate into each other.
$ConfigPath = Join-Path $ScriptDir $(if ($NoEncryption) { "Configuration.json" } else { "Configuration.json.enc" })
. (Join-Path $ScriptDir "lib\WebServer.ps1")
. (Join-Path $ScriptDir "lib\TopologyCrypto.ps1")
$DebugLog = Join-Path $ScriptDir "Mapper_Debug.log"
$SnapshotDir = Join-Path $ScriptDir "Network_Maps"
if (-not (Test-Path $SnapshotDir)) { New-Item -ItemType Directory -Path $SnapshotDir -Force | Out-Null }

# Works identically on Windows PowerShell 5.1 and pwsh 7+, unlike manually marshaling the
# BSTR (which needs its own ZeroFreeBSTR cleanup).
function ConvertFrom-SecurePassword {
    param([Parameter(Mandatory=$true)][securestring]$SecureString)
    return [System.Net.NetworkCredential]::new('', $SecureString).Password
}

$EncryptionPassword = $null
# Normally the same string as $EncryptionPassword. Kept separate because the two protect
# different things: $EncryptionPassword also gates rewriting Configuration.json.enc, so the
# decrypt-failure path below has to blank that one while snapshot encryption stays on.
$SnapshotEncryptionPassword = $null
$JunosUsername = $null
$JunosPassword = $null

if ($NoEncryption) {
    if (Test-Path $ConfigPath) {
        try {
            # -Encoding UTF8 explicit: Get-Content -Raw without it falls back to the system
            # ANSI codepage on a BOM-less file, corrupting non-ASCII text.
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
    # Before the prompt, so an unsupported runtime says so once instead of failing key
    # derivation after the operator has typed a password.
    Assert-TopologyCryptoRuntime

    # Always interactively entered, in both crawl and server-only modes - there is no
    # file-based fallback.
    Write-Host ""
    # Read-Host -AsSecureString accepts a bare Enter, and an empty password breaks downstream
    # key derivation with an unreadable error.
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

            # Snapshot encryption gets its own password instead of inheriting the blanking.
            # Otherwise no key material is derived, Invoke-FleetCrawl sees no -EncKey and writes
            # snapshots - every device's full unredacted "show configuration | display set",
            # RADIUS/TACACS+/SNMP secrets included - as plaintext, which is not what the operator
            # consented to by giving up server-side credentials.
            Write-Host "Configuration.json.enc will be left untouched. New snapshots are still encrypted, but with a separate password the viewer will prompt you for." -ForegroundColor Yellow
            do {
                $SnapshotEncryptionPassword = ConvertFrom-SecurePassword -SecureString (Read-Host -Prompt "Enter a password to encrypt new snapshots with" -AsSecureString)
                if ([string]::IsNullOrEmpty($SnapshotEncryptionPassword)) { Write-Host "Password cannot be empty." -ForegroundColor Red }
            } while ([string]::IsNullOrEmpty($SnapshotEncryptionPassword))
        }
    }
}

# --- Output Encryption (AES-256-CBC, encrypt-then-MAC with HMAC-SHA256) ---
# AesGcm is .NET Core/5+ only; this must also run under Windows PowerShell 5.1 (.NET
# Framework). CBC+HMAC works on both runtimes and on the browser's Web Crypto API, which
# decrypts this format on the Network_Visualizer side.
# Runs in server-only mode too, so a browser-triggered scan has key material for
# Invoke-FleetCrawl.
$PBKDF2_ITERATIONS = Get-TopologyPbkdf2Iterations
$EncKeyBytes = $null; $MacKeyBytes = $null; $SaltBytes = $null

if (-not $NoEncryption -and -not $SnapshotEncryptionPassword) { $SnapshotEncryptionPassword = $EncryptionPassword }
if (-not $NoEncryption -and $SnapshotEncryptionPassword) {
    # Only $EncryptionPassword reaches /api/session-password, so on the config-decrypt-failure
    # path (where it is blanked) the viewer has to prompt even in this session.
    if ($EncryptionPassword) {
        Write-Host "Output encryption enabled - the viewer will use this password automatically while this server is running; opening the file elsewhere (or after a restart) will prompt for it." -ForegroundColor Yellow
    } else {
        Write-Host "Output encryption enabled - the viewer will prompt for this password when opening a snapshot." -ForegroundColor Yellow
    }

    $SaltBytes = [byte[]]::new(16)
    $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $Rng.GetBytes($SaltBytes)
    $Rng.Dispose()

    $KeyMaterial = Get-TopologyKeyMaterial -Password $SnapshotEncryptionPassword -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS
    $EncKeyBytes = $KeyMaterial.EncKey
    $MacKeyBytes = $KeyMaterial.MacKey
}

# Server-only launch. Proceeds regardless of credentials - browsing snapshots needs none, and
# the actions that do need them fail cleanly pointing at the Settings tab.
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

# Same fence the crawl and the web UI's manual-entry paths apply: without it a typo'd
# out-of-scope -SwitchIP reaches an SSH login with saved credentials before the crawl ever
# gets a chance to filter it.
if (-not (Test-IpInAllowedScopes -IP $SwitchIP -AllowedScopes $AllowedScopes)) {
    Write-Host "SwitchIP '$SwitchIP' is outside the configured AllowedScopes ($($AllowedScopes -join ', ')). Adjust -AllowedScopes if this IP should be permitted." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $WorkerPath)) { Write-Host "Worker script missing at $WorkerPath!" -ForegroundColor Red; exit 1 }

# Fail closed rather than downgrading: Invoke-FleetCrawl treats absent key material as "write
# plaintext", so reaching it without keys but also without -NoEncryption would dump every
# device's full configuration unencrypted. Only -NoEncryption may do that, and it must be
# asked for explicitly.
if (-not $NoEncryption -and -not $EncKeyBytes) {
    throw "Refusing to crawl: snapshot encryption was requested but no key material could be derived. Re-run and supply an encryption password, or pass -NoEncryption to write plaintext snapshots deliberately."
}

$CrawlProgress = @{}  # unused by the CLI path - passed only because Invoke-FleetCrawl requires it
$CrawlResult = Invoke-FleetCrawl -StartIP $SwitchIP -AllowedScopes $AllowedScopes -MaxConcurrent $MaxConcurrent `
    -WorkerPath $WorkerPath -Username $JunosUsername -Password $JunosPassword `
    -SnapshotDir $SnapshotDir -ProgressTable $CrawlProgress `
    -EncKey $EncKeyBytes -MacKey $MacKeyBytes -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS `
    -DebugLogPath $DebugLog -Log:$Log

# Blocks serving requests until Ctrl+C.
Start-MapperWebServer -NoEncryption:$NoEncryption -VisualizerRoot $VisualizerRoot -SingleFileVisualizerPath $SingleFileVisualizerPath -ConnectScriptPath $ConnectScriptPath -WorkerPath $WorkerPath -Port $WebPort -ConfigPath $ConfigPath -EncryptionPassword $EncryptionPassword -JunosUsername $JunosUsername -JunosPassword $JunosPassword -MaxConcurrent $MaxConcurrent -AllowedScopes $AllowedScopes -SnapshotDir $SnapshotDir -EncKey $EncKeyBytes -MacKey $MacKeyBytes -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS -DebugLogPath $DebugLog

param (
    # Omit to launch the viewer against existing snapshots without crawling.
    [Parameter(HelpMessage="Starting IP address of the first switch - omit to launch the viewer against existing snapshots without crawling")]
    [string]$SwitchIP,

    [string[]]$AllowedScopes = @("131.30."),

    [ValidateRange(1, 64)]
    [int]$MaxConcurrent = 25,
    [switch]$Log,
    # Disabling encryption writes plain .json and uses a plaintext Configuration.json; an existing
    # .enc is ignored, not migrated.
    [switch]$NoEncryption,

    # Bound to localhost only - see WebServer.ps1's header comment.
    [int]$WebPort = 8787
)

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
$WorkerPath = Join-Path $ScriptDir "lib\Get-JunosNodeData.ps1"
$ConnectScriptPath = Join-Path $ScriptDir "lib\Connect-Switch.ps1"
# web-src/ is a dev-only sibling; a release ships only this script + lib/.
$VisualizerRoot = Join-Path $ScriptDir "web-src"
# Scoped to this one path - never widen to $ScriptDir, which would expose lib/'s *.ps1 and logs.
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

# Works on 5.1 and pwsh 7+, unlike manually marshaling the BSTR.
function ConvertFrom-SecurePassword {
    param([Parameter(Mandatory=$true)][securestring]$SecureString)
    return [System.Net.NetworkCredential]::new('', $SecureString).Password
}

$EncryptionPassword = $null
# Normally the same string as $EncryptionPassword, but kept separate: that one also gates rewriting
# Configuration.json.enc, so the decrypt-failure path blanks it while snapshot encryption stays on.
$SnapshotEncryptionPassword = $null
$JunosUsername = $null
$JunosPassword = $null

if ($NoEncryption) {
    if (Test-Path $ConfigPath) {
        try {
            # -Encoding UTF8 explicit, or a BOM-less file is read as ANSI and non-ASCII is corrupted.
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
    # Before the prompt, so an unsupported runtime says so once instead of failing key derivation.
    Assert-TopologyCryptoRuntime

    Write-Host ""
    # Read-Host -AsSecureString accepts a bare Enter, and an empty password breaks key derivation.
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

            # Blanked so it can't silently rewrite the file on the next /api/save-config call.
            $EncryptionPassword = $null

            # Snapshot encryption gets its own password rather than inheriting the blanking: otherwise
            # no key material is derived and Invoke-FleetCrawl writes every device's full unredacted
            # config as plaintext, which giving up server-side credentials did not consent to.
            Write-Host "Configuration.json.enc will be left untouched. New snapshots are still encrypted, but with a separate password the viewer will prompt you for." -ForegroundColor Yellow
            do {
                $SnapshotEncryptionPassword = ConvertFrom-SecurePassword -SecureString (Read-Host -Prompt "Enter a password to encrypt new snapshots with" -AsSecureString)
                if ([string]::IsNullOrEmpty($SnapshotEncryptionPassword)) { Write-Host "Password cannot be empty." -ForegroundColor Red }
            } while ([string]::IsNullOrEmpty($SnapshotEncryptionPassword))
        }
    }
}

# AesGcm is .NET Core/5+ only; this must also run under Windows PowerShell 5.1, so AES-256-CBC +
# HMAC-SHA256, which also works in the browser's Web Crypto API that decrypts this format. Runs in
# server-only mode too, so a browser-triggered scan has key material for Invoke-FleetCrawl.
$PBKDF2_ITERATIONS = Get-TopologyPbkdf2Iterations
$EncKeyBytes = $null; $MacKeyBytes = $null; $SaltBytes = $null

if (-not $NoEncryption -and -not $SnapshotEncryptionPassword) { $SnapshotEncryptionPassword = $EncryptionPassword }
if (-not $NoEncryption -and $SnapshotEncryptionPassword) {
    # Only $EncryptionPassword reaches /api/session-password, so a blanked one means the viewer prompts.
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

# Proceeds regardless of credentials - browsing snapshots needs none, and the rest fail cleanly.
if (-not $SwitchIP) {
    Start-MapperWebServer -NoEncryption:$NoEncryption -VisualizerRoot $VisualizerRoot -SingleFileVisualizerPath $SingleFileVisualizerPath -ConnectScriptPath $ConnectScriptPath -WorkerPath $WorkerPath -Port $WebPort -ConfigPath $ConfigPath -EncryptionPassword $EncryptionPassword -JunosUsername $JunosUsername -JunosPassword $JunosPassword -MaxConcurrent $MaxConcurrent -AllowedScopes $AllowedScopes -SnapshotDir $SnapshotDir -EncKey $EncKeyBytes -MacKey $MacKeyBytes -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS -DebugLogPath $DebugLog
    return
}

# Crawling needs SSH credentials regardless of -NoEncryption.
if (-not $JunosUsername -or -not $JunosPassword) {
    throw "No Juniper login configured - set it in the Settings tab of the web viewer, then run a crawl."
}

Write-Host "Initializing Enterprise Orchestrator starting at $SwitchIP..." -ForegroundColor Cyan
if ($Log) { Write-Host "[LOGGING ENABLED] Raw payloads will be saved to .\RawDumps\" -ForegroundColor Yellow }

. (Join-Path $ScriptDir "lib\FleetCrawl.ps1")

# The same fence the crawl and the web UI apply: without it a typo'd out-of-scope -SwitchIP reaches
# an SSH login with saved credentials before the crawl can filter it.
if (-not (Test-IpInAllowedScopes -IP $SwitchIP -AllowedScopes $AllowedScopes)) {
    Write-Host "SwitchIP '$SwitchIP' is outside the configured AllowedScopes ($($AllowedScopes -join ', ')). Adjust -AllowedScopes if this IP should be permitted." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $WorkerPath)) { Write-Host "Worker script missing at $WorkerPath!" -ForegroundColor Red; exit 1 }

# Fail closed rather than downgrade: Invoke-FleetCrawl treats absent key material as "write
# plaintext", and only an explicit -NoEncryption may ask for that.
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

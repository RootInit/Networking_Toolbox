# Credentials & Settings in Configuration.json Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Juniper switch login and all app settings (fleet-health thresholds + graph-layout tuning) out of plaintext `Auth.json`/`localStorage`/DOM-only state and into the single encrypted `Configuration.json.enc` the geo-map-view feature already introduced, eliminating `Auth.json` entirely on the V2 side.

**Architecture:** PowerShell gains a new `Unprotect-TopologyPayload` (mirrors the browser's `decryptEnvelope`) so `Start-NetworkMapper.ps1` can decrypt `Configuration.json.enc` at startup after an interactive password prompt, extracting `credentials` for the crawl/rescan/SSH-launch actions. The browser's existing config load/save machinery (`map.js`) generalizes from "just device locations" to the whole `{devices, credentials, settings}` object; `persistence.js`'s threshold functions and a new Settings-tab "Juniper Switch Login" section read/write through that same object instead of `localStorage`.

**Tech Stack:** PowerShell (pwsh 7.6.2 / Windows PowerShell 5.1 dual-runtime), vanilla JS (classic scripts, no build step), Web Crypto API / .NET `System.Security.Cryptography` (AES-256-CBC + PBKDF2-SHA256 + HMAC-SHA256, encrypt-then-MAC).

**Spec:** `docs/superpowers/specs/2026-08-23-config-credentials-settings-design.md`

## Global Constraints

- Every `.ps1` change must run correctly on both pwsh 7+ (.NET Core) and Windows PowerShell 5.1 (.NET Framework) - no `-AsHashtable` on `ConvertFrom-Json`, no `AesGcm`, no `System.Web`. See `TopologyCrypto.ps1`'s and `Start-WebServer.ps1`'s existing header comments for the precedent.
- `Get-JunosNodeData.ps1` runs inside an in-process runspace (`[powershell]::Create()` + `AddParameter`) for both the crawl loop and `/api/rescan` - credentials reach it only via `.AddParameter(...)`, never a temp file or command line.
- `Connect-Switch.ps1` runs via `Start-Process powershell.exe` - a genuinely separate OS process - so credentials reach it only via the new `-CredentialFile` short-lived `%TEMP%` file, mirroring the existing `New-JunosAskPass`/`Remove-JunosAskPass` pattern exactly (owned/cleaned-up by the reader, in a `finally` block).
- V1 (`PS_NetworkMapper/`) is untouched - its own `Auth.json`/`Auth.example.json` stay exactly as they are. This plan only touches `PS_NetworkMapper_V2/`.
- No PowerShell-side interactive credential prompt for Juniper login, anywhere. Every action needing switch credentials (crawl, `/api/rescan`, `/api/connect`) fails cleanly pointing at the Settings tab if `Configuration.json.enc` has none - it never prompts inline.
- The encryption password prompt (`Read-Host -AsSecureString`) in `Start-NetworkMapper.ps1` is unconditional in both crawl and server-only modes, regardless of `-NoEncryption` - that flag only controls whether *this run's topology-snapshot output* gets encrypted, not whether the password is collected (needed either way, to read `Configuration.json.enc`).
- Device/alarm history caches (`persistence.js`'s `updateDeviceHistory`/`updateAlarmHistory`) stay in `localStorage` - out of scope, not "Settings".
- `graph.js`'s `getClusterThreshold`/`getLayoutSettings` keep reading live from the DOM on every render (unchanged) - only what populates those DOM inputs on tab-open changes.
- `Invoke-GetConfigAction` (serves raw encrypted bytes) is unchanged - the browser still decrypts independently client-side.

---

### Task 1: `TopologyCrypto.ps1` - add `Unprotect-TopologyPayload`

**Files:**
- Modify: `PS_NetworkMapper_V2/Network_Mapper/lib/TopologyCrypto.ps1`

**Interfaces:**
- Produces: `Unprotect-TopologyPayload -Envelope <object> -Password <string> [-ExpectedFormats <string[]>]` → returns the decrypted plaintext JSON as a `[string]`, or throws on wrong password / tampered file / unrecognized format. Mirrors `Network_Visualizer/src/topology-crypto.js`'s `decryptEnvelope` (same MIN/MAX iteration bounds: 1000/5,000,000; same encrypt-then-MAC verify-before-decrypt ordering). Consumed by Task 6's `Start-NetworkMapper.ps1`.

- [ ] **Step 1: Add `Unprotect-TopologyPayload` to `TopologyCrypto.ps1`**

Append this function at the end of the file, after `Protect-TopologyPayload`:

```powershell
# Mirror of Network_Visualizer/src/topology-crypto.js's decryptEnvelope, for the PowerShell
# side - Start-NetworkMapper.ps1 needs to decrypt Configuration.json.enc at startup to read
# stored Juniper credentials, and until now only the browser ever decrypted anything (this
# file's other function, Protect-TopologyPayload, only ever encrypts). Verifies the HMAC
# before decrypting (encrypt-then-MAC) so a wrong password or a tampered file fails with one
# clear error instead of an AES-CBC padding exception.
function Unprotect-TopologyPayload {
    param(
        [Parameter(Mandatory=$true)]$Envelope,
        [Parameter(Mandatory=$true)][string]$Password,
        [string[]]$ExpectedFormats = @("PSNetworkMapper-EncryptedTopology")
    )

    if (-not $Envelope -or $ExpectedFormats -notcontains $Envelope.format) {
        throw "Not a recognized encrypted file (expected one of: $($ExpectedFormats -join ', '))."
    }
    if ($Envelope.version -ne 1) {
        throw "Unsupported envelope version: $($Envelope.version)"
    }
    if ($Envelope.kdf -ne "PBKDF2-SHA256" -or $Envelope.cipher -ne "AES-256-CBC" -or $Envelope.macAlgorithm -ne "HMAC-SHA256") {
        throw "Unsupported encryption parameters: $($Envelope.kdf)/$($Envelope.cipher)/$($Envelope.macAlgorithm)"
    }
    # Same bounds as topology-crypto.js's MIN_ITERATIONS/MAX_ITERATIONS - a CPU-burn guard
    # against a tampered file forcing an absurd PBKDF2 cost, not a security boundary (a real
    # file, current or historical, never needs to go anywhere near either edge).
    $IterCheck = 0L
    if (-not [long]::TryParse([string]$Envelope.iterations, [ref]$IterCheck) -or $IterCheck -lt 1000 -or $IterCheck -gt 5000000) {
        throw "Iteration count out of range: $($Envelope.iterations)"
    }

    $SaltBytes = [Convert]::FromBase64String($Envelope.salt)
    $IvBytes = [Convert]::FromBase64String($Envelope.iv)
    $CipherBytes = [Convert]::FromBase64String($Envelope.ciphertext)
    $MacBytes = [Convert]::FromBase64String($Envelope.mac)

    $KeyMaterial = Get-TopologyKeyMaterial -Password $Password -Salt $SaltBytes -Iterations $IterCheck

    $Hmac = [System.Security.Cryptography.HMACSHA256]::new($KeyMaterial.MacKey)
    $ComputedMac = $Hmac.ComputeHash($IvBytes + $CipherBytes)
    $Hmac.Dispose()

    # Byte-by-byte, not a Base64-string comparison - avoids allocating strings for the sole
    # purpose of comparing them. Not constant-time, but this app's threat model (localhost-
    # only server, single local operator - see Start-WebServer.ps1's header comment) already
    # accepts non-constant-time comparisons elsewhere; anyone able to measure this timing
    # already has local code execution, which is full compromise regardless.
    $MacOk = $ComputedMac.Length -eq $MacBytes.Length
    if ($MacOk) {
        for ($i = 0; $i -lt $ComputedMac.Length; $i++) {
            if ($ComputedMac[$i] -ne $MacBytes[$i]) { $MacOk = $false; break }
        }
    }
    if (-not $MacOk) { throw "Incorrect password, or the file is corrupted." }

    $Aes = [System.Security.Cryptography.Aes]::Create()
    $Aes.KeySize = 256
    $Aes.Key = $KeyMaterial.EncKey
    $Aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
    $Aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
    $Aes.IV = $IvBytes

    $Decryptor = $Aes.CreateDecryptor()
    $PlainBytes = $Decryptor.TransformFinalBlock($CipherBytes, 0, $CipherBytes.Length)
    $Decryptor.Dispose()
    $Aes.Dispose()

    return [System.Text.Encoding]::UTF8.GetString($PlainBytes)
}
```

- [ ] **Step 2: Verify with a round-trip smoke test**

There is no Pester (or any `.ps1` test framework) anywhere in this repo - existing PS-side crypto (`Protect-TopologyPayload`) has never had an automated test either. Verify by dot-sourcing the file and round-tripping a payload through `Protect-TopologyPayload` → `Unprotect-TopologyPayload` directly at the prompt:

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox/PS_NetworkMapper_V2/Network_Mapper/lib
pwsh -NoProfile -Command '
. ./TopologyCrypto.ps1
$salt = [byte[]]::new(16); (New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($salt)
$iter = Get-TopologyPbkdf2Iterations
$km = Get-TopologyKeyMaterial -Password "correct horse" -Salt $salt -Iterations $iter
$plain = (@{devices=@(); credentials=@{username="bob";password="hunter2"}; settings=@{cpuWarnPct=70}} | ConvertTo-Json -Depth 5 -Compress)
$env = Protect-TopologyPayload -PlainJson $plain -EncKey $km.EncKey -MacKey $km.MacKey -Salt $salt -Iterations $iter -Format "PSNetworkMapper-EncryptedConfig"

# Round trip with the right password and format
$out = Unprotect-TopologyPayload -Envelope $env -Password "correct horse" -ExpectedFormats @("PSNetworkMapper-EncryptedConfig")
if ($out -ne $plain) { throw "MISMATCH: round-trip did not return the original plaintext" }
Write-Host "Round trip OK" -ForegroundColor Green

# Wrong password must fail with a clear error, not decrypt garbage
try {
    Unprotect-TopologyPayload -Envelope $env -Password "wrong password" -ExpectedFormats @("PSNetworkMapper-EncryptedConfig")
    throw "SHOULD HAVE THROWN on wrong password"
} catch {
    if ($_.Exception.Message -notmatch "Incorrect password") { throw "Wrong error for bad password: $_" }
    Write-Host "Wrong-password rejection OK" -ForegroundColor Green
}

# Wrong expected format must be rejected before even trying to decrypt
try {
    Unprotect-TopologyPayload -Envelope $env -Password "correct horse" -ExpectedFormats @("PSNetworkMapper-EncryptedTopology")
    throw "SHOULD HAVE THROWN on format mismatch"
} catch {
    if ($_.Exception.Message -notmatch "Not a recognized encrypted file") { throw "Wrong error for format mismatch: $_" }
    Write-Host "Format-mismatch rejection OK" -ForegroundColor Green
}
'
```

Expected: `Round trip OK`, `Wrong-password rejection OK`, `Format-mismatch rejection OK` - no uncaught exceptions.

- [ ] **Step 3: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Mapper/lib/TopologyCrypto.ps1
git commit -m "Add Unprotect-TopologyPayload: PowerShell-side decrypt, mirroring the browser's decryptEnvelope"
```

---

### Task 2: `Connect-JunosSsh.ps1` - remove `Get-JunosAuth`, add credential-file helpers

**Files:**
- Modify: `PS_NetworkMapper_V2/Network_Mapper/lib/Connect-JunosSsh.ps1`

**Interfaces:**
- Consumes: nothing new.
- Produces: `New-JunosCredentialFile -Username <string> -Password <string>` → writes `{Username, Password}` as JSON to a short-lived `%TEMP%` file and returns its path (`[string]`). `Remove-JunosCredentialFile -CredentialFile <string>` → deletes that file (best-effort, `SilentlyContinue`). Consumed by Task 5 (`Start-WebServer.ps1`'s `Invoke-ConnectAction` calls `New-JunosCredentialFile`) and Task 4 (`Connect-Switch.ps1` reads the file and calls `Remove-JunosCredentialFile` in its own `finally`).
- Removes: `Get-JunosAuth` (nothing reads `Auth.json` anymore after this task chain completes - `Get-JunosNodeData.ps1` (Task 3) and `Connect-Switch.ps1` (Task 4) both stop calling it in the same wave).

- [ ] **Step 1: Remove `Get-JunosAuth`, add `New-JunosCredentialFile`/`Remove-JunosCredentialFile`**

Replace the `Get-JunosAuth` function (lines 11-16) with the two new helpers, placed right after the header comment and before `New-JunosAskPass`:

```powershell
# Writes {Username, Password} to a short-lived %TEMP% file for handoff to Connect-Switch.ps1,
# which runs via Start-Process as a genuinely separate OS process (unlike Get-JunosNodeData.ps1,
# which runs in-process via a runspace and receives credentials directly through
# .AddParameter(...), never touching a file). Mirrors New-JunosAskPass's own "shortest
# possible plaintext-on-disk window, owned by the reader, cleaned up even on error" posture -
# not a new exposure, the same one already accepted for the SSH password itself, now also
# covering the credential handoff into that separate process. The caller passes only the
# returned path to Start-Process; the reader (Connect-Switch.ps1) is responsible for calling
# Remove-JunosCredentialFile once it has read the file, in a finally block.
function New-JunosCredentialFile {
    param([Parameter(Mandatory=$true)][string]$Username, [Parameter(Mandatory=$true)][string]$Password)
    $CredPath = Join-Path $env:TEMP "junos_cred_$($PID)_$([guid]::NewGuid().Guid.Substring(0,8)).json"
    @{ Username = $Username; Password = $Password } | ConvertTo-Json -Compress | Out-File -FilePath $CredPath -Encoding utf8
    return $CredPath
}

function Remove-JunosCredentialFile {
    param([Parameter(Mandatory=$true)][string]$CredentialFile)
    Remove-Item -Path $CredentialFile -Force -ErrorAction SilentlyContinue
}
```

- [ ] **Step 2: Verify with a round-trip smoke test**

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox/PS_NetworkMapper_V2/Network_Mapper/lib
pwsh -NoProfile -Command '
. ./Connect-JunosSsh.ps1
$path = New-JunosCredentialFile -Username "svc-mapper" -Password "s3cret!"
if (-not (Test-Path $path)) { throw "Credential file was not created" }
$data = Get-Content $path -Raw | ConvertFrom-Json
if ($data.Username -ne "svc-mapper" -or $data.Password -ne "s3cret!") { throw "Round-trip content mismatch: $($data | ConvertTo-Json)" }
Write-Host "Write/read round trip OK" -ForegroundColor Green
Remove-JunosCredentialFile -CredentialFile $path
if (Test-Path $path) { throw "File still exists after Remove-JunosCredentialFile" }
Write-Host "Cleanup OK" -ForegroundColor Green
# Get-JunosAuth must be gone
if (Get-Command Get-JunosAuth -ErrorAction SilentlyContinue) { throw "Get-JunosAuth still defined - should have been removed" }
Write-Host "Get-JunosAuth removal OK" -ForegroundColor Green
'
```

Expected: `Write/read round trip OK`, `Cleanup OK`, `Get-JunosAuth removal OK`.

- [ ] **Step 3: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Mapper/lib/Connect-JunosSsh.ps1
git commit -m "Replace Get-JunosAuth with New/Remove-JunosCredentialFile for cross-process credential handoff"
```

---

### Task 3: `Get-JunosNodeData.ps1` - take `-Username`/`-Password` directly

**Files:**
- Modify: `PS_NetworkMapper_V2/Network_Mapper/lib/Get-JunosNodeData.ps1`

**Interfaces:**
- Consumes: `New-JunosAskPass`/`Remove-JunosAskPass` from `Connect-JunosSsh.ps1` (Task 2, unchanged).
- Produces: script now requires `-Username`/`-Password` params instead of `-AuthFile`. Consumed by Task 6 (`Start-NetworkMapper.ps1`'s crawl-loop `.AddParameter` calls) and Task 5 (`Start-WebServer.ps1`'s `Invoke-RescanAction`).

- [ ] **Step 1: Replace `-AuthFile` with `-Username`/`-Password`**

Replace the param block (lines 1-15):

```powershell
[CmdletBinding()]
param (
    [Parameter(Mandatory=$true)]
    [string]$TargetIP,

    [Parameter(Mandatory=$true)]
    [string]$Username,

    [Parameter(Mandatory=$true)]
    [string]$Password,

    [switch]$HumanReadable,

    # NEW: Only write raw payload text files if this flag is present
    [switch]$Log 
)
```

Replace lines 17-22 (auth loading):

```powershell
$WorkerScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
. (Join-Path $WorkerScriptDir "Connect-JunosSsh.ps1")

$AskPass = New-JunosAskPass -Password $Password
```

(`$Username` is now the mandatory param directly - every other reference to `$Username` later in the file, e.g. inside `Invoke-InteractiveBatch`'s `Get-JunosSshArgs -Username $Username -TargetIP $TargetIP` call, already refers to a variable of that same name and needs no further change.)

- [ ] **Step 2: Verify - syntax check and parameter-shape check**

No real switch is reachable from this environment, so this can't be exercised end-to-end here; verify the script still parses and that the new params are exactly as expected:

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox/PS_NetworkMapper_V2/Network_Mapper/lib
pwsh -NoProfile -Command '
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path "./Get-JunosNodeData.ps1"), [ref]$null, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Host $_ -ForegroundColor Red }; throw "Parse errors found" }
Write-Host "Parses cleanly" -ForegroundColor Green

$cmd = Get-Command ./Get-JunosNodeData.ps1
$names = $cmd.Parameters.Keys
foreach ($required in @("TargetIP","Username","Password")) {
    if ($names -notcontains $required) { throw "Missing expected parameter: $required" }
}
if ($names -contains "AuthFile") { throw "AuthFile parameter should have been removed" }
if (-not $cmd.Parameters["Username"].Attributes.Mandatory) { throw "Username should be mandatory" }
if (-not $cmd.Parameters["Password"].Attributes.Mandatory) { throw "Password should be mandatory" }
Write-Host "Parameter shape OK" -ForegroundColor Green
'
```

Expected: `Parses cleanly`, `Parameter shape OK`.

- [ ] **Step 3: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Mapper/lib/Get-JunosNodeData.ps1
git commit -m "Get-JunosNodeData.ps1: take -Username/-Password directly instead of reading Auth.json"
```

---

### Task 4: `Connect-Switch.ps1` - take `-CredentialFile` instead of `-AuthFile`

**Files:**
- Modify: `PS_NetworkMapper_V2/Network_Mapper/lib/Connect-Switch.ps1`

**Interfaces:**
- Consumes: `Remove-JunosCredentialFile` (Task 2), `New-JunosAskPass`/`Remove-JunosAskPass`/`Get-JunosSshArgs` (`Connect-JunosSsh.ps1`, unchanged).
- Produces: script now requires `-CredentialFile` (a path to a `{Username, Password}` JSON file, written by the caller) instead of `-AuthFile`. Consumed by Task 5 (`Start-WebServer.ps1`'s `Invoke-ConnectAction` launches this via `Start-Process`).

- [ ] **Step 1: Replace `-AuthFile` with `-CredentialFile`, read+clean up the file**

Replace the whole file:

```powershell
# Opens a genuine interactive SSH session to a Juniper switch, using credentials handed off
# via a short-lived -CredentialFile (written by Start-WebServer.ps1's Invoke-ConnectAction
# right before launching this script) - for when you just want to log in and look around,
# rather than run the full scripted crawl (Get-JunosNodeData.ps1) or wait for a topology map.
# A browser page still can't spawn a process directly (no such API exists in any mainstream
# browser), but in V2 the "Launch SSH Session" button now gets there indirectly: it POSTs to
# the local Start-WebServer.ps1 server, which is itself a PowerShell process and runs this
# script via Start-Process on the browser's behalf. Kept as a real -TargetIP parameter (not
# something request-controlled beyond that already-validated IP) so this is still just as
# safe to run by hand.
#
# Uses the same SSH_ASKPASS password-injection approach as the crawler (see
# Connect-JunosSsh.ps1), but attaches ssh.exe directly to this console instead of
# redirecting its output to temp files and feeding it scripted commands - that's a
# genuinely different shape of invocation, not shared with the crawler beyond the
# askpass setup itself.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true, HelpMessage="IP address of the switch to connect to")]
    [string]$TargetIP,

    [Parameter(Mandatory=$true, HelpMessage="Path to a short-lived {Username, Password} JSON file written by the caller")]
    [string]$CredentialFile
)

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
. (Join-Path $ScriptDir "Connect-JunosSsh.ps1")

$CredData = Get-Content $CredentialFile -Raw | ConvertFrom-Json
$Username = $CredData.Username
$AskPass = New-JunosAskPass -Password $CredData.Password

try {
    $SshArgs = Get-JunosSshArgs -Username $Username -TargetIP $TargetIP
    Write-Host "Connecting to $TargetIP as $Username..." -ForegroundColor Cyan

    # No cmd.exe wrapper and no redirection here, unlike the crawler's batch mode - stdin/
    # stdout/stderr all stay attached to this console for a real interactive session.
    $ProcInfo = New-Object System.Diagnostics.ProcessStartInfo("ssh.exe", ($SshArgs -join ' '))
    $ProcInfo.UseShellExecute = $false
    foreach ($EnvKey in $AskPass.EnvironmentVariables.Keys) { $ProcInfo.EnvironmentVariables[$EnvKey] = $AskPass.EnvironmentVariables[$EnvKey] }

    $Process = [System.Diagnostics.Process]::Start($ProcInfo)
    $Process.WaitForExit()
} finally {
    Remove-JunosAskPass -AskPassContext $AskPass
    Remove-JunosCredentialFile -CredentialFile $CredentialFile
}
```

- [ ] **Step 2: Verify - syntax check and parameter-shape check**

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox/PS_NetworkMapper_V2/Network_Mapper/lib
pwsh -NoProfile -Command '
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path "./Connect-Switch.ps1"), [ref]$null, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Host $_ -ForegroundColor Red }; throw "Parse errors found" }
Write-Host "Parses cleanly" -ForegroundColor Green

$cmd = Get-Command ./Connect-Switch.ps1
$names = $cmd.Parameters.Keys
if ($names -notcontains "CredentialFile") { throw "Missing CredentialFile parameter" }
if ($names -contains "AuthFile") { throw "AuthFile parameter should have been removed" }
if (-not $cmd.Parameters["CredentialFile"].Attributes.Mandatory) { throw "CredentialFile should be mandatory" }
Write-Host "Parameter shape OK" -ForegroundColor Green
'
```

Expected: `Parses cleanly`, `Parameter shape OK`.

- [ ] **Step 3: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Mapper/lib/Connect-Switch.ps1
git commit -m "Connect-Switch.ps1: take -CredentialFile instead of reading Auth.json directly"
```

---

### Task 5: `Start-WebServer.ps1` - credential-presence checks, new params, `Auth.json` removed

**Files:**
- Modify: `PS_NetworkMapper_V2/Network_Mapper/lib/Start-WebServer.ps1`

**Interfaces:**
- Consumes: `New-JunosCredentialFile` (Task 2), `Get-JunosNodeData.ps1` with `-Username`/`-Password` (Task 3), `Connect-Switch.ps1` with `-CredentialFile` (Task 4).
- Produces: `Start-MapperWebServer` gains `-JunosUsername`/`-JunosPassword` (optional strings, default `""`) and `-EncryptionPassword` (mandatory string), replacing `-AuthFile` entirely. Consumed by Task 6 (`Start-NetworkMapper.ps1`'s two call sites).

- [ ] **Step 1: Dot-source `Connect-JunosSsh.ps1`**

Add right after the existing `TopologyCrypto.ps1` dot-source (line 20):

```powershell
# Invoke-ConnectAction (below) needs New-JunosCredentialFile. Same "dot-source directly,
# don't rely on caller load order" reasoning as the TopologyCrypto.ps1 dot-source above.
. (Join-Path $PSScriptRoot "Connect-JunosSsh.ps1")
```

- [ ] **Step 2: `Invoke-ConnectAction` - credential-presence check, `-CredentialFile` handoff**

Replace the whole function:

```powershell
# The one action a browser click can trigger server-side: launch Connect-Switch.ps1 (a
# real interactive SSH session, askpass-injected via a short-lived credential file) against
# a target IP. Deliberately narrow - a fixed script, one validated parameter, no free-form
# command or Invoke-Expression surface. $TargetIP is regex-locked to IPv4 shape before it
# ever reaches Start-Process, so it carries no shell metacharacters even though the
# arguments below are also passed as a single pre-quoted string rather than relying on
# Start-Process's own (version-dependent) array-quoting behavior.
function Invoke-ConnectAction {
    param($Response, [string]$Body, [string]$ConnectScriptPath, [string]$JunosUsername, [string]$JunosPassword)

    if ([string]::IsNullOrWhiteSpace($JunosUsername) -or [string]::IsNullOrWhiteSpace($JunosPassword)) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "No Juniper login configured - set it in the Settings tab, then try again." }
        return
    }

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    $TargetIP = if ($Parsed) { [string]$Parsed.ip } else { $null }

    if (-not $TargetIP -or $TargetIP -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Invalid or missing IP address" }
        return
    }

    try {
        $CredFile = New-JunosCredentialFile -Username $JunosUsername -Password $JunosPassword
        $ArgString = @("-NoExit", "-File", "`"$ConnectScriptPath`"", "-TargetIP", $TargetIP, "-CredentialFile", "`"$CredFile`"") -join ' '
        Start-Process -FilePath "powershell.exe" -ArgumentList $ArgString | Out-Null
        Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "launched"; ip = $TargetIP }
    } catch {
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to launch SSH session: $_" }
    }
}
```

- [ ] **Step 3: `Invoke-RescanAction` - credential-presence check, `-Username`/`-Password`**

Replace the param line and the `Test-Path $AuthFile` check (lines 126, 137-140), and the worker dispatch (line 166):

```powershell
function Invoke-RescanAction {
    param($Response, [string]$Body, [string]$WorkerPath, [string]$JunosUsername, [string]$JunosPassword)

    if ([string]::IsNullOrWhiteSpace($JunosUsername) -or [string]::IsNullOrWhiteSpace($JunosPassword)) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "No Juniper login configured - set it in the Settings tab, then try again." }
        return
    }

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    $TargetIP = if ($Parsed) { [string]$Parsed.ip } else { $null }

    if (-not $TargetIP -or $TargetIP -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Invalid or missing IP address" }
        return
    }
```

(the rest of the function body - the orphan-reaping loop and the `$script:PendingScan` 409 check - is unchanged; only the two lines below, further down where the job is dispatched, change)

```powershell
    # -TargetIP/-Username/-Password only, matching Get-JunosNodeData.ps1's fixed read-only
    # "show ..." batch. Never -HumanReadable (that branch ends in `exit`, which would kill
    # this runspace) and never -Log (no reason for an ad-hoc rescan to write RawDumps/).
    $JobId = [guid]::NewGuid().ToString()
    $PS = [powershell]::Create().AddCommand($WorkerPath).AddParameter("TargetIP", $TargetIP).AddParameter("Username", $JunosUsername).AddParameter("Password", $JunosPassword)
    $PS.RunspacePool = $script:RescanPool
    $Handle = $PS.BeginInvoke()
```

- [ ] **Step 4: `Invoke-GetConfigAction` - unchanged**

No changes to this function (still serves raw encrypted bytes; the browser decrypts independently). Confirm it's untouched while editing the surrounding functions.

- [ ] **Step 5: `Invoke-SaveConfigAction` - use the passed-in `-EncryptionPassword`**

Replace the whole function:

```powershell
# Encrypts and writes Configuration.json.enc. The browser sends PLAINTEXT edited config
# JSON - the encryption password never crosses the wire in either direction, same as
# topology writes. $EncryptionPassword is the same password Start-NetworkMapper.ps1 already
# prompted for interactively at startup (see that script's header sequence) and passed
# straight through to Start-MapperWebServer - it is never read from a file. A fresh
# salt/IV is generated per save (unlike a crawl's session-cached key - saves are rare/
# interactive, not periodic, so there's no repeated-PBKDF2-cost reason to cache keys across
# calls here).
function Invoke-SaveConfigAction {
    param($Response, [string]$Body, [string]$ConfigPath, [string]$EncryptionPassword)

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    # Presence check, not truthiness: `-not $Parsed.devices` would also reject a
    # legitimate `devices: []` save (PowerShell treats an empty array as falsy), which is
    # exactly what the in-app editor sends the first time someone deletes their last
    # location entry. $null -eq checks for "key absent (or explicitly null)" instead.
    if (-not $Parsed -or $null -eq $Parsed.devices) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Request body must be JSON with a 'devices' array" }
        return
    }

    try {
        $SaltBytes = [byte[]]::new(16)
        $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $Rng.GetBytes($SaltBytes)
        $Rng.Dispose()

        # Shared with Start-NetworkMapper.ps1's crawl-output encryption via
        # TopologyCrypto.ps1's Get-TopologyPbkdf2Iterations (dot-sourced at the top of this
        # file) - was a duplicated `600000` literal here, defeating the point of extracting
        # TopologyCrypto.ps1 in the first place (stop crypto parameters drifting between the
        # crawler and the webserver).
        $Iterations = Get-TopologyPbkdf2Iterations
        $KeyMaterial = Get-TopologyKeyMaterial -Password $EncryptionPassword -Salt $SaltBytes -Iterations $Iterations
        $Envelope = Protect-TopologyPayload -PlainJson $Body -EncKey $KeyMaterial.EncKey -MacKey $KeyMaterial.MacKey -Salt $SaltBytes -Iterations $Iterations -Format "PSNetworkMapper-EncryptedConfig"

        $Envelope | ConvertTo-Json -Depth 10 | Out-File -FilePath $ConfigPath -Encoding utf8
        Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "saved" }
    } catch {
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to save configuration: $_" }
    }
}
```

- [ ] **Step 6: `Start-MapperWebServer` - new params, updated dispatch calls**

Replace the param block (lines 350-358):

```powershell
function Start-MapperWebServer {
    param(
        [Parameter(Mandatory=$true)][string]$VisualizerRoot,
        [Parameter(Mandatory=$true)][string]$ConnectScriptPath,
        [Parameter(Mandatory=$true)][string]$WorkerPath,
        [Parameter(Mandatory=$true)][string]$ConfigPath,
        [Parameter(Mandatory=$true)][string]$EncryptionPassword,
        [string]$JunosUsername = "",
        [string]$JunosPassword = "",
        [int]$Port = 8787
    )
```

Update the three call sites inside the accept loop (lines ~395, ~404, ~418):

```powershell
                        Invoke-ConnectAction -Response $Response -Body $Body -ConnectScriptPath $ConnectScriptPath -JunosUsername $JunosUsername -JunosPassword $JunosPassword
```

```powershell
                        Invoke-RescanAction -Response $Response -Body $Body -WorkerPath $WorkerPath -JunosUsername $JunosUsername -JunosPassword $JunosPassword
```

```powershell
                        Invoke-SaveConfigAction -Response $Response -Body $Body -ConfigPath $ConfigPath -EncryptionPassword $EncryptionPassword
```

- [ ] **Step 7: Verify - syntax check, parameter shape, and a live endpoint check**

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox/PS_NetworkMapper_V2/Network_Mapper/lib
pwsh -NoProfile -Command '
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path "./Start-WebServer.ps1"), [ref]$null, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Host $_ -ForegroundColor Red }; throw "Parse errors found" }
Write-Host "Parses cleanly" -ForegroundColor Green

. ./Start-WebServer.ps1
$cmd = Get-Command Start-MapperWebServer
$names = $cmd.Parameters.Keys
foreach ($required in @("JunosUsername","JunosPassword","EncryptionPassword")) {
    if ($names -notcontains $required) { throw "Missing expected parameter: $required" }
}
if ($names -contains "AuthFile") { throw "AuthFile parameter should have been removed" }
if (-not $cmd.Parameters["EncryptionPassword"].Attributes.Mandatory) { throw "EncryptionPassword should be mandatory" }
Write-Host "Parameter shape OK" -ForegroundColor Green
'
```

Then a live check of the credential-presence guard (this is a genuine HttpListener - it runs fine on Linux under pwsh 7+, no real switch needed since this path returns before ever touching SSH):

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox/PS_NetworkMapper_V2/Network_Mapper/lib
pwsh -NoProfile -Command '
. ./Start-WebServer.ps1
$job = Start-Job -ScriptBlock {
    param($libDir)
    Set-Location $libDir
    . ./Start-WebServer.ps1
    Start-MapperWebServer -VisualizerRoot "/tmp" -ConnectScriptPath "/tmp/noop.ps1" -WorkerPath "/tmp/noop.ps1" -ConfigPath "/tmp/nope.enc" -EncryptionPassword "unused-in-this-test" -Port 18787
} -ArgumentList (Resolve-Path ".").Path
Start-Sleep -Seconds 3
try {
    $resp = Invoke-WebRequest -Uri "http://localhost:18787/api/rescan" -Method Post -Body (@{ip="10.0.0.1"} | ConvertTo-Json) -ContentType "application/json" -Headers @{Origin="http://localhost:18787"} -SkipHttpErrorCheck
    if ($resp.StatusCode -ne 400) { throw "Expected 400 for missing credentials, got $($resp.StatusCode)" }
    $body = $resp.Content | ConvertFrom-Json
    if ($body.error -notmatch "Settings tab") { throw "Error message should point at the Settings tab: $($body.error)" }
    Write-Host "Missing-credentials 400 OK" -ForegroundColor Green
} finally {
    Stop-Job $job -ErrorAction SilentlyContinue; Remove-Job $job -Force -ErrorAction SilentlyContinue
}
'
```

Expected: `Parses cleanly`, `Parameter shape OK`, `Missing-credentials 400 OK`.

- [ ] **Step 8: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Mapper/lib/Start-WebServer.ps1
git commit -m "Start-WebServer.ps1: credential-presence checks, -JunosUsername/-JunosPassword/-EncryptionPassword replace -AuthFile"
```

---

### Task 6: `Start-NetworkMapper.ps1` - interactive password prompt, config decrypt, `-AuthFile` removed

**Files:**
- Modify: `PS_NetworkMapper_V2/Network_Mapper/Start-NetworkMapper.ps1`

**Interfaces:**
- Consumes: `Unprotect-TopologyPayload` (Task 1), `Get-JunosNodeData.ps1` with `-Username`/`-Password` (Task 3), `Start-MapperWebServer` with `-JunosUsername`/`-JunosPassword`/`-EncryptionPassword` (Task 5).
- Produces: nothing new consumed elsewhere - this is the top-level entry point.

- [ ] **Step 1: Remove `-AuthFile` param, relocate `$ConfigPath`'s anchor**

Replace the param block (lines 1-24):

```powershell
param (
    # No longer mandatory: omitting it starts the viewer (webserver + browser) straight
    # from existing snapshots, without running a crawl first - see the server-only branch
    # below. Pass it when you actually want a fresh crawl.
    [Parameter(HelpMessage="Starting IP address of the first switch - omit to launch the viewer against existing snapshots without crawling")]
    [string]$SwitchIP,

    [string[]]$AllowedScopes = @("131.30."),

    [int]$MaxConcurrent = 10,
    [switch]$Log,
    # Output encryption is on by default (topology, clients, and - now - full device
    # config backups are sensitive enough that "on unless you opt in" was the wrong
    # default). Pass this to get a plain .json instead of .json.enc. Does NOT skip the
    # encryption-password prompt below - Configuration.json.enc (credentials/settings) is
    # read regardless of this flag, which only controls whether THIS run's own topology
    # output gets encrypted.
    [switch]$NoEncryption,

    # Bound to localhost only - see Start-WebServer.ps1's header comment for why LAN
    # exposure was deliberately ruled out rather than gated behind auth.
    [int]$WebPort = 8787
)
```

Replace lines 26-43 (setup vars):

```powershell
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
$WorkerPath = Join-Path $ScriptDir "lib\Get-JunosNodeData.ps1"
$ConnectScriptPath = Join-Path $ScriptDir "lib\Connect-Switch.ps1"
$VisualizerRoot = Join-Path $ScriptDir "..\Network_Visualizer"
# V2 shares its data (snapshot history, and now Configuration.json.enc) with the original
# PS_NetworkMapper/ instead of forking it - see $SnapshotDir below. Only the code (this
# webserver, the SSH-spawn action, the NDJSON ledger) is new. Configuration.json.enc lives
# in that shared Network_Mapper/ folder, same location it's always lived in (previously
# anchored off -AuthFile's parent directory - now a fixed relative path, since -AuthFile no
# longer exists).
$SharedMapperDir = Join-Path $ScriptDir "..\..\PS_NetworkMapper\Network_Mapper"
$ConfigPath = Join-Path $SharedMapperDir "Configuration.json.enc"
. (Join-Path $ScriptDir "lib\Start-WebServer.ps1")
. (Join-Path $ScriptDir "lib\TopologyCrypto.ps1")
$DebugLog = Join-Path $ScriptDir "Mapper_Debug.log"
# Snapshots (and now the NDJSON device-history ledger) live in the ORIGINAL
# PS_NetworkMapper's Network_Maps/ folder, not a V2-local copy - shared per the
# fork-sharing decision above, so a V1 crawl and a V2 crawl land side by side in the same
# history instead of splitting it across two folders.
$SnapshotDir = Join-Path $ScriptDir "..\..\PS_NetworkMapper\Network_Maps"
if (-not (Test-Path $SnapshotDir)) { New-Item -ItemType Directory -Path $SnapshotDir -Force | Out-Null }
$DeviceHistoryLedger = Join-Path $SnapshotDir "device_history.ndjson"
```

- [ ] **Step 2: Add the unconditional password prompt + `Configuration.json.enc` decrypt, before the server-only early return**

Insert this whole block where the old `if (-not $SwitchIP) { ...; return }` used to sit alone (replacing lines 45-52), so it runs in BOTH modes before anything branches:

```powershell
# Converts a SecureString to plaintext - the standard cross-runtime idiom (works
# identically on Windows PowerShell 5.1 and pwsh 7+, unlike manually marshaling the BSTR,
# which needs its own explicit ZeroFreeBSTR cleanup to avoid a leak).
function ConvertFrom-SecurePassword {
    param([Parameter(Mandatory=$true)][securestring]$SecureString)
    return [System.Net.NetworkCredential]::new('', $SecureString).Password
}

# Always interactively entered, in BOTH crawl and server-only modes, regardless of
# -NoEncryption - see the -NoEncryption param's own comment above for why. Configuration.json.enc
# (Juniper credentials + app settings) now lives ONLY behind this password; there is no
# file-based fallback anymore (Auth.json is gone).
Write-Host ""
$EncryptionPassword = ConvertFrom-SecurePassword -SecureString (Read-Host -Prompt "Enter encryption password" -AsSecureString)

$JunosUsername = $null
$JunosPassword = $null
if (Test-Path $ConfigPath) {
    $Attempts = 0
    $DecryptedConfigJson = $null
    while ($null -eq $DecryptedConfigJson -and $Attempts -lt 3) {
        $Attempts++
        try {
            $Envelope = Get-Content $ConfigPath -Raw | ConvertFrom-Json
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
    }
}

# Server-only launch: no -SwitchIP means "just show me the viewer", not "crawl the
# fleet". Proceeds regardless of whether Juniper credentials are present - browsing
# existing snapshots needs no switch credentials at all, and Invoke-ConnectAction/
# Invoke-RescanAction already fail cleanly (pointing at the Settings tab) if the browser
# tries an action that needs them.
if (-not $SwitchIP) {
    Start-MapperWebServer -VisualizerRoot $VisualizerRoot -ConnectScriptPath $ConnectScriptPath -WorkerPath $WorkerPath -Port $WebPort -ConfigPath $ConfigPath -EncryptionPassword $EncryptionPassword -JunosUsername $JunosUsername -JunosPassword $JunosPassword
    return
}

# Crawling every device needs SSH credentials; there is no partial crawl to attempt
# without them, and this holds regardless of -NoEncryption (that flag only affects
# topology-write encryption, not whether credentials are needed to crawl at all).
if (-not $JunosUsername -or -not $JunosPassword) {
    throw "No Juniper login configured - set it in the Settings tab of the web viewer, then run a crawl."
}
```

- [ ] **Step 3: Remove the old `Auth.json`-based encryption-password sourcing**

Delete lines 84-99 (the old `if (-not (Test-Path $AuthFile))` throw, `$AuthData = Get-Content...`, and the `if (-not $AuthData.EncryptionPassword...)` block) entirely - `$EncryptionPassword` is now already set by Step 2 above. What remains directly below (the `if (-not $NoEncryption)` block that derives `$SaltBytes`/`$EncKeyBytes`/`$MacKeyBytes`) stays, but drop its own now-redundant `$EncryptionPassword = $AuthData.EncryptionPassword` line and the preceding `Write-Host "Output encryption enabled (password from Auth.json)..."` line - replace that one `Write-Host` with:

```powershell
    Write-Host "Output encryption enabled - Network_Visualizer will prompt for this same password when the file is opened." -ForegroundColor Yellow
```

So the surviving block reads:

```powershell
if (-not $NoEncryption) {
    Write-Host "Output encryption enabled - Network_Visualizer will prompt for this same password when the file is opened." -ForegroundColor Yellow

    $SaltBytes = [byte[]]::new(16)
    $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $Rng.GetBytes($SaltBytes)
    $Rng.Dispose()

    $KeyMaterial = Get-TopologyKeyMaterial -Password $EncryptionPassword -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS
    $EncKeyBytes = $KeyMaterial.EncKey
    $MacKeyBytes = $KeyMaterial.MacKey
    $EncryptionPassword = $null
}
```

- [ ] **Step 4: Update the crawl-loop worker dispatch**

Replace the `.AddParameter("AuthFile", $AuthFile)` call (around old line 217) and its preceding comment:

```powershell
            # -Username/-Password passed explicitly (in-memory, via .AddParameter - never a
            # file or command line) rather than letting the worker read Auth.json itself,
            # which no longer exists.
            $PS = [powershell]::Create().AddCommand($WorkerPath).AddParameter("TargetIP", $NextIP).AddParameter("Username", $JunosUsername).AddParameter("Password", $JunosPassword)
```

- [ ] **Step 5: Update the post-crawl viewer launch**

Replace the final line of the file (old line 349):

```powershell
Start-MapperWebServer -VisualizerRoot $VisualizerRoot -ConnectScriptPath $ConnectScriptPath -WorkerPath $WorkerPath -Port $WebPort -ConfigPath $ConfigPath -EncryptionPassword $EncryptionPassword -JunosUsername $JunosUsername -JunosPassword $JunosPassword
```

Note: `$EncryptionPassword` was set to `$null` at the end of the Step 3 block above (when `-NoEncryption` is not passed) to drop it out of memory once the topology-write keys are derived - but `Invoke-SaveConfigAction` (Task 5) needs the real password for the lifetime of the server. Un-null it: remove the `$EncryptionPassword = $null` line from the block in Step 3 (shown above without it already - just confirm it is NOT present in what you write) so the password survives in memory for the whole server session, exactly as it needs to for `/api/save-config` to keep working after a crawl completes and the viewer launches.

- [ ] **Step 6: Verify - syntax check and full flow smoke test**

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox/PS_NetworkMapper_V2/Network_Mapper
pwsh -NoProfile -Command '
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path "./Start-NetworkMapper.ps1"), [ref]$null, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Host $_ -ForegroundColor Red }; throw "Parse errors found" }
Write-Host "Parses cleanly" -ForegroundColor Green

$cmd = Get-Command ./Start-NetworkMapper.ps1
if ($cmd.Parameters.Keys -contains "AuthFile") { throw "AuthFile parameter should have been removed" }
Write-Host "AuthFile removal OK" -ForegroundColor Green
'
```

Then an end-to-end smoke test of the decrypt-retry flow, using a real `Configuration.json.enc` built the same way `Invoke-SaveConfigAction` builds one, confirming: (a) the right password decrypts credentials on the first try, (b) a wrong password then the right password on retry also works, (c) exhausting all 3 attempts and answering "n" aborts cleanly.

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox
pwsh -NoProfile -Command '
. ./PS_NetworkMapper_V2/Network_Mapper/lib/TopologyCrypto.ps1
$dir = Join-Path ([System.IO.Path]::GetTempPath()) "cred-settings-smoke-$([guid]::NewGuid().Guid.Substring(0,8))"
New-Item -ItemType Directory -Path (Join-Path $dir "PS_NetworkMapper\Network_Mapper") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dir "PS_NetworkMapper_V2\Network_Mapper\lib") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dir "PS_NetworkMapper_V2\Network_Visualizer") -Force | Out-Null
Copy-Item ./PS_NetworkMapper_V2/Network_Mapper/Start-NetworkMapper.ps1 (Join-Path $dir "PS_NetworkMapper_V2\Network_Mapper\") -Force
Copy-Item ./PS_NetworkMapper_V2/Network_Mapper/lib/*.ps1 (Join-Path $dir "PS_NetworkMapper_V2\Network_Mapper\lib\") -Force

$salt = [byte[]]::new(16); (New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($salt)
$iter = Get-TopologyPbkdf2Iterations
$km = Get-TopologyKeyMaterial -Password "CorrectHorse!23" -Salt $salt -Iterations $iter
$plain = (@{devices=@(); credentials=@{username="svc-mapper";password="s3cret!"}; settings=@{cpuWarnPct=70}} | ConvertTo-Json -Depth 5 -Compress)
$env = Protect-TopologyPayload -PlainJson $plain -EncKey $km.EncKey -MacKey $km.MacKey -Salt $salt -Iterations $iter -Format "PSNetworkMapper-EncryptedConfig"
$env | ConvertTo-Json -Depth 10 | Out-File (Join-Path $dir "PS_NetworkMapper\Network_Mapper\Configuration.json.enc") -Encoding utf8

# Feed stdin: wrong password, then the right one, then trust the script proceeds far enough
# to hit the server-only branch (no -SwitchIP) and call Start-MapperWebServer, which we let
# fail fast on the bind (port already in use, or just Ctrl+C-equivalent via timeout) - the
# goal is only to prove the retry-then-succeed decrypt path runs without throwing before
# that point.
$scriptPath = Join-Path $dir "PS_NetworkMapper_V2\Network_Mapper\Start-NetworkMapper.ps1"
$psi = New-Object System.Diagnostics.ProcessStartInfo("pwsh", "-NoProfile -File `"$scriptPath`" -WebPort 18788")
$psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$proc = [System.Diagnostics.Process]::Start($psi)
$proc.StandardInput.WriteLine("WrongPassword1")
Start-Sleep -Milliseconds 500
$proc.StandardInput.WriteLine("CorrectHorse!23")
Start-Sleep -Seconds 3
$out = $proc.StandardOutput.ReadToEnd() + $proc.StandardError.ReadToEnd()
if (-not $proc.HasExited) { $proc.Kill() }
if ($out -notmatch "Failed to decrypt") { throw "Expected a decrypt failure to be logged for the wrong password. Output:`n$out" }
if ($out -match "Aborted") { throw "Should not have aborted - the second (correct) password should have succeeded. Output:`n$out" }
Write-Host "Retry-then-succeed decrypt flow OK" -ForegroundColor Green
Remove-Item -Recurse -Force $dir
'
```

Expected: `Parses cleanly`, `AuthFile removal OK`, `Retry-then-succeed decrypt flow OK`.

- [ ] **Step 7: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Mapper/Start-NetworkMapper.ps1
git commit -m "Start-NetworkMapper.ps1: always-interactive encryption password, decrypt Configuration.json.enc for Juniper credentials, remove -AuthFile"
```

---

### Task 7: `map.js` - generalize the config object to `{devices, credentials, settings}`

**Files:**
- Modify: `PS_NetworkMapper_V2/Network_Visualizer/src/map.js`

**Interfaces:**
- Produces: `window.getLoadedCredentials()` → `{username, password}` (never null - defaults to empty strings). `window.setLoadedCredentials(creds)`. `window.getLoadedSettings()` → object (partial or `{}`). `window.setLoadedSettings(settings)`. `window.ensureConfigLoaded()` → `Promise<void>`, idempotent, prompts for the password at most once per session. `window.saveConfiguration()` → `Promise<boolean>` (previously `Promise<undefined>`; now resolves `true` on success, `false` on any failure). Consumed by Task 8 (`persistence.js`'s `populateSettingsInputs`/`saveSettingsPanel`, `app.js`'s `switchSidebarTab`).

- [ ] **Step 1: Track credentials/settings alongside devices**

Replace the module-level state (lines 9-19):

```javascript
var leafletMap = null;
var mapMarkersByIp = new Map();
var mapConfigEntries = [];      // decrypted Configuration.json's devices[], or [] if none loaded yet
var loadedCredentials = null;   // decrypted Configuration.json's credentials ({username, password}), or null
var loadedSettings = {};        // decrypted Configuration.json's settings (partial or empty) - merge over defaults at read time
var mapConfigLoaded = false;    // true once a GET /api/config attempt (success OR "no file yet") has completed
// True once fitBounds has ever run against real markers. renderMapMarkers is now called
// from every place topology data can change (new snapshot, single-device rescan), not just
// from the original three call sites - re-fitting the camera on every one of those would
// reset the user's pan/zoom every time a rescan completes or a snapshot switches, which is
// worse than the stale-map bug this is fixing. Only the very first time markers appear
// does the camera auto-frame; every re-render after that only touches markers/edges.
var hasFitBoundsOnce = false;
```

- [ ] **Step 2: `loadMapConfiguration` - parse `credentials`/`settings` too, reset them on every early-return path**

Replace the 404 branch:

```javascript
    if (resp.status === 404) {
        mapConfigEntries = [];
        loadedCredentials = null;
        loadedSettings = {};
        mapConfigLoaded = true;
        window.showMapStatus('');
        return;
    }
```

Replace the fetch-error branch:

```javascript
    var resp;
    try {
        resp = await fetch('/api/config');
    } catch (fetchErr) {
        window.showMapStatus('Could not reach the server to load saved locations (' + fetchErr.message + '). Click Map again to retry.');
        mapConfigEntries = [];
        loadedCredentials = null;
        loadedSettings = {};
        mapConfigLoaded = false;
        return;
    }
```

Replace the HTTP-error branch:

```javascript
    if (!resp.ok) {
        window.showMapStatus('Failed to load Configuration.json.enc: HTTP ' + resp.status + '. Click Map again to retry.');
        mapConfigEntries = [];
        loadedCredentials = null;
        loadedSettings = {};
        mapConfigLoaded = false;
        return;
    }
```

Replace the parse-error branch:

```javascript
    var envelope;
    try {
        envelope = await resp.json();
    } catch (parseErr) {
        window.showMapStatus('Configuration.json.enc is not valid JSON (' + parseErr.message + '). Click Map again to retry.');
        mapConfigEntries = [];
        loadedCredentials = null;
        loadedSettings = {};
        mapConfigLoaded = false;
        return;
    }
```

Replace the final success block (was `mapConfigEntries = JSON.parse(decryptedText).devices || [];`):

```javascript
    var parsedConfig = JSON.parse(decryptedText);
    mapConfigEntries = parsedConfig.devices || [];
    loadedCredentials = parsedConfig.credentials || null;
    loadedSettings = parsedConfig.settings || {};
    mapConfigLoaded = true;
    window.showMapStatus('');
```

(the cancelled-password-prompt branch above that - `window.showMapStatus('Location config decryption cancelled...')` - stays exactly as-is, including its existing `mapConfigEntries = []; mapConfigLoaded = false;` lines; add `loadedCredentials = null; loadedSettings = {};` to it too for the same reset-on-retry consistency)

- [ ] **Step 3: Add getters/setters and `ensureConfigLoaded`**

Add these new exports right after `loadMapConfiguration` (before `window.showMapStatus`):

```javascript
window.getLoadedCredentials = function() {
    return loadedCredentials || { username: '', password: '' };
};

window.setLoadedCredentials = function(creds) {
    loadedCredentials = creds;
};

window.getLoadedSettings = function() {
    return loadedSettings || {};
};

window.setLoadedSettings = function(settings) {
    loadedSettings = settings;
};

// Idempotent, session-wide "make sure the config has been fetched" gate - both Map view
// (initMapView, above) and the Settings tab (app.js's switchSidebarTab) call this instead
// of loadMapConfiguration directly, so the password prompt and fetch only ever happen once
// per session regardless of which one the user opens first. A no-op once mapConfigLoaded is
// true; retries a previously failed/cancelled attempt otherwise.
window.ensureConfigLoaded = async function() {
    if (mapConfigLoaded) return;
    await window.loadMapConfiguration();
    if (mapConfigLoaded) window.renderMapMarkers(); // no-op if Map view was never opened (leafletMap === null)
};
```

- [ ] **Step 4: `saveConfiguration` - load-before-save safety guard, include credentials/settings, return success**

Replace the whole function:

```javascript
window.saveConfiguration = async function() {
    // Config may not have loaded yet if this is triggered from the Settings tab before Map
    // view was ever opened (or before an earlier load attempt finished) - saving now would
    // otherwise overwrite devices/credentials/settings this session never actually fetched
    // with empty defaults, silently wiping out everything previously saved (e.g. every
    // placed device location). ensureConfigLoaded is a no-op once a real load has completed.
    await window.ensureConfigLoaded();

    // Merge pending edits over the currently-loaded config entries. An untouched entry
    // (its key+keyType never appears in pendingConfigEdits) survives unchanged.
    //
    // Before inserting each pending edit's entry, collapse any STALE entry left behind by a
    // key change: if a device was saved once under one key (e.g. hostname-keyed, because it
    // had no serial yet) and is now being edited again after its keys changed (e.g. a
    // rescan gave it a serial, so bestKeyForSave now returns the serial key), the old
    // hostname-keyed entry would otherwise never be removed - saveConfiguration only ever
    // added/updated by the NEW key, leaving the stale old-keyed entry sitting in
    // Configuration.json.enc forever. That's not just clutter: resolveDeviceLocation
    // (config-resolve.js) matches purely on `entry.key === value` within a keyType tier
    // with no binding to which device created the entry, so if that old key is ever reused
    // by a DIFFERENT device before that device's own serial is captured, resolution could
    // silently attach the new device to the old device's stale saved location.
    //
    // extractDeviceKeys(device) gives the device's full set of CURRENT candidate keys
    // (serial/hostname/ip, whichever are non-null) - not just the one key this particular
    // edit happens to be saved under - so this removes every one of them from `merged`,
    // regardless of which tier the device used to be keyed by, before inserting the new
    // entry under its (possibly different) current key.
    var merged = new Map(mapConfigEntries.map(function (e) { return [e.keyType + ':' + e.key, e]; }));
    pendingConfigEdits.forEach(function (pending) {
        var device = deviceByIp.get(pending.deviceIp);
        if (device) {
            var keys = window.ConfigResolve.extractDeviceKeys(device);
            ['serial', 'hostname', 'ip'].forEach(function (keyType) {
                var value = keys[keyType];
                if (value !== null && value !== undefined) merged.delete(keyType + ':' + value);
            });
        }
        merged.set(pending.entry.keyType + ':' + pending.entry.key, pending.entry);
    });
    var devices = Array.from(merged.values());

    var resp;
    try {
        resp = await fetch('/api/save-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ devices: devices, credentials: loadedCredentials, settings: loadedSettings }),
        });
    } catch (fetchErr) {
        // Same "must never leave the user without feedback" concern as loadMapConfiguration's
        // fetch above - an unreachable server here would otherwise be an unhandled rejection
        // from the Save button's onclick with no visible sign the click did anything.
        window.showMapStatus('Could not reach the server to save (' + fetchErr.message + '). Click Save Configuration to retry.');
        return false;
    }
    if (!resp.ok) {
        window.showMapStatus('Save failed: HTTP ' + resp.status);
        return false;
    }
    mapConfigEntries = devices;
    pendingConfigEdits.clear();
    window.renderSaveConfigButton();
    window.showMapStatus('Configuration saved.');
    window.renderMapMarkers();
    return true;
};
```

- [ ] **Step 5: Verify - unit test the pure logic touched by this task**

`map.js` is a classic script with heavy DOM/Leaflet coupling (not unit-testable in isolation like `topology-graph.js`/`config-resolve.js`), so verify via a headless-browser smoke check instead. From the repo root:

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox/PS_NetworkMapper_V2/Network_Visualizer
python3 -m http.server 8913 >/tmp/nv-server.log 2>&1 &
SERVER_PID=$!
sleep 1
CB=$(command -v chromium || command -v chromium-browser || echo "")
if [ -z "$CB" ]; then echo "No chromium found - skip headless check, rely on manual verification"; else
  "$CB" --headless --disable-gpu --virtual-time-budget=8000 \
    --screenshot=/dev/null \
    --run-all-compositor-stages-before-draw \
    'http://localhost:8913/network_vis.html' 2>&1 | grep -i "error\|exception" || echo "No console errors on load"
fi
kill $SERVER_PID 2>/dev/null
```

This is a load-only smoke check (confirms no syntax error breaks page load); the full `ensureConfigLoaded`/Settings-tab flow is exercised end-to-end in Task 9's integration pass once `persistence.js`/`network_vis.html` (Task 8) exist too.

- [ ] **Step 6: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Visualizer/src/map.js
git commit -m "map.js: generalize the loaded config object to {devices, credentials, settings}, add ensureConfigLoaded"
```

---

### Task 8: Settings tab becomes `Configuration.json`-backed; Juniper login fields added

**Files:**
- Modify: `PS_NetworkMapper_V2/Network_Visualizer/src/persistence.js`
- Modify: `PS_NetworkMapper_V2/Network_Visualizer/network_vis.html`
- Modify: `PS_NetworkMapper_V2/Network_Visualizer/src/app.js`

**Interfaces:**
- Consumes: `window.getLoadedCredentials`/`setLoadedCredentials`/`getLoadedSettings`/`setLoadedSettings`/`ensureConfigLoaded`/`saveConfiguration` (Task 7).
- Produces: `window.loadSettings()` stays synchronous (unchanged signature - `utils.js`'s `renderCrawlAge` and `dashboard.js`'s fleet-health rendering both keep calling it exactly as before), now backed by the in-memory loaded-config object instead of `localStorage`.

- [ ] **Step 1: `network_vis.html` - add the Juniper Switch Login subhead**

Insert this block as the FIRST thing inside `#sidebar-tab-settings` (right after the opening `<div id="sidebar-tab-settings" class="sidebar-tab-content">` tag, before the existing "Fleet Health Thresholds" subhead):

```html
            <div class="settings-subhead">Juniper Switch Login</div>
            <div class="settings-row">
                <label>Username</label>
                <input type="text" id="setting-junosUsername" autocomplete="username">
            </div>
            <div class="settings-row">
                <label>Password</label>
                <input type="password" id="setting-junosPassword" autocomplete="current-password">
            </div>
            <p style="font-size:0.75rem; color:#888; margin:0 0 4px;">Optional - required for Crawl, Rescan, and Launch SSH Session. Stored in the encrypted Configuration.json.enc, same as saved device locations.</p>

```

(the existing `<div class="settings-subhead">Fleet Health Thresholds</div>` and everything after it stays unchanged, just now preceded by this new block)

- [ ] **Step 2: `persistence.js` - settings become config-backed**

Replace lines 9-19 (`SETTINGS_STORAGE_KEY`/`DEFAULT_SETTINGS`):

```javascript
// Threshold + graph-layout settings, now all persisted in the encrypted
// Configuration.json.enc (via map.js's loaded-config object) instead of localStorage or
// bare DOM state. Alarm severity (Major/Minor) is deliberately not here - it maps directly
// to Junos's own two-tier scheme, not a meaningful place for a user knob. clusterThreshold/
// nodeSpacing/leafSpacing/minRadius match network_vis.html's own static HTML defaults - kept
// here too so resetSettingsPanel and the "not yet loaded" fallback (before Configuration.json.enc
// has ever been fetched this session) have somewhere to fall back to.
var DEFAULT_SETTINGS = {
    cpuWarnPct: 70, cpuCriticalPct: 90,
    memWarnPct: 75, memCriticalPct: 90,
    crawlAgeFreshMin: 60, crawlAgeStaleMin: 1440,
    recentRebootMin: 60,
    clusterThreshold: 50, nodeSpacing: 350, leafSpacing: 250, minRadius: 250,
};
// The four graph-layout keys use their bare id as the DOM element id (#clusterThreshold,
// #nodeSpacing, ...) - a naming convention that predates this file (see network_vis.html) -
// while the threshold keys use a `setting-` prefix (#setting-cpuWarnPct, ...). This maps a
// settings key to its actual input id so populate/save/reset can loop over one key list
// instead of hand-writing two near-identical blocks.
var LAYOUT_SETTING_KEYS = ['clusterThreshold', 'nodeSpacing', 'leafSpacing', 'minRadius'];
function settingInputId(key) {
    return LAYOUT_SETTING_KEYS.indexOf(key) === -1 ? 'setting-' + key : key;
}
```

Replace `window.loadSettings`/`window.saveSettings` (lines 24-39):

```javascript
// Synchronous by design - utils.js's renderCrawlAge (a setInterval tick) and dashboard.js's
// fleet-health rendering both call this on every render, long before (or entirely without)
// the user ever opening the Map view or Settings tab that triggers the actual
// Configuration.json.enc fetch+decrypt (see map.js's ensureConfigLoaded). Reads whatever's
// currently in memory: DEFAULT_SETTINGS until a real config has loaded this session, the
// real saved values after. No longer reads localStorage - settings now live in
// Configuration.json.enc, loaded once per session by map.js's shared config machinery.
window.loadSettings = function() {
    var loaded = window.getLoadedSettings ? window.getLoadedSettings() : {};
    return Object.assign({}, DEFAULT_SETTINGS, loaded);
};
```

- [ ] **Step 3: `populateSettingsInputs` - also populate layout + credential fields**

Replace:

```javascript
// Populates the Settings tab's inputs (thresholds, graph layout, Juniper login) from the
// loaded config - called on tab activation (see window.switchSidebarTab) since there's no
// "open" event for an always-present tab. Called twice per tab-open: once immediately (best
// available values - defaults, or an earlier load) and once after ensureConfigLoaded
// resolves (the real saved values, once the password prompt/fetch complete).
window.populateSettingsInputs = function() {
    var settings = window.loadSettings();
    Object.keys(DEFAULT_SETTINGS).forEach(key => {
        var el = document.getElementById(settingInputId(key));
        if (el) el.value = settings[key];
    });

    var creds = window.getLoadedCredentials ? window.getLoadedCredentials() : { username: '', password: '' };
    var userEl = document.getElementById('setting-junosUsername');
    var passEl = document.getElementById('setting-junosPassword');
    if (userEl) userEl.value = creds.username || '';
    if (passEl) passEl.value = creds.password || '';
};
```

- [ ] **Step 4: `saveSettingsPanel` - collect everything, save through `/api/save-config`**

Replace:

```javascript
window.saveSettingsPanel = async function() {
    var settings = {};
    var invalid = false;
    Object.keys(DEFAULT_SETTINGS).forEach(key => {
        var el = document.getElementById(settingInputId(key));
        var n = el ? parseFloat(el.value) : NaN;
        var min = LAYOUT_SETTING_KEYS.indexOf(key) === -1 ? 0 : (key === 'clusterThreshold' ? 2 : 20);
        if (!Number.isFinite(n) || n < min) { invalid = true; return; }
        settings[key] = n;
    });
    if (invalid) {
        window.setStatus("Settings not saved - all fields must be valid numbers within range.", "red");
        return;
    }

    var userEl = document.getElementById('setting-junosUsername');
    var passEl = document.getElementById('setting-junosPassword');
    window.setLoadedCredentials({
        username: userEl ? userEl.value : '',
        password: passEl ? passEl.value : '',
    });
    window.setLoadedSettings(settings);

    var ok = await window.saveConfiguration();
    if (ok) {
        // Thresholds affect already-rendered UI, not just future renders - refresh anything
        // currently showing threshold-driven state rather than requiring a reload.
        if (loadedSnapshots[activeSnapshotIndex]) window.renderCrawlAge(loadedSnapshots[activeSnapshotIndex].scanTimestamp);
        window.setStatus("Settings saved.", "green");
    } else {
        // saveConfiguration already wrote a detailed reason to the map status note
        // (#mapStatusNote, visible regardless of which sidebar tab or center view is
        // active - see network_vis.html) - this is just the left-panel-local echo of "it
        // failed", not a duplicate of the reason itself.
        window.setStatus("Settings not saved - see the status note for the error.", "red");
    }
};
```

- [ ] **Step 5: `resetSettingsPanel` - also reset layout fields**

Replace:

```javascript
window.resetSettingsPanel = function() {
    Object.keys(DEFAULT_SETTINGS).forEach(key => {
        var el = document.getElementById(settingInputId(key));
        if (el) el.value = DEFAULT_SETTINGS[key];
    });
};
```

- [ ] **Step 6: `app.js` - `switchSidebarTab` triggers config load on first Settings-tab visit**

Replace `window.switchSidebarTab` (lines 184-194):

```javascript
// Sidebar tabs (Load File / Search / Settings / Analysis Dashboard). Panes stay in the
// DOM when hidden (display:none, not removed), so getElementById-based reads elsewhere
// (getClusterThreshold, getLayoutSettings) work regardless of which tab is active. The
// Analysis Dashboard tab widens the panel (.wide-panel) since its tables/charts don't fit
// in the 320px other tabs use - vis-network's own container-size polling picks up the
// resulting #mynetwork resize the same way it already does for panel collapse/expand.
window.switchSidebarTab = async function(tabId) {
    document.querySelectorAll('.sidebar-tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.sidebar-tab').forEach(el => el.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    document.getElementById('btn-' + tabId).classList.add('active');
    document.getElementById('left-panel').classList.toggle('wide-panel', tabId === 'sidebar-tab-analysis');
    activeSidebarTab = tabId;

    if (tabId === 'sidebar-tab-settings') {
        // Immediate paint with whatever's already known (defaults, or an earlier load this
        // session), then widen the config-load trigger to fire here too (previously only
        // Map view did) - both surfaces share the same ensureConfigLoaded gate (map.js), so
        // the password prompt and fetch only ever happen once per session regardless of
        // which one the user opens first.
        window.populateSettingsInputs();
        await window.ensureConfigLoaded();
        window.populateSettingsInputs();
    }
    if (tabId === 'sidebar-tab-analysis') window.refreshAnalysisDashboard();
};
```

- [ ] **Step 7: Verify - headless browser walk-through of the Settings tab**

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox/PS_NetworkMapper_V2/Network_Visualizer
python3 -m http.server 8914 >/tmp/nv-server2.log 2>&1 &
SERVER_PID=$!
sleep 1
CB=$(command -v chromium || command -v chromium-browser || echo "")
if [ -n "$CB" ]; then
cat > /tmp/settings-check.json <<'EOF'
[
  {"nav": "http://localhost:8914/network_vis.html"},
  {"wait": 1500},
  {"eval": "document.getElementById('btn-sidebar-tab-settings').click(); 'clicked'"},
  {"wait": 500},
  {"eval": "document.getElementById('setting-cpuWarnPct').value"},
  {"eval": "document.getElementById('setting-junosUsername') ? 'username field present' : 'MISSING'"},
  {"eval": "document.getElementById('clusterThreshold').value"}
]
EOF
node ~/.claude/tools/cdp.mjs || echo "cdp driver not available in this environment - inspect manually instead"
fi
kill $SERVER_PID 2>/dev/null
```

If the CDP driver isn't available in the execution environment, instead verify by direct inspection: start the static server above, `curl -s http://localhost:8914/network_vis.html | grep -c 'setting-junosUsername\|setting-junosPassword'` should print `2`, and `grep -n "async function\|window.switchSidebarTab = async" src/app.js` should show the new `async` keyword landed.

- [ ] **Step 8: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Visualizer/src/persistence.js PS_NetworkMapper_V2/Network_Visualizer/network_vis.html PS_NetworkMapper_V2/Network_Visualizer/src/app.js
git commit -m "Settings tab becomes Configuration.json-backed: Juniper login fields, thresholds + graph layout persist server-side instead of localStorage"
```

---

### Task 9: Final integration pass - stale comments, `.gitignore` note, end-to-end smoke test

**Files:**
- Modify: `.gitignore` (comment only)
- Modify: `PS_NetworkMapper_V2/Network_Visualizer/src/map.js` (comment only, if any `Auth.json` references remain)
- No new interfaces - this task is cross-file consistency cleanup + a full-stack smoke test.

- [ ] **Step 1: Fix the now-stale `.gitignore` comment**

The comment block at lines 27-30 of `.gitignore` says "V2 shares all of that with PS_NetworkMapper/ above (see Start-NetworkMapper.ps1's $AuthFile/$SnapshotDir defaults)" - `$AuthFile` no longer exists. Update it:

```
# PS_NetworkMapper_V2's Auth.json, Network_Maps/, and NDJSON device-history ledger are
# not duplicated here - V2 shares all of that with PS_NetworkMapper/ above (see
# Start-NetworkMapper.ps1's $SharedMapperDir/$SnapshotDir). Only its own per-run debug
# artifacts are local to it.
```

(no gitignore *pattern* lines change - `PS_NetworkMapper/Network_Mapper/Configuration.json.enc` on line 10 already covers the shared path V2 now writes to unconditionally; V1's own `Auth.json` line 5 is untouched per this plan's Global Constraints)

- [ ] **Step 2: Grep for any remaining stale `Auth.json`/`AuthFile` references in touched files**

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox/PS_NetworkMapper_V2
grep -rn "AuthFile\|Auth\.json" Network_Mapper/Start-NetworkMapper.ps1 Network_Mapper/lib/Start-WebServer.ps1 Network_Mapper/lib/Connect-JunosSsh.ps1 Network_Mapper/lib/Connect-Switch.ps1 Network_Mapper/lib/Get-JunosNodeData.ps1 Network_Visualizer/src/map.js Network_Visualizer/src/app.js Network_Visualizer/src/persistence.js
```

Expected: no output (or only comments in `map.js`/`app.js` that describe filename-filtering behavior unrelated to V2 credentials, e.g. `forceLoadFolder`'s folder-picker filter comment, which is still accurate since V1's `Auth.json` still exists on disk in the shared folder - leave that one alone). If any other match references the old `-AuthFile` mechanism, fix it in place.

- [ ] **Step 3: Full end-to-end smoke test - server-only mode, missing Juniper credentials, Settings save round trip**

This exercises the complete PS + browser stack together: start `Start-NetworkMapper.ps1` in server-only mode (no `-SwitchIP`) against a scratch directory with no pre-existing `Configuration.json.enc`, confirm the server starts and serves the page, confirm `/api/config` 404s cleanly (fresh checkout), then confirm a `/api/save-config` round trip with the browser-shaped `{devices, credentials, settings}` body succeeds and `/api/config` subsequently returns something decryptable with the same password.

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox
pwsh -NoProfile -Command '
. ./PS_NetworkMapper_V2/Network_Mapper/lib/TopologyCrypto.ps1
$dir = Join-Path ([System.IO.Path]::GetTempPath()) "cred-settings-e2e-$([guid]::NewGuid().Guid.Substring(0,8))"
New-Item -ItemType Directory -Path (Join-Path $dir "PS_NetworkMapper\Network_Mapper") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dir "PS_NetworkMapper_V2\Network_Mapper\lib") -Force | Out-Null
$vizSrc = "./PS_NetworkMapper_V2/Network_Visualizer"
Copy-Item $vizSrc (Join-Path $dir "PS_NetworkMapper_V2\Network_Visualizer") -Recurse -Force
Copy-Item ./PS_NetworkMapper_V2/Network_Mapper/Start-NetworkMapper.ps1 (Join-Path $dir "PS_NetworkMapper_V2\Network_Mapper\") -Force
Copy-Item ./PS_NetworkMapper_V2/Network_Mapper/lib/*.ps1 (Join-Path $dir "PS_NetworkMapper_V2\Network_Mapper\lib\") -Force

$scriptPath = Join-Path $dir "PS_NetworkMapper_V2\Network_Mapper\Start-NetworkMapper.ps1"
$psi = New-Object System.Diagnostics.ProcessStartInfo("pwsh", "-NoProfile -File `"$scriptPath`" -WebPort 18789")
$psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$proc = [System.Diagnostics.Process]::Start($psi)
$proc.StandardInput.WriteLine("E2ePassword!1")
Start-Sleep -Seconds 3

try {
    $page = Invoke-WebRequest -Uri "http://localhost:18789/network_vis.html" -SkipHttpErrorCheck
    if ($page.StatusCode -ne 200) { throw "Page did not load: $($page.StatusCode)" }
    Write-Host "Page load OK" -ForegroundColor Green

    $cfgResp = Invoke-WebRequest -Uri "http://localhost:18789/api/config" -SkipHttpErrorCheck
    if ($cfgResp.StatusCode -ne 404) { throw "Expected 404 for a fresh checkout, got $($cfgResp.StatusCode)" }
    Write-Host "Fresh-checkout /api/config 404 OK" -ForegroundColor Green

    $body = @{ devices = @(); credentials = @{ username = "svc-mapper"; password = "hunter2" }; settings = @{ cpuWarnPct = 80 } } | ConvertTo-Json -Depth 5
    $saveResp = Invoke-WebRequest -Uri "http://localhost:18789/api/save-config" -Method Post -Body $body -ContentType "application/json" -Headers @{Origin="http://localhost:18789"} -SkipHttpErrorCheck
    if ($saveResp.StatusCode -ne 200) { throw "Save failed: $($saveResp.StatusCode) $($saveResp.Content)" }
    Write-Host "Save-config round trip OK" -ForegroundColor Green

    $cfgResp2 = Invoke-WebRequest -Uri "http://localhost:18789/api/config" -SkipHttpErrorCheck
    if ($cfgResp2.StatusCode -ne 200) { throw "Expected 200 after a save, got $($cfgResp2.StatusCode)" }
    $envelope = $cfgResp2.Content | ConvertFrom-Json
    $decrypted = Unprotect-TopologyPayload -Envelope $envelope -Password "E2ePassword!1" -ExpectedFormats @("PSNetworkMapper-EncryptedConfig")
    $parsed = $decrypted | ConvertFrom-Json
    if ($parsed.credentials.username -ne "svc-mapper") { throw "Round-tripped username mismatch: $($parsed.credentials.username)" }
    if ($parsed.settings.cpuWarnPct -ne 80) { throw "Round-tripped setting mismatch: $($parsed.settings.cpuWarnPct)" }
    Write-Host "Full round trip (save -> re-fetch -> decrypt with the startup password) OK" -ForegroundColor Green

    $rescanResp = Invoke-WebRequest -Uri "http://localhost:18789/api/rescan" -Method Post -Body (@{ip="10.0.0.1"} | ConvertTo-Json) -ContentType "application/json" -Headers @{Origin="http://localhost:18789"} -SkipHttpErrorCheck
    # This server was started with NO Configuration.json.enc present at startup (the save
    # above happened AFTER the server had already started and cached empty credentials into
    # $JunosUsername/$JunosPassword at launch) - so rescan should still correctly report
    # missing credentials, proving the presence check is live and correctly wired, not just
    # a placeholder.
    if ($rescanResp.StatusCode -ne 400) { throw "Expected 400 (this server session started with no credentials), got $($rescanResp.StatusCode)" }
    Write-Host "Rescan-without-credentials 400 OK (proves the presence check is wired end to end)" -ForegroundColor Green
} finally {
    if (-not $proc.HasExited) { $proc.Kill() }
    Remove-Item -Recurse -Force $dir
}
'
```

Expected: `Page load OK`, `Fresh-checkout /api/config 404 OK`, `Save-config round trip OK`, `Full round trip (save -> re-fetch -> decrypt with the startup password) OK`, `Rescan-without-credentials 400 OK (proves the presence check is wired end to end)`.

- [ ] **Step 4: Run the existing JS unit test suite - confirm nothing broke**

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox/PS_NetworkMapper_V2/Network_Visualizer
node --test src/test/*.test.mjs
```

Expected: all existing tests still pass (this task touches no file those tests import, but this is a real regression check, not a formality - `config-resolve.test.mjs`/`topology-graph.test.mjs`/`topology-crypto.test.mjs` all exercise files this plan's earlier tasks left untouched, and a pass here confirms that).

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "Fix stale $AuthFile reference in .gitignore comment after the Auth.json -> Configuration.json.enc migration"
```

(only commit if Step 1's edit actually changed something - if Step 2's grep found and fixed other stale references in other files, stage and commit those too, in the same commit)

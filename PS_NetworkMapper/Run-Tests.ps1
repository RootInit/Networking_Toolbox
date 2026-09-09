<#
.SYNOPSIS
    Minimal, dependency-free smoke-test harness for PS_NetworkMapper's PowerShell-side
    security/safety-critical logic.

.DESCRIPTION
    Plain PowerShell, no Pester - it isn't guaranteed to be installed on every deployment
    target. Dot-sources the real lib/*.ps1 files and exercises their shipped behavior; it
    never re-implements the logic under test. See the section banners below for what it covers.

.USAGE
    powershell.exe -File .\Run-Tests.ps1
    (run from the project root; plain functions/scriptblocks only, so pwsh works too)

    Exits 0 if every case passed, 1 otherwise.
#>

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$LibDir = Join-Path $ProjectRoot 'lib'

# --- tiny assertion harness -------------------------------------------------------------
$script:Total = 0
$script:Passed = 0

function Test-Case {
    param(
        [Parameter(Mandatory = $true)][string]$Description,
        [Parameter(Mandatory = $true)][scriptblock]$Actual,
        [switch]$ExpectThrow,
        # Regex the thrown message must match. Prefer this over a bare -ExpectThrow for any
        # test asserting that a GUARD rejected something: without it the case passes on any
        # exception at all, so renaming or deleting the guard leaves the test green while
        # proving nothing. -ExpectThrow alone remains valid where the message is incidental.
        [string]$ExpectThrowMatch,
        [switch]$ExpectFalse # default expectation is "truthy" unless this or ExpectThrow is set
    )
    $script:Total++
    $WantThrow = $ExpectThrow -or $PSBoundParameters.ContainsKey('ExpectThrowMatch')
    try {
        $Result = & $Actual
        if ($WantThrow) {
            Write-Host "[FAIL] $Description (expected a throw, none occurred; got: $Result)" -ForegroundColor Red
            return
        }
        # A scriptblock emits its WHOLE output stream, so a stray Write-Output before the real
        # assertion makes $Result a multi-element array - which is truthy regardless of what the
        # assertion actually evaluated to. Demand a single boolean instead of coercing.
        if ($Result -is [object[]]) {
            Write-Host "[FAIL] $Description (scriptblock emitted $($Result.Count) values; the assertion must be the only output)" -ForegroundColor Red
            return
        }
        if ($Result -isnot [bool]) {
            Write-Host "[FAIL] $Description (assertion returned [$(if ($null -eq $Result) { 'null' } else { $Result.GetType().Name })], expected a boolean)" -ForegroundColor Red
            return
        }
        $Ok = if ($ExpectFalse) { -not $Result } else { $Result }
        if ($Ok) {
            Write-Host "[PASS] $Description" -ForegroundColor Green
            $script:Passed++
        } else {
            Write-Host "[FAIL] $Description (got: $Result)" -ForegroundColor Red
        }
    } catch {
        $Message = $_.Exception.Message
        if (-not $WantThrow) {
            Write-Host "[FAIL] $Description (unexpected throw: $Message)" -ForegroundColor Red
            return
        }
        # A missing/renamed function throws too, which would otherwise satisfy every
        # -ExpectThrow case in this file and hide the deletion of the code under test.
        if ($_.CategoryInfo.Reason -eq 'CommandNotFoundException') {
            Write-Host "[FAIL] $Description (the function under test does not exist: $Message)" -ForegroundColor Red
            return
        }
        if ($ExpectThrowMatch -and $Message -notmatch $ExpectThrowMatch) {
            Write-Host "[FAIL] $Description (threw, but message did not match '$ExpectThrowMatch': $Message)" -ForegroundColor Red
            return
        }
        Write-Host "[PASS] $Description (threw as expected: $Message)" -ForegroundColor Green
        $script:Passed++
    }
}

# =========================================================================================
# 1. Get-JunosNodeData.ps1 RawDumps secret-redaction regex
# =========================================================================================
# Get-JunosNodeData.ps1 opens a real ssh.exe session, so there's no dot-sourceable function to
# call. Extract the shipped -replace pattern/replacement literals from the source and apply
# them, rather than hand-copying the regex here where it could drift from the real one.
Write-Host "`n--- 1. RawDumps secret-redaction regex (Get-JunosNodeData.ps1:147) ---" -ForegroundColor Cyan

$JunosNodeDataPath = Join-Path $LibDir 'Get-JunosNodeData.ps1'
$JunosNodeDataSrc = Get-Content -LiteralPath $JunosNodeDataPath -Raw
$RedactMatch = [regex]::Match(
    $JunosNodeDataSrc,
    "(?s)\`$RedactedOutput\s*=\s*\`$RawOutput\s*-replace\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'"
)

if (-not $RedactMatch.Success) {
    Write-Host "[FAIL] Could not locate the redaction -replace expression in Get-JunosNodeData.ps1 - has it moved or been rewritten? (skipping redaction test cases)" -ForegroundColor Red
    $script:Total++
} else {
    $RedactPattern = $RedactMatch.Groups[1].Value -replace "''", "'"
    $RedactReplacement = $RedactMatch.Groups[2].Value -replace "''", "'"

    # Case A: a representative real dump - secret in the config section must be redacted.
    $DumpWithSecret = @"
admin@switch1> show system uptime
System booted: 2024-01-01 00:00:00 UTC

admin@switch1> show configuration | display set
set system radius-server 10.1.1.1 secret "TopSecretPassword1"
set system root-authentication encrypted-password "`$1`$abcdefgh`$restofhash"

admin@switch1> show interfaces extensive
Physical interface: ge-0/0/0, Enabled, Physical link is Up
"@
    $RedactedA = $DumpWithSecret -replace $RedactPattern, $RedactReplacement
    Test-Case "redacts a secret found in the config section" { $RedactedA -notmatch 'TopSecretPassword1' }
    Test-Case "leaves a CONFIGURATION REDACTED marker in place of the secret" { $RedactedA -match 'CONFIGURATION REDACTED' }
    Test-Case "does not touch unrelated sections (uptime line still present)" { $RedactedA -match 'System booted: 2024-01-01' }

    # Case B: no config section at all -> no over-redaction, output passes through unchanged.
    $DumpNoConfig = @"
admin@switch1> show system uptime
System booted: 2024-01-01 00:00:00 UTC

admin@switch1> show lldp neighbors
Local Interface: ge-0/0/0, Parent Interface: -, Chassis Id: 00:11:22:33:44:55
"@
    $RedactedB = $DumpNoConfig -replace $RedactPattern, $RedactReplacement
    Test-Case "dump with no config section passes through byte-for-byte unchanged" { $RedactedB -eq $DumpNoConfig }

    # Case C: a decoy, prompt-shaped line planted inside a later command's output (e.g. an
    # operator-set interface Description), positioned AFTER the real config section. A greedy
    # prefix would backtrack to the later decoy and leave the earlier real secret
    # un-redacted; the shipped regex uses a non-greedy prefix to avoid that.
    $DumpWithDecoy = @"
admin@switch1> show system uptime
System booted: 2024-01-01 00:00:00 UTC

admin@switch1> show configuration | display set
set system radius-server 10.1.1.1 secret "TopSecretPassword1"
set system root-authentication encrypted-password "`$1`$abcdefgh`$restofhash"

admin@switch1> show interfaces extensive
Physical interface: ge-0/0/0, Enabled, Physical link is Up
  Description: fake decoy line -> admin@switch1> show configuration | display set
  Link-level type: Ethernet
"@
    $RedactedC = $DumpWithDecoy -replace $RedactPattern, $RedactReplacement
    Test-Case "decoy prompt-shaped text later in the stream does not un-redact the real earlier secret (Pass 6->7 regression shape)" { $RedactedC -notmatch 'TopSecretPassword1' }
}

# =========================================================================================
# 2. SshHelpers.ps1 Get-JunosSshArgs injection guard
# =========================================================================================
Write-Host "`n--- 2. Get-JunosSshArgs injection guard (SshHelpers.ps1) ---" -ForegroundColor Cyan
. (Join-Path $LibDir 'SshHelpers.ps1')

Test-Case "valid username + valid IP is accepted" {
    (Get-JunosSshArgs -Username "admin" -TargetIP "10.1.2.3") -join ' ' -match '10\.1\.2\.3'
}

# Regression guard: if ServerAliveInterval x ServerAliveCountMax is shorter than the worker's
# per-batch Process.WaitForExit, ssh tears down healthy sessions to switches whose RE stalls
# mid-batch, yielding an empty payload on those switches only.
Test-Case "ssh keepalive budget stays longer than the worker's per-batch timeout" {
    $SshArgs = Get-JunosSshArgs -Username "admin" -TargetIP "10.1.2.3"
    $Interval = [int](($SshArgs | Where-Object { $_ -like 'ServerAliveInterval=*' }) -replace '\D')
    $CountMax = [int](($SshArgs | Where-Object { $_ -like 'ServerAliveCountMax=*' }) -replace '\D')

    # Read the worker's real timeout rather than hardcoding it, so the two stay coupled.
    $WorkerSrc = Get-Content -LiteralPath (Join-Path $LibDir 'Get-JunosNodeData.ps1') -Raw
    if ($WorkerSrc -notmatch 'WaitForExit\((?<ms>\d+)\)') { throw "Could not find WaitForExit(<ms>) in Get-JunosNodeData.ps1" }
    $BatchTimeoutSec = [int]$Matches.ms / 1000

    $KeepaliveBudget = $Interval * $CountMax
    if ($KeepaliveBudget -le $BatchTimeoutSec) {
        throw "ssh keepalive budget ${KeepaliveBudget}s must exceed the ${BatchTimeoutSec}s batch timeout, or ssh kills sessions the batch is still waiting on"
    }
    $true
}

# Same coupling one layer up: the orchestrator's abandon deadline has to outlast a worker that
# is legitimately sitting on its full batch timeout, or slow-but-healthy switches get dropped
# from the crawl with "job abandoned".
Test-Case "orchestrator job-abandon deadline stays longer than the worker's per-batch timeout" {
    $WorkerSrc = Get-Content -LiteralPath (Join-Path $LibDir 'Get-JunosNodeData.ps1') -Raw
    if ($WorkerSrc -notmatch 'WaitForExit\((?<ms>\d+)\)') { throw "Could not find WaitForExit(<ms>) in Get-JunosNodeData.ps1" }
    $BatchTimeoutSec = [int]$Matches.ms / 1000

    $CrawlSrc = Get-Content -LiteralPath (Join-Path $LibDir 'FleetCrawl.ps1') -Raw
    if ($CrawlSrc -notmatch '\$JobAbandonSeconds\s*=\s*(?<sec>\d+)') { throw "Could not find `$JobAbandonSeconds in FleetCrawl.ps1" }
    $AbandonSec = [int]$Matches.sec

    if ($AbandonSec -le $BatchTimeoutSec) {
        throw "job-abandon deadline ${AbandonSec}s must exceed the ${BatchTimeoutSec}s batch timeout, or the orchestrator discards workers that were still going to succeed"
    }
    $true
}
Test-Case "username with a leading dash is rejected (would be parsed as an ssh flag)" {
    Get-JunosSshArgs -Username "-oProxyCommand=evil" -TargetIP "10.1.2.3"
} -ExpectThrowMatch 'Invalid Junos username'
Test-Case "username with a shell metacharacter (semicolon) is rejected" {
    Get-JunosSshArgs -Username "admin;rm -rf /" -TargetIP "10.1.2.3"
} -ExpectThrowMatch 'Invalid Junos username'
Test-Case "username with a backtick command substitution is rejected" {
    Get-JunosSshArgs -Username 'admin`whoami`' -TargetIP "10.1.2.3"
} -ExpectThrowMatch 'Invalid Junos username'
Test-Case "username with a `$() command substitution is rejected" {
    Get-JunosSshArgs -Username 'admin$(whoami)' -TargetIP "10.1.2.3"
} -ExpectThrowMatch 'Invalid Junos username'
Test-Case "username with an embedded newline is rejected" {
    Get-JunosSshArgs -Username "admin`nssh evilhost" -TargetIP "10.1.2.3"
} -ExpectThrowMatch 'Invalid Junos username'
Test-Case "target IP with a shell metacharacter (semicolon) is rejected" {
    Get-JunosSshArgs -Username "admin" -TargetIP "10.1.2.3;rm -rf /"
} -ExpectThrowMatch 'Invalid Junos target IP'
Test-Case "target IP with an out-of-range octet (999) is rejected" {
    Get-JunosSshArgs -Username "admin" -TargetIP "10.1.2.999"
} -ExpectThrowMatch 'Invalid Junos target IP'
Test-Case "target IP missing an octet is rejected" {
    Get-JunosSshArgs -Username "admin" -TargetIP "10.1.2"
} -ExpectThrowMatch 'Invalid Junos target IP'

# =========================================================================================
# 3. FleetCrawl.ps1 Test-IpInAllowedScopes crawl-scope fence
# =========================================================================================
Write-Host "`n--- 3. Test-IpInAllowedScopes crawl-scope fence (FleetCrawl.ps1) ---" -ForegroundColor Cyan
. (Join-Path $LibDir 'FleetCrawl.ps1')

$DefaultScopes = @("131.30.")
Test-Case "IP inside the default allowed scope is allowed" {
    Test-IpInAllowedScopes -IP "131.30.5.10" -AllowedScopes $DefaultScopes
}
Test-Case "IP clearly outside the default allowed scope is blocked" {
    Test-IpInAllowedScopes -IP "10.0.0.1" -AllowedScopes $DefaultScopes
} -ExpectFalse
Test-Case "IP that is a numeric superstring of the scope (not prefix-bounded) is blocked" {
    # "1131.30.1.1" contains "131.30." as a substring but does not start with it - a naive
    # substring (rather than prefix) match would wrongly allow this.
    Test-IpInAllowedScopes -IP "1131.30.1.1" -AllowedScopes $DefaultScopes
} -ExpectFalse
Test-Case "IP sharing the scope's digits but not the trailing dot boundary is blocked (e.g. 131.300.1.1)" {
    Test-IpInAllowedScopes -IP "131.300.1.1" -AllowedScopes $DefaultScopes
} -ExpectFalse
Test-Case "IP exactly equal to the scope with its trailing dot trimmed is allowed" {
    Test-IpInAllowedScopes -IP "131.30" -AllowedScopes $DefaultScopes
}
Test-Case "empty IP is blocked" {
    Test-IpInAllowedScopes -IP "" -AllowedScopes $DefaultScopes
} -ExpectFalse

# =========================================================================================
# 4. FileHelpers.ps1 Move-FileAtomic / Set-FileContentAtomic
# =========================================================================================
Write-Host "`n--- 4. Move-FileAtomic / Set-FileContentAtomic (FileHelpers.ps1) ---" -ForegroundColor Cyan
. (Join-Path $LibDir 'FileHelpers.ps1')

$TestDir = Join-Path ([System.IO.Path]::GetTempPath()) "pnm_runtests_$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $TestDir -Force | Out-Null
try {
    # Case: destination does not exist yet.
    $Src1 = Join-Path $TestDir "src1.txt"
    $Dst1 = Join-Path $TestDir "dst1.txt"
    Set-Content -LiteralPath $Src1 -Value "new content" -NoNewline
    Move-FileAtomic -SourcePath $Src1 -DestinationPath $Dst1
    Test-Case "Move-FileAtomic creates the destination when it doesn't exist yet" { Test-Path -LiteralPath $Dst1 }
    Test-Case "Move-FileAtomic: destination content matches the source" { (Get-Content -LiteralPath $Dst1 -Raw) -eq "new content" }
    Test-Case "Move-FileAtomic: source file no longer exists after the move" { -not (Test-Path -LiteralPath $Src1) }

    # Case: destination already exists (overwrite path).
    $Src2 = Join-Path $TestDir "src2.txt"
    $Dst2 = Join-Path $TestDir "dst2.txt"
    Set-Content -LiteralPath $Dst2 -Value "old content" -NoNewline
    Set-Content -LiteralPath $Src2 -Value "replacement content" -NoNewline
    Move-FileAtomic -SourcePath $Src2 -DestinationPath $Dst2
    Test-Case "Move-FileAtomic overwrites an existing destination's content" { (Get-Content -LiteralPath $Dst2 -Raw) -eq "replacement content" }
    Test-Case "Move-FileAtomic (overwrite case): source file no longer exists after the move" { -not (Test-Path -LiteralPath $Src2) }

    # Set-FileContentAtomic: convenience wrapper, both fresh-write and overwrite.
    $Dst3 = Join-Path $TestDir "dst3.txt"
    Set-FileContentAtomic -DestinationPath $Dst3 -Content "hello world" -NoNewline
    Test-Case "Set-FileContentAtomic writes content to a fresh destination" { (Get-Content -LiteralPath $Dst3 -Raw) -eq "hello world" }
    Set-FileContentAtomic -DestinationPath $Dst3 -Content "updated content" -NoNewline
    Test-Case "Set-FileContentAtomic overwrites existing destination content" { (Get-Content -LiteralPath $Dst3 -Raw) -eq "updated content" }
    Test-Case "Set-FileContentAtomic leaves no leftover .tmp file behind" {
        -not (Get-ChildItem -Path $TestDir -Filter "dst3.txt.*.tmp" -File -ErrorAction SilentlyContinue)
    }
} finally {
    Remove-Item -LiteralPath $TestDir -Recurse -Force -ErrorAction SilentlyContinue
}

# =========================================================================================
# 5. Cross-session history-merge / reboot detection
# =========================================================================================
Write-Host "`n--- 5. coverage-5 (history-merge / reboot detection) ---" -ForegroundColor Cyan
Write-Host "SKIPPED: this logic lives entirely in web-src/persistence.js (JS), already covered" -ForegroundColor Yellow
Write-Host "by web-src/test/*.test.mjs via 'node --test'. No PowerShell-side reboot-detection" -ForegroundColor Yellow
Write-Host "(comparison) logic exists to test here - not forcing an inapplicable PS test." -ForegroundColor Yellow

# Bonus: the Uptime "System booted:" parsing regex that feeds the JS-side reboot detection,
# extracted from source the same way as item 1 above.
$UptimeMatch = [regex]::Match(
    $JunosNodeDataSrc,
    "(?s)if\s*\(\`$UptimeScope\s*-match\s*`"([^`"]*)`"\)"
)
if (-not $UptimeMatch.Success) {
    Write-Host "[FAIL] Could not locate the Uptime 'System booted:' parsing regex in Get-JunosNodeData.ps1 - has it moved? (skipping bonus case)" -ForegroundColor Red
    $script:Total++
} else {
    $UptimePattern = $UptimeMatch.Groups[1].Value
    $UptimeSample = "System booted: 2024-01-01 00:00:00 UTC (300w2d 03:00 ago)"
    $UptimeResult = $UptimeSample -match $UptimePattern
    Test-Case "(bonus) Uptime parsing regex extracts the boot timestamp from a 'show system uptime' line" {
        $UptimeResult -and ($Matches.boot.Trim() -eq "2024-01-01 00:00:00 UTC")
    }
}

# =========================================================================================
# 6. TopologyCrypto.ps1 envelope (round-trip, tamper rejection, JS interop)
# =========================================================================================
# This is the most security-critical PowerShell in the repo and had no coverage at all. It
# must also stay byte-compatible with web-src/topology-crypto.js, which decrypts the same
# envelopes in the browser - hence the fixed vector below, which web-src/test/topology-crypto.test.mjs
# decrypts from its own copy. If either side drifts, exactly one of the two suites goes red.
Write-Host "`n--- 6. TopologyCrypto envelope ---" -ForegroundColor Cyan

. (Join-Path $LibDir 'TopologyCrypto.ps1')

$CryptoPassword = "Correct Horse Battery Staple"
$CryptoPlain = '{"Topology":[{"DeviceIP":"10.55.1.1"}],"ScanTimestamp":"2026-01-01T00:00:00Z"}'
$CryptoSalt = [byte[]](1..16)
# 1000 is the documented floor; the shipped 600k would make this suite take minutes.
$CryptoIter = 1000
$CryptoKeys = Get-TopologyKeyMaterial -Password $CryptoPassword -Salt $CryptoSalt -Iterations $CryptoIter
$CryptoEnvelope = Protect-TopologyPayload -PlainJson $CryptoPlain -EncKey $CryptoKeys.EncKey -MacKey $CryptoKeys.MacKey -Salt $CryptoSalt -Iterations $CryptoIter

Test-Case "round-trips a payload through Protect/Unprotect unchanged" {
    (Unprotect-TopologyPayload -Envelope $CryptoEnvelope -Password $CryptoPassword) -eq $CryptoPlain
}
Test-Case "a fresh IV is generated per call (two encryptions of the same input differ)" {
    $Second = Protect-TopologyPayload -PlainJson $CryptoPlain -EncKey $CryptoKeys.EncKey -MacKey $CryptoKeys.MacKey -Salt $CryptoSalt -Iterations $CryptoIter
    $Second.iv -ne $CryptoEnvelope.iv -and $Second.ciphertext -ne $CryptoEnvelope.ciphertext
}
Test-Case "the wrong password is rejected" {
    Unprotect-TopologyPayload -Envelope $CryptoEnvelope -Password "wrong password"
} -ExpectThrowMatch 'Incorrect password, or the file is corrupted'

# Tamper cases. Each flips one byte of one field; the HMAC covers IV+ciphertext and is
# checked BEFORE decrypting, so all three must fail with the same clean error rather than
# surfacing a raw AES padding exception.
function New-TamperedEnvelope {
    param($Source, [string]$Field)
    $Copy = [ordered]@{}
    foreach ($Key in $Source.Keys) { $Copy[$Key] = $Source[$Key] }
    $Bytes = [Convert]::FromBase64String($Source[$Field])
    $Bytes[0] = $Bytes[0] -bxor 0xFF
    $Copy[$Field] = [Convert]::ToBase64String($Bytes)
    return $Copy
}
foreach ($TamperField in @('ciphertext', 'iv', 'mac')) {
    $Tampered = New-TamperedEnvelope -Source $CryptoEnvelope -Field $TamperField
    Test-Case "a tampered $TamperField is rejected before decryption" {
        Unprotect-TopologyPayload -Envelope $Tampered -Password $CryptoPassword
    } -ExpectThrowMatch 'Incorrect password, or the file is corrupted'
}

# Type strictness. PowerShell's -ne coerces the right operand to the left's type, so a JSON
# string "1" would compare equal to 1 - the JS side's strict !== rejects it, and these guards
# exist so both runtimes agree on what is a valid envelope.
Test-Case "a JSON-string version is rejected (PS coercion must not accept what JS rejects)" {
    $Bad = [ordered]@{}; foreach ($Key in $CryptoEnvelope.Keys) { $Bad[$Key] = $CryptoEnvelope[$Key] }
    $Bad['version'] = "1"
    Unprotect-TopologyPayload -Envelope $Bad -Password $CryptoPassword
} -ExpectThrowMatch 'Unsupported envelope version'
Test-Case "a JSON-string iteration count is rejected" {
    $Bad = [ordered]@{}; foreach ($Key in $CryptoEnvelope.Keys) { $Bad[$Key] = $CryptoEnvelope[$Key] }
    $Bad['iterations'] = "1000"
    Unprotect-TopologyPayload -Envelope $Bad -Password $CryptoPassword
} -ExpectThrowMatch 'Iteration count out of range'
Test-Case "an absurd iteration count is rejected without overflowing (1e300 CPU-burn guard)" {
    $Bad = [ordered]@{}; foreach ($Key in $CryptoEnvelope.Keys) { $Bad[$Key] = $CryptoEnvelope[$Key] }
    $Bad['iterations'] = 1e300
    Unprotect-TopologyPayload -Envelope $Bad -Password $CryptoPassword
} -ExpectThrowMatch 'Iteration count out of range'
Test-Case "an envelope of the wrong format is rejected" {
    $Bad = [ordered]@{}; foreach ($Key in $CryptoEnvelope.Keys) { $Bad[$Key] = $CryptoEnvelope[$Key] }
    $Bad['format'] = "SomethingElse"
    Unprotect-TopologyPayload -Envelope $Bad -Password $CryptoPassword
} -ExpectThrowMatch 'Not a recognized encrypted file'

# Fixed cross-runtime vector: produced by Protect-TopologyPayload, decrypted here AND by
# web-src/test/topology-crypto.test.mjs. Pins salt/IV/MAC ordering, base64 and UTF-8 handling
# across both implementations.
$InteropEnvelope = '{"format":"PSNetworkMapper-EncryptedTopology","version":1,"kdf":"PBKDF2-SHA256","iterations":1000,"cipher":"AES-256-CBC","macAlgorithm":"HMAC-SHA256","salt":"AQIDBAUGBwgJCgsMDQ4PEA==","iv":"b+iBnE7OTNxUHdbMJLgqNA==","mac":"ZPIp4GkNDGJeBU0QZ1VLLci2HQGC482oBvInAG1G5tw=","ciphertext":"k1v8NbYk+p0Qm04nui5MVixuNLLTPAxZyxnlc0vwyvgCnckpR+qhdOu9xhXCE2L2sDIZVf75RyOZ3oE2RdLWeJtbJjgk7Ub+lA/5hzA+HJPzSFNulBOHlKPCTVbyGEknwmUyA+7tu8l4JHNBkwk6cw=="}' | ConvertFrom-Json
Test-Case "decrypts the fixed interop vector shared with the JS implementation" {
    (Unprotect-TopologyPayload -Envelope $InteropEnvelope -Password "Correct Horse Battery Stapleäöü😀") -eq '{"Topology":[{"DeviceIP":"10.55.1.1","Hostname":"swutch-e"}],"ScanTimestamp":"2026-01-01T00:00:00Z"}'
}

# =========================================================================================
# 7. Get-JunosNodeData.ps1 CLI-output regexes that have silently failed on 100% of real input
# =========================================================================================
# Both regexes below shipped in a state where they matched nothing (PoE) or the wrong field on
# every neighbour (LLDP), and neither failed loudly - the fields just came back "Unknown" or
# nonsense. Patterns are extracted from the shipped source rather than retyped, so they cannot
# drift from what actually runs. Fixtures are synthetic, in the real Junos column layout.
Write-Host "`n--- 7. Junos CLI parsing regexes ---" -ForegroundColor Cyan

# --- LLDP remote port ---
# The block's Local Information section contains "Local Port ID : <local ifIndex>". An
# unanchored "Port ID\s*:" matches inside THAT line first, so every neighbour's RemotePort
# became the local interface's ifIndex integer instead of the neighbour's port name.
$LldpMatch = [regex]::Match($JunosNodeDataSrc, '\$Block\s+-match\s+"((?:[^"\\]|\\.)*rport(?:[^"\\]|\\.)*)"')
if (-not $LldpMatch.Success) {
    Write-Host "[FAIL] Could not locate the LLDP RemotePort regex in Get-JunosNodeData.ps1" -ForegroundColor Red
    $script:Total++
} else {
    $LldpPattern = $LldpMatch.Groups[1].Value
    $LldpBlock = @"
Local Interface    : ge-0/0/33
Local Parent Interface : -
Local Port ID      : 564
Ageout Count       : 0

Neighbour Information:
Chassis type       : Mac address
Chassis ID         : 00:11:22:33:44:55
Port type          : Locally assigned
Port ID            : ge-0/0/23
System name        : NEIGHBOR-SWITCH
"@
    $LldpOk = $LldpBlock -match $LldpPattern
    Test-Case "LLDP RemotePort takes the neighbour's Port ID, not the local ifIndex" {
        $LldpOk -and $Matches.rport.Trim() -eq 'ge-0/0/23'
    }
    Test-Case "LLDP RemotePort is not the bare integer from 'Local Port ID'" {
        $LldpOk -and $Matches.rport.Trim() -ne '564'
    }
}

# --- PoE interface table ---
# The field count between Oper and Power/Class varies by Junos version and platform, so the
# pattern must anchor Power+Class as the last two tokens rather than assume a fixed column.
# A fixed-position pattern matched zero rows on a real EX3400.
$PoeMatch = [regex]::Match($JunosNodeDataSrc, '\$Line\s+-match\s+"((?:[^"\\]|\\.)*\(\?<power>(?:[^"\\]|\\.)*)"')
if (-not $PoeMatch.Success) {
    Write-Host "[FAIL] Could not locate the PoE interface regex in Get-JunosNodeData.ps1" -ForegroundColor Red
    $script:Total++
} else {
    $PoePattern = $PoeMatch.Groups[1].Value
    # Real EX3400 layout: Interface Admin Oper Max-power Priority Power-consumption Class
    Test-Case "PoE row parses on the 7-column layout (power and class are the last two fields)" {
        $Row = "ge-0/0/0          Enabled    ON       30.0W       Low      1.6W             1"
        ($Row -match $PoePattern) -and $Matches.port -eq 'ge-0/0/0' -and $Matches.power -eq '1.6W' -and $Matches.class -eq '1'
    }
    Test-Case "PoE row parses when Class is 'not-applicable' (port powered off)" {
        $Row = "ge-0/0/5          Enabled    OFF      30.0W       Low      0.0W             not-applicable"
        ($Row -match $PoePattern) -and $Matches.oper -eq 'OFF' -and $Matches.class -eq 'not-applicable'
    }
    Test-Case "PoE row parses on a shorter legacy layout (fewer columns between Oper and Power)" {
        $Row = "ge-0/0/9          Enabled    ON       15.4W       6.3W             4"
        ($Row -match $PoePattern) -and $Matches.power -eq '6.3W' -and $Matches.class -eq '4'
    }
    Test-Case "a PoE table header row is not mistaken for data" {
        $Header = "Interface     Admin      Oper     Max-power   Priority  Power-consumption Class"
        -not ($Header -match $PoePattern)
    }
}

# --- multi-VLAN spanning-tree collapse ---
# "show spanning-tree interface" repeats a port once per VLAN. The loop used to overwrite .STP
# on every repeat, so a trunk BLK in one VLAN and FWD in another reported whichever VLAN came
# last - on a real capture two uplinks disagreed across VLANs and both reported FWD. The field
# is still one state string; repeats are now collapsed by precedence, BLK highest.
$StpLineMatch = [regex]::Match($JunosNodeDataSrc, '\$Line\s+-match\s+"((?:[^"\\]|\\.)*\(\?<state>FWD(?:[^"\\]|\\.)*)"')
$StpPrecMatch = [regex]::Match($JunosNodeDataSrc, '\$StpStatePrecedence\s*=\s*(@\{[^}]*\})')
if (-not ($StpLineMatch.Success -and $StpPrecMatch.Success)) {
    Write-Host "[FAIL] Could not locate the spanning-tree line regex or precedence table in Get-JunosNodeData.ps1" -ForegroundColor Red
    $script:Total++
} else {
    $StpPattern = $StpLineMatch.Groups[1].Value
    $StpPrecedence = Invoke-Expression $StpPrecMatch.Groups[1].Value
    # Real layout: the same three ports repeated per STP instance, ge-0/2/0 and ae0 blocking
    # only in instance 100.
    $StpText = @"
Spanning tree interface parameters for instance 0

Interface    Port ID    Designated       Designated         Port    State  Role
                         port ID           bridge ID         Cost
ge-0/2/0     128:513    128:513   32768.0019e2b0c380         20000  FWD    DESG
ae0          128:600    128:600   32768.0019e2b0c380         20000  FWD    DESG
ge-0/0/5     128:518    128:518   32768.0019e2b0c380         20000  FWD    DESG

Spanning tree interface parameters for instance 100

ge-0/2/0     128:513    128:513   32768.0019e2b0c380         20000  BLK    ALT
ae0          128:600    128:600   32768.0019e2b0c380         20000  BLK    ALT
ge-0/0/5     128:518    128:518   32768.0019e2b0c380         20000  FWD    DESG

Spanning tree interface parameters for instance 200

ge-0/2/0     128:513    128:513   32768.0019e2b0c380         20000  FWD    DESG
ae0          128:600    128:600   32768.0019e2b0c380         20000  FWD    DESG
ge-0/0/5     128:518    128:518   32768.0019e2b0c380         20000  FWD    DESG
"@
    # Mirrors the shipped collapse using the shipped pattern and the shipped precedence table.
    $StpCollapsed = @{}
    foreach ($Line in ($StpText -split "`n")) {
        $Line = $Line.Trim()
        if ($Line -match $StpPattern) {
            $StpPort = $Matches.port -replace "\.\d+$",""
            $StpNew = $Matches.state
            $StpRank = 0
            if ($StpCollapsed.ContainsKey($StpPort) -and $StpPrecedence.ContainsKey($StpCollapsed[$StpPort])) { $StpRank = $StpPrecedence[$StpCollapsed[$StpPort]] }
            if ($StpPrecedence[$StpNew] -gt $StpRank) { $StpCollapsed[$StpPort] = $StpNew }
        }
    }
    Test-Case "STP: a port blocking in one VLAN and forwarding in later ones reports BLK, not the last VLAN's FWD" {
        $StpCollapsed['ge-0/2/0'] -eq 'BLK'
    }
    Test-Case "STP: an AE bundle blocking in one VLAN reports BLK too (both real-capture uplinks)" {
        $StpCollapsed['ae0'] -eq 'BLK'
    }
    Test-Case "STP: a port forwarding in every VLAN still reports FWD" {
        $StpCollapsed['ge-0/0/5'] -eq 'FWD'
    }
    Test-Case "STP: BLK outranks every other state in the shipped precedence table" {
        $Others = @('LST','LRN','FWD','DIS') | Where-Object { $StpPrecedence[$_] -ge $StpPrecedence['BLK'] }
        $Others.Count -eq 0
    }
    Test-Case "STP: the collapsed value is still a single state string, not a per-VLAN collection" {
        $StpCollapsed['ge-0/2/0'] -is [string]
    }
}

# --- virtual-chassis master RE scoping (show version / show system uptime) ---
# Both commands emit one "fpcN:" block per VC member and a bare -match takes fpc0's. On the real
# capture the prompt was {master:1} while the parsed boot time was fpc0's, so reboot detection
# compared a member that is not the RE that answered.
$MasterBlockMatch = [regex]::Match($JunosNodeDataSrc, '\$MasterFpcBlockPattern\s*=\s*"((?:[^"\\]|\\.)*)"')
$MasterPromptMatch = [regex]::Match($JunosNodeDataSrc, '\$RawOutput\s+-match\s+"((?:[^"\\]|\\.)*\(\?<fpc>(?:[^"\\]|\\.)*)"')
$UptimeScopeMatch = [regex]::Match($JunosNodeDataSrc, '\$UptimeScope\s+-match\s+"((?:[^"\\]|\\.)*\(\?<boot>(?:[^"\\]|\\.)*)"')
$VersionScopeMatch = [regex]::Match($JunosNodeDataSrc, '\$VersionScope\s+-match\s+"((?:[^"\\]|\\.)*\(\?<ver>(?:[^"\\]|\\.)*)"')
if (-not ($MasterBlockMatch.Success -and $MasterPromptMatch.Success -and $UptimeScopeMatch.Success -and $VersionScopeMatch.Success)) {
    Write-Host "[FAIL] Could not locate the master-RE scoping regexes in Get-JunosNodeData.ps1" -ForegroundColor Red
    $script:Total++
} else {
    $MasterPromptPattern = $MasterPromptMatch.Groups[1].Value
    $UptimePattern = $UptimeScopeMatch.Groups[1].Value
    $VersionPattern = $VersionScopeMatch.Groups[1].Value
    $VcVersion = @"
fpc0:
--------------------------------------------------------------------------
Hostname: SW-EDGE-01
Model: ex4300-48t
Junos: 18.4R3-S9.2

fpc1:
--------------------------------------------------------------------------
Hostname: SW-EDGE-02
Model: ex4300-48t
Junos: 20.4R3-S4.8
"@
    $VcUptime = @"
fpc0:
--------------------------------------------------------------------------
Current time: 2026-08-28 09:15:22 UTC
System booted: 2026-01-04 02:11:07 UTC (33w4d 07:04 ago)
Last configured: 2026-08-01 12:00:00 UTC (4w0d 00:00 ago) by admin

fpc1:
--------------------------------------------------------------------------
Current time: 2026-08-28 09:15:22 UTC
System booted: 2026-08-20 18:44:31 UTC (1w0d 14:30 ago)
Last configured: 2026-08-01 12:00:00 UTC (4w0d 00:00 ago) by admin
"@
    # fpc1 is master here, exactly as on the real capture's {master:1} prompt.
    $VcRaw = "{master:1}`nadmin@SW-EDGE-01> show system uptime`n"
    $MasterFpcId = $null
    if ($VcRaw -match $MasterPromptPattern) { $MasterFpcId = $Matches.fpc }
    # ${MasterFpcId} is substituted the same way the shipped string interpolation does.
    $MasterPattern = $MasterBlockMatch.Groups[1].Value -replace '\$\{MasterFpcId\}', $MasterFpcId

    Test-Case "master RE is taken from the {master:N} prompt, not assumed to be fpc0" {
        $MasterFpcId -eq '1'
    }
    Test-Case "Uptime comes from the master member's block, not fpc0's" {
        $Scope = $VcUptime; if ($VcUptime -match $MasterPattern) { $Scope = $Matches.masterfpc }
        ($Scope -match $UptimePattern) -and $Matches.boot.Trim() -eq '2026-08-20 18:44:31 UTC'
    }
    Test-Case "the separately-rebooted non-master member's boot time is not what gets reported" {
        $Scope = $VcUptime; if ($VcUptime -match $MasterPattern) { $Scope = $Matches.masterfpc }
        ($Scope -match $UptimePattern) -and $Matches.boot.Trim() -ne '2026-01-04 02:11:07 UTC'
    }
    Test-Case "JunosVersion comes from the master member's 'show version' block too" {
        $Scope = $VcVersion; if ($VcVersion -match $MasterPattern) { $Scope = $Matches.masterfpc }
        ($Scope -match $VersionPattern) -and $Matches.ver -eq '20.4R3-S4.8'
    }
    Test-Case "the master block stops at the next fpcN: header (no bleed into other members)" {
        ($VcUptime -match $MasterPattern) -and $Matches.masterfpc -notmatch '2026-01-04'
    }
    Test-Case "a standalone switch (no fpcN blocks) falls back to the whole section unchanged" {
        $Standalone = "Hostname: SW-STANDALONE`nModel: ex2300-c-12p`nJunos: 18.2R3-S8`n"
        $Scope = $Standalone; if ($Standalone -match $MasterPattern) { $Scope = $Matches.masterfpc }
        ($Scope -eq $Standalone) -and ($Scope -match $VersionPattern) -and $Matches.ver -eq '18.2R3-S8'
    }
}

# --- chassis-hardware fallback model ---
# The fallback runs only when the virtual-chassis parse failed, i.e. exactly when the device IS a
# VC - and "Chassis <serial> Virtual Chassis" with a \S+ model capture reported Model = "Virtual".
$ChassisMatch = [regex]::Match($JunosNodeDataSrc, '\$DataDict\["CHASSIS_HARDWARE"\]\s+-match\s+"((?:[^"\\]|\\.)*)"')
if (-not $ChassisMatch.Success) {
    Write-Host "[FAIL] Could not locate the chassis-hardware fallback regex in Get-JunosNodeData.ps1" -ForegroundColor Red
    $script:Total++
} else {
    $ChassisPattern = $ChassisMatch.Groups[1].Value
    $VcChassis = @"
Hardware inventory:
Item             Version  Part number  Serial number     Description
Chassis                                NW0217450140      Virtual Chassis
Routing Engine 0          BUILTIN      BUILTIN           EX4300-48T
"@
    $StandaloneChassis = @"
Hardware inventory:
Item             Version  Part number  Serial number     Description
Chassis                                JN11D2E7CAFB      EX3400-48P
"@
    Test-Case "chassis fallback does not report 'Virtual' as the model of a virtual chassis" {
        $Ok = $VcChassis -match $ChassisPattern
        $Model = if ($Ok) { $Matches.model.Trim() } else { '' }
        $Ok -and $Model -notmatch '(?i)^virtual$'
    }
    Test-Case "chassis fallback recognises the whole 'Virtual Chassis' description, not its first token" {
        ($VcChassis -match $ChassisPattern) -and $Matches.model.Trim() -match '(?i)^virtual\s+chassis$'
    }
    Test-Case "chassis fallback still captures the serial on a virtual chassis" {
        ($VcChassis -match $ChassisPattern) -and $Matches.serial -eq 'NW0217450140'
    }
    Test-Case "chassis fallback still reads a real standalone model unchanged" {
        ($StandaloneChassis -match $ChassisPattern) -and $Matches.model.Trim() -eq 'EX3400-48P' -and $Matches.serial -eq 'JN11D2E7CAFB'
    }
    Test-Case "the chassis-hardware header row is not mistaken for the Chassis row" {
        $Header = "Item             Version  Part number  Serial number     Description"
        -not ($Header -match $ChassisPattern)
    }
}

# --- ssh.exe process ownership (unredacted-temp-file leak) ---
# The batch used to run `cmd.exe /c ssh.exe ... > %TEMP%\ssh_out_*.txt`. On timeout it killed the
# cmd.exe wrapper; Windows does not kill children with their parent and .NET Framework 4.x (the
# 5.1 runtime) has no Kill(entireProcessTree) overload, so ssh.exe survived holding a write
# handle on ssh_out_ - the raw, unredacted `show configuration | display set` output. These are
# source-shape assertions: the real behaviour needs a Windows host with a live switch.
Test-Case "the SSH batch no longer routes through a cmd.exe wrapper it cannot kill through" {
    # The word may still appear in the comment explaining why; only an actual invocation counts.
    $JunosNodeDataSrc -notmatch 'ProcessStartInfo\(\s*"cmd\.exe"'
}
Test-Case "no unredacted ssh_out_/ssh_err_ temp file is written to %TEMP% any more" {
    $JunosNodeDataSrc -notmatch 'ssh_out_\$|ssh_err_\$'
}
Test-Case "stdout and stderr are owned by the worker (redirected), so Kill() targets ssh.exe itself" {
    ($JunosNodeDataSrc -match '\$ProcInfo\.RedirectStandardOutput\s*=\s*\$true') -and
    ($JunosNodeDataSrc -match '\$ProcInfo\.RedirectStandardError\s*=\s*\$true')
}
Test-Case "both redirected streams are read asynchronously, before any command is written (deadlock guard)" {
    $StartIdx = $JunosNodeDataSrc.IndexOf('Process]::Start($ProcInfo)')
    $WriteIdx = $JunosNodeDataSrc.IndexOf('WriteLine("set cli screen-length 0")')
    $Between = $JunosNodeDataSrc.Substring($StartIdx, $WriteIdx - $StartIdx)
    ($Between -match 'StandardOutput\.ReadToEndAsync\(\)') -and ($Between -match 'StandardError\.ReadToEndAsync\(\)')
}
Test-Case "no Kill(entireProcessTree) overload is used (it does not exist on .NET Framework 4.x / PS 5.1)" {
    $JunosNodeDataSrc -notmatch 'Kill\(\s*\$(true|false)\s*\)'
}
Test-Case "the redirected streams are decoded as UTF-8, not the console codepage" {
    ($JunosNodeDataSrc -match 'StandardOutputEncoding\s*=\s*\[System\.Text\.Encoding\]::UTF8') -and
    ($JunosNodeDataSrc -match 'StandardErrorEncoding\s*=\s*\[System\.Text\.Encoding\]::UTF8')
}

# --- log mutex name ---
Test-Case "the log mutex name is computed once per run, not per log line (leaked an MD5 provider)" {
    $WriteLogIdx = $JunosNodeDataSrc.IndexOf('function Write-LogMsg')
    $Body = $JunosNodeDataSrc.Substring($WriteLogIdx)
    $Body -notmatch 'Cryptography\.MD5\]::Create'
}
Test-Case "the hoisted MD5 provider is disposed" {
    $JunosNodeDataSrc -match '(?s)Cryptography\.MD5\]::Create\(\).*?\$Md5\.Dispose\(\)'
}

# =========================================================================================
# 8. WebServer.ps1 endpoint payload shapes (accept-loop blocking guards)
# =========================================================================================
# The single-threaded accept loop serves one request at a time, so any handler that
# serializes a large payload blocks the whole server. Two endpoints did exactly that and the
# symptom - a browser-side "failed to fetch" with nothing in the server log - gave no hint
# where it came from. These assert the payload SHAPES that keep them cheap; a regression here
# is invisible on a fast machine and only bites on Windows PowerShell 5.1 with a real archive.
Write-Host "`n--- 8. WebServer endpoint payload shapes ---" -ForegroundColor Cyan

. (Join-Path $LibDir 'WebServer.ps1')

# Send-WebResponse only needs settable properties plus a writable stream, so a PSCustomObject
# with a MemoryStream stands in for HttpListenerResponse. ToArray() is still valid after the
# handler closes the stream.
function New-MockResponse {
    [PSCustomObject]@{
        StatusCode = 0; ContentType = ''; ContentLength64 = 0
        OutputStream = [System.IO.MemoryStream]::new()
    }
}
function Get-MockResponseText {
    param($Response)
    [System.Text.Encoding]::UTF8.GetString($Response.OutputStream.ToArray())
}

$SnapTestDir = Join-Path ([System.IO.Path]::GetTempPath()) ("pnm_snaptest_" + [guid]::NewGuid().Guid.Substring(0, 8))
New-Item -ItemType Directory -Path $SnapTestDir -Force | Out-Null
try {
    $BigBody = '{"Topology":[{"DeviceIP":"10.55.1.1","Filler":"' + ('x' * 5000) + '"}],"ScanTimestamp":"2026-01-01T00:00:00Z"}'
    Set-Content -LiteralPath (Join-Path $SnapTestDir 'NetworkMap_2026-01-01_000000.json') -Value $BigBody -Encoding UTF8 -NoNewline
    Set-Content -LiteralPath (Join-Path $SnapTestDir 'NetworkMap_2026-01-02_000000.json') -Value $BigBody -Encoding UTF8 -NoNewline

    $ListResponse = New-MockResponse
    Invoke-GetSnapshotsAction -Response $ListResponse -SnapshotDir $SnapTestDir
    $ListText = Get-MockResponseText -Response $ListResponse
    $Listing = $ListText | ConvertFrom-Json

    Test-Case "/api/snapshots returns a listing, never the file bodies (whole-archive serialization is what stalls the loop)" {
        $ListText -notmatch 'Filler'
    }
    Test-Case "/api/snapshots listing stays small regardless of archive size" {
        $ListText.Length -lt 1000
    }
    Test-Case "/api/snapshots reports each snapshot's name and size" {
        $First = $Listing.snapshots[0]
        $null -ne $First.name -and $First.size -gt 5000
    }

    # Per-file endpoint: bytes verbatim, no JSON envelope, and confined to the snapshot dir.
    $FileResponse = New-MockResponse
    Invoke-GetSnapshotAction -Response $FileResponse -SnapshotDir $SnapTestDir -Name 'NetworkMap_2026-01-01_000000.json'
    Test-Case "/api/snapshot serves the file's bytes verbatim (no re-serialization)" {
        (Get-MockResponseText -Response $FileResponse) -eq $BigBody
    }

    # The name regex alone admits path separators, so containment is what actually stops
    # traversal - assert the containment check, not just the regex.
    $TraversalResponse = New-MockResponse
    Invoke-GetSnapshotAction -Response $TraversalResponse -SnapshotDir $SnapTestDir -Name 'NetworkMap_../../../etc/NetworkMap_passwd.json'
    Test-Case "/api/snapshot refuses a traversal name that satisfies the filename regex" {
        $TraversalResponse.StatusCode -eq 404
    }
    $BadNameResponse = New-MockResponse
    Invoke-GetSnapshotAction -Response $BadNameResponse -SnapshotDir $SnapTestDir -Name 'Configuration.json'
    Test-Case "/api/snapshot refuses a name outside the NetworkMap_*.json shape" {
        $BadNameResponse.StatusCode -eq 400
    }
} finally {
    Remove-Item -LiteralPath $SnapTestDir -Recurse -Force -ErrorAction SilentlyContinue
}

# Invoke-ScanNetworkStatusAction needs a live runspace job to exercise directly, so assert the
# payload shape at the source: the completed job is retained to be re-served idempotently, so
# carrying the topology in it means re-serializing the whole fleet on every poll - including
# the one the client makes on every page load.
$WebServerSrc = Get-Content -LiteralPath (Join-Path $LibDir 'WebServer.ps1') -Raw
Test-Case "/api/scan-network/status does not carry the topology in its completed-job outcome" {
    $WebServerSrc -notmatch 'topology\s*=\s*\$Payload\.Topology'
}
Test-Case "/api/scan-network/status still reports the output file the client fetches instead" {
    $WebServerSrc -match 'outputFile\s*=\s*\(Split-Path\s+\$Payload\.OutputFile'
}

# --- fix 1: a rejected /api/scan-network must change no server state -------------------
# Collected=$true so the seeded job needs no real EndInvoke/Dispose.
$PriorScan = [PSCustomObject]@{
    Handle = [PSCustomObject]@{ IsCompleted = $true }; Collected = $true
    StartIP = '10.0.0.1'; Outcome = @{ status = 'complete'; ok = $true }
}
$ScanTmpDir = [System.IO.Path]::GetTempPath()

$script:PendingScanNetwork = $PriorScan
$BadIpResponse = New-MockResponse
Invoke-ScanNetworkAction -Response $BadIpResponse -Body '{"startIp":"not-an-ip"}' -WorkerPath 'x' `
    -JunosUsername 'u' -JunosPassword 'p' -MaxConcurrent '4' -AllowedScopes @('10.0.0.0/8') -SnapshotDir $ScanTmpDir
Test-Case "/api/scan-network rejects a malformed start IP" {
    $BadIpResponse.StatusCode -eq 400
}
# The reap that clears this slot must sit BELOW validation: a typo'd IP used to discard the
# previous scan's result, after which every status poll 404'd.
Test-Case "a malformed start IP does not discard the previous scan's pollable result" {
    $null -ne $script:PendingScanNetwork
}

$script:PendingScanNetwork = $PriorScan
$OutOfScopeResponse = New-MockResponse
Invoke-ScanNetworkAction -Response $OutOfScopeResponse -Body '{"startIp":"192.168.1.1"}' -WorkerPath 'x' `
    -JunosUsername 'u' -JunosPassword 'p' -MaxConcurrent '4' -AllowedScopes @('10.0.0.0/8') -SnapshotDir $ScanTmpDir
Test-Case "/api/scan-network refuses a start IP outside AllowedScopes" {
    $OutOfScopeResponse.StatusCode -eq 400
}
Test-Case "an out-of-scope start IP does not discard the previous scan's pollable result" {
    $null -ne $script:PendingScanNetwork
}
# The symptom the operator actually saw.
$PollResponse = New-MockResponse
Invoke-ScanNetworkStatusAction -Response $PollResponse
Test-Case "the previous scan's result is still pollable after a rejected new-scan request" {
    $PollResponse.StatusCode -eq 200
}
$script:PendingScanNetwork = $null

# --- fix 2: engine resolution, not host resolution -------------------------------------
$EnginePath = Get-PowerShellEnginePath
Test-Case "Get-PowerShellEnginePath resolves an executable that exists on disk" {
    [System.IO.File]::Exists($EnginePath)
}
# The ISE hosts the engine in-process, so MainModule.FileName yields powershell_ise.exe -
# which cannot run -File/-NoExit, yet Start-Process succeeds and leaks the credential file.
Test-Case "Get-PowerShellEnginePath never returns the ISE host" {
    [System.IO.Path]::GetFileName($EnginePath) -ne 'powershell_ise.exe'
}
Test-Case "Get-PowerShellEnginePath returns the engine matching this edition" {
    $EngineLeaf = [System.IO.Path]::GetFileName($EnginePath)
    if ($PSVersionTable.PSVersion.Major -ge 6) { $EngineLeaf -like 'pwsh*' } else { $EngineLeaf -eq 'powershell.exe' }
}

# --- fix 4: static filenames are literal paths, not wildcards --------------------------
$StaticRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("pnm_static_" + [guid]::NewGuid().Guid.Substring(0, 8))
New-Item -ItemType Directory -Path $StaticRoot -Force | Out-Null
try {
    # [IO.File]::WriteAllText, not Set-Content: Set-Content -Path would itself glob the "[1]".
    [System.IO.File]::WriteAllText((Join-Path $StaticRoot 'chart[1].js'), 'BRACKET-CONTENT')
    [System.IO.File]::WriteAllText((Join-Path $StaticRoot 'a1.js'), 'A1')

    $BracketResponse = New-MockResponse
    Invoke-StaticFile -Response $BracketResponse -AbsolutePath '/chart[1].js' -VisualizerRoot $StaticRoot
    Test-Case "a static file whose name contains [ ] is served, not wildcard-matched into a 404" {
        $BracketResponse.StatusCode -eq 200 -and (Get-MockResponseText -Response $BracketResponse) -eq 'BRACKET-CONTENT'
    }
} finally { Remove-Item -LiteralPath $StaticRoot -Recurse -Force -ErrorAction SilentlyContinue }

# --- fix 6: one batched write, per-line timestamps preserved ---------------------------
$SavedDebugLogPath = $script:DebugLogPath
$BatchLogPath = Join-Path ([System.IO.Path]::GetTempPath()) ("pnm_clienterr_" + [guid]::NewGuid().Guid.Substring(0, 8) + ".log")
$script:DebugLogPath = $BatchLogPath
$script:ClientErrorRateLimitCount = 0
$script:ClientErrorRateLimitWindowStart = Get-Date
try {
    $StackFrames = (1..5 | ForEach-Object { "    at fn$_ (http://localhost:8787/app.js:$($_):1)" }) -join "`n"
    $ClientErrBody = @{ message = 'boom'; source = 'window.onerror'; url = 'http://localhost:8787/'; stack = $StackFrames } | ConvertTo-Json -Compress
    Invoke-ClientErrorAction -Response (New-MockResponse) -Body $ClientErrBody
    $ErrLines = @(Get-Content -LiteralPath $BatchLogPath)

    Test-Case "a client error report logs its header plus one line per stack frame" {
        $ErrLines.Count -eq 6
    }
    # Batching must not cost the per-line "[timestamp] " prefix - that prefix is what stops a
    # stack frame from forging what looks like a separate log entry.
    Test-Case "every batched client-error log line keeps its own real timestamp prefix" {
        @($ErrLines | Where-Object { $_ -notmatch '^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\] ' }).Count -eq 0
    }

    $script:ClientErrorRateLimitCount = 0
    Invoke-ClientErrorAction -Response (New-MockResponse) `
        -Body (@{ message = "ok`n[2020-01-01 00:00:00] FORGED"; source = 'x' } | ConvertTo-Json -Compress)
    Test-Case "a CR/LF in a client error message still cannot forge a timestamped entry" {
        @(Get-Content -LiteralPath $BatchLogPath | Where-Object { $_ -match '^\[2020-01-01' }).Count -eq 0
    }
} finally {
    Remove-Item -LiteralPath $BatchLogPath -Force -ErrorAction SilentlyContinue
    $script:DebugLogPath = $SavedDebugLogPath
}

# --- fix 7: a mid-write disconnect logs once instead of throwing three times ------------
# Uses the REAL Send-WebResponse; the pre-disposed stream is what fails, exactly as a
# vanished client does. Headers are set before the write, so the handler's catch runs with
# $script:WebResponseStarted already true.
$DeadSnapDir = Join-Path ([System.IO.Path]::GetTempPath()) ("pnm_dead_" + [guid]::NewGuid().Guid.Substring(0, 8))
New-Item -ItemType Directory -Path $DeadSnapDir -Force | Out-Null
try {
    [System.IO.File]::WriteAllText((Join-Path $DeadSnapDir 'NetworkMap_2026-01-01_000000.json'), '{"Topology":[]}')
    $script:WebResponseStarted = $false   # no dispatcher here to reset it
    $DeadResponse = New-MockResponse
    $DeadResponse.OutputStream.Dispose()
    $EscapedError = $null
    try {
        Invoke-GetSnapshotAction -Response $DeadResponse -SnapshotDir $DeadSnapDir -Name 'NetworkMap_2026-01-01_000000.json'
    } catch { $EscapedError = $_ }

    # StatusCode still 200 proves the 500 send was never attempted; no escaped error proves
    # the dispatcher is not handed a third send.
    Test-Case "a mid-write client disconnect is logged, not answered with a second throwing send" {
        $null -eq $EscapedError -and $DeadResponse.StatusCode -eq 200
    }
} finally {
    Remove-Item -LiteralPath $DeadSnapDir -Recurse -Force -ErrorAction SilentlyContinue
    $script:WebResponseStarted = $false
}

# --- fix 5: shutdown cleanup must skip already-Collected jobs -------------------------
# The status actions dispose PS and reap the grandchildren on first collection, but leave the
# slot populated. Re-running that at shutdown double-Disposes, and re-reaps an "@<IP>" that
# may by then belong to an unrelated interactive session.
$ShutdownSrc = $WebServerSrc.Substring($WebServerSrc.IndexOf('SERVER SHUTDOWN (IsListening='))
Test-Case "shutdown cleanup skips an already-Collected rescan job" {
    $ShutdownSrc -match '\$script:PendingScan\s+-and\s+-not\s+\$script:PendingScan\.Collected'
}
Test-Case "shutdown cleanup skips an already-Collected ping job" {
    $ShutdownSrc -match '\$script:PendingPing\s+-and\s+-not\s+\$script:PendingPing\.Collected'
}

# =========================================================================================
# 9. Placeholder-node parity + crawl-abort behavior (FleetCrawl.ps1)
# =========================================================================================
Write-Host "`n--- 9. Placeholder nodes and crawl abort (FleetCrawl.ps1) ---" -ForegroundColor Cyan

# Item 4 was a placeholder that had silently drifted from the real initializer, so compare the
# two key sets from source rather than trusting a comment that says they match.
$NodeDataSrc = Get-Content -LiteralPath (Join-Path $LibDir 'Get-JunosNodeData.ps1') -Raw
$FleetCrawlSrc = Get-Content -LiteralPath (Join-Path $LibDir 'FleetCrawl.ps1') -Raw

$RealInitMatch = [regex]::Match($NodeDataSrc, '(?s)\$NodeData\s*=\s*@\{(.*?)\n\}')
$PlaceholderMatch = [regex]::Match($FleetCrawlSrc, '(?s)function New-PlaceholderNodeLocal\s*\{(.*?)\n    \}')

if (-not $RealInitMatch.Success -or -not $PlaceholderMatch.Success) {
    Write-Host "[FAIL] Could not locate the \$NodeData initializer and/or New-PlaceholderNodeLocal - have they moved or been rewritten? (skipping parity test cases)" -ForegroundColor Red
    $script:Total++
} else {
    $KeyRegex = [regex]'(?m)(?:^|;)\s*([A-Za-z][A-Za-z0-9]*)\s*='
    $RealKeys = @($KeyRegex.Matches($RealInitMatch.Groups[1].Value) | ForEach-Object { $_.Groups[1].Value }) | Sort-Object -Unique
    $PlaceholderKeys = @($KeyRegex.Matches($PlaceholderMatch.Groups[1].Value) | ForEach-Object { $_.Groups[1].Value }) |
        Where-Object { $_ -notin @('IP', 'Status', 'ScanErrorText') } | Sort-Object -Unique

    Test-Case "placeholder node carries every key Get-JunosNodeData's real node initializer does" {
        ($RealKeys -join ',') -eq ($PlaceholderKeys -join ',')
    }
    Test-Case "placeholder node initializes Interfaces as a hashtable, not an array (no 'Interfaces = @()' in FleetCrawl.ps1)" {
        $FleetCrawlSrc -notmatch 'Interfaces\s*=\s*@\(\)'
    }
}

# End-to-end: the circuit breaker used to BeginStop in-flight jobs and drop them, leaving
# devices in $Visited with no node anywhere in the output. Takes ~8s (the fake worker
# deliberately wedges two jobs so the abort path has something in flight to synthesize for).
$CrawlDir = Join-Path ([System.IO.Path]::GetTempPath()) "pnm_crawl_$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $CrawlDir -Force | Out-Null
try {
    $FakeWorker = Join-Path $CrawlDir 'FakeWorker.ps1'
    Set-Content -LiteralPath $FakeWorker -Encoding utf8 -Value @'
param([string]$TargetIP, [string]$Username, [string]$Password, [switch]$Log, [string]$DebugLogPath)
$Base = @{
    DeviceIP = $TargetIP; Hostname = "sw-$TargetIP"; JunosVersion = "x"; Gateway = "x";
    StackMembers = @(); Neighbors = @(); Clients = @(); ArpEntries = @(); Interfaces = @{};
    Uptime = "x"; LastConfigured = "x"; LastConfiguredBy = "x"; Alarms = @();
    MasterCpuUtilization = "x"; MasterMemoryUtilization = "x"; MedNeighbors = @();
    Configuration = "x"; ScanStatus = "Ok"; ScanError = $null
}
switch -Regex ($TargetIP) {
    '10\.0\.0\.1$'     { $Base.Neighbors = @(2,3,4,5,6 | ForEach-Object { @{ ManagementIP = "10.0.0.$_" } }) }
    '10\.0\.0\.[234]$' { $Base.ScanStatus = "AuthFailed"; $Base.ScanError = "bad creds" }
    '10\.0\.0\.[56]$'  { [System.Threading.Thread]::Sleep(15000) }
}
return @{ Node = $Base; Logs = @() }
'@

    $CrawlProgress = @{}
    $CrawlClock = [System.Diagnostics.Stopwatch]::StartNew()
    # 3> suppresses the Protect-JunosSensitiveFileAcl warnings on non-Windows runtimes.
    $CrawlResult = Invoke-FleetCrawl -StartIP '10.0.0.1' -AllowedScopes @('10.0.0.') -MaxConcurrent 6 `
        -WorkerPath $FakeWorker -Username 'u' -Password 'p' `
        -SnapshotDir $CrawlDir -ProgressTable $CrawlProgress 3>$null
    $CrawlClock.Stop()

    Test-Case "circuit breaker aborts the crawl on repeated auth failures" { $CrawlResult.Aborted -eq $true }
    Test-Case "no device visited during an aborted crawl is silently dropped from the topology" {
        $CrawlResult.Topology.Count -eq $CrawlResult.VisitedCount
    }
    Test-Case "jobs killed in flight by the circuit breaker get a ScanStatus='Aborted' node" {
        @($CrawlResult.Topology | Where-Object { $_.ScanStatus -eq 'Aborted' }).Count -eq 2
    }
    Test-Case "an Aborted placeholder's Interfaces is a hashtable (serializes as {}, not [])" {
        $AbortedNode = @($CrawlResult.Topology | Where-Object { $_.ScanStatus -eq 'Aborted' })[0]
        $AbortedNode.Interfaces -is [hashtable]
    }
    Test-Case "the aborted devices reach the on-disk snapshot, not just the in-memory result" {
        $SnapFile = Get-ChildItem -LiteralPath $CrawlDir -Filter 'NetworkMap_*.json' | Select-Object -First 1
        $OnDisk = (Get-Content -LiteralPath $SnapFile.FullName -Raw | ConvertFrom-Json).Topology
        $OnDisk.Count -eq $CrawlResult.VisitedCount
    }
    # The abort path used to block on Dispose()/RunspacePool.Close() for as long as the wedged
    # worker ran (measured 16s against a 15s sleep; up to ~50s against a real
    # Process.WaitForExit). Both waits are now bounded, so this must finish well under the sleep. The
    # bound is 14s rather than a tighter number so a slow runspace-pool start on 5.1 cannot
    # flake it - the old blocking behaviour measured 16.0s, so it still discriminates.
    Test-Case "aborting does not block the orchestrator until the wedged worker finishes" {
        $CrawlClock.Elapsed.TotalSeconds -lt 14
    }
} finally {
    Remove-Item -LiteralPath $CrawlDir -Recurse -Force -ErrorAction SilentlyContinue
}

# =========================================================================================
# 10. Resolve-PathForDotNetIo (FileHelpers.ps1)
# =========================================================================================
Write-Host "`n--- 10. Resolve-PathForDotNetIo (FileHelpers.ps1) ---" -ForegroundColor Cyan

# [Environment]::CurrentDirectory is NOT kept in step with $PWD, so a raw [System.IO.File]
# call given a relative path writes to a different directory than the caller expects.
$SavedNetCwd = [Environment]::CurrentDirectory
$SavedLocation = Get-Location
$IoDir = Join-Path ([System.IO.Path]::GetTempPath()) "pnm_io_$([guid]::NewGuid().ToString('N'))"
$IoDecoy = Join-Path ([System.IO.Path]::GetTempPath()) "pnm_decoy_$([guid]::NewGuid().ToString('N'))"
try {
    New-Item -ItemType Directory -Path $IoDir -Force | Out-Null
    New-Item -ItemType Directory -Path $IoDecoy -Force | Out-Null
    Set-Location -LiteralPath $IoDir
    [Environment]::CurrentDirectory = $IoDecoy

    Test-Case "Resolve-PathForDotNetIo resolves a bare filename against `$PWD, not [Environment]::CurrentDirectory" {
        (Resolve-PathForDotNetIo -Path 'snapshot.json') -eq (Join-Path (Convert-Path -LiteralPath $IoDir) 'snapshot.json')
    }
    Test-Case "Resolve-PathForDotNetIo resolves a path whose file does not exist yet (parent resolved, leaf rejoined)" {
        $Resolved = Resolve-PathForDotNetIo -Path 'not-created-yet.json'
        (-not (Test-Path -LiteralPath $Resolved)) -and [System.IO.Path]::IsPathRooted($Resolved)
    }
    Test-Case "Resolve-PathForDotNetIo leaves an already-absolute path pointing at the same file" {
        $Absolute = Join-Path (Convert-Path -LiteralPath $IoDir) 'abs.json'
        (Resolve-PathForDotNetIo -Path $Absolute) -eq $Absolute
    }
} finally {
    # Restore in a finally, or every later test case inherits the $PWD/CurrentDirectory mismatch.
    Set-Location $SavedLocation
    [Environment]::CurrentDirectory = $SavedNetCwd
    Remove-Item -LiteralPath $IoDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $IoDecoy -Recurse -Force -ErrorAction SilentlyContinue
}

# =========================================================================================
# 11. Runtime floor + Protect-MapperFile -WhatIf
# =========================================================================================
Write-Host "`n--- 11. Crypto runtime floor and -WhatIf preview ---" -ForegroundColor Cyan

# Rfc2898DeriveBytes(String, Byte[], Int32, HashAlgorithmName) needs .NET Framework 4.7.2+;
# Windows Server 2016 ships 4.6.2 by default. On such a box this fails here with a clear
# message instead of deep inside key derivation, behind a password prompt.
Test-Case "Assert-TopologyCryptoRuntime accepts the runtime running these tests" {
    Assert-TopologyCryptoRuntime
    $true
}

$WhatIfDir = Join-Path ([System.IO.Path]::GetTempPath()) "pnm_whatif_$([guid]::NewGuid().ToString('N'))"
try {
    New-Item -ItemType Directory -Path $WhatIfDir -Force | Out-Null
    $WhatIfInput = Join-Path $WhatIfDir 'sample.json'
    Set-Content -LiteralPath $WhatIfInput -Value '{"a":1}' -Encoding utf8 -NoNewline
    $ProtectScript = Join-Path $LibDir 'Protect-MapperFile.ps1'
    $WhatIfPassword = ConvertTo-SecureString 'test-password' -AsPlainText -Force

    # Set-FileContentAtomic isn't ShouldProcess-aware: -WhatIf reaching it makes Set-Content
    # write nothing, then Move-FileAtomic throws Convert-Paths'ing a temp file that never
    # existed. The whole write has to sit behind one ShouldProcess in the script itself.
    Test-Case "Protect-MapperFile -WhatIf previews instead of throwing" {
        & $ProtectScript -InputFile $WhatIfInput -Password $WhatIfPassword -WhatIf | Out-Null
        $true
    }
    Test-Case "Protect-MapperFile -WhatIf writes no output file" {
        -not (Test-Path -LiteralPath "$WhatIfInput.enc")
    }
    Test-Case "Protect-MapperFile without -WhatIf still writes the envelope (round-trip intact)" {
        & $ProtectScript -InputFile $WhatIfInput -Password $WhatIfPassword -Force | Out-Null
        $Envelope = Get-Content -LiteralPath "$WhatIfInput.enc" -Raw -Encoding UTF8 | ConvertFrom-Json
        (Unprotect-TopologyPayload -Envelope $Envelope -Password 'test-password') -eq '{"a":1}'
    }
} finally {
    Remove-Item -LiteralPath $WhatIfDir -Recurse -Force -ErrorAction SilentlyContinue
}

# --- summary ---------------------------------------------------------------------------
Write-Host "`n============================================" -ForegroundColor Cyan
if ($script:Passed -eq $script:Total) {
    Write-Host "$($script:Passed)/$($script:Total) passed" -ForegroundColor Green
} else {
    Write-Host "$($script:Passed)/$($script:Total) passed" -ForegroundColor Red
}
Write-Host "============================================`n" -ForegroundColor Cyan

if ($script:Passed -ne $script:Total) { exit 1 } else { exit 0 }

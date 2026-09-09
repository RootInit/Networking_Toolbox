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
    "(?s)if\s*\(\`$DataDict\[`"UPTIME`"\]\s*-match\s*`"([^`"]*)`"\)"
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

# --- summary ---------------------------------------------------------------------------
Write-Host "`n============================================" -ForegroundColor Cyan
if ($script:Passed -eq $script:Total) {
    Write-Host "$($script:Passed)/$($script:Total) passed" -ForegroundColor Green
} else {
    Write-Host "$($script:Passed)/$($script:Total) passed" -ForegroundColor Red
}
Write-Host "============================================`n" -ForegroundColor Cyan

if ($script:Passed -ne $script:Total) { exit 1 } else { exit 0 }

<#
.SYNOPSIS
    Minimal, dependency-free smoke-test harness for PS_NetworkMapper's PowerShell-side
    security/safety-critical logic.

.DESCRIPTION
    Plain PowerShell, no Pester - it isn't guaranteed to be present on every deployment target.
    Dot-sources the real lib/*.ps1 files and exercises their shipped behavior. Run from the
    project root; exits 0 if every case passed.
#>

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$LibDir = Join-Path $ProjectRoot 'lib'

$script:Total = 0
$script:Passed = 0

function Test-Case {
    param(
        [Parameter(Mandatory = $true)][string]$Description,
        [Parameter(Mandatory = $true)][scriptblock]$Actual,
        [switch]$ExpectThrow,
        # Regex the thrown message must match: -ExpectThrow alone passes on any exception.
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
        # A stray Write-Output makes $Result a truthy array, so demand a single boolean.
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
            # A missing/renamed function throws too, which would satisfy every -ExpectThrow case.
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

# Get-JunosNodeData.ps1 opens a real ssh.exe session, so there's no dot-sourceable function. Extract
# the shipped -replace literals from the source rather than hand-copying a regex that could drift.
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

    # Case A: secret in the config section must be redacted.
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

    # Case B: no config section -> no over-redaction.
    $DumpNoConfig = @"
admin@switch1> show system uptime
System booted: 2024-01-01 00:00:00 UTC

admin@switch1> show lldp neighbors
Local Interface: ge-0/0/0, Parent Interface: -, Chassis Id: 00:11:22:33:44:55
"@
    $RedactedB = $DumpNoConfig -replace $RedactPattern, $RedactReplacement
    Test-Case "dump with no config section passes through byte-for-byte unchanged" { $RedactedB -eq $DumpNoConfig }

    # Case C: a prompt-shaped decoy AFTER the real config section; a greedy prefix backtracks to it.
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

Write-Host "`n--- 2. Get-JunosSshArgs injection guard (SshHelpers.ps1) ---" -ForegroundColor Cyan
. (Join-Path $LibDir 'SshHelpers.ps1')

Test-Case "valid username + valid IP is accepted" {
    (Get-JunosSshArgs -Username "admin" -TargetIP "10.1.2.3") -join ' ' -match '10\.1\.2\.3'
}

# If the keepalive budget is shorter than the worker's WaitForExit, ssh tears down healthy sessions.
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

# Same coupling one layer up: the abandon deadline must outlast a worker on its full batch timeout.
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
# Third layer: the UI's Rescan runs the worker directly and needs its own longer deadline.
Test-Case "the web rescan deadline stays longer than the worker's per-batch timeout" {
    $WorkerSrc = Get-Content -LiteralPath (Join-Path $LibDir 'Get-JunosNodeData.ps1') -Raw
    if ($WorkerSrc -notmatch 'WaitForExit\((?<ms>\d+)\)') { throw "Could not find WaitForExit(<ms>) in Get-JunosNodeData.ps1" }
    $BatchTimeoutSec = [int]$Matches.ms / 1000

    $WebSrc = Get-Content -LiteralPath (Join-Path $LibDir 'WebServer.ps1') -Raw
    if ($WebSrc -notmatch '\$script:OrphanedScans') { throw "Could not find the rescan orphan path in WebServer.ps1" }
    # The deadline immediately above the OrphanedScans hand-off.
    $RescanMatch = [regex]::Match($WebSrc, '(?s)\$Elapsed\s*-gt\s*(?<sec>\d+)\)\s*\{(?:(?!\$Elapsed).)*?\$script:OrphanedScans')
    if (-not $RescanMatch.Success) { throw "Could not find the rescan deadline guarding `$script:OrphanedScans in WebServer.ps1" }
    $RescanSec = [int]$RescanMatch.Groups['sec'].Value

    if ($RescanSec -le $BatchTimeoutSec) {
        throw "web rescan deadline ${RescanSec}s must exceed the ${BatchTimeoutSec}s batch timeout, or a single-device rescan reports 'timeout' for switches the worker was still scanning"
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
    # Contains "131.30." as a substring but does not start with it - a substring match would allow it.
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

Write-Host "`n--- 5. coverage-5 (history-merge / reboot detection) ---" -ForegroundColor Cyan
Write-Host "SKIPPED: this logic lives entirely in web-src/persistence.js (JS), already covered" -ForegroundColor Yellow
Write-Host "by web-src/test/*.test.mjs via 'node --test'. No PowerShell-side reboot-detection" -ForegroundColor Yellow
Write-Host "(comparison) logic exists to test here - not forcing an inapplicable PS test." -ForegroundColor Yellow

# The Uptime "System booted:" regex that feeds JS-side reboot detection, extracted as in item 1.
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

# The most security-critical PowerShell in the repo. It must stay byte-compatible with
# web-src/topology-crypto.js - hence the fixed vector below, which that suite decrypts from its own
# copy. If either side drifts, exactly one of the two suites goes red.
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

# The HMAC is checked BEFORE decrypting, so all three must fail with the same clean error.
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

# PowerShell's -ne coerces the right operand, so "1" compares equal to 1 - JS's !== rejects it.
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

# Fixed cross-runtime vector, decrypted here AND by web-src/test/topology-crypto.test.mjs.
$InteropEnvelope = '{"format":"PSNetworkMapper-EncryptedTopology","version":1,"kdf":"PBKDF2-SHA256","iterations":1000,"cipher":"AES-256-CBC","macAlgorithm":"HMAC-SHA256","salt":"AQIDBAUGBwgJCgsMDQ4PEA==","iv":"b+iBnE7OTNxUHdbMJLgqNA==","mac":"ZPIp4GkNDGJeBU0QZ1VLLci2HQGC482oBvInAG1G5tw=","ciphertext":"k1v8NbYk+p0Qm04nui5MVixuNLLTPAxZyxnlc0vwyvgCnckpR+qhdOu9xhXCE2L2sDIZVf75RyOZ3oE2RdLWeJtbJjgk7Ub+lA/5hzA+HJPzSFNulBOHlKPCTVbyGEknwmUyA+7tu8l4JHNBkwk6cw=="}' | ConvertFrom-Json
Test-Case "decrypts the fixed interop vector shared with the JS implementation" {
    (Unprotect-TopologyPayload -Envelope $InteropEnvelope -Password "Correct Horse Battery Stapleäöü😀") -eq '{"Topology":[{"DeviceIP":"10.55.1.1","Hostname":"swutch-e"}],"ScanTimestamp":"2026-01-01T00:00:00Z"}'
}

# Both regexes below shipped matching nothing (PoE) or the wrong field (LLDP), and neither failed
# loudly. Patterns are extracted from the shipped source; fixtures use the real column layout.
Write-Host "`n--- 7. Junos CLI parsing regexes ---" -ForegroundColor Cyan

# --- LLDP remote port ---
# "Local Port ID : <local ifIndex>" comes first, so an unanchored "Port ID\s*:" matched there.
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
# The field count before Power/Class varies by version, so anchor them as the last two tokens.
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
# "show spanning-tree interface" repeats a port per VLAN, and the loop used to overwrite .STP on
# every repeat. Repeats are now collapsed by precedence, BLK highest.
$StpLineMatch = [regex]::Match($JunosNodeDataSrc, '\$Line\s+-match\s+"((?:[^"\\]|\\.)*\(\?<state>FWD(?:[^"\\]|\\.)*)"')
$StpPrecMatch = [regex]::Match($JunosNodeDataSrc, '\$StpStatePrecedence\s*=\s*(@\{[^}]*\})')
if (-not ($StpLineMatch.Success -and $StpPrecMatch.Success)) {
    Write-Host "[FAIL] Could not locate the spanning-tree line regex or precedence table in Get-JunosNodeData.ps1" -ForegroundColor Red
    $script:Total++
} else {
    $StpPattern = $StpLineMatch.Groups[1].Value
    $StpPrecedence = Invoke-Expression $StpPrecMatch.Groups[1].Value
    # Real layout: the same three ports per STP instance, two blocking only in instance 100.
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

# --- virtual-chassis master RE scoping ---
# Both commands emit one "fpcN:" block per member and a bare -match takes fpc0's, not the master's.
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
# The fallback runs only when the VC parse failed, and a \S+ capture reported Model = "Virtual".
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
# The batch used to run `cmd.exe /c ssh.exe ... > %TEMP%\ssh_out_*.txt` and on timeout killed only
# the wrapper, so ssh.exe survived holding the raw config output. Source-shape assertions only.
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
Test-Case "the log mutex name is computed once per run, not per log line" {
    $WriteLogIdx = $JunosNodeDataSrc.IndexOf('function Write-LogMsg')
    $Body = $JunosNodeDataSrc.Substring($WriteLogIdx)
    $Body -notmatch '16777619'
}
Test-Case "the worker touches no System.Security.Cryptography type (FIPS-enforced hosts throw on MD5 before the worker emits anything)" {
    $JunosNodeDataSrc -notmatch 'System\.Security\.Cryptography'
}
Test-Case "the mutex-name block yields a stable 8-hex-char name with no crypto provider" {
    $Block = [regex]::Match($JunosNodeDataSrc, '(?s)\$Hash = \[long\]2166136261.*?-f \$Hash\)').Value
    $DebugLogPath = 'C:\Users\Test\ScanNetwork_Debug.log'
    Invoke-Expression $Block; $A = $LogMutexName
    Invoke-Expression $Block; $B = $LogMutexName
    [bool]$Block -and ($A -eq $B) -and ($A -match '^Global\\JunosMapperLog_[0-9a-f]{8}$')
}
Test-Case "the worker masks with an int64 literal (bare 0xFFFFFFFF parses as Int32 -1, a no-op mask that overflows to double)" {
    ($JunosNodeDataSrc -match '-band\s+0xFFFFFFFFL') -and ($JunosNodeDataSrc -notmatch '-band\s+0xFFFFFFFF\b')
}

# The single-threaded accept loop serves one request at a time, so a handler that serializes a large
# payload blocks the whole server. These assert the payload SHAPES that keep two endpoints cheap; a
# regression is invisible except on 5.1 with a real archive.
Write-Host "`n--- 8. WebServer endpoint payload shapes ---" -ForegroundColor Cyan

. (Join-Path $LibDir 'WebServer.ps1')

# A PSCustomObject with a MemoryStream stands in for HttpListenerResponse.
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

    # The name regex admits path separators, so assert the containment check, not just the regex.
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

# Asserted at the source: a retained job carrying the topology re-serializes the fleet per poll.
$WebServerSrc = Get-Content -LiteralPath (Join-Path $LibDir 'WebServer.ps1') -Raw
Test-Case "/api/scan-network/status does not carry the topology in its completed-job outcome" {
    $WebServerSrc -notmatch 'topology\s*=\s*\$Payload\.Topology'
}
Test-Case "/api/scan-network/status still reports the output file the client fetches instead" {
    $WebServerSrc -match 'outputFile\s*=\s*\(Split-Path\s+\$Payload\.OutputFile'
}

# --- fix 1: a rejected /api/scan-network must change no server state (Collected=$true seeded job) ---
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
# The reap must sit BELOW validation: a typo'd IP used to discard the previous scan's result.
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
# The ISE hosts the engine in-process, so MainModule.FileName yields powershell_ise.exe.
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
    # The per-line "[timestamp] " prefix is what stops a stack frame forging a separate entry.
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

# --- fix 7: a mid-write disconnect logs once; the pre-disposed stream fails like a vanished client ---
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

    # StatusCode still 200 proves the 500 send was never attempted.
    Test-Case "a mid-write client disconnect is logged, not answered with a second throwing send" {
        $null -eq $EscapedError -and $DeadResponse.StatusCode -eq 200
    }
} finally {
    Remove-Item -LiteralPath $DeadSnapDir -Recurse -Force -ErrorAction SilentlyContinue
    $script:WebResponseStarted = $false
}

# --- fix 5: shutdown cleanup must skip already-Collected jobs ---
# Re-running it double-Disposes and re-reaps an "@<IP>" that may now be an unrelated session.
$ShutdownSrc = $WebServerSrc.Substring($WebServerSrc.IndexOf('SERVER SHUTDOWN (IsListening='))
Test-Case "shutdown cleanup skips an already-Collected rescan job" {
    $ShutdownSrc -match '\$script:PendingScan\s+-and\s+-not\s+\$script:PendingScan\.Collected'
}
Test-Case "shutdown cleanup skips an already-Collected ping job" {
    $ShutdownSrc -match '\$script:PendingPing\s+-and\s+-not\s+\$script:PendingPing\.Collected'
}

Write-Host "`n--- 9. Placeholder nodes and crawl abort (FleetCrawl.ps1) ---" -ForegroundColor Cyan

# Item 4 was a placeholder that silently drifted, so compare the two key sets from source.
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

# End-to-end: the breaker used to drop in-flight jobs, leaving devices in $Visited with no node.
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
    # The abort path used to block on Dispose()/Close() for as long as the wedged worker ran (16.0s
    # against a 15s sleep). 14s rather than tighter so a slow pool start on 5.1 cannot flake it.
    Test-Case "aborting does not block the orchestrator until the wedged worker finishes" {
        $CrawlClock.Elapsed.TotalSeconds -lt 14
    }
} finally {
    Remove-Item -LiteralPath $CrawlDir -Recurse -Force -ErrorAction SilentlyContinue
}

# --- Retry pass ---
# Covers the retry rules, including the one that must NOT retry - a bad credential locks the account.
$RetryDir = Join-Path ([System.IO.Path]::GetTempPath()) "pnm_retry_$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $RetryDir -Force | Out-Null
try {
    $RetryWorker = Join-Path $RetryDir 'RetryWorker.ps1'
    # Attempts are counted via files in the worker's own directory: runspaces share no state.
    Set-Content -LiteralPath $RetryWorker -Encoding utf8 -Value @'
param([string]$TargetIP, [string]$Username, [string]$Password, [switch]$Log, [string]$DebugLogPath)
$AttemptDir = Join-Path $PSScriptRoot 'attempts'
if (-not (Test-Path $AttemptDir)) { New-Item -ItemType Directory -Path $AttemptDir -Force | Out-Null }
$Attempt = @(Get-ChildItem -LiteralPath $AttemptDir -Filter "$TargetIP`_*" -ErrorAction SilentlyContinue).Count + 1
New-Item -ItemType File -Path (Join-Path $AttemptDir "$TargetIP`_$Attempt") -Force | Out-Null

$Base = @{
    DeviceIP = $TargetIP; Hostname = "sw-$TargetIP"; JunosVersion = "x"; Gateway = "x";
    StackMembers = @(); Neighbors = @(); Clients = @(); ArpEntries = @(); Interfaces = @{};
    Uptime = "x"; LastConfigured = "x"; LastConfiguredBy = "x"; Alarms = @();
    MasterCpuUtilization = "x"; MasterMemoryUtilization = "x"; MedNeighbors = @();
    Configuration = "x"; ScanStatus = "Ok"; ScanError = $null
}
switch -Regex ($TargetIP) {
    '10\.1\.0\.1$' { $Base.Neighbors = @(2,3,4 | ForEach-Object { @{ ManagementIP = "10.1.0.$_" } }) }
    # Transient: fails once, then succeeds - the case the retry exists for.
    '10\.1\.0\.2$' { if ($Attempt -eq 1) { $Base.ScanStatus = "Error"; $Base.ScanError = "empty payload" } }
    # Permanently down: burns both attempts and settles as a failure node.
    '10\.1\.0\.3$' { $Base.ScanStatus = "Unreachable"; $Base.ScanError = "connection timed out" }
    # Must be tried exactly once, no matter what.
    '10\.1\.0\.4$' { $Base.ScanStatus = "AuthFailed"; $Base.ScanError = "bad creds" }
}
return @{ Node = $Base; Logs = @() }
'@

    $RetryProgress = @{}
    $RetryResult = Invoke-FleetCrawl -StartIP '10.1.0.1' -AllowedScopes @('10.1.0.') -MaxConcurrent 4 `
        -WorkerPath $RetryWorker -Username 'u' -Password 'p' `
        -SnapshotDir $RetryDir -ProgressTable $RetryProgress 3>$null

    function Get-RetryAttemptCount { param([string]$IP)
        @(Get-ChildItem -LiteralPath (Join-Path $RetryDir 'attempts') -Filter "$IP`_*" -ErrorAction SilentlyContinue).Count
    }
    # Callers wrap this in @(): an unwrapped single hashtable reports .Count as its key count.
    function Get-RetryNodes { param([string]$IP)
        $RetryResult.Topology | Where-Object { $_.DeviceIP -eq $IP }
    }

    Test-Case "a device that fails transiently is dispatched a second time" {
        (Get-RetryAttemptCount '10.1.0.2') -eq 2
    }
    Test-Case "a device that succeeds on retry ends up Ok, with no leftover failure node" {
        $Nodes = @(Get-RetryNodes '10.1.0.2')
        $Nodes.Count -eq 1 -and $Nodes[0].ScanStatus -eq 'Ok'
    }
    Test-Case "an auth failure is never retried (a repeat attempt is how an account gets locked out)" {
        (Get-RetryAttemptCount '10.1.0.4') -eq 1
    }
    Test-Case "a permanently failing device stops at the attempt cap" {
        (Get-RetryAttemptCount '10.1.0.3') -eq 2
    }
    Test-Case "a device that fails every attempt still lands exactly one node in the topology" {
        $Nodes = @(Get-RetryNodes '10.1.0.3')
        $Nodes.Count -eq 1 -and $Nodes[0].ScanStatus -eq 'Unreachable'
    }
    Test-Case "retrying does not duplicate or drop devices - one node per visited IP" {
        $RetryResult.Topology.Count -eq $RetryResult.VisitedCount
    }
    Test-Case "a successful device is never re-dispatched" {
        (Get-RetryAttemptCount '10.1.0.1') -eq 1
    }
} finally {
    Remove-Item -LiteralPath $RetryDir -Recurse -Force -ErrorAction SilentlyContinue
}

# A retry-queued IP is in $Visited, has no node yet, and sits in the QUEUE rather than $Jobs, so the
# abort path's live-job sweep misses it - the exact silent-drop the placeholders exist to prevent.
$AbortRetryDir = Join-Path ([System.IO.Path]::GetTempPath()) "pnm_abortretry_$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $AbortRetryDir -Force | Out-Null
try {
    $AbortRetryWorker = Join-Path $AbortRetryDir 'AbortRetryWorker.ps1'
    Set-Content -LiteralPath $AbortRetryWorker -Encoding utf8 -Value @'
param([string]$TargetIP, [string]$Username, [string]$Password, [switch]$Log, [string]$DebugLogPath)
$Base = @{
    DeviceIP = $TargetIP; Hostname = "sw-$TargetIP"; JunosVersion = "x"; Gateway = "x";
    StackMembers = @(); Neighbors = @(); Clients = @(); ArpEntries = @(); Interfaces = @{};
    Uptime = "x"; LastConfigured = "x"; LastConfiguredBy = "x"; Alarms = @();
    MasterCpuUtilization = "x"; MasterMemoryUtilization = "x"; MedNeighbors = @();
    Configuration = "x"; ScanStatus = "Ok"; ScanError = $null
}
switch -Regex ($TargetIP) {
    '10\.2\.0\.1$'       { $Base.Neighbors = @(2,3,4,5 | ForEach-Object { @{ ManagementIP = "10.2.0.$_" } }) }
    # Retryable: queued for a second attempt that the abort below will never dispatch.
    '10\.2\.0\.2$'       { $Base.ScanStatus = "Error"; $Base.ScanError = "empty payload" }
    '10\.2\.0\.[345]$'   { $Base.ScanStatus = "AuthFailed"; $Base.ScanError = "bad creds" }
}
return @{ Node = $Base; Logs = @() }
'@

    $AbortRetryProgress = @{}
    $AbortRetryResult = Invoke-FleetCrawl -StartIP '10.2.0.1' -AllowedScopes @('10.2.0.') -MaxConcurrent 5 `
        -WorkerPath $AbortRetryWorker -Username 'u' -Password 'p' `
        -SnapshotDir $AbortRetryDir -ProgressTable $AbortRetryProgress 3>$null

    Test-Case "a crawl aborting while a retry is queued still aborts" {
        $AbortRetryResult.Aborted -eq $true
    }
    Test-Case "a device awaiting a retry when the crawl aborts is not silently dropped" {
        @($AbortRetryResult.Topology | Where-Object { $_.DeviceIP -eq '10.2.0.2' }).Count -eq 1
    }
    Test-Case "no device is dropped when the crawl aborts with retries pending" {
        $AbortRetryResult.Topology.Count -eq $AbortRetryResult.VisitedCount
    }
} finally {
    Remove-Item -LiteralPath $AbortRetryDir -Recurse -Force -ErrorAction SilentlyContinue
}

# A batch killed mid-stream still parses, so the node used to come back ScanStatus="Ok".
Test-Case "a timed-out batch that still produced output is flagged Partial, not Ok" {
    $JunosNodeDataSrc -match '(?s)\$Result\.TimedOut[^\r\n]*\r?\n[^\r\n]*ScanStatus\s*=\s*"Partial"'
}
Test-Case "the retryable statuses exclude AuthFailed and Aborted" {
    if ($FleetCrawlSrc -notmatch '\$RetryableStatuses\s*=\s*@\(([^\)]*)\)') { throw "Could not find `$RetryableStatuses in FleetCrawl.ps1" }
    $List = $Matches[1]
    ($List -match 'Timeout') -and ($List -match 'Partial') -and ($List -match 'Error') -and
    ($List -match 'Unreachable') -and ($List -notmatch 'AuthFailed') -and ($List -notmatch 'Aborted')
}

Write-Host "`n--- 10. Resolve-PathForDotNetIo (FileHelpers.ps1) ---" -ForegroundColor Cyan

# [Environment]::CurrentDirectory isn't kept in step with $PWD, so a relative path lands elsewhere.
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

Write-Host "`n--- 11. Crypto runtime floor and -WhatIf preview ---" -ForegroundColor Cyan

# Rfc2898DeriveBytes' SHA-256 overload needs .NET Framework 4.7.2+; Server 2016 ships 4.6.2.
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

    # Set-FileContentAtomic isn't ShouldProcess-aware: -WhatIf reaching it breaks Move-FileAtomic.
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

Write-Host "`n============================================" -ForegroundColor Cyan
if ($script:Passed -eq $script:Total) {
    Write-Host "$($script:Passed)/$($script:Total) passed" -ForegroundColor Green
} else {
    Write-Host "$($script:Passed)/$($script:Total) passed" -ForegroundColor Red
}
Write-Host "============================================`n" -ForegroundColor Cyan

if ($script:Passed -ne $script:Total) { exit 1 } else { exit 0 }

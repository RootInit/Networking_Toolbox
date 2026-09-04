<#
.SYNOPSIS
    Minimal, dependency-free smoke-test harness for PS_NetworkMapper's PowerShell-side
    security/safety-critical logic.

.DESCRIPTION
    This repo has zero automated PowerShell test coverage. A codebase audit
    (.audit/proposals/coverage-bundle.md, coverage-1..5) flagged five HIGH/CRITICAL pieces of
    logic with no regression protection at all - one of which (the RawDumps secret-redaction
    regex) has already silently regressed once in this project's history. This script is the
    audit's own recommended fix: a minimal no-Pester smoke test (plain PowerShell, since
    Pester is not guaranteed to be installed on every deployment target) that dot-sources the
    real lib/*.ps1 files and exercises their actual, shipped behavior - it never re-implements
    the logic under test.

    Covers:
      1. Get-JunosNodeData.ps1's RawDumps secret-redaction regex (coverage-1)
      2. SshHelpers.ps1's Get-JunosSshArgs injection guard (coverage-2)
      3. FleetCrawl.ps1's Test-IpInAllowedScopes crawl-scope fence (coverage-3)
      4. FileHelpers.ps1's Move-FileAtomic / Set-FileContentAtomic (coverage-4)
      5. (coverage-5, cross-session history-merge/reboot-detection) lives entirely in
         web-src/persistence.js and is already covered by web-src/test/*.test.mjs via
         `node --test` - nothing PowerShell-side to test there. As a related bonus, this
         script also covers Get-JunosNodeData.ps1's Uptime "System booted:" parsing regex,
         since it shares the same "inline regex, no dedicated function, no test" risk shape
         as item 1 and is the PS-side data that feeds the JS-side reboot detection - but it is
         NOT a substitute for coverage-5 itself.

.USAGE
    powershell.exe -File .\Run-Tests.ps1
    (run from the PS_NetworkMapper project root; plain functions/scriptblocks only, so this
    also runs fine under pwsh if that's what's on hand)

    Exits 0 if every case passed, 1 otherwise - suitable for wiring into CI later even though
    none currently exists.
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
        [switch]$ExpectFalse # default expectation is "truthy" unless this or ExpectThrow is set
    )
    $script:Total++
    try {
        $Result = & $Actual
        if ($ExpectThrow) {
            Write-Host "[FAIL] $Description (expected a throw, none occurred; got: $Result)" -ForegroundColor Red
            return
        }
        $Ok = if ($ExpectFalse) { -not $Result } else { [bool]$Result }
        if ($Ok) {
            Write-Host "[PASS] $Description" -ForegroundColor Green
            $script:Passed++
        } else {
            Write-Host "[FAIL] $Description (got: $Result)" -ForegroundColor Red
        }
    } catch {
        if ($ExpectThrow) {
            Write-Host "[PASS] $Description (threw as expected: $($_.Exception.Message))" -ForegroundColor Green
            $script:Passed++
        } else {
            Write-Host "[FAIL] $Description (unexpected throw: $($_.Exception.Message))" -ForegroundColor Red
        }
    }
}

# =========================================================================================
# 1. Get-JunosNodeData.ps1 RawDumps secret-redaction regex (coverage-1)
# =========================================================================================
# Get-JunosNodeData.ps1 is a full CLI-driving script (it opens a real ssh.exe session), not a
# dot-sourceable library, so there's no clean function to call. Rather than re-implementing
# the regex by hand here (which would repeat the exact "test re-implements instead of
# imports" anti-pattern this same audit already flagged elsewhere), extract the ACTUAL,
# shipped -replace pattern/replacement literals straight out of the source file and apply
# them - this exercises the real regex, verbatim, not a hand-copied stand-in that could drift
# from it (which is exactly how the historical regression slipped through).
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

    # Case C: the historical Pass 6->7 regression shape - a decoy, prompt-shaped line
    # ("admin@switch1> show configuration | display set") planted INSIDE a later command's
    # output (e.g. an operator-set interface Description shown in "show interfaces
    # extensive"), positioned AFTER the real config section. A greedy prefix would backtrack
    # to this LATER decoy match and leave the real, earlier secret un-redacted; the shipped
    # regex uses a non-greedy prefix specifically to avoid that.
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
# 2. SshHelpers.ps1 Get-JunosSshArgs injection guard (coverage-2)
# =========================================================================================
Write-Host "`n--- 2. Get-JunosSshArgs injection guard (SshHelpers.ps1) ---" -ForegroundColor Cyan
. (Join-Path $LibDir 'SshHelpers.ps1')

Test-Case "valid username + valid IP is accepted" {
    (Get-JunosSshArgs -Username "admin" -TargetIP "10.1.2.3") -join ' ' -match '10\.1\.2\.3'
}
Test-Case "username with a leading dash is rejected (would be parsed as an ssh flag)" {
    Get-JunosSshArgs -Username "-oProxyCommand=evil" -TargetIP "10.1.2.3"
} -ExpectThrow
Test-Case "username with a shell metacharacter (semicolon) is rejected" {
    Get-JunosSshArgs -Username "admin;rm -rf /" -TargetIP "10.1.2.3"
} -ExpectThrow
Test-Case "username with a backtick command substitution is rejected" {
    Get-JunosSshArgs -Username 'admin`whoami`' -TargetIP "10.1.2.3"
} -ExpectThrow
Test-Case "username with a `$() command substitution is rejected" {
    Get-JunosSshArgs -Username 'admin$(whoami)' -TargetIP "10.1.2.3"
} -ExpectThrow
Test-Case "username with an embedded newline is rejected" {
    Get-JunosSshArgs -Username "admin`nssh evilhost" -TargetIP "10.1.2.3"
} -ExpectThrow
Test-Case "target IP with a shell metacharacter (semicolon) is rejected" {
    Get-JunosSshArgs -Username "admin" -TargetIP "10.1.2.3;rm -rf /"
} -ExpectThrow
Test-Case "target IP with an out-of-range octet (999) is rejected" {
    Get-JunosSshArgs -Username "admin" -TargetIP "10.1.2.999"
} -ExpectThrow
Test-Case "target IP missing an octet is rejected" {
    Get-JunosSshArgs -Username "admin" -TargetIP "10.1.2"
} -ExpectThrow

# =========================================================================================
# 3. FleetCrawl.ps1 Test-IpInAllowedScopes crawl-scope fence (coverage-3)
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
# 4. FileHelpers.ps1 Move-FileAtomic / Set-FileContentAtomic (coverage-4)
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
# 5. coverage-5 (cross-session history-merge / reboot detection)
# =========================================================================================
Write-Host "`n--- 5. coverage-5 (history-merge / reboot detection) ---" -ForegroundColor Cyan
Write-Host "SKIPPED: this logic lives entirely in web-src/persistence.js (JS), already covered" -ForegroundColor Yellow
Write-Host "by web-src/test/*.test.mjs via 'node --test'. No PowerShell-side reboot-detection" -ForegroundColor Yellow
Write-Host "(comparison) logic exists to test here - not forcing an inapplicable PS test." -ForegroundColor Yellow

# Bonus (not a substitute for coverage-5): Get-JunosNodeData.ps1's Uptime "System booted:"
# parsing regex - the PS-side data that feeds the JS-side reboot detection, extracted from
# source the same way as item 1 above, since it shares that item's "inline regex, no
# dedicated function" shape.
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

# --- summary ---------------------------------------------------------------------------
Write-Host "`n============================================" -ForegroundColor Cyan
if ($script:Passed -eq $script:Total) {
    Write-Host "$($script:Passed)/$($script:Total) passed" -ForegroundColor Green
} else {
    Write-Host "$($script:Passed)/$($script:Total) passed" -ForegroundColor Red
}
Write-Host "============================================`n" -ForegroundColor Cyan

if ($script:Passed -ne $script:Total) { exit 1 } else { exit 0 }

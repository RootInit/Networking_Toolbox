<#
.SYNOPSIS
    Runs both test suites and records which host ran which, so a green run cannot be mistaken for
    evidence it is not.

.DESCRIPTION
    Run-Tests.ps1 targets Windows PowerShell 5.1. A pass under pwsh 7 on Linux exercises different
    string encoding, different JSON serialization and a different GC, and this project has already
    shipped bugs that only 5.1 reproduced - so such a run is reported as UNVERIFIED, not as a pass.

    No single host runs everything: the Windows test VM has no Node, and Linux cannot be 5.1. Each
    run therefore appends to a ledger keyed by git commit, and every run reports what is still
    missing for the commit in the working tree. "Both suites green" is a claim about a commit
    assembled from more than one machine, and this makes that explicit instead of implied.

.PARAMETER AllowStaleBuild
    Proceed even when a web-src/*.js file is newer than lib/Network_Visualizer.html. The built
    artifact is what Start-NetworkMapper.ps1 and WebServer.ps1 actually serve, so a stale one means
    the JS suite tested source that does not ship.

.PARAMETER SkipPowerShell
.PARAMETER SkipWebSrc
    Run only one suite. The ledger records what ran, so skipping does not silently become a pass.

.PARAMETER Commit
    The commit these files came from, for hosts without git - the Windows test VM has none, and
    without this its 5.1 pass lands under "unknown" and cannot be matched to the Linux run. Pass the
    short SHA the files were copied from; it is recorded verbatim, so a wrong value is a wrong
    ledger entry.

.EXAMPLE
    .\Run-AllTests.ps1
#>
[CmdletBinding()]
param(
    [switch]$AllowStaleBuild,
    [switch]$SkipPowerShell,
    [switch]$SkipWebSrc,
    [string]$Commit
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$LedgerDir = Join-Path $ProjectRoot 'test-results'
$LedgerPath = Join-Path $LedgerDir 'runs.jsonl'

# --------------------------------------------------------------- host identification

# $IsWindows does not exist on 5.1, where the host is Windows by definition.
$OnWindows = if ($null -ne (Get-Variable -Name IsWindows -ErrorAction SilentlyContinue)) { $IsWindows } else { $true }
$Edition = if ($PSVersionTable.PSEdition) { $PSVersionTable.PSEdition } else { 'Desktop' }
$PsVersion = $PSVersionTable.PSVersion.ToString()
# The primary target, exactly: Windows PowerShell 5.1, which is always the Desktop edition.
$IsPrimaryTarget = $OnWindows -and $Edition -eq 'Desktop' -and $PSVersionTable.PSVersion.Major -eq 5

$HostName = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { [System.Net.Dns]::GetHostName() }
$OsText = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
if (-not $OsText) { $OsText = [System.Environment]::OSVersion.VersionString }

$CommitSource = 'git'
$Dirty = $null
if ($Commit) {
    $CommitSource = 'parameter'
} else {
    $Commit = 'unknown'
    try {
        $Resolved = (& git -C $ProjectRoot rev-parse --short HEAD 2>$null | Select-Object -First 1)
        if ($Resolved) { $Commit = $Resolved }
        $Status = & git -C $ProjectRoot status --porcelain 2>$null
        $Dirty = [bool]$Status
    } catch {
        # No git on the host - record what we can and let -Commit supply the rest.
        $CommitSource = 'unavailable'
    }
    if ($Commit -eq 'unknown') { $CommitSource = 'unavailable' }
}

function Write-Banner {
    param([string]$Text)
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Cyan
    Write-Host $Text -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor Cyan
}

Write-Banner "PS_NetworkMapper - full test run"
Write-Host ("  host        : {0}" -f $HostName)
Write-Host ("  powershell  : {0} ({1})" -f $PsVersion, $Edition)
Write-Host ("  os          : {0}" -f $OsText)
$CommitNote = ''
if ($Dirty) { $CommitNote = ' (working tree dirty)' }
elseif ($CommitSource -eq 'parameter') { $CommitNote = ' (supplied by -Commit, not verified here)' }
elseif ($CommitSource -eq 'unavailable') { $CommitNote = ' (no git on this host - pass -Commit to attribute this run)' }
Write-Host ("  commit      : {0}{1}" -f $Commit, $CommitNote)
if ($IsPrimaryTarget) {
    Write-Host "  target      : PRIMARY (Windows PowerShell 5.1)" -ForegroundColor Green
} else {
    Write-Host "  target      : SECONDARY - a PowerShell pass here is not evidence for 5.1" -ForegroundColor Yellow
}

# --------------------------------------------------------------- build freshness

$BuildCheck = 'skipped'
$Artifact = Join-Path (Join-Path $ProjectRoot 'lib') 'Network_Visualizer.html'
$WebSrcDir = Join-Path $ProjectRoot 'web-src'
if ((Test-Path -LiteralPath $Artifact) -and (Test-Path -LiteralPath $WebSrcDir)) {
    $ArtifactTime = (Get-Item -LiteralPath $Artifact).LastWriteTimeUtc
    # Only the inlined sources matter: tools/ and test/ are not part of the bundle.
    $Newer = @(Get-ChildItem -LiteralPath $WebSrcDir -Filter '*.js' -File |
        Where-Object { $_.LastWriteTimeUtc -gt $ArtifactTime })
    if ($Newer.Count -gt 0) {
        $BuildCheck = 'stale'
        Write-Host ''
        Write-Host "[!] lib/Network_Visualizer.html is older than: $(($Newer | ForEach-Object { $_.Name }) -join ', ')" -ForegroundColor Red
        Write-Host "    That artifact is what actually gets served - web-src/ is never read at runtime." -ForegroundColor Red
        Write-Host "    Run 'npm run build' in web-src/, or pass -AllowStaleBuild." -ForegroundColor Red
        if (-not $AllowStaleBuild) {
            Write-Host ''
            Write-Host "ABORTED: stale build artifact." -ForegroundColor Red
            exit 2
        }
    } else {
        $BuildCheck = 'fresh'
        Write-Host "  build       : artifact is current" -ForegroundColor Green
    }
}

# --------------------------------------------------------------- PowerShell suite

$PsResult = [ordered]@{ status = 'skipped'; passed = $null; total = $null }
if (-not $SkipPowerShell) {
    Write-Banner "1. PowerShell suite - Run-Tests.ps1"
    $SuitePath = Join-Path $ProjectRoot 'Run-Tests.ps1'
    # *>&1, not 2>&1: Run-Tests.ps1 reports through Write-Host, which goes to the information
    # stream and is invisible to an error-stream redirect. Getting this wrong makes a 184/184 run
    # parse as zero tests and report a failure.
    $Output = & $SuitePath *>&1 | ForEach-Object { "$_" }
    $ExitCode = $LASTEXITCODE
    $Output | ForEach-Object {
        if ($_ -match '^\[FAIL\]') { Write-Host $_ -ForegroundColor Red }
        elseif ($_ -match '\d+/\d+ passed') { Write-Host $_ -ForegroundColor Cyan }
    }
    $Match = [regex]::Match(($Output -join "`n"), '(?m)^\s*(\d+)/(\d+) passed')
    if ($Match.Success) {
        $PsResult.passed = [int]$Match.Groups[1].Value
        $PsResult.total = [int]$Match.Groups[2].Value
    }
    $PsResult.status = if ($ExitCode -eq 0 -and $Match.Success -and $PsResult.passed -eq $PsResult.total) { 'pass' } else { 'fail' }
    if ($null -eq $PsResult.total) {
        Write-Host "  -> $($PsResult.status)  (could not parse a count from the suite output)" -ForegroundColor Red
    } else {
        Write-Host ("  -> {0}  ({1}/{2})" -f $PsResult.status, $PsResult.passed, $PsResult.total)
    }
}

# --------------------------------------------------------------- web-src suite

$JsResult = [ordered]@{ status = 'skipped'; passed = $null; total = $null; reason = $null }
if (-not $SkipWebSrc) {
    Write-Banner "2. web-src suite - node --test"
    $Node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $Node) {
        $JsResult.reason = 'node not installed on this host'
        Write-Host "  -> skipped: node is not on PATH" -ForegroundColor Yellow
    } elseif (-not (Test-Path -LiteralPath $WebSrcDir)) {
        $JsResult.reason = 'web-src/ not present (release layout)'
        Write-Host "  -> skipped: no web-src/ directory" -ForegroundColor Yellow
    } else {
        Push-Location $WebSrcDir
        try {
            $JsOut = & node --test 'test/*.test.mjs' *>&1 | ForEach-Object { "$_" }
            $JsExit = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        $JsText = $JsOut -join "`n"
        $JsOut | Where-Object { $_ -match '^not ok |^\s*pass \d+|^\s*fail \d+' } | ForEach-Object { Write-Host $_ }
        # node --test prints "# pass 230" / "# fail 0" in TAP, or an info-prefixed form when not TAP.
        $PassMatch = [regex]::Match($JsText, '(?m)^\D*pass\s+(\d+)\s*$')
        $FailMatch = [regex]::Match($JsText, '(?m)^\D*fail\s+(\d+)\s*$')
        if ($PassMatch.Success -and $FailMatch.Success) {
            $JsResult.passed = [int]$PassMatch.Groups[1].Value
            $JsResult.total = $JsResult.passed + [int]$FailMatch.Groups[1].Value
        }
        $JsResult.status = if ($JsExit -eq 0) { 'pass' } else { 'fail' }
        Write-Host ("  -> {0}  ({1}/{2})" -f $JsResult.status, $JsResult.passed, $JsResult.total)
    }
}

# --------------------------------------------------------------- ledger

$Entry = [ordered]@{
    timestamp       = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    commit          = $Commit
    commitSource    = $CommitSource
    dirty           = $Dirty
    host            = $HostName
    psVersion       = $PsVersion
    psEdition       = $Edition
    os              = $OsText
    isPrimaryTarget = $IsPrimaryTarget
    buildArtifact   = $BuildCheck
    powershell      = $PsResult
    webSrc          = $JsResult
}
if (-not (Test-Path -LiteralPath $LedgerDir)) { New-Item -ItemType Directory -Path $LedgerDir -Force | Out-Null }
# One JSON object per line, appended: concurrent runs on different hosts must not overwrite
# each other, and -Depth 5 keeps the nested suite results intact.
[System.IO.File]::AppendAllText($LedgerPath, (($Entry | ConvertTo-Json -Depth 5 -Compress) + "`n"))

# --------------------------------------------------------------- verdict

$Prior = @()
if (Test-Path -LiteralPath $LedgerPath) {
    foreach ($Line in (Get-Content -LiteralPath $LedgerPath)) {
        if ([string]::IsNullOrWhiteSpace($Line)) { continue }
        try { $Prior += ($Line | ConvertFrom-Json) } catch { }
    }
}
$ForCommit = @()
if ($Commit -ne 'unknown') {
    $ForCommit = @($Prior | Where-Object { $_.commit -eq $Commit -and -not $_.dirty })
}
$PsOn51 = @($ForCommit | Where-Object { $_.isPrimaryTarget -and $_.powershell.status -eq 'pass' })
$JsAnywhere = @($ForCommit | Where-Object { $_.webSrc.status -eq 'pass' })

Write-Banner "RESULT"
Write-Host ("  PowerShell suite : {0}{1}" -f $PsResult.status, $(if ($PsResult.total) { "  ($($PsResult.passed)/$($PsResult.total))" } else { '' }))
Write-Host ("  web-src suite    : {0}{1}" -f $JsResult.status, $(if ($JsResult.total) { "  ($($JsResult.passed)/$($JsResult.total))" } elseif ($JsResult.reason) { "  ($($JsResult.reason))" } else { '' }))
Write-Host ''
if ($Dirty) {
    Write-Host "  Working tree is dirty - this run is not attributed to a commit." -ForegroundColor Yellow
} elseif ($Commit -eq 'unknown') {
    Write-Host "  No commit known for this run - pass -Commit <sha> so it can be matched to others." -ForegroundColor Yellow
} else {
    Write-Host ("  Coverage for commit {0}, across all hosts that have reported:" -f $Commit)
    if ($PsOn51.Count -gt 0) {
        $W = $PsOn51[-1]
        Write-Host ("    [ok] PowerShell verified on 5.1  ({0}, {1}, {2})" -f $W.host, $W.psVersion, $W.timestamp) -ForegroundColor Green
    } else {
        Write-Host "    [--] PowerShell NOT yet verified on Windows PowerShell 5.1" -ForegroundColor Yellow
    }
    if ($JsAnywhere.Count -gt 0) {
        $W = $JsAnywhere[-1]
        Write-Host ("    [ok] web-src suite passed        ({0}, {1})" -f $W.host, $W.timestamp) -ForegroundColor Green
    } else {
        Write-Host "    [--] web-src suite has not passed for this commit" -ForegroundColor Yellow
    }
}
Write-Host ''
Write-Host ("  Ledger: {0}" -f $LedgerPath) -ForegroundColor DarkGray

$Failed = ($PsResult.status -eq 'fail') -or ($JsResult.status -eq 'fail')
if ($Failed) { exit 1 }
exit 0

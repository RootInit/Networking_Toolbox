# HttpListener-based local webserver for Network_Visualizer. Localhost-only by design:
# binds "localhost" specifically (no netsh urlacl/admin needed), and no auth is needed
# either - the only sensitive action it can trigger is spawning an SSH session with
# in-memory switch credentials, which is only safe when caller and process owner are
# the same person, true for localhost and false the moment this is rebound to a LAN address.
#
# Not meant to be run directly - dot-source it, then call Start-MapperWebServer.

# Dot-sourced directly (not relying on caller load order) so this file's correctness
# doesn't depend on Start-NetworkMapper.ps1 having loaded these first.
. (Join-Path $PSScriptRoot "TopologyCrypto.ps1")
. (Join-Path $PSScriptRoot "SshHelpers.ps1")
. (Join-Path $PSScriptRoot "FleetCrawl.ps1")

$script:ContentTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".mjs"  = "application/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".svg"  = "image/svg+xml"
    ".png"  = "image/png"
    ".ico"  = "image/x-icon"
}

function Send-WebResponse {
    param($Response, [int]$StatusCode, [byte[]]$Bytes, [string]$ContentType = "text/plain; charset=utf-8")
    $Response.StatusCode = $StatusCode
    $Response.ContentType = $ContentType
    $Response.ContentLength64 = $Bytes.Length
    $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
    $Response.OutputStream.Close()
}

function Send-WebJson {
    param($Response, [int]$StatusCode, [hashtable]$Object, [int]$Depth = 10)
    try {
        $Json = $Object | ConvertTo-Json -Depth $Depth -Compress
    } catch {
        # Must not fall through to Start-MapperWebServer's catch-all, which sends a
        # plain-text 500 body - every client caller does .json() on every response
        # regardless of status, so a non-JSON body here is a guaranteed parse failure
        # that discards the real error. Emit a small, always-serializable JSON error instead.
        $ErrJson = @{ error = "Server failed to serialize response: $_" } | ConvertTo-Json -Compress
        Send-WebResponse -Response $Response -StatusCode 500 -Bytes ([System.Text.Encoding]::UTF8.GetBytes($ErrJson)) -ContentType "application/json; charset=utf-8"
        return
    }
    Send-WebResponse -Response $Response -StatusCode $StatusCode -Bytes ([System.Text.Encoding]::UTF8.GetBytes($Json)) -ContentType "application/json; charset=utf-8"
}

# Mapper_Debug.log - the same file Invoke-FleetCrawl's Write-DebugLogLocal writes crawl
# activity to (set once via $script:DebugLogPath in Start-MapperWebServer).
function Write-MapperDebugLog {
    param([string]$Message)
    if (-not $script:DebugLogPath) { return }
    # Best-effort: a full disk or locked log file must not take down the request logging to it.
    # -Encoding utf8 explicit, or a mixed-encoding file causes CJK mojibake in text editors.
    try { "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" | Out-File -FilePath $script:DebugLogPath -Append -Encoding utf8 } catch {}
}

# Lets the browser (window.reportClientError, utils.js) forward client-side errors into
# Mapper_Debug.log, so server- and client-side failures of a scan end up in one place.
# Tolerant of a malformed/missing body - a logging endpoint must not itself throw.
function Invoke-ClientErrorAction {
    param($Response, [string]$Body)

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}

    $MessageText = if ($Parsed -and $Parsed.message) { [string]$Parsed.message } else { "(no message)" }
    $SourceText = if ($Parsed -and $Parsed.source) { [string]$Parsed.source } else { "unknown" }
    $UrlText = if ($Parsed -and $Parsed.url) { [string]$Parsed.url } else { "" }
    $StackText = if ($Parsed -and $Parsed.stack) { [string]$Parsed.stack } else { "" }

    $HeaderLine = "CLIENT ERROR [$SourceText] $MessageText"
    if ($UrlText) { $HeaderLine += " (at $UrlText)" }
    Write-MapperDebugLog $HeaderLine
    if ($StackText) {
        foreach ($StackLine in ($StackText -split "`n")) { Write-MapperDebugLog "    $($StackLine.TrimEnd())" }
    }

    Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "logged" }
}

# $Request.ContentEncoding falls back to the system ANSI codepage on Windows PowerShell
# 5.1 when no charset is declared (our fetch() calls never declare one) - decode as UTF-8
# explicitly instead, since the browser body is always UTF-8 regardless of the header.
function Read-WebRequestBody {
    param($Request)
    $Reader = [System.IO.StreamReader]::new($Request.InputStream, [System.Text.Encoding]::UTF8)
    try { return $Reader.ReadToEnd() } finally { $Reader.Close() }
}

# Minimal query-string reader. [System.Web.HttpUtility] isn't reliably present on both
# runtimes this repo targets; [System.Net.WebUtility] is, so that's the only dependency.
function Get-QueryParam {
    param([string]$Query, [string]$Name)
    if ([string]::IsNullOrEmpty($Query)) { return $null }
    foreach ($Pair in $Query.TrimStart('?') -split '&') {
        $Parts = $Pair -split '=', 2
        if ($Parts.Length -eq 2 -and [System.Net.WebUtility]::UrlDecode($Parts[0]) -eq $Name) {
            return [System.Net.WebUtility]::UrlDecode($Parts[1])
        }
    }
    return $null
}

# CSRF/DNS-rebinding guard for every endpoint that changes state or hands back something
# sensitive (e.g. /api/session-password). Localhost binding only proves the caller runs as
# this user, not that it's our page - a rebound-DNS fetch or hidden cross-origin form still
# looks same-machine. Origin (Referer as fallback) is browser-set and unforgeable by page JS,
# so check it; fail closed if neither header is present.
#
# Does NOT cover a hostile process running as a different OS user on the same machine - it
# can set any Origin it likes talking directly to this HttpListener. Pre-existing, app-wide gap.
function Test-SameOriginRequest {
    param($Request, [int]$Port)
    $Expected = "http://localhost:$Port"
    $Origin = $Request.Headers["Origin"]
    if ($Origin) { return $Origin -eq $Expected }
    $Referer = $Request.Headers["Referer"]
    if ($Referer) { return $Referer -eq "$Expected/" -or $Referer.StartsWith("$Expected/") }
    return $false
}

# Launches Connect-Switch.ps1 (interactive SSH, askpass-injected via a short-lived
# credential file) against a target IP. Deliberately narrow: fixed script, one validated
# parameter, no free-form command surface. $TargetIP is regex-locked to IPv4 shape before
# reaching Start-Process, so it carries no shell metacharacters.
#
# $PowerShellExePath is resolved by Start-MapperWebServer from the CURRENT process rather
# than hardcoded, since a pwsh-only machine has no "powershell.exe" to find.
function Invoke-ConnectAction {
    param($Response, [string]$Body, [string]$ConnectScriptPath, [string]$JunosUsername, [string]$JunosPassword, [string]$PowerShellExePath = "powershell.exe")

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

    # Declared outside the try so the catch can see it: the plaintext credential file in
    # %TEMP% is normally removed by Connect-Switch.ps1's own finally block once it reads it.
    $CredFile = $null
    try {
        $CredFile = New-JunosCredentialFile -Username $JunosUsername -Password $JunosPassword
        $ArgString = @("-NoExit", "-File", "`"$ConnectScriptPath`"", "-TargetIP", $TargetIP, "-CredentialFile", "`"$CredFile`"") -join ' '
        Start-Process -FilePath $PowerShellExePath -ArgumentList $ArgString | Out-Null
        Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "launched"; ip = $TargetIP }
    } catch {
        # Launch failed before Connect-Switch.ps1 could clean up its own credential file -
        # remove it here so the plaintext password doesn't leak/accumulate in %TEMP%.
        if ($CredFile) { Remove-JunosCredentialFile -CredentialFile $CredFile }
        Write-MapperDebugLog "CONNECT ERROR [$TargetIP] Failed to launch SSH session: $_"
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to launch SSH session: $_" }
    }
}

# Re-scans a single device without waiting for a full fleet crawl. Async: a scan can take
# up to ~50s and the accept loop handles one request at a time, so this starts it in a
# single-slot runspace pool and returns immediately; the browser polls
# Invoke-RescanStatusAction for the result. Only one rescan may be in-flight at a time
# (hygiene, not a security boundary - the analyst already has SSH access via /api/connect).
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

    # Reap any previously-timed-out job that has since finished (see the timeout handling
    # in Invoke-RescanStatusAction for why a timed-out job isn't force-stopped).
    for ($i = $script:OrphanedScans.Count - 1; $i -ge 0; $i--) {
        $Orphan = $script:OrphanedScans[$i]
        if ($Orphan.Handle.IsCompleted) {
            try { $Orphan.PS.EndInvoke($Orphan.Handle) | Out-Null } catch {}
            $Orphan.PS.Dispose()
            $script:OrphanedScans.RemoveAt($i)
        }
    }

    if ($script:PendingScan) {
        Send-WebJson -Response $Response -StatusCode 409 -Object @{
            error = "A rescan is already in progress"; jobId = $script:PendingScan.JobId; ip = $script:PendingScan.IP
        }
        return
    }

    # Never -HumanReadable (ends in `exit`, killing this runspace) and never -Log (no
    # reason for an ad-hoc rescan to write RawDumps/).
    $JobId = [guid]::NewGuid().ToString()
    $PS = [powershell]::Create().AddCommand($WorkerPath).AddParameter("TargetIP", $TargetIP).AddParameter("Username", $JunosUsername).AddParameter("Password", $JunosPassword)
    $PS.RunspacePool = $script:RescanPool
    # $PS isn't reachable from $script:PendingScan until BeginInvoke succeeds below - if it
    # throws, dispose it here or it leaks (nothing else references it to clean up later).
    try {
        $Handle = $PS.BeginInvoke()
    } catch {
        $PS.Dispose()
        throw
    }

    $script:PendingScan = [PSCustomObject]@{ PS = $PS; Handle = $Handle; IP = $TargetIP; JobId = $JobId; StartTime = (Get-Date) }
    Send-WebJson -Response $Response -StatusCode 202 -Object @{ status = "started"; jobId = $JobId; ip = $TargetIP }
}

# Quick reachability check (a few ICMP echoes). Synchronous - Test-Connection returns in a
# couple seconds worst case, so no job-queue/poll dance is needed here unlike a rescan.
function Invoke-PingAction {
    param($Response, [string]$Body)

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    $TargetIP = if ($Parsed) { [string]$Parsed.ip } else { $null }

    # Strict dotted-quad check - stops this from becoming a generic "resolve and probe
    # anything" endpoint (a hostname, a flag-looking string, etc.).
    if (-not $TargetIP -or $TargetIP -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Invalid or missing IP address" }
        return
    }

    try {
        # -Quiet avoided (no latency/loss detail). Parameter set and failure shape differ
        # by generation: PS 7+'s Test-Connection returns one object per ping including
        # timeouts (Status='TimedOut', Latency=0) - must filter on Status -eq 'Success' or
        # a dead device reports as 4/4 replies. PS 5.1's classic cmdlet only ever returns
        # successes as objects (failures go to the error stream), so plain assignment
        # already collects successes only - -ErrorAction Stop there would wrongly turn the
        # first failure into a terminating exception and discard earlier successes.
        if ($PSVersionTable.PSVersion.Major -ge 6) {
            $AllResults = Test-Connection -TargetName $TargetIP -Count 4 -TimeoutSeconds 2 -ErrorAction SilentlyContinue
            $Results = @($AllResults | Where-Object { $_.Status -eq 'Success' })
        } else {
            $Results = @(Test-Connection -ComputerName $TargetIP -Count 4 -ErrorAction SilentlyContinue)
        }
    } catch {
        # Report as zero replies, not a 500 - an unreachable device is an expected result here.
        $Results = @()
    }

    $ReplyCount = $Results.Count
    $Latencies = @($Results | ForEach-Object {
        if ($null -ne $_.PSObject.Properties['Latency']) { $_.Latency }
        elseif ($null -ne $_.PSObject.Properties['ResponseTime']) { $_.ResponseTime }
    } | Where-Object { $null -ne $_ })

    $AvgLatency = if ($Latencies.Count -gt 0) { [math]::Round(($Latencies | Measure-Object -Average).Average, 1) } else { $null }

    Send-WebJson -Response $Response -StatusCode 200 -Object @{
        ip = $TargetIP; alive = ($ReplyCount -gt 0); sent = 4; received = $ReplyCount; avgLatencyMs = $AvgLatency
    }
}

# Polled by the browser every ~2s while a rescan is outstanding.
function Invoke-RescanStatusAction {
    param($Response, [string]$JobId)

    if (-not $JobId -or -not $script:PendingScan -or $script:PendingScan.JobId -ne $JobId) {
        Send-WebJson -Response $Response -StatusCode 404 -Object @{ error = "Unknown or expired job id" }
        return
    }

    $Job = $script:PendingScan

    if ($Job.Handle.IsCompleted) {
        $script:PendingScan = $null
        try {
            $Result = $Job.PS.EndInvoke($Job.Handle)
        } catch {
            $Job.PS.Dispose()
            Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "complete"; ok = $false; ip = $Job.IP; reason = "Scan failed: $_" }
            return
        }
        $Job.PS.Dispose()

        # Success/failure decided here from the CRITICAL log-line signal Get-JunosNodeData.ps1
        # emits, not inferred by the browser. ok:false omits `node` entirely, since a failed
        # scan's fields are placeholder-shaped and should not overwrite existing good data.
        $Logs = if ($Result -and $Result.Logs) { @($Result.Logs) } else { @() }
        $HasCritical = $false
        foreach ($LogLine in $Logs) { if ($LogLine -match 'CRITICAL') { $HasCritical = $true; break } }

        if (-not $Result -or -not $Result.Node -or $HasCritical) {
            Send-WebJson -Response $Response -StatusCode 200 -Object @{
                status = "complete"; ok = $false; ip = $Job.IP
                reason = "Switch returned empty payload or scan failed - see logs"; logs = $Logs
            }
            return
        }

        Send-WebJson -Response $Response -StatusCode 200 -Depth 20 -Object @{ status = "complete"; ok = $true; ip = $Job.IP; node = $Result.Node; logs = $Logs }
        return
    }

    $Elapsed = ((Get-Date) - $Job.StartTime).TotalSeconds
    if ($Elapsed -gt 90) {
        # Not force-stopped: New-JunosAskPass writes the switch password to a plaintext
        # %TEMP% file cleaned up only by the worker's own finally block, and .Stop()'ing a
        # pipeline blocked in Process.WaitForExit isn't guaranteed to run that promptly.
        # Instead free the single active slot and let Invoke-RescanAction reap it once it
        # actually finishes on its own.
        $script:OrphanedScans.Add($Job)
        $script:PendingScan = $null
        Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "timeout"; ip = $Job.IP; elapsedSeconds = [math]::Round($Elapsed) }
        return
    }

    Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "running"; ip = $Job.IP; elapsedSeconds = [math]::Round($Elapsed) }
}

# Kicks off a full fleet crawl asynchronously (same "don't block the accept loop" reasoning
# as Invoke-RescanAction, but the runspace pool is sized to $MaxConcurrent). Only one scan
# may be in flight, tracked in $script:PendingScanNetwork; a second click gets a 409.
function Invoke-ScanNetworkAction {
    param($Response, [string]$Body, [string]$WorkerPath, [string]$JunosUsername, [string]$JunosPassword,
          [string]$MaxConcurrent, [string[]]$AllowedScopes, [string]$SnapshotDir,
          [byte[]]$EncKey, [byte[]]$MacKey, [byte[]]$Salt, [int]$Iterations)

    if ([string]::IsNullOrWhiteSpace($JunosUsername) -or [string]::IsNullOrWhiteSpace($JunosPassword)) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "No Juniper login configured - set it in the Settings tab, then try again." }
        return
    }

    # Reap a finished scan job before deciding whether a new one can start - without this,
    # a scan whose result the browser never polled (tab closed) would sit here forever,
    # 409-ing every future click. If .Collected is already set, PS/Runspace are already
    # disposed and this just clears the slot; otherwise collect here so nothing leaks.
    if ($script:PendingScanNetwork -and $script:PendingScanNetwork.Handle.IsCompleted) {
        $Finished = $script:PendingScanNetwork
        if (-not $Finished.Collected) {
            try { $Finished.PS.EndInvoke($Finished.Handle) | Out-Null } catch {}
            try { $Finished.PS.Dispose() } catch {}
            try { $Finished.Runspace.Dispose() } catch {}
        }
        $script:PendingScanNetwork = $null
    }

    if ($script:PendingScanNetwork) {
        Send-WebJson -Response $Response -StatusCode 409 -Object @{ error = "A network scan is already in progress"; ip = $script:PendingScanNetwork.StartIP }
        return
    }

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    $StartIP = if ($Parsed -and $Parsed.startIp) { [string]$Parsed.startIp } else { $null }

    if (-not $StartIP -or $StartIP -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Invalid or missing starting IP address" }
        return
    }

    # Without this, Invoke-FleetCrawl's Write-DebugLogLocal is a no-op for web-triggered
    # scans, making a failed scan undiagnosable. Overwritten per crawl, same as the CLI path.
    $DebugLogPath = Join-Path $SnapshotDir "ScanNetwork_Debug.log"

    $ProgressTable = [hashtable]::Synchronized(@{ Visited = 0; QueueDepth = 1; ActiveJobs = 0; Done = $false })
    $PS = [powershell]::Create().AddCommand("Invoke-FleetCrawl").
        AddParameter("StartIP", $StartIP).
        AddParameter("AllowedScopes", $AllowedScopes).
        AddParameter("MaxConcurrent", [int]$MaxConcurrent).
        AddParameter("WorkerPath", $WorkerPath).
        AddParameter("Username", $JunosUsername).
        AddParameter("Password", $JunosPassword).
        AddParameter("SnapshotDir", $SnapshotDir).
        AddParameter("ProgressTable", $ProgressTable).
        AddParameter("DebugLogPath", $DebugLogPath)
    if ($EncKey) { $PS.AddParameter("EncKey", $EncKey).AddParameter("MacKey", $MacKey).AddParameter("Salt", $Salt).AddParameter("Iterations", $Iterations) | Out-Null }

    # A fresh [powershell]::Create() runspace doesn't inherit Invoke-FleetCrawl's
    # definition from this session by default, so load it explicitly.
    $InitialState = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
    $FleetCrawlPath = Join-Path $PSScriptRoot "FleetCrawl.ps1"
    $InitialState.StartupScripts.Add($FleetCrawlPath) | Out-Null
    $Runspace = [runspacefactory]::CreateRunspace($InitialState)
    # $PS/$Runspace aren't reachable from $script:PendingScanNetwork until BeginInvoke
    # succeeds below - if Open()/BeginInvoke() throws, dispose both here or they leak
    # (nothing else references them to clean up later).
    try {
        $Runspace.Open()
        $PS.Runspace = $Runspace
        $Handle = $PS.BeginInvoke()
    } catch {
        $PS.Dispose()
        $Runspace.Dispose()
        throw
    }
    # Collected/Outcome: filled in once by Invoke-ScanNetworkStatusAction on first
    # completion so the result can be re-served idempotently to later polls.
    $script:PendingScanNetwork = [PSCustomObject]@{ PS = $PS; Runspace = $Runspace; Handle = $Handle; StartIP = $StartIP; StartTime = (Get-Date); ProgressTable = $ProgressTable; Collected = $false; Outcome = $null }
    Send-WebJson -Response $Response -StatusCode 202 -Object @{ status = "started"; startIp = $StartIP }
}

# Polled by the browser every ~2s. Unlike a rescan, a fleet crawl can run for many minutes,
# so no timeout ceiling is imposed - the browser just keeps polling until "complete".
# Returns the full decrypted topology inline (already in memory) rather than writing it to
# disk and adding new file-serving surface outside $VisualizerRoot.
function Invoke-ScanNetworkStatusAction {
    param($Response)

    if (-not $script:PendingScanNetwork) {
        Send-WebJson -Response $Response -StatusCode 404 -Object @{ error = "No scan is currently running or was ever started this session" }
        return
    }

    $Job = $script:PendingScanNetwork

    if ($Job.Handle.IsCompleted) {
        # Collect (EndInvoke + Dispose) exactly once and cache the outcome - EndInvoke
        # throws if called twice, and later polls just re-serve the cached outcome.
        if (-not $Job.Collected) {
            try {
                $Result = $Job.PS.EndInvoke($Job.Handle)
                # Index explicitly ($Result[0]) rather than dotting into $Result: PowerShell
                # member enumeration on a 1-item collection unwraps straight to that item's
                # own .Topology, which for a single-device crawl is a bare PSCustomObject
                # instead of the List[object] Invoke-FleetCrawl actually returns - breaking
                # ConvertTo-Json's array shape and the browser's .forEach(...) on it.
                $Payload = if ($Result -and $Result.Count -gt 0) { $Result[0] } else { $null }

                if (-not $Payload -or -not $Payload.Topology) {
                    $Job.Outcome = @{ status = "complete"; ok = $false; reason = "Scan produced no data - see server console/debug log" }
                } else {
                    $Job.Outcome = @{
                        status = "complete"; ok = $true
                        topology = $Payload.Topology; scanTimestamp = $Payload.ScanTimestampIso
                        outputFile = (Split-Path $Payload.OutputFile -Leaf); visitedCount = $Payload.VisitedCount
                    }
                }
            } catch {
                $Job.Outcome = @{ status = "complete"; ok = $false; reason = "Scan failed: $_" }
            }
            try { $Job.PS.Dispose() } catch {}
            try { $Job.Runspace.Dispose() } catch {}
            $Job.Collected = $true
        }

        # -Depth 100 matches FleetCrawl.ps1's Write-TopologyOutputLocal - a shallower depth
        # risks ConvertTo-Json silently truncating a deeply-nested topology.
        Send-WebJson -Response $Response -StatusCode 200 -Depth 100 -Object $Job.Outcome
        return
    }

    Send-WebJson -Response $Response -StatusCode 200 -Object @{
        status = "running"; startIp = $Job.StartIP
        elapsedSeconds = [math]::Round(((Get-Date) - $Job.StartTime).TotalSeconds)
        visited = $Job.ProgressTable.Visited; queueDepth = $Job.ProgressTable.QueueDepth; activeJobs = $Job.ProgressTable.ActiveJobs
    }
}

# Serves the current Configuration.json.enc envelope as-is (still encrypted - the browser
# decrypts it client-side). 404 with a JSON body so the browser can tell "no config yet"
# apart from a real error.
#
# Skips ConvertFrom-Json/Send-WebJson entirely: `-AsHashtable` (needed for Send-WebJson's
# [hashtable] param) is PowerShell 6.0+ only and throws under Windows PowerShell 5.1. The
# envelope is already JSON on disk, so just write the raw bytes straight through.
function Invoke-GetConfigAction {
    param($Response, [string]$ConfigPath)

    if (-not (Test-Path $ConfigPath)) {
        Send-WebJson -Response $Response -StatusCode 404 -Object @{ error = "No configuration file yet" }
        return
    }

    try {
        # -Encoding UTF8 explicit: Get-Content -Raw with no -Encoding falls back to the
        # system ANSI codepage on a BOM-less UTF-8 file (e.g. written under pwsh 7+, read
        # back under Windows PowerShell 5.1), silently mis-decoding non-ASCII fields.
        $Raw = Get-Content $ConfigPath -Raw -Encoding UTF8
        Send-WebResponse -Response $Response -StatusCode 200 -Bytes ([System.Text.Encoding]::UTF8.GetBytes($Raw)) -ContentType "application/json; charset=utf-8"
    } catch {
        Write-MapperDebugLog "GET-CONFIG ERROR [$ConfigPath] Failed to read configuration file: $_"
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to read configuration file: $_" }
    }
}

# Hands the browser the encryption password Start-NetworkMapper.ps1 already prompted for at
# startup, so it can decrypt Configuration.json.enc / NetworkMap_*.json.enc client-side
# without re-prompting the operator. A deliberate exception to Invoke-SaveConfigAction's
# "the password never crosses the wire" posture below.
#
# Gated by Test-SameOriginRequest even though this is a read-only GET: a DNS-rebinding
# attack makes a same-origin-looking fetch from the browser's point of view, so "no side
# effects" alone doesn't protect it - and a leaked password here is silent and durable
# (decrypts every archived snapshot offline, indefinitely), unlike /api/connect's worst case.
#
# Returns "" (not null) when there's nothing to offer - the browser falls back to prompting.
function Invoke-GetSessionPasswordAction {
    param($Response, [string]$EncryptionPassword)
    Send-WebJson -Response $Response -StatusCode 200 -Object @{ password = [string]$EncryptionPassword }
}

# Backs the browser's startup autoload (window.autoloadLastScan in app.js) - hands back
# every archived snapshot's raw content so the browser can feed them straight into the same
# processSelectedFiles() path a manual folder-pick uses, without a file-picker gesture.
# Same NetworkMap_*.json(.enc) naming/exclusion convention as the folder-picker filter in
# app.js's forceLoadFolder - a mid-crawl *.tmp.json(.enc) must not be picked up as finished.
#
# Gated by Test-SameOriginRequest for the same reason as Invoke-GetSessionPasswordAction:
# this is read-only but hands back full topology contents on a bare GET.
function Invoke-GetSnapshotsAction {
    param($Response, [string]$SnapshotDir)

    if (-not (Test-Path $SnapshotDir)) {
        Send-WebJson -Response $Response -StatusCode 200 -Object @{ snapshots = @() }
        return
    }

    try {
        $Files = Get-ChildItem -LiteralPath $SnapshotDir -File |
            Where-Object { $_.Name -match '^NetworkMap_.*\.json(\.enc)?$' -and $_.Name -notmatch '\.tmp\.json(\.enc)?$' }

        # Per-file try/catch: a single locked/unreadable file (e.g. a concurrent crawl mid-
        # write, a permissions issue) must not 500 the whole autoload - skip it and serve
        # every other snapshot, matching processSelectedFiles' own "one bad file in a batch
        # doesn't discard the rest" convention (app.js). -LiteralPath on both calls - a
        # filename containing [ or ] would otherwise be wildcard-interpreted by -Path.
        $Snapshots = @($Files | ForEach-Object {
            try {
                $Content = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8
                if ([string]::IsNullOrEmpty($Content)) { return }
                @{ name = $_.Name; content = $Content }
            } catch {
                Write-MapperDebugLog "GET-SNAPSHOTS WARNING [$($_.FullName)] Skipped unreadable snapshot: $_"
            }
        })

        Send-WebJson -Response $Response -StatusCode 200 -Object @{ snapshots = $Snapshots }
    } catch {
        Write-MapperDebugLog "GET-SNAPSHOTS ERROR [$SnapshotDir] Failed to read snapshot(s): $_"
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to read snapshot(s): $_" }
    }
}

# Encrypts and writes Configuration.json.enc. The browser sends PLAINTEXT edited config
# JSON - the encryption password itself never crosses in this request (see
# Invoke-GetSessionPasswordAction for the one deliberate exception). A fresh salt/IV is
# generated per save (saves are rare/interactive, no reason to cache the key across calls).
function Invoke-SaveConfigAction {
    param($Response, [string]$Body, [string]$ConfigPath, [string]$EncryptionPassword, [switch]$NoEncryption)

    # Fail closed: if Configuration.json.enc failed to decrypt at startup and the operator
    # chose to continue anyway, $EncryptionPassword is blanked - re-encrypting under it would
    # silently lock every future session out under an unrecorded password. Doesn't apply in
    # -NoEncryption mode, where there's no password to have failed to decrypt.
    if (-not $NoEncryption -and [string]::IsNullOrWhiteSpace($EncryptionPassword)) {
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "No working encryption password for this session - Configuration.json.enc could not be decrypted at startup, so saving is disabled to avoid rewriting the file under an unverified password. Restart Start-NetworkMapper.ps1 with the correct password." }
        return
    }

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    # Presence check, not truthiness: `-not $Parsed.devices` would also reject a legitimate
    # `devices: []` save, since PowerShell treats an empty array as falsy.
    if (-not $Parsed -or $null -eq $Parsed.devices) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Request body must be JSON with a 'devices' array" }
        return
    }

    try {
        if ($NoEncryption) {
            # Re-serialize rather than raw $Body | Out-File, so the file is consistently formatted.
            $Parsed | ConvertTo-Json -Depth 10 | Out-File -FilePath $ConfigPath -Encoding utf8
        } else {
            $SaltBytes = [byte[]]::new(16)
            $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            $Rng.GetBytes($SaltBytes)
            $Rng.Dispose()

            # Shared with the crawl's own encryption via TopologyCrypto.ps1, so iteration
            # count can't drift between the crawler and the webserver.
            $Iterations = Get-TopologyPbkdf2Iterations
            $KeyMaterial = Get-TopologyKeyMaterial -Password $EncryptionPassword -Salt $SaltBytes -Iterations $Iterations
            $Envelope = Protect-TopologyPayload -PlainJson $Body -EncKey $KeyMaterial.EncKey -MacKey $KeyMaterial.MacKey -Salt $SaltBytes -Iterations $Iterations -Format "PSNetworkMapper-EncryptedConfig"

            $Envelope | ConvertTo-Json -Depth 10 | Out-File -FilePath $ConfigPath -Encoding utf8
        }

        # Push just-saved credentials into the running server's live copies so
        # /api/connect, /api/rescan, /api/scan-network use them immediately, instead of
        # requiring a restart. After the file write (a failed save must not update live
        # credentials) and a presence check, not truthiness: `credentials:null` (sent when
        # nothing was loaded) leaves in-memory copies alone, but an explicit {username:"",
        # password:""} does clear them.
        if ($Parsed.credentials) {
            $script:JunosUsername = [string]$Parsed.credentials.username
            $script:JunosPassword = [string]$Parsed.credentials.password
        }

        Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "saved" }
    } catch {
        Write-MapperDebugLog "SAVE-CONFIG ERROR [$ConfigPath] Failed to save configuration: $_"
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to save configuration: $_" }
    }
}

# Serves a file under $VisualizerRoot, defaulting "/" to index.html. Resolves the
# request path to an absolute path and rejects anything that lands outside
# $VisualizerRoot (../ traversal, absolute-path requests) before it ever touches disk.
function Invoke-StaticFile {
    param($Response, [string]$AbsolutePath, [string]$VisualizerRoot)

    $RelPath = $AbsolutePath.TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($RelPath)) { $RelPath = "index.html" }

    $RootFull = [System.IO.Path]::GetFullPath($VisualizerRoot)
    if (-not $RootFull.EndsWith([System.IO.Path]::DirectorySeparatorChar)) { $RootFull += [System.IO.Path]::DirectorySeparatorChar }
    $FullPath = [System.IO.Path]::GetFullPath((Join-Path $RootFull $RelPath))

    # $RootFull's trailing separator (added above) makes this a path-prefix match, not a
    # string-prefix match - otherwise "Network_Visualizer" would also accept
    # "Network_Visualizer_old".
    if (-not $FullPath.StartsWith($RootFull, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $FullPath -PathType Leaf)) {
        Send-WebResponse -Response $Response -StatusCode 404 -Bytes ([System.Text.Encoding]::UTF8.GetBytes("Not found"))
        return
    }

    $Ext = [System.IO.Path]::GetExtension($FullPath).ToLowerInvariant()
    $CType = if ($script:ContentTypes.ContainsKey($Ext)) { $script:ContentTypes[$Ext] } else { "application/octet-stream" }
    Send-WebResponse -Response $Response -StatusCode 200 -Bytes ([System.IO.File]::ReadAllBytes($FullPath)) -ContentType $CType
}

# Serves the ONE portable single-file visualizer bundle instead of Invoke-StaticFile's
# whole-directory serving. Only "/" and "/Network_Visualizer.html" resolve - the bundle has
# no external .js/.css/image files, so nothing else is ever requested. Never falls through
# to $VisualizerRoot, or single-file mode would silently widen back to serving the whole tree.
function Invoke-SingleFileVisualizer {
    param($Response, [string]$AbsolutePath, [string]$SingleFileVisualizerPath)

    if ($AbsolutePath -ne "/" -and $AbsolutePath -ne "/Network_Visualizer.html") {
        Send-WebResponse -Response $Response -StatusCode 404 -Bytes ([System.Text.Encoding]::UTF8.GetBytes("Not found"))
        return
    }
    Send-WebResponse -Response $Response -StatusCode 200 -Bytes ([System.IO.File]::ReadAllBytes($SingleFileVisualizerPath)) -ContentType "text/html; charset=utf-8"
}

# Starts the listener, opens the default browser to it, then blocks serving requests one
# at a time (single local analyst, not a shared service) until Ctrl+C.
function Start-MapperWebServer {
    param(
        # Passed through so Invoke-SaveConfigAction writes plaintext Configuration.json
        # instead of requiring/using $EncryptionPassword.
        [switch]$NoEncryption,
        [Parameter(Mandatory=$true)][string]$VisualizerRoot,
        # Set only when Start-NetworkMapper.ps1 found a single-file bundle next to itself -
        # see Invoke-SingleFileVisualizer for why this takes over serving entirely.
        [AllowNull()][AllowEmptyString()][string]$SingleFileVisualizerPath,
        [Parameter(Mandatory=$true)][string]$ConnectScriptPath,
        [Parameter(Mandatory=$true)][string]$WorkerPath,
        [Parameter(Mandatory=$true)][string]$ConfigPath,
        # Empty/null is a legal VALUE (not "omit"): Start-NetworkMapper.ps1 passes $null on
        # the "continue without server-side credentials" path, meaning "no verified password
        # this session" - Invoke-SaveConfigAction then refuses to write the config file.
        # Keep AllowNull/AllowEmptyString, or that path dies at launch instead of serving
        # the viewer read-only.
        [Parameter(Mandatory=$true)][AllowNull()][AllowEmptyString()][string]$EncryptionPassword,
        [string]$JunosUsername = "",
        [string]$JunosPassword = "",
        [Parameter(Mandatory=$true)][int]$MaxConcurrent,
        [Parameter(Mandatory=$true)][string[]]$AllowedScopes,
        [Parameter(Mandatory=$true)][string]$SnapshotDir,
        [byte[]]$EncKey,
        [byte[]]$MacKey,
        [byte[]]$Salt,
        [int]$Iterations,
        [int]$Port = 8787,
        # Mapper_Debug.log. Optional - Write-MapperDebugLog is a no-op without it, so an
        # unwired caller just loses client-error logging rather than failing to start.
        [AllowNull()][AllowEmptyString()][string]$DebugLogPath
    )

    $Listener = [System.Net.HttpListener]::new()
    $Prefix = "http://localhost:$Port/"
    $Listener.Prefixes.Add($Prefix)

    try {
        $Listener.Start()
    } catch {
        throw "Could not bind $Prefix - is another instance already running? ($_)"
    }

    # Backs /api/rescan - single-slot, matching Invoke-RescanAction's "one in-flight scan" choice.
    $script:RescanPool = [runspacefactory]::CreateRunspacePool(1, 1)
    $script:RescanPool.Open()
    $script:PendingScan = $null
    $script:OrphanedScans = [System.Collections.Generic.List[object]]::new()
    $script:PendingScanNetwork = $null
    # -JunosUsername/-JunosPassword are only the seed (decrypted once at startup).
    # Script-scoped so Invoke-SaveConfigAction can update them live when credentials are
    # saved from the Settings tab, without requiring a process restart.
    $script:JunosUsername = $JunosUsername
    $script:JunosPassword = $JunosPassword
    $script:DebugLogPath = $DebugLogPath

    # Detect the host that launched this process (pwsh.exe vs powershell.exe) so
    # Invoke-ConnectAction's SSH launch uses the same runtime rather than a hardcoded
    # literal that may not exist. try/catch + the default param are a last-resort fallback.
    $PowerShellExePath = try { [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName } catch { $null }
    if ([string]::IsNullOrWhiteSpace($PowerShellExePath)) { $PowerShellExePath = "powershell.exe" }

    Write-Host "`nWeb UI listening on $Prefix (localhost only - Ctrl+C to stop)" -ForegroundColor Cyan
    Start-Process $Prefix

    # Console progress for browser-triggered scans: Invoke-ScanNetworkAction runs the crawl
    # in a background runspace, so FleetCrawl.ps1's Write-Host never reaches this console
    # otherwise. Piggybacks on the 250ms accept-loop tick below.
    $script:ScanProgressSnapshot = $null
    try {
        while ($Listener.IsListening) {
            # BeginGetContext/WaitOne(250) instead of a blocking GetContext(): a blocking
            # call gives the engine no statement boundary to act on, so Ctrl+C is ignored.
            # Polling on a timeout hands control back every 250ms, making Ctrl+C work.
            #
            # This accept machinery (as opposed to the per-request dispatch below, which has
            # its own try/catch) used to run bare: an HttpListenerException here - e.g. a
            # transient EndGetContext failure - fell all the way out of this function
            # uncaught, silently killing the whole server process with nothing written to
            # Mapper_Debug.log and the browser just reporting "Lost connection to the local
            # server". Log and retry instead of dying.
            try {
                $AsyncResult = $Listener.BeginGetContext($null, $null)
                while (-not $AsyncResult.AsyncWaitHandle.WaitOne(250)) {
                    if ($script:PendingScanNetwork) {
                        $Progress = $script:PendingScanNetwork.ProgressTable
                        if ($Progress.Done) {
                            if ($script:ScanProgressSnapshot -ne 'done') {
                                Write-Host "`r[Scan] Complete - $($Progress.Visited) device(s) visited.                        " -ForegroundColor Green
                                $script:ScanProgressSnapshot = 'done'
                            }
                        } else {
                            $Snapshot = "$($Progress.Visited)|$($Progress.QueueDepth)|$($Progress.ActiveJobs)"
                            if ($Snapshot -ne $script:ScanProgressSnapshot) {
                                Write-Host "`r[Scan] Visited: $($Progress.Visited)  Queue: $($Progress.QueueDepth)  Active: $($Progress.ActiveJobs)    " -NoNewline -ForegroundColor Cyan
                                $script:ScanProgressSnapshot = $Snapshot
                            }
                        }
                    } elseif ($script:ScanProgressSnapshot) {
                        $script:ScanProgressSnapshot = $null
                    }
                }
                $Context = $Listener.EndGetContext($AsyncResult)
            } catch {
                Write-MapperDebugLog "ACCEPT LOOP ERROR: $_"
                Write-Host "`nAccept loop error (logged to Mapper_Debug.log): $_" -ForegroundColor Red
                # Guards against a tight CPU-spinning retry loop if the listener is failing
                # every call (e.g. IsListening hasn't flipped false yet but the underlying
                # socket is already dead) - a real per-request hiccup only costs 250ms.
                Start-Sleep -Milliseconds 250
                continue
            }
            $Request = $Context.Request
            $Response = $Context.Response

            try {
                if ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/connect") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused" }
                    } else {
                        $Body = Read-WebRequestBody -Request $Request
                        Invoke-ConnectAction -Response $Response -Body $Body -ConnectScriptPath $ConnectScriptPath -JunosUsername $script:JunosUsername -JunosPassword $script:JunosPassword -PowerShellExePath $PowerShellExePath
                    }
                } elseif ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/rescan") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused" }
                    } else {
                        $Body = Read-WebRequestBody -Request $Request
                        Invoke-RescanAction -Response $Response -Body $Body -WorkerPath $WorkerPath -JunosUsername $script:JunosUsername -JunosPassword $script:JunosPassword
                    }
                } elseif ($Request.HttpMethod -eq "GET" -and $Request.Url.AbsolutePath -eq "/api/rescan/status") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused" }
                    } else {
                        $JobId = Get-QueryParam -Query $Request.Url.Query -Name "jobId"
                        Invoke-RescanStatusAction -Response $Response -JobId $JobId
                    }
                } elseif ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/ping") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused" }
                    } else {
                        $Body = Read-WebRequestBody -Request $Request
                        Invoke-PingAction -Response $Response -Body $Body
                    }
                } elseif ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/client-error") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused" }
                    } else {
                        $Body = Read-WebRequestBody -Request $Request
                        Invoke-ClientErrorAction -Response $Response -Body $Body
                    }
                } elseif ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/scan-network") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused" }
                    } else {
                        $Body = Read-WebRequestBody -Request $Request
                        Invoke-ScanNetworkAction -Response $Response -Body $Body -WorkerPath $WorkerPath -JunosUsername $script:JunosUsername -JunosPassword $script:JunosPassword -MaxConcurrent $MaxConcurrent -AllowedScopes $AllowedScopes -SnapshotDir $SnapshotDir -EncKey $EncKey -MacKey $MacKey -Salt $Salt -Iterations $Iterations
                    }
                } elseif ($Request.HttpMethod -eq "GET" -and $Request.Url.AbsolutePath -eq "/api/scan-network/status") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused" }
                    } else {
                        Invoke-ScanNetworkStatusAction -Response $Response
                    }
                } elseif ($Request.HttpMethod -eq "GET" -and $Request.Url.AbsolutePath -eq "/api/config") {
                    Invoke-GetConfigAction -Response $Response -ConfigPath $ConfigPath
                } elseif ($Request.HttpMethod -eq "GET" -and $Request.Url.AbsolutePath -eq "/api/session-password") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused" }
                    } else {
                        Invoke-GetSessionPasswordAction -Response $Response -EncryptionPassword $EncryptionPassword
                    }
                } elseif ($Request.HttpMethod -eq "GET" -and $Request.Url.AbsolutePath -eq "/api/snapshots") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused" }
                    } else {
                        Invoke-GetSnapshotsAction -Response $Response -SnapshotDir $SnapshotDir
                    }
                } elseif ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/save-config") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused" }
                    } else {
                        $Body = Read-WebRequestBody -Request $Request
                        Invoke-SaveConfigAction -Response $Response -Body $Body -ConfigPath $ConfigPath -EncryptionPassword $EncryptionPassword -NoEncryption:$NoEncryption
                    }
                } elseif ($SingleFileVisualizerPath) {
                    Invoke-SingleFileVisualizer -Response $Response -AbsolutePath $Request.Url.AbsolutePath -SingleFileVisualizerPath $SingleFileVisualizerPath
                } else {
                    Invoke-StaticFile -Response $Response -AbsolutePath $Request.Url.AbsolutePath -VisualizerRoot $VisualizerRoot
                }
            } catch {
                Write-MapperDebugLog "UNHANDLED REQUEST ERROR [$($Request.HttpMethod) $($Request.Url.AbsolutePath)] $_"
                try { Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Server error: $_" } } catch {}
            }
        }
    } finally {
        $Listener.Stop()
        $Listener.Close()
        if ($script:PendingScan) { try { $script:PendingScan.PS.Stop() } catch {}; $script:PendingScan.PS.Dispose() }
        foreach ($Orphan in $script:OrphanedScans) { try { $Orphan.PS.Stop() } catch {}; $Orphan.PS.Dispose() }
        # .Collected means Invoke-ScanNetworkStatusAction already disposed this job -
        # avoid double-disposing PS/Runspace.
        if ($script:PendingScanNetwork -and -not $script:PendingScanNetwork.Collected) {
            try { $script:PendingScanNetwork.PS.Stop() } catch {}
            try { $script:PendingScanNetwork.PS.Dispose() } catch {}
            try { $script:PendingScanNetwork.Runspace.Dispose() } catch {}
        }
        $script:RescanPool.Close()
        $script:RescanPool.Dispose()
    }
}

# HttpListener-based local webserver for Network_Visualizer. Binds "localhost" specifically
# (no netsh urlacl/admin needed) and runs unauthenticated: the sensitive action it can
# trigger is an SSH session using in-memory switch credentials, safe only while caller and
# process owner are the same person - untrue the moment this is rebound to a LAN address.
#
# Not run directly - dot-source it, then call Start-MapperWebServer.

# Dot-sourced here rather than relying on caller load order.
. (Join-Path $PSScriptRoot "TopologyCrypto.ps1")
. (Join-Path $PSScriptRoot "SshHelpers.ps1")
. (Join-Path $PSScriptRoot "FileHelpers.ps1")
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
    try {
        $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
    } finally {
        # A client that disconnected mid-write makes Close() throw too; that must not mask
        # the original Write failure (or fake one when Write succeeded).
        try { $Response.OutputStream.Close() } catch {}
    }
}

function Send-WebJson {
    param($Response, [int]$StatusCode, [hashtable]$Object, [int]$Depth = 10)
    try {
        $Json = $Object | ConvertTo-Json -Depth $Depth -Compress
    } catch {
        # Must not fall through to Start-MapperWebServer's plain-text 500: every client
        # caller does .json() on every response regardless of status, so a non-JSON body
        # is a guaranteed parse failure that discards the real error.
        $ErrJson = @{ error = "Server failed to serialize response: $_" } | ConvertTo-Json -Compress
        Send-WebResponse -Response $Response -StatusCode 500 -Bytes ([System.Text.Encoding]::UTF8.GetBytes($ErrJson)) -ContentType "application/json; charset=utf-8"
        return
    }
    Send-WebResponse -Response $Response -StatusCode $StatusCode -Bytes ([System.Text.Encoding]::UTF8.GetBytes($Json)) -ContentType "application/json; charset=utf-8"
}

# Truncate-at-size, not real rotation: a single local analyst only needs the log of this
# long-running process not to grow without bound.
$script:DebugLogMaxBytes = 10MB

# Mapper_Debug.log - the same file Invoke-FleetCrawl's Write-DebugLogLocal writes crawl
# activity to (set once via $script:DebugLogPath in Start-MapperWebServer).
function Write-MapperDebugLog {
    param([string]$Message)
    if (-not $script:DebugLogPath) { return }
    # Best-effort throughout: a full disk, a locked file, or a Get-Item racing a concurrent
    # Invoke-FleetCrawl -Force truncation must not block the append or take down the caller.
    # -Encoding utf8 explicit, or a mixed-encoding file causes CJK mojibake in text editors.
    try {
        $ExistingFile = Get-Item -LiteralPath $script:DebugLogPath -ErrorAction SilentlyContinue
        if ($ExistingFile -and $ExistingFile.Length -gt $script:DebugLogMaxBytes) {
            "=== Mapper_Debug.log truncated at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') (exceeded $($script:DebugLogMaxBytes) bytes) ===" | Out-File -FilePath $script:DebugLogPath -Encoding utf8
        }
        "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" | Out-File -FilePath $script:DebugLogPath -Append -Encoding utf8
    } catch {}
}

# Caps unbounded client-controlled text hitting the log, like Get-JunosNodeData.ps1's
# 500-char $ErrSummary - larger here because a JS stack trace legitimately runs longer.
$script:ClientErrorFieldMaxLength = 4000

# Server-side throttle for /api/client-error: utils.js's reportedClientErrors Set dedupes
# only on the CLIENT, so a modified client could flood the log. One global counter/window
# suffices here (localhost-only, single analyst). Normal usage is a few errors per load.
$script:ClientErrorRateLimitMax = 50
$script:ClientErrorRateLimitWindowSeconds = 60
$script:ClientErrorRateLimitCount = 0
$script:ClientErrorRateLimitWindowStart = Get-Date

# Neutralizes a client-supplied log field: CR/LF become visible escapes (content stays
# readable but can't forge a second "[timestamp] ..." entry) and the value is truncated.
function ConvertTo-SafeLogField {
    param([string]$Text, [int]$MaxLength = $script:ClientErrorFieldMaxLength)
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $Safe = $Text -replace "`r`n", '\r\n' -replace "`r", '\r' -replace "`n", '\n'
    if ($Safe.Length -gt $MaxLength) { $Safe = $Safe.Substring(0, $MaxLength) + "...(truncated)" }
    return $Safe
}

# Forwards browser errors (window.reportClientError) into Mapper_Debug.log so both sides of
# a failed scan land in one place. Tolerant of a bad body - a log sink must not throw.
function Invoke-ClientErrorAction {
    param($Response, [string]$Body)

    # Responds 200 even when throttled: this is a fire-and-forget sink from the browser's
    # perspective (utils.js), so a dropped report shouldn't surface as a visible failure.
    $Now = Get-Date
    if (($Now - $script:ClientErrorRateLimitWindowStart).TotalSeconds -ge $script:ClientErrorRateLimitWindowSeconds) {
        $script:ClientErrorRateLimitWindowStart = $Now
        $script:ClientErrorRateLimitCount = 0
    }
    $script:ClientErrorRateLimitCount++
    if ($script:ClientErrorRateLimitCount -gt $script:ClientErrorRateLimitMax) {
        # Once per window only, or the throttle notice becomes the flood it prevents.
        if ($script:ClientErrorRateLimitCount -eq $script:ClientErrorRateLimitMax + 1) {
            Write-MapperDebugLog "CLIENT ERROR RATE LIMIT: exceeded $script:ClientErrorRateLimitMax reports in $($script:ClientErrorRateLimitWindowSeconds)s - dropping further reports until the window resets."
        }
        Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "logged" }
        return
    }

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}

    $MessageText = if ($Parsed -and $Parsed.message) { [string]$Parsed.message } else { "(no message)" }
    $SourceText = if ($Parsed -and $Parsed.source) { [string]$Parsed.source } else { "unknown" }
    $UrlText = if ($Parsed -and $Parsed.url) { [string]$Parsed.url } else { "" }
    $StackText = if ($Parsed -and $Parsed.stack) { [string]$Parsed.stack } else { "" }

    # These three compose the single HeaderLine below, so a smuggled CR/LF would fabricate
    # what looks like a separate timestamped entry.
    $MessageText = ConvertTo-SafeLogField $MessageText
    $SourceText = ConvertTo-SafeLogField $SourceText
    $UrlText = ConvertTo-SafeLogField $UrlText

    $HeaderLine = "CLIENT ERROR [$SourceText] $MessageText"
    if ($UrlText) { $HeaderLine += " (at $UrlText)" }
    Write-MapperDebugLog $HeaderLine
    if ($StackText) {
        # Split below so each line gets its own real "[timestamp]    " prefix, so a stack
        # can't forge an entry - only length-cap it, leave its newline structure alone.
        if ($StackText.Length -gt $script:ClientErrorFieldMaxLength) {
            $StackText = $StackText.Substring(0, $script:ClientErrorFieldMaxLength) + "...(truncated)"
        }
        foreach ($StackLine in ($StackText -split "`n")) {
            # TrimEnd() only strips a trailing `r; a lone mid-line `r would survive and, on
            # playback, return the cursor to overwrite the real timestamp prefix - the same
            # forged-entry effect, so escape it to a literal.
            Write-MapperDebugLog "    $($StackLine.Replace("`r", '\r').TrimEnd())"
        }
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

# CSRF/DNS-rebinding guard for every endpoint that changes state or returns something
# sensitive. Localhost binding only proves the caller runs as this user, not that it's our
# page - a rebound-DNS fetch or cross-origin form still looks same-machine. Origin (Referer
# as fallback) is browser-set and unforgeable by page JS; fail closed if neither is present.
# Does NOT stop a hostile process on this machine talking to the listener directly.
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
# credential file). Deliberately narrow: fixed script, no free-form command surface, and
# $TargetIP is regex-locked to IPv4 shape so it carries no shell metacharacters.
function Invoke-ConnectAction {
    param($Response, [string]$Body, [string]$ConnectScriptPath, [string]$JunosUsername, [string]$JunosPassword, [string]$PowerShellExePath = "powershell.exe", [string[]]$AllowedScopes)

    if ([string]::IsNullOrWhiteSpace($JunosUsername) -or [string]::IsNullOrWhiteSpace($JunosPassword)) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "No Juniper login configured - set it in the Settings tab, then try again." }
        return
    }

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    $TargetIP = if ($Parsed) { [string]$Parsed.ip } else { $null }

    if (-not $TargetIP -or $TargetIP -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\z') {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Invalid or missing IP address" }
        return
    }

    # Crawl-discovered neighbors are scope-checked in FleetCrawl.ps1; a manually-supplied
    # target must clear the same fence, or a typo'd IP reaches an SSH login with saved
    # credentials. (Same check guards /api/rescan and /api/scan-network below.)
    if (-not (Test-IpInAllowedScopes -IP $TargetIP -AllowedScopes $AllowedScopes)) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "IP is outside the configured AllowedScopes ($($AllowedScopes -join ', '))" }
        return
    }

    # Declared outside the try so the catch can see it: the plaintext %TEMP% credential file
    # is normally removed by Connect-Switch.ps1's own finally block once it reads it.
    $CredFile = $null
    try {
        $CredFile = New-JunosCredentialFile -Username $JunosUsername -Password $JunosPassword
        $ArgString = @("-NoExit", "-File", "`"$ConnectScriptPath`"", "-TargetIP", $TargetIP, "-CredentialFile", "`"$CredFile`"") -join ' '
        Start-Process -FilePath $PowerShellExePath -ArgumentList $ArgString | Out-Null
        Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "launched"; ip = $TargetIP }
    } catch {
        # Launch failed before Connect-Switch.ps1 could clean up its own credential file.
        if ($CredFile) { Remove-JunosCredentialFile -CredentialFile $CredFile }
        Write-MapperDebugLog "CONNECT ERROR [$TargetIP] Failed to launch SSH session: $_"
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to launch SSH session: $_" }
    }
}

# Re-scans a single device without a full fleet crawl. Async because a scan can take ~50s
# and the accept loop serves one request at a time; polled via Invoke-RescanStatusAction.
# One rescan at a time is hygiene, not a security boundary (/api/connect already gives SSH).
function Invoke-RescanAction {
    param($Response, [string]$Body, [string]$WorkerPath, [string]$JunosUsername, [string]$JunosPassword, [string[]]$AllowedScopes)

    if ([string]::IsNullOrWhiteSpace($JunosUsername) -or [string]::IsNullOrWhiteSpace($JunosPassword)) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "No Juniper login configured - set it in the Settings tab, then try again." }
        return
    }

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    $TargetIP = if ($Parsed) { [string]$Parsed.ip } else { $null }

    if (-not $TargetIP -or $TargetIP -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\z') {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Invalid or missing IP address" }
        return
    }

    # Scope fence - see Invoke-ConnectAction.
    if (-not (Test-IpInAllowedScopes -IP $TargetIP -AllowedScopes $AllowedScopes)) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "IP is outside the configured AllowedScopes ($($AllowedScopes -join ', '))" }
        return
    }

    # Reap any previously-timed-out job that has since finished (Invoke-RescanStatusAction
    # explains why a timed-out job isn't force-stopped).
    for ($i = $script:OrphanedScans.Count - 1; $i -ge 0; $i--) {
        $Orphan = $script:OrphanedScans[$i]
        if ($Orphan.Handle.IsCompleted) {
            try {
                $Orphan.PS.EndInvoke($Orphan.Handle) | Out-Null
                Write-MapperDebugLog "RESCAN ORPHAN [$($Orphan.IP)] Job completed after client timeout (result discarded)"
            } catch {
                Write-MapperDebugLog "RESCAN ORPHAN [$($Orphan.IP)] Job completed after client timeout but failed: $_"
            }
            # Unguarded Dispose() would skip RemoveAt on throw, wedging this slot until restart.
            try { $Orphan.PS.Dispose() } catch {}
            # Get-JunosNodeData.ps1 spawns ssh.exe via cmd.exe from this process; PS.Dispose()
            # doesn't touch that OS-level grandchild (see Stop-JunosOrphanProcessesLocal).
            Stop-JunosOrphanProcessesLocal -TargetIP $Orphan.IP -SinceTime $Orphan.StartTime.AddSeconds(-2) -DebugLogPath $script:DebugLogPath
            $script:OrphanedScans.RemoveAt($i)
        }
    }

    # A rescan whose result the browser never polled (drawer closed, page reload) would hold
    # the slot forever, 409-ing every future rescan. Collected=true means the status action
    # already EndInvoke'd/Disposed it - just clear the slot; a second EndInvoke throws.
    if ($script:PendingScan -and $script:PendingScan.Handle.IsCompleted) {
        $Finished = $script:PendingScan
        if (-not $Finished.Collected) {
            try {
                $Finished.PS.EndInvoke($Finished.Handle) | Out-Null
                Write-MapperDebugLog "RESCAN ORPHAN [$($Finished.IP)] Job completed after client abandoned poll (result discarded)"
            } catch {
                Write-MapperDebugLog "RESCAN ORPHAN [$($Finished.IP)] Job completed after client abandoned poll but failed: $_"
            }
            try { $Finished.PS.Dispose() } catch {}
            Stop-JunosOrphanProcessesLocal -TargetIP $Finished.IP -SinceTime $Finished.StartTime.AddSeconds(-2) -DebugLogPath $script:DebugLogPath
        }
        $script:PendingScan = $null
    }

    if ($script:PendingScan) {
        Send-WebJson -Response $Response -StatusCode 409 -Object @{
            error = "A rescan is already in progress"; jobId = $script:PendingScan.JobId; ip = $script:PendingScan.IP
        }
        return
    }

    # Never -HumanReadable (it ends in `exit`, killing this runspace) and never -Log (a clean
    # ad-hoc rescan has no reason to write RawDumps/; failure paths in Get-JunosNodeData.ps1
    # dump unconditionally anyway). -DebugLogPath IS passed so a failed login/scan survives in
    # Mapper_Debug.log even if the browser never polls for the result.
    $JobId = [guid]::NewGuid().ToString()
    $PS = [powershell]::Create().AddCommand($WorkerPath).AddParameter("TargetIP", $TargetIP).AddParameter("Username", $JunosUsername).AddParameter("Password", $JunosPassword)
    if ($script:DebugLogPath) { $PS.AddParameter("DebugLogPath", $script:DebugLogPath) | Out-Null }
    $PS.RunspacePool = $script:RescanPool
    # Nothing else references $PS until BeginInvoke succeeds, so a throw here leaks it.
    try {
        $Handle = $PS.BeginInvoke()
    } catch {
        $PS.Dispose()
        throw
    }

    # Collected/Outcome: set on first completion so later polls get the same result.
    $script:PendingScan = [PSCustomObject]@{ PS = $PS; Handle = $Handle; IP = $TargetIP; JobId = $JobId; StartTime = (Get-Date); Collected = $false; Outcome = $null }
    Send-WebJson -Response $Response -StatusCode 202 -Object @{ status = "started"; jobId = $JobId; ip = $TargetIP }
}

# Quick reachability check. Async for the same reason as Invoke-RescanAction: 4 pings at 2s
# can take ~8s against a dead device, stalling every other request on the accept loop.
function Invoke-PingAction {
    param($Response, [string]$Body)

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    $TargetIP = if ($Parsed) { [string]$Parsed.ip } else { $null }

    # Strict dotted-quad - stops this becoming a generic "resolve and probe anything" endpoint.
    if (-not $TargetIP -or $TargetIP -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\z') {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Invalid or missing IP address" }
        return
    }

    # Reap a previously-timed-out job that has since finished.
    for ($i = $script:OrphanedPings.Count - 1; $i -ge 0; $i--) {
        $Orphan = $script:OrphanedPings[$i]
        if ($Orphan.Handle.IsCompleted) {
            try {
                $Orphan.PS.EndInvoke($Orphan.Handle) | Out-Null
                Write-MapperDebugLog "PING ORPHAN [$($Orphan.IP)] Job completed after client timeout (result discarded)"
            } catch {
                Write-MapperDebugLog "PING ORPHAN [$($Orphan.IP)] Job completed after client timeout but failed: $_"
            }
            try { $Orphan.PS.Dispose() } catch {}
            $script:OrphanedPings.RemoveAt($i)
        }
    }

    # Same abandoned-poll reap as Invoke-RescanAction.
    if ($script:PendingPing -and $script:PendingPing.Handle.IsCompleted) {
        $Finished = $script:PendingPing
        if (-not $Finished.Collected) {
            try {
                $Finished.PS.EndInvoke($Finished.Handle) | Out-Null
                Write-MapperDebugLog "PING ORPHAN [$($Finished.IP)] Job completed after client abandoned poll (result discarded)"
            } catch {
                Write-MapperDebugLog "PING ORPHAN [$($Finished.IP)] Job completed after client abandoned poll but failed: $_"
            }
            try { $Finished.PS.Dispose() } catch {}
        }
        $script:PendingPing = $null
    }

    if ($script:PendingPing) {
        Send-WebJson -Response $Response -StatusCode 409 -Object @{
            error = "A ping is already in progress"; jobId = $script:PendingPing.JobId; ip = $script:PendingPing.IP
        }
        return
    }

    $JobId = [guid]::NewGuid().ToString()
    $PS = [powershell]::Create().AddScript({
        param($TargetIP)
        try {
            # -Quiet avoided (no latency/loss detail). Parameter set and failure shape differ
            # by generation: PS 7+ returns one object per ping including timeouts, so it must
            # filter on Status -eq 'Success' or a dead device reports 4/4 replies. PS 5.1
            # returns only successes as objects (failures go to the error stream), and
            # -ErrorAction Stop there would discard earlier successes on the first failure.
            if ($PSVersionTable.PSVersion.Major -ge 6) {
                $AllResults = Test-Connection -TargetName $TargetIP -Count 4 -TimeoutSeconds 2 -ErrorAction SilentlyContinue
                $Results = @($AllResults | Where-Object { $_.Status -eq 'Success' })
            } else {
                $Results = @(Test-Connection -ComputerName $TargetIP -Count 4 -ErrorAction SilentlyContinue)
            }
        } catch {
            # Zero replies, not a failure - an unreachable device is an expected result.
            $Results = @()
        }

        $ReplyCount = $Results.Count
        $Latencies = @($Results | ForEach-Object {
            if ($null -ne $_.PSObject.Properties['Latency']) { $_.Latency }
            elseif ($null -ne $_.PSObject.Properties['ResponseTime']) { $_.ResponseTime }
        } | Where-Object { $null -ne $_ })

        $AvgLatency = if ($Latencies.Count -gt 0) { [math]::Round(($Latencies | Measure-Object -Average).Average, 1) } else { $null }

        [PSCustomObject]@{ ReplyCount = $ReplyCount; AvgLatency = $AvgLatency }
    }).AddArgument($TargetIP)
    $PS.RunspacePool = $script:PingPool
    # Nothing else references $PS until BeginInvoke succeeds, so a throw here leaks it.
    try {
        $Handle = $PS.BeginInvoke()
    } catch {
        $PS.Dispose()
        throw
    }

    # Collected/Outcome: set on first completion so later polls get the same result.
    $script:PendingPing = [PSCustomObject]@{ PS = $PS; Handle = $Handle; IP = $TargetIP; JobId = $JobId; StartTime = (Get-Date); Collected = $false; Outcome = $null }
    Send-WebJson -Response $Response -StatusCode 202 -Object @{ status = "started"; jobId = $JobId; ip = $TargetIP }
}

# Polled by the browser every ~1-2s while a ping is outstanding. Response shape mirrors
# Invoke-RescanStatusAction: {status:"running"|"timeout"|"complete", ...}; on "complete",
# ok distinguishes a successful probe from a job that errored out.
function Invoke-PingStatusAction {
    param($Response, [string]$JobId)

    if (-not $JobId -or -not $script:PendingPing -or $script:PendingPing.JobId -ne $JobId) {
        Send-WebJson -Response $Response -StatusCode 404 -Object @{ error = "Unknown or expired job id" }
        return
    }

    $Job = $script:PendingPing

    if ($Job.Handle.IsCompleted) {
        # Collect exactly once and cache the outcome: EndInvoke throws if called twice, and a
        # client disconnect mid-write must not lose the result (the next poll re-serves it).
        if (-not $Job.Collected) {
            try {
                $Result = $Job.PS.EndInvoke($Job.Handle)

                # Non-terminating worker errors don't fail EndInvoke and surface nowhere else.
                if ($Job.PS.HadErrors) {
                    foreach ($ErrRecord in $Job.PS.Streams.Error) {
                        Write-MapperDebugLog "PING ERROR STREAM [$($Job.IP)] $ErrRecord"
                    }
                }
                if ($Job.PS.Streams.Warning.Count -gt 0) {
                    foreach ($WarnRecord in $Job.PS.Streams.Warning) {
                        Write-MapperDebugLog "PING WARNING STREAM [$($Job.IP)] $WarnRecord"
                    }
                }

                # Index explicitly, matching how EndInvoke results are unwrapped elsewhere in
                # this file (see Invoke-ScanNetworkStatusAction for where it actually matters).
                $Payload = if ($Result -and $Result.Count -gt 0) { $Result[0] } else { $null }
                $ReplyCount = if ($Payload) { $Payload.ReplyCount } else { 0 }
                $AvgLatency = if ($Payload) { $Payload.AvgLatency } else { $null }

                $Job.Outcome = @{
                    status = "complete"; ok = $true; ip = $Job.IP
                    alive = ($ReplyCount -gt 0); sent = 4; received = $ReplyCount; avgLatencyMs = $AvgLatency
                }
            } catch {
                $Job.Outcome = @{ status = "complete"; ok = $false; ip = $Job.IP; reason = "Ping failed: $_" }
            }
            try { $Job.PS.Dispose() } catch {}
            $Job.Collected = $true
        }

        Send-WebJson -Response $Response -StatusCode 200 -Object $Job.Outcome
        return
    }

    $Elapsed = ((Get-Date) - $Job.StartTime).TotalSeconds
    if ($Elapsed -gt 20) {
        # Not force-stopped: .Stop() can't interrupt a pipeline blocked in a synchronous
        # native ping. This frees only the HTTP-facing slot; $Job.PS keeps a $script:PingPool
        # runspace until it finishes, which is why that pool has spare capacity.
        $script:OrphanedPings.Add($Job)
        $script:PendingPing = $null
        Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "timeout"; ip = $Job.IP; elapsedSeconds = [math]::Round($Elapsed) }
        return
    }

    Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "running"; ip = $Job.IP; elapsedSeconds = [math]::Round($Elapsed) }
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
        # Collect exactly once and cache the outcome - EndInvoke throws if called twice.
        if (-not $Job.Collected) {
            try {
                $Result = $Job.PS.EndInvoke($Job.Handle)

                # Non-terminating worker errors don't fail EndInvoke and surface nowhere else.
                if ($Job.PS.HadErrors) {
                    foreach ($ErrRecord in $Job.PS.Streams.Error) {
                        Write-MapperDebugLog "RESCAN ERROR STREAM [$($Job.IP)] $ErrRecord"
                    }
                }
                if ($Job.PS.Streams.Warning.Count -gt 0) {
                    foreach ($WarnRecord in $Job.PS.Streams.Warning) {
                        Write-MapperDebugLog "RESCAN WARNING STREAM [$($Job.IP)] $WarnRecord"
                    }
                }

                # Success/failure decided here from Get-JunosNodeData.ps1's CRITICAL log-line
                # signal, not inferred by the browser. ok:false omits `node` entirely - a
                # failed scan's fields are placeholders and must not overwrite good data.
                $Logs = if ($Result -and $Result.Logs) { @($Result.Logs) } else { @() }
                $HasCritical = $false
                foreach ($LogLine in $Logs) { if ($LogLine -match 'CRITICAL') { $HasCritical = $true; break } }

                if (-not $Result -or -not $Result.Node -or $HasCritical) {
                    # Not replayed to the log here: the worker's -DebugLogPath already wrote
                    # these lines as they happened.
                    $Job.Outcome = @{
                        status = "complete"; ok = $false; ip = $Job.IP
                        reason = "Switch returned empty payload or scan failed - see logs"; logs = $Logs
                    }
                } else {
                    $Job.Outcome = @{ status = "complete"; ok = $true; ip = $Job.IP; node = $Result.Node; logs = $Logs }
                }
            } catch {
                $Job.Outcome = @{ status = "complete"; ok = $false; ip = $Job.IP; reason = "Scan failed: $_" }
                Write-MapperDebugLog "RESCAN [$($Job.IP)] Scan failed: $_"
            }
            try { $Job.PS.Dispose() } catch {}
            # Needed on clean completion too, not just the orphan paths: PS.Dispose() never
            # touches the ssh.exe/cmd.exe grandchildren.
            Stop-JunosOrphanProcessesLocal -TargetIP $Job.IP -SinceTime $Job.StartTime.AddSeconds(-2) -DebugLogPath $script:DebugLogPath
            $Job.Collected = $true
        }

        Send-WebJson -Response $Response -StatusCode 200 -Depth 20 -Object $Job.Outcome
        return
    }

    $Elapsed = ((Get-Date) - $Job.StartTime).TotalSeconds
    if ($Elapsed -gt 90) {
        # Not force-stopped: New-JunosAskPass's plaintext %TEMP% password file is removed only
        # by the worker's own finally block, which .Stop() on a pipeline blocked in
        # Process.WaitForExit may never reach. Free the HTTP-facing slot instead and let
        # Invoke-RescanAction reap it later; it holds a $script:RescanPool runspace until then.
        $script:OrphanedScans.Add($Job)
        $script:PendingScan = $null
        Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "timeout"; ip = $Job.IP; elapsedSeconds = [math]::Round($Elapsed) }
        return
    }

    Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "running"; ip = $Job.IP; elapsedSeconds = [math]::Round($Elapsed) }
}

# Kicks off a full fleet crawl asynchronously, same accept-loop reasoning as
# Invoke-RescanAction. Only one scan in flight; a second click gets a 409.
function Invoke-ScanNetworkAction {
    param($Response, [string]$Body, [string]$WorkerPath, [string]$JunosUsername, [string]$JunosPassword,
          [string]$MaxConcurrent, [string[]]$AllowedScopes, [string]$SnapshotDir,
          [byte[]]$EncKey, [byte[]]$MacKey, [byte[]]$Salt, [int]$Iterations)

    if ([string]::IsNullOrWhiteSpace($JunosUsername) -or [string]::IsNullOrWhiteSpace($JunosPassword)) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "No Juniper login configured - set it in the Settings tab, then try again." }
        return
    }

    # Reap a finished job first, or a scan the browser never polled (tab closed) 409s every
    # future click. Collected=true means PS/Runspace are already disposed.
    if ($script:PendingScanNetwork -and $script:PendingScanNetwork.Handle.IsCompleted) {
        $Finished = $script:PendingScanNetwork
        if (-not $Finished.Collected) {
            try {
                $Finished.PS.EndInvoke($Finished.Handle) | Out-Null
                Write-MapperDebugLog "SCAN-NETWORK ORPHAN [$($Finished.StartIP)] Job completed after client abandoned poll (result discarded)"
            } catch {
                Write-MapperDebugLog "SCAN-NETWORK ORPHAN [$($Finished.StartIP)] Job completed after client abandoned poll but failed: $_"
            }
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

    if (-not $StartIP -or $StartIP -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\z') {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Invalid or missing starting IP address" }
        return
    }

    # Scope fence - see Invoke-ConnectAction. The entry-point IP is reached before the crawl
    # applies any filtering of its own.
    if (-not (Test-IpInAllowedScopes -IP $StartIP -AllowedScopes $AllowedScopes)) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "IP is outside the configured AllowedScopes ($($AllowedScopes -join ', '))" }
        return
    }

    # Without this, Invoke-FleetCrawl's Write-DebugLogLocal is a no-op for web-triggered
    # scans. Overwritten per crawl, same as the CLI path.
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

    # A fresh runspace doesn't inherit Invoke-FleetCrawl's definition from this session.
    $InitialState = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
    $FleetCrawlPath = Join-Path $PSScriptRoot "FleetCrawl.ps1"
    $InitialState.StartupScripts.Add($FleetCrawlPath) | Out-Null
    $Runspace = [runspacefactory]::CreateRunspace($InitialState)
    # Nothing else references $PS/$Runspace until BeginInvoke succeeds, so a throw leaks them.
    try {
        $Runspace.Open()
        $PS.Runspace = $Runspace
        $Handle = $PS.BeginInvoke()
    } catch {
        $PS.Dispose()
        $Runspace.Dispose()
        throw
    }
    # Collected/Outcome: set on first completion so later polls get the same result.
    $script:PendingScanNetwork = [PSCustomObject]@{ PS = $PS; Runspace = $Runspace; Handle = $Handle; StartIP = $StartIP; StartTime = (Get-Date); ProgressTable = $ProgressTable; Collected = $false; Outcome = $null }
    Send-WebJson -Response $Response -StatusCode 202 -Object @{ status = "started"; startIp = $StartIP }
}

# Polled by the browser every ~2s. No timeout ceiling: a fleet crawl can legitimately run
# for many minutes. Returns the decrypted topology inline (already in memory) rather than
# writing it to disk and adding file-serving surface outside $VisualizerRoot.
function Invoke-ScanNetworkStatusAction {
    param($Response)

    if (-not $script:PendingScanNetwork) {
        Send-WebJson -Response $Response -StatusCode 404 -Object @{ error = "No scan is currently running or was ever started this session" }
        return
    }

    $Job = $script:PendingScanNetwork

    if ($Job.Handle.IsCompleted) {
        # Collect exactly once and cache the outcome - EndInvoke throws if called twice.
        if (-not $Job.Collected) {
            try {
                $Result = $Job.PS.EndInvoke($Job.Handle)

                # Non-terminating worker errors don't fail EndInvoke and surface nowhere else.
                if ($Job.PS.HadErrors) {
                    foreach ($ErrRecord in $Job.PS.Streams.Error) {
                        Write-MapperDebugLog "SCAN-NETWORK ERROR STREAM [$($Job.StartIP)] $ErrRecord"
                    }
                }
                if ($Job.PS.Streams.Warning.Count -gt 0) {
                    foreach ($WarnRecord in $Job.PS.Streams.Warning) {
                        Write-MapperDebugLog "SCAN-NETWORK WARNING STREAM [$($Job.StartIP)] $WarnRecord"
                    }
                }

                # Index explicitly rather than dotting into $Result: member enumeration on a
                # 1-item collection unwraps to a bare PSCustomObject for a single-device
                # crawl, breaking ConvertTo-Json's array shape and the browser's .forEach.
                $Payload = if ($Result -and $Result.Count -gt 0) { $Result[0] } else { $null }

                if (-not $Payload -or -not $Payload.Topology) {
                    $Job.Outcome = @{ status = "complete"; ok = $false; reason = "Scan produced no data - see server console/debug log" }
                } else {
                    # Deliberately NOT carrying $Payload.Topology. Invoke-FleetCrawl has already
                    # written it to $SnapshotDir under a name Invoke-GetSnapshotAction serves, so
                    # the client fetches it from there instead. Returning it inline meant every
                    # request to this endpoint re-serialized the whole fleet, and since the
                    # completed job is retained to be re-served idempotently, that cost was paid
                    # on every hit for the life of the process - including the unconditional poll
                    # the client makes on each page load. Same accept-loop stall as the snapshots
                    # endpoint. Keeping it out also frees the topology instead of pinning it in
                    # the server's heap.
                    $Job.Outcome = @{
                        status = "complete"; ok = $true
                        scanTimestamp = $Payload.ScanTimestampIso
                        outputFile = (Split-Path $Payload.OutputFile -Leaf); visitedCount = $Payload.VisitedCount
                    }
                    if ($Payload.Aborted) {
                        $Job.Outcome.aborted = [bool]$Payload.Aborted
                        $Job.Outcome.abortReason = $Payload.AbortReason
                    }
                }
            } catch {
                $Job.Outcome = @{ status = "complete"; ok = $false; reason = "Scan failed: $_" }
            }
            try { $Job.PS.Dispose() } catch {}
            try { $Job.Runspace.Dispose() } catch {}
            $Job.Collected = $true
        }

        Send-WebJson -Response $Response -StatusCode 200 -Object $Job.Outcome
        return
    }

    Send-WebJson -Response $Response -StatusCode 200 -Object @{
        status = "running"; startIp = $Job.StartIP
        elapsedSeconds = [math]::Round(((Get-Date) - $Job.StartTime).TotalSeconds)
        visited = $Job.ProgressTable.Visited; queueDepth = $Job.ProgressTable.QueueDepth; activeJobs = $Job.ProgressTable.ActiveJobs
    }
}

# Serves the Configuration.json.enc envelope as-is (the browser decrypts client-side). 404
# carries a JSON body so "no config yet" is distinguishable from an error. Bypasses
# Send-WebJson because -AsHashtable, which its [hashtable] param needs, is pwsh 6.0+ only.
function Invoke-GetConfigAction {
    param($Response, [string]$ConfigPath)

    if (-not (Test-Path $ConfigPath)) {
        Send-WebJson -Response $Response -StatusCode 404 -Object @{ error = "No configuration file yet" }
        return
    }

    try {
        # -Encoding UTF8 explicit: without it, Windows PowerShell 5.1 reads a BOM-less UTF-8
        # file (as written by pwsh 7+) using the system ANSI codepage, mangling non-ASCII.
        $Raw = Get-Content $ConfigPath -Raw -Encoding UTF8
        Send-WebResponse -Response $Response -StatusCode 200 -Bytes ([System.Text.Encoding]::UTF8.GetBytes($Raw)) -ContentType "application/json; charset=utf-8"
    } catch {
        Write-MapperDebugLog "GET-CONFIG ERROR [$ConfigPath] Failed to read configuration file: $_"
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to read configuration file: $_" }
    }
}

# Hands the browser the encryption password Start-NetworkMapper.ps1 prompted for at startup
# so it can decrypt Configuration.json.enc / NetworkMap_*.json.enc client-side without
# re-prompting - a deliberate exception to Invoke-SaveConfigAction's "the password never
# crosses the wire" posture. Same-origin-gated despite being a read-only GET: a leak here is
# silent and durable (decrypts every archived snapshot offline), so "no side effects" isn't
# enough. Returns "" (not null) when there's nothing to offer; the browser then prompts.
function Invoke-GetSessionPasswordAction {
    param($Response, [string]$EncryptionPassword)
    # This body is the plaintext password - keep it out of proxy and browser disk caches.
    $Response.Headers.Add("Cache-Control", "no-store")
    Send-WebJson -Response $Response -StatusCode 200 -Object @{ password = [string]$EncryptionPassword }
}

# Backs the browser's startup autoload (window.autoloadLastScan in app.js), listing archived
# snapshots without a file-picker gesture. Mirrors app.js forceLoadFolder's naming filter -
# a mid-crawl *.tmp.json(.enc) must not be picked up as finished.
function Invoke-GetSnapshotsAction {
    param($Response, [string]$SnapshotDir)

    if (-not (Test-Path $SnapshotDir)) {
        Send-WebJson -Response $Response -StatusCode 200 -Object @{ snapshots = @() }
        return
    }

    try {
        # Most-recent-first covers the use case (the latest, plus enough history for
        # cross-snapshot merging); older files stay on disk, just aren't offered here.
        $MaxSnapshots = 20
        $Files = Get-ChildItem -LiteralPath $SnapshotDir -File |
            Where-Object { $_.Name -match '^NetworkMap_.*\.json(\.enc)?$' -and $_.Name -notmatch '\.tmp\.json(\.enc)?$' } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First $MaxSnapshots

        # Names and sizes only; bodies are fetched one at a time from Invoke-GetSnapshotAction.
        # Inlining contents here would mean one ConvertTo-Json over the whole archive (~40MB at
        # this cap), which Windows PowerShell 5.1's JavaScriptSerializer takes minutes to do -
        # on the accept-loop thread, so the server would answer nothing at all meanwhile.
        $Snapshots = @($Files | ForEach-Object { @{ name = $_.Name; size = $_.Length } })

        Send-WebJson -Response $Response -StatusCode 200 -Object @{ snapshots = $Snapshots }
    } catch {
        Write-MapperDebugLog "GET-SNAPSHOTS ERROR [$SnapshotDir] Failed to list snapshot(s): $_"
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to list snapshot(s): $_" }
    }
}

# Serves ONE snapshot file, by name, from the listing above. Bytes verbatim, not wrapped in
# a JSON envelope: the file already IS the JSON document the client wants, and quoting it
# would re-introduce the serialization cost this split exists to avoid.
function Invoke-GetSnapshotAction {
    param($Response, [string]$SnapshotDir, [string]$Name)

    # Same filter the listing applies, so only a name it could have produced is served. \z
    # rather than $, which in PowerShell also matches before a trailing newline - that would
    # let "NetworkMap_x.json`n<anything>" through.
    if ([string]::IsNullOrWhiteSpace($Name) -or
        $Name -notmatch '^NetworkMap_.*\.json(\.enc)?\z' -or
        $Name -match '\.tmp\.json(\.enc)?\z') {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Invalid snapshot name" }
        return
    }

    # The regex is anchored but its .* still admits path separators and .. segments, so
    # confine the resolved path to $SnapshotDir rather than trusting the name's shape.
    try {
        $RootFull = [System.IO.Path]::GetFullPath($SnapshotDir)
        if (-not $RootFull.EndsWith([System.IO.Path]::DirectorySeparatorChar)) { $RootFull += [System.IO.Path]::DirectorySeparatorChar }
        $FullPath = [System.IO.Path]::GetFullPath((Join-Path $RootFull $Name))

        if (-not $FullPath.StartsWith($RootFull, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $FullPath -PathType Leaf)) {
            Send-WebJson -Response $Response -StatusCode 404 -Object @{ error = "Snapshot not found" }
            return
        }

        Send-WebResponse -Response $Response -StatusCode 200 -Bytes ([System.IO.File]::ReadAllBytes($FullPath)) -ContentType "application/json; charset=utf-8"
    } catch {
        Write-MapperDebugLog "GET-SNAPSHOT ERROR [$Name] Failed to read snapshot: $_"
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to read snapshot: $_" }
    }
}

# Encrypts and writes Configuration.json.enc. The browser sends PLAINTEXT config JSON - the
# encryption password never crosses in this request (Invoke-GetSessionPasswordAction is the
# one deliberate exception). Fresh salt/IV per save; saves are rare and interactive, so
# there's no reason to cache the derived key across calls.
function Invoke-SaveConfigAction {
    param($Response, [string]$Body, [string]$ConfigPath, [string]$EncryptionPassword, [switch]$NoEncryption)

    # Fail closed: $EncryptionPassword is blanked when startup decryption failed and the
    # operator continued anyway, and re-encrypting under it would silently lock every future
    # session out under an unrecorded password. Not applicable under -NoEncryption.
    if (-not $NoEncryption -and [string]::IsNullOrWhiteSpace($EncryptionPassword)) {
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "No working encryption password for this session - Configuration.json.enc could not be decrypted at startup, so saving is disabled to avoid rewriting the file under an unverified password. Restart Start-NetworkMapper.ps1 with the correct password." }
        return
    }

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    # Presence check, not truthiness: PowerShell treats an empty array as falsy, so
    # `-not $Parsed.devices` would reject a legitimate `devices: []` save.
    if (-not $Parsed -or $null -eq $Parsed.devices) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Request body must be JSON with a 'devices' array" }
        return
    }

    # $Username is interpolated unquoted into an ssh.exe/cmd.exe command line (Get-JunosSshArgs
    # -> Connect-Switch.ps1/Get-JunosNodeData.ps1), so a stray space or metacharacter is a
    # command-injection vector (e.g. `admin -oProxyCommand=calc.exe x`), not a cosmetic issue.
    # Locked to typical Junos login shape; empty string stays legal, since an explicit
    # {username:"", password:""} intentionally clears saved credentials.
    if ($Parsed.credentials) {
        $NewUsername = [string]$Parsed.credentials.username
        if ($NewUsername -and $NewUsername -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}\z') {
            Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Invalid username: must start with a letter or digit and contain only letters, digits, '.', '_', or '-'" }
            return
        }
    }

    try {
        if ($NoEncryption) {
            # Re-serialized rather than writing $Body raw, for consistent formatting. Atomic
            # (temp file + rename) because this is the operator's only copy of their device
            # list and credentials - a crash mid-write must not truncate it.
            Set-FileContentAtomic -DestinationPath $ConfigPath -Content ($Parsed | ConvertTo-Json -Depth 10) -Encoding utf8
            # Under -NoEncryption this file holds plaintext Junos credentials, and the atomic
            # rename leaves it with a newly-created file's default ACL on every save.
            Protect-JunosSensitiveFileAcl -Path $ConfigPath
        } else {
            $SaltBytes = [byte[]]::new(16)
            $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            $Rng.GetBytes($SaltBytes)
            $Rng.Dispose()

            # Shared with the crawl via TopologyCrypto.ps1 so the iteration count can't drift
            # between crawler and webserver.
            $Iterations = Get-TopologyPbkdf2Iterations
            $KeyMaterial = Get-TopologyKeyMaterial -Password $EncryptionPassword -Salt $SaltBytes -Iterations $Iterations
            $Envelope = Protect-TopologyPayload -PlainJson $Body -EncKey $KeyMaterial.EncKey -MacKey $KeyMaterial.MacKey -Salt $SaltBytes -Iterations $Iterations -Format "PSNetworkMapper-EncryptedConfig"

            # Atomic for the same reason as the branch above.
            Set-FileContentAtomic -DestinationPath $ConfigPath -Content ($Envelope | ConvertTo-Json -Depth 10) -Encoding utf8
        }

        # Push just-saved credentials into the live copies so the SSH endpoints pick them up
        # without a restart. Deliberately after the file write - a failed save must not update
        # them. Presence check, not truthiness: `credentials:null` (sent when nothing was
        # loaded) leaves them alone, while an explicit {username:"", password:""} clears them.
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

# Serves a file under $VisualizerRoot, defaulting "/" to index.html. Resolves to an absolute
# path and rejects anything landing outside the root (../ traversal, absolute-path requests)
# before touching disk.
function Invoke-StaticFile {
    param($Response, [string]$AbsolutePath, [string]$VisualizerRoot)

    $RelPath = $AbsolutePath.TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($RelPath)) { $RelPath = "index.html" }

    $RootFull = [System.IO.Path]::GetFullPath($VisualizerRoot)
    if (-not $RootFull.EndsWith([System.IO.Path]::DirectorySeparatorChar)) { $RootFull += [System.IO.Path]::DirectorySeparatorChar }
    $FullPath = [System.IO.Path]::GetFullPath((Join-Path $RootFull $RelPath))

    # The trailing separator makes this a path-prefix match rather than a string-prefix one -
    # otherwise "Network_Visualizer" would also accept "Network_Visualizer_old".
    if (-not $FullPath.StartsWith($RootFull, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $FullPath -PathType Leaf)) {
        Send-WebResponse -Response $Response -StatusCode 404 -Bytes ([System.Text.Encoding]::UTF8.GetBytes("Not found"))
        return
    }

    $Ext = [System.IO.Path]::GetExtension($FullPath).ToLowerInvariant()
    $CType = if ($script:ContentTypes.ContainsKey($Ext)) { $script:ContentTypes[$Ext] } else { "application/octet-stream" }
    Send-WebResponse -Response $Response -StatusCode 200 -Bytes ([System.IO.File]::ReadAllBytes($FullPath)) -ContentType $CType
}

# Serves the portable single-file visualizer bundle instead of Invoke-StaticFile's
# whole-directory serving. Only "/" and "/Network_Visualizer.html" resolve (the bundle has no
# external assets), and it never falls through to $VisualizerRoot - that would silently widen
# single-file mode back to serving the whole tree.
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
        # Set only when Start-NetworkMapper.ps1 found a single-file bundle next to itself.
        [AllowNull()][AllowEmptyString()][string]$SingleFileVisualizerPath,
        [Parameter(Mandatory=$true)][string]$ConnectScriptPath,
        [Parameter(Mandatory=$true)][string]$WorkerPath,
        [Parameter(Mandatory=$true)][string]$ConfigPath,
        # Empty/null is a legal VALUE (not "omit"): it means "no verified password this
        # session", after which Invoke-SaveConfigAction refuses to write. Without
        # AllowNull/AllowEmptyString that path dies at launch instead of serving read-only.
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
        # Mapper_Debug.log. Optional - Write-MapperDebugLog no-ops without it, so an unwired
        # caller loses logging rather than failing to start.
        [AllowNull()][AllowEmptyString()][string]$DebugLogPath
    )

    # Must precede anything that can fail below: Write-MapperDebugLog is a silent no-op until
    # this is set, so a bind or pool-setup failure would otherwise leave no trace.
    $script:DebugLogPath = $DebugLogPath

    $Listener = [System.Net.HttpListener]::new()
    $Prefix = "http://localhost:$Port/"
    $Listener.Prefixes.Add($Prefix)

    try {
        $Listener.Start()
    } catch {
        Write-MapperDebugLog "SERVER BIND FAILED [$Prefix] $_"
        throw "Could not bind $Prefix - is another instance already running? ($_)"
    }
    # Bookends the SERVER SHUTDOWN line in the finally below; together they are the only
    # record of when this process could actually serve requests, which is what separates a
    # browser-side "failed to fetch" from a request the server rejected.
    Write-MapperDebugLog "SERVER START listening on $Prefix (PID $PID)"

    # Both pools open before the main try/finally that would otherwise dispose them, so this
    # setup needs its own try/catch: a throw from the second .Open() would escape the function
    # leaving the already-Start()ed $Listener and the first pool leaked.
    #
    # Pools are sized 3, not 1, even though $script:PendingScan/$script:PendingPing already
    # 409-gate one job at a time: an orphaned job is never force-stopped (see the status
    # actions' timeout handling), so a truly hung one holds a runspace indefinitely. The spare
    # slots absorb that instead of wedging every later job behind the zombie.
    try {
        $script:RescanPool = [runspacefactory]::CreateRunspacePool(1, 3)
        $script:RescanPool.Open()
        $script:PendingScan = $null
        $script:OrphanedScans = [System.Collections.Generic.List[object]]::new()
        $script:PendingScanNetwork = $null
        # A ping can hang unboundedly: the PS 5.1 Test-Connection branch has no timeout at all.
        $script:PingPool = [runspacefactory]::CreateRunspacePool(1, 3)
        $script:PingPool.Open()
        $script:PendingPing = $null
        $script:OrphanedPings = [System.Collections.Generic.List[object]]::new()
    } catch {
        try { if ($script:PingPool) { $script:PingPool.Close(); $script:PingPool.Dispose() } } catch {}
        try { if ($script:RescanPool) { $script:RescanPool.Close(); $script:RescanPool.Dispose() } } catch {}
        try { $Listener.Stop() } catch {}
        try { $Listener.Close() } catch {}
        throw
    }
    # The parameters are only the seed (decrypted once at startup); script scope lets
    # Invoke-SaveConfigAction update them live without a process restart.
    $script:JunosUsername = $JunosUsername
    $script:JunosPassword = $JunosPassword

    # Invoke-ConnectAction's SSH launch must reuse the host that started this process: a
    # pwsh-only machine has no "powershell.exe" to hardcode.
    $PowerShellExePath = try { [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName } catch { $null }
    if ([string]::IsNullOrWhiteSpace($PowerShellExePath)) { $PowerShellExePath = "powershell.exe" }

    Write-Host "`nWeb UI listening on $Prefix (localhost only - Ctrl+C to stop)" -ForegroundColor Cyan
    # Guarded because this sits between the pool setup and the serving try/finally: an
    # unguarded throw would leave the listener bound with the accept loop never entered.
    # ShellExecute genuinely fails on hosts with no http:// handler, and isn't worth the
    # server for.
    try {
        Start-Process $Prefix
    } catch {
        Write-MapperDebugLog "BROWSER LAUNCH FAILED [$Prefix] $_"
        Write-Host "Could not open a browser automatically ($_)." -ForegroundColor Yellow
        Write-Host "The server is running - open $Prefix manually." -ForegroundColor Yellow
    }

    # Console progress for browser-triggered scans: the crawl runs in a background runspace,
    # so FleetCrawl.ps1's Write-Host never reaches this console. Piggybacks on the 250ms
    # accept-loop tick below.
    $script:ScanProgressSnapshot = $null
    try {
        while ($Listener.IsListening) {
          # Outermost per-iteration guard. The two try/catches below cover accept and dispatch,
          # but not the statements between them; anything escaping would reach this function's
          # finally without ever hitting a Write-MapperDebugLog call - the "server dies,
          # nothing in the log" failure mode. Catch all, log, keep the loop alive.
          try {
            # BeginGetContext/WaitOne(250) rather than a blocking GetContext(): a blocking call
            # gives the engine no statement boundary, so Ctrl+C is ignored. Its own try/catch,
            # separate from the dispatch below, so a transient HttpListenerException is logged
            # and retried instead of killing the server process silently.
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
                Write-MapperDebugLog "ACCEPT LOOP ERROR [$($_.Exception.GetBaseException().GetType().FullName)] $_`nStackTrace: $($_.ScriptStackTrace)"
                Write-Host "`nAccept loop error (logged to Mapper_Debug.log): $_" -ForegroundColor Red
                # Stops a CPU-spinning retry loop when the listener fails every call (socket
                # dead but IsListening not yet false); a real hiccup only costs 250ms.
                Start-Sleep -Milliseconds 250
                continue
            }
            $Request = $Context.Request
            $Response = $Context.Response

            # Every request is served on this one thread, so a blocking handler stops the whole
            # server while the process still looks alive - indistinguishable from "server down"
            # at the client. Only slow requests are logged: enough to name the blocking
            # endpoint without logging every request.
            $RequestStopwatch = [System.Diagnostics.Stopwatch]::StartNew()

            try {
                if ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/connect") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused"; reason = "Cross-origin request refused" }
                    } else {
                        $Body = Read-WebRequestBody -Request $Request
                        Invoke-ConnectAction -Response $Response -Body $Body -ConnectScriptPath $ConnectScriptPath -JunosUsername $script:JunosUsername -JunosPassword $script:JunosPassword -PowerShellExePath $PowerShellExePath -AllowedScopes $AllowedScopes
                    }
                } elseif ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/rescan") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused"; reason = "Cross-origin request refused" }
                    } else {
                        $Body = Read-WebRequestBody -Request $Request
                        Invoke-RescanAction -Response $Response -Body $Body -WorkerPath $WorkerPath -JunosUsername $script:JunosUsername -JunosPassword $script:JunosPassword -AllowedScopes $AllowedScopes
                    }
                } elseif ($Request.HttpMethod -eq "GET" -and $Request.Url.AbsolutePath -eq "/api/rescan/status") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused"; reason = "Cross-origin request refused" }
                    } else {
                        $JobId = Get-QueryParam -Query $Request.Url.Query -Name "jobId"
                        Invoke-RescanStatusAction -Response $Response -JobId $JobId
                    }
                } elseif ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/ping") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused"; reason = "Cross-origin request refused" }
                    } else {
                        $Body = Read-WebRequestBody -Request $Request
                        Invoke-PingAction -Response $Response -Body $Body
                    }
                } elseif ($Request.HttpMethod -eq "GET" -and $Request.Url.AbsolutePath -eq "/api/ping/status") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused"; reason = "Cross-origin request refused" }
                    } else {
                        $JobId = Get-QueryParam -Query $Request.Url.Query -Name "jobId"
                        Invoke-PingStatusAction -Response $Response -JobId $JobId
                    }
                } elseif ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/client-error") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused"; reason = "Cross-origin request refused" }
                    } else {
                        $Body = Read-WebRequestBody -Request $Request
                        Invoke-ClientErrorAction -Response $Response -Body $Body
                    }
                } elseif ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/scan-network") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused"; reason = "Cross-origin request refused" }
                    } else {
                        $Body = Read-WebRequestBody -Request $Request
                        Invoke-ScanNetworkAction -Response $Response -Body $Body -WorkerPath $WorkerPath -JunosUsername $script:JunosUsername -JunosPassword $script:JunosPassword -MaxConcurrent $MaxConcurrent -AllowedScopes $AllowedScopes -SnapshotDir $SnapshotDir -EncKey $EncKey -MacKey $MacKey -Salt $Salt -Iterations $Iterations
                    }
                } elseif ($Request.HttpMethod -eq "GET" -and $Request.Url.AbsolutePath -eq "/api/scan-network/status") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused"; reason = "Cross-origin request refused" }
                    } else {
                        Invoke-ScanNetworkStatusAction -Response $Response
                    }
                } elseif ($Request.HttpMethod -eq "GET" -and $Request.Url.AbsolutePath -eq "/api/config") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused"; reason = "Cross-origin request refused" }
                    } else {
                        Invoke-GetConfigAction -Response $Response -ConfigPath $ConfigPath
                    }
                } elseif ($Request.HttpMethod -eq "GET" -and $Request.Url.AbsolutePath -eq "/api/session-password") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused"; reason = "Cross-origin request refused" }
                    } else {
                        Invoke-GetSessionPasswordAction -Response $Response -EncryptionPassword $EncryptionPassword
                    }
                } elseif ($Request.HttpMethod -eq "GET" -and $Request.Url.AbsolutePath -eq "/api/snapshots") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused"; reason = "Cross-origin request refused" }
                    } else {
                        Invoke-GetSnapshotsAction -Response $Response -SnapshotDir $SnapshotDir
                    }
                } elseif ($Request.HttpMethod -eq "GET" -and $Request.Url.AbsolutePath -eq "/api/snapshot") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused"; reason = "Cross-origin request refused" }
                    } else {
                        $SnapshotName = Get-QueryParam -Query $Request.Url.Query -Name "name"
                        Invoke-GetSnapshotAction -Response $Response -SnapshotDir $SnapshotDir -Name $SnapshotName
                    }
                } elseif ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/save-config") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused"; reason = "Cross-origin request refused" }
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
                Write-MapperDebugLog "UNHANDLED REQUEST ERROR [$($Request.HttpMethod) $($Request.Url.AbsolutePath)] [$($_.Exception.GetBaseException().GetType().FullName)] $_`nStackTrace: $($_.ScriptStackTrace)"
                try { Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Server error: $_" } } catch {}
            } finally {
                $RequestStopwatch.Stop()
                if ($RequestStopwatch.Elapsed.TotalSeconds -ge 5) {
                    Write-MapperDebugLog "SLOW REQUEST [$($Request.HttpMethod) $($Request.Url.AbsolutePath)] blocked the accept loop for $([math]::Round($RequestStopwatch.Elapsed.TotalSeconds, 1))s"
                }
            }
          } catch {
            Write-MapperDebugLog "ACCEPT LOOP ITERATION FATAL (contained) [$($_.Exception.GetBaseException().GetType().FullName)] $_`nStackTrace: $($_.ScriptStackTrace)"
            Write-Host "`nAccept loop iteration error, contained (logged to Mapper_Debug.log): $_" -ForegroundColor Red
            # Abort a partially-constructed response so the browser fails fast rather than
            # hanging. Read off $Context, not $Response: if the exception came from unpacking
            # $Context, $Response still points at the previous iteration's closed object.
            try { if ($Context) { $Context.Response.Abort() } } catch {}
            Start-Sleep -Milliseconds 250
          }
        }
        Write-MapperDebugLog "ACCEPT LOOP EXITED (IsListening=$($Listener.IsListening))"
    } catch {
        Write-MapperDebugLog "SERVER FATAL [$($_.Exception.GetBaseException().GetType().FullName)] $_`nStackTrace: $($_.ScriptStackTrace)"
        throw
    } finally {
        # FIRST statement in the finally, deliberately: Ctrl+C raises a PipelineStoppedException
        # the catch above does not intercept, so neither SERVER FATAL nor ACCEPT LOOP EXITED is
        # written on the most common way this process ends. Pairs with SERVER START to bound
        # the process's serving lifetime.
        #
        # Raw .NET calls, not Write-MapperDebugLog: once Ctrl+C puts the pipeline in Stopping
        # state, any CMDLET invoked from a finally block re-throws PipelineStoppedException at
        # the call boundary (the helper's own `catch {}` would then swallow it and write
        # nothing). Plain .NET method calls are unaffected.
        #
        # That rule also means the cmdlet-based parts of this finally do not run on Ctrl+C:
        # the .NET $Listener/runspace teardown below does, but Stop-JunosOrphanProcessesLocal
        # and every SHUTDOWN ERROR line do not, so ssh.exe/cmd.exe grandchildren of an
        # in-flight scan survive a Ctrl+C exit. A .NET-only reap would fix it.
        try {
            if ($script:DebugLogPath) {
                [System.IO.File]::AppendAllText(
                    $script:DebugLogPath,
                    "[$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))] SERVER SHUTDOWN (IsListening=$($Listener.IsListening))`r`n",
                    [System.Text.Encoding]::UTF8)
            }
        } catch {}

        # Each step is independently try/catch'd: these are unrelated resources, and one
        # throwing must not abort the rest and leak whatever comes after it. Failures are
        # logged, not rethrown - there's no caller left and the process is exiting anyway.
        try { $Listener.Stop() } catch { Write-MapperDebugLog "SHUTDOWN ERROR [Listener.Stop] $_" }
        try { $Listener.Close() } catch { Write-MapperDebugLog "SHUTDOWN ERROR [Listener.Close] $_" }
        try {
            if ($script:PendingScan) {
                try { $script:PendingScan.PS.Stop() } catch {}
                $script:PendingScan.PS.Dispose()
                # Same ssh.exe/cmd.exe grandchild leak as the other rescan cleanup points.
                Stop-JunosOrphanProcessesLocal -TargetIP $script:PendingScan.IP -SinceTime $script:PendingScan.StartTime.AddSeconds(-2) -DebugLogPath $script:DebugLogPath
            }
        } catch { Write-MapperDebugLog "SHUTDOWN ERROR [PendingScan cleanup] $_" }
        try {
            foreach ($Orphan in $script:OrphanedScans) {
                try { $Orphan.PS.Stop() } catch {}
                $Orphan.PS.Dispose()
                Stop-JunosOrphanProcessesLocal -TargetIP $Orphan.IP -SinceTime $Orphan.StartTime.AddSeconds(-2) -DebugLogPath $script:DebugLogPath
            }
        } catch { Write-MapperDebugLog "SHUTDOWN ERROR [OrphanedScans cleanup] $_" }
        try {
            # .Collected means Invoke-ScanNetworkStatusAction already disposed PS/Runspace.
            if ($script:PendingScanNetwork -and -not $script:PendingScanNetwork.Collected) {
                try { $script:PendingScanNetwork.PS.Stop() } catch {}
                try { $script:PendingScanNetwork.PS.Dispose() } catch {}
                try { $script:PendingScanNetwork.Runspace.Dispose() } catch {}
            }
        } catch { Write-MapperDebugLog "SHUTDOWN ERROR [PendingScanNetwork cleanup] $_" }
        try { $script:RescanPool.Close(); $script:RescanPool.Dispose() } catch { Write-MapperDebugLog "SHUTDOWN ERROR [RescanPool cleanup] $_" }
        try {
            if ($script:PendingPing) { try { $script:PendingPing.PS.Stop() } catch {}; $script:PendingPing.PS.Dispose() }
        } catch { Write-MapperDebugLog "SHUTDOWN ERROR [PendingPing cleanup] $_" }
        try {
            foreach ($Orphan in $script:OrphanedPings) { try { $Orphan.PS.Stop() } catch {}; $Orphan.PS.Dispose() }
        } catch { Write-MapperDebugLog "SHUTDOWN ERROR [OrphanedPings cleanup] $_" }
        try { $script:PingPool.Close(); $script:PingPool.Dispose() } catch { Write-MapperDebugLog "SHUTDOWN ERROR [PingPool cleanup] $_" }
    }
}

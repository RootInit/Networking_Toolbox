# HttpListener-based local webserver for Network_Visualizer. Binds "localhost" only and runs
# unauthenticated: it can open an SSH session with in-memory switch credentials, so it is safe only
# while caller and process owner are the same person. Dot-source it, then Start-MapperWebServer.

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

# Set once the body starts going out: StatusCode/ContentLength64 are read-only after submission.
$script:WebResponseStarted = $false

function Send-WebResponse {
    param($Response, [int]$StatusCode, [byte[]]$Bytes, [string]$ContentType = "text/plain; charset=utf-8")
    $Response.StatusCode = $StatusCode
    $Response.ContentType = $ContentType
    $Response.ContentLength64 = $Bytes.Length
    try {
        $script:WebResponseStarted = $true
        $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
    } finally {
        # Close() throws too if the client vanished mid-write; must not mask the Write failure.
        try { $Response.OutputStream.Close() } catch {}
    }
}

function Send-WebJson {
    param($Response, [int]$StatusCode, [hashtable]$Object, [int]$Depth = 10)
    try {
        $Json = $Object | ConvertTo-Json -Depth $Depth -Compress
    } catch {
        # Every client does .json() on every response, so a non-JSON 500 body loses the real error.
        $ErrJson = @{ error = "Server failed to serialize response: $_" } | ConvertTo-Json -Compress
        Send-WebResponse -Response $Response -StatusCode 500 -Bytes ([System.Text.Encoding]::UTF8.GetBytes($ErrJson)) -ContentType "application/json; charset=utf-8"
        return
    }
    Send-WebResponse -Response $Response -StatusCode $StatusCode -Bytes ([System.Text.Encoding]::UTF8.GetBytes($Json)) -ContentType "application/json; charset=utf-8"
}

# Truncate-at-size rather than real rotation - the log only needs to stay bounded.
$script:DebugLogMaxBytes = 10MB

# Appends to Mapper_Debug.log. An array batch costs one open/close; each line keeps its own prefix.
function Write-MapperDebugLog {
    param([string[]]$Message)
    if (-not $script:DebugLogPath) { return }
    if ($null -eq $Message -or $Message.Count -eq 0) { return }
    # Best-effort: a full disk or a concurrent truncation must not take down the caller.
    # -Encoding utf8 explicit, or a mixed-encoding file causes CJK mojibake in text editors.
    try {
        $ExistingFile = Get-Item -LiteralPath $script:DebugLogPath -ErrorAction SilentlyContinue
        if ($ExistingFile -and $ExistingFile.Length -gt $script:DebugLogMaxBytes) {
            "=== Mapper_Debug.log truncated at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') (exceeded $($script:DebugLogMaxBytes) bytes) ===" | Out-File -FilePath $script:DebugLogPath -Encoding utf8
        }
        $Stamp = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] "
        $Stamped = foreach ($Line in $Message) { $Stamp + $Line }
        ($Stamped -join [Environment]::NewLine) | Out-File -FilePath $script:DebugLogPath -Append -Encoding utf8
    } catch {}
}

# Caps client-controlled text hitting the log; larger than elsewhere - JS stacks run long.
$script:ClientErrorFieldMaxLength = 4000

# Server-side throttle: utils.js dedupes only client-side, so a modified client could flood.
$script:ClientErrorRateLimitMax = 50
$script:ClientErrorRateLimitWindowSeconds = 60
$script:ClientErrorRateLimitCount = 0
$script:ClientErrorRateLimitWindowStart = Get-Date

# CR/LF become visible escapes so a value can't forge a second "[timestamp] ..." entry.
function ConvertTo-SafeLogField {
    param([string]$Text, [int]$MaxLength = $script:ClientErrorFieldMaxLength)
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $Safe = $Text -replace "`r`n", '\r\n' -replace "`r", '\r' -replace "`n", '\n'
    if ($Safe.Length -gt $MaxLength) { $Safe = $Safe.Substring(0, $MaxLength) + "...(truncated)" }
    return $Safe
}

# Forwards browser errors into Mapper_Debug.log. Tolerant of a bad body - a sink must not throw.
function Invoke-ClientErrorAction {
    param($Response, [string]$Body)

    # 200 even when throttled: fire-and-forget from the browser's side.
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

    # These compose the single HeaderLine below, so a smuggled CR/LF would fabricate an entry.
    $MessageText = ConvertTo-SafeLogField $MessageText
    $SourceText = ConvertTo-SafeLogField $SourceText
    $UrlText = ConvertTo-SafeLogField $UrlText

    $HeaderLine = "CLIENT ERROR [$SourceText] $MessageText"
    if ($UrlText) { $HeaderLine += " (at $UrlText)" }
    # One write for the whole stack: a stack is ~40 lines and this is the accept loop.
    $LogLines = [System.Collections.Generic.List[string]]::new()
    $LogLines.Add($HeaderLine)
    if ($StackText) {
        # Length-cap only - each line still needs its own real prefix, so leave newlines alone.
        if ($StackText.Length -gt $script:ClientErrorFieldMaxLength) {
            $StackText = $StackText.Substring(0, $script:ClientErrorFieldMaxLength) + "...(truncated)"
        }
        foreach ($StackLine in ($StackText -split "`n")) {
            # TrimEnd only strips a trailing CR; a mid-line one would overwrite the prefix on playback.
            $LogLines.Add("    $($StackLine.Replace("`r", '\r').TrimEnd())")
        }
    }
    Write-MapperDebugLog $LogLines.ToArray()

    Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "logged" }
}

# ContentEncoding falls back to the ANSI codepage on 5.1 when no charset is declared; decode UTF-8.
function Read-WebRequestBody {
    param($Request)
    $Reader = [System.IO.StreamReader]::new($Request.InputStream, [System.Text.Encoding]::UTF8)
    try { return $Reader.ReadToEnd() } finally { $Reader.Close() }
}

# [System.Web.HttpUtility] isn't reliably present on both target runtimes; WebUtility is.
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

# CSRF/DNS-rebinding guard. Localhost binding proves only that the caller runs as this user, not
# that it is our page. Origin (Referer as fallback) is unforgeable by page JS; fail closed if absent.
function Test-SameOriginRequest {
    param($Request, [int]$Port)
    $Expected = "http://localhost:$Port"
    $Origin = $Request.Headers["Origin"]
    if ($Origin) { return $Origin -eq $Expected }
    $Referer = $Request.Headers["Referer"]
    if ($Referer) { return $Referer -eq "$Expected/" -or $Referer.StartsWith("$Expected/") }
    return $false
}

# Resolves the ENGINE executable, not the host process: in the ISE, MainModule.FileName is
# powershell_ise.exe, whose -File opens the file in the editor - yet Start-Process still succeeds,
# so every click reports "launched" while leaking a plaintext credential file.
function Get-PowerShellEnginePath {
    $Candidates = @()
    if ($PSHOME) {
        if ($PSVersionTable.PSVersion.Major -ge 6) {
            # "pwsh.exe for Windows and pwsh for macOS and Linux" - try both, no platform test.
            $Candidates += (Join-Path $PSHOME "pwsh.exe")
            $Candidates += (Join-Path $PSHOME "pwsh")
        } else {
            $Candidates += (Join-Path $PSHOME "powershell.exe")
        }
    }
    foreach ($Candidate in $Candidates) {
        if ([System.IO.File]::Exists($Candidate)) { return $Candidate }
    }

    # Correct whenever the host IS the engine; the ISE is excluded or the bug above returns.
    $HostPath = try { [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName } catch { $null }
    if (-not [string]::IsNullOrWhiteSpace($HostPath) -and
        [System.IO.Path]::GetFileName($HostPath) -ne "powershell_ise.exe") {
        return $HostPath
    }
    return "powershell.exe"
}

# Launches Connect-Switch.ps1. Fixed script, no free-form command surface, $TargetIP regex-locked.
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

    # A manually-supplied target must clear the same fence crawl-discovered neighbors do.
    if (-not (Test-IpInAllowedScopes -IP $TargetIP -AllowedScopes $AllowedScopes)) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "IP is outside the configured AllowedScopes ($($AllowedScopes -join ', '))" }
        return
    }

    # Outside the try so the catch can see it; Connect-Switch.ps1 normally removes it itself.
    $CredFile = $null
    try {
        $CredFile = New-JunosCredentialFile -Username $JunosUsername -Password $JunosPassword
        $ArgString = @("-NoExit", "-File", "`"$ConnectScriptPath`"", "-TargetIP", $TargetIP, "-CredentialFile", "`"$CredFile`"") -join ' '
        Start-Process -FilePath $PowerShellExePath -ArgumentList $ArgString | Out-Null
        Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "launched"; ip = $TargetIP }
    } catch {
        # If the body already went out, Start-Process succeeded and the file is about to be read.
        if ($script:WebResponseStarted) {
            Write-MapperDebugLog "CONNECT ABORTED [$TargetIP] Client disconnected mid-response: $_"
            return
        }
        # Launch failed before Connect-Switch.ps1 could clean up its own credential file.
        if ($CredFile) { Remove-JunosCredentialFile -CredentialFile $CredFile }
        Write-MapperDebugLog "CONNECT ERROR [$TargetIP] Failed to launch SSH session: $_"
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to launch SSH session: $_" }
    }
}

# Async because a scan can take ~50s and the accept loop serves one request at a time.
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

    if (-not (Test-IpInAllowedScopes -IP $TargetIP -AllowedScopes $AllowedScopes)) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "IP is outside the configured AllowedScopes ($($AllowedScopes -join ', '))" }
        return
    }

    # Reap a previously-timed-out job that has since finished.
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
            # PS.Dispose() doesn't touch the ssh.exe grandchild this process spawned.
            Stop-JunosOrphanProcessesLocal -TargetIP $Orphan.IP -SinceTime $Orphan.StartTime.AddSeconds(-2) -DebugLogPath $script:DebugLogPath
            $script:OrphanedScans.RemoveAt($i)
        }
    }

    # A result the browser never polled would hold the slot forever. Collected=true: already reaped.
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

    # Never -HumanReadable (it ends in `exit`) and never -Log; -DebugLogPath IS passed.
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

# Async for the same reason as Invoke-RescanAction: 4 pings at 2s can stall the loop ~8s.
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
            # -Quiet avoided (no latency detail). PS 7+ returns one object per ping including timeouts,
            # so it must filter on Status; on 5.1 -ErrorAction Stop would discard earlier successes.
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
    try {
        $Handle = $PS.BeginInvoke()
    } catch {
        $PS.Dispose()
        throw
    }

    $script:PendingPing = [PSCustomObject]@{ PS = $PS; Handle = $Handle; IP = $TargetIP; JobId = $JobId; StartTime = (Get-Date); Collected = $false; Outcome = $null }
    Send-WebJson -Response $Response -StatusCode 202 -Object @{ status = "started"; jobId = $JobId; ip = $TargetIP }
}

# Polled while a ping is outstanding; response shape mirrors Invoke-RescanStatusAction.
function Invoke-PingStatusAction {
    param($Response, [string]$JobId)

    if (-not $JobId -or -not $script:PendingPing -or $script:PendingPing.JobId -ne $JobId) {
        Send-WebJson -Response $Response -StatusCode 404 -Object @{ error = "Unknown or expired job id" }
        return
    }

    $Job = $script:PendingPing

    if ($Job.Handle.IsCompleted) {
        # Collect once and cache: EndInvoke throws if called twice, and a poll may be retried.
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

                # Unwrap by index, matching how EndInvoke results are handled elsewhere here.
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
        # Not force-stopped: .Stop() can't interrupt a synchronous native ping; the pool has slack.
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
        if (-not $Job.Collected) {
            try {
                $Result = $Job.PS.EndInvoke($Job.Handle)

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

                # ok:false omits `node` - a failed scan's fields are placeholders, not real data.
                $Logs = if ($Result -and $Result.Logs) { @($Result.Logs) } else { @() }
                $HasCritical = $false
                foreach ($LogLine in $Logs) { if ($LogLine -match 'CRITICAL') { $HasCritical = $true; break } }

                if (-not $Result -or -not $Result.Node -or $HasCritical) {
                    # Not replayed here: the worker's -DebugLogPath already wrote these lines.
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
            # Needed on clean completion too: PS.Dispose() never touches the ssh.exe grandchildren.
            Stop-JunosOrphanProcessesLocal -TargetIP $Job.IP -SinceTime $Job.StartTime.AddSeconds(-2) -DebugLogPath $script:DebugLogPath
            $Job.Collected = $true
        }

        Send-WebJson -Response $Response -StatusCode 200 -Depth 20 -Object $Job.Outcome
        return
    }

    $Elapsed = ((Get-Date) - $Job.StartTime).TotalSeconds
    # INVARIANT: must outlast the worker's per-batch WaitForExit. Matches $JobAbandonSeconds.
    if ($Elapsed -gt 145) {
        # Not force-stopped: only the worker's own finally removes its plaintext %TEMP% password file.
        $script:OrphanedScans.Add($Job)
        $script:PendingScan = $null
        Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "timeout"; ip = $Job.IP; elapsedSeconds = [math]::Round($Elapsed) }
        return
    }

    Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "running"; ip = $Job.IP; elapsedSeconds = [math]::Round($Elapsed) }
}

# Async, same accept-loop reasoning as Invoke-RescanAction. One scan in flight; a second 409s.
function Invoke-ScanNetworkAction {
    param($Response, [string]$Body, [string]$WorkerPath, [string]$JunosUsername, [string]$JunosPassword,
          [string]$MaxConcurrent, [string[]]$AllowedScopes, [string]$SnapshotDir,
          [byte[]]$EncKey, [byte[]]$MacKey, [byte[]]$Salt, [int]$Iterations)

    if ([string]::IsNullOrWhiteSpace($JunosUsername) -or [string]::IsNullOrWhiteSpace($JunosPassword)) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "No Juniper login configured - set it in the Settings tab, then try again." }
        return
    }

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    $StartIP = if ($Parsed -and $Parsed.startIp) { [string]$Parsed.startIp } else { $null }

    if (-not $StartIP -or $StartIP -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\z') {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Invalid or missing starting IP address" }
        return
    }

    # Scope fence - the entry-point IP is reached before the crawl filters anything itself.
    if (-not (Test-IpInAllowedScopes -IP $StartIP -AllowedScopes $AllowedScopes)) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "IP is outside the configured AllowedScopes ($($AllowedScopes -join ', '))" }
        return
    }

    # Reap before validating: this clears the slot the previous scan's result is polled from. Reaping
    # is also required before the 409, or a scan the browser never polled 409s every future click.
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

    # Without this, Invoke-FleetCrawl's Write-DebugLogLocal is a no-op for web-triggered scans.
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
    try {
        $Runspace.Open()
        $PS.Runspace = $Runspace
        $Handle = $PS.BeginInvoke()
    } catch {
        $PS.Dispose()
        $Runspace.Dispose()
        throw
    }
    $script:PendingScanNetwork = [PSCustomObject]@{ PS = $PS; Runspace = $Runspace; Handle = $Handle; StartIP = $StartIP; StartTime = (Get-Date); ProgressTable = $ProgressTable; Collected = $false; Outcome = $null }
    Send-WebJson -Response $Response -StatusCode 202 -Object @{ status = "started"; startIp = $StartIP }
}

# Polled every ~2s. No timeout ceiling: a fleet crawl can legitimately run for many minutes.
function Invoke-ScanNetworkStatusAction {
    param($Response)

    if (-not $script:PendingScanNetwork) {
        Send-WebJson -Response $Response -StatusCode 404 -Object @{ error = "No scan is currently running or was ever started this session" }
        return
    }

    $Job = $script:PendingScanNetwork

    if ($Job.Handle.IsCompleted) {
        if (-not $Job.Collected) {
            try {
                $Result = $Job.PS.EndInvoke($Job.Handle)

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

                # Index explicitly: a 1-item collection unwraps to a bare object, breaking the array shape.
                $Payload = if ($Result -and $Result.Count -gt 0) { $Result[0] } else { $null }

                if (-not $Payload -or -not $Payload.Topology) {
                    $Job.Outcome = @{ status = "complete"; ok = $false; reason = "Scan produced no data - see server console/debug log" }
                } else {
                    # Deliberately NOT carrying $Payload.Topology: it is already on disk where
                    # Invoke-GetSnapshotAction serves it, and re-serializing it per poll stalled the loop.
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

# Serves the envelope as-is (the browser decrypts). Bypasses Send-WebJson: -AsHashtable is pwsh 6+.
function Invoke-GetConfigAction {
    param($Response, [string]$ConfigPath)

    if (-not (Test-Path $ConfigPath)) {
        Send-WebJson -Response $Response -StatusCode 404 -Object @{ error = "No configuration file yet" }
        return
    }

    try {
        # -Encoding UTF8 explicit, or 5.1 reads a BOM-less UTF-8 file as ANSI and mangles non-ASCII.
        $Raw = Get-Content $ConfigPath -Raw -Encoding UTF8
        Send-WebResponse -Response $Response -StatusCode 200 -Bytes ([System.Text.Encoding]::UTF8.GetBytes($Raw)) -ContentType "application/json; charset=utf-8"
    } catch {
        if ($script:WebResponseStarted) {
            Write-MapperDebugLog "GET-CONFIG ABORTED [$ConfigPath] Client disconnected mid-response: $_"
            return
        }
        Write-MapperDebugLog "GET-CONFIG ERROR [$ConfigPath] Failed to read configuration file: $_"
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to read configuration file: $_" }
    }
}

# Hands the browser the startup encryption password so it can decrypt client-side - a deliberate
# exception to "the password never crosses the wire". Same-origin gated despite being a GET: a leak
# decrypts every archived snapshot offline. Returns "" when there is nothing to offer.
function Invoke-GetSessionPasswordAction {
    param($Response, [string]$EncryptionPassword)
    # This body is the plaintext password - keep it out of proxy and browser disk caches.
    $Response.Headers.Add("Cache-Control", "no-store")
    Send-WebJson -Response $Response -StatusCode 200 -Object @{ password = [string]$EncryptionPassword }
}

# Backs the startup autoload. Mirrors forceLoadFolder's filter - a mid-crawl *.tmp must not load.
function Invoke-GetSnapshotsAction {
    param($Response, [string]$SnapshotDir)

    if (-not (Test-Path $SnapshotDir)) {
        Send-WebJson -Response $Response -StatusCode 200 -Object @{ snapshots = @() }
        return
    }

    try {
        # Most-recent-first covers the use case; older files stay on disk, just aren't offered.
        $MaxSnapshots = 20
        $Files = Get-ChildItem -LiteralPath $SnapshotDir -File |
            Where-Object { $_.Name -match '^NetworkMap_.*\.json(\.enc)?$' -and $_.Name -notmatch '\.tmp\.json(\.enc)?$' } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First $MaxSnapshots

        # Names and sizes only: one ConvertTo-Json over a ~40MB archive takes 5.1 minutes, on this thread.
        $Snapshots = @($Files | ForEach-Object { @{ name = $_.Name; size = $_.Length } })

        Send-WebJson -Response $Response -StatusCode 200 -Object @{ snapshots = $Snapshots }
    } catch {
        if ($script:WebResponseStarted) {
            Write-MapperDebugLog "GET-SNAPSHOTS ABORTED [$SnapshotDir] Client disconnected mid-response: $_"
            return
        }
        Write-MapperDebugLog "GET-SNAPSHOTS ERROR [$SnapshotDir] Failed to list snapshot(s): $_"
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to list snapshot(s): $_" }
    }
}

# Serves ONE snapshot verbatim: the file already IS the JSON document the client wants.
function Invoke-GetSnapshotAction {
    param($Response, [string]$SnapshotDir, [string]$Name)

    # Same filter the listing applies. \z, not $, which also matches before a trailing newline.
    if ([string]::IsNullOrWhiteSpace($Name) -or
        $Name -notmatch '^NetworkMap_.*\.json(\.enc)?\z' -or
        $Name -match '\.tmp\.json(\.enc)?\z') {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Invalid snapshot name" }
        return
    }

    # The anchored regex still admits path separators and .. segments; confine to $SnapshotDir.
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
        if ($script:WebResponseStarted) {
            Write-MapperDebugLog "GET-SNAPSHOT ABORTED [$Name] Client disconnected mid-response: $_"
            return
        }
        Write-MapperDebugLog "GET-SNAPSHOT ERROR [$Name] Failed to read snapshot: $_"
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to read snapshot: $_" }
    }
}

# The browser sends PLAINTEXT config JSON - the password never crosses in this request.
function Invoke-SaveConfigAction {
    param($Response, [string]$Body, [string]$ConfigPath, [string]$EncryptionPassword, [switch]$NoEncryption)

    # Fail closed: a blanked $EncryptionPassword would lock every future session out.
    if (-not $NoEncryption -and [string]::IsNullOrWhiteSpace($EncryptionPassword)) {
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "No working encryption password for this session - Configuration.json.enc could not be decrypted at startup, so saving is disabled to avoid rewriting the file under an unverified password. Restart Start-NetworkMapper.ps1 with the correct password." }
        return
    }

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    # Presence check, not truthiness: an empty array is falsy, and `devices: []` is legitimate.
    if (-not $Parsed -or $null -eq $Parsed.devices) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Request body must be JSON with a 'devices' array" }
        return
    }

    # $Username is interpolated unquoted into an ssh.exe command line, so a metacharacter is a
    # command-injection vector. Empty stays legal - {username:"", password:""} clears credentials.
    if ($Parsed.credentials) {
        $NewUsername = [string]$Parsed.credentials.username
        if ($NewUsername -and $NewUsername -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}\z') {
            Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Invalid username: must start with a letter or digit and contain only letters, digits, '.', '_', or '-'" }
            return
        }
    }

    try {
        if ($NoEncryption) {
            # Atomic: this is the operator's only copy of their device list and credentials.
            Set-FileContentAtomic -DestinationPath $ConfigPath -Content ($Parsed | ConvertTo-Json -Depth 10) -Encoding utf8
            # The atomic rename gives the file a default ACL, and it may hold plaintext credentials.
            Protect-JunosSensitiveFileAcl -Path $ConfigPath
        } else {
            $SaltBytes = [byte[]]::new(16)
            $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            $Rng.GetBytes($SaltBytes)
            $Rng.Dispose()

            # Shared via TopologyCrypto.ps1 so the count can't drift between crawler and webserver.
            $Iterations = Get-TopologyPbkdf2Iterations
            $KeyMaterial = Get-TopologyKeyMaterial -Password $EncryptionPassword -Salt $SaltBytes -Iterations $Iterations
            $Envelope = Protect-TopologyPayload -PlainJson $Body -EncKey $KeyMaterial.EncKey -MacKey $KeyMaterial.MacKey -Salt $SaltBytes -Iterations $Iterations -Format "PSNetworkMapper-EncryptedConfig"

            Set-FileContentAtomic -DestinationPath $ConfigPath -Content ($Envelope | ConvertTo-Json -Depth 10) -Encoding utf8
        }

        # Push saved credentials into the live copies, after the file write - a failed save must not
        # update them. Presence check: `credentials:null` leaves them alone.
        if ($Parsed.credentials) {
            $script:JunosUsername = [string]$Parsed.credentials.username
            $script:JunosPassword = [string]$Parsed.credentials.password
        }

        Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "saved" }
    } catch {
        if ($script:WebResponseStarted) {
            Write-MapperDebugLog "SAVE-CONFIG ABORTED [$ConfigPath] Client disconnected mid-response: $_"
            return
        }
        Write-MapperDebugLog "SAVE-CONFIG ERROR [$ConfigPath] Failed to save configuration: $_"
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to save configuration: $_" }
    }
}

# Serves a file under $VisualizerRoot; rejects anything resolving outside it before touching disk.
function Invoke-StaticFile {
    param($Response, [string]$AbsolutePath, [string]$VisualizerRoot)

    $RelPath = $AbsolutePath.TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($RelPath)) { $RelPath = "index.html" }

    $RootFull = [System.IO.Path]::GetFullPath($VisualizerRoot)
    if (-not $RootFull.EndsWith([System.IO.Path]::DirectorySeparatorChar)) { $RootFull += [System.IO.Path]::DirectorySeparatorChar }
    $FullPath = [System.IO.Path]::GetFullPath((Join-Path $RootFull $RelPath))

    # Trailing separator makes this a path-prefix match, or "Network_Visualizer_old" would pass.
    # -LiteralPath: without it a name containing [ ] or * is read as a wildcard.
    if (-not $FullPath.StartsWith($RootFull, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $FullPath -PathType Leaf)) {
        Send-WebResponse -Response $Response -StatusCode 404 -Bytes ([System.Text.Encoding]::UTF8.GetBytes("Not found"))
        return
    }

    $Ext = [System.IO.Path]::GetExtension($FullPath).ToLowerInvariant()
    $CType = if ($script:ContentTypes.ContainsKey($Ext)) { $script:ContentTypes[$Ext] } else { "application/octet-stream" }
    Send-WebResponse -Response $Response -StatusCode 200 -Bytes ([System.IO.File]::ReadAllBytes($FullPath)) -ContentType $CType
}

# Single-file bundle mode: only "/" and "/Network_Visualizer.html" resolve, never $VisualizerRoot.
function Invoke-SingleFileVisualizer {
    param($Response, [string]$AbsolutePath, [string]$SingleFileVisualizerPath)

    if ($AbsolutePath -ne "/" -and $AbsolutePath -ne "/Network_Visualizer.html") {
        Send-WebResponse -Response $Response -StatusCode 404 -Bytes ([System.Text.Encoding]::UTF8.GetBytes("Not found"))
        return
    }
    Send-WebResponse -Response $Response -StatusCode 200 -Bytes ([System.IO.File]::ReadAllBytes($SingleFileVisualizerPath)) -ContentType "text/html; charset=utf-8"
}

# Starts the listener, opens a browser, then serves one request at a time until Ctrl+C.
function Start-MapperWebServer {
    param(
        # Makes Invoke-SaveConfigAction write plaintext Configuration.json.
        [switch]$NoEncryption,
        [Parameter(Mandatory=$true)][string]$VisualizerRoot,
        # Set only when Start-NetworkMapper.ps1 found a single-file bundle next to itself.
        [AllowNull()][AllowEmptyString()][string]$SingleFileVisualizerPath,
        [Parameter(Mandatory=$true)][string]$ConnectScriptPath,
        [Parameter(Mandatory=$true)][string]$WorkerPath,
        [Parameter(Mandatory=$true)][string]$ConfigPath,
        # Empty/null is a legal VALUE ("no verified password this session"), not "omit".
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
        # Optional - Write-MapperDebugLog no-ops without it rather than failing to start.
        [AllowNull()][AllowEmptyString()][string]$DebugLogPath
    )

    # Must precede anything that can fail: Write-MapperDebugLog is a no-op until this is set.
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
    # Bookends SERVER SHUTDOWN below; together they bound when this process could actually serve.
    Write-MapperDebugLog "SERVER START listening on $Prefix (PID $PID)"

    # Own try/catch: a throw from the second .Open() would leak the listener and the first pool.
    # Sized 3, not 1: an orphaned job is never force-stopped, so a hung one holds a runspace
    # indefinitely; the spare slots absorb that instead of wedging every later job behind it.
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
    # Script scope lets Invoke-SaveConfigAction update these live without a process restart.
    $script:JunosUsername = $JunosUsername
    $script:JunosPassword = $JunosPassword

    # The SSH launch must reuse the engine running this process - see Get-PowerShellEnginePath.
    $PowerShellExePath = Get-PowerShellEnginePath

    Write-Host "`nWeb UI listening on $Prefix (localhost only - Ctrl+C to stop)" -ForegroundColor Cyan
    # Guarded: an unguarded throw would leave the listener bound with the accept loop never entered.
    try {
        Start-Process $Prefix
    } catch {
        Write-MapperDebugLog "BROWSER LAUNCH FAILED [$Prefix] $_"
        Write-Host "Could not open a browser automatically ($_)." -ForegroundColor Yellow
        Write-Host "The server is running - open $Prefix manually." -ForegroundColor Yellow
    }

    # The crawl runs in a background runspace, so FleetCrawl.ps1's Write-Host never reaches here.
    $script:ScanProgressSnapshot = $null
    try {
        while ($Listener.IsListening) {
          # Outermost per-iteration guard: anything escaping the inner try/catches dies unlogged.
          try {
            # BeginGetContext/WaitOne(250), not a blocking GetContext(): a blocking call ignores Ctrl+C.
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
                # Stops a CPU-spinning retry loop when the listener fails every call; a hiccup costs 250ms.
                Start-Sleep -Milliseconds 250
                continue
            }
            $Request = $Context.Request
            $Response = $Context.Response
            $script:WebResponseStarted = $false

            # One thread serves everything, so a blocking handler looks like "server down" at the client.
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
                # A disconnect after the body started is a client event; a 500 would just throw again.
                if ($script:WebResponseStarted) {
                    Write-MapperDebugLog "REQUEST ABORTED [$($Request.HttpMethod) $($Request.Url.AbsolutePath)] Client disconnected mid-response: $_"
                } else {
                    Write-MapperDebugLog "UNHANDLED REQUEST ERROR [$($Request.HttpMethod) $($Request.Url.AbsolutePath)] [$($_.Exception.GetBaseException().GetType().FullName)] $_`nStackTrace: $($_.ScriptStackTrace)"
                    try { Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Server error: $_" } } catch {}
                }
            } finally {
                $RequestStopwatch.Stop()
                if ($RequestStopwatch.Elapsed.TotalSeconds -ge 5) {
                    Write-MapperDebugLog "SLOW REQUEST [$($Request.HttpMethod) $($Request.Url.AbsolutePath)] blocked the accept loop for $([math]::Round($RequestStopwatch.Elapsed.TotalSeconds, 1))s"
                }
            }
          } catch {
            Write-MapperDebugLog "ACCEPT LOOP ITERATION FATAL (contained) [$($_.Exception.GetBaseException().GetType().FullName)] $_`nStackTrace: $($_.ScriptStackTrace)"
            Write-Host "`nAccept loop iteration error, contained (logged to Mapper_Debug.log): $_" -ForegroundColor Red
            # Read off $Context: if unpacking it threw, $Response points at the previous iteration's.
            try { if ($Context) { $Context.Response.Abort() } } catch {}
            Start-Sleep -Milliseconds 250
          }
        }
        Write-MapperDebugLog "ACCEPT LOOP EXITED (IsListening=$($Listener.IsListening))"
    } catch {
        Write-MapperDebugLog "SERVER FATAL [$($_.Exception.GetBaseException().GetType().FullName)] $_`nStackTrace: $($_.ScriptStackTrace)"
        throw
    } finally {
        # FIRST statement in the finally: Ctrl+C raises a PipelineStoppedException the catch above
        # doesn't intercept, so neither SERVER FATAL nor ACCEPT LOOP EXITED is written on the most
        # common exit. Raw .NET because Ctrl+C breaks pipeline OUTPUT - log to a file, never a stream.
        try {
            if ($script:DebugLogPath) {
                [System.IO.File]::AppendAllText(
                    $script:DebugLogPath,
                    "[$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))] SERVER SHUTDOWN (IsListening=$($Listener.IsListening))`r`n",
                    [System.Text.Encoding]::UTF8)
            }
        } catch {}

        # Independently try/catch'd: one unrelated resource throwing must not leak the rest.
        try { $Listener.Stop() } catch { Write-MapperDebugLog "SHUTDOWN ERROR [Listener.Stop] $_" }
        try { $Listener.Close() } catch { Write-MapperDebugLog "SHUTDOWN ERROR [Listener.Close] $_" }
        try {
            # .Collected: PS is already disposed, and the reap could hit an unrelated ssh.exe.
            if ($script:PendingScan -and -not $script:PendingScan.Collected) {
                try { $script:PendingScan.PS.Stop() } catch {}
                $script:PendingScan.PS.Dispose()
                # Same ssh.exe grandchild leak as the other rescan cleanup points.
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
            if ($script:PendingScanNetwork -and -not $script:PendingScanNetwork.Collected) {
                try { $script:PendingScanNetwork.PS.Stop() } catch {}
                try { $script:PendingScanNetwork.PS.Dispose() } catch {}
                try { $script:PendingScanNetwork.Runspace.Dispose() } catch {}
            }
        } catch { Write-MapperDebugLog "SHUTDOWN ERROR [PendingScanNetwork cleanup] $_" }
        try { $script:RescanPool.Close(); $script:RescanPool.Dispose() } catch { Write-MapperDebugLog "SHUTDOWN ERROR [RescanPool cleanup] $_" }
        try {
            if ($script:PendingPing -and -not $script:PendingPing.Collected) { try { $script:PendingPing.PS.Stop() } catch {}; $script:PendingPing.PS.Dispose() }
        } catch { Write-MapperDebugLog "SHUTDOWN ERROR [PendingPing cleanup] $_" }
        try {
            foreach ($Orphan in $script:OrphanedPings) { try { $Orphan.PS.Stop() } catch {}; $Orphan.PS.Dispose() }
        } catch { Write-MapperDebugLog "SHUTDOWN ERROR [OrphanedPings cleanup] $_" }
        try { $script:PingPool.Close(); $script:PingPool.Dispose() } catch { Write-MapperDebugLog "SHUTDOWN ERROR [PingPool cleanup] $_" }
    }
}

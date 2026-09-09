# The fleet crawl loop, shared by Start-NetworkMapper.ps1's CLI path and WebServer.ps1's
# /api/scan-network endpoint so both use identical crawl logic.
#
# Not meant to be run directly - dot-source it, then call Invoke-FleetCrawl.

. (Join-Path $PSScriptRoot "TopologyCrypto.ps1")
. (Join-Path $PSScriptRoot "SshHelpers.ps1")
. (Join-Path $PSScriptRoot "FileHelpers.ps1")

# The single scope fence, also called from WebServer.ps1 so a manually-entered entry-point IP
# is checked against the same rules as a crawl-discovered neighbor. Do not duplicate it.
#
# Not a bare string-prefix match: a scope like "10.1" must not match "10.19.5.5", so a prefix
# only counts on a full match or when followed by a literal ".". Scopes are trimmed of a
# trailing "." (the default "131.30." style) so they don't need a doubled "..".
function Test-IpInAllowedScopes {
    param([string]$IP, [string[]]$AllowedScopes)

    if ([string]::IsNullOrEmpty($IP)) { return $false }
    foreach ($Scope in $AllowedScopes) {
        $ScopeTrimmed = $Scope.TrimEnd('.')
        if ($IP -eq $ScopeTrimmed -or $IP.StartsWith("$ScopeTrimmed.")) { return $true }
    }
    return $false
}

# A worker's ssh.exe is an OS-level grandchild of THIS process that $PS.Stop()/.Dispose() know
# nothing about, so abandoning a hung job leaks a live ssh.exe with its session to the switch
# open. Many jobs share this PID, so candidates must match on command line plus creation time,
# not process name.
#
# -DebugLogPath must be an explicit parameter, since PowerShell resolves unscoped names via
# the *call stack*: called from WebServer.ps1, Invoke-FleetCrawl's Write-DebugLogLocal
# wouldn't resolve and the error would be swallowed by the try/catch below.
function Stop-JunosOrphanProcessesLocal {
    param([Parameter(Mandatory=$true)][string]$TargetIP, [Parameter(Mandatory=$true)][datetime]$SinceTime, [string]$DebugLogPath)
    function Write-OrphanCleanupLogLocal {
        param([string]$Message)
        if ($DebugLogPath) {
            try { "[$(Get-Date -Format 'HH:mm:ss')] $Message" | Out-File -FilePath $DebugLogPath -Append -Encoding utf8 } catch {}
        }
    }
    try {
        # Anchored on the "$Username@$TargetIP" token Get-JunosSshArgs appends last. A bare
        # "*$TargetIP*" wildcard would match 10.1.1.5 against a concurrent job for
        # 10.1.1.50-59, killing a healthy in-flight scan.
        $Candidates = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction Stop |
            Where-Object { $_.CommandLine -and $_.CommandLine -match "@$([regex]::Escape($TargetIP))(\s|$)" -and $_.CreationDate -ge $SinceTime }
        foreach ($Proc in $Candidates) {
            try {
                Stop-Process -Id $Proc.ProcessId -Force -ErrorAction Stop
                Write-OrphanCleanupLogLocal "ORCHESTRATOR CLEANUP: killed orphaned $($Proc.Name) (PID $($Proc.ProcessId)) for $TargetIP"
            } catch {
                Write-OrphanCleanupLogLocal "ORCHESTRATOR CLEANUP: failed to kill orphan PID $($Proc.ProcessId) ($($Proc.Name)) for $($TargetIP): $_"
            }
        }
    } catch {
        Write-OrphanCleanupLogLocal "ORCHESTRATOR CLEANUP: Stop-JunosOrphanProcessesLocal failed for $($TargetIP): $_"
    }
}

function Invoke-FleetCrawl {
    param(
        [Parameter(Mandatory=$true)][string]$StartIP,
        [Parameter(Mandatory=$true)][string[]]$AllowedScopes,
        [Parameter(Mandatory=$true)][ValidateRange(1, 64)][int]$MaxConcurrent,
        [Parameter(Mandatory=$true)][string]$WorkerPath,
        [Parameter(Mandatory=$true)][string]$Username,
        [Parameter(Mandatory=$true)][string]$Password,
        [Parameter(Mandatory=$true)][string]$SnapshotDir,
        # The web path shares this hashtable instance with its polling HTTP handler: single
        # writer (this function), single reader (poll handler), so no locking needed.
        [Parameter(Mandatory=$true)][hashtable]$ProgressTable,
        # All four present = encrypted output; all four absent = plain .json.
        [byte[]]$EncKey,
        [byte[]]$MacKey,
        [byte[]]$Salt,
        [int]$Iterations,
        [string]$DebugLogPath,
        [switch]$Log
    )

    # Sweep up plaintext credential/askpass files a prior crashed run left in %TEMP% before
    # workers start writing their own.
    Clear-StaleJunosTempFiles

    $Encrypted = $null -ne $EncKey
    # Swallow logging failures (e.g. read-only log dir) - losing a debug line shouldn't kill the crawl.
    function Write-DebugLogLocal {
        param([string]$Message)
        if ($DebugLogPath) {
            try { "[$(Get-Date -Format 'HH:mm:ss')] $Message" | Out-File -FilePath $DebugLogPath -Append -Encoding utf8 } catch {}
        }
    }
    # -Encoding utf8 required: Windows PowerShell 5.1's Out-File default is UTF-16LE with a
    # BOM, which would put this header in a different encoding from the lines appended after
    # it and make the whole file read back as UTF-16LE.
    if ($DebugLogPath) { try { "=== Fleet Crawl Debug Log - $(Get-Date) ===" | Out-File -FilePath $DebugLogPath -Force -Encoding utf8 } catch {} }

    # Single write path for init/periodic/final writes so encryption is wired in once.
    function Write-TopologyOutputLocal {
        param($Topology, [string]$Path, [string]$ScanTimestampIso)
        $PlainJson = @{ Topology = $Topology; ScanTimestamp = $ScanTimestampIso } | ConvertTo-Json -Depth 100
        if ($Encrypted) {
            $Envelope = Protect-TopologyPayload -PlainJson $PlainJson -EncKey $EncKey -MacKey $MacKey -Salt $Salt -Iterations $Iterations
            $Envelope | ConvertTo-Json -Depth 5 | Out-File -FilePath $Path -Encoding utf8
        } else {
            # An unencrypted snapshot holds the full unredacted "show configuration | display
            # set" for every device - SNMP communities, RADIUS/TACACS+ secrets - so it needs
            # the same single-user ACL SshHelpers.ps1 gives its credential temp files. Touch
            # the file empty and harden it BEFORE the plaintext lands, so the content is never
            # on disk under $SnapshotDir's broader default ACL even momentarily.
            [System.IO.File]::WriteAllText((Resolve-PathForDotNetIo -Path $Path), "")
            Protect-JunosSensitiveFileAcl -Path $Path
            $PlainJson | Out-File -FilePath $Path -Encoding utf8
        }
    }

    # Every topology write (init/periodic/final/salvage) goes through here. Move-FileAtomic
    # replaces $OutputFile with a freshly-created file carrying the default ACL on EVERY call,
    # so the post-move hardening has to run each time rather than once - File.Replace's ACL
    # semantics across the rename are not relied on. Skipped when $Encrypted: an envelope is
    # already opaque without the passphrase. See Write-TopologyOutputLocal for why plaintext
    # snapshots need this at all.
    function Move-TopologyOutputAtomicLocal {
        param([string]$SourcePath, [string]$DestinationPath)
        Move-FileAtomic -SourcePath $SourcePath -DestinationPath $DestinationPath
        if (-not $Encrypted) {
            Protect-JunosSensitiveFileAcl -Path $DestinationPath
        }
    }

    # Without a synthetic node a device that never produced one vanishes from the output
    # entirely: its IP is already in $Visited, and once its attempts are spent nothing
    # re-dispatches it.
    # Mirrors Get-JunosNodeData.ps1's $NodeData initializer field-for-field (Interfaces is a
    # hashtable there, not an array) - consumers assume every key a real node has is present.
    function New-PlaceholderNodeLocal {
        param([string]$IP, [string]$Status, [string]$ScanErrorText)
        return @{
            DeviceIP = $IP; Hostname = "Unknown"; JunosVersion = "Unknown"; Gateway = "Unknown";
            StackMembers = @(); Neighbors = @(); Clients = @(); ArpEntries = @(); Interfaces = @{};
            Uptime = "Unknown"; LastConfigured = "Unknown"; LastConfiguredBy = "Unknown"; Alarms = @();
            MasterCpuUtilization = "Unknown"; MasterMemoryUtilization = "Unknown";
            MedNeighbors = @(); Configuration = "Unknown";
            ScanStatus = $Status
            ScanError  = $ScanErrorText
        }
    }

    # A client's ARP entry often lives on a different device than the access switch it's
    # plugged into (the L3 gateway/IRB), so backfill "Unknown" IPs from a global MAC->IP map
    # built across every node crawled so far.
    function Update-ClientIpCorrelationLocal {
        param([System.Collections.Generic.List[object]]$Topology)
        $GlobalArpMap = @{}
        foreach ($Device in $Topology) {
            foreach ($Arp in $Device.ArpEntries) {
                if ($Arp.MAC -and $Arp.IP) { $GlobalArpMap[$Arp.MAC] = $Arp.IP }
            }
        }
        foreach ($Device in $Topology) {
            foreach ($Client in $Device.Clients) {
                if ($Client.IP -eq "Unknown" -and $GlobalArpMap.ContainsKey($Client.MAC)) {
                    $Client.IP = $GlobalArpMap[$Client.MAC]
                }
            }
        }
    }

    $ScanDateTime = Get-Date
    $ScanTimestamp = $ScanDateTime.ToString("yyyy-MM-dd_HHmmss")
    $ScanTimestampIso = $ScanDateTime.ToString("o")
    $OutputExtension = if ($Encrypted) { ".json.enc" } else { ".json" }
    $OutputFile = Join-Path $SnapshotDir "NetworkMap_$ScanTimestamp$OutputExtension"
    $TempOutputFile = Join-Path $SnapshotDir "NetworkMap_$ScanTimestamp.$PID.$([guid]::NewGuid().ToString('N')).tmp$OutputExtension"

    $RunspacePool = [runspacefactory]::CreateRunspacePool(1, $MaxConcurrent)
    $RunspacePool.Open()

    $Jobs = [System.Collections.Generic.List[PSCustomObject]]::new()

    # INVARIANT: must exceed the worker's own worst case or the orchestrator abandons jobs that
    # were still going to succeed - abandoning gains nothing and costs the crawl a device.
    # Set it no higher than that either: a dead switch holds a runspace slot for this whole
    # budget. Get-JunosNodeData.ps1 makes exactly one SSH batch call, capped at
    # Process.WaitForExit(120000); the remaining 25s covers process start, parsing and the
    # result write. Raise this if that cap rises or a second batch is ever added.
    $JobAbandonSeconds = 145
    $Queue = [System.Collections.Generic.Queue[string]]::new()
    $Visited = [System.Collections.Generic.HashSet[string]]::new()
    $Enqueued = [System.Collections.Generic.HashSet[string]]::new()
    $TopologyList = [System.Collections.Generic.List[object]]::new()

    # Retry pass, for a device lost to a transient fault (a stalled RE, a dropped connect). A
    # failed IP goes to the BACK of the same queue and the main loop handles it, which reuses
    # dispatch, neighbor discovery, the periodic writes and the circuit breaker rather than
    # growing a second loop that has to repeat all of them. Back of the queue, not the front, so
    # the retry lands after the rest of the sweep and a transient fault has time to clear.
    #
    # AuthFailed is deliberately absent: retrying a bad credential is precisely how the estate
    # locks the account out, which is what the circuit breaker below exists to prevent. Aborted
    # is absent because the crawl is already stopping.
    $RetryableStatuses = @("Timeout", "Partial", "Error", "Unreachable")
    $MaxAttempts = 2
    $Attempts = @{}
    # The discarded node from a retried attempt, keyed by IP. A Partial carries real data, so if
    # the retry then produces nothing (abandoned as hung, or cut short by an abort) the stashed
    # node is still the better record - without this, retrying could report LESS than one attempt.
    $LastFailedNode = @{}

    # $true means the IP is queued for another attempt, and the caller must NOT record a node
    # for this one: a device that succeeds on its retry has to leave no failure behind, and
    # consumers do last-write-wins by DeviceIP, so a stale placeholder would be indistinguishable
    # from a real result. The final attempt returns $false and is recorded normally.
    function Request-JobRetryLocal {
        param([string]$IP, [string]$Status)
        if ($RetryableStatuses -notcontains $Status) { return $false }
        if ($Attempts[$IP] -ge $MaxAttempts) {
            Write-DebugLogLocal "RETRY EXHAUSTED: $IP failed $($Attempts[$IP]) attempts, last status '$Status'"
            return $false
        }
        $Queue.Enqueue($IP)
        Write-DebugLogLocal "RETRY QUEUED: $IP (attempt $($Attempts[$IP]) failed with status '$Status')"
        return $true
    }

    # The one node a failed IP ends up with. Prefers whatever a discarded earlier attempt
    # collected over an empty placeholder, so a device never loses data by being retried.
    # Callers own $PendingWrites: assigning to it here would only create a local copy.
    function Add-FinalNodeLocal {
        param([string]$IP, [string]$Status, [string]$ScanErrorText)
        if ($LastFailedNode.ContainsKey($IP)) {
            $TopologyList.Add($LastFailedNode[$IP])
            $LastFailedNode.Remove($IP)
        } else {
            $TopologyList.Add((New-PlaceholderNodeLocal -IP $IP -Status $Status -ScanErrorText $ScanErrorText))
        }
    }

    $Queue.Enqueue($StartIP)
    $Enqueued.Add($StartIP) | Out-Null
    $LastWriteTime = Get-Date
    $PendingWrites = 0
    # Grows adaptively with the measured cost of a write - see the periodic-write block below.
    $BaseWriteIntervalSeconds = 5
    $MaxWriteIntervalSeconds = 120
    $WriteIntervalSeconds = $BaseWriteIntervalSeconds

    # Circuit breaker: the same credential is retried against every device in the queue, so on
    # a TACACS+/RADIUS estate with lockout-after-N-failures one mistyped password could lock
    # the account out fleet-wide. Abort once failures cross the threshold instead.
    $ConsecutiveAuthFailures = 0
    $TotalAuthFailures = 0
    $AuthFailureThreshold = 3
    # Lets the caller distinguish an aborted crawl from a complete one - both otherwise fall
    # into the same post-loop return.
    $WasAborted = $false
    $AbortReason = $null

    # PowerShell instances whose BeginStop() is in flight, awaiting EndStop()+Dispose() once
    # it completes - see the cleanup site below for why this can't be done inline.
    $PendingDisposal = [System.Collections.Generic.List[PSCustomObject]]::new()
    # Accumulated across both final drains (the normal-exit one and the finally's), so the
    # runspace-pool close below still knows a pipeline was abandoned earlier.
    $AbandonedPipelines = 0

    # Bounds the final drain. The circuit-breaker abort BeginStops every in-flight job and
    # drains immediately, so entries can reach the drain having had no polling window at all.
    $FinalDrainSeconds = 3

    function Complete-PendingDisposalsLocal {
        param([bool]$OnlyCompleted = $true)
        for ($i = $PendingDisposal.Count - 1; $i -ge 0; $i--) {
            $Entry = $PendingDisposal[$i]
            if ($Entry.Async.IsCompleted) {
                try { $Entry.PS.EndStop($Entry.Async) } catch {}
                try { $Entry.PS.Dispose() } catch {}
                $PendingDisposal.RemoveAt($i)
            }
        }
        if ($OnlyCompleted) { return }

        # Final drain. Dispose() blocks for exactly as long as the synchronous Stop() this code
        # avoids (a pipeline wedged in Process.WaitForExit(50000) blocks the orchestrator - and
        # in the web path the whole single-threaded HttpListener loop - for the rest of that
        # wait), so give the stops a bounded window and then abandon what is left rather than
        # disposing it. .NET primitives rather than cmdlets (Thread.Sleep over Start-Sleep,
        # Stopwatch over Get-Date) only to keep a tight poll loop cheap - cmdlets DO run
        # normally here, including from the finally under Ctrl+C, since PowerShell suspends the
        # pipeline's stopping state for the duration of a finally body. What Ctrl+C does break
        # is pipeline OUTPUT, so anything reported from this path must go to a file.
        $DrainClock = [System.Diagnostics.Stopwatch]::StartNew()
        while ($PendingDisposal.Count -gt 0 -and $DrainClock.Elapsed.TotalSeconds -lt $FinalDrainSeconds) {
            [System.Threading.Thread]::Sleep(100)
            for ($i = $PendingDisposal.Count - 1; $i -ge 0; $i--) {
                $Entry = $PendingDisposal[$i]
                if ($Entry.Async.IsCompleted) {
                    try { $Entry.PS.EndStop($Entry.Async) } catch {}
                    try { $Entry.PS.Dispose() } catch {}
                    $PendingDisposal.RemoveAt($i)
                }
            }
        }
        $Leaked = $PendingDisposal.Count
        if ($Leaked -gt 0) {
            $PendingDisposal.Clear()
            Write-DebugLogLocal "ORCHESTRATOR: abandoned $Leaked pipeline(s) still stopping after $($FinalDrainSeconds)s - Dispose() would have blocked on them."
        }
        # Sole output: callers capture it to decide whether waiting on the pool is worthwhile.
        return $Leaked
    }

    try {
        Write-Host "`nStarting Crawl with $MaxConcurrent Threads. Press Ctrl+C to abort gracefully.`n" -ForegroundColor Yellow

        # Inside the try, not above it, so a failure here still reaches the catch below and the
        # finally still reaps the leftover .tmp file.
        Write-TopologyOutputLocal -Topology @() -Path $TempOutputFile -ScanTimestampIso $ScanTimestampIso
        Move-TopologyOutputAtomicLocal -SourcePath $TempOutputFile -DestinationPath $OutputFile

        while ($Queue.Count -gt 0 -or $Jobs.Count -gt 0) {

            # 0. Finish off any async Stop()s that completed since the last iteration.
            $null = Complete-PendingDisposalsLocal

            # 1. Fill available thread slots (Safely dequeueing)
            #
            # The circuit breaker only counts COMPLETED results, so it can't stop the first
            # wave: $MaxConcurrent jobs can be in flight against a bad credential before it has
            # anything to count. Once ANY auth failure is seen, throttle to one dispatch per
            # iteration so exposure stays bounded while the breaker gathers evidence.
            $DispatchLimitThisIteration = if ($TotalAuthFailures -gt 0) { 1 } else { $MaxConcurrent }
            $DispatchedThisIteration = 0
            while ($Jobs.Count -lt $MaxConcurrent -and $Queue.Count -gt 0 -and $DispatchedThisIteration -lt $DispatchLimitThisIteration) {
                $NextIP = $Queue.Dequeue()
                # $Visited dedupes first dispatches only. A retry is a deliberate re-dispatch of
                # an already-visited IP, so it bypasses that gate and is bounded by $MaxAttempts.
                $PriorAttempts = if ($Attempts.ContainsKey($NextIP)) { $Attempts[$NextIP] } else { 0 }
                if ($PriorAttempts -eq 0) {
                    if (!$Visited.Add($NextIP)) { continue }
                } elseif ($PriorAttempts -ge $MaxAttempts) {
                    continue
                }
                $Attempts[$NextIP] = $PriorAttempts + 1

                # Reset $PS before the try: it's function-scoped, so a throw here would
                # otherwise leave it pointing at the previous iteration's live job, which the
                # catch below would then Dispose().
                $PS = $null
                try {
                    $PS = [powershell]::Create().AddCommand($WorkerPath).AddParameter("TargetIP", $NextIP).AddParameter("Username", $Username).AddParameter("Password", $Password)
                    if ($Log) { $PS.AddParameter("Log") | Out-Null }
                    # Lets the worker write failures to disk as they happen rather than only
                    # buffering into $Result.Logs: a job abandoned as hung never reaches
                    # EndInvoke, so its failure would otherwise never reach the debug log.
                    if ($DebugLogPath) { $PS.AddParameter("DebugLogPath", $DebugLogPath) | Out-Null }

                    $PS.RunspacePool = $RunspacePool
                    # Captured BEFORE BeginInvoke(): the pipeline can start on a pool thread
                    # immediately, so its ssh.exe grandchild's CreationDate could land earlier
                    # than a StartTime taken after the call returns, letting a genuine orphan
                    # slip past Stop-JunosOrphanProcessesLocal's "CreationDate -ge" filter.
                    $JobStartTime = Get-Date
                    $Handle = $PS.BeginInvoke()
                    # Abandoned gates the orphan reap below: only a job we gave up on can have
                    # left an ssh.exe behind. A job that returned normally already ran the
                    # worker's own finally, which killed its process and cleaned its temp files.
                    $Jobs.Add([PSCustomObject]@{ PS = $PS; Handle = $Handle; IP = $NextIP; StartTime = $JobStartTime; Abandoned = $false })
                } catch {
                    Write-DebugLogLocal "ORCHESTRATOR ERROR: failed to start job for $($NextIP): $_"
                    Write-Host "`n[!] Failed to start job for $($NextIP): $_" -ForegroundColor Red
                    if ($PS) { try { $PS.Dispose() } catch {} }
                }
                $DispatchedThisIteration++
            }

            Write-Host "`r[Threads: $($Jobs.Count)/$MaxConcurrent] [Queue: $($Queue.Count)] [Done: $($TopologyList.Count)]    " -NoNewline -ForegroundColor Cyan
            $ProgressTable.Visited = $Visited.Count
            $ProgressTable.QueueDepth = $Queue.Count
            $ProgressTable.ActiveJobs = $Jobs.Count

            # 2. Process Jobs (Completed OR Hung)
            $JobsToRemove = @()

            foreach ($Job in $Jobs) {
                if (-not $Job.Handle.IsCompleted -and ((Get-Date) - $Job.StartTime).TotalSeconds -gt $JobAbandonSeconds) {
                    Write-DebugLogLocal "ORCHESTRATOR TIMEOUT: Abandoning hung thread for $($Job.IP)"
                    Write-Host "`n[!] Timed out waiting on $($Job.IP) - abandoning and continuing." -ForegroundColor Red

                    if (-not (Request-JobRetryLocal -IP $Job.IP -Status "Timeout")) {
                        Add-FinalNodeLocal -IP $Job.IP -Status "Timeout" `
                            -ScanErrorText "Orchestrator gave up waiting on $($Job.IP) after $($JobAbandonSeconds)s (job abandoned)."
                        $PendingWrites++
                    }
                    # A timeout resets only the consecutive streak; $TotalAuthFailures is a
                    # whole-crawl tally so interleaved timeouts can't mask a failing credential.
                    $ConsecutiveAuthFailures = 0

                    $Job.Abandoned = $true
                    $JobsToRemove += $Job
                    continue
                }

                if ($Job.Handle.IsCompleted) {
                    try {
                        $Result = $Job.PS.EndInvoke($Job.Handle)

                        # Non-terminating errors inside the worker don't fail EndInvoke and
                        # would otherwise never surface anywhere.
                        if ($Job.PS.HadErrors) {
                            foreach ($ErrRecord in $Job.PS.Streams.Error) {
                                Write-DebugLogLocal "WORKER ERROR STREAM ($($Job.IP)): $ErrRecord"
                            }
                        }

                        # Same for Write-Warning: these are hostless runspace jobs, so a
                        # worker's warning lands in .Streams.Warning and is never displayed.
                        if ($Job.PS.Streams.Warning.Count -gt 0) {
                            foreach ($WarnRecord in $Job.PS.Streams.Warning) {
                                Write-DebugLogLocal "WORKER WARNING STREAM ($($Job.IP)): $WarnRecord"
                            }
                        }

                        if ($Result -and $Result.Node) {
                            $Node = $Result.Node
                            # Fallback only for a run without $DebugLogPath: when it is set the
                            # worker already wrote these lines itself, so replaying them here
                            # would duplicate every line.
                            if (-not $DebugLogPath -and $Result.Logs) { foreach ($LogLine in $Result.Logs) { Write-DebugLogLocal $LogLine } }

                            # Retryable failures are dropped here rather than recorded: the
                            # re-dispatch discovers this device's neighbors itself, so nothing
                            # is lost by waiting for the attempt that actually reaches it.
                            if (Request-JobRetryLocal -IP $Job.IP -Status $Node.ScanStatus) {
                                # The enclosing try's finally adds $Job to $JobsToRemove.
                                $LastFailedNode[$Job.IP] = $Node
                                Write-Host "`n[~] $($Job.IP) failed ($($Node.ScanStatus)) - queued for another attempt." -ForegroundColor Yellow
                                continue
                            }

                            Write-Host "`n[+] Finished $($Job.IP) ($($Node.Hostname)) - $($Node.Neighbors.Count) Neighbors, $($Node.Clients.Count) Clients" -ForegroundColor Green

                            # Before the neighbor loop, so a malformed neighbor entry throwing
                            # partway through doesn't cost the node its collected data.
                            $TopologyList.Add($Node)
                            $LastFailedNode.Remove($Job.IP)
                            $PendingWrites++

                            if ($Node.ScanStatus -eq "AuthFailed") {
                                $ConsecutiveAuthFailures++
                                $TotalAuthFailures++
                                Write-DebugLogLocal "ORCHESTRATOR: auth failures - consecutive=$ConsecutiveAuthFailures total=$TotalAuthFailures (threshold $AuthFailureThreshold)"
                            } else {
                                $ConsecutiveAuthFailures = 0
                            }

                            # Own try/catch: a throw here must not reach the outer EndInvoke
                            # catch, which would append a ScanStatus="Error" placeholder for
                            # $Job.IP alongside the real $Node just added - and since consumers
                            # do last-write-wins by DeviceIP, that placeholder would silently
                            # clobber the good data.
                            try {
                                foreach ($Neigh in $Node.Neighbors) {
                                    $NIP = $Neigh.ManagementIP
                                    if ([string]::IsNullOrEmpty($NIP)) { continue }
                                    $InScope = Test-IpInAllowedScopes -IP $NIP -AllowedScopes $AllowedScopes

                                    if ($InScope -and !$Visited.Contains($NIP) -and !$Enqueued.Contains($NIP)) {
                                        $Queue.Enqueue($NIP)
                                        $Enqueued.Add($NIP) | Out-Null
                                        Write-DebugLogLocal "ENQUEUED: $NIP"
                                    } elseif (-not $InScope) {
                                        Write-DebugLogLocal "SKIPPED (out of AllowedScopes): $NIP seen as neighbor of $($Job.IP)"
                                    }
                                }
                            } catch {
                                Write-DebugLogLocal "ORCHESTRATOR ERROR: failed while enqueuing neighbors for $($Job.IP): $_"
                                Write-Host "`n[!] Error enqueuing neighbors for $($Job.IP): $_" -ForegroundColor Red
                            }
                        } else {
                            # Get-JunosNodeData always returns a Node, so reaching here means the
                            # worker died before its own error handling could - a FIPS-policy host
                            # rejecting a hash provider did exactly this. Recorded rather than
                            # skipped: a silent drop leaves the device in $Visited with no node
                            # anywhere in the output.
                            Write-DebugLogLocal "ORCHESTRATOR WARNING: $($Job.IP) produced no result (worker returned nothing)."
                            Write-Host "`n[!] $($Job.IP) produced no result." -ForegroundColor Red

                            if (-not (Request-JobRetryLocal -IP $Job.IP -Status "Error")) {
                                Add-FinalNodeLocal -IP $Job.IP -Status "Error" `
                                    -ScanErrorText "Worker returned nothing for $($Job.IP) - it exited before it could report a fault. See the debug log's WORKER ERROR STREAM lines."
                                $PendingWrites++
                            }
                        }
                    } catch {
                        Write-DebugLogLocal "ORCHESTRATOR ERROR parsing result from $($Job.IP): $_"
                        Write-Host "`n[!] Error processing result from $($Job.IP): $_" -ForegroundColor Red

                        if (-not (Request-JobRetryLocal -IP $Job.IP -Status "Error")) {
                            Add-FinalNodeLocal -IP $Job.IP -Status "Error" `
                                -ScanErrorText "Orchestrator failed to process result from $($Job.IP): $_"
                            $PendingWrites++
                        }
                    } finally {
                        $JobsToRemove += $Job
                    }
                }
            }

            # 3. Clean up processed or hung jobs.
            #
            # PowerShell.Stop() is synchronous and can't preempt an uninterruptible native call
            # inside the worker (Process.WaitForExit, a blocked StandardInput.WriteLine on a
            # dead pipe), so on this single-threaded loop a stuck pipeline would freeze the
            # entire crawl. BeginStop() returns immediately; EndStop()+Dispose() are deferred to
            # $PendingDisposal and drained by step 0. Polling rather than a BeginStop
            # AsyncCallback, which would fire on a threadpool thread with no runspace attached.
            foreach ($DeadJob in $JobsToRemove) {
                try {
                    $StopHandle = $DeadJob.PS.BeginStop($null, $null)
                    $PendingDisposal.Add([PSCustomObject]@{ PS = $DeadJob.PS; Async = $StopHandle })
                } catch {
                    Write-DebugLogLocal "BeginStop() failed for $($DeadJob.IP): $_"
                    try { $DeadJob.PS.Dispose() } catch {}
                }

                # Abandoned jobs only. The reap is a machine-wide Win32_Process query, and
                # Connect-Switch.ps1 builds its ssh.exe command line from the same
                # Get-JunosSshArgs helper, so the filter cannot tell this crawl's leftover
                # process from an interactive session the operator opened to the same switch.
                # A job that completed normally has nothing left to reap anyway.
                if (-not $DeadJob.Abandoned) {
                    $Jobs.Remove($DeadJob) | Out-Null
                    continue
                }
                # -2s margin: $StartTime is DateTime.Now (~15.6ms quantization) while the filter
                # compares WMI's CreationDate, which can round below it even though $StartTime
                # was captured before BeginInvoke(). Safe to widen: $Visited means an IP is
                # never scanned twice in one crawl, so this can't reach another job's process.
                Stop-JunosOrphanProcessesLocal -TargetIP $DeadJob.IP -SinceTime $DeadJob.StartTime.AddSeconds(-2) -DebugLogPath $DebugLogPath

                $Jobs.Remove($DeadJob) | Out-Null
            }

            if ($ConsecutiveAuthFailures -ge $AuthFailureThreshold -or $TotalAuthFailures -ge $AuthFailureThreshold) {
                Write-DebugLogLocal "ORCHESTRATOR ABORT: consecutive=$ConsecutiveAuthFailures total=$TotalAuthFailures auth failures (threshold $AuthFailureThreshold) - aborting crawl to avoid a fleet-wide lockout."
                Write-Host "`n[!] Aborting crawl: repeated authentication failures ($TotalAuthFailures total) - check the credential before retrying (avoiding a possible account lockout)." -ForegroundColor Red
                $WasAborted = $true
                $AbortReason = "Aborted after $TotalAuthFailures authentication failures - check the credential before retrying."

                # Step 3 only handled jobs that completed or timed out this cycle; stop and reap
                # the still-in-flight ones here so breaking out below doesn't leak their
                # pipelines or ssh.exe children.
                foreach ($LiveJob in $Jobs) {
                    try {
                        $StopHandle = $LiveJob.PS.BeginStop($null, $null)
                        $PendingDisposal.Add([PSCustomObject]@{ PS = $LiveJob.PS; Async = $StopHandle })
                    } catch { try { $LiveJob.PS.Dispose() } catch {} }
                    # Same reasoning as the timeout and EndInvoke-error paths: killed mid-flight
                    # these devices are already in $Visited, so without a node they vanish.
                    $TopologyList.Add((New-PlaceholderNodeLocal -IP $LiveJob.IP -Status "Aborted" `
                        -ScanErrorText "Crawl aborted (repeated authentication failures) while this device was still being scanned."))
                    $PendingWrites++
                    # Same -2s margin as the step-3 cleanup above - see comment there.
                    Stop-JunosOrphanProcessesLocal -TargetIP $LiveJob.IP -SinceTime $LiveJob.StartTime.AddSeconds(-2) -DebugLogPath $DebugLogPath
                }
                $Jobs.Clear()

                # A retry waiting in the queue is in $Visited with no node and no live job, so
                # the sweep above cannot see it - without this it would vanish from the output
                # entirely, the same silent drop the Aborted placeholders exist to prevent.
                # Only IPs already dispatched at least once: an IP merely enqueued from a
                # neighbor was never visited and is not expected to have a node.
                foreach ($QueuedIP in @($Queue.ToArray())) {
                    if (-not $Attempts.ContainsKey($QueuedIP)) { continue }
                    Add-FinalNodeLocal -IP $QueuedIP -Status "Aborted" `
                        -ScanErrorText "Crawl aborted (repeated authentication failures) while this device was waiting to be retried."
                    $PendingWrites++
                }
                $Queue.Clear()
                break
            }

            # 4. Periodic snapshot write
            if ($PendingWrites -gt 0 -and ((Get-Date) - $LastWriteTime).TotalSeconds -gt $WriteIntervalSeconds) {
                try {
                    $WriteStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
                    Update-ClientIpCorrelationLocal -Topology $TopologyList
                    Write-TopologyOutputLocal -Topology $TopologyList -Path $TempOutputFile -ScanTimestampIso $ScanTimestampIso
                    Move-TopologyOutputAtomicLocal -SourcePath $TempOutputFile -DestinationPath $OutputFile
                    $WriteStopwatch.Stop()
                    # This whole block runs on the orchestrator thread, stealing time from job
                    # reaping while in-flight jobs' abandon timers keep running - and its cost
                    # grows with the fleet, since it re-correlates every client and re-serializes
                    # every device's full Configuration text each time (far worse under Windows
                    # PowerShell 5.1's JavaScriptSerializer-backed ConvertTo-Json). Back the
                    # interval off to ~10x the last write's duration so periodic writes stay
                    # around a tenth of the loop's time regardless of fleet size. The final write
                    # below is unconditional and unaffected.
                    $WriteIntervalSeconds = [Math]::Max($BaseWriteIntervalSeconds, [Math]::Min($MaxWriteIntervalSeconds, [int]($WriteStopwatch.Elapsed.TotalSeconds * 10)))
                    $PendingWrites = 0
                    $LastWriteTime = Get-Date
                } catch {
                    Write-DebugLogLocal "PERIODIC WRITE FAILED (will retry next cycle): $_"
                }
                [System.GC]::Collect()
            }

            Start-Sleep -Milliseconds 250
        }

        # $OnlyCompleted:$false: best-effort drain rather than waiting indefinitely - the crawl
        # is ending either way, so a wedged pipeline just gets abandoned.
        $AbandonedPipelines += Complete-PendingDisposalsLocal -OnlyCompleted:$false

        # No "next cycle" retry left, but a failure here must not stop the crawl reporting
        # completion - the caller still gets $TopologyList in memory.
        try {
            if ($PendingWrites -gt 0) {
                Update-ClientIpCorrelationLocal -Topology $TopologyList
                Write-TopologyOutputLocal -Topology $TopologyList -Path $TempOutputFile -ScanTimestampIso $ScanTimestampIso
                Move-TopologyOutputAtomicLocal -SourcePath $TempOutputFile -DestinationPath $OutputFile
            }
        } catch {
            Write-DebugLogLocal "FINAL WRITE FAILED: $_"
            Write-Host "`n[!] Final snapshot write failed: $_" -ForegroundColor Red
        }

        Write-Host "`n`n=================================================" -ForegroundColor Cyan
        if ($WasAborted) {
            Write-Host "Crawl Aborted! Processed $($Visited.Count) device(s) before stopping." -ForegroundColor Red
        } else {
            Write-Host "Mapping Complete! Processed $($Visited.Count) devices." -ForegroundColor Green
        }
        Write-Host "Topology saved to: $OutputFile" -ForegroundColor White
        Write-Host "=================================================" -ForegroundColor Cyan

        # Cleared alongside Done: these are only refreshed at the top of the loop, so without
        # this a post-crawl status poll keeps reporting in-flight work that no longer exists.
        $ProgressTable.ActiveJobs = 0
        $ProgressTable.QueueDepth = $Queue.Count
        $ProgressTable.Done = $true
        return @{ Topology = $TopologyList; ScanTimestampIso = $ScanTimestampIso; OutputFile = $OutputFile; VisitedCount = $Visited.Count; Aborted = $WasAborted; AbortReason = $AbortReason }
    }
    catch {
        # An unexpected throw would otherwise skip the final write and never set
        # ProgressTable.Done, leaving a web-triggered scan polling forever. NOT reached by
        # Ctrl+C - a pipeline stop goes straight to finally.
        Write-DebugLogLocal "ORCHESTRATOR FATAL: unhandled error in crawl loop: $_"
        Write-Host "`n[!] Unexpected crawl error: $_" -ForegroundColor Red
        try {
            if ($TopologyList.Count -gt 0) {
                Update-ClientIpCorrelationLocal -Topology $TopologyList
                Write-TopologyOutputLocal -Topology $TopologyList -Path $TempOutputFile -ScanTimestampIso $ScanTimestampIso
                Move-TopologyOutputAtomicLocal -SourcePath $TempOutputFile -DestinationPath $OutputFile
                Write-Host "[!] Salvaged $($TopologyList.Count) already-crawled device(s) to $OutputFile before aborting." -ForegroundColor Yellow
            }
        } catch {
            Write-DebugLogLocal "ORCHESTRATOR FATAL: emergency salvage write also failed: $_"
        }
        $ProgressTable.ActiveJobs = 0
        $ProgressTable.QueueDepth = $Queue.Count
        $ProgressTable.Done = $true
        throw
    }
    finally {
        # An interrupted crawl (Ctrl+C, or any exit skipping the cleanup paths above) reaches
        # here with jobs still in $Jobs - stop and reap them the same way so it doesn't leak
        # in-flight pipelines and their ssh.exe children.
        foreach ($LiveJob in $Jobs) {
            try {
                $StopHandle = $LiveJob.PS.BeginStop($null, $null)
                $PendingDisposal.Add([PSCustomObject]@{ PS = $LiveJob.PS; Async = $StopHandle })
            } catch { try { $LiveJob.PS.Dispose() } catch {} }
            # Same -2s margin as the step-3 cleanup above - see comment there.
            Stop-JunosOrphanProcessesLocal -TargetIP $LiveJob.IP -SinceTime $LiveJob.StartTime.AddSeconds(-2) -DebugLogPath $DebugLogPath
        }
        $Jobs.Clear()

        # The normal-exit path already drains this, but the re-throw from the catch above skips
        # that, leaving whatever is still pending to leak.
        $AbandonedPipelines += Complete-PendingDisposalsLocal -OnlyCompleted:$false

        # Close() blocks on a runspace still inside an uninterruptible native call for exactly
        # as long as Dispose() does, so closing synchronously here would just move the stall the
        # drain above exists to prevent. Close asynchronously, wait the same bounded window, and
        # abandon the pool to the process if it hasn't finished - Dispose() would block too, so
        # it only runs once the close completed.
        try {
            $CloseHandle = $RunspacePool.BeginClose($null, $null)
            # No wait at all when the drain already gave up on a pipeline: the same wedged
            # runspace is what the close is waiting for, so the window can only expire.
            $CloseClock = [System.Diagnostics.Stopwatch]::StartNew()
            while (-not $CloseHandle.IsCompleted -and $AbandonedPipelines -eq 0 -and $CloseClock.Elapsed.TotalSeconds -lt $FinalDrainSeconds) { [System.Threading.Thread]::Sleep(100) }
            if ($CloseHandle.IsCompleted) {
                $RunspacePool.EndClose($CloseHandle)
                $RunspacePool.Dispose()
            } else {
                Write-DebugLogLocal "ORCHESTRATOR: runspace pool still closing after $($FinalDrainSeconds)s - abandoned rather than blocking on Close()."
            }
        } catch {
            Write-DebugLogLocal "ORCHESTRATOR: runspace pool close failed: $_"
        }
        if (Test-Path $TempOutputFile) { Remove-Item -LiteralPath $TempOutputFile -Force }
    }
}

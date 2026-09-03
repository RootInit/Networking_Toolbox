# The fleet crawl loop, shared by Start-NetworkMapper.ps1's CLI path and WebServer.ps1's
# /api/scan-network endpoint so both use identical crawl logic.
#
# Not meant to be run directly - dot-source it, then call Invoke-FleetCrawl.

. (Join-Path $PSScriptRoot "TopologyCrypto.ps1")
. (Join-Path $PSScriptRoot "SshHelpers.ps1")

function Invoke-FleetCrawl {
    param(
        [Parameter(Mandatory=$true)][string]$StartIP,
        [Parameter(Mandatory=$true)][string[]]$AllowedScopes,
        [Parameter(Mandatory=$true)][int]$MaxConcurrent,
        [Parameter(Mandatory=$true)][string]$WorkerPath,
        [Parameter(Mandatory=$true)][string]$Username,
        [Parameter(Mandatory=$true)][string]$Password,
        [Parameter(Mandatory=$true)][string]$SnapshotDir,
        # Mandatory even for callers that don't use it, to keep the contract uniform. The web
        # path shares this hashtable instance with its polling HTTP handler; single writer
        # (this function) / single reader (poll handler), so no locking needed.
        [Parameter(Mandatory=$true)][hashtable]$ProgressTable,
        # All four present = encrypted output; all four absent (default) = plain .json.
        # Matches -NoEncryption's existing meaning one level up in the caller.
        [byte[]]$EncKey,
        [byte[]]$MacKey,
        [byte[]]$Salt,
        [int]$Iterations,
        [string]$DebugLogPath,
        [switch]$Log
    )

    # A new crawl session starts here - sweep up any plaintext credential/askpass files a prior
    # crashed run (this crawl or Connect-Switch.ps1) left behind in %TEMP% before workers start
    # writing their own.
    Clear-StaleJunosTempFiles

    $Encrypted = $null -ne $EncKey
    # Swallow logging failures (e.g. read-only log dir) - losing a debug line shouldn't kill the crawl.
    function Write-DebugLogLocal {
        param([string]$Message)
        if ($DebugLogPath) {
            try { "[$(Get-Date -Format 'HH:mm:ss')] $Message" | Out-File -FilePath $DebugLogPath -Append -Encoding utf8 } catch {}
        }
    }
    # -Encoding utf8 required here: Windows PowerShell 5.1's Out-File default is UTF-16LE
    # with a BOM, which would make this header a different encoding than the utf8 lines
    # appended after it, causing the whole file to be misread as UTF-16LE.
    if ($DebugLogPath) { try { "=== Fleet Crawl Debug Log - $(Get-Date) ===" | Out-File -FilePath $DebugLogPath -Force -Encoding utf8 } catch {} }

    # Single write path for init/periodic/final writes so encryption is wired in once.
    function Write-TopologyOutputLocal {
        param($Topology, [string]$Path, [string]$ScanTimestampIso)
        $PlainJson = @{ Topology = $Topology; ScanTimestamp = $ScanTimestampIso } | ConvertTo-Json -Depth 100
        if ($Encrypted) {
            $Envelope = Protect-TopologyPayload -PlainJson $PlainJson -EncKey $EncKey -MacKey $MacKey -Salt $Salt -Iterations $Iterations
            $Envelope | ConvertTo-Json -Depth 5 | Out-File -FilePath $Path -Encoding utf8
        } else {
            $PlainJson | Out-File -FilePath $Path -Encoding utf8
        }
    }

    # Every worker's ssh.exe is launched (inside Get-JunosNodeData.ps1) as `cmd.exe /c ssh.exe
    # ...` from THIS process's runspace pool, so both cmd.exe and its ssh.exe grandchild are
    # OS-level descendants of the current PID - not of any handle FleetCrawl.ps1 holds.
    # $PS.Stop()/.Dispose() only tear down the managed PowerShell pipeline; they have no idea a
    # native grandchild process exists, so abandoning a hung job leaks a live ssh.exe with its
    # TCP session to the switch still open. Since many jobs share this one parent PID
    # concurrently, match candidates on command line (the target IP is always the last ssh.exe
    # argument, "$Username@$TargetIP") plus creation time (>= this job's start), not just name.
    function Stop-JunosOrphanProcessesLocal {
        param([Parameter(Mandatory=$true)][string]$TargetIP, [Parameter(Mandatory=$true)][datetime]$SinceTime)
        try {
            # Anchored on the literal "$Username@$TargetIP" token Get-JunosSshArgs always
            # appends last (see SshHelpers.ps1). A bare "*$TargetIP*" wildcard would also match
            # e.g. 10.1.1.5 against a concurrently-running job for 10.1.1.50-59, killing a
            # healthy in-flight scan instead of only the abandoned one.
            $Candidates = Get-CimInstance Win32_Process -Filter "Name='ssh.exe' OR Name='cmd.exe'" -ErrorAction Stop |
                Where-Object { $_.CommandLine -and $_.CommandLine -match "@$([regex]::Escape($TargetIP))(\s|$)" -and $_.CreationDate -ge $SinceTime }
            # Kill ssh.exe before cmd.exe: once the cmd.exe parent is gone there's no longer a
            # process-tree link to fall back on if a later scan's command-line match ever misses.
            foreach ($Proc in ($Candidates | Sort-Object { if ($_.Name -eq 'ssh.exe') { 0 } else { 1 } })) {
                try {
                    Stop-Process -Id $Proc.ProcessId -Force -ErrorAction Stop
                    Write-DebugLogLocal "ORCHESTRATOR CLEANUP: killed orphaned $($Proc.Name) (PID $($Proc.ProcessId)) for $TargetIP"
                } catch {
                    Write-DebugLogLocal "ORCHESTRATOR CLEANUP: failed to kill orphan PID $($Proc.ProcessId) ($($Proc.Name)) for $($TargetIP): $_"
                }
            }
        } catch {
            Write-DebugLogLocal "ORCHESTRATOR CLEANUP: Stop-JunosOrphanProcessesLocal failed for $($TargetIP): $_"
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
    $TempOutputFile = Join-Path $SnapshotDir "NetworkMap_$ScanTimestamp.tmp$OutputExtension"

    $RunspacePool = [runspacefactory]::CreateRunspacePool(1, $MaxConcurrent)
    $RunspacePool.Open()

    $Jobs = [System.Collections.Generic.List[PSCustomObject]]::new()
    $Queue = [System.Collections.Generic.Queue[string]]::new()
    $Visited = [System.Collections.Generic.HashSet[string]]::new()
    $Enqueued = [System.Collections.Generic.HashSet[string]]::new()
    $TopologyList = [System.Collections.Generic.List[object]]::new()

    $Queue.Enqueue($StartIP)
    $Enqueued.Add($StartIP) | Out-Null
    $LastWriteTime = Get-Date
    $PendingWrites = 0

    # Circuit breaker: the same Username/Password is retried against every device in the queue.
    # On a TACACS+/RADIUS estate with lockout-after-N-failed-attempts, one mistyped password
    # could otherwise lock the account out fleet-wide. Track consecutive AuthFailed results and
    # abort early (rather than hammering every remaining device with the same bad credential)
    # once the streak crosses a small threshold. Any non-AuthFailed result resets the streak,
    # so this only fires on a genuine run of failures, not a few scattered ones.
    $ConsecutiveAuthFailures = 0
    $TotalAuthFailures = 0
    $AuthFailureThreshold = 3
    # Set when the circuit breaker trips below, so the caller (WebServer.ps1's poll handler /
    # the CLI path) can distinguish an aborted crawl from a genuinely complete one - both
    # otherwise fall into the same post-loop return.
    $WasAborted = $false
    $AbortReason = $null

    # PowerShell instances whose async Stop() (BeginStop) is in flight, awaiting EndStop()+
    # Dispose() once it actually completes - see the "async stop" comment at the cleanup site
    # below for why this can't just be done inline.
    $PendingDisposal = [System.Collections.Generic.List[PSCustomObject]]::new()

    function Complete-PendingDisposalsLocal {
        param([bool]$OnlyCompleted = $true)
        for ($i = $PendingDisposal.Count - 1; $i -ge 0; $i--) {
            $Entry = $PendingDisposal[$i]
            if ($Entry.Async.IsCompleted) {
                try { $Entry.PS.EndStop($Entry.Async) } catch {}
                try { $Entry.PS.Dispose() } catch {}
                $PendingDisposal.RemoveAt($i)
            } elseif (-not $OnlyCompleted) {
                # Final drain, entry not actually done yet: EndStop() blocks until completion
                # just like the original Stop() call did, so don't call it here - that would
                # reintroduce the exact hang this fix removes. Dispose() alone is the
                # documented Stop()-then-dispose behavior too, but this only runs once, at
                # crawl shutdown, on whatever (rare) entry hasn't finished in the 250ms-polled
                # window since it was abandoned - an acceptable, bounded, one-time cost instead
                # of a risk in the hot per-iteration path.
                try { $Entry.PS.Dispose() } catch {}
                $PendingDisposal.RemoveAt($i)
            }
        }
    }

    try {
        Write-Host "`nStarting Crawl with $MaxConcurrent Threads. Press Ctrl+C to abort gracefully.`n" -ForegroundColor Yellow

        # Temp-file + Move-Item, same pattern as every later write in this function (periodic,
        # final, and the emergency-salvage write in the catch block below) - a partway failure
        # here (e.g. disk full) then leaves no half-written $OutputFile behind instead of a
        # truncated one a poller could read mid-write. Inside the try (not above it) so a
        # Move-Item failure here still hits the catch below (an empty-topology salvage write is
        # a harmless no-op at this point) and the finally still reaps the leftover .tmp file.
        Write-TopologyOutputLocal -Topology @() -Path $TempOutputFile -ScanTimestampIso $ScanTimestampIso
        Move-Item -Path $TempOutputFile -Destination $OutputFile -Force

        while ($Queue.Count -gt 0 -or $Jobs.Count -gt 0) {

            # 0. Finish off any async Stop()s that completed since the last iteration (loop
            # ticks every 250ms below, so this is cheap and never blocks).
            Complete-PendingDisposalsLocal

            # 1. Fill available thread slots (Safely dequeueing)
            #
            # The circuit breaker below only counts COMPLETED results, so it can't stop the
            # very first wave of dispatches: with $MaxConcurrent=10 and $AuthFailureThreshold=3,
            # up to 10 jobs can already be in flight against a bad credential before the
            # breaker has anything to count. Once ANY auth failure has been observed, throttle
            # new dispatches to 1-per-iteration (~1 every 250ms) instead of filling every free
            # slot, so exposure to a confirmed-bad credential is bounded even while the breaker
            # is still accumulating enough evidence to trip. Full-speed dispatch otherwise.
            $DispatchLimitThisIteration = if ($TotalAuthFailures -gt 0) { 1 } else { $MaxConcurrent }
            $DispatchedThisIteration = 0
            while ($Jobs.Count -lt $MaxConcurrent -and $Queue.Count -gt 0 -and $DispatchedThisIteration -lt $DispatchLimitThisIteration) {
                $NextIP = $Queue.Dequeue()
                if (!$Visited.Add($NextIP)) { continue }

                # A Create()/BeginInvoke() failure must not kill the crawl - log it, drop this
                # IP, keep going. Reset $PS before the try: since it's function-scoped (not
                # per-iteration), a throw here would otherwise leave $PS pointing at the
                # previous iteration's live job, which the catch below would then Dispose().
                $PS = $null
                try {
                    $PS = [powershell]::Create().AddCommand($WorkerPath).AddParameter("TargetIP", $NextIP).AddParameter("Username", $Username).AddParameter("Password", $Password)
                    if ($Log) { $PS.AddParameter("Log") | Out-Null }

                    $PS.RunspacePool = $RunspacePool
                    # Captured BEFORE BeginInvoke() (not after): BeginInvoke() can start
                    # executing on a runspace thread pool thread immediately, so its native
                    # ssh.exe grandchild's actual CreationDate could otherwise land slightly
                    # earlier than a StartTime captured after the call returns - letting a
                    # genuinely orphaned process for this job slip past
                    # Stop-JunosOrphanProcessesLocal's "CreationDate -ge SinceTime" filter.
                    $JobStartTime = Get-Date
                    $Handle = $PS.BeginInvoke()
                    $Jobs.Add([PSCustomObject]@{ PS = $PS; Handle = $Handle; IP = $NextIP; StartTime = $JobStartTime })
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
                if (-not $Job.Handle.IsCompleted -and ((Get-Date) - $Job.StartTime).TotalSeconds -gt 65) {
                    Write-DebugLogLocal "ORCHESTRATOR TIMEOUT: Abandoning hung thread for $($Job.IP)"
                    Write-Host "`n[!] Timed out waiting on $($Job.IP) - abandoning and continuing." -ForegroundColor Red

                    # Previously this device was just dropped from $TopologyList - silently
                    # different from a worker-level failure (bad password, connection refused),
                    # which DOES get added with its own ScanStatus. Add a synthetic minimal node
                    # so both failure classes are represented consistently for the UI/consumers.
                    # Mirrors Get-JunosNodeData.ps1's $NodeData initializer field-for-field
                    # (Devices consuming this - the web UI - are owned by other agents; a node
                    # missing keys a real one always has would fail there, not here) plus the
                    # ScanStatus/ScanError contract.
                    $TimeoutNode = @{
                        DeviceIP = $Job.IP; Hostname = "Unknown"; JunosVersion = "Unknown"; Gateway = "Unknown";
                        StackMembers = @(); Neighbors = @(); Clients = @(); ArpEntries = @(); Interfaces = @{};
                        Uptime = "Unknown"; LastConfigured = "Unknown"; LastConfiguredBy = "Unknown"; Alarms = @();
                        MasterCpuUtilization = "Unknown"; MasterMemoryUtilization = "Unknown";
                        MedNeighbors = @(); Configuration = "Unknown";
                        ScanStatus = "Timeout"
                        ScanError  = "Orchestrator gave up waiting on $($Job.IP) after 65s (job abandoned)."
                    }
                    $TopologyList.Add($TimeoutNode)
                    $PendingWrites++
                    # A timeout isn't an auth failure - only reset the consecutive streak
                    # (not $TotalAuthFailures, which is a whole-crawl tally per the circuit
                    # breaker's "3 in a row, OR across the whole crawl" requirement).
                    $ConsecutiveAuthFailures = 0

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

                        if ($Result -and $Result.Node) {
                            $Node = $Result.Node
                            if ($Result.Logs) { foreach ($LogLine in $Result.Logs) { Write-DebugLogLocal $LogLine } }

                            Write-Host "`n[+] Finished $($Job.IP) ($($Node.Hostname)) - $($Node.Neighbors.Count) Neighbors, $($Node.Clients.Count) Clients" -ForegroundColor Green

                            # Added before the neighbor loop so a malformed neighbor entry
                            # throwing partway through doesn't cost the node its already-
                            # collected data.
                            $TopologyList.Add($Node)
                            $PendingWrites++

                            if ($Node.ScanStatus -eq "AuthFailed") {
                                $ConsecutiveAuthFailures++
                                $TotalAuthFailures++
                                Write-DebugLogLocal "ORCHESTRATOR: auth failures - consecutive=$ConsecutiveAuthFailures total=$TotalAuthFailures (threshold $AuthFailureThreshold)"
                            } else {
                                $ConsecutiveAuthFailures = 0
                            }

                            # Own try/catch, local to just this loop: $Node was already added to
                            # $TopologyList above with real, fully-collected data. A malformed
                            # neighbor entry throwing partway through (e.g. ManagementIP isn't a
                            # plain string and .StartsWith() throws) must not fall into the outer
                            # EndInvoke catch below - that catch synthesizes a ScanStatus="Error"
                            # placeholder node for $Job.IP, which would land in $TopologyList
                            # ALONGSIDE the real $Node just added, and since every consumer does
                            # last-write-wins by DeviceIP, the placeholder would silently clobber
                            # the good data. So: log and continue here instead.
                            try {
                                foreach ($Neigh in $Node.Neighbors) {
                                    $NIP = $Neigh.ManagementIP
                                    if ([string]::IsNullOrEmpty($NIP)) { continue }
                                    $InScope = $false
                                    foreach ($Scope in $AllowedScopes) { if ($NIP.StartsWith($Scope)) { $InScope = $true; break } }

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
                            # Shouldn't happen (Get-JunosNodeData always returns a Node), but
                            # log it rather than let the device vanish silently.
                            Write-DebugLogLocal "ORCHESTRATOR WARNING: $($Job.IP) produced no result (worker returned nothing)."
                            Write-Host "`n[!] $($Job.IP) produced no result - skipping." -ForegroundColor Red
                        }
                    } catch {
                        Write-DebugLogLocal "ORCHESTRATOR ERROR parsing result from $($Job.IP): $_"
                        Write-Host "`n[!] Error processing result from $($Job.IP): $_" -ForegroundColor Red

                        # Same reasoning as the timeout path above: without a synthesized node
                        # this device silently vanishes from the output (it was already marked
                        # $Visited before the job ran, so it's never retried either). Mirrors
                        # $TimeoutNode field-for-field, distinguished by ScanStatus.
                        $ErrorNode = @{
                            DeviceIP = $Job.IP; Hostname = "Unknown"; JunosVersion = "Unknown"; Gateway = "Unknown";
                            StackMembers = @(); Neighbors = @(); Clients = @(); ArpEntries = @(); Interfaces = @{};
                            Uptime = "Unknown"; LastConfigured = "Unknown"; LastConfiguredBy = "Unknown"; Alarms = @();
                            MasterCpuUtilization = "Unknown"; MasterMemoryUtilization = "Unknown";
                            MedNeighbors = @(); Configuration = "Unknown";
                            ScanStatus = "Error"
                            ScanError  = "Orchestrator failed to process result from $($Job.IP): $_"
                        }
                        $TopologyList.Add($ErrorNode)
                        $PendingWrites++
                    } finally {
                        $JobsToRemove += $Job
                    }
                }
            }

            # 3. Clean up processed or hung jobs.
            #
            # PowerShell.Stop() is a documented SYNCHRONOUS API: it blocks the calling thread
            # until the pipeline has actually stopped, and can't preempt an uninterruptible
            # native call inside the worker (e.g. Process.WaitForExit, or a blocked
            # StandardInput.WriteLine on a dead pipe). This crawl loop is single-threaded, so a
            # stuck pipeline could freeze the *entire* crawl right here despite already having
            # logged "abandoning and continuing" above. Use the async BeginStop() instead - it
            # returns immediately - and defer EndStop()+Dispose() to $PendingDisposal, drained
            # once each async Stop() actually completes (step 0 above, polled every 250ms). A
            # scriptblock passed as BeginStop's AsyncCallback would run on an arbitrary
            # threadpool thread with no PowerShell runspace attached, which is unreliable for
            # invoking PS methods - polling from the main loop avoids that entirely and never
            # blocks it.
            foreach ($DeadJob in $JobsToRemove) {
                try {
                    $StopHandle = $DeadJob.PS.BeginStop($null, $null)
                    $PendingDisposal.Add([PSCustomObject]@{ PS = $DeadJob.PS; Async = $StopHandle })
                } catch {
                    Write-DebugLogLocal "BeginStop() failed for $($DeadJob.IP): $_"
                    try { $DeadJob.PS.Dispose() } catch {}
                }

                # Also reap any orphaned ssh.exe/cmd.exe OS child process this job may have left
                # running - see Stop-JunosOrphanProcessesLocal above for why PS.Stop()/Dispose()
                # alone can't do this.
                # -2s safety margin: $StartTime is DateTime.Now (~15.6ms timer quantization),
                # while the orphan filter compares against WMI's CreationDate - different
                # precisions, so CreationDate can still round below a bare $StartTime even with
                # it captured before BeginInvoke(). $Visited means this IP is never scanned
                # twice in one crawl, so a wider window here can't ever reach a different job's
                # process for the same IP.
                Stop-JunosOrphanProcessesLocal -TargetIP $DeadJob.IP -SinceTime $DeadJob.StartTime.AddSeconds(-2)

                $Jobs.Remove($DeadJob) | Out-Null
            }

            # Circuit breaker: bail out of the crawl before hammering more devices with a
            # credential that's clearly failing repeatedly. Either 3-in-a-row or 3 total across
            # the whole crawl trips it, so an estate that interleaves scattered auth failures
            # with unrelated timeouts (which reset the consecutive streak but not the total)
            # still gets caught.
            if ($ConsecutiveAuthFailures -ge $AuthFailureThreshold -or $TotalAuthFailures -ge $AuthFailureThreshold) {
                Write-DebugLogLocal "ORCHESTRATOR ABORT: consecutive=$ConsecutiveAuthFailures total=$TotalAuthFailures auth failures (threshold $AuthFailureThreshold) - aborting crawl to avoid a fleet-wide lockout."
                Write-Host "`n[!] Aborting crawl: repeated authentication failures ($TotalAuthFailures total) - check the credential before retrying (avoiding a possible account lockout)." -ForegroundColor Red
                $WasAborted = $true
                $AbortReason = "Aborted after $TotalAuthFailures authentication failures - check the credential before retrying."

                # Jobs still in flight at this point weren't touched by step 3 above (that only
                # handled completed/timed-out ones this cycle) - stop/dispose and reap them here
                # too so breaking out of the loop below doesn't leak their pipelines or ssh.exe
                # children the same way an abandoned timeout would.
                foreach ($LiveJob in $Jobs) {
                    try {
                        $StopHandle = $LiveJob.PS.BeginStop($null, $null)
                        $PendingDisposal.Add([PSCustomObject]@{ PS = $LiveJob.PS; Async = $StopHandle })
                    } catch { try { $LiveJob.PS.Dispose() } catch {} }
                    # Same -2s margin as the step-3 cleanup above - see comment there.
                    Stop-JunosOrphanProcessesLocal -TargetIP $LiveJob.IP -SinceTime $LiveJob.StartTime.AddSeconds(-2)
                }
                $Jobs.Clear()
                break
            }

            # 4. Batch JSON Write (Only write if pending data exists AND 5 seconds have passed)
            if ($PendingWrites -gt 0 -and ((Get-Date) - $LastWriteTime).TotalSeconds -gt 5) {
                try {
                    Update-ClientIpCorrelationLocal -Topology $TopologyList
                    Write-TopologyOutputLocal -Topology $TopologyList -Path $TempOutputFile -ScanTimestampIso $ScanTimestampIso
                    Move-Item -Path $TempOutputFile -Destination $OutputFile -Force
                    $PendingWrites = 0
                    $LastWriteTime = Get-Date
                } catch {
                    Write-DebugLogLocal "PERIODIC WRITE FAILED (will retry next cycle): $_"
                }
                [System.GC]::Collect()
            }

            Start-Sleep -Milliseconds 250
        }

        # Drain any still-pending async Stop()s (from the last iteration's cleanup, or the
        # circuit breaker's abort path) before returning. $OnlyCompleted:$false forces a final
        # best-effort EndStop()+Dispose() on whatever hasn't finished yet rather than waiting
        # indefinitely - the crawl is ending either way, so a wedged pipeline here just gets
        # abandoned the same as PS.Stop() would previously have blocked on.
        Complete-PendingDisposalsLocal -OnlyCompleted:$false

        # Last write this run gets (no "next cycle" retry like step 4). A failure here must
        # not stop the crawl from reporting completion - the caller still gets $TopologyList
        # in memory even if the on-disk snapshot is stale.
        try {
            if ($PendingWrites -gt 0) {
                Update-ClientIpCorrelationLocal -Topology $TopologyList
                Write-TopologyOutputLocal -Topology $TopologyList -Path $TempOutputFile -ScanTimestampIso $ScanTimestampIso
                Move-Item -Path $TempOutputFile -Destination $OutputFile -Force
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

        $ProgressTable.Done = $true
        return @{ Topology = $TopologyList; ScanTimestampIso = $ScanTimestampIso; OutputFile = $OutputFile; VisitedCount = $Visited.Count; Aborted = $WasAborted; AbortReason = $AbortReason }
    }
    catch {
        # An unexpected throw in the loop above would otherwise skip the final write and
        # never set ProgressTable.Done (a web-triggered scan would poll forever). Salvage
        # what was already collected before re-throwing.
        #
        # NOT reached by Ctrl+C - a pipeline-stop terminates the runspace immediately,
        # skipping straight to finally.
        Write-DebugLogLocal "ORCHESTRATOR FATAL: unhandled error in crawl loop: $_"
        Write-Host "`n[!] Unexpected crawl error: $_" -ForegroundColor Red
        try {
            if ($TopologyList.Count -gt 0) {
                Update-ClientIpCorrelationLocal -Topology $TopologyList
                # Temp file + Move-Item (not a direct write) so a partway failure here
                # doesn't replace a good prior snapshot with a truncated one.
                Write-TopologyOutputLocal -Topology $TopologyList -Path $TempOutputFile -ScanTimestampIso $ScanTimestampIso
                Move-Item -Path $TempOutputFile -Destination $OutputFile -Force
                Write-Host "[!] Salvaged $($TopologyList.Count) already-crawled device(s) to $OutputFile before aborting." -ForegroundColor Yellow
            }
        } catch {
            Write-DebugLogLocal "ORCHESTRATOR FATAL: emergency salvage write also failed: $_"
        }
        $ProgressTable.Done = $true
        throw
    }
    finally {
        # Belt-and-suspenders: the normal-exit path already drains this before returning, but
        # an unhandled throw from the `catch` block above (re-thrown, so it skips that drain)
        # would otherwise leak whatever's still pending here.
        Complete-PendingDisposalsLocal -OnlyCompleted:$false
        $RunspacePool.Close(); $RunspacePool.Dispose()
        if (Test-Path $TempOutputFile) { Remove-Item -Path $TempOutputFile -Force }
    }
}

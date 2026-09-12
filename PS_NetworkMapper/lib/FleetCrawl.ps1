# The fleet crawl loop, shared by Start-NetworkMapper.ps1's CLI path and WebServer.ps1's
# /api/scan-network endpoint. Dot-source it, then call Invoke-FleetCrawl.

. (Join-Path $PSScriptRoot "TopologyCrypto.ps1")
. (Join-Path $PSScriptRoot "SshHelpers.ps1")
. (Join-Path $PSScriptRoot "FileHelpers.ps1")

# The single scope fence, also called from WebServer.ps1 so a manually-entered entry-point IP gets
# the same rules. Not a bare prefix match: "10.1" must not match "10.19.5.5".
function Test-IpInAllowedScopes {
    param([string]$IP, [string[]]$AllowedScopes)

    if ([string]::IsNullOrEmpty($IP)) { return $false }
    foreach ($Scope in $AllowedScopes) {
        $ScopeTrimmed = $Scope.TrimEnd('.')
        if ($IP -eq $ScopeTrimmed -or $IP.StartsWith("$ScopeTrimmed.")) { return $true }
    }
    return $false
}

# A worker's ssh.exe is an OS-level grandchild that $PS.Stop()/.Dispose() know nothing about, so
# abandoning a hung job leaks a live session. Candidates match on command line plus creation time.
# -DebugLogPath must be explicit: PowerShell resolves unscoped names via the CALL STACK.
function Stop-JunosOrphanProcessesLocal {
    param([Parameter(Mandatory=$true)][string]$TargetIP, [Parameter(Mandatory=$true)][datetime]$SinceTime, [string]$DebugLogPath)
    function Write-OrphanCleanupLogLocal {
        param([string]$Message)
        if ($DebugLogPath) {
            try { "[$(Get-Date -Format 'HH:mm:ss')] $Message" | Out-File -FilePath $DebugLogPath -Append -Encoding utf8 } catch {}
        }
    }
    try {
        # Anchored on the "$Username@$TargetIP" token: "*10.1.1.5*" would also match 10.1.1.50-59.
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
        # Shared with the polling HTTP handler: single writer here, single reader there, so no lock.
        [Parameter(Mandatory=$true)][hashtable]$ProgressTable,
        # All four present = encrypted output; all four absent = plain .json.
        [byte[]]$EncKey,
        [byte[]]$MacKey,
        [byte[]]$Salt,
        [int]$Iterations,
        [string]$DebugLogPath,
        [switch]$Log
    )

    # Sweep up plaintext credential/askpass files a prior crashed run left in %TEMP%.
    Clear-StaleJunosTempFiles

    $Encrypted = $null -ne $EncKey
    # Swallow logging failures (e.g. read-only log dir) - losing a debug line shouldn't kill the crawl.
    function Write-DebugLogLocal {
        param([string]$Message)
        if ($DebugLogPath) {
            try { "[$(Get-Date -Format 'HH:mm:ss')] $Message" | Out-File -FilePath $DebugLogPath -Append -Encoding utf8 } catch {}
        }
    }
    # -Encoding utf8 required: 5.1's Out-File default is UTF-16LE with a BOM.
    if ($DebugLogPath) { try { "=== Fleet Crawl Debug Log - $(Get-Date) ===" | Out-File -FilePath $DebugLogPath -Force -Encoding utf8 } catch {} }

    # Single write path for init/periodic/final writes so encryption is wired in once.
    function Write-TopologyOutputLocal {
        param($Topology, [string]$Path, [string]$ScanTimestampIso)
        $PlainJson = @{ Topology = $Topology; ScanTimestamp = $ScanTimestampIso } | ConvertTo-Json -Depth 100
        if ($Encrypted) {
            $Envelope = Protect-TopologyPayload -PlainJson $PlainJson -EncKey $EncKey -MacKey $MacKey -Salt $Salt -Iterations $Iterations
            $Envelope | ConvertTo-Json -Depth 5 | Out-File -FilePath $Path -Encoding utf8
        } else {
            # An unencrypted snapshot holds every device's unredacted config, so touch the file empty
            # and harden its ACL BEFORE the plaintext lands.
            [System.IO.File]::WriteAllText((Resolve-PathForDotNetIo -Path $Path), "")
            Protect-JunosSensitiveFileAcl -Path $Path
            $PlainJson | Out-File -FilePath $Path -Encoding utf8
        }
    }

    # Move-FileAtomic creates a fresh file with the default ACL on EVERY call, so the hardening runs
    # each time. Skipped when $Encrypted: an envelope is already opaque.
    function Move-TopologyOutputAtomicLocal {
        param([string]$SourcePath, [string]$DestinationPath)
        Move-FileAtomic -SourcePath $SourcePath -DestinationPath $DestinationPath
        if (-not $Encrypted) {
            Protect-JunosSensitiveFileAcl -Path $DestinationPath
        }
    }

    # Without a synthetic node a device that never produced one vanishes: its IP is in $Visited and
    # nothing re-dispatches it. Mirrors Get-JunosNodeData.ps1's $NodeData initializer field-for-field.
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

    # A client's ARP entry often lives on the L3 gateway, so backfill from a fleet-wide MAC->IP map.
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

    # INVARIANT: must exceed the worker's own worst case or the orchestrator abandons jobs still going
    # to succeed; no higher either, since a dead switch holds a runspace slot for the whole budget.
    # The worker's one SSH batch is capped at WaitForExit(120000); the remaining 25s covers the rest.
    $JobAbandonSeconds = 145
    $Queue = [System.Collections.Generic.Queue[string]]::new()
    $Visited = [System.Collections.Generic.HashSet[string]]::new()
    $Enqueued = [System.Collections.Generic.HashSet[string]]::new()
    $TopologyList = [System.Collections.Generic.List[object]]::new()

    # Retry pass for a device lost to a transient fault: the failed IP goes to the BACK of the same
    # queue, reusing dispatch, discovery, periodic writes and the circuit breaker. AuthFailed is
    # deliberately absent - retrying a bad credential locks the account out; Aborted, we're stopping.
    $RetryableStatuses = @("Timeout", "Partial", "Error", "Unreachable")
    $MaxAttempts = 2
    $Attempts = @{}
    # A Partial carries real data, so if the retry produces nothing the stashed node is still better.
    $LastFailedNode = @{}

    # $true means requeued and the caller must NOT record a node: last-write-wins would clobber it.
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

    # Prefers a discarded earlier attempt's data over an empty placeholder. Callers own $PendingWrites.
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

    # Circuit breaker: one mistyped password would otherwise lock the account out fleet-wide.
    $ConsecutiveAuthFailures = 0
    $TotalAuthFailures = 0
    $AuthFailureThreshold = 3
    # Lets the caller tell an aborted crawl from a complete one - both fall into the same return.
    $WasAborted = $false
    $AbortReason = $null

    # Instances whose BeginStop() is in flight, awaiting EndStop()+Dispose() once it completes.
    $PendingDisposal = [System.Collections.Generic.List[PSCustomObject]]::new()
    # Accumulated across both final drains, so the pool close below knows a pipeline was abandoned.
    $AbandonedPipelines = 0

    # Bounds the final drain: an aborted job can reach it having had no polling window at all.
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

        # Final drain. Dispose() blocks as long as the synchronous Stop() this avoids (a pipeline
        # wedged in WaitForExit(50000) freezes the orchestrator, and in the web path the HttpListener
        # loop), so give the stops a bounded window and abandon what is left. Ctrl+C breaks pipeline
        # OUTPUT, so anything reported from here must go to a file.
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

        # Inside the try so a failure here still reaches the catch and the finally reaps the .tmp.
        Write-TopologyOutputLocal -Topology @() -Path $TempOutputFile -ScanTimestampIso $ScanTimestampIso
        Move-TopologyOutputAtomicLocal -SourcePath $TempOutputFile -DestinationPath $OutputFile

        while ($Queue.Count -gt 0 -or $Jobs.Count -gt 0) {

            # 0. Finish off any async Stop()s that completed since the last iteration.
            $null = Complete-PendingDisposalsLocal

            # 1. Fill available thread slots. The circuit breaker only counts COMPLETED results, so it
            # can't stop the first wave: $MaxConcurrent jobs can be in flight against a bad credential.
            # Once ANY auth failure is seen, throttle to one dispatch per iteration.
            $DispatchLimitThisIteration = if ($TotalAuthFailures -gt 0) { 1 } else { $MaxConcurrent }
            $DispatchedThisIteration = 0
            while ($Jobs.Count -lt $MaxConcurrent -and $Queue.Count -gt 0 -and $DispatchedThisIteration -lt $DispatchLimitThisIteration) {
                $NextIP = $Queue.Dequeue()
                # A retry deliberately re-dispatches a visited IP, bounded by $MaxAttempts instead.
                $PriorAttempts = if ($Attempts.ContainsKey($NextIP)) { $Attempts[$NextIP] } else { 0 }
                if ($PriorAttempts -eq 0) {
                    if (!$Visited.Add($NextIP)) { continue }
                } elseif ($PriorAttempts -ge $MaxAttempts) {
                    continue
                }
                $Attempts[$NextIP] = $PriorAttempts + 1

                # Reset before the try: $PS is function-scoped and the catch would Dispose() a stale one.
                $PS = $null
                try {
                    $PS = [powershell]::Create().AddCommand($WorkerPath).AddParameter("TargetIP", $NextIP).AddParameter("Username", $Username).AddParameter("Password", $Password)
                    if ($Log) { $PS.AddParameter("Log") | Out-Null }
                    # A job abandoned as hung never reaches EndInvoke, so it must log as it goes.
                    if ($DebugLogPath) { $PS.AddParameter("DebugLogPath", $DebugLogPath) | Out-Null }

                    $PS.RunspacePool = $RunspacePool
                    # Captured BEFORE BeginInvoke(): its ssh.exe's CreationDate could predate a later stamp.
                    $JobStartTime = Get-Date
                    $Handle = $PS.BeginInvoke()
                    # Only a job we gave up on can have left an ssh.exe behind; a normal return cleaned up.
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
                    # A timeout resets only the streak; $TotalAuthFailures is a whole-crawl tally.
                    $ConsecutiveAuthFailures = 0

                    $Job.Abandoned = $true
                    $JobsToRemove += $Job
                    continue
                }

                if ($Job.Handle.IsCompleted) {
                    try {
                        $Result = $Job.PS.EndInvoke($Job.Handle)

                        # Non-terminating worker errors don't fail EndInvoke and surface nowhere else.
                        if ($Job.PS.HadErrors) {
                            foreach ($ErrRecord in $Job.PS.Streams.Error) {
                                Write-DebugLogLocal "WORKER ERROR STREAM ($($Job.IP)): $ErrRecord"
                            }
                        }

                        # Same for Write-Warning: hostless runspace jobs never display it.
                        if ($Job.PS.Streams.Warning.Count -gt 0) {
                            foreach ($WarnRecord in $Job.PS.Streams.Warning) {
                                Write-DebugLogLocal "WORKER WARNING STREAM ($($Job.IP)): $WarnRecord"
                            }
                        }

                        if ($Result -and $Result.Node) {
                            $Node = $Result.Node
                            # Only without $DebugLogPath: with it the worker already wrote these lines.
                            if (-not $DebugLogPath -and $Result.Logs) { foreach ($LogLine in $Result.Logs) { Write-DebugLogLocal $LogLine } }

                            # Dropped rather than recorded: the re-dispatch rediscovers the neighbors.
                            if (Request-JobRetryLocal -IP $Job.IP -Status $Node.ScanStatus) {
                                # The enclosing try's finally adds $Job to $JobsToRemove.
                                $LastFailedNode[$Job.IP] = $Node
                                Write-Host "`n[~] $($Job.IP) failed ($($Node.ScanStatus)) - queued for another attempt." -ForegroundColor Yellow
                                continue
                            }

                            Write-Host "`n[+] Finished $($Job.IP) ($($Node.Hostname)) - $($Node.Neighbors.Count) Neighbors, $($Node.Clients.Count) Clients" -ForegroundColor Green

                            # Before the neighbor loop, so a malformed neighbor can't cost the node its data.
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

                            # Own try/catch: a throw reaching the outer catch would append an "Error"
                            # placeholder that last-write-wins by DeviceIP would let clobber good data.
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
                            # Get-JunosNodeData always returns a Node, so the worker died before its own
                            # error handling could. Recorded, or the device vanishes from the output.
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

            # 3. Clean up processed or hung jobs. PowerShell.Stop() is synchronous and can't preempt an
            # uninterruptible native call, so a stuck pipeline would freeze this loop. BeginStop() returns
            # immediately; EndStop()+Dispose() are deferred to $PendingDisposal and drained by step 0.
            foreach ($DeadJob in $JobsToRemove) {
                try {
                    $StopHandle = $DeadJob.PS.BeginStop($null, $null)
                    $PendingDisposal.Add([PSCustomObject]@{ PS = $DeadJob.PS; Async = $StopHandle })
                } catch {
                    Write-DebugLogLocal "BeginStop() failed for $($DeadJob.IP): $_"
                    try { $DeadJob.PS.Dispose() } catch {}
                }

                # Abandoned jobs only: the reap is a machine-wide Win32_Process query and can't tell this
                # crawl's leftovers from an operator's own session to the same switch.
                if (-not $DeadJob.Abandoned) {
                    $Jobs.Remove($DeadJob) | Out-Null
                    continue
                }
                # -2s margin: DateTime.Now quantizes ~15.6ms while the filter compares WMI's CreationDate.
                Stop-JunosOrphanProcessesLocal -TargetIP $DeadJob.IP -SinceTime $DeadJob.StartTime.AddSeconds(-2) -DebugLogPath $DebugLogPath

                $Jobs.Remove($DeadJob) | Out-Null
            }

            if ($ConsecutiveAuthFailures -ge $AuthFailureThreshold -or $TotalAuthFailures -ge $AuthFailureThreshold) {
                Write-DebugLogLocal "ORCHESTRATOR ABORT: consecutive=$ConsecutiveAuthFailures total=$TotalAuthFailures auth failures (threshold $AuthFailureThreshold) - aborting crawl to avoid a fleet-wide lockout."
                Write-Host "`n[!] Aborting crawl: repeated authentication failures ($TotalAuthFailures total) - check the credential before retrying (avoiding a possible account lockout)." -ForegroundColor Red
                $WasAborted = $true
                $AbortReason = "Aborted after $TotalAuthFailures authentication failures - check the credential before retrying."

                # Step 3 only handled jobs that finished this cycle; reap the still-in-flight ones here.
                foreach ($LiveJob in $Jobs) {
                    try {
                        $StopHandle = $LiveJob.PS.BeginStop($null, $null)
                        $PendingDisposal.Add([PSCustomObject]@{ PS = $LiveJob.PS; Async = $StopHandle })
                    } catch { try { $LiveJob.PS.Dispose() } catch {} }
                    # Killed mid-flight these devices are already in $Visited, so without a node they vanish.
                    $TopologyList.Add((New-PlaceholderNodeLocal -IP $LiveJob.IP -Status "Aborted" `
                        -ScanErrorText "Crawl aborted (repeated authentication failures) while this device was still being scanned."))
                    $PendingWrites++
                    # Same -2s margin as the step-3 cleanup above - see comment there.
                    Stop-JunosOrphanProcessesLocal -TargetIP $LiveJob.IP -SinceTime $LiveJob.StartTime.AddSeconds(-2) -DebugLogPath $DebugLogPath
                }
                $Jobs.Clear()

                # A retry waiting in the queue is in $Visited with no node and no live job, so the sweep
                # above misses it. Only IPs already dispatched: a merely-enqueued IP has no node expected.
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
                    # This runs on the orchestrator thread while abandon timers keep running, and its
                    # cost grows with the fleet (re-correlating clients, re-serializing configs). Back the
                    # interval off to ~10x the last write's duration; the final write is unconditional.
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

        # Best-effort drain: the crawl is ending either way, so a wedged pipeline just gets abandoned.
        $AbandonedPipelines += Complete-PendingDisposalsLocal -OnlyCompleted:$false

        # A failure here must not stop the crawl reporting completion - the caller still gets the list.
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

        # Cleared alongside Done, or a post-crawl poll keeps reporting work that no longer exists.
        $ProgressTable.ActiveJobs = 0
        $ProgressTable.QueueDepth = $Queue.Count
        $ProgressTable.Done = $true
        return @{ Topology = $TopologyList; ScanTimestampIso = $ScanTimestampIso; OutputFile = $OutputFile; VisitedCount = $Visited.Count; Aborted = $WasAborted; AbortReason = $AbortReason }
    }
    catch {
        # Otherwise an unexpected throw skips the final write and leaves a web scan polling forever.
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
        # An interrupted crawl reaches here with jobs still in $Jobs - stop and reap them the same way.
        foreach ($LiveJob in $Jobs) {
            try {
                $StopHandle = $LiveJob.PS.BeginStop($null, $null)
                $PendingDisposal.Add([PSCustomObject]@{ PS = $LiveJob.PS; Async = $StopHandle })
            } catch { try { $LiveJob.PS.Dispose() } catch {} }
            Stop-JunosOrphanProcessesLocal -TargetIP $LiveJob.IP -SinceTime $LiveJob.StartTime.AddSeconds(-2) -DebugLogPath $DebugLogPath
        }
        $Jobs.Clear()

        # The normal-exit path drains this, but a re-throw from the catch above skips that.
        $AbandonedPipelines += Complete-PendingDisposalsLocal -OnlyCompleted:$false

        # Close() blocks on a wedged runspace as long as Dispose() does, so close asynchronously, wait
        # the same bounded window, and abandon the pool if it hasn't finished.
        try {
            $CloseHandle = $RunspacePool.BeginClose($null, $null)
            # No wait when the drain already gave up: the same wedged runspace is what the close awaits.
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

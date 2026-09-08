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

# A worker's ssh.exe runs as `cmd.exe /c ssh.exe ...`, an OS-level grandchild of THIS process
# that $PS.Stop()/.Dispose() know nothing about, so abandoning a hung job leaks a live ssh.exe
# with its session to the switch open. Many jobs share this PID, so candidates must match on
# command line plus creation time, not process name.
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
        $Candidates = Get-CimInstance Win32_Process -Filter "Name='ssh.exe' OR Name='cmd.exe'" -ErrorAction Stop |
            Where-Object { $_.CommandLine -and $_.CommandLine -match "@$([regex]::Escape($TargetIP))(\s|$)" -and $_.CreationDate -ge $SinceTime }
        # ssh.exe before cmd.exe: once the parent is gone there's no process-tree link left to
        # fall back on if a later command-line match misses.
        foreach ($Proc in ($Candidates | Sort-Object { if ($_.Name -eq 'ssh.exe') { 0 } else { 1 } })) {
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
            [System.IO.File]::WriteAllText($Path, "")
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

    # Must exceed the worker's own worst case or the orchestrator abandons jobs that were
    # still going to succeed. Get-JunosNodeData.ps1 caps each SSH batch at
    # Process.WaitForExit(50000) and may run a second -ForcePty attempt after the first comes
    # back empty, so a worker can legitimately need ~100s plus parsing. Keep this above 2x the
    # worker's batch timeout if that timeout changes, or the pty retry becomes dead code.
    $JobAbandonSeconds = 130
    $Queue = [System.Collections.Generic.Queue[string]]::new()
    $Visited = [System.Collections.Generic.HashSet[string]]::new()
    $Enqueued = [System.Collections.Generic.HashSet[string]]::new()
    $TopologyList = [System.Collections.Generic.List[object]]::new()

    $Queue.Enqueue($StartIP)
    $Enqueued.Add($StartIP) | Out-Null
    $LastWriteTime = Get-Date
    $PendingWrites = 0

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

    function Complete-PendingDisposalsLocal {
        param([bool]$OnlyCompleted = $true)
        for ($i = $PendingDisposal.Count - 1; $i -ge 0; $i--) {
            $Entry = $PendingDisposal[$i]
            if ($Entry.Async.IsCompleted) {
                try { $Entry.PS.EndStop($Entry.Async) } catch {}
                try { $Entry.PS.Dispose() } catch {}
                $PendingDisposal.RemoveAt($i)
            } elseif (-not $OnlyCompleted) {
                # Final drain, entry not done yet: EndStop() would block until completion, the
                # exact hang BeginStop exists to avoid. Dispose() alone here - this runs once,
                # at shutdown, on whatever rare entry is still pending.
                try { $Entry.PS.Dispose() } catch {}
                $PendingDisposal.RemoveAt($i)
            }
        }
    }

    try {
        Write-Host "`nStarting Crawl with $MaxConcurrent Threads. Press Ctrl+C to abort gracefully.`n" -ForegroundColor Yellow

        # Inside the try, not above it, so a failure here still reaches the catch below and the
        # finally still reaps the leftover .tmp file.
        Write-TopologyOutputLocal -Topology @() -Path $TempOutputFile -ScanTimestampIso $ScanTimestampIso
        Move-TopologyOutputAtomicLocal -SourcePath $TempOutputFile -DestinationPath $OutputFile

        while ($Queue.Count -gt 0 -or $Jobs.Count -gt 0) {

            # 0. Finish off any async Stop()s that completed since the last iteration.
            Complete-PendingDisposalsLocal

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
                if (!$Visited.Add($NextIP)) { continue }

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

                    # Without a synthetic node the device vanishes from the output entirely,
                    # unlike a worker-level failure which is reported with its own ScanStatus.
                    # Must mirror Get-JunosNodeData.ps1's $NodeData initializer field-for-field
                    # - consumers assume every key a real node has is present.
                    $TimeoutNode = @{
                        DeviceIP = $Job.IP; Hostname = "Unknown"; JunosVersion = "Unknown"; Gateway = "Unknown";
                        StackMembers = @(); Neighbors = @(); Clients = @(); ArpEntries = @(); Interfaces = @();
                        Uptime = "Unknown"; LastConfigured = "Unknown"; LastConfiguredBy = "Unknown"; Alarms = @();
                        MasterCpuUtilization = "Unknown"; MasterMemoryUtilization = "Unknown";
                        MedNeighbors = @(); Configuration = "Unknown";
                        ScanStatus = "Timeout"
                        ScanError  = "Orchestrator gave up waiting on $($Job.IP) after $($JobAbandonSeconds)s (job abandoned)."
                    }
                    $TopologyList.Add($TimeoutNode)
                    $PendingWrites++
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

                            Write-Host "`n[+] Finished $($Job.IP) ($($Node.Hostname)) - $($Node.Neighbors.Count) Neighbors, $($Node.Clients.Count) Clients" -ForegroundColor Green

                            # Before the neighbor loop, so a malformed neighbor entry throwing
                            # partway through doesn't cost the node its collected data.
                            $TopologyList.Add($Node)
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
                            # Shouldn't happen - Get-JunosNodeData always returns a Node.
                            Write-DebugLogLocal "ORCHESTRATOR WARNING: $($Job.IP) produced no result (worker returned nothing)."
                            Write-Host "`n[!] $($Job.IP) produced no result - skipping." -ForegroundColor Red
                        }
                    } catch {
                        Write-DebugLogLocal "ORCHESTRATOR ERROR parsing result from $($Job.IP): $_"
                        Write-Host "`n[!] Error processing result from $($Job.IP): $_" -ForegroundColor Red

                        # Same reasoning as the timeout path above; $Visited was already set, so
                        # this device is never retried either.
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
                    # Same -2s margin as the step-3 cleanup above - see comment there.
                    Stop-JunosOrphanProcessesLocal -TargetIP $LiveJob.IP -SinceTime $LiveJob.StartTime.AddSeconds(-2) -DebugLogPath $DebugLogPath
                }
                $Jobs.Clear()
                break
            }

            # 4. Periodic snapshot write
            if ($PendingWrites -gt 0 -and ((Get-Date) - $LastWriteTime).TotalSeconds -gt 5) {
                try {
                    Update-ClientIpCorrelationLocal -Topology $TopologyList
                    Write-TopologyOutputLocal -Topology $TopologyList -Path $TempOutputFile -ScanTimestampIso $ScanTimestampIso
                    Move-TopologyOutputAtomicLocal -SourcePath $TempOutputFile -DestinationPath $OutputFile
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
        Complete-PendingDisposalsLocal -OnlyCompleted:$false

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
        Complete-PendingDisposalsLocal -OnlyCompleted:$false
        $RunspacePool.Close(); $RunspacePool.Dispose()
        if (Test-Path $TempOutputFile) { Remove-Item -LiteralPath $TempOutputFile -Force }
    }
}

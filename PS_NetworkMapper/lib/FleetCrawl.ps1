# The fleet crawl loop, extracted from Start-NetworkMapper.ps1 so both the CLI crawl path
# and WebServer.ps1's async /api/scan-network endpoint (see that file's
# Invoke-ScanNetworkAction) can run the identical logic instead of two copies drifting
# apart. This is a behavior-preserving extraction, not a rewrite - the queue/BFS/
# runspace-pool/periodic-write/timeout logic below is unchanged from the original inline
# script body; only the pieces that differed between callers (starting IP, credentials,
# encryption keys, progress reporting) became parameters.
#
# Not meant to be run directly - dot-source it, then call Invoke-FleetCrawl.

. (Join-Path $PSScriptRoot "TopologyCrypto.ps1")

function Invoke-FleetCrawl {
    param(
        [Parameter(Mandatory=$true)][string]$StartIP,
        [Parameter(Mandatory=$true)][string[]]$AllowedScopes,
        [Parameter(Mandatory=$true)][int]$MaxConcurrent,
        [Parameter(Mandatory=$true)][string]$WorkerPath,
        [Parameter(Mandatory=$true)][string]$Username,
        [Parameter(Mandatory=$true)][string]$Password,
        [Parameter(Mandatory=$true)][string]$SnapshotDir,
        # Mandatory even for a caller that never reads it (the CLI path) - keeps the
        # function's contract uniform rather than branching internally on whether progress
        # reporting was requested. The web path (Task 3) shares this SAME hashtable
        # instance with its polling HTTP handler; a plain hashtable is an ordinary shared
        # .NET object across runspaces in the same process, and this function is the only
        # writer while the poll handler is the only reader, so no locking is needed for
        # this single-writer/single-reader progress-display use.
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

    $Encrypted = $null -ne $EncKey
    # Called from ~8 places throughout the crawl loop, several outside any try/catch of
    # their own - a bare Out-File here (e.g. a read-only/full log directory) would throw
    # and take the whole crawl down over a logging failure, exactly the "one error kills
    # the entire run" mode this file otherwise guards against everywhere else. Swallow it:
    # losing one debug-log line is not worth losing the crawl.
    function Write-DebugLogLocal {
        param([string]$Message)
        if ($DebugLogPath) {
            try { "[$(Get-Date -Format 'HH:mm:ss')] $Message" | Out-File -FilePath $DebugLogPath -Append -Encoding utf8 } catch {}
        }
    }
    if ($DebugLogPath) { try { "=== Fleet Crawl Debug Log - $(Get-Date) ===" | Out-File -FilePath $DebugLogPath -Force } catch {} }

    # Single write path for all three call sites below (init/periodic/final) so encryption
    # only has to be wired in once instead of duplicated three times.
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

    # A client's MAC often shows up in one switch's MAC table (the access switch it's
    # plugged into) but its ARP entry lives on a different device entirely (whichever box
    # owns the L3 gateway/IRB for that VLAN - frequently the core, not the access switch).
    # No single node's local view is enough, so once per write we build one MAC->IP map
    # across every node crawled so far and use it to backfill any client still showing IP
    # "Unknown".
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

    Write-TopologyOutputLocal -Topology @() -Path $OutputFile -ScanTimestampIso $ScanTimestampIso

    try {
        Write-Host "`nStarting Crawl with $MaxConcurrent Threads. Press Ctrl+C to abort gracefully.`n" -ForegroundColor Yellow

        while ($Queue.Count -gt 0 -or $Jobs.Count -gt 0) {

            # 1. Fill available thread slots (Safely dequeueing)
            while ($Jobs.Count -lt $MaxConcurrent -and $Queue.Count -gt 0) {
                $NextIP = $Queue.Dequeue()
                if (!$Visited.Add($NextIP)) { continue }

                # A faulted runspace pool (or any other Create()/BeginInvoke() failure)
                # must not take the whole crawl down - it's not this device's fault the
                # pool is unhealthy, but the fix is the same either way: log it, drop this
                # one IP (it's already in $Visited so it won't loop forever), keep going.
                # Reset before the try, not just declared by the assignment inside it: $PS
                # is scoped to the whole function (PowerShell doesn't rescope per while
                # iteration), so without this a Create()/AddCommand() throw here would
                # leave $PS pointing at the PREVIOUS iteration's instance - one already
                # added to $Jobs and running - and the catch below would then Dispose() a
                # live job out from under itself.
                $PS = $null
                try {
                    $PS = [powershell]::Create().AddCommand($WorkerPath).AddParameter("TargetIP", $NextIP).AddParameter("Username", $Username).AddParameter("Password", $Password)
                    if ($Log) { $PS.AddParameter("Log") | Out-Null }

                    $PS.RunspacePool = $RunspacePool
                    $Handle = $PS.BeginInvoke()
                    $Jobs.Add([PSCustomObject]@{ PS = $PS; Handle = $Handle; IP = $NextIP; StartTime = (Get-Date) })
                } catch {
                    Write-DebugLogLocal "ORCHESTRATOR ERROR: failed to start job for $($NextIP): $_"
                    Write-Host "`n[!] Failed to start job for $($NextIP): $_" -ForegroundColor Red
                    if ($PS) { try { $PS.Dispose() } catch {} }
                }
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
                    $JobsToRemove += $Job
                    continue
                }

                if ($Job.Handle.IsCompleted) {
                    try {
                        $Result = $Job.PS.EndInvoke($Job.Handle)

                        # Non-terminating errors inside the worker (e.g. a caught exception
                        # it logged via Write-LogMsg, or something Junos-parsing-related
                        # that wrote to the error stream instead of throwing) don't fail
                        # EndInvoke and would otherwise never surface anywhere.
                        if ($Job.PS.HadErrors) {
                            foreach ($ErrRecord in $Job.PS.Streams.Error) {
                                Write-DebugLogLocal "WORKER ERROR STREAM ($($Job.IP)): $ErrRecord"
                            }
                        }

                        if ($Result -and $Result.Node) {
                            $Node = $Result.Node
                            if ($Result.Logs) { foreach ($LogLine in $Result.Logs) { Write-DebugLogLocal $LogLine } }

                            Write-Host "`n[+] Finished $($Job.IP) ($($Node.Hostname)) - $($Node.Neighbors.Count) Neighbors, $($Node.Clients.Count) Clients" -ForegroundColor Green

                            # Recorded before the neighbor loop below, not after: this
                            # node's own interfaces/clients/ARP data already came back
                            # successfully by this point, and a malformed neighbor entry
                            # (unexpected ManagementIP shape, etc.) throwing partway through
                            # that loop must not cost the node its already-collected data -
                            # it would otherwise be silently dropped into the catch below
                            # along with the (unrelated) enqueue failure.
                            $TopologyList.Add($Node)
                            $PendingWrites++

                            foreach ($Neigh in $Node.Neighbors) {
                                $NIP = $Neigh.ManagementIP
                                if ([string]::IsNullOrEmpty($NIP)) { continue }
                                $InScope = $false
                                foreach ($Scope in $AllowedScopes) { if ($NIP.StartsWith($Scope)) { $InScope = $true; break } }

                                if ($InScope -and !$Visited.Contains($NIP) -and !$Enqueued.Contains($NIP)) {
                                    $Queue.Enqueue($NIP)
                                    $Enqueued.Add($NIP) | Out-Null
                                    Write-DebugLogLocal "ENQUEUED: $NIP"
                                }
                            }
                        } else {
                            # The worker returned nothing (or a result with no Node) without
                            # EndInvoke throwing - shouldn't happen given Get-JunosNodeData's
                            # own try/catch always returns a Node, but if it ever does, the
                            # device must not vanish from the log with zero explanation.
                            Write-DebugLogLocal "ORCHESTRATOR WARNING: $($Job.IP) produced no result (worker returned nothing)."
                            Write-Host "`n[!] $($Job.IP) produced no result - skipping." -ForegroundColor Red
                        }
                    } catch {
                        Write-DebugLogLocal "ORCHESTRATOR ERROR parsing result from $($Job.IP): $_"
                        Write-Host "`n[!] Error processing result from $($Job.IP): $_" -ForegroundColor Red
                    } finally {
                        $JobsToRemove += $Job
                    }
                }
            }

            # 3. Clean up processed or hung jobs
            foreach ($DeadJob in $JobsToRemove) {
                try { $DeadJob.PS.Stop() } catch { Write-DebugLogLocal "Stop() failed for $($DeadJob.IP): $_" }
                try { $DeadJob.PS.Dispose() } catch { Write-DebugLogLocal "Dispose() failed for $($DeadJob.IP): $_" }
                $Jobs.Remove($DeadJob) | Out-Null
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

        # Unlike the periodic write at step 4, this one has no "next cycle" to retry on -
        # it's the last write this run gets. A failure here (disk full, path went away
        # mid-run, permissions) must not stop the crawl from reporting completion and
        # returning $TopologyList in memory - the caller (WebServer.ps1's status poll, or
        # Start-NetworkMapper.ps1's CLI path) still gets the real data even if the on-disk
        # snapshot is stale.
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
        Write-Host "Mapping Complete! Processed $($Visited.Count) devices." -ForegroundColor Green
        Write-Host "Topology saved to: $OutputFile" -ForegroundColor White
        Write-Host "=================================================" -ForegroundColor Cyan

        $ProgressTable.Done = $true
        return @{ Topology = $TopologyList; ScanTimestampIso = $ScanTimestampIso; OutputFile = $OutputFile; VisitedCount = $Visited.Count }
    }
    catch {
        # A genuinely unexpected throw somewhere in the loop above (not one of the
        # per-device paths already caught individually) used to fall straight through to
        # the finally below and out of the function - losing the in-memory $TopologyList,
        # skipping the final write entirely, and never setting ProgressTable.Done
        # (so a web-triggered scan would poll forever). Make a best-effort attempt to save
        # whatever was already collected before this still re-throws, so a mid-crawl bug
        # costs at most the devices not yet visited - not the ones already gathered.
        #
        # NOT reached by Ctrl+C (verified against pwsh: a pipeline-stop terminates the
        # runspace immediately, skipping catch entirely - only the finally below runs) -
        # this only covers a genuine unexpected exception in the orchestrator loop itself.
        Write-DebugLogLocal "ORCHESTRATOR FATAL: unhandled error in crawl loop: $_"
        Write-Host "`n[!] Unexpected crawl error: $_" -ForegroundColor Red
        try {
            if ($TopologyList.Count -gt 0) {
                Update-ClientIpCorrelationLocal -Topology $TopologyList
                # Temp file + Move-Item, same as every other write path (init/periodic/
                # final) - not a direct write to $OutputFile. The condition that lands here
                # is often disk-full or a vanished directory, i.e. exactly the condition
                # that can make a direct write fail PARTWAY, replacing a good prior
                # snapshot with a truncated one. Move-Item only replaces $OutputFile once
                # the temp file is fully and successfully written.
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
        $RunspacePool.Close(); $RunspacePool.Dispose()
        if (Test-Path $TempOutputFile) { Remove-Item -Path $TempOutputFile -Force }
    }
}

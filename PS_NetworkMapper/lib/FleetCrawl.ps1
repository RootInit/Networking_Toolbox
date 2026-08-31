# The fleet crawl loop, shared by Start-NetworkMapper.ps1's CLI path and WebServer.ps1's
# /api/scan-network endpoint so both use identical crawl logic.
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

    Write-TopologyOutputLocal -Topology @() -Path $OutputFile -ScanTimestampIso $ScanTimestampIso

    try {
        Write-Host "`nStarting Crawl with $MaxConcurrent Threads. Press Ctrl+C to abort gracefully.`n" -ForegroundColor Yellow

        while ($Queue.Count -gt 0 -or $Jobs.Count -gt 0) {

            # 1. Fill available thread slots (Safely dequeueing)
            while ($Jobs.Count -lt $MaxConcurrent -and $Queue.Count -gt 0) {
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
                            # Shouldn't happen (Get-JunosNodeData always returns a Node), but
                            # log it rather than let the device vanish silently.
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
        Write-Host "Mapping Complete! Processed $($Visited.Count) devices." -ForegroundColor Green
        Write-Host "Topology saved to: $OutputFile" -ForegroundColor White
        Write-Host "=================================================" -ForegroundColor Cyan

        $ProgressTable.Done = $true
        return @{ Topology = $TopologyList; ScanTimestampIso = $ScanTimestampIso; OutputFile = $OutputFile; VisitedCount = $Visited.Count }
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
        $RunspacePool.Close(); $RunspacePool.Dispose()
        if (Test-Path $TempOutputFile) { Remove-Item -Path $TempOutputFile -Force }
    }
}

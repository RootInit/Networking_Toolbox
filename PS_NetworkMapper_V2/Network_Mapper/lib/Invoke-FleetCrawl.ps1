# The fleet crawl loop, extracted from Start-NetworkMapper.ps1 so both the CLI crawl path
# and Start-WebServer.ps1's async /api/scan-network endpoint (see that file's
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
        [Parameter(Mandatory=$true)][string]$DeviceHistoryLedger,
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
    function Write-DebugLogLocal {
        param([string]$Message)
        if ($DebugLogPath) { "[$(Get-Date -Format 'HH:mm:ss')] $Message" | Out-File -FilePath $DebugLogPath -Append -Encoding utf8 }
    }
    if ($DebugLogPath) { "=== Fleet Crawl Debug Log - $(Get-Date) ===" | Out-File -FilePath $DebugLogPath -Force }

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

    # Appends one NDJSON line per device to the shared history ledger - additive to, not a
    # replacement for, the full JSON/enc snapshot written above. Only called once, at the
    # very end of a completed crawl - not on every 5-second periodic write - so each device
    # gets exactly one ledger line per run, not one per partial flush.
    function Write-DeviceHistoryLedgerLocal {
        param([System.Collections.Generic.List[object]]$Topology, [string]$LedgerPath, [string]$ScanTimestampIso)
        $Lines = foreach ($Device in $Topology) {
            [ordered]@{
                ts         = $ScanTimestampIso
                ip         = $Device.DeviceIP
                hostname   = $Device.Hostname
                junosVer   = $Device.JunosVersion
                uptime     = $Device.Uptime
                alarmCount = @($Device.Alarms).Count
                cpuPct     = $Device.MasterCpuUtilization
                memPct     = $Device.MasterMemoryUtilization
            } | ConvertTo-Json -Depth 5 -Compress
        }
        # AppendAllLines with an explicit BOM-less UTF8Encoding, not Add-Content -Encoding
        # utf8 - see Start-NetworkMapper.ps1's own original comment on this for why (BOM
        # inconsistency between PS 5.1 and 7+ would otherwise corrupt later lines for
        # per-line consumers).
        if ($Lines) { [System.IO.File]::AppendAllLines($LedgerPath, [string[]]$Lines, [System.Text.UTF8Encoding]::new($false)) }
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

                $PS = [powershell]::Create().AddCommand($WorkerPath).AddParameter("TargetIP", $NextIP).AddParameter("Username", $Username).AddParameter("Password", $Password)
                if ($Log) { $PS.AddParameter("Log") | Out-Null }

                $PS.RunspacePool = $RunspacePool
                $Handle = $PS.BeginInvoke()
                $Jobs.Add([PSCustomObject]@{ PS = $PS; Handle = $Handle; IP = $NextIP; StartTime = (Get-Date) })
            }

            Write-Host "`r[Threads: $($Jobs.Count)/$MaxConcurrent] [Queue: $($Queue.Count)] [Done: $($TopologyList.Count)]    " -NoNewline -ForegroundColor Cyan
            $ProgressTable.Visited = $Visited.Count
            $ProgressTable.QueueDepth = $Queue.Count
            $ProgressTable.ActiveJobs = $Jobs.Count
            $ProgressTable.Done = $TopologyList.Count

            # 2. Process Jobs (Completed OR Hung)
            $JobsToRemove = @()

            foreach ($Job in $Jobs) {
                if (-not $Job.Handle.IsCompleted -and ((Get-Date) - $Job.StartTime).TotalSeconds -gt 65) {
                    Write-DebugLogLocal "ORCHESTRATOR TIMEOUT: Abandoning hung thread for $($Job.IP)"
                    $JobsToRemove += $Job
                    continue
                }

                if ($Job.Handle.IsCompleted) {
                    try {
                        $Result = $Job.PS.EndInvoke($Job.Handle)

                        if ($Result -and $Result.Node) {
                            $Node = $Result.Node
                            if ($Result.Logs) { foreach ($LogLine in $Result.Logs) { Write-DebugLogLocal $LogLine } }

                            Write-Host "`n[+] Finished $($Job.IP) ($($Node.Hostname)) - $($Node.Neighbors.Count) Neighbors, $($Node.Clients.Count) Clients" -ForegroundColor Green

                            foreach ($Neigh in $Node.Neighbors) {
                                $NIP = $Neigh.ManagementIP
                                $InScope = $false
                                foreach ($Scope in $AllowedScopes) { if ($NIP.StartsWith($Scope)) { $InScope = $true; break } }

                                if ($InScope -and !$Visited.Contains($NIP) -and !$Enqueued.Contains($NIP)) {
                                    $Queue.Enqueue($NIP)
                                    $Enqueued.Add($NIP) | Out-Null
                                    Write-DebugLogLocal "ENQUEUED: $NIP"
                                }
                            }

                            $TopologyList.Add($Node)
                            $PendingWrites++
                        }
                    } catch {
                        Write-DebugLogLocal "ORCHESTRATOR ERROR parsing result from $($Job.IP): $_"
                    } finally {
                        $JobsToRemove += $Job
                    }
                }
            }

            # 3. Clean up processed or hung jobs
            foreach ($DeadJob in $JobsToRemove) {
                try { $DeadJob.PS.Stop() } catch { Write-DebugLogLocal "Stop() failed for $($DeadJob.IP): $_" }
                $DeadJob.PS.Dispose()
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

        if ($PendingWrites -gt 0) {
            Update-ClientIpCorrelationLocal -Topology $TopologyList
            Write-TopologyOutputLocal -Topology $TopologyList -Path $TempOutputFile -ScanTimestampIso $ScanTimestampIso
            Move-Item -Path $TempOutputFile -Destination $OutputFile -Force
        }
        Write-DeviceHistoryLedgerLocal -Topology $TopologyList -LedgerPath $DeviceHistoryLedger -ScanTimestampIso $ScanTimestampIso

        Write-Host "`n`n=================================================" -ForegroundColor Cyan
        Write-Host "Mapping Complete! Processed $($Visited.Count) devices." -ForegroundColor Green
        Write-Host "Topology saved to: $OutputFile" -ForegroundColor White
        Write-Host "Device history appended to: $DeviceHistoryLedger" -ForegroundColor White
        Write-Host "=================================================" -ForegroundColor Cyan

        $ProgressTable.Done = $true
        return @{ Topology = $TopologyList; ScanTimestampIso = $ScanTimestampIso; OutputFile = $OutputFile; VisitedCount = $Visited.Count }
    }
    finally {
        $RunspacePool.Close(); $RunspacePool.Dispose()
        if (Test-Path $TempOutputFile) { Remove-Item -Path $TempOutputFile -Force }
    }
}

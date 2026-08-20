param (
    [Parameter(Mandatory=$true, HelpMessage="Starting IP address of the first switch")]
    [string]$SwitchIP,
    
    [string]$AuthFile = ".\Auth.json",
    [string[]]$AllowedScopes = @("131.30."),
    
    [int]$MaxConcurrent = 10,
    [switch]$Log 
)

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
$WorkerPath = Join-Path $ScriptDir "Get-JunosNodeData.ps1"
$OutputFile = Join-Path $ScriptDir "NetworkMap.json"
$TempOutputFile = Join-Path $ScriptDir "NetworkMap.tmp.json"
$DebugLog = Join-Path $ScriptDir "Mapper_Debug.log"

Write-Host "Initializing Enterprise Orchestrator starting at $SwitchIP..." -ForegroundColor Cyan
if ($Log) { Write-Host "[LOGGING ENABLED] Raw payloads will be saved to .\RawDumps\" -ForegroundColor Yellow }

if (-not (Test-Path $WorkerPath)) { Write-Host "Worker script missing at $WorkerPath!" -ForegroundColor Red; exit }

"=== Orchestrator Debug Log - $(Get-Date) ===" | Out-File -FilePath $DebugLog -Force
function Write-DebugLog { param([string]$Message) "[$(Get-Date -Format 'HH:mm:ss')] $Message" | Out-File -FilePath $DebugLog -Append -Encoding utf8 }

# A client's MAC often shows up in one switch's MAC table (the access switch it's plugged
# into) but its ARP entry lives on a different device entirely (whichever box owns the L3
# gateway/IRB for that VLAN - frequently the core, not the access switch). No single node's
# local view is enough, so once per write we build one MAC->IP map across every node crawled
# so far and use it to backfill any client still showing IP "Unknown".
function Update-ClientIpCorrelation {
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

$RunspacePool = [runspacefactory]::CreateRunspacePool(1, $MaxConcurrent)
$RunspacePool.Open()

$Jobs = [System.Collections.Generic.List[PSCustomObject]]::new() 
$Queue = [System.Collections.Generic.Queue[string]]::new()
$Visited = [System.Collections.Generic.HashSet[string]]::new()
$Enqueued = [System.Collections.Generic.HashSet[string]]::new()
$TopologyList = [System.Collections.Generic.List[object]]::new()

# Initialize Queue
$Queue.Enqueue($SwitchIP)
$Enqueued.Add($SwitchIP) | Out-Null
$LastWriteTime = Get-Date
$PendingWrites = 0

# Initialize JSON (Depth 100 prevents object truncation)
@{ Topology = @() } | ConvertTo-Json -Depth 100 | Out-File -FilePath $OutputFile -Encoding utf8

try {
    Write-Host "`nStarting Crawl with $MaxConcurrent Threads. Press Ctrl+C to abort gracefully.`n" -ForegroundColor Yellow

    while ($Queue.Count -gt 0 -or $Jobs.Count -gt 0) {
        
        # 1. Fill available thread slots (Safely dequeueing)
        while ($Jobs.Count -lt $MaxConcurrent -and $Queue.Count -gt 0) {
            $NextIP = $Queue.Dequeue()
            
            # If already visited, skip immediately before spinning up a thread
            if (!$Visited.Add($NextIP)) { continue } 
            
            $PS = [powershell]::Create().AddCommand($WorkerPath).AddParameter("TargetIP", $NextIP)
            if ($Log) { $PS.AddParameter("Log") | Out-Null }

            $PS.RunspacePool = $RunspacePool
            $Handle = $PS.BeginInvoke()
            
            # Record start time to detect hung threads
            $Jobs.Add([PSCustomObject]@{ PS = $PS; Handle = $Handle; IP = $NextIP; StartTime = (Get-Date) })
        }

        Write-Host "`r[Threads: $($Jobs.Count)/$MaxConcurrent] [Queue: $($Queue.Count)] [Done: $($TopologyList.Count)]    " -NoNewline -ForegroundColor Cyan

        # 2. Process Jobs (Completed OR Hung)
        $JobsToRemove = @()

        foreach ($Job in $Jobs) {
            # Check for hard timeout (45 seconds max per node)
            if (-not $Job.Handle.IsCompleted -and ((Get-Date) - $Job.StartTime).TotalSeconds -gt 45) {
                Write-DebugLog "ORCHESTRATOR TIMEOUT: Abandoning hung thread for $($Job.IP)"
                $JobsToRemove += $Job
                continue
            }

            # Process finished jobs
            if ($Job.Handle.IsCompleted) {
                try {
                    $Result = $Job.PS.EndInvoke($Job.Handle)
                    
                    if ($Result -and $Result.Node) {
                        $Node = $Result.Node
                        if ($Result.Logs) { foreach ($LogLine in $Result.Logs) { Write-DebugLog $LogLine } }
                        
                        Write-Host "`n[+] Finished $($Job.IP) ($($Node.Hostname)) - $($Node.Neighbors.Count) Neighbors, $($Node.Clients.Count) Clients" -ForegroundColor Green
                        
                        # Enqueue valid neighbors
                        foreach ($Neigh in $Node.Neighbors) {
                            $NIP = $Neigh.ManagementIP
                            $InScope = $false
                            foreach ($Scope in $AllowedScopes) { if ($NIP.StartsWith($Scope)) { $InScope = $true; break } }
                            
                            # Strict deduplication before queueing
                            if ($InScope -and !$Visited.Contains($NIP) -and !$Enqueued.Contains($NIP)) {
                                $Queue.Enqueue($NIP)
                                $Enqueued.Add($NIP) | Out-Null
                                Write-DebugLog "ENQUEUED: $NIP"
                            }
                        }

                        $TopologyList.Add($Node)
                        $PendingWrites++
                    }
                } catch {
                    Write-DebugLog "ORCHESTRATOR ERROR parsing result from $($Job.IP): $_"
                } finally {
                    $JobsToRemove += $Job
                }
            }
        }

        # 3. Clean up processed or hung jobs
        foreach ($DeadJob in $JobsToRemove) {
            $DeadJob.PS.Dispose()
            $Jobs.Remove($DeadJob) | Out-Null
        }

        # 4. Batch JSON Write (Only write if pending data exists AND 5 seconds have passed)
        if ($PendingWrites -gt 0 -and ((Get-Date) - $LastWriteTime).TotalSeconds -gt 5) {
            Update-ClientIpCorrelation -Topology $TopologyList
            $ExportData = @{ Topology = $TopologyList }
            # Use Depth 100 to ensure deep dictionaries (like Interfaces) are never truncated
            $ExportData | ConvertTo-Json -Depth 100 | Out-File -FilePath $TempOutputFile -Encoding utf8
            Move-Item -Path $TempOutputFile -Destination $OutputFile -Force
            $PendingWrites = 0
            $LastWriteTime = Get-Date
            
            # Force .NET Garbage Collection to keep RAM flat during long crawls
            [System.GC]::Collect() 
        }

        # Prevent 100% CPU lockups
        Start-Sleep -Milliseconds 250
    }

    # Final Write Check
    if ($PendingWrites -gt 0) {
        Update-ClientIpCorrelation -Topology $TopologyList
        $ExportData = @{ Topology = $TopologyList }
        $ExportData | ConvertTo-Json -Depth 100 | Out-File -FilePath $TempOutputFile -Encoding utf8
        Move-Item -Path $TempOutputFile -Destination $OutputFile -Force
    }

    Write-Host "`n`n=================================================" -ForegroundColor Cyan
    Write-Host "Mapping Complete! Processed $($Visited.Count) devices." -ForegroundColor Green
    Write-Host "Topology saved to: $OutputFile" -ForegroundColor White
    Write-Host "=================================================" -ForegroundColor Cyan
}
finally {
    $RunspacePool.Close(); $RunspacePool.Dispose()
    if (Test-Path $TempOutputFile) { Remove-Item -Path $TempOutputFile -Force }
}

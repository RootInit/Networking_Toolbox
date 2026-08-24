# Scan Network Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Scan Network" button to the web viewer that kicks off a full fleet crawl from the browser - no CLI needed - starting from a user-typed IP if nothing is loaded yet, or from the current topology's own core/backbone node if a snapshot is already loaded.

**Architecture:** `Start-NetworkMapper.ps1`'s inline crawl loop (queue/runspace-pool/BFS/periodic-write) is extracted into a reusable `Invoke-FleetCrawl` function so both the CLI crawl path and a new async web endpoint can run the identical crawl logic. `Start-WebServer.ps1` gains `POST /api/scan-network` (starts a crawl in a background runspace, mirroring `/api/rescan`'s async-job pattern but sized for real concurrency) and `GET /api/scan-network/status` (polled for progress, returns the finished topology inline in its JSON response - not a second file fetch, since the crawl already holds the full result in memory). The browser gets a new "Scan Network" button, a small "Starting IP" modal matching this app's existing modal conventions, a best-start-IP heuristic reusing `GraphLayout.computeGraphRoot` (already pure/reusable, unchanged), and on completion synthesizes a `File` object from the returned JSON and feeds it through the existing `processSelectedFiles` load pipeline - zero duplication of the parsing/multi-snapshot logic that already exists.

**Tech Stack:** PowerShell (pwsh 7.6.2 / Windows PowerShell 5.1 dual-runtime), vanilla JS (classic scripts, no build step).

**Depends on:** `docs/superpowers/plans/2026-08-23-config-credentials-settings.md` ("Plan B") - assumed already implemented and merged before this plan starts. This plan uses `Start-MapperWebServer`'s `-JunosUsername`/`-JunosPassword`/`-EncryptionPassword` params (added by Plan B) and follows the same "fail cleanly, point at the Settings tab" posture Plan B established for `Invoke-ConnectAction`/`Invoke-RescanAction`.

## Global Constraints

- Every `.ps1` change must run correctly on both pwsh 7+ (.NET Core) and Windows PowerShell 5.1 (.NET Framework) - no `-AsHashtable` on `ConvertFrom-Json`, no `AesGcm`, no `System.Web`. Same precedent as Plan B.
- V1 (`PS_NetworkMapper/`) is untouched. This plan only touches `PS_NetworkMapper_V2/`.
- The crawl-loop extraction (Task 1) must be **behavior-preserving** - the CLI's existing console output, periodic-write cadence, timeout handling, and output file naming/format must not change. This is the highest-risk task in this plan; it gets its own dedicated verification step proving the extracted function produces output identical in shape to the original inline loop.
- `/api/scan-network` is a state-changing endpoint (launches SSH sessions against every reachable device in scope) - it goes through the same `Test-SameOriginRequest` CSRF guard as `/api/connect`/`/api/rescan`/`/api/save-config`.
- `/api/scan-network` fails cleanly with 400 + a Settings-tab-pointing message if Juniper credentials aren't configured, checked *before* starting anything - same posture Plan B established for `Invoke-ConnectAction`/`Invoke-RescanAction`.
- No PowerShell-side interactive credential prompt anywhere in this plan either (same rule as Plan B) - a web-triggered scan uses whatever credentials this server session already collected at startup, or fails to the Settings tab.
- Out of scope, explicitly dropped by the user earlier in this project: "prepopulate the last-used browse path." Not implemented here.
- The full crawl result is returned inline in the status-poll JSON response, not served from a second file-fetch endpoint - avoids adding new file-serving surface rooted outside `$VisualizerRoot` (which would otherwise need its own path-traversal hardening, duplicating what `Invoke-StaticFile` already does for a different root).

---

### Task 1: Extract the crawl loop into `Invoke-FleetCrawl`

**Files:**
- Create: `PS_NetworkMapper_V2/Network_Mapper/lib/Invoke-FleetCrawl.ps1`
- Modify: `PS_NetworkMapper_V2/Network_Mapper/Start-NetworkMapper.ps1`

**Interfaces:**
- Produces: `Invoke-FleetCrawl -StartIP <string> -AllowedScopes <string[]> -MaxConcurrent <int> -WorkerPath <string> -Username <string> -Password <string> -SnapshotDir <string> -DeviceHistoryLedger <string> -ProgressTable <hashtable> [-EncKey <byte[]> -MacKey <byte[]> -Salt <byte[]> -Iterations <int>] [-DebugLogPath <string>] [-Log]` → returns `@{ Topology = <List[object]>; ScanTimestampIso = <string>; OutputFile = <string>; VisitedCount = <int> }`. `-EncKey`/`-MacKey`/`-Salt`/`-Iterations` are a group - all four present means encrypted output (`.json.enc`), all four absent (default `$null`) means plain `.json`, matching `-NoEncryption`'s existing meaning. `-ProgressTable` is mandatory (even for a caller that ignores it) - the function writes `Visited`/`QueueDepth`/`ActiveJobs` keys into it on every loop tick, read by the caller from a different thread in the web path (Task 3) or simply discarded by the CLI path (Task 2). Consumed by Task 2 (`Start-NetworkMapper.ps1`'s CLI crawl path) and Task 3 (`Start-WebServer.ps1`'s `Invoke-ScanNetworkAction`).

- [ ] **Step 1: Create `Invoke-FleetCrawl.ps1`**

```powershell
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
```

- [ ] **Step 2: `Start-NetworkMapper.ps1`'s CLI crawl path calls `Invoke-FleetCrawl`**

This replaces the entire inline crawl body. The exact surrounding context (param block, encryption-key derivation, credential decrypt) is whatever Plan B's Task 6 left the file looking like - locate the block starting right after the crawl-mode credential check (`if (-not $JunosUsername -or -not $JunosPassword) { throw ... }`) and ending at the file's final `Start-MapperWebServer` call, and replace everything between "Timestamped once per scan..." and the final viewer launch with:

```powershell
. (Join-Path $ScriptDir "lib\Invoke-FleetCrawl.ps1")

if (-not (Test-Path $WorkerPath)) { Write-Host "Worker script missing at $WorkerPath!" -ForegroundColor Red; exit }

$CrawlProgress = @{}  # unused by the CLI path (nothing polls it) - passed only because Invoke-FleetCrawl requires it
$CrawlResult = Invoke-FleetCrawl -StartIP $SwitchIP -AllowedScopes $AllowedScopes -MaxConcurrent $MaxConcurrent `
    -WorkerPath $WorkerPath -Username $JunosUsername -Password $JunosPassword `
    -SnapshotDir $SnapshotDir -DeviceHistoryLedger $DeviceHistoryLedger -ProgressTable $CrawlProgress `
    -EncKey $EncKeyBytes -MacKey $MacKeyBytes -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS `
    -DebugLogPath $DebugLog -Log:$Log
```

(`-EncKey $EncKeyBytes -MacKey $MacKeyBytes -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS` are `$null`/`0` whenever `-NoEncryption` was passed, since `$EncKeyBytes`/`$MacKeyBytes`/`$SaltBytes` are only ever assigned inside the `if (-not $NoEncryption)` block - PowerShell happily passes an unset/`$null` variable through, and `Invoke-FleetCrawl`'s own `$Encrypted = $null -ne $EncKey` check handles that correctly)

Remove the now-dead functions/variables this replaces entirely: `Write-TopologyOutput`, `Update-ClientIpCorrelation`, `Write-DeviceHistoryLedger`, `Write-DebugLog`, `$RunspacePool`/`$Jobs`/`$Queue`/`$Visited`/`$Enqueued`/`$TopologyList`/`$LastWriteTime`/`$PendingWrites`, the `$ScanDateTime`/`$ScanTimestamp`/`$ScanTimestampIso`/`$OutputExtension`/`$OutputFile`/`$TempOutputFile` block, and the entire `try { while (...) { ... } } finally { ... }` loop - all of that logic now lives inside `Invoke-FleetCrawl`.

- [ ] **Step 3: Verify - behavior-preserving extraction check**

No real switch is reachable here, so verify with a synthetic worker script that fabricates node data instead of talking SSH - this exercises the real queue/BFS/periodic-write/file-output logic of `Invoke-FleetCrawl` end to end, only swapping out the one piece (`Get-JunosNodeData.ps1`) that needs a real switch.

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox
mkdir -p /tmp/fleet-crawl-smoke
cat > /tmp/fleet-crawl-smoke/FakeWorker.ps1 <<'EOF'
param([string]$TargetIP, [string]$Username, [string]$Password, [switch]$Log)
# Fabricates a tiny 3-node linear topology: 10.0.0.1 -> 10.0.0.2 -> 10.0.0.3, so the real
# crawl loop actually exercises its BFS enqueue/dedupe logic against more than one node.
$NeighborMap = @{ "10.0.0.1" = @("10.0.0.2"); "10.0.0.2" = @("10.0.0.1","10.0.0.3"); "10.0.0.3" = @("10.0.0.2") }
$Neighbors = @()
foreach ($NIP in $NeighborMap[$TargetIP]) { $Neighbors += [PSCustomObject]@{ ManagementIP = $NIP; Hostname = "sw-$NIP" } }
$Node = @{
    DeviceIP = $TargetIP; Hostname = "sw-$TargetIP"; JunosVersion = "21.4R1"; Gateway = "10.0.0.254"
    StackMembers = @(); Neighbors = $Neighbors; Clients = @(); ArpEntries = @(); Interfaces = @()
    Uptime = "1 day"; LastConfigured = "Unknown"; LastConfiguredBy = "Unknown"; Alarms = @()
    MasterCpuUtilization = "10%"; MasterMemoryUtilization = "20%"; MedNeighbors = @(); Configuration = "Unknown"
}
return @{ Node = $Node; Logs = @() }
EOF

pwsh -NoProfile -Command '
. ./PS_NetworkMapper_V2/Network_Mapper/lib/Invoke-FleetCrawl.ps1
$dir = Join-Path ([System.IO.Path]::GetTempPath()) "fleet-crawl-out-$([guid]::NewGuid().Guid.Substring(0,8))"
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$progress = @{}
$result = Invoke-FleetCrawl -StartIP "10.0.0.1" -AllowedScopes @("10.0.0.") -MaxConcurrent 4 -WorkerPath "/tmp/fleet-crawl-smoke/FakeWorker.ps1" -Username "u" -Password "p" -SnapshotDir $dir -DeviceHistoryLedger (Join-Path $dir "history.ndjson") -ProgressTable $progress

if ($result.VisitedCount -ne 3) { throw "Expected 3 visited nodes (BFS should have discovered all 3), got $($result.VisitedCount)" }
if ($result.Topology.Count -ne 3) { throw "Expected 3 topology entries, got $($result.Topology.Count)" }
if (-not (Test-Path $result.OutputFile)) { throw "Output file was not written: $($result.OutputFile)" }
if ($result.OutputFile -notmatch "\.json$") { throw "Expected plain .json (no encryption keys passed), got: $($result.OutputFile)" }
$onDisk = Get-Content $result.OutputFile -Raw | ConvertFrom-Json
if ($onDisk.Topology.Count -ne 3) { throw "On-disk file has $($onDisk.Topology.Count) devices, expected 3" }
if (-not (Test-Path (Join-Path $dir "history.ndjson"))) { throw "Device history ledger was not written" }
$ledgerLines = Get-Content (Join-Path $dir "history.ndjson")
if ($ledgerLines.Count -ne 3) { throw "Expected 3 ledger lines, got $($ledgerLines.Count)" }
Write-Host "BFS discovery + periodic write + ledger OK" -ForegroundColor Green

# Encrypted-output path
. ./PS_NetworkMapper_V2/Network_Mapper/lib/TopologyCrypto.ps1
$salt = [byte[]]::new(16); (New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($salt)
$iter = Get-TopologyPbkdf2Iterations
$km = Get-TopologyKeyMaterial -Password "test-pw" -Salt $salt -Iterations $iter
$progress2 = @{}
$result2 = Invoke-FleetCrawl -StartIP "10.0.0.1" -AllowedScopes @("10.0.0.") -MaxConcurrent 4 -WorkerPath "/tmp/fleet-crawl-smoke/FakeWorker.ps1" -Username "u" -Password "p" -SnapshotDir $dir -DeviceHistoryLedger (Join-Path $dir "history.ndjson") -ProgressTable $progress2 -EncKey $km.EncKey -MacKey $km.MacKey -Salt $salt -Iterations $iter
if ($result2.OutputFile -notmatch "\.json\.enc$") { throw "Expected encrypted .json.enc, got: $($result2.OutputFile)" }
$envelope = Get-Content $result2.OutputFile -Raw | ConvertFrom-Json
$decrypted = Unprotect-TopologyPayload -Envelope $envelope -Password "test-pw" -ExpectedFormats @("PSNetworkMapper-EncryptedTopology")
$decryptedParsed = $decrypted | ConvertFrom-Json
if ($decryptedParsed.Topology.Count -ne 3) { throw "Decrypted output has wrong device count" }
Write-Host "Encrypted-output path OK" -ForegroundColor Green

if ($progress.Visited -ne 3) { throw "ProgressTable was not updated - expected Visited=3, got $($progress.Visited)" }
Write-Host "ProgressTable updates OK" -ForegroundColor Green

Remove-Item -Recurse -Force $dir
'
```

Expected: `BFS discovery + periodic write + ledger OK`, `Encrypted-output path OK`, `ProgressTable updates OK`. This proves the extraction preserved BFS traversal, scope filtering, periodic writes, the device-history ledger, and both encrypted/plain output - the same behaviors the original inline loop had.

- [ ] **Step 4: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Mapper/lib/Invoke-FleetCrawl.ps1 PS_NetworkMapper_V2/Network_Mapper/Start-NetworkMapper.ps1
git commit -m "Extract the fleet crawl loop into Invoke-FleetCrawl.ps1 so the web-triggered scan (Task 3) can reuse it"
```

---

### Task 2: `Start-NetworkMapper.ps1` - derive encryption keys unconditionally, thread new params to the webserver

**Files:**
- Modify: `PS_NetworkMapper_V2/Network_Mapper/Start-NetworkMapper.ps1`

**Interfaces:**
- Produces: `Start-MapperWebServer` (Task 3) now additionally receives `-MaxConcurrent`, `-AllowedScopes`, `-WorkerPath` (already passed in Plan B - confirm it still is), `-SnapshotDir`, `-DeviceHistoryLedger`, and `-EncKey`/`-MacKey`/`-Salt`/`-Iterations` (`$null`/`0` when `-NoEncryption`).

**Why this task exists:** Plan B's encryption-key derivation (`$EncKeyBytes`/`$MacKeyBytes`/`$SaltBytes`) only ever ran inside the crawl-mode branch (after the `-SwitchIP`-gated early return for server-only mode). A browser-triggered scan needs to work from server-only mode too (the common case: launch the viewer with no `-SwitchIP`, then click "Scan Network" later) - so this key derivation has to run in BOTH modes now, and the resulting keys (or nulls, if `-NoEncryption`) need to reach `Start-MapperWebServer` so it can pass them into `Invoke-FleetCrawl` when `/api/scan-network` fires.

- [ ] **Step 1: Move key derivation above the server-only early return, thread new params through**

Find the `if (-not $NoEncryption) { ... }` block that derives `$SaltBytes`/`$EncKeyBytes`/`$MacKeyBytes` (Plan B's Task 6 left this directly after the crawl-mode credential check, i.e. AFTER the `if (-not $SwitchIP) { ...; return }` branch). Move it to run unconditionally, BEFORE that server-only early return, right after the `$JunosUsername`/`$JunosPassword`/`Configuration.json.enc`-decrypt block:

```powershell
$PBKDF2_ITERATIONS = Get-TopologyPbkdf2Iterations
$EncKeyBytes = $null; $MacKeyBytes = $null; $SaltBytes = $null
if (-not $NoEncryption) {
    Write-Host "Output encryption enabled - Network_Visualizer will prompt for this same password when the file is opened." -ForegroundColor Yellow

    $SaltBytes = [byte[]]::new(16)
    $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $Rng.GetBytes($SaltBytes)
    $Rng.Dispose()

    $KeyMaterial = Get-TopologyKeyMaterial -Password $EncryptionPassword -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS
    $EncKeyBytes = $KeyMaterial.EncKey
    $MacKeyBytes = $KeyMaterial.MacKey
}
```

(this is the same block Plan B's Task 6 wrote, just relocated - and with `$PBKDF2_ITERATIONS = Get-TopologyPbkdf2Iterations` now hoisted above the `if`, since a web-triggered scan needs `$PBKDF2_ITERATIONS` regardless of whether this run itself happens to encrypt anything, for consistency with what `Invoke-FleetCrawl` expects)

Delete this block from its old location (immediately after the crawl-mode credential check) - it no longer belongs there.

Update BOTH `Start-MapperWebServer` call sites (server-only branch, and the post-crawl viewer launch) to also pass:

```powershell
-MaxConcurrent $MaxConcurrent -AllowedScopes $AllowedScopes -SnapshotDir $SnapshotDir -DeviceHistoryLedger $DeviceHistoryLedger -EncKey $EncKeyBytes -MacKey $MacKeyBytes -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS
```

so the server-only call site reads:

```powershell
    Start-MapperWebServer -VisualizerRoot $VisualizerRoot -ConnectScriptPath $ConnectScriptPath -WorkerPath $WorkerPath -Port $WebPort -ConfigPath $ConfigPath -EncryptionPassword $EncryptionPassword -JunosUsername $JunosUsername -JunosPassword $JunosPassword -MaxConcurrent $MaxConcurrent -AllowedScopes $AllowedScopes -SnapshotDir $SnapshotDir -DeviceHistoryLedger $DeviceHistoryLedger -EncKey $EncKeyBytes -MacKey $MacKeyBytes -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS
    return
```

and the final post-crawl line reads:

```powershell
Start-MapperWebServer -VisualizerRoot $VisualizerRoot -ConnectScriptPath $ConnectScriptPath -WorkerPath $WorkerPath -Port $WebPort -ConfigPath $ConfigPath -EncryptionPassword $EncryptionPassword -JunosUsername $JunosUsername -JunosPassword $JunosPassword -MaxConcurrent $MaxConcurrent -AllowedScopes $AllowedScopes -SnapshotDir $SnapshotDir -DeviceHistoryLedger $DeviceHistoryLedger -EncKey $EncKeyBytes -MacKey $MacKeyBytes -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS
```

Note: `$EncryptionPassword` must still be a real, non-nulled string at this point in the file for `-EncryptionPassword $EncryptionPassword` to work (Plan B's Task 6 already established this - confirm the `$EncryptionPassword = $null` line was never re-added anywhere).

- [ ] **Step 2: Verify - syntax check and parameter-threading check**

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox/PS_NetworkMapper_V2/Network_Mapper
pwsh -NoProfile -Command '
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path "./Start-NetworkMapper.ps1"), [ref]$null, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Host $_ -ForegroundColor Red }; throw "Parse errors found" }
Write-Host "Parses cleanly" -ForegroundColor Green

$src = Get-Content "./Start-NetworkMapper.ps1" -Raw
foreach ($p in @("-MaxConcurrent \$MaxConcurrent","-AllowedScopes \$AllowedScopes","-SnapshotDir \$SnapshotDir","-DeviceHistoryLedger \$DeviceHistoryLedger","-EncKey \$EncKeyBytes")) {
    $matches = ([regex]::Matches($src, [regex]::Escape($p))).Count
    if ($matches -ne 2) { throw "Expected $p to appear exactly twice (both Start-MapperWebServer call sites), found $matches" }
}
Write-Host "Both call sites updated OK" -ForegroundColor Green
'
```

Expected: `Parses cleanly`, `Both call sites updated OK`.

- [ ] **Step 3: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Mapper/Start-NetworkMapper.ps1
git commit -m "Start-NetworkMapper.ps1: derive encryption keys unconditionally so server-only mode can support a browser-triggered scan"
```

---

### Task 3: `Start-WebServer.ps1` - `POST /api/scan-network` + `GET /api/scan-network/status`

**Files:**
- Modify: `PS_NetworkMapper_V2/Network_Mapper/lib/Start-WebServer.ps1`

**Interfaces:**
- Consumes: `Invoke-FleetCrawl` (Task 1).
- Produces: `Start-MapperWebServer` gains `-MaxConcurrent`, `-AllowedScopes`, `-SnapshotDir`, `-DeviceHistoryLedger`, `-EncKey`, `-MacKey`, `-Salt`, `-Iterations` (Task 2 already threads these in). New routes `POST /api/scan-network` (body: `{startIp?: string}`) and `GET /api/scan-network/status` - status response shape on completion: `{status:"complete", ok:true, topology:[...], scanTimestamp:"...", outputFile:"NetworkMap_...", visitedCount: N}`. Consumed by Task 4 (browser).

- [ ] **Step 1: Dot-source `Invoke-FleetCrawl.ps1`**

Add right after the `Connect-JunosSsh.ps1` dot-source Plan B's Task 5 added:

```powershell
# Invoke-ScanNetworkAction (below) needs Invoke-FleetCrawl.
. (Join-Path $PSScriptRoot "Invoke-FleetCrawl.ps1")
```

- [ ] **Step 2: Add `Invoke-ScanNetworkAction`/`Invoke-ScanNetworkStatusAction`**

Add these two functions right after `Invoke-RescanStatusAction` (before `Invoke-GetConfigAction`):

```powershell
# Kicks off a full fleet crawl from the browser, via Invoke-FleetCrawl (see that file) run
# asynchronously in its own runspace pool - same "must not block the accept loop" reasoning
# as Invoke-RescanAction, but sized to $MaxConcurrent (a real crawl needs real concurrency,
# unlike a single-device rescan's 1-slot pool). Only one scan may be in flight at a time,
# tracked in $script:PendingScanNetwork exactly like $script:PendingScan does for rescans -
# a second click while one is running is refused with a 409, not queued or stacked.
function Invoke-ScanNetworkAction {
    param($Response, [string]$Body, [string]$WorkerPath, [string]$JunosUsername, [string]$JunosPassword,
          [string]$MaxConcurrent, [string[]]$AllowedScopes, [string]$SnapshotDir, [string]$DeviceHistoryLedger,
          [byte[]]$EncKey, [byte[]]$MacKey, [byte[]]$Salt, [int]$Iterations)

    if ([string]::IsNullOrWhiteSpace($JunosUsername) -or [string]::IsNullOrWhiteSpace($JunosPassword)) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "No Juniper login configured - set it in the Settings tab, then try again." }
        return
    }

    if ($script:PendingScanNetwork) {
        Send-WebJson -Response $Response -StatusCode 409 -Object @{ error = "A network scan is already in progress"; ip = $script:PendingScanNetwork.StartIP }
        return
    }

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    $StartIP = if ($Parsed -and $Parsed.startIp) { [string]$Parsed.startIp } else { $null }

    if (-not $StartIP -or $StartIP -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Invalid or missing starting IP address" }
        return
    }

    $ProgressTable = [hashtable]::Synchronized(@{ Visited = 0; QueueDepth = 1; ActiveJobs = 0; Done = $false })
    $PS = [powershell]::Create().AddCommand("Invoke-FleetCrawl").
        AddParameter("StartIP", $StartIP).
        AddParameter("AllowedScopes", $AllowedScopes).
        AddParameter("MaxConcurrent", [int]$MaxConcurrent).
        AddParameter("WorkerPath", $WorkerPath).
        AddParameter("Username", $JunosUsername).
        AddParameter("Password", $JunosPassword).
        AddParameter("SnapshotDir", $SnapshotDir).
        AddParameter("DeviceHistoryLedger", $DeviceHistoryLedger).
        AddParameter("ProgressTable", $ProgressTable)
    if ($EncKey) { $PS.AddParameter("EncKey", $EncKey).AddParameter("MacKey", $MacKey).AddParameter("Salt", $Salt).AddParameter("Iterations", $Iterations) | Out-Null }

    # Invoke-FleetCrawl itself is defined in the caller's session state (dot-sourced at the
    # top of this file) - a fresh [powershell]::Create() runspace does NOT inherit that by
    # default, so the function definition has to travel into the new runspace explicitly.
    $InitialState = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
    $FleetCrawlPath = Join-Path $PSScriptRoot "Invoke-FleetCrawl.ps1"
    $InitialState.StartupScripts.Add($FleetCrawlPath) | Out-Null
    $Runspace = [runspacefactory]::CreateRunspace($InitialState)
    $Runspace.Open()
    $PS.Runspace = $Runspace

    $Handle = $PS.BeginInvoke()
    $script:PendingScanNetwork = [PSCustomObject]@{ PS = $PS; Runspace = $Runspace; Handle = $Handle; StartIP = $StartIP; StartTime = (Get-Date); ProgressTable = $ProgressTable }
    Send-WebJson -Response $Response -StatusCode 202 -Object @{ status = "started"; startIp = $StartIP }
}

# Polled by the browser every ~2s while a scan is outstanding. Unlike Invoke-RescanStatusAction
# (one device, small/bounded runtime), a full fleet crawl can run for many minutes - no
# client-side timeout ceiling is imposed here; the browser just keeps polling until it sees
# "complete". Returns the FULL decrypted topology inline on completion (not a second file
# fetch) - Invoke-FleetCrawl already holds it all in memory at that point, so there is
# nothing to gain by writing it to disk and reading it straight back over a new endpoint,
# and doing so would mean adding new file-serving surface rooted outside $VisualizerRoot.
function Invoke-ScanNetworkStatusAction {
    param($Response)

    if (-not $script:PendingScanNetwork) {
        Send-WebJson -Response $Response -StatusCode 404 -Object @{ error = "No scan is currently running or was ever started this session" }
        return
    }

    $Job = $script:PendingScanNetwork

    if ($Job.Handle.IsCompleted) {
        $script:PendingScanNetwork = $null
        try {
            $Result = $Job.PS.EndInvoke($Job.Handle)
        } catch {
            $Job.PS.Dispose(); $Job.Runspace.Dispose()
            Send-WebJson -Response $Response -StatusCode 200 -Depth 20 -Object @{ status = "complete"; ok = $false; reason = "Scan failed: $_" }
            return
        }
        $Job.PS.Dispose(); $Job.Runspace.Dispose()

        if (-not $Result -or -not $Result.Topology) {
            Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "complete"; ok = $false; reason = "Scan produced no data - see server console/debug log" }
            return
        }

        Send-WebJson -Response $Response -StatusCode 200 -Depth 30 -Object @{
            status = "complete"; ok = $true
            topology = $Result.Topology; scanTimestamp = $Result.ScanTimestampIso
            outputFile = (Split-Path $Result.OutputFile -Leaf); visitedCount = $Result.VisitedCount
        }
        return
    }

    Send-WebJson -Response $Response -StatusCode 200 -Object @{
        status = "running"; startIp = $Job.StartIP
        elapsedSeconds = [math]::Round(((Get-Date) - $Job.StartTime).TotalSeconds)
        visited = $Job.ProgressTable.Visited; queueDepth = $Job.ProgressTable.QueueDepth; activeJobs = $Job.ProgressTable.ActiveJobs
    }
}
```

- [ ] **Step 3: `Start-MapperWebServer` - new params, new routes, cleanup on shutdown**

Add the new params (right after the `-Iterations` param Task 2's dispatch expects - these all arrive from `Start-NetworkMapper.ps1`):

```powershell
        [Parameter(Mandatory=$true)][int]$MaxConcurrent,
        [Parameter(Mandatory=$true)][string[]]$AllowedScopes,
        [Parameter(Mandatory=$true)][string]$SnapshotDir,
        [Parameter(Mandatory=$true)][string]$DeviceHistoryLedger,
        [byte[]]$EncKey,
        [byte[]]$MacKey,
        [byte[]]$Salt,
        [int]$Iterations,
```

Initialize the new tracking variable alongside `$script:PendingScan`/`$script:OrphanedScans`:

```powershell
    $script:PendingScanNetwork = $null
```

Add the two new routes inside the accept loop's `if`/`elseif` chain, right after the `/api/rescan/status` branch:

```powershell
                } elseif ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/scan-network") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused" }
                    } else {
                        $Reader = [System.IO.StreamReader]::new($Request.InputStream, $Request.ContentEncoding)
                        $Body = $Reader.ReadToEnd()
                        $Reader.Close()
                        Invoke-ScanNetworkAction -Response $Response -Body $Body -WorkerPath $WorkerPath -JunosUsername $JunosUsername -JunosPassword $JunosPassword -MaxConcurrent $MaxConcurrent -AllowedScopes $AllowedScopes -SnapshotDir $SnapshotDir -DeviceHistoryLedger $DeviceHistoryLedger -EncKey $EncKey -MacKey $MacKey -Salt $Salt -Iterations $Iterations
                    }
                } elseif ($Request.HttpMethod -eq "GET" -and $Request.Url.AbsolutePath -eq "/api/scan-network/status") {
                    Invoke-ScanNetworkStatusAction -Response $Response
```

Add cleanup for an in-flight scan in the `finally` block at the bottom of `Start-MapperWebServer`, alongside the existing `$script:PendingScan`/`$script:OrphanedScans` cleanup:

```powershell
        if ($script:PendingScanNetwork) { try { $script:PendingScanNetwork.PS.Stop() } catch {}; $script:PendingScanNetwork.PS.Dispose(); $script:PendingScanNetwork.Runspace.Dispose() }
```

- [ ] **Step 4: Verify - syntax check, parameter shape, and a live scan-network flow (synthetic worker)**

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox/PS_NetworkMapper_V2/Network_Mapper/lib
pwsh -NoProfile -Command '
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path "./Start-WebServer.ps1"), [ref]$null, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Host $_ -ForegroundColor Red }; throw "Parse errors found" }
Write-Host "Parses cleanly" -ForegroundColor Green
'
```

```bash
mkdir -p /tmp/fleet-crawl-smoke
cat > /tmp/fleet-crawl-smoke/FakeWorker.ps1 <<'EOF'
param([string]$TargetIP, [string]$Username, [string]$Password, [switch]$Log)
$NeighborMap = @{ "10.0.0.1" = @("10.0.0.2"); "10.0.0.2" = @() }
$Neighbors = @()
foreach ($NIP in $NeighborMap[$TargetIP]) { $Neighbors += [PSCustomObject]@{ ManagementIP = $NIP; Hostname = "sw-$NIP" } }
$Node = @{ DeviceIP = $TargetIP; Hostname = "sw-$TargetIP"; JunosVersion = "21.4R1"; Gateway = "10.0.0.254"; StackMembers = @(); Neighbors = $Neighbors; Clients = @(); ArpEntries = @(); Interfaces = @(); Uptime = "1 day"; LastConfigured = "Unknown"; LastConfiguredBy = "Unknown"; Alarms = @(); MasterCpuUtilization = "10%"; MasterMemoryUtilization = "20%"; MedNeighbors = @(); Configuration = "Unknown" }
return @{ Node = $Node; Logs = @() }
EOF

cd /home/alexander/Documents/Programming/Networking_Toolbox/PS_NetworkMapper_V2/Network_Mapper/lib
pwsh -NoProfile -Command '
. ./Start-WebServer.ps1
$dir = Join-Path ([System.IO.Path]::GetTempPath()) "scan-network-smoke-$([guid]::NewGuid().Guid.Substring(0,8))"
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$job = Start-Job -ScriptBlock {
    param($libDir, $snapDir)
    Set-Location $libDir
    . ./Start-WebServer.ps1
    Start-MapperWebServer -VisualizerRoot "/tmp" -ConnectScriptPath "/tmp/noop.ps1" -WorkerPath "/tmp/fleet-crawl-smoke/FakeWorker.ps1" -ConfigPath "/tmp/nope.enc" -EncryptionPassword "unused" -JunosUsername "u" -JunosPassword "p" -MaxConcurrent 4 -AllowedScopes @("10.0.0.") -SnapshotDir $snapDir -DeviceHistoryLedger (Join-Path $snapDir "history.ndjson") -Port 18790
} -ArgumentList (Resolve-Path ".").Path, $dir
Start-Sleep -Seconds 3
try {
    $resp = Invoke-WebRequest -Uri "http://localhost:18790/api/scan-network" -Method Post -Body (@{startIp="10.0.0.1"} | ConvertTo-Json) -ContentType "application/json" -Headers @{Origin="http://localhost:18790"} -SkipHttpErrorCheck
    if ($resp.StatusCode -ne 202) { throw "Expected 202, got $($resp.StatusCode): $($resp.Content)" }
    Write-Host "Scan start 202 OK" -ForegroundColor Green

    $ok = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        $statusResp = Invoke-WebRequest -Uri "http://localhost:18790/api/scan-network/status" -SkipHttpErrorCheck
        $status = $statusResp.Content | ConvertFrom-Json
        if ($status.status -eq "complete") {
            if (-not $status.ok) { throw "Scan completed with ok=false: $($status.reason)" }
            if ($status.topology.Count -ne 2) { throw "Expected 2 devices in the completed topology, got $($status.topology.Count)" }
            if ($status.visitedCount -ne 2) { throw "Expected visitedCount=2, got $($status.visitedCount)" }
            $ok = $true
            break
        }
        if ($status.status -eq "running" -and $i -eq 0) { Write-Host "Saw a running status: visited=$($status.visited) queueDepth=$($status.queueDepth)" -ForegroundColor Cyan }
    }
    if (-not $ok) { throw "Scan never completed within 30s" }
    Write-Host "Scan-network end-to-end (start -> poll -> complete with inline topology) OK" -ForegroundColor Green

    # A second concurrent scan-network call while none is running should now succeed (previous one finished)
    $resp2 = Invoke-WebRequest -Uri "http://localhost:18790/api/scan-network" -Method Post -Body (@{} | ConvertTo-Json) -ContentType "application/json" -Headers @{Origin="http://localhost:18790"} -SkipHttpErrorCheck
    if ($resp2.StatusCode -ne 400) { throw "Expected 400 for a missing startIp, got $($resp2.StatusCode)" }
    Write-Host "Missing-startIp 400 OK" -ForegroundColor Green
} finally {
    Stop-Job $job -ErrorAction SilentlyContinue; Remove-Job $job -Force -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
}
'
```

Expected: `Parses cleanly`, `Scan start 202 OK`, a `Saw a running status: ...` line, `Scan-network end-to-end (start -> poll -> complete with inline topology) OK`, `Missing-startIp 400 OK`.

- [ ] **Step 5: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Mapper/lib/Start-WebServer.ps1
git commit -m "Add POST /api/scan-network + GET /api/scan-network/status, running Invoke-FleetCrawl asynchronously"
```

---

### Task 4: Browser - "Scan Network" button, starting-IP modal, best-root heuristic

**Files:**
- Create: `PS_NetworkMapper_V2/Network_Visualizer/src/scan-network.js`
- Modify: `PS_NetworkMapper_V2/Network_Visualizer/network_vis.html`

**Interfaces:**
- Consumes: `window.GraphLayout.computeGraphRoot` (`graph-layout.js`, unchanged), `window.TopologyGraph.computeDeviceClassification`/`computeNeighborEdges` (`topology-graph.js`, unchanged), `window.processSelectedFiles` (`app.js`, unchanged - reused as-is, not duplicated).
- Produces: `window.startNetworkScan()` (button click handler), `window.confirmScanStartIp()`/`window.cancelScanStartIp()` (modal button handlers).

- [ ] **Step 1: `network_vis.html` - add the "Scan Network" button**

Add right after the existing `loadFolderBtn` button inside `#sidebar-tab-load` (after line `<button id="loadFolderBtn" ...>Load Folder of Snapshots</button>`):

```html
            <button id="scanNetworkBtn" type="button" style="background:#2c3e50; color:white;" onclick="window.startNetworkScan()">Scan Network</button>
```

- [ ] **Step 2: `network_vis.html` - add the Starting-IP modal**

Add right after the existing `#password-modal` block (after its closing `</div>` at the end of that block), following the exact same structural convention:

```html
    <!-- Scan Network: starting-IP prompt (see window.startNetworkScan) -->
    <div id="scan-start-ip-modal" style="position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:9999; display:none; justify-content:center; align-items:center;">
        <div style="background:var(--panel-bg); width:340px; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.3); overflow:hidden;">
            <div class="drawer-header"><h2 style="font-size:1.05rem;">Scan Network</h2></div>
            <div style="padding:18px;">
                <p style="margin:0 0 12px; font-size:0.85rem; color:#666;">No previous scan is loaded - enter the starting switch's IP address to begin a fleet crawl.</p>
                <div id="scan-start-ip-error" style="display:none; background:#fdecea; color:#c0392b; border:1px solid #f5c6c2; border-radius:4px; padding:8px 10px; font-size:0.8rem; margin-bottom:12px;"></div>
                <input type="text" id="scan-start-ip-input" placeholder="e.g. 10.55.2.2" autocomplete="off">
                <div style="display:flex; gap:10px; margin-top:4px;">
                    <button id="scan-start-ip-cancel-btn" type="button" style="background:#eee; color:#333; flex:1; width:auto; margin-bottom:0;" onclick="window.cancelScanStartIp()">Cancel</button>
                    <button id="scan-start-ip-confirm-btn" type="button" style="flex:1; width:auto; margin-bottom:0;" onclick="window.confirmScanStartIp()">Start Scan</button>
                </div>
            </div>
        </div>
    </div>
```

- [ ] **Step 3: `network_vis.html` - load the new script**

Add right after `<script src="src/drawer.js"></script>` (before the Leaflet/`map.js`/`app.js` tags):

```html
    <script src="src/scan-network.js"></script>
```

- [ ] **Step 4: Create `scan-network.js`**

```javascript
// "Scan Network" button (#sidebar-tab-load): kicks off a full fleet crawl from the browser
// via Start-WebServer.ps1's async POST /api/scan-network + GET /api/scan-network/status
// (see that file's Invoke-ScanNetworkAction/Invoke-ScanNetworkStatusAction). Reads
// loadedSnapshots/globalTopologyData (app.js), calls into window.processSelectedFiles
// (app.js) to load the finished scan through the exact same pipeline a manually-uploaded
// file goes through - no separate "apply a scan result" code path to keep in sync.

var scanNetworkPollTimer = null;

// Promise-based starting-IP prompt, same resolve-on-confirm/reject-on-cancel shape as
// window.promptForPassword (app.js) - only used when no previous scan is loaded this
// session (see window.startNetworkScan below).
function promptForStartIp() {
    return new Promise((resolve, reject) => {
        var modal = document.getElementById('scan-start-ip-modal');
        var input = document.getElementById('scan-start-ip-input');
        var errEl = document.getElementById('scan-start-ip-error');
        var confirmBtn = document.getElementById('scan-start-ip-confirm-btn');
        var cancelBtn = document.getElementById('scan-start-ip-cancel-btn');

        errEl.style.display = 'none';
        input.value = '';
        modal.style.display = 'flex';
        input.focus();

        function cleanup() {
            modal.style.display = 'none';
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
            input.removeEventListener('keydown', onKeydown);
        }
        function onConfirm() {
            var value = input.value.trim();
            if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) {
                errEl.textContent = 'Enter a valid IPv4 address.';
                errEl.style.display = 'block';
                return;
            }
            cleanup();
            resolve(value);
        }
        function onCancel() { cleanup(); reject(new Error('Cancelled')); }
        function onKeydown(e) {
            if (e.key === 'Enter') onConfirm();
            if (e.key === 'Escape') onCancel();
        }

        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
        input.addEventListener('keydown', onKeydown);
    });
}
window.confirmScanStartIp = function() {}; // wired via addEventListener above, not directly - kept as a no-op so the HTML onclick has something to call without duplicating the confirm logic; the actual click is handled by promptForStartIp's own listener
window.cancelScanStartIp = function() {}; // same - actual handling lives in promptForStartIp's onCancel

// "Best" starting IP from the currently active snapshot: the graph-center node (largest
// connected component, minimum eccentricity) - the same "core/backbone" selection
// graph.js's own diagram root uses (see graph.js line ~121's computeGraphRoot call), reused
// here via the same pure, DOM-free function rather than inventing a second heuristic.
function bestStartIpFromActiveSnapshot() {
    if (!globalTopologyData || globalTopologyData.length === 0) return null;
    var classification = window.TopologyGraph.computeDeviceClassification(globalTopologyData);
    var nodeIds = Array.from(classification.keys());
    var edges = window.TopologyGraph.computeNeighborEdges(globalTopologyData);
    return window.GraphLayout.computeGraphRoot(nodeIds, edges);
}

window.startNetworkScan = async function() {
    var btn = document.getElementById('scanNetworkBtn');
    var startIp;

    if (loadedSnapshots.length === 0) {
        try {
            startIp = await promptForStartIp();
        } catch (cancelErr) {
            return; // user cancelled - no status message needed, nothing was started
        }
    } else {
        startIp = bestStartIpFromActiveSnapshot();
        if (!startIp) {
            // Defensive - loadedSnapshots.length > 0 but somehow no classifiable node (e.g.
            // every device record is malformed). Fall back to asking, same as the
            // no-snapshot case, rather than silently failing to start.
            try {
                startIp = await promptForStartIp();
            } catch (cancelErr) {
                return;
            }
        }
    }

    function finish(msg, color) {
        if (scanNetworkPollTimer) { clearTimeout(scanNetworkPollTimer); scanNetworkPollTimer = null; }
        if (btn) { btn.disabled = false; btn.textContent = 'Scan Network'; }
        window.setStatus(msg, color);
    }

    try {
        if (btn) { btn.disabled = true; btn.textContent = 'Starting scan...'; }
        var resp = await fetch('/api/scan-network', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ startIp: startIp }),
        });
        var result = await resp.json();
        if (!resp.ok) {
            finish("Could not start scan: " + (result.error || ('HTTP ' + resp.status)), "red");
            return;
        }
    } catch (e) {
        finish("Could not start scan: " + e.message, "red");
        return;
    }

    var pollStart = Date.now();
    var poll = async function() {
        var statusResp, status;
        try {
            statusResp = await fetch('/api/scan-network/status');
            status = await statusResp.json();
        } catch (e) {
            finish("Lost connection to the local server - the scan may still be running server-side.", "red");
            return;
        }

        if (statusResp.status === 404) {
            finish("Scan job expired or the server restarted.", "red");
            return;
        }
        if (status.status === 'running') {
            if (btn) btn.textContent = 'Scanning (' + status.visited + ' found)...';
            scanNetworkPollTimer = setTimeout(poll, 2000);
            return;
        }
        // status.status === 'complete'
        if (!status.ok) {
            finish("Scan failed: " + (status.reason || "unknown error"), "red");
            return;
        }

        // Feed the finished scan through the exact same load pipeline a manually-uploaded
        // file goes through, by synthesizing a File object from the already-decrypted JSON
        // this endpoint returned - readSnapshotFile (app.js) already knows how to parse
        // this shape (it's the same {Topology, ScanTimestamp} envelope Start-NetworkMapper.ps1
        // writes to disk), so there is no second parsing path to keep in sync. This
        // intentionally REPLACES whatever was previously loaded (loadedSnapshots is
        // reassigned wholesale) - the same behavior any other new load already has via
        // processSelectedFiles, not special-cased here.
        var syntheticContent = JSON.stringify({ Topology: status.topology, ScanTimestamp: status.scanTimestamp });
        var syntheticFile = new File([syntheticContent], status.outputFile || 'scan-result.json', { type: 'application/json' });
        finish("Scan complete - " + status.visitedCount + " device(s) found. Loading...", "green");
        await window.processSelectedFiles([syntheticFile]);
    };
    poll();
};
```

Delete the two no-op stub assignments (`window.confirmScanStartIp = function() {};` / `window.cancelScanStartIp = function() {};`) and instead change the modal buttons in Step 2 to not use `onclick` at all - `promptForStartIp`'s own `addEventListener` calls already wire the real handlers directly to `#scan-start-ip-confirm-btn`/`#scan-start-ip-cancel-btn` by id, exactly like `window.promptForPassword` does for `#password-unlock-btn`/`#password-cancel-btn` (see `app.js`). Revise Step 2's modal markup to drop the `onclick` attributes from those two buttons:

```html
                    <button id="scan-start-ip-cancel-btn" type="button" style="background:#eee; color:#333; flex:1; width:auto; margin-bottom:0;">Cancel</button>
                    <button id="scan-start-ip-confirm-btn" type="button" style="flex:1; width:auto; margin-bottom:0;">Start Scan</button>
```

- [ ] **Step 5: Verify - unit test the pure heuristic wiring, headless load check**

`bestStartIpFromActiveSnapshot`'s two dependencies (`computeDeviceClassification`/`computeNeighborEdges` in `topology-graph.js`, `computeGraphRoot` in `graph-layout.js`) are already unit-tested in `src/test/topology-graph.test.mjs`/`src/test/graph-layout.test.mjs` - confirm those still pass (this task doesn't modify either file):

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox/PS_NetworkMapper_V2/Network_Visualizer
node --test src/test/topology-graph.test.mjs src/test/graph-layout.test.mjs
```

Then a headless load-only smoke check (confirms no syntax error breaks page load, same approach Plan B's Task 7 uses):

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox/PS_NetworkMapper_V2/Network_Visualizer
python3 -m http.server 8915 >/tmp/nv-server3.log 2>&1 &
SERVER_PID=$!
sleep 1
CB=$(command -v chromium || command -v chromium-browser || echo "")
if [ -n "$CB" ]; then
  "$CB" --headless --disable-gpu --virtual-time-budget=8000 --screenshot=/dev/null --run-all-compositor-stages-before-draw 'http://localhost:8915/network_vis.html' 2>&1 | grep -i "error\|exception" || echo "No console errors on load"
else
  echo "No chromium found - skip headless check"
fi
kill $SERVER_PID 2>/dev/null
```

Expected: existing tests still pass, `No console errors on load` (or the chromium-unavailable fallback message).

- [ ] **Step 6: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Visualizer/src/scan-network.js PS_NetworkMapper_V2/Network_Visualizer/network_vis.html
git commit -m "Add Scan Network button: starting-IP modal, graph-root heuristic, async scan + auto-load on completion"
```

---

### Task 5: Full-stack integration verification

**Files:** none - verification only.

- [ ] **Step 1: End-to-end: server-only launch, click-equivalent scan-network call, confirm the loaded result matches what the browser would render**

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox
mkdir -p /tmp/fleet-crawl-smoke
cat > /tmp/fleet-crawl-smoke/FakeWorker.ps1 <<'EOF'
param([string]$TargetIP, [string]$Username, [string]$Password, [switch]$Log)
$NeighborMap = @{ "10.0.0.1" = @("10.0.0.2"); "10.0.0.2" = @("10.0.0.1","10.0.0.3"); "10.0.0.3" = @("10.0.0.2") }
$Neighbors = @()
foreach ($NIP in $NeighborMap[$TargetIP]) { $Neighbors += [PSCustomObject]@{ ManagementIP = $NIP; Hostname = "sw-$NIP" } }
$Node = @{ DeviceIP = $TargetIP; Hostname = "sw-$TargetIP"; JunosVersion = "21.4R1"; Gateway = "10.0.0.254"; StackMembers = @(); Neighbors = $Neighbors; Clients = @(); ArpEntries = @(); Interfaces = @(); Uptime = "1 day"; LastConfigured = "Unknown"; LastConfiguredBy = "Unknown"; Alarms = @(); MasterCpuUtilization = "10%"; MasterMemoryUtilization = "20%"; MedNeighbors = @(); Configuration = "Unknown" }
return @{ Node = $Node; Logs = @() }
EOF

pwsh -NoProfile -Command '
. ./PS_NetworkMapper_V2/Network_Mapper/lib/TopologyCrypto.ps1
$dir = Join-Path ([System.IO.Path]::GetTempPath()) "scan-e2e-$([guid]::NewGuid().Guid.Substring(0,8))"
New-Item -ItemType Directory -Path (Join-Path $dir "PS_NetworkMapper\Network_Mapper") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dir "PS_NetworkMapper_V2\Network_Mapper\lib") -Force | Out-Null
Copy-Item "./PS_NetworkMapper_V2/Network_Visualizer" (Join-Path $dir "PS_NetworkMapper_V2\Network_Visualizer") -Recurse -Force
Copy-Item ./PS_NetworkMapper_V2/Network_Mapper/Start-NetworkMapper.ps1 (Join-Path $dir "PS_NetworkMapper_V2\Network_Mapper\") -Force
Copy-Item ./PS_NetworkMapper_V2/Network_Mapper/lib/*.ps1 (Join-Path $dir "PS_NetworkMapper_V2\Network_Mapper\lib\") -Force

$scriptPath = Join-Path $dir "PS_NetworkMapper_V2\Network_Mapper\Start-NetworkMapper.ps1"
$psi = New-Object System.Diagnostics.ProcessStartInfo("pwsh", "-NoProfile -File `"$scriptPath`" -WebPort 18791")
$psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$proc = [System.Diagnostics.Process]::Start($psi)
$proc.StandardInput.WriteLine("E2eScanPassword!1")
Start-Sleep -Seconds 3

try {
    # Configure credentials so the scan is allowed to proceed
    $saveBody = @{ devices = @(); credentials = @{ username = "svc-mapper"; password = "hunter2" }; settings = @{} } | ConvertTo-Json -Depth 5
    $saveResp = Invoke-WebRequest -Uri "http://localhost:18791/api/save-config" -Method Post -Body $saveBody -ContentType "application/json" -Headers @{Origin="http://localhost:18791"} -SkipHttpErrorCheck
    if ($saveResp.StatusCode -ne 200) { throw "Could not seed credentials: $($saveResp.StatusCode) $($saveResp.Content)" }

    # This server session cached $JunosUsername/$JunosPassword at STARTUP (before the save
    # above) - same "this session started with no credentials" situation Plan B''s own
    # end-to-end test documents, so scan-network is expected to still 400 here, proving the
    # presence check is live. This is not a bug in this feature - it correctly demonstrates
    # that a fresh server process picks up newly-saved credentials only on its NEXT launch,
    # consistent with how Start-NetworkMapper.ps1 reads Configuration.json.enc once at
    # startup, not on every request.
    $scanResp = Invoke-WebRequest -Uri "http://localhost:18791/api/scan-network" -Method Post -Body (@{startIp="10.0.0.1"} | ConvertTo-Json) -ContentType "application/json" -Headers @{Origin="http://localhost:18791"} -SkipHttpErrorCheck
    if ($scanResp.StatusCode -ne 400) { throw "Expected 400 (this server session started with no credentials), got $($scanResp.StatusCode)" }
    Write-Host "Scan-without-credentials 400 OK (proves the presence check is wired end to end)" -ForegroundColor Green
} finally {
    if (-not $proc.HasExited) { $proc.Kill() }
    Remove-Item -Recurse -Force $dir
}
'
```

Expected: `Scan-without-credentials 400 OK (proves the presence check is wired end to end)`. This is the same "fresh server session, no credentials yet" situation Plan B's own Task 9 end-to-end test hits and documents - it is the correct, expected result here too (a real user launches with `Configuration.json.enc` already containing credentials from a previous session, which the Task 3/Task 1 smoke tests above already prove works when credentials ARE present at startup).

- [ ] **Step 2: Run the full existing JS test suite**

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox/PS_NetworkMapper_V2/Network_Visualizer
node --test src/test/*.test.mjs
```

Expected: all tests pass (this plan added no new `.test.mjs` files - `scan-network.js` has heavy DOM/fetch coupling like `map.js`/`drawer.js`, verified via the headless/live-endpoint checks in Tasks 3-4 instead, matching this codebase's existing split between node:test-covered pure logic and manually-verified DOM-coupled code).

- [ ] **Step 3: No commit** - this task is verification-only; nothing to stage.

---

## Self-Review Notes

- **Spec coverage:** starting-IP prompt when nothing is loaded (Task 4), auto-pick core/backbone node when a snapshot IS loaded (Task 4, `bestStartIpFromActiveSnapshot`/`computeGraphRoot`), button exists (Task 4), last-scan-path prepopulation explicitly NOT implemented (Global Constraints) - all covered.
- **Placeholder scan:** no "TBD"/"similar to Task N"/hand-waved error handling found on review - every step has literal code.
- **Type/signature consistency:** `Invoke-FleetCrawl`'s return shape (`Topology`/`ScanTimestampIso`/`OutputFile`/`VisitedCount`) is used identically by Task 2 (discarded via console `Write-Host`, matching the original CLI's own final summary) and Task 3 (`Invoke-ScanNetworkStatusAction` reads all four fields). `-ProgressTable`'s three keys (`Visited`/`QueueDepth`/`ActiveJobs`) written by Task 1 match exactly what Task 3's status response reads. The browser's `status.topology`/`status.scanTimestamp`/`status.outputFile`/`status.visitedCount` field names match `Invoke-ScanNetworkStatusAction`'s JSON object literally.
- **One genuinely open question, flagged rather than silently decided:** `Invoke-ScanNetworkAction`'s cross-runspace function-availability approach (`InitialSessionState.StartupScripts.Add(...)`) is less battle-tested in this codebase than the `AddCommand($WorkerPath)` pattern `Invoke-RescanAction`/the crawl loop already use for `Get-JunosNodeData.ps1` (a standalone script file, not a dot-sourced function). Task 3's Step 4 verification exercises this path directly against a real `HttpListener` and asserts a real completed crawl came back, which is the strongest verification available without a live Windows PowerShell 5.1 host in this environment - if that verification step fails, the most likely fix is switching `Invoke-ScanNetworkAction` to invoke `Invoke-FleetCrawl.ps1` as a script file via `AddCommand($FleetCrawlPath)` instead of a dot-sourced function name, mirroring the `Get-JunosNodeData.ps1` pattern exactly rather than the `InitialSessionState` approach - a same-shape fallback, not a redesign.

param (
    # No longer mandatory: omitting it starts the viewer (webserver + browser) straight
    # from existing snapshots, without running a crawl first - see the server-only branch
    # below. Pass it when you actually want a fresh crawl.
    [Parameter(HelpMessage="Starting IP address of the first switch - omit to launch the viewer against existing snapshots without crawling")]
    [string]$SwitchIP,

    # V2 shares its data (real switch credentials, snapshot history) with the original
    # PS_NetworkMapper/ instead of forking it - see the sibling-path default below. Only
    # the code (this webserver, the SSH-spawn action, the NDJSON ledger) is new.
    [string]$AuthFile = (Join-Path $PSScriptRoot "..\..\PS_NetworkMapper\Network_Mapper\Auth.json"),
    [string[]]$AllowedScopes = @("131.30."),

    [int]$MaxConcurrent = 10,
    [switch]$Log,
    # Output encryption is on by default (topology, clients, and - now - full device
    # config backups are sensitive enough that "on unless you opt in" was the wrong
    # default). Pass this to get a plain .json instead of .json.enc.
    [switch]$NoEncryption,

    # Bound to localhost only - see Start-WebServer.ps1's header comment for why LAN
    # exposure was deliberately ruled out rather than gated behind auth.
    [int]$WebPort = 8787
)

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
$WorkerPath = Join-Path $ScriptDir "lib\Get-JunosNodeData.ps1"
$ConnectScriptPath = Join-Path $ScriptDir "lib\Connect-Switch.ps1"
$VisualizerRoot = Join-Path $ScriptDir "..\Network_Visualizer"
. (Join-Path $ScriptDir "lib\Start-WebServer.ps1")
. (Join-Path $ScriptDir "lib\TopologyCrypto.ps1")
$DebugLog = Join-Path $ScriptDir "Mapper_Debug.log"
# Snapshots (and now the NDJSON device-history ledger) live in the ORIGINAL
# PS_NetworkMapper's Network_Maps/ folder, not a V2-local copy - shared per the
# fork-sharing decision above, so a V1 crawl and a V2 crawl land side by side in the same
# history instead of splitting it across two folders.
$SnapshotDir = Join-Path $ScriptDir "..\..\PS_NetworkMapper\Network_Maps"
if (-not (Test-Path $SnapshotDir)) { New-Item -ItemType Directory -Path $SnapshotDir -Force | Out-Null }
$DeviceHistoryLedger = Join-Path $SnapshotDir "device_history.ndjson"

# Server-only launch: no -SwitchIP means "just show me the viewer", not "crawl the
# fleet". Deliberately ahead of the Auth.json check below - browsing existing snapshots
# needs no switch credentials at all, and Connect-Switch.ps1 already throws its own clear
# error if the SSH-launch button is used without one.
if (-not $SwitchIP) {
    Start-MapperWebServer -VisualizerRoot $VisualizerRoot -ConnectScriptPath $ConnectScriptPath -AuthFile $AuthFile -WorkerPath $WorkerPath -Port $WebPort
    return
}

Write-Host "Initializing Enterprise Orchestrator starting at $SwitchIP..." -ForegroundColor Cyan
if ($Log) { Write-Host "[LOGGING ENABLED] Raw payloads will be saved to .\RawDumps\" -ForegroundColor Yellow }

# --- Output Encryption (AES-256-CBC, encrypt-then-MAC with HMAC-SHA256) ---
# Deliberately avoids AesGcm: it's .NET Core/5+ only, and this script also has to run
# under Windows PowerShell 5.1 (.NET Framework), which doesn't have it. CBC+HMAC needs
# nothing beyond Aes/Rfc2898DeriveBytes/HMACSHA256, all present on both runtimes, and
# both algorithms are natively available in the browser's Web Crypto API on the
# Network_Visualizer side, which decrypts this same format.
# OWASP's current PBKDF2-HMAC-SHA256 guidance (600k, up from 310k a few years ago).
# Safe to raise without breaking old files: iterations is stored per-file in the
# envelope and read back from it on decrypt, not assumed - see MIN/MAX_ITERATIONS in
# topology-crypto.js's decryptEnvelope, which accepts anything from 200k-era files up
# through this.
$PBKDF2_ITERATIONS = 600000
$EncKeyBytes = $null; $MacKeyBytes = $null; $SaltBytes = $null

# Single write path for all three call sites below (init/periodic/final) so encryption
# only has to be wired in once instead of duplicated three times.
function Write-TopologyOutput {
    param($Topology, [string]$Path)

    $PlainJson = @{ Topology = $Topology; ScanTimestamp = $ScanTimestampIso } | ConvertTo-Json -Depth 100

    if (-not $NoEncryption) {
        $Envelope = Protect-TopologyPayload -PlainJson $PlainJson -EncKey $EncKeyBytes -MacKey $MacKeyBytes -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS
        $Envelope | ConvertTo-Json -Depth 5 | Out-File -FilePath $Path -Encoding utf8
    } else {
        $PlainJson | Out-File -FilePath $Path -Encoding utf8
    }
}

if (-not (Test-Path $AuthFile)) { throw "Auth file missing at $AuthFile! V2 shares credentials with the original PS_NetworkMapper - copy PS_NetworkMapper\Network_Mapper\lib\Auth.example.json to PS_NetworkMapper\Network_Mapper\Auth.json, fill in real switch credentials, and set EncryptionPassword (or pass -NoEncryption). Alternatively pass -AuthFile to point at a different file." }
$AuthData = Get-Content $AuthFile -Raw | ConvertFrom-Json

if (-not $NoEncryption) {
    # Sourced from Auth.json rather than an interactive prompt so encryption can be on by
    # default without blocking unattended/scheduled runs on a password prompt. This does
    # mean Auth.json is now a higher-value target than before - it already held the live
    # switch credentials in plaintext, and now also gates every historical encrypted
    # snapshot. An attacker with Auth.json could already re-crawl the live switches
    # directly, so the marginal exposure is real but smaller than it first looks; still
    # worth knowing this trade was made deliberately, not accidentally.
    if (-not $AuthData.EncryptionPassword -or [string]::IsNullOrWhiteSpace($AuthData.EncryptionPassword)) {
        throw "Auth.json is missing an 'EncryptionPassword' field, required because output encryption is on by default. Add one to $AuthFile, or pass -NoEncryption to write plain .json instead."
    }
    $EncryptionPassword = $AuthData.EncryptionPassword
    Write-Host "Output encryption enabled (password from Auth.json) - Network_Visualizer will prompt for it when the file is opened." -ForegroundColor Yellow

    $SaltBytes = [byte[]]::new(16)
    $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $Rng.GetBytes($SaltBytes)
    $Rng.Dispose()

    $KeyMaterial = Get-TopologyKeyMaterial -Password $EncryptionPassword -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS
    $EncKeyBytes = $KeyMaterial.EncKey
    $MacKeyBytes = $KeyMaterial.MacKey
    $EncryptionPassword = $null
}

# Timestamped once per scan (not re-stamped on every periodic write below), so a single
# run's mid-crawl updates keep landing on the same file instead of scattering across many.
# Both strings come from the same captured instant so the filename and the in-payload
# timestamp (read by Network_Visualizer's crawl-age display) never drift apart.
$ScanDateTime = Get-Date
$ScanTimestamp = $ScanDateTime.ToString("yyyy-MM-dd_HHmmss")
$ScanTimestampIso = $ScanDateTime.ToString("o")
$OutputExtension = if (-not $NoEncryption) { ".json.enc" } else { ".json" }
$OutputFile = Join-Path $SnapshotDir "NetworkMap_$ScanTimestamp$OutputExtension"
$TempOutputFile = Join-Path $SnapshotDir "NetworkMap_$ScanTimestamp.tmp$OutputExtension"

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

# Appends one NDJSON line per device to the shared history ledger - additive to, not a
# replacement for, the full JSON/enc snapshot written above. The snapshot stays the
# source of truth for Topology Diff and "load folder of snapshots"; this ledger exists
# for the thing JSON snapshots are bad at: trend/history queries (Select-String or a grep
# over one growing file) without loading and parsing every snapshot on disk. Only called
# once, at the very end of a completed crawl - not on every 5-second periodic write - so
# each device gets exactly one ledger line per run, not one per partial flush.
function Write-DeviceHistoryLedger {
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
    # utf8: Add-Content's "utf8" means UTF-8-with-BOM on Windows PowerShell 5.1 but
    # BOM-less on 7+, and a re-emitted BOM landing mid-file on a later append would sit at
    # the start of some line and silently break every downstream per-line consumer
    # (Select-String, ConvertFrom-Json per line). AppendAllLines with BOM explicitly off
    # behaves identically on both runtimes.
    if ($Lines) { [System.IO.File]::AppendAllLines($LedgerPath, [string[]]$Lines, [System.Text.UTF8Encoding]::new($false)) }
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
Write-TopologyOutput -Topology @() -Path $OutputFile

try {
    Write-Host "`nStarting Crawl with $MaxConcurrent Threads. Press Ctrl+C to abort gracefully.`n" -ForegroundColor Yellow

    while ($Queue.Count -gt 0 -or $Jobs.Count -gt 0) {
        
        # 1. Fill available thread slots (Safely dequeueing)
        while ($Jobs.Count -lt $MaxConcurrent -and $Queue.Count -gt 0) {
            $NextIP = $Queue.Dequeue()
            
            # If already visited, skip immediately before spinning up a thread
            if (!$Visited.Add($NextIP)) { continue } 
            
            # -AuthFile passed explicitly (unlike V1, where the worker's own CWD-relative
            # default is enough because Auth.json sits next to it) - V2's $AuthFile now
            # resolves outside this folder entirely (shared with PS_NetworkMapper/), so the
            # worker's default ".\Auth.json" would look in the wrong place otherwise.
            $PS = [powershell]::Create().AddCommand($WorkerPath).AddParameter("TargetIP", $NextIP).AddParameter("AuthFile", $AuthFile)
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
            # Check for hard timeout (65 seconds max per node - stays above the worker's
            # own worst-case budget in Get-JunosNodeData.ps1: a single 50s interactive
            # batch (config backup now runs inside it, not as a second SSH call), plus
            # the same ~15s buffer used elsewhere, so a slow switch times out there
            # first instead of getting abandoned here mid-response)
            if (-not $Job.Handle.IsCompleted -and ((Get-Date) - $Job.StartTime).TotalSeconds -gt 65) {
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
            # Stop() before Dispose() matters specifically for the timeout path above: a
            # hung job's runspace may still genuinely be executing when it's abandoned
            # here, and Dispose() alone on a still-running pipeline does not reliably
            # release its slot back to the RunspacePool (bounded at $MaxConcurrent). Left
            # unreleased, each timeout permanently shrinks effective concurrency by one -
            # enough consistently-unreachable IPs in $AllowedScopes over a long crawl
            # exhausts the pool and the crawl stalls silently (still "running", queue
            # never draining). Stop() is a safe no-op on an already-completed pipeline, so
            # this is unconditional rather than branching on which path added the job.
            try { $DeadJob.PS.Stop() } catch { Write-DebugLog "Stop() failed for $($DeadJob.IP): $_" }
            $DeadJob.PS.Dispose()
            $Jobs.Remove($DeadJob) | Out-Null
        }

        # 4. Batch JSON Write (Only write if pending data exists AND 5 seconds have passed)
        if ($PendingWrites -gt 0 -and ((Get-Date) - $LastWriteTime).TotalSeconds -gt 5) {
            # A transient failure here (disk full, file briefly locked by an AV scanner,
            # etc.) must not abort a multi-hour crawl - nothing outside this loop catches
            # it, so an uncaught exception would kill the whole run and lose every device
            # not yet flushed to disk. Log and retry on the next iteration instead;
            # $PendingWrites/$LastWriteTime are deliberately left untouched on failure so
            # this batch is still considered pending and gets retried in 5 more seconds
            # rather than silently dropped.
            try {
                Update-ClientIpCorrelation -Topology $TopologyList
                Write-TopologyOutput -Topology $TopologyList -Path $TempOutputFile
                Move-Item -Path $TempOutputFile -Destination $OutputFile -Force
                $PendingWrites = 0
                $LastWriteTime = Get-Date
            } catch {
                Write-DebugLog "PERIODIC WRITE FAILED (will retry next cycle): $_"
            }

            # Force .NET Garbage Collection to keep RAM flat during long crawls
            [System.GC]::Collect()
        }

        # Prevent 100% CPU lockups
        Start-Sleep -Milliseconds 250
    }

    # Final Write Check
    if ($PendingWrites -gt 0) {
        Update-ClientIpCorrelation -Topology $TopologyList
        Write-TopologyOutput -Topology $TopologyList -Path $TempOutputFile
        Move-Item -Path $TempOutputFile -Destination $OutputFile -Force
    }
    # Unconditional (not gated on $PendingWrites) - every device that finished this run
    # gets exactly one ledger line, regardless of whether it arrived in the last periodic
    # batch or an earlier one already flushed to disk.
    Write-DeviceHistoryLedger -Topology $TopologyList -LedgerPath $DeviceHistoryLedger -ScanTimestampIso $ScanTimestampIso

    Write-Host "`n`n=================================================" -ForegroundColor Cyan
    Write-Host "Mapping Complete! Processed $($Visited.Count) devices." -ForegroundColor Green
    Write-Host "Topology saved to: $OutputFile" -ForegroundColor White
    Write-Host "Device history appended to: $DeviceHistoryLedger" -ForegroundColor White
    Write-Host "=================================================" -ForegroundColor Cyan
}
finally {
    $RunspacePool.Close(); $RunspacePool.Dispose()
    if (Test-Path $TempOutputFile) { Remove-Item -Path $TempOutputFile -Force }
}

# Once the crawl is done, launch the viewer: start the local webserver and open the
# default browser to it. Runs after the crawl (not instead of it) so the freshly-written
# snapshot is immediately available to "Load Folder of Snapshots" without a manual step -
# this call blocks (serving requests) until Ctrl+C.
Start-MapperWebServer -VisualizerRoot $VisualizerRoot -ConnectScriptPath $ConnectScriptPath -AuthFile $AuthFile -WorkerPath $WorkerPath -Port $WebPort

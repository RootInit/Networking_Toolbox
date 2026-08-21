param (
    [Parameter(Mandatory=$true, HelpMessage="Starting IP address of the first switch")]
    [string]$SwitchIP,

    [string]$AuthFile = ".\Auth.json",
    [string[]]$AllowedScopes = @("131.30."),

    [int]$MaxConcurrent = 10,
    [switch]$Log,
    # Output encryption is on by default (topology, clients, and - now - full device
    # config backups are sensitive enough that "on unless you opt in" was the wrong
    # default). Pass this to get a plain .json instead of .json.enc.
    [switch]$NoEncryption
)

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
$WorkerPath = Join-Path $ScriptDir "lib\Get-JunosNodeData.ps1"
$DebugLog = Join-Path $ScriptDir "Mapper_Debug.log"
# Snapshots live in the sibling Network_Maps/ folder (alongside Network_Mapper/ and
# Network_Visualizer/), not inside Network_Mapper/ itself - Network_Visualizer's own
# folder-load picker just needs a directory full of NetworkMap_*.json(.enc) files, and
# keeping every snapshot (real crawls and the shipped samples) in one place is what makes
# that picker useful instead of just a single-file convenience.
$SnapshotDir = Join-Path $ScriptDir "..\Network_Maps"
if (-not (Test-Path $SnapshotDir)) { New-Item -ItemType Directory -Path $SnapshotDir -Force | Out-Null }

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

# Builds an encrypted envelope from a plaintext JSON string. IV is fresh per call (per
# write); key/salt are derived once for the whole run and passed in, since PBKDF2 at
# 200k iterations is too slow to redo on every 5-second periodic write.
function Protect-TopologyPayload {
    param([string]$PlainJson, [byte[]]$EncKey, [byte[]]$MacKey, [byte[]]$Salt, [int]$Iterations)

    $Aes = [System.Security.Cryptography.Aes]::Create()
    $Aes.KeySize = 256
    $Aes.Key = $EncKey
    $Aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
    $Aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
    $Aes.GenerateIV()
    $IvBytes = $Aes.IV

    $PlainBytes = [System.Text.Encoding]::UTF8.GetBytes($PlainJson)
    $Encryptor = $Aes.CreateEncryptor()
    $CipherBytes = $Encryptor.TransformFinalBlock($PlainBytes, 0, $PlainBytes.Length)
    $Encryptor.Dispose()
    $Aes.Dispose()

    # HMAC covers IV + ciphertext (encrypt-then-MAC) so tampering with either is caught
    # before any bytes are handed to the decryptor - verified browser-side before decrypt.
    $Hmac = [System.Security.Cryptography.HMACSHA256]::new($MacKey)
    $MacBytes = $Hmac.ComputeHash($IvBytes + $CipherBytes)
    $Hmac.Dispose()

    return [ordered]@{
        format       = "PSNetworkMapper-EncryptedTopology"
        version      = 1
        kdf          = "PBKDF2-SHA256"
        iterations   = $Iterations
        cipher       = "AES-256-CBC"
        macAlgorithm = "HMAC-SHA256"
        salt         = [Convert]::ToBase64String($Salt)
        iv           = [Convert]::ToBase64String($IvBytes)
        mac          = [Convert]::ToBase64String($MacBytes)
        ciphertext   = [Convert]::ToBase64String($CipherBytes)
    }
}

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

if (-not (Test-Path $AuthFile)) { throw "Auth file missing at $AuthFile! Copy lib\Auth.example.json to Auth.json (in this directory), fill in real switch credentials, and set EncryptionPassword (or pass -NoEncryption)." }
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

    $Kdf = [System.Security.Cryptography.Rfc2898DeriveBytes]::new($EncryptionPassword, $SaltBytes, $PBKDF2_ITERATIONS, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
    $KeyMaterial = $Kdf.GetBytes(64)
    $Kdf.Dispose()
    $EncKeyBytes = $KeyMaterial[0..31]
    $MacKeyBytes = $KeyMaterial[32..63]
    # Best-effort only - PowerShell strings are managed/immutable, so this can't
    # guarantee the plaintext password is scrubbed from memory, just dereferenced.
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

    Write-Host "`n`n=================================================" -ForegroundColor Cyan
    Write-Host "Mapping Complete! Processed $($Visited.Count) devices." -ForegroundColor Green
    Write-Host "Topology saved to: $OutputFile" -ForegroundColor White
    Write-Host "=================================================" -ForegroundColor Cyan
}
finally {
    $RunspacePool.Close(); $RunspacePool.Dispose()
    if (Test-Path $TempOutputFile) { Remove-Item -Path $TempOutputFile -Force }
}

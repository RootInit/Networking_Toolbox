[CmdletBinding()]
param (
    [Parameter(Mandatory=$true)]
    [string]$TargetIP,

    [Parameter(Mandatory=$true)]
    [string]$Username,

    [Parameter(Mandatory=$true)]
    [string]$Password,

    [switch]$HumanReadable,

    # Only write raw payload text files if this flag is present.
    [switch]$Log,

    # Written as failures happen: a job the orchestrator abandons as hung never calls EndInvoke.
    [string]$DebugLogPath
)

$WorkerScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
. (Join-Path $WorkerScriptDir "SshHelpers.ps1")

# Everything below runs inside a try/finally so the plaintext askpass files are always removed.
$AskPass = $null
try {

$AskPass = New-JunosAskPass -Password $Password

# SECURITY: the config backup holds secrets (SNMP communities, RADIUS/TACACS+ keys), so redact it
# here, bounded to the next echoed prompt line. The prefix is non-greedy so it anchors on the
# FIRST/real config command; a greedy one would leave the earlier real secrets unredacted.
function Save-RawDump {
    param([string]$RawOutput)
    # Web paths run in a runspace pool with no working directory, so anchor next to $DebugLogPath.
    $DumpDir = if ($DebugLogPath) { Join-Path (Split-Path -Parent $DebugLogPath) "RawDumps" } else { Join-Path $PWD "RawDumps" }
    if (-not (Test-Path $DumpDir)) { New-Item -ItemType Directory -Path $DumpDir -Force | Out-Null }
    $RawLogPath = Join-Path $DumpDir "Raw_$TargetIP.txt"
    $RedactedOutput = $RawOutput -replace '(?ms)(^.*?>\s*show\s+configuration\s*\|\s*display\s+set[^\r\n]*[\r\n]+).*?(?=[\r\n]+(?:\{[^}]+\}[\r\n]+)?\S+@\S+[>#]|\z)', '$1[CONFIGURATION REDACTED - not written to RawDumps by design; see the Configuration field in NetworkMap output]'
    $RedactedOutput | Out-File $RawLogPath -Force -Encoding utf8
    return $RawLogPath
}

# No redaction needed - ssh's stderr carries no secrets, but its known-hosts line proves a handshake.
function Save-RawErrDump {
    param([string]$ErrOutput)
    $DumpDir = if ($DebugLogPath) { Join-Path (Split-Path -Parent $DebugLogPath) "RawDumps" } else { Join-Path $PWD "RawDumps" }
    if (-not (Test-Path $DumpDir)) { New-Item -ItemType Directory -Path $DumpDir -Force | Out-Null }
    $RawErrLogPath = Join-Path $DumpDir "RawErr_$TargetIP.txt"
    $ErrOutput | Out-File $RawErrLogPath -Force -Encoding utf8
    return $RawErrLogPath
}

$Logs = [System.Collections.Generic.List[string]]::new()

# Computed once: the name depends only on $DebugLogPath. Hashed in-script rather than with a .NET
# provider: under the Windows FIPS policy, MD5 and every *Managed hash class throw from their
# constructor, and String.GetHashCode is per-process randomized on Core. 0xFFFFFFFFL, not
# 0xFFFFFFFF - PowerShell parses the latter as Int32 -1, making the mask a no-op.
$LogMutexName = $null
if ($DebugLogPath) {
    $Hash = [long]2166136261
    foreach ($Byte in [System.Text.Encoding]::UTF8.GetBytes($DebugLogPath)) {
        $Hash = $Hash -bxor $Byte
        $Hash = ($Hash * 16777619) -band 0xFFFFFFFFL
    }
    $LogMutexName = "Global\JunosMapperLog_" + ('{0:x8}' -f $Hash)
}

function Write-LogMsg {
    param([string]$msg)
    $Line = "[$TargetIP] $msg"
    $Logs.Add($Line)
    if ($DebugLogPath) {
        # Out-File -Append takes an exclusive handle and many workers share this log: under 8-way
        # concurrency a bare retry loop lost over half the lines. The name is per-log-path.
        $Mutex = New-Object System.Threading.Mutex($false, $LogMutexName)
        $Acquired = $false
        try {
            # AbandonedMutexException still grants the mutex, and Out-File is never left half-written.
            try { $Acquired = $Mutex.WaitOne(5000) } catch [System.Threading.AbandonedMutexException] { $Acquired = $true }
            "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Line" | Out-File -FilePath $DebugLogPath -Append -Encoding utf8
        } catch {
        } finally {
            if ($Acquired) { try { $Mutex.ReleaseMutex() } catch {} }
            $Mutex.Dispose()
        }
    }
}

# ReadToEndAsync completes when the child closes its end, so a killed ssh.exe resolves immediately.
# .Result rethrows a faulted task; an unreadable stream is reported as empty.
function Get-StreamTaskText {
    param($Task)
    try {
        if ($Task.Wait(5000)) {
            $Text = $Task.Result
            if ($null -ne $Text) { return $Text }
        }
    } catch {}
    return ""
}

function Invoke-InteractiveBatch {
    $SshArgs = Get-JunosSshArgs -Username $Username -TargetIP $TargetIP
    # ssh.exe is started DIRECTLY, not via `cmd.exe /c`: Windows does not kill a child with its parent
    # and .NET Framework 4.x has no Kill(entireProcessTree), so killing a wrapper left ssh.exe holding
    # the session and a write handle on the unredacted config text.
    $SshExe = "ssh.exe"
    $SshCmd = Get-Command "ssh.exe" -CommandType Application -ErrorAction SilentlyContinue
    if ($SshCmd) { $SshExe = @($SshCmd)[0].Source }
    # No quoting needed (the regexes admit no whitespace); ArgumentList doesn't exist on .NET 4.x.
    $ProcInfo = New-Object System.Diagnostics.ProcessStartInfo($SshExe, ($SshArgs -join ' '))
    $ProcInfo.UseShellExecute = $false; $ProcInfo.CreateNoWindow = $true
    $ProcInfo.RedirectStandardInput = $true
    $ProcInfo.RedirectStandardOutput = $true
    $ProcInfo.RedirectStandardError = $true
    # Junos emits UTF-8; the default here is the console codepage, which mangles multi-byte text.
    $ProcInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $ProcInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8

    foreach ($EnvKey in $AskPass.EnvironmentVariables.Keys) { $ProcInfo.EnvironmentVariables[$EnvKey] = $AskPass.EnvironmentVariables[$EnvKey] }

    if ($HumanReadable) { Write-Host "  -> Establishing Interactive Shell & Injecting Commands..." -ForegroundColor DarkGray }

    $Process = $null
    # If ssh.exe exits immediately the pipe breaks and WriteLine throws; the finally still cleans up.
    $Output = ""; $ErrText = ""; $TimedOut = $false; $ExitCode = $null
    $Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        # A missing ssh.exe throws a Win32Exception naming nothing actionable - rethrow with the path.
        try {
            $Process = [System.Diagnostics.Process]::Start($ProcInfo)
        } catch {
            throw "Could not start ssh.exe ('$SshExe'): $_"
        }
        # Both reads start BEFORE the first write: reading one synchronously deadlocks on a full pipe.
        $OutTask = $Process.StandardOutput.ReadToEndAsync()
        $ErrTask = $Process.StandardError.ReadToEndAsync()

        $Process.StandardInput.WriteLine("set cli screen-length 0")
        # A forced pty with no real terminal gets sshd's default 80 columns, wrapping long records.
        $Process.StandardInput.WriteLine("set cli screen-width 0")
        $Process.StandardInput.WriteLine("show version")
        $Process.StandardInput.WriteLine("show virtual-chassis")
        $Process.StandardInput.WriteLine("show chassis hardware")
        $Process.StandardInput.WriteLine("show route 0/0 exact")
        $Process.StandardInput.WriteLine("show interfaces terse")
        $Process.StandardInput.WriteLine("show interfaces descriptions")
        $Process.StandardInput.WriteLine("show spanning-tree interface")
        $Process.StandardInput.WriteLine("show poe interface")
        $Process.StandardInput.WriteLine("show dot1x interface")
        $Process.StandardInput.WriteLine("show lldp neighbors detail")
        $Process.StandardInput.WriteLine("show vlans")
        $Process.StandardInput.WriteLine("show ethernet-switching table")
        $Process.StandardInput.WriteLine("show arp no-resolve")
        # ORDERING: after ARP, then smallest/most-critical first, so a timeout costs the least.
        $Process.StandardInput.WriteLine("show system uptime")
        $Process.StandardInput.WriteLine("show chassis alarms")
        $Process.StandardInput.WriteLine("show chassis routing-engine")
        $Process.StandardInput.WriteLine("show configuration | display set")
        $Process.StandardInput.WriteLine("show interfaces extensive")
        $Process.StandardInput.WriteLine("quit")
        $Process.StandardInput.Close()

        $Process.WaitForExit(120000) | Out-Null
        if (-not $Process.HasExited) {
            # Targets ssh.exe itself. Kill() races HasExited and throws if it exited in between.
            try { $Process.Kill() } catch {}
            $TimedOut = $true
            Write-LogMsg "TIMEOUT on interactive batch."
            # Kill() is async: ExitCode isn't valid until teardown finishes.
            $Process.WaitForExit()
        }

        $Output = Get-StreamTaskText -Task $OutTask
        # Named $ErrText, not $Error - $Error is PowerShell's automatic error-history variable.
        $ErrText = Get-StreamTaskText -Task $ErrTask
        try { $ExitCode = $Process.ExitCode } catch { $ExitCode = $null }
    } finally {
        if ($Process) {
            # A WriteLine throwing on a broken pipe skips the timeout kill above.
            try { if (-not $Process.HasExited) { $Process.Kill() } } catch {}
            $Process.Dispose()
        }
    }

    return @{
        Output = $Output; Error = $ErrText; TimedOut = $TimedOut
        ExitCode = $ExitCode; ElapsedSeconds = [Math]::Round($Stopwatch.Elapsed.TotalSeconds, 1)
    }
}

$NodeData = @{
    DeviceIP = $TargetIP; Hostname = "Unknown"; JunosVersion = "Unknown"; Gateway = "Unknown";
    StackMembers = @(); Neighbors = @(); Clients = @(); ArpEntries = @(); Interfaces = @{};
    Uptime = "Unknown"; LastConfigured = "Unknown"; LastConfiguredBy = "Unknown"; Alarms = @();
    # Only the RE that answered the CLI session (the master on a VC), not a VC-wide aggregate.
    MasterCpuUtilization = "Unknown"; MasterMemoryUtilization = "Unknown";
    # LLDP-MED endpoints (phones, APs), kept separate from Neighbors (switch-to-switch topology).
    MedNeighbors = @()
    # Full "show configuration | display set" text; redacted from RawDumps since it holds secrets.
    Configuration = "Unknown"
    # Tells "empty because unreachable" apart from "empty because this is an isolated leaf switch".
    ScanStatus = "Ok"; ScanError = $null
}

try {
    if ($HumanReadable) { Write-Host "`nGathering node data for $TargetIP..." -ForegroundColor Cyan }

    $Result = Invoke-InteractiveBatch

    $RawOutput = $Result.Output
    # Normalize to bare LF so no regex below has to tolerate a mix.
    if ($RawOutput) { $RawOutput = $RawOutput -replace "`r`n", "`n" }

    if ($Log -and -not [string]::IsNullOrWhiteSpace($RawOutput)) {
        $RawLogPath = Save-RawDump -RawOutput $RawOutput
        Write-LogMsg "Raw payload saved to $RawLogPath (configuration output redacted)"
    } elseif ($Result.TimedOut -and -not [string]::IsNullOrWhiteSpace($RawOutput)) {
        # Partial output from a killed batch shows how far it got, so dump it even without -Log.
        $RawLogPath = Save-RawDump -RawOutput $RawOutput
        Write-LogMsg "Partial payload (session timed out) saved to $RawLogPath (configuration output redacted)"
    }

    if ([string]::IsNullOrWhiteSpace($RawOutput)) {
        # ssh's stderr says WHY (timed out, permission denied, host key failure), capped so it can't
        # blow up the log. The pty advisory is benign but often the ONLY stderr line, which sent
        # operators chasing pty problems - filtered here; Save-RawErrDump keeps the original.
        $PtyAdvisory = 'Pseudo-terminal will not be allocated because stdin is not a terminal\.?'
        $StderrNoise = $null -ne $Result.Error -and $Result.Error -match $PtyAdvisory
        $ErrSummary = if (-not [string]::IsNullOrWhiteSpace($Result.Error)) {
            $Trimmed = (($Result.Error -split "`r?`n" | Where-Object { $_ -notmatch $PtyAdvisory }) -join "`n").Trim()
            if ([string]::IsNullOrWhiteSpace($Trimmed)) {
                "(ssh reported no error; the only stderr line was the benign no-pty advisory, which means ssh_config sets RequestTTY)"
            } elseif ($Trimmed.Length -gt 4000) { $Trimmed.Substring(0, 4000) + "...(truncated)" } else { $Trimmed }
        } else { "(no stderr output captured)" }
        if ($StderrNoise) { $ErrSummary = "$ErrSummary [ssh_config requests a TTY]" }
        # Distinguishes "ssh exited with nothing to show" from "idle until our WaitForExit killed it".
        $DiagTag = "[exit=$($Result.ExitCode) elapsed=$($Result.ElapsedSeconds)s timedOut=$($Result.TimedOut)]"
        $ErrSummary = "$DiagTag $ErrSummary"
        if ($HumanReadable) { Write-Host "  [!] CRITICAL ERROR: Switch returned empty payload. ssh said: $ErrSummary" -ForegroundColor Red }
        Write-LogMsg "CRITICAL: Switch returned empty payload. ssh stderr: $ErrSummary"
        if (-not [string]::IsNullOrWhiteSpace($Result.Error)) {
            try {
                $RawErrLogPath = Save-RawErrDump -ErrOutput $Result.Error
                Write-LogMsg "Raw stderr saved to $RawErrLogPath"
            } catch { Write-LogMsg "Failed to save raw stderr dump: $_" }
        }
        # This early return skips the hashtable-to-array conversion, so force @() or JSON emits "{}".
        $NodeData.Interfaces = @()
        # Matched against $Result.Error, not $ErrSummary - the latter now has $DiagTag prefixed.
        $NodeData.ScanStatus = if ($Result.Error -match "(?i)permission denied|authentication failed|too many authentication failures") {
            "AuthFailed"
        } elseif ($Result.Error -match "(?i)connection refused|no route to host|network is unreachable|operation timed out|connection timed out|could not resolve hostname|host is down|no address associated") {
            "Unreachable"
        } else {
            "Error"
        }
        $NodeData.ScanError = $ErrSummary
        return @{ Node = $NodeData; Logs = $Logs }
    }

    $DataDict = @{}
    $Sections = $RawOutput -split "(?m)^.*>\s*show\s+"
    
    foreach ($Sec in $Sections) {
        if ($Sec -match '^(?i)version\b[^\r\n]*[\r\n]+(?<content>(?s).*)$') { $DataDict["VERSION"] = $Matches.content }
        elseif ($Sec -match '^(?i)virtual-chassis\b[^\r\n]*[\r\n]+(?<content>(?s).*)$') { $DataDict["VIRTUAL_CHASSIS"] = $Matches.content }
        elseif ($Sec -match '^(?i)chassis hardware\b[^\r\n]*[\r\n]+(?<content>(?s).*)$') { $DataDict["CHASSIS_HARDWARE"] = $Matches.content }
        elseif ($Sec -match '^(?i)route 0/0 exact\b[^\r\n]*[\r\n]+(?<content>(?s).*)$') { $DataDict["ROUTE"] = $Matches.content }
        elseif ($Sec -match '^(?i)interfaces terse\b[^\r\n]*[\r\n]+(?<content>(?s).*)$') { $DataDict["INTERFACES_TERSE"] = $Matches.content }
        elseif ($Sec -match '^(?i)interfaces descriptions\b[^\r\n]*[\r\n]+(?<content>(?s).*)$') { $DataDict["INTERFACES_DESC"] = $Matches.content }
        elseif ($Sec -match '^(?i)interfaces extensive\b[^\r\n]*[\r\n]+(?<content>(?s).*)$') { $DataDict["INTERFACES_EXT"] = $Matches.content }
        elseif ($Sec -match '^(?i)spanning-tree interface\b[^\r\n]*[\r\n]+(?<content>(?s).*)$') { $DataDict["STP"] = $Matches.content }
        elseif ($Sec -match '^(?i)poe interface\b[^\r\n]*[\r\n]+(?<content>(?s).*)$') { $DataDict["POE"] = $Matches.content }
        elseif ($Sec -match '^(?i)dot1x interface\b[^\r\n]*[\r\n]+(?<content>(?s).*)$') { $DataDict["DOT1X"] = $Matches.content }
        elseif ($Sec -match '^(?i)lldp neighbors detail\b[^\r\n]*[\r\n]+(?<content>(?s).*)$') { $DataDict["LLDP"] = $Matches.content }
        elseif ($Sec -match '^(?i)vlans\b[^\r\n]*[\r\n]+(?<content>(?s).*)$') { $DataDict["VLANS"] = $Matches.content }
        elseif ($Sec -match '^(?i)ethernet-switching table\b[^\r\n]*[\r\n]+(?<content>(?s).*)$') { $DataDict["MAC_TABLE"] = $Matches.content }
        elseif ($Sec -match '^(?i)arp no-resolve\b[^\r\n]*[\r\n]+(?<content>(?s).*)$') { $DataDict["ARP_TABLE"] = $Matches.content }
        elseif ($Sec -match '^(?i)system uptime\b[^\r\n]*[\r\n]+(?<content>(?s).*)$') { $DataDict["UPTIME"] = $Matches.content }
        elseif ($Sec -match '^(?i)chassis alarms\b[^\r\n]*[\r\n]+(?<content>(?s).*)$') { $DataDict["ALARMS"] = $Matches.content }
        elseif ($Sec -match '^(?i)chassis routing-engine\b[^\r\n]*[\r\n]+(?<content>(?s).*)$') { $DataDict["ROUTING_ENGINE"] = $Matches.content }
        # The trailing prompt match is anchored to end-of-stream (`\z`), not literal "quit": that covers
        # a timeout mid-config and stops a login banner's prompt-shaped text from false-matching.
        elseif ($Sec -match '^(?i)configuration\s*\|\s*display\s+set\b[^\r\n]*[\r\n]+(?<content>(?s).*?)(?:[\r\n]+(?:{[^}]+}[\r\n]+)?\S+@\S+[>#](?s).*)?\z') { $DataDict["CONFIG"] = $Matches.content }
    }

    # A virtual chassis emits one "fpcN:" block per member, so a bare -match takes fpc0's, which is not
    # necessarily the master. The prompt's {master:N} marker names the RE that answered - otherwise a
    # separately-rebooted member supplies the boot time compared against the master's.
    $MasterFpcId = $null
    if ($RawOutput -match "(?m)^\{master:(?<fpc>\d+)\}") { $MasterFpcId = $Matches.fpc }
    $VersionScope = $DataDict["VERSION"]
    $UptimeScope = $DataDict["UPTIME"]
    if ($null -ne $MasterFpcId) {
        $MasterFpcBlockPattern = "(?ms)^fpc${MasterFpcId}:[^\r\n]*\r?\n(?:-+\r?\n)?(?<masterfpc>.*?)(?=^fpc\d+:|\z)"
        if ($DataDict["VERSION"] -match $MasterFpcBlockPattern) { $VersionScope = $Matches.masterfpc }
        if ($DataDict["UPTIME"] -match $MasterFpcBlockPattern) { $UptimeScope = $Matches.masterfpc }
    }

    if ($VersionScope -match "(?i)Hostname:\s*(?<host>\S+)") { $NodeData.Hostname = $Matches.host }
    if ($VersionScope -match "(?i)Junos:\s*(?<ver>\S+)") { $NodeData.JunosVersion = $Matches.ver }

    # Config backup is stored verbatim; redacted from RawDumps - see Save-RawDump.
    if (-not [string]::IsNullOrWhiteSpace($DataDict["CONFIG"])) { $NodeData.Configuration = $DataDict["CONFIG"].Trim() }
    
    $ParsedStack = $false
    if ($DataDict["VIRTUAL_CHASSIS"] -match "Member ID") {
        foreach ($Line in ($DataDict["VIRTUAL_CHASSIS"] -split "`n")) {
            $Line = $Line.Trim()
            if ($Line -match "^(?<id>\d+)\s+") {
                # Captured before the -match calls below overwrite $Matches.
                $fpcId = $Matches.id

                $role = "Unknown"
                if ($Line -match "(Master|Backup|Linecard)") { $role = $Matches[1] }

                $serial = "Unknown"
                if ($Line -match "\b([A-Z0-9]{10,})\b") { $serial = $Matches[1] }

                $model = "Unknown"
                if ($Line -match "(?i)\b(ex\d{4}[^\s]*|qfx\d{4}[^\s]*|srx\d{4}[^\s]*)\b") { $model = $Matches[1] }

                if ($serial -ne "Unknown") {
                    $NodeData.StackMembers += [PSCustomObject]@{ FPC = $fpcId; Model = $model; Serial = $serial; Role = $role }
                    $ParsedStack = $true
                }
            }
        }
    } 
    
    if (-not $ParsedStack) {
        # A VC reads "Chassis <serial> Virtual Chassis", so a \S+ capture took "Virtual" as the model.
        if ($DataDict["CHASSIS_HARDWARE"] -match "(?im)^Chassis\s+(?<serial>\S+)\s+(?<model>[^\r\n]+?)\s*$") {
            $ChassisSerial = $Matches.serial
            $ChassisModel = $Matches.model.Trim()
            if ($ChassisModel -match "(?i)^virtual\s+chassis$") { $ChassisModel = "Unknown" }
            $NodeData.StackMembers += [PSCustomObject]@{ FPC = "0"; Model = $ChassisModel; Serial = $ChassisSerial; Role = "Standalone" }
        }
    }

    if ($DataDict["ROUTE"] -match "to\s+(?<gw>\b(?:\d{1,3}\.){3}\d{1,3}\b)\s+via") { $NodeData.Gateway = $Matches.gw }

    if ($UptimeScope -match "(?i)System booted:\s*(?<boot>[^\(\r\n]+)") { $NodeData.Uptime = $Matches.boot.Trim() }
    if ($UptimeScope -match "(?i)Last configured:\s*(?<cfg>[^\(\r\n]+?)\s*\([^\)]*\)\s*by\s+(?<user>\S+)") {
        $NodeData.LastConfigured = $Matches.cfg.Trim()
        $NodeData.LastConfiguredBy = $Matches.user.Trim()
    }

    if ($DataDict["ALARMS"] -notmatch "(?i)no alarms currently active") {
        foreach ($Line in ($DataDict["ALARMS"] -split "`n")) {
            $Line = $Line.Trim()
            if ($Line -match "^(?<time>\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\S+)\s+(?<class>Major|Minor)\s+(?<desc>.+)$") {
                $NodeData.Alarms += [PSCustomObject]@{ Time = $Matches.time.Trim(); Class = $Matches.class; Description = $Matches.desc.Trim() }
            }
        }
    }

    # Slot order doesn't put the master first on dual-RE/VC systems, so scope to the "Current state ...
    # Master" block or the backup's health is reported as the master's.
    $MasterReBlock = $DataDict["ROUTING_ENGINE"]
    if ($DataDict["ROUTING_ENGINE"] -match "(?is)Current state\s+Master(?<masterblock>.*?)(?=Slot \d+:|\z)") {
        $MasterReBlock = $Matches.masterblock
    }
    if ($MasterReBlock -match "(?i)Idle\s+(?<idle>\d+)\s+percent") {
        $NodeData.MasterCpuUtilization = "$(100 - [int]$Matches.idle)%"
    }
    if ($MasterReBlock -match "(?i)Memory utilization\s+(?<mem>\d+)\s+percent") {
        $NodeData.MasterMemoryUtilization = "$($Matches.mem)%"
    }

    foreach ($Line in ($DataDict["INTERFACES_TERSE"] -split "`n")) {
        $Line = $Line.Trim()
        if ($Line -match "^(?<port>(?:ge|xe|et|ae|mge)[^\s]+)\s+(?<admin>up|down)\s+(?<link>up|down)") {
            # Strip the trailing ".N" logical unit so "ge-0/0/1.100" collapses onto "ge-0/0/1".
            $p = $Matches.port -replace "\.\d+$",""
            if (-not $NodeData.Interfaces.ContainsKey($p)) {
                $NodeData.Interfaces[$p] = @{ Port = $p; Admin = $Matches.admin; Link = $Matches.link; Desc = "Unknown"; STP = "Unknown"; PoE = "Unknown"; LastFlappedSeconds = $null }
            }
        }
    }

    foreach ($Line in ($DataDict["INTERFACES_DESC"] -split "`n")) {
        $Line = $Line.Trim()
        if ($Line -match "^(?<port>(?:ge|xe|et|ae|mge)[^\s]+)\s+(?:up|down)\s+(?:up|down)\s+(?<desc>.+)$") {
            $p = $Matches.port -replace "\.\d+$",""
            if ($NodeData.Interfaces.ContainsKey($p)) { $NodeData.Interfaces[$p].Desc = $Matches.desc.Trim() }
        }
    }

    # Only the relative "(... ago)" part is parsed: the absolute timestamp's abbreviated timezone isn't
    # reliably resolvable and the switch clock may differ. An unrecognized format leaves it unset.
    $ExtBlocks = $DataDict["INTERFACES_EXT"] -split "(?=Physical interface:)"
    foreach ($Block in $ExtBlocks) {
        if ($Block -notmatch "^Physical interface:\s*(?<port>(?:ge|xe|et|ae|mge)[^\s,]+)") { continue }
        $p = $Matches.port
        if (-not $NodeData.Interfaces.ContainsKey($p)) {
            Write-LogMsg "INTERFACES_EXT: port '$p' not found in terse output, skipping flap data"
            continue
        }
        if ($Block -match "(?im)^\s*Last flapped\s*:\s*Never") {
            $NodeData.Interfaces[$p].LastFlappedSeconds = $null
            continue
        }
        # Anchored to a line-start "Last flapped" label - Junos emits Description before it.
        if ($Block -match "(?im)^\s*Last flapped\s*:[^\(]*\(\s*(?:(?<w>\d+)w)?\s*(?:(?<d>\d+)d)?\s*(?:(?<h>\d+):(?<m>\d+)(?::(?<s>\d+))?)?\s*ago\s*\)") {
            $TotalSeconds = 0
            if ($Matches.w) { $TotalSeconds += [int]$Matches.w * 604800 }
            if ($Matches.d) { $TotalSeconds += [int]$Matches.d * 86400 }
            if ($Matches.h) { $TotalSeconds += [int]$Matches.h * 3600 }
            if ($Matches.m) { $TotalSeconds += [int]$Matches.m * 60 }
            if ($Matches.s) { $TotalSeconds += [int]$Matches.s }
            $NodeData.Interfaces[$p].LastFlappedSeconds = $TotalSeconds
        } elseif ($Block -match "(?im)^\s*Last flapped\s*:[^\(]*\(\s*(?<secs>\d+)\s*secs?\s*ago\s*\)") {
            $NodeData.Interfaces[$p].LastFlappedSeconds = [int]$Matches.secs
        }
    }

    # LACP bundle membership (physical port -> "aeN"). LLDP runs on the member links, so without this
    # map the uplink exclusion misses "aeN" and trunk MACs leak into Clients.
    $AeMemberOf = @{}
    foreach ($Line in ($DataDict["INTERFACES_TERSE"] -split "`n")) {
        $Line = $Line.Trim()
        if ($Line -match "^(?<phys>(?:ge|xe|et|mge)\S+)\.\d+\s+(?:up|down)\s+(?:up|down)\s+aenet\s+-->\s+(?<ae>ae\d+)\.") {
            $AeMemberOf[$Matches.phys] = $Matches.ae
        }
    }

    # "show spanning-tree interface" repeats a port per VLAN, and a trunk can be BLK in some. The field
    # stays one state string, so repeats collapse by precedence rather than last-VLAN-wins.
    $StpStatePrecedence = @{ BLK = 5; LST = 4; LRN = 3; FWD = 2; DIS = 1 }
    foreach ($Line in ($DataDict["STP"] -split "`n")) {
        $Line = $Line.Trim()
        if ($Line -match "^(?<port>(?:ge|xe|et|ae|mge)[^\s]+)\s+.*?(?<state>FWD|BLK|DIS|LRN|LST)") {
            # Strip any trailing ".N" (not just ".0") to land on the collapsed physical-port key.
            $p = $Matches.port -replace "\.\d+$",""
            $NewState = $Matches.state
            if ($NodeData.Interfaces.ContainsKey($p)) {
                $CurrentRank = 0
                $CurrentState = $NodeData.Interfaces[$p].STP
                if ($StpStatePrecedence.ContainsKey($CurrentState)) { $CurrentRank = $StpStatePrecedence[$CurrentState] }
                if ($StpStatePrecedence[$NewState] -gt $CurrentRank) { $NodeData.Interfaces[$p].STP = $NewState }
            }
        }
    }

    foreach ($Line in ($DataDict["POE"] -split "`n")) {
        $Line = $Line.Trim()
        # The field count between Oper and Power/Class varies by version, so anchor them as the last two.
        if ($Line -match "^(?<port>(?:ge|xe|et|ae|mge)[^\s]+)\s+(?<status>Enabled|Disabled)\s+(?<oper>\S+)(?:\s+\S+)*?\s+(?<power>\d+\.\d+W?)\s+(?<class>\S+)$") {
            $p = $Matches.port -replace "\.\d+$",""
            if ($NodeData.Interfaces.ContainsKey($p)) { $NodeData.Interfaces[$p].PoE = "$($Matches.oper) ($($Matches.power))" }
        }
    }

    $Dot1xDict = @{}
    foreach ($Line in ($DataDict["DOT1X"] -split "`n")) {
        if ($Line -match "(?<interface>\S+)\s+(?:Authenticator)?\s+(?<state>Authenticated|Initialize|Connecting|Held|Auto)\s+(?<mac>(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})(?:\s+(?<user>[^\s\r\n]+))?") {
            $Dot1xDict[$Matches.mac.ToLower()] = @{ State = $Matches.state; User = if ($Matches.user) { $Matches.user } else { "Unknown" } }
        }
    }

    # Local ports facing a confirmed switch/router, including ones with no management address.
    $LldpSwitchPorts = New-Object System.Collections.Generic.HashSet[string]
    $Blocks = $DataDict["LLDP"] -split "(?i)(?=Local Interface\s*:)"
    foreach ($Block in $Blocks) {
        $IsMedEndpoint = ($Block -match "Class III Device") -or ($Block -match "Bridge Telephone") -or ($Block -match "WLAN Access Point") -or ($Block -match "ArubaOS")
        # The capability list is on separate "Supported:"/"Enabled :" lines, so match "Enabled  :".
        $IsSwitchOrRouter = ($Block -match "(?i)Enabled\s*:\s*[^\r\n]*(?:Bridge|Router)")

        $Neigh = @{ LocalPort = "Unknown"; RemotePort = "Unknown"; Hostname = "Unknown"; MacAddress = "Unknown"; ManagementIP = "Unknown"; Description = "Unknown" }
        if ($Block -match "(?i)Local Interface\s*:\s*(?<port>[^\r\n]+)") { $Neigh.LocalPort = $Matches.port.Trim() }
        # Anchored: the block opens with "Local Port ID : <ifIndex>", which an unanchored match takes.
        if ($Block -match "(?im)^Port ID\s*:\s*(?<rport>[^\r\n]+)") { $Neigh.RemotePort = $Matches.rport.Trim() }
        if ($Block -match "(?i)System Name\s*:\s*(?<name>[^\r\n]+)") { $Neigh.Hostname = $Matches.name.Trim() }
        # Chassis ID's subtype isn't necessarily a MAC; a non-MAC would mislead MAC correlation.
        if ($Block -match "(?i)Chassis ID\s*:\s*(?<mac>[^\r\n]+)") {
            $ChassisId = $Matches.mac.Trim()
            if ($ChassisId -match "^(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$") { $Neigh.MacAddress = $ChassisId }
        }
        if ($Block -match "(?i)(?:Management Address|Address)\s*:\s*(?<ip>\b(?:\d{1,3}\.){3}\d{1,3}\b)") { $Neigh.ManagementIP = $Matches.ip.Trim() }
        if ($Block -match "(?i)System Description\s*:\s*(?<desc>[^\r\n]+)") { $Neigh.Description = $Matches.desc.Trim() }

        if ($IsMedEndpoint) {
            # Phones/APs rarely advertise a management address, so gate only on LocalPort.
            if ($Neigh.LocalPort -ne "Unknown") {
                $NodeData.MedNeighbors += [PSCustomObject]$Neigh
            }
        } else {
            $HasManagementIp = $Neigh.ManagementIP -ne "Unknown" -and $Neigh.ManagementIP -ne $TargetIP -and $Neigh.ManagementIP -ne "0.0.0.0"
            if ($Neigh.LocalPort -ne "Unknown" -and ($IsSwitchOrRouter -or $HasManagementIp)) {
                $LocalPhysPort = $Neigh.LocalPort -replace "\.\d+$",""
                [void]$LldpSwitchPorts.Add($LocalPhysPort)
                if ($AeMemberOf.ContainsKey($LocalPhysPort)) { [void]$LldpSwitchPorts.Add($AeMemberOf[$LocalPhysPort]) }
            }
            if ($HasManagementIp) {
                $NodeData.Neighbors += [PSCustomObject]$Neigh
            }
        }
    }

    # "show vlans" is "VLAN name  Tag  Interfaces", but gains a leading "Routing instance" column under
    # e.g. default-switch - detect the layout from the header, or VLAN_Tag is "Unknown" for every
    # client. $VlanDict is keyed "<instance>|<name>" there; $VlanNameTagIndex is a name-only fallback
    # for the MAC-table join, nulled the moment two instances disagree.
    $VlanDict = @{}
    $VlanNameTagIndex = @{}
    $HasRoutingInstanceColumn = $DataDict["VLANS"] -match "(?im)^\s*Routing instance\s"
    $LastSeenInstance = $null
    foreach ($Line in ($DataDict["VLANS"] -split "`n")) {
        if ($HasRoutingInstanceColumn) {
            $InstForRow = $null
            $NameForRow = $null
            $TagForRow = $null
            if ($Line -match "^(?<inst>\S+)\s+(?<name>\S+)\s+(?<tag>\d+)") {
                $InstForRow = $Matches.inst
                $NameForRow = $Matches.name
                $TagForRow = $Matches.tag
                $LastSeenInstance = $InstForRow
            } elseif ($LastSeenInstance -and $Line -match "^(?<name>\S+)\s+(?<tag>\d+)") {
                # Carry the last instance forward across a continuation row; gated on a prior 3-token row.
                $InstForRow = $LastSeenInstance
                $NameForRow = $Matches.name
                $TagForRow = $Matches.tag
            }
            if ($null -ne $InstForRow) {
                $VlanDict["$InstForRow|$NameForRow"] = $TagForRow
                if ($VlanNameTagIndex.ContainsKey($NameForRow)) {
                    if ($null -ne $VlanNameTagIndex[$NameForRow] -and $VlanNameTagIndex[$NameForRow] -ne $TagForRow) {
                        $VlanNameTagIndex[$NameForRow] = $null
                    }
                } else {
                    $VlanNameTagIndex[$NameForRow] = $TagForRow
                }
            }
        } else {
            if ($Line -match "^(?<name>\S+)\s+(?<tag>\d+)") { $VlanDict[$Matches.name] = $Matches.tag }
        }
    }

    # Ports facing a switch/router LLDP neighbor (phones/APs are MedNeighbors and not excluded) - a
    # downstream uplink otherwise contributes hundreds of unrelated MACs. Membership needs a positive
    # Bridge/Router signal or a management IP: misclassifying a phone would drop its real clients.
    $UplinkPorts = $LldpSwitchPorts

    # VC interconnect (vcp) and management (bme/reth/me/vme) interfaces never appear as LLDP neighbors,
    # so exclude them explicitly or MACs learned there leak into Clients.
    $InterconnectPortPattern = "^(?:vcp|bme|reth|me|vme)"

    # A MAC can appear on both an access port and an uplink. Keyed by MAC the last sighting wins, so an
    # access-port sighting always beats a non-access incumbent.
    $RawMacs = @{}
    $CurrentMacInstance = $null
    foreach ($Line in ($DataDict["MAC_TABLE"] -split "`n")) {
        if ($Line -match "(?i)^\s*Routing instance\s*:\s*(?<inst>\S+)") { $CurrentMacInstance = $Matches.inst; continue }
        # Two-letter flags (SE, NM) must be tried first, or the line fails and the client is dropped.
        if ($Line -match "(?<vlan>\S+)\s+(?<mac>(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})\s+(?<flag>SE|NM|[SDLPCNO])\s+.+?(?<interface>(?:ge|xe|et|ae|mge|vcp|bme|reth|me|vme)[a-zA-Z0-9\-\/\.]+)") {
            $VlanName = $Matches.vlan
            $VlanTag = "Unknown"
            if ($CurrentMacInstance -and $VlanDict.ContainsKey("$CurrentMacInstance|$VlanName")) {
                $VlanTag = $VlanDict["$CurrentMacInstance|$VlanName"]
            } elseif ($VlanNameTagIndex.ContainsKey($VlanName) -and $null -ne $VlanNameTagIndex[$VlanName]) {
                $VlanTag = $VlanNameTagIndex[$VlanName]
            } elseif ($VlanDict.ContainsKey($VlanName)) {
                $VlanTag = $VlanDict[$VlanName]
            }

            $MacKey = $Matches.mac.ToLower()
            $NewPhysPort = $Matches.interface -replace "\.\d+$",""
            $NewIsAccessPort = -not ($UplinkPorts.Contains($NewPhysPort) -or $NewPhysPort -match $InterconnectPortPattern)
            $Incumbent = $RawMacs[$MacKey]
            $IncumbentIsAccessPort = $false
            if ($Incumbent) {
                $IncumbentPhysPort = $Incumbent.Port -replace "\.\d+$",""
                $IncumbentIsAccessPort = -not ($UplinkPorts.Contains($IncumbentPhysPort) -or $IncumbentPhysPort -match $InterconnectPortPattern)
            }
            if (-not $Incumbent -or -not $IncumbentIsAccessPort -or $NewIsAccessPort) {
                $RawMacs[$MacKey] = @{
                    Port = $Matches.interface; VLAN_Name = $VlanName;
                    VLAN_Tag = $VlanTag;
                    Type = if ($Matches.flag -eq "D") { "Dynamic" } else { "Static/Other" }
                }
            }
        }
    }

    # Also exported raw, so the orchestrator can build a network-wide MAC->IP map.
    $ArpDict = @{}
    foreach ($Line in ($DataDict["ARP_TABLE"] -split "`n")) {
        if ($Line -match "(?<mac>(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})\s+(?<ip>\b(?:\d{1,3}\.){3}\d{1,3}\b)") {
            $macLower = $Matches.mac.ToLower()
            $ArpDict[$macLower] = $Matches.ip
            $NodeData.ArpEntries += [PSCustomObject]@{ MAC = $macLower; IP = $Matches.ip }
        }
    }

    # IP stays "Unknown" until the orchestrator's global enrichment pass when local ARP has no entry.
    foreach ($MacKey in $RawMacs.Keys) {
        $Entry = $RawMacs[$MacKey]
        $physPort = $Entry.Port -replace "\.\d+$",""
        if ($UplinkPorts.Contains($physPort) -or $physPort -match $InterconnectPortPattern) { continue }

        $Client = @{
            IP = if ($ArpDict.ContainsKey($MacKey)) { $ArpDict[$MacKey] } else { "Unknown" }
            MAC = $MacKey; Port = $Entry.Port; PortDesc = "Unknown"
            VLAN_Name = $Entry.VLAN_Name; VLAN_Tag = $Entry.VLAN_Tag; Type = $Entry.Type
            Dot1x_User = "Unknown"; Dot1x_State = "Unknown"
        }

        if ($NodeData.Interfaces.ContainsKey($physPort)) { $Client.PortDesc = $NodeData.Interfaces[$physPort].Desc }
        if ($Dot1xDict.ContainsKey($MacKey)) {
            $Client.Dot1x_User = $Dot1xDict[$MacKey].User; $Client.Dot1x_State = $Dot1xDict[$MacKey].State
        }
        $NodeData.Clients += [PSCustomObject]$Client
    }

} catch {
    Write-LogMsg "CRITICAL EXCEPTION: $_"
    Write-LogMsg "Stack trace: $($_.ScriptStackTrace)"
    # Reached only after a successful session, so anything here is a parser fault - dump $RawOutput.
    if (-not [string]::IsNullOrWhiteSpace($RawOutput)) {
        try {
            $RawLogPath = Save-RawDump -RawOutput $RawOutput
            Write-LogMsg "Raw payload that caused this exception saved to $RawLogPath (configuration output redacted)"
        } catch { Write-LogMsg "Failed to save raw payload dump: $_" }
    }
    if ($HumanReadable) { Write-Host "`n[!] SCRIPT EXCEPTION: $_" -ForegroundColor Red }
    # Flagged so a parser failure isn't mistaken for a clean scan.
    $NodeData.ScanStatus = "Error"
    $NodeData.ScanError = $_.ToString()
}

$InterfaceArray = @()
foreach ($Key in $NodeData.Interfaces.Keys) { $InterfaceArray += [PSCustomObject]$NodeData.Interfaces[$Key] }
# Wrapped in @(): Sort-Object collapses to a bare object for 1 item and $null for 0.
$NodeData.Interfaces = @($InterfaceArray | Sort-Object Port)

# --- Human-readable CLI output ---
if ($HumanReadable) {
    Write-Host "`n==================================================================" -ForegroundColor Cyan
    Write-Host " SWITCH NODE REPORT: $($NodeData.DeviceIP) / $($NodeData.Hostname)" -ForegroundColor Yellow
    Write-Host "==================================================================" -ForegroundColor Cyan
    Write-Host "Junos Version : $($NodeData.JunosVersion)"
    Write-Host "Default GW    : $($NodeData.Gateway)"
    Write-Host "Uptime        : $($NodeData.Uptime)"
    Write-Host "Last Config   : $($NodeData.LastConfigured) by $($NodeData.LastConfiguredBy)"
    Write-Host "RE CPU / Mem  : $($NodeData.MasterCpuUtilization) / $($NodeData.MasterMemoryUtilization)"
    if ($NodeData.Alarms.Count -gt 0) {
        Write-Host "Alarms        : $($NodeData.Alarms.Count) ACTIVE" -ForegroundColor Red
    } else {
        Write-Host "Alarms        : None" -ForegroundColor Green
    }
    if ($NodeData.Configuration -ne "Unknown") {
        $ConfigLineCount = ($NodeData.Configuration -split "`n").Count
        Write-Host "Config Backup : $ConfigLineCount lines captured (not shown here - not written to RawDumps either; see the JSON output)" -ForegroundColor DarkGray
    } else {
        Write-Host "Config Backup : FAILED or empty" -ForegroundColor Red
    }
    if ($Log) { Write-Host "Raw Log Dump  : .\RawDumps\Raw_$TargetIP.txt" -ForegroundColor DarkGray }
    
    Write-Host "`n--- Stack Members ---" -ForegroundColor Cyan
    if ($NodeData.StackMembers.Count -gt 0) {
        $NodeData.StackMembers | Select-Object FPC, Role, Model, Serial | Format-Table -AutoSize | Out-String | Write-Host
    } else { Write-Host "No hardware info parsed.`n" -ForegroundColor DarkGray }
    
    Write-Host "--- LLDP Neighbors ---" -ForegroundColor Cyan
    if ($NodeData.Neighbors.Count -gt 0) {
        $NodeData.Neighbors | Select-Object LocalPort, Hostname, ManagementIP, RemotePort | Format-Table -AutoSize | Out-String | Write-Host
    } else { Write-Host "No neighbors found.`n" -ForegroundColor DarkGray }
    
    Write-Host "--- Active Edge Clients (Preview) ---" -ForegroundColor Cyan
    if ($NodeData.Clients.Count -gt 0) {
        $NodeData.Clients | Select-Object IP, Port, VLAN_Tag, Dot1x_State, Dot1x_User -First 15 | Format-Table -AutoSize | Out-String | Write-Host
        Write-Host " (Showing first 15 of $($NodeData.Clients.Count) clients...)`n" -ForegroundColor DarkGray
    } else { Write-Host "No clients found.`n" -ForegroundColor DarkGray }
    
    Write-Host "--- Interfaces (Preview) ---" -ForegroundColor Cyan
    if ($NodeData.Interfaces.Count -gt 0) {
        $PhysicalPorts = $NodeData.Interfaces | Where-Object { $_.Port -notmatch "\.\d+$" }
        $PhysicalPorts | Select-Object Port, Admin, Link, STP, PoE, Desc -First 15 | Format-Table -AutoSize | Out-String | Write-Host
        Write-Host " (Showing first 15 interfaces of $($PhysicalPorts.Count) total...)`n" -ForegroundColor DarkGray
    }
    exit
}

# A killed batch that still delivered output parses fine, so the node looks complete while missing
# every command the kill cut off. Flagged Partial so the orchestrator can retry it.
if ($Result.TimedOut -and $NodeData.ScanStatus -eq "Ok") {
    $NodeData.ScanStatus = "Partial"
    $NodeData.ScanError = "Session timed out mid-batch; the commands after the last one captured are missing from this node."
}

return @{ Node = $NodeData; Logs = $Logs }

} finally {
    if ($AskPass) { Remove-JunosAskPass -AskPassContext $AskPass }
}

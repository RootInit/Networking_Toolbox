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

    # Failures are written here as they happen, not just buffered into $Logs: a job the
    # orchestrator abandons as hung never calls EndInvoke, so $Logs would never reach disk.
    [string]$DebugLogPath
)

$WorkerScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
. (Join-Path $WorkerScriptDir "SshHelpers.ps1")

# Everything below (New-JunosAskPass included) runs inside a try/finally so the plaintext
# askpass files are always removed, even on a partway failure (%TEMP% full/locked).
$AskPass = $null
try {

$AskPass = New-JunosAskPass -Password $Password

# SECURITY: the config backup holds secrets (SNMP communities, RADIUS/TACACS+ keys) and is
# stored verbatim, so redact it here - keep the command echo line, replace only that command's
# own output, bounded to the next echoed prompt line (config is not last in the batch).
# The prefix is non-greedy so it anchors on the FIRST/real echoed config command; a greedy
# prefix would latch onto a later prompt-shaped line (e.g. an operator-set interface
# Description) and leave the real secrets, earlier in the stream, unredacted.
#
# Every raw dump - success path and failure paths - goes through this one function; never
# inline the regex elsewhere, or a second copy will drift and leak.
function Save-RawDump {
    param([string]$RawOutput)
    # $PWD is only the repo root for the CLI -Log caller; web paths run in a runspace pool with
    # no guaranteed working directory, so anchor next to the caller-resolved $DebugLogPath.
    $DumpDir = if ($DebugLogPath) { Join-Path (Split-Path -Parent $DebugLogPath) "RawDumps" } else { Join-Path $PWD "RawDumps" }
    if (-not (Test-Path $DumpDir)) { New-Item -ItemType Directory -Path $DumpDir -Force | Out-Null }
    $RawLogPath = Join-Path $DumpDir "Raw_$TargetIP.txt"
    $RedactedOutput = $RawOutput -replace '(?ms)(^.*?>\s*show\s+configuration\s*\|\s*display\s+set[^\r\n]*[\r\n]+).*?(?=[\r\n]+(?:\{[^}]+\}[\r\n]+)?\S+@\S+[>#]|\z)', '$1[CONFIGURATION REDACTED - not written to RawDumps by design; see the Configuration field in NetworkMap output]'
    $RedactedOutput | Out-File $RawLogPath -Force -Encoding utf8
    return $RawLogPath
}

# ssh's stderr carries no secrets, so unlike Save-RawDump this needs no redaction. Worth
# keeping because the presence or absence of the "Permanently added ... to the list of known
# hosts" line (expected every run under StrictHostKeyChecking=no/UserKnownHostsFile=NUL)
# separates "reached a shell and got nothing back" from "never completed the handshake".
function Save-RawErrDump {
    param([string]$ErrOutput)
    $DumpDir = if ($DebugLogPath) { Join-Path (Split-Path -Parent $DebugLogPath) "RawDumps" } else { Join-Path $PWD "RawDumps" }
    if (-not (Test-Path $DumpDir)) { New-Item -ItemType Directory -Path $DumpDir -Force | Out-Null }
    $RawErrLogPath = Join-Path $DumpDir "RawErr_$TargetIP.txt"
    $ErrOutput | Out-File $RawErrLogPath -Force -Encoding utf8
    return $RawErrLogPath
}

$Logs = [System.Collections.Generic.List[string]]::new()
function Write-LogMsg {
    param([string]$msg)
    $Line = "[$TargetIP] $msg"
    $Logs.Add($Line)
    if ($DebugLogPath) {
        # Out-File -Append takes an exclusive handle, and many workers append to this shared log
        # concurrently: measured under 8-way concurrency, a bare try/catch with retries still
        # lost over half the lines. The mutex name is per-log-path so unrelated scans don't
        # serialize against each other.
        $MutexName = "Global\JunosMapperLog_" + [System.BitConverter]::ToString(
            [System.Security.Cryptography.MD5]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($DebugLogPath))
        ).Replace("-", "")
        $Mutex = New-Object System.Threading.Mutex($false, $MutexName)
        $Acquired = $false
        try {
            # AbandonedMutexException still grants us the mutex, and Out-File is never left
            # half-written, so a previous holder dying mid-write is safe to proceed through.
            try { $Acquired = $Mutex.WaitOne(5000) } catch [System.Threading.AbandonedMutexException] { $Acquired = $true }
            "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Line" | Out-File -FilePath $DebugLogPath -Append -Encoding utf8
        } catch {
        } finally {
            if ($Acquired) { try { $Mutex.ReleaseMutex() } catch {} }
            $Mutex.Dispose()
        }
    }
}

function Invoke-InteractiveBatch {
    param([switch]$ForcePty)

    $TempOut = Join-Path $env:TEMP "ssh_out_$([guid]::NewGuid().Guid.Substring(0,8)).txt"
    $TempErr = Join-Path $env:TEMP "ssh_err_$([guid]::NewGuid().Guid.Substring(0,8)).txt"

    $SshArgs = Get-JunosSshArgs -Username $Username -TargetIP $TargetIP -ForcePty:$ForcePty
    $ProcInfo = New-Object System.Diagnostics.ProcessStartInfo("cmd.exe", "/c ssh.exe $($SshArgs -join ' ') > `"$TempOut`" 2> `"$TempErr`"")
    $ProcInfo.UseShellExecute = $false; $ProcInfo.CreateNoWindow = $true
    $ProcInfo.RedirectStandardInput = $true

    foreach ($EnvKey in $AskPass.EnvironmentVariables.Keys) { $ProcInfo.EnvironmentVariables[$EnvKey] = $AskPass.EnvironmentVariables[$EnvKey] }

    if ($HumanReadable) { Write-Host "  -> Establishing Interactive Shell & Injecting Commands..." -ForegroundColor DarkGray }

    $Process = $null
    # If ssh.exe exits immediately (bad host, refused connection, askpass rejected) the pipe
    # breaks and a WriteLine throws. Temp-file reads/cleanup stay inside this try so a throw
    # still reaches the finally below - otherwise $TempOut/$TempErr leak across the crawl.
    $Output = ""; $ErrText = ""; $TimedOut = $false; $ExitCode = $null
    $Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $Process = [System.Diagnostics.Process]::Start($ProcInfo)

        $Process.StandardInput.WriteLine("set cli screen-length 0")
        # A forced pty with no real terminal gets sshd's default rows/cols, and an 80-column
        # wrap would silently corrupt parsing that assumes one logical line per record.
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
        # ORDERING: these five run after ARP (which client-IP correlation depends on), and among
        # themselves go smallest/most-critical first to largest/most-optional last, so a timeout
        # costs the least valuable data first. "show interfaces extensive" is by far the largest
        # and feeds only optional flap data, so it goes last of all.
        $Process.StandardInput.WriteLine("show system uptime")
        $Process.StandardInput.WriteLine("show chassis alarms")
        $Process.StandardInput.WriteLine("show chassis routing-engine")
        $Process.StandardInput.WriteLine("show configuration | display set")
        $Process.StandardInput.WriteLine("show interfaces extensive")
        $Process.StandardInput.WriteLine("quit")
        $Process.StandardInput.Close()

        $Process.WaitForExit(50000) | Out-Null
        if (-not $Process.HasExited) {
            $Process.Kill()
            $TimedOut = $true
            Write-LogMsg "TIMEOUT on interactive batch."
            # Kill() is async: ExitCode isn't valid until teardown finishes.
            $Process.WaitForExit()
        }

        # -Encoding UTF8 explicit: Junos emits UTF-8 for non-ASCII text, but Get-Content's
        # no-BOM default is the system ANSI codepage, which mangles multi-byte sequences.
        $Output = if (Test-Path $TempOut) { Get-Content $TempOut -Raw -Encoding UTF8 } else { "" }
        # Named $ErrText, not $Error - $Error is PowerShell's automatic error-history variable.
        $ErrText = if (Test-Path $TempErr) { Get-Content $TempErr -Raw -Encoding UTF8 } else { "" }
        try { $ExitCode = $Process.ExitCode } catch { $ExitCode = $null }
    } finally {
        if ($Process) { $Process.Dispose() }
        if (Test-Path $TempOut) { Remove-Item $TempOut -Force -ErrorAction SilentlyContinue }
        if (Test-Path $TempErr) { Remove-Item $TempErr -Force -ErrorAction SilentlyContinue }
    }

    return @{
        Output = $Output; Error = $ErrText; TimedOut = $TimedOut
        ExitCode = $ExitCode; ElapsedSeconds = [Math]::Round($Stopwatch.Elapsed.TotalSeconds, 1)
        ForcePty = $ForcePty.IsPresent
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
    # Lets callers tell "empty because unreachable" apart from "empty because this really is an
    # isolated leaf switch".
    ScanStatus = "Ok"; ScanError = $null
}

try {
    if ($HumanReadable) { Write-Host "`nGathering node data for $TargetIP..." -ForegroundColor Cyan }

    $Result = Invoke-InteractiveBatch

    # Empty stdout with no definitive ssh-level rejection in stderr (a pty can't fix those) is
    # retried exactly once with a forced pty: some Junos configurations appear not to attach a
    # CLI to a non-pty piped-stdin shell. Scoped to this failure shape only, so switches the
    # plain path already works for are unaffected.
    if ([string]::IsNullOrWhiteSpace($Result.Output)) {
        $LooksLikeDefiniteSshRejection = -not [string]::IsNullOrWhiteSpace($Result.Error) -and
            ($Result.Error -match "(?i)permission denied|authentication failed|too many authentication failures|connection refused|no route to host|network is unreachable|operation timed out|connection timed out|could not resolve hostname|host is down|no address associated")
        if (-not $LooksLikeDefiniteSshRejection) {
            Write-LogMsg "Empty payload on first (non-pty) attempt (exit=$($Result.ExitCode), elapsed=$($Result.ElapsedSeconds)s, timedOut=$($Result.TimedOut)); retrying once with a forced pty (-tt)."
            $PlainAttempt = $Result
            $Result = Invoke-InteractiveBatch -ForcePty
        }
    }
    $RawOutput = $Result.Output
    # Normalize to bare LF: a pty-mode retry can emit CRLF (kernel tty line discipline), and
    # relying on every regex below to tolerate a mix is more fragile than normalizing once.
    if ($RawOutput) { $RawOutput = $RawOutput -replace "`r`n", "`n" }

    # --- CONDITIONAL RAW LOG DUMP (config output redacted) ---
    if ($Log -and -not [string]::IsNullOrWhiteSpace($RawOutput)) {
        $RawLogPath = Save-RawDump -RawOutput $RawOutput
        Write-LogMsg "Raw payload saved to $RawLogPath (configuration output redacted)"
    } elseif ($Result.TimedOut -and -not [string]::IsNullOrWhiteSpace($RawOutput)) {
        # Partial output from a killed batch shows how far it got, so dump it even without -Log.
        $RawLogPath = Save-RawDump -RawOutput $RawOutput
        Write-LogMsg "Partial payload (session timed out) saved to $RawLogPath (configuration output redacted)"
    }

    if ([string]::IsNullOrWhiteSpace($RawOutput)) {
        # ssh's stderr says WHY (timed out, permission denied, host key failure). Capped so a
        # pathological dump can't blow up the debug log; ssh normally emits a handful of lines.
        # The pty advisory is emitted client-side while parsing arguments, before any socket
        # opens - it appears above even a DNS failure and is benign, but it is often the ONLY
        # stderr line, so reporting it verbatim sent operators chasing pty problems instead of
        # the real fault. Filtered out here; Save-RawErrDump below keeps the original. Its
        # presence does signal one thing: this code never passes -t, so ssh_config sets RequestTTY.
        $PtyAdvisory = 'Pseudo-terminal will not be allocated because stdin is not a terminal\.?'
        $StderrNoise = $null -ne $Result.Error -and $Result.Error -match $PtyAdvisory
        $ErrSummary = if (-not [string]::IsNullOrWhiteSpace($Result.Error)) {
            $Trimmed = (($Result.Error -split "`r?`n" | Where-Object { $_ -notmatch $PtyAdvisory }) -join "`n").Trim()
            if ([string]::IsNullOrWhiteSpace($Trimmed)) {
                "(ssh reported no error; the only stderr line was the benign no-pty advisory, which means ssh_config sets RequestTTY)"
            } elseif ($Trimmed.Length -gt 4000) { $Trimmed.Substring(0, 4000) + "...(truncated)" } else { $Trimmed }
        } else { "(no stderr output captured)" }
        if ($StderrNoise) { $ErrSummary = "$ErrSummary [ssh_config requests a TTY]" }
        # Distinguishes "ssh exited on its own with nothing to show" from "the session sat idle
        # until our 50s WaitForExit killed it" - identical from ScanError alone otherwise - and
        # records whether the forced-pty retry already got a fair try on this switch.
        $Attempt = if ($Result.ForcePty) { "forced-pty(-tt) retry" } else { "plain (no pty)" }
        $DiagTag = "[attempt=$Attempt exit=$($Result.ExitCode) elapsed=$($Result.ElapsedSeconds)s timedOut=$($Result.TimedOut)]"
        if ($PlainAttempt) {
            $DiagTag += " [first attempt: exit=$($PlainAttempt.ExitCode) elapsed=$($PlainAttempt.ElapsedSeconds)s timedOut=$($PlainAttempt.TimedOut), also empty]"
        }
        $ErrSummary = "$DiagTag $ErrSummary"
        if ($HumanReadable) { Write-Host "  [!] CRITICAL ERROR: Switch returned empty payload. ssh said: $ErrSummary" -ForegroundColor Red }
        Write-LogMsg "CRITICAL: Switch returned empty payload. ssh stderr: $ErrSummary"
        if (-not [string]::IsNullOrWhiteSpace($Result.Error)) {
            try {
                $RawErrLogPath = Save-RawErrDump -ErrOutput $Result.Error
                Write-LogMsg "Raw stderr saved to $RawErrLogPath"
            } catch { Write-LogMsg "Failed to save raw stderr dump: $_" }
        }
        # This early return skips the hashtable-to-array conversion below, so force @() or the
        # JSON serializes as "{}" instead of "[]" and consumers like CSV export choke.
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
        # The trailing prompt match is anchored to end-of-stream (`\z`), not to literal "quit":
        # that covers a timeout hitting mid-config, where the prompt is flushed but no further
        # command is echoed. Anchoring at end-of-stream rather than mid-content also stops a
        # login banner containing prompt-shaped text ("admin@example.com >") from false-matching.
        # The optional `{master:N}` group absorbs a VC member's prompt prefix.
        elseif ($Sec -match '^(?i)configuration\s*\|\s*display\s+set\b[^\r\n]*[\r\n]+(?<content>(?s).*?)(?:[\r\n]+(?:{[^}]+}[\r\n]+)?\S+@\S+[>#](?s).*)?\z') { $DataDict["CONFIG"] = $Matches.content }
    }

    # --- Parse Identity ---
    if ($DataDict["VERSION"] -match "(?i)Hostname:\s*(?<host>\S+)") { $NodeData.Hostname = $Matches.host }
    if ($DataDict["VERSION"] -match "(?i)Junos:\s*(?<ver>\S+)") { $NodeData.JunosVersion = $Matches.ver }

    # --- Parse Config Backup (stored verbatim, redacted from RawDumps - see above) ---
    if (-not [string]::IsNullOrWhiteSpace($DataDict["CONFIG"])) { $NodeData.Configuration = $DataDict["CONFIG"].Trim() }
    
    # --- Parse Stack/Hardware ---
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
        if ($DataDict["CHASSIS_HARDWARE"] -match "(?i)Chassis\s+(?<serial>\S+)\s+(?<model>\S+)") {
            $NodeData.StackMembers += [PSCustomObject]@{ FPC = "0"; Model = $Matches.model; Serial = $Matches.serial; Role = "Standalone" }
        }
    }

    # --- Parse Gateway ---
    if ($DataDict["ROUTE"] -match "to\s+(?<gw>\b(?:\d{1,3}\.){3}\d{1,3}\b)\s+via") { $NodeData.Gateway = $Matches.gw }

    # --- Parse Uptime / Last Config Change (both from "show system uptime") ---
    if ($DataDict["UPTIME"] -match "(?i)System booted:\s*(?<boot>[^\(\r\n]+)") { $NodeData.Uptime = $Matches.boot.Trim() }
    if ($DataDict["UPTIME"] -match "(?i)Last configured:\s*(?<cfg>[^\(\r\n]+?)\s*\([^\)]*\)\s*by\s+(?<user>\S+)") {
        $NodeData.LastConfigured = $Matches.cfg.Trim()
        $NodeData.LastConfiguredBy = $Matches.user.Trim()
    }

    # --- Parse Chassis Alarms ---
    if ($DataDict["ALARMS"] -notmatch "(?i)no alarms currently active") {
        foreach ($Line in ($DataDict["ALARMS"] -split "`n")) {
            $Line = $Line.Trim()
            if ($Line -match "^(?<time>\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\S+)\s+(?<class>Major|Minor)\s+(?<desc>.+)$") {
                $NodeData.Alarms += [PSCustomObject]@{ Time = $Matches.time.Trim(); Class = $Matches.class; Description = $Matches.desc.Trim() }
            }
        }
    }

    # --- Parse Routing Engine Health ---
    # Slot order in "show chassis routing-engine" doesn't put the master first on dual-RE/VC
    # systems, so scope the search to the "Current state ... Master" block or the backup's
    # health gets reported as the master's. A single-RE system has no such block and falls back
    # to the whole blob.
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

    # --- Parse Interfaces ---
    foreach ($Line in ($DataDict["INTERFACES_TERSE"] -split "`n")) {
        $Line = $Line.Trim()
        if ($Line -match "^(?<port>(?:ge|xe|et|ae|mge)[^\s]+)\s+(?<admin>up|down)\s+(?<link>up|down)") {
            # Strip the trailing ".N" logical-unit suffix so "ge-0/0/1" and "ge-0/0/1.100"
            # collapse onto one entry instead of producing duplicate interface rows.
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

    # "Last flapped" duration, e.g. "Last flapped : 2024-01-15 08:23:11 PST (5w2d 03:12:34 ago)".
    # Only the relative "(... ago)" part is parsed: the absolute timestamp carries an abbreviated
    # timezone name that .NET/JS parsers don't reliably resolve, and the switch's clock may not
    # agree with this host's. An unrecognized format leaves LastFlappedSeconds unset (excluded
    # from the "longest inactive" view) rather than guessing a wrong duration.
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
        # Two forms: the usual "w/d/h:m:s ago", and Junos's sub-minute "(N secs ago)". Anchored
        # to a line-start "Last flapped" label because Junos emits Description before it in the
        # same block, so an unanchored match could land inside that free-text value instead.
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

    # LACP bundle membership (physical port -> "aeN"). LLDP runs on an AE bundle's physical
    # member links, never on the "aeN" logical interface, so a neighbor reports LocalPort as
    # e.g. "xe-0/1/0"; without this map the uplink exclusion below misses "aeN" and every MAC
    # learned across that trunk leaks into Clients as a fake directly-attached device.
    $AeMemberOf = @{}
    foreach ($Line in ($DataDict["INTERFACES_TERSE"] -split "`n")) {
        $Line = $Line.Trim()
        if ($Line -match "^(?<phys>(?:ge|xe|et|mge)\S+)\.\d+\s+(?:up|down)\s+(?:up|down)\s+aenet\s+-->\s+(?<ae>ae\d+)\.") {
            $AeMemberOf[$Matches.phys] = $Matches.ae
        }
    }

    foreach ($Line in ($DataDict["STP"] -split "`n")) {
        $Line = $Line.Trim()
        if ($Line -match "^(?<port>(?:ge|xe|et|ae|mge)[^\s]+)\s+.*?(?<state>FWD|BLK|DIS|LRN|LST)") {
            # Strip any trailing ".N" (not just ".0") to land on the collapsed physical-port key.
            $p = $Matches.port -replace "\.\d+$",""
            if ($NodeData.Interfaces.ContainsKey($p)) { $NodeData.Interfaces[$p].STP = $Matches.state }
        }
    }

    foreach ($Line in ($DataDict["POE"] -split "`n")) {
        $Line = $Line.Trim()
        # The field count between Oper and Power/Class varies by Junos version/platform (newer
        # tables add Pair/Mode and Priority columns older EX2200/4200 ones lack), so skip a
        # variable number of fields and anchor Power+Class as the line's last two tokens.
        if ($Line -match "^(?<port>(?:ge|xe|et|ae|mge)[^\s]+)\s+(?<status>Enabled|Disabled)\s+(?<oper>\S+)(?:\s+\S+)*?\s+(?<power>\d+\.\d+W?)\s+(?<class>\S+)$") {
            $p = $Matches.port -replace "\.\d+$",""
            if ($NodeData.Interfaces.ContainsKey($p)) { $NodeData.Interfaces[$p].PoE = "$($Matches.oper) ($($Matches.power))" }
        }
    }

    # --- Parse ForeScout Dot1x ---
    $Dot1xDict = @{}
    foreach ($Line in ($DataDict["DOT1X"] -split "`n")) {
        if ($Line -match "(?<interface>\S+)\s+(?:Authenticator)?\s+(?<state>Authenticated|Initialize|Connecting|Held|Auto)\s+(?<mac>(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})(?:\s+(?<user>[^\s\r\n]+))?") {
            $Dot1xDict[$Matches.mac.ToLower()] = @{ State = $Matches.state; User = if ($Matches.user) { $Matches.user } else { "Unknown" } }
        }
    }

    # --- Parse LLDP Neighbors (switch-to-switch topology) + LLDP-MED Endpoints (phones/APs) ---
    # Local ports facing a neighbor confirmed as a switch/router, including ones with no
    # management address (see $UplinkPorts below for what this feeds).
    $LldpSwitchPorts = New-Object System.Collections.Generic.HashSet[string]
    $Blocks = $DataDict["LLDP"] -split "(?i)(?=Local Interface\s*:)"
    foreach ($Block in $Blocks) {
        $IsMedEndpoint = ($Block -match "Class III Device") -or ($Block -match "Bridge Telephone") -or ($Block -match "WLAN Access Point") -or ($Block -match "ArubaOS")
        # Real "show lldp neighbors detail" output puts a bare "System capabilities" header line
        # above separate "Supported:"/"Enabled  :" lines carrying the capability list - the word
        # "Capabilities" never appears on the same line as Bridge/Router, so matching on
        # "Enabled  :" alone is what makes this fire at all.
        $IsSwitchOrRouter = ($Block -match "(?i)Enabled\s*:\s*[^\r\n]*(?:Bridge|Router)")

        $Neigh = @{ LocalPort = "Unknown"; RemotePort = "Unknown"; Hostname = "Unknown"; MacAddress = "Unknown"; ManagementIP = "Unknown"; Description = "Unknown" }
        if ($Block -match "(?i)Local Interface\s*:\s*(?<port>[^\r\n]+)") { $Neigh.LocalPort = $Matches.port.Trim() }
        # Anchored to line start: the block opens with "Local Port ID : <ifIndex>", which an
        # unanchored "Port ID\s*:" matches first, yielding the local ifIndex integer instead of
        # the neighbor's remote port name.
        if ($Block -match "(?im)^Port ID\s*:\s*(?<rport>[^\r\n]+)") { $Neigh.RemotePort = $Matches.rport.Trim() }
        if ($Block -match "(?i)System Name\s*:\s*(?<name>[^\r\n]+)") { $Neigh.Hostname = $Matches.name.Trim() }
        # Chassis ID's LLDP subtype isn't necessarily a MAC (it can be an interface name, IP, or
        # locally-assigned string), so only store one that looks like a MAC - otherwise
        # downstream MAC-based correlation is misled.
        if ($Block -match "(?i)Chassis ID\s*:\s*(?<mac>[^\r\n]+)") {
            $ChassisId = $Matches.mac.Trim()
            if ($ChassisId -match "^(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$") { $Neigh.MacAddress = $ChassisId }
        }
        if ($Block -match "(?i)(?:Management Address|Address)\s*:\s*(?<ip>\b(?:\d{1,3}\.){3}\d{1,3}\b)") { $Neigh.ManagementIP = $Matches.ip.Trim() }
        if ($Block -match "(?i)System Description\s*:\s*(?<desc>[^\r\n]+)") { $Neigh.Description = $Matches.desc.Trim() }

        if ($IsMedEndpoint) {
            # Phones/APs rarely advertise a management address, so gate only on LocalPort - it's
            # what the visualizer's daisy-chain detection uses.
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

    # --- Parse VLANs ---
    # "show vlans" is "VLAN name  Tag  Interfaces", but gains a leading "Routing instance"
    # column where VLANs live under e.g. default-switch - detect the layout from the header, or
    # every line fails to match and VLAN_Tag is "Unknown" for every client (VLAN_Name comes
    # straight off the MAC table, so the symptom is "names right, tags wrong").
    # $VlanDict is keyed "<routing-instance>|<name>" in that layout so two instances defining
    # the same VLAN name with different tags don't collide last-write-wins. $VlanNameTagIndex is
    # a name-only fallback for the MAC-table join, which has no instance context: it holds a
    # tag only while every instance defining that name agrees, and is nulled the moment they
    # disagree, so only a genuinely ambiguous name degrades to "Unknown".
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
                # Defensive: if Junos ever blanks the routing-instance column on a continuation
                # row, carry the last instance forward instead of dropping the VLAN. Gated on a
                # prior 3-token row so a stray 2-token line (interface-list continuation) can't
                # fabricate an entry.
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

    # Ports facing a switch/router LLDP neighbor (phones/APs are MedNeighbors and deliberately
    # not excluded). A downstream switch's uplink shows up here as hundreds of unrelated client
    # MACs, so excluding these keeps Clients to devices this switch is the actual access point
    # for. Membership requires a positive Bridge/Router capability signal or a management IP -
    # never merely "not recognized as a MED endpoint" - because misclassifying an unrecognized
    # phone/AP/camera as an uplink would silently drop its real clients, worse than the leak.
    # Both this and $InterconnectPortPattern are defined here, not by the Clients loop, because
    # the MAC-table parse below needs them to prefer an access-port sighting over an uplink one.
    $UplinkPorts = $LldpSwitchPorts

    # VC interconnect (vcp) and management (bme/reth/me/vme) interfaces never appear as LLDP
    # neighbors, so they never reach $UplinkPorts - but the MAC-table regex below matches them
    # (needed for VC bookkeeping), so they must be excluded explicitly or MACs learned there
    # leak into Clients, same failure shape as the AE-trunk leak above.
    $InterconnectPortPattern = "^(?:vcp|bme|reth|me|vme)"

    # --- Parse MAC Table ---
    # A MAC can legitimately appear on both a real access port and an uplink/interconnect port.
    # Keyed by MAC alone the last sighting wins, and if that's the uplink one the exclusion
    # check below drops the client entirely - so an access-port sighting always beats a
    # non-access incumbent, while two non-access sightings keep last-write-wins.
    $RawMacs = @{}
    $CurrentMacInstance = $null
    foreach ($Line in ($DataDict["MAC_TABLE"] -split "`n")) {
        if ($Line -match "(?i)^\s*Routing instance\s*:\s*(?<inst>\S+)") { $CurrentMacInstance = $Matches.inst; continue }
        # The flag legend includes two-letter flags (SE, NM) alongside single-letter ones;
        # matching a single char only fails the whole line and silently drops that client, so
        # the two-letter tokens must be tried first.
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

    # --- Parse local ARP Table (also exported raw, so the orchestrator can build a
    # network-wide MAC->IP map for hosts whose ARP entry lives on the L3 gateway) ---
    $ArpDict = @{}
    foreach ($Line in ($DataDict["ARP_TABLE"] -split "`n")) {
        if ($Line -match "(?<mac>(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})\s+(?<ip>\b(?:\d{1,3}\.){3}\d{1,3}\b)") {
            $macLower = $Matches.mac.ToLower()
            $ArpDict[$macLower] = $Matches.ip
            $NodeData.ArpEntries += [PSCustomObject]@{ MAC = $macLower; IP = $Matches.ip }
        }
    }

    # --- Build Clients from the MAC table; IP stays "Unknown" until the orchestrator's global
    # enrichment pass when local ARP has no entry ---
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
    # Reached only after a successful SSH session produced output (connect/auth failures are
    # handled above, before parsing), so anything here is a parser fault and $RawOutput is the
    # payload that broke it - dump it even without -Log.
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
# Wrapped in @(...): `X | Sort-Object` collapses to a bare object for 1 item and $null for 0,
# so ConvertTo-Json would emit "{...}"/null instead of always an array.
$NodeData.Interfaces = @($InterfaceArray | Sort-Object Port)

# ==============================================================================
# HUMAN READABLE CLI OUTPUT
# ==============================================================================
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

return @{ Node = $NodeData; Logs = $Logs }

} finally {
    if ($AskPass) { Remove-JunosAskPass -AskPassContext $AskPass }
}

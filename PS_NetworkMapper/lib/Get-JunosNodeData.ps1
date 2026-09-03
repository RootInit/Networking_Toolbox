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
    [switch]$Log
)

$WorkerScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
. (Join-Path $WorkerScriptDir "SshHelpers.ps1")

$AskPass = New-JunosAskPass -Password $Password

# Everything below runs inside a try/finally so the plaintext askpass files
# (containing the real switch password) are always removed, even on error or exit.
try {

$Logs = [System.Collections.Generic.List[string]]::new()
function Write-LogMsg { param([string]$msg) $Logs.Add("[$TargetIP] $msg") }

function Invoke-InteractiveBatch {
    $TempOut = Join-Path $env:TEMP "ssh_out_$([guid]::NewGuid().Guid.Substring(0,8)).txt"
    $TempErr = Join-Path $env:TEMP "ssh_err_$([guid]::NewGuid().Guid.Substring(0,8)).txt"

    $SshArgs = Get-JunosSshArgs -Username $Username -TargetIP $TargetIP
    $ProcInfo = New-Object System.Diagnostics.ProcessStartInfo("cmd.exe", "/c ssh.exe $($SshArgs -join ' ') > `"$TempOut`" 2> `"$TempErr`"")
    $ProcInfo.UseShellExecute = $false; $ProcInfo.CreateNoWindow = $true
    $ProcInfo.RedirectStandardInput = $true

    foreach ($EnvKey in $AskPass.EnvironmentVariables.Keys) { $ProcInfo.EnvironmentVariables[$EnvKey] = $AskPass.EnvironmentVariables[$EnvKey] }

    if ($HumanReadable) { Write-Host "  -> Establishing Interactive Shell & Injecting Commands..." -ForegroundColor DarkGray }

    $Process = $null
    # If ssh.exe exits immediately (bad host, refused connection, askpass rejected) the pipe
    # breaks and a WriteLine throws. Temp-file reads/cleanup stay inside this try so a throw
    # still reaches the finally below - otherwise $TempOut/$TempErr leak across the crawl.
    $Output = ""; $ErrText = ""
    try {
        $Process = [System.Diagnostics.Process]::Start($ProcInfo)

        $Process.StandardInput.WriteLine("set cli screen-length 0")
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
        # These four come last, after the ARP table client-IP correlation depends on, so a
        # timeout truncates only this optional data. Config backup is last of the four since
        # it's the largest output, so a timeout costs it before uptime/alarms/RE-health.
        $Process.StandardInput.WriteLine("show system uptime")
        $Process.StandardInput.WriteLine("show chassis alarms")
        $Process.StandardInput.WriteLine("show chassis routing-engine")
        $Process.StandardInput.WriteLine("show configuration | display set")
        $Process.StandardInput.WriteLine("quit")
        $Process.StandardInput.Close()

        $Process.WaitForExit(50000) | Out-Null
        if (-not $Process.HasExited) { $Process.Kill(); Write-LogMsg "TIMEOUT on interactive batch." }

        # -Encoding UTF8 explicit: Junos emits UTF-8 for non-ASCII text, but Get-Content's
        # no-BOM default is the system ANSI codepage, which mangles multi-byte sequences.
        $Output = if (Test-Path $TempOut) { Get-Content $TempOut -Raw -Encoding UTF8 } else { "" }
        # Named $ErrText, not $Error - $Error is PowerShell's automatic error-history variable.
        $ErrText = if (Test-Path $TempErr) { Get-Content $TempErr -Raw -Encoding UTF8 } else { "" }
    } finally {
        if ($Process) { $Process.Dispose() }
        if (Test-Path $TempOut) { Remove-Item $TempOut -Force -ErrorAction SilentlyContinue }
        if (Test-Path $TempErr) { Remove-Item $TempErr -Force -ErrorAction SilentlyContinue }
    }

    return @{ Output = $Output; Error = $ErrText }
}

$NodeData = @{
    DeviceIP = $TargetIP; Hostname = "Unknown"; JunosVersion = "Unknown"; Gateway = "Unknown";
    StackMembers = @(); Neighbors = @(); Clients = @(); ArpEntries = @(); Interfaces = @{};
    Uptime = "Unknown"; LastConfigured = "Unknown"; LastConfiguredBy = "Unknown"; Alarms = @();
    # Reflects only the RE that answered the CLI session (the master on a VC), not an
    # aggregate across all members.
    MasterCpuUtilization = "Unknown"; MasterMemoryUtilization = "Unknown";
    # LLDP-MED endpoints (phones, APs), kept separate from Neighbors (switch-to-switch topology).
    MedNeighbors = @()
    # Full "show configuration | display set" text; redacted from the -Log RawDumps file
    # (see that block below) since it contains secrets.
    Configuration = "Unknown"
    # Distinguishes a real, successfully-scanned isolated leaf switch from a device that
    # was never actually reached, so callers (e.g. FleetCrawl.ps1) can tell "empty because
    # unreachable" apart from "empty because it genuinely has no neighbors/clients."
    ScanStatus = "Ok"; ScanError = $null
}

try {
    if ($HumanReadable) { Write-Host "`nGathering node data for $TargetIP..." -ForegroundColor Cyan }

    $Result = Invoke-InteractiveBatch
    $RawOutput = $Result.Output

    # --- CONDITIONAL RAW LOG DUMP (config output redacted) ---
    if ($Log -and -not [string]::IsNullOrWhiteSpace($RawOutput)) {
        $DumpDir = Join-Path $PWD "RawDumps"
        if (-not (Test-Path $DumpDir)) { New-Item -ItemType Directory -Path $DumpDir -Force | Out-Null }
        $RawLogPath = Join-Path $DumpDir "Raw_$TargetIP.txt"

        # Config backup contains secrets (SNMP communities, RADIUS/TACACS+ shared secrets, etc)
        # and is stored verbatim/unparsed, so redact it here: keep the command echo line,
        # replace everything after it (safe since this command is written last, see above).
        $RedactedOutput = $RawOutput -replace '(?ms)(^.*>\s*show\s+configuration\s*\|\s*display\s+set[^\r\n]*[\r\n]+).*\z', '$1[CONFIGURATION REDACTED - not written to RawDumps by design; see the Configuration field in NetworkMap output]'
        $RedactedOutput | Out-File $RawLogPath -Force -Encoding utf8
        Write-LogMsg "Raw payload saved to $RawLogPath (configuration output redacted)"
    }

    if ([string]::IsNullOrWhiteSpace($RawOutput)) {
        # ssh's stderr says WHY (timed out, permission denied, host key failure, etc).
        # Truncated so a pathological stderr dump can't blow up the log.
        $ErrSummary = if (-not [string]::IsNullOrWhiteSpace($Result.Error)) {
            $Trimmed = $Result.Error.Trim()
            if ($Trimmed.Length -gt 500) { $Trimmed.Substring(0, 500) + "...(truncated)" } else { $Trimmed }
        } else { "(no stderr output captured)" }
        if ($HumanReadable) { Write-Host "  [!] CRITICAL ERROR: Switch returned empty payload. ssh said: $ErrSummary" -ForegroundColor Red }
        Write-LogMsg "CRITICAL: Switch returned empty payload. ssh stderr: $ErrSummary"
        # Interfaces starts as a hashtable (converted to an array later in the normal path,
        # a step this early return skips) - force it to @() so it still serializes as JSON
        # "[]" instead of "{}", which some consumers (e.g. CSV export) choke on.
        $NodeData.Interfaces = @()
        # Classify the failure from ssh's stderr so a ghost node (never reached) is
        # distinguishable from a real, successfully-scanned isolated leaf switch.
        $NodeData.ScanStatus = if ($ErrSummary -match "(?i)permission denied|authentication failed|too many authentication failures") {
            "AuthFailed"
        } elseif ($ErrSummary -match "(?i)connection refused|no route to host|network is unreachable|operation timed out|connection timed out|could not resolve hostname|host is down|no address associated") {
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
        # No "show " follows this section ("quit" does), so stop non-greedily at a trailing
        # CLI prompt line anchored to end-of-stream (`\z`) rather than on literal "quit" -
        # large configs often hit the 50s timeout with the prompt flushed but "quit" not yet
        # written. Anchoring to end-of-stream (not mid-content) avoids false-triggering on a
        # login banner containing prompt-shaped text like "admin@example.com >". The optional
        # `{master:N}` group absorbs a VC member's prompt prefix; bare `\z` is the fallback.
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
                # Captured immediately, before any further -match calls below overwrite
                # $Matches - otherwise reading $Matches.id later picks up whichever regex
                # (role/serial/model) happened to match last, not the id match, leaving
                # FPC blank.
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
    # On dual-RE/VC systems, slot order in "show chassis routing-engine" doesn't guarantee
    # the master comes first, so scope the CPU/memory search to the "Current state ...
    # Master" block specifically (not just the first match anywhere) to avoid reporting the
    # backup's health as the master's. A standalone single-RE system has no "Current state"/
    # "Slot N:" fields, so this pattern just won't match and the fallback searches the whole blob.
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
            # Strip any trailing ".N" logical-unit suffix so a port's physical line and its
            # logical-unit line(s) (e.g. "ge-0/0/1" and "ge-0/0/1.100") collapse onto the
            # same dict entry instead of creating duplicate interface rows.
            $p = $Matches.port -replace "\.\d+$",""
            if (-not $NodeData.Interfaces.ContainsKey($p)) {
                $NodeData.Interfaces[$p] = @{ Port = $p; Admin = $Matches.admin; Link = $Matches.link; Desc = "Unknown"; STP = "Unknown"; PoE = "Unknown" }
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

    # LACP bundle membership (physical port -> "aeN"), from "show interfaces terse"'s
    # "<phys>.<unit>  up  up  aenet  --> aeN.<unit>" lines. LLDP runs on the physical member
    # links of an AE bundle, never on the "aeN" logical interface itself, so a neighbor
    # discovered there reports LocalPort as e.g. "xe-0/1/0" - the uplink-exclusion check below
    # needs this map to also recognize "aeN" as an uplink, or every MAC learned across that
    # trunk (every VLAN it carries, from devices this switch never directly saw) leaks into
    # Clients as if directly attached, on port "aeN.0", almost entirely with "Unknown" IP.
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
            # Strip any trailing ".N" (not just ".0") so this lands on the same collapsed
            # physical-port entry the terse/desc loops above key by.
            $p = $Matches.port -replace "\.\d+$",""
            if ($NodeData.Interfaces.ContainsKey($p)) { $NodeData.Interfaces[$p].STP = $Matches.state }
        }
    }

    foreach ($Line in ($DataDict["POE"] -split "`n")) {
        $Line = $Line.Trim()
        if ($Line -match "^(?<port>(?:ge|xe|et|ae|mge)[^\s]+)\s+(?<status>Enabled|Disabled)\s+(?<oper>\S+)\s+\S+\s+(?<class>\S+)\s+(?<power>\d+\.\d+W)") {
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
    # Tracks every LLDP neighbor confirmed to be a switch/router by its advertised LLDP
    # capabilities (see the $UplinkPorts comment below), even one without a usable management
    # address - a switch neighbor that doesn't advertise one must still count as an uplink, or
    # its downstream MAC-table entries leak into Clients. Deliberately requires a positive
    # "Bridge"/"Router" capability signal rather than just "not recognized as a MED endpoint" -
    # an unrecognized phone/AP/camera falling into the wrong bucket here would silently drop
    # its real clients from the scan output, which is worse than the leak this guards against.
    $LldpSwitchPorts = New-Object System.Collections.Generic.HashSet[string]
    $Blocks = $DataDict["LLDP"] -split "(?i)(?=Local Interface\s*:)"
    foreach ($Block in $Blocks) {
        $IsMedEndpoint = ($Block -match "Class III Device") -or ($Block -match "Bridge Telephone") -or ($Block -match "WLAN Access Point") -or ($Block -match "ArubaOS")
        $IsSwitchOrRouter = ($Block -match "(?i)(?:Enabled|System)\s+Capabilities\s*:\s*[^\r\n]*(?:Bridge|Router)")

        $Neigh = @{ LocalPort = "Unknown"; RemotePort = "Unknown"; Hostname = "Unknown"; MacAddress = "Unknown"; ManagementIP = "Unknown"; Description = "Unknown" }
        if ($Block -match "(?i)Local Interface\s*:\s*(?<port>[^\r\n]+)") { $Neigh.LocalPort = $Matches.port.Trim() }
        if ($Block -match "(?i)Port ID\s*:\s*(?<rport>[^\r\n]+)") { $Neigh.RemotePort = $Matches.rport.Trim() }
        if ($Block -match "(?i)System Name\s*:\s*(?<name>[^\r\n]+)") { $Neigh.Hostname = $Matches.name.Trim() }
        if ($Block -match "(?i)Chassis ID\s*:\s*(?<mac>[^\r\n]+)") { $Neigh.MacAddress = $Matches.mac.Trim() }
        if ($Block -match "(?i)(?:Management Address|Address)\s*:\s*(?<ip>\b(?:\d{1,3}\.){3}\d{1,3}\b)") { $Neigh.ManagementIP = $Matches.ip.Trim() }
        if ($Block -match "(?i)System Description\s*:\s*(?<desc>[^\r\n]+)") { $Neigh.Description = $Matches.desc.Trim() }

        if ($IsMedEndpoint) {
            # Phones/APs rarely advertise a management address, so gate only on LocalPort
            # (unlike Neighbors below) - it's what the visualizer's daisy-chain detection uses.
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
    # "show vlans" is "VLAN name  Tag  Interfaces" on a switch with no explicit
    # routing-instance, but gains a leading "Routing instance" column ("Routing instance
    # VLAN name  Tag  Interfaces") on one where VLANs live under e.g. default-switch -
    # detect which layout is present from the header rather than assuming one, or every
    # line silently fails to match on whichever layout wasn't assumed and VLAN_Tag ends
    # up "Unknown" for every client (VLAN_Name is unaffected - it's read straight off the
    # MAC table, not through this lookup - so a mismatch here shows up as "VLAN_Name is
    # right everywhere but VLAN_Tag/the VLAN filter is not").
    # $VlanDict is keyed "<routing-instance>|<name>" when the layout has an instance column,
    # so two different routing-instances defining the same VLAN name (e.g. "guest"=100 under
    # one instance, "guest"=200 under another) don't collide into a single last-write-wins
    # entry. $VlanNameTagIndex is a parallel name-only index used as a fallback at the MAC-table
    # join below (which has no routing-instance context of its own): it holds a VLAN name's tag
    # only while every routing-instance that defines that name agrees on the tag, and is forced
    # to $null the moment two instances disagree - so an unambiguous name still resolves
    # correctly, and only a genuinely colliding name falls back to "Unknown" instead of silently
    # returning whichever instance's tag happened to be seen there.
    $VlanDict = @{}
    $VlanNameTagIndex = @{}
    $HasRoutingInstanceColumn = $DataDict["VLANS"] -match "(?im)^\s*Routing instance\s"
    foreach ($Line in ($DataDict["VLANS"] -split "`n")) {
        if ($HasRoutingInstanceColumn) {
            if ($Line -match "^(?<inst>\S+)\s+(?<name>\S+)\s+(?<tag>\d+)") {
                $VlanDict["$($Matches.inst)|$($Matches.name)"] = $Matches.tag
                if ($VlanNameTagIndex.ContainsKey($Matches.name)) {
                    if ($null -ne $VlanNameTagIndex[$Matches.name] -and $VlanNameTagIndex[$Matches.name] -ne $Matches.tag) {
                        $VlanNameTagIndex[$Matches.name] = $null
                    }
                } else {
                    $VlanNameTagIndex[$Matches.name] = $Matches.tag
                }
            }
        } else {
            if ($Line -match "^(?<name>\S+)\s+(?<tag>\d+)") { $VlanDict[$Matches.name] = $Matches.tag }
        }
    }

    # Ports with a switch/router LLDP neighbor (not a phone/AP - those are MedNeighbors and
    # deliberately not excluded here). A downstream switch's uplink shows up in this switch's
    # MAC table as hundreds of unrelated client MACs; excluded so Clients only reflects
    # devices this switch is the actual access point for. Built from $LldpSwitchPorts, which
    # is wider than $NodeData.Neighbors (management IP required there for the topology-edge
    # display) - it also includes a neighbor confirmed as a switch/router by its LLDP
    # capabilities even without a management address - but never wider than "confirmed
    # switch/router or has a management IP", so an unrecognized endpoint device can't be
    # mistaken for an uplink and silently swallow its own clients. Defined here (rather than
    # just above the Clients-building loop) because the MAC-table parse loop below needs it
    # too, to prefer an access-port sighting over an uplink/interconnect one when the same
    # MAC is seen on both.
    $UplinkPorts = $LldpSwitchPorts

    # Virtual-chassis interconnect (vcp) and management (bme/reth/me/vme) interfaces are
    # never LLDP neighbors, so they'd never land in $UplinkPorts above - yet the MAC-table
    # regex below deliberately still matches them (it needs to, for other VC bookkeeping),
    # so a MAC learned on one of these must be excluded as a client (below, and at the
    # dedup preference just below) or it leaks into Clients as a fake directly-attached
    # device, the same failure shape as the already-fixed LACP/AE trunk-VLAN leak. Defined
    # here (rather than just above the Clients-building loop) because the MAC-table parse
    # loop needs it too, to prefer an access-port sighting over an uplink/interconnect one.
    $InterconnectPortPattern = "^(?:vcp|bme|reth|me|vme)"

    # --- Parse MAC Table ---
    # A MAC can legitimately appear more than once in "show ethernet-switching table" - e.g.
    # visible via both a real access port and an uplink/interconnect port. Keying $RawMacs by
    # MAC alone means the last-parsed sighting wins; if that happens to be the uplink/
    # interconnect one, the client is dropped entirely by the exclusion check below even
    # though an access-port sighting for the same MAC was right there. Track whether the
    # currently-stored sighting for a MAC is an access-port one and only let a later line
    # overwrite it when the incumbent isn't (so an access-port sighting always wins, and among
    # two non-access sightings the last one parsed still wins, same as before).
    $RawMacs = @{}
    $CurrentMacInstance = $null
    foreach ($Line in ($DataDict["MAC_TABLE"] -split "`n")) {
        if ($Line -match "(?i)^\s*Routing instance\s*:\s*(?<inst>\S+)") { $CurrentMacInstance = $Matches.inst; continue }
        # Junos's documented flag legend for "show ethernet-switching table" includes the
        # two-letter flags SE (statistics enabled) and NM (non-configured MAC) alongside the
        # single-letter ones; matching only a single char here failed the whole line's regex
        # and silently dropped that client. Try the two-letter tokens first.
        if ($Line -match "(?<vlan>\S+)\s+(?<mac>(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})\s+(?<flag>SE|NM|[SDLPCNO])\s+.+?(?<interface>(?:ge|xe|et|ae|vcp|bme|reth|me|vme)[a-zA-Z0-9\-\/\.]+)") {
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

    # --- Parse local ARP Table (enriches this node's own clients; also exported raw so
    # the orchestrator can build a network-wide MAC->IP map for downstream hosts whose ARP
    # entry lives on the L3 gateway instead) ---
    $ArpDict = @{}
    foreach ($Line in ($DataDict["ARP_TABLE"] -split "`n")) {
        if ($Line -match "(?<mac>(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})\s+(?<ip>\b(?:\d{1,3}\.){3}\d{1,3}\b)") {
            $macLower = $Matches.mac.ToLower()
            $ArpDict[$macLower] = $Matches.ip
            $NodeData.ArpEntries += [PSCustomObject]@{ MAC = $macLower; IP = $Matches.ip }
        }
    }

    # --- Build Clients from the MAC table. IP comes from local ARP when available;
    # otherwise "Unknown" until the orchestrator's global enrichment pass. ---
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
    if ($HumanReadable) { Write-Host "`n[!] SCRIPT EXCEPTION: $_" -ForegroundColor Red }
    # Reached only after a successful SSH session (ssh's own connect/auth failures are
    # handled above, before parsing starts) - so any exception here is a parsing/script
    # error, not a connectivity problem. Still worth flagging so this node isn't mistaken
    # for a clean scan.
    $NodeData.ScanStatus = "Error"
    $NodeData.ScanError = $_.ToString()
}

$InterfaceArray = @()
foreach ($Key in $NodeData.Interfaces.Keys) { $InterfaceArray += [PSCustomObject]$NodeData.Interfaces[$Key] }
# Wrapped in @(...): `X | Sort-Object` alone collapses to a bare object for 1 item, or
# $null for 0, so ConvertTo-Json would emit "{...}"/null instead of always an array.
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
    Remove-JunosAskPass -AskPassContext $AskPass
}

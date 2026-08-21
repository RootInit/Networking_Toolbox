[CmdletBinding()]
param (
    [Parameter(Mandatory=$true)]
    [string]$TargetIP,
    
    [string]$AuthFile = ".\Auth.json",
    
    [switch]$HumanReadable,
    
    # NEW: Only write raw payload text files if this flag is present
    [switch]$Log 
)

$WorkerScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
. (Join-Path $WorkerScriptDir "Connect-JunosSsh.ps1")

$Auth = Get-JunosAuth -AuthFile $AuthFile
$Username = $Auth.Username
$AskPass = New-JunosAskPass -Password $Auth.Password

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
    # These four are appended last, after the ARP table the client-IP correlation
    # depends on: if a slow switch trips the hard timeout below, it truncates only
    # this optional data instead of corrupting client IPs. Config backup is last of the
    # four specifically because it's the largest output of anything in this batch (a
    # full device config, potentially thousands of lines on a big stack) - a timeout
    # should cost the config backup before it costs uptime/alarms/RE-health.
    $Process.StandardInput.WriteLine("show system uptime")
    $Process.StandardInput.WriteLine("show chassis alarms")
    $Process.StandardInput.WriteLine("show chassis routing-engine")
    $Process.StandardInput.WriteLine("show configuration | display set")
    $Process.StandardInput.WriteLine("quit")
    $Process.StandardInput.Close()

    $Process.WaitForExit(50000) | Out-Null
    if (-not $Process.HasExited) { $Process.Kill(); Write-LogMsg "TIMEOUT on interactive batch." }
    
    $Output = if (Test-Path $TempOut) { Get-Content $TempOut -Raw } else { "" }
    $Error  = if (Test-Path $TempErr) { Get-Content $TempErr -Raw } else { "" }
    
    if (Test-Path $TempOut) { Remove-Item $TempOut -Force -ErrorAction SilentlyContinue }
    if (Test-Path $TempErr) { Remove-Item $TempErr -Force -ErrorAction SilentlyContinue }
    
    return @{ Output = $Output; Error = $Error }
}

$NodeData = @{
    DeviceIP = $TargetIP; Hostname = "Unknown"; JunosVersion = "Unknown"; Gateway = "Unknown";
    StackMembers = @(); Neighbors = @(); Clients = @(); ArpEntries = @(); Interfaces = @{};
    Uptime = "Unknown"; LastConfigured = "Unknown"; LastConfiguredBy = "Unknown"; Alarms = @();
    # These reflect only the RE that answered the CLI session (the master on a VC),
    # not an aggregate across all members - named accordingly, not "Cpu"/"Memory".
    MasterCpuUtilization = "Unknown"; MasterMemoryUtilization = "Unknown";
    # LLDP-MED endpoints (phones, APs) - kept separate from Neighbors, which is the
    # switch-to-switch topology graph and was never meant to include them. See the LLDP
    # parsing loop below for why these are captured instead of discarded outright.
    MedNeighbors = @()
    # Full "show configuration | display set" text - folded into the same interactive
    # batch as everything else above (one SSH connection, not two) but deliberately
    # redacted out of the -Log RawDumps file below - see that block for why.
    Configuration = "Unknown"
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

        # Config backup content - SNMP communities, RADIUS/TACACS+ shared secrets, local
        # user secrets - is far more sensitive than anything else this tool captures, and
        # isn't parsed at all (just stored verbatim), so RawDumps gets none of the
        # debugging benefit it exists for and all of the risk. Redact it before writing:
        # keep the command echo line (so it's visible the command ran) and replace
        # everything after it, to the end of the captured output, with a placeholder.
        # "show configuration | display set" is written last in Invoke-InteractiveBatch
        # specifically so this "to the end" replacement is safe - nothing else follows it.
        $RedactedOutput = $RawOutput -replace '(?ms)(^.*>\s*show\s+configuration\s*\|\s*display\s+set[^\r\n]*[\r\n]+).*\z', '$1[CONFIGURATION REDACTED - not written to RawDumps by design; see the Configuration field in NetworkMap output]'
        $RedactedOutput | Out-File $RawLogPath -Force
        Write-LogMsg "Raw payload saved to $RawLogPath (configuration output redacted)"
    }

    if ([string]::IsNullOrWhiteSpace($RawOutput)) {
        if ($HumanReadable) { Write-Host "  [!] CRITICAL ERROR: Switch returned empty payload." -ForegroundColor Red }
        Write-LogMsg "CRITICAL: Switch returned empty payload."
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
        # Unlike every section above, nothing with "show " follows this one - "quit" does -
        # so the -split boundary above can't bound it and a greedy (?s).* would swallow the
        # trailing "user@switch> quit" echo (and any "Connection closed" text after it) into
        # the config itself. Stop non-greedily at the next CLI prompt line instead.
        elseif ($Sec -match '^(?i)configuration\s*\|\s*display\s+set\b[^\r\n]*[\r\n]+(?<content>(?s).*?)(?:[\r\n]+\S+@\S+[>#]\s|\z)') { $DataDict["CONFIG"] = $Matches.content }
    }

    # --- Parse Identity ---
    if ($DataDict["VERSION"] -match "(?i)Hostname:\s*(?<host>\S+)") { $NodeData.Hostname = $Matches.host }
    if ($DataDict["VERSION"] -match "(?i)Junos:\s*(?<ver>\S+)") { $NodeData.JunosVersion = $Matches.ver }

    # --- Parse Config Backup (stored verbatim, no further parsing - see the redaction
    # comment above for why this never reaches RawDumps) ---
    if (-not [string]::IsNullOrWhiteSpace($DataDict["CONFIG"])) { $NodeData.Configuration = $DataDict["CONFIG"].Trim() }
    
    # --- Parse Stack/Hardware ---
    $ParsedStack = $false
    if ($DataDict["VIRTUAL_CHASSIS"] -match "Member ID") {
        foreach ($Line in ($DataDict["VIRTUAL_CHASSIS"] -split "`n")) {
            $Line = $Line.Trim()
            if ($Line -match "^(?<id>\d+)\s+") {
                $role = "Unknown"
                if ($Line -match "(Master|Backup|Linecard)") { $role = $Matches[1] }
                
                $serial = "Unknown"
                if ($Line -match "\b([A-Z0-9]{10,})\b") { $serial = $Matches[1] }
                
                $model = "Unknown"
                if ($Line -match "\b(ex\d{4}[^\s]*)\b") { $model = $Matches[1] }
                
                if ($serial -ne "Unknown") {
                    $NodeData.StackMembers += [PSCustomObject]@{ FPC = $Matches.id; Model = $model; Serial = $serial; Role = $role }
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

    # --- Parse Routing Engine Health (first RE block reported - the master on a VC) ---
    if ($DataDict["ROUTING_ENGINE"] -match "(?i)Idle\s+(?<idle>\d+)\s+percent") {
        $NodeData.MasterCpuUtilization = "$(100 - [int]$Matches.idle)%"
    }
    if ($DataDict["ROUTING_ENGINE"] -match "(?i)Memory utilization\s+(?<mem>\d+)\s+percent") {
        $NodeData.MasterMemoryUtilization = "$($Matches.mem)%"
    }

    # --- Parse Interfaces ---
    foreach ($Line in ($DataDict["INTERFACES_TERSE"] -split "`n")) {
        $Line = $Line.Trim()
        if ($Line -match "^(?<port>(?:ge|xe|et|ae|mge)[^\s]+)\s+(?<admin>up|down)\s+(?<link>up|down)") {
            $p = $Matches.port
            if (-not $NodeData.Interfaces.ContainsKey($p)) {
                $NodeData.Interfaces[$p] = @{ Port = $p; Admin = $Matches.admin; Link = $Matches.link; Desc = "Unknown"; STP = "Unknown"; PoE = "Unknown" }
            }
        }
    }

    foreach ($Line in ($DataDict["INTERFACES_DESC"] -split "`n")) {
        $Line = $Line.Trim()
        if ($Line -match "^(?<port>(?:ge|xe|et|ae|mge)[^\s]+)\s+(?:up|down)\s+(?:up|down)\s+(?<desc>.+)$") { 
            $p = $Matches.port
            if ($NodeData.Interfaces.ContainsKey($p)) { $NodeData.Interfaces[$p].Desc = $Matches.desc.Trim() }
        }
    }

    foreach ($Line in ($DataDict["STP"] -split "`n")) {
        $Line = $Line.Trim()
        if ($Line -match "^(?<port>(?:ge|xe|et|ae|mge)[^\s]+)\s+.*?(?<state>FWD|BLK|DIS|LRN|LST)") {
            $p = $Matches.port -replace "\.0$","" 
            if ($NodeData.Interfaces.ContainsKey($p)) { $NodeData.Interfaces[$p].STP = $Matches.state }
        }
    }

    foreach ($Line in ($DataDict["POE"] -split "`n")) {
        $Line = $Line.Trim()
        if ($Line -match "^(?<port>(?:ge|xe|et|ae|mge)[^\s]+)\s+(?<status>Enabled|Disabled)\s+(?<oper>\S+)\s+\S+\s+(?<class>\S+)\s+(?<power>\d+\.\d+W)") {
            $p = $Matches.port
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
    $Blocks = $DataDict["LLDP"] -split "(?i)(?=Local Interface\s*:)"
    foreach ($Block in $Blocks) {
        $IsMedEndpoint = ($Block -match "Class III Device") -or ($Block -match "Bridge Telephone") -or ($Block -match "WLAN Access Point") -or ($Block -match "ArubaOS")

        $Neigh = @{ LocalPort = "Unknown"; RemotePort = "Unknown"; Hostname = "Unknown"; MacAddress = "Unknown"; ManagementIP = "Unknown"; Description = "Unknown" }
        if ($Block -match "(?i)Local Interface\s*:\s*(?<port>[^\r\n]+)") { $Neigh.LocalPort = $Matches.port.Trim() }
        if ($Block -match "(?i)Port ID\s*:\s*(?<rport>[^\r\n]+)") { $Neigh.RemotePort = $Matches.rport.Trim() }
        if ($Block -match "(?i)System Name\s*:\s*(?<name>[^\r\n]+)") { $Neigh.Hostname = $Matches.name.Trim() }
        if ($Block -match "(?i)Chassis ID\s*:\s*(?<mac>[^\r\n]+)") { $Neigh.MacAddress = $Matches.mac.Trim() }
        if ($Block -match "(?i)(?:Management Address|Address)\s*:\s*(?<ip>\b(?:\d{1,3}\.){3}\d{1,3}\b)") { $Neigh.ManagementIP = $Matches.ip.Trim() }
        if ($Block -match "(?i)System Description\s*:\s*(?<desc>[^\r\n]+)") { $Neigh.Description = $Matches.desc.Trim() }

        if ($IsMedEndpoint) {
            # Phones/APs identifying via LLDP-MED rarely advertise a management address the
            # way a switch does, so - unlike $NodeData.Neighbors below - capture is gated
            # only on having parsed a local port: that's the field the visualizer's
            # daisy-chain detection correlates against the MAC-table client list on.
            if ($Neigh.LocalPort -ne "Unknown") {
                $NodeData.MedNeighbors += [PSCustomObject]$Neigh
            }
        } elseif ($Neigh.ManagementIP -ne "Unknown" -and $Neigh.ManagementIP -ne $TargetIP -and $Neigh.ManagementIP -ne "0.0.0.0") {
            $NodeData.Neighbors += [PSCustomObject]$Neigh
        }
    }

    # --- Parse VLANs ---
    $VlanDict = @{}
    foreach ($Line in ($DataDict["VLANS"] -split "`n")) {
        # "Name  Tag  Interfaces" - the trailing interface (if any) is never purely numeric,
        # so anchoring the match on name+tag only (not a 3rd numeric field) is what actually
        # matches real "show vlans" output.
        if ($Line -match "^(?<name>\S+)\s+(?<tag>\d+)") { $VlanDict[$Matches.name] = $Matches.tag }
    }

    # --- Parse MAC Table ---
    $RawMacs = @{} 
    foreach ($Line in ($DataDict["MAC_TABLE"] -split "`n")) {
        if ($Line -match "(?<vlan>\S+)\s+(?<mac>(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})\s+(?<flag>[SDLPCNO])\s+.+?(?<interface>(?:ge|xe|et|ae|vcp|bme|reth|me|vme)[a-zA-Z0-9\-\/\.]+)") {
            $VlanName = $Matches.vlan
            $RawMacs[$Matches.mac.ToLower()] = @{ 
                Port = $Matches.interface; VLAN_Name = $VlanName; 
                VLAN_Tag = if ($VlanDict.ContainsKey($VlanName)) { $VlanDict[$VlanName] } else { "Unknown" }; 
                Type = if ($Matches.flag -eq "D") { "Dynamic" } else { "Static/Other" } 
            }
        }
    }

    # --- Parse local ARP Table (used to enrich this node's own clients; also exported
    # raw so the orchestrator can build a network-wide MAC->IP map. On L2-only access
    # switches, ARP for downstream hosts usually lives on the L3 gateway instead, not
    # here - that's what the orchestrator-side global enrichment pass is for.) ---
    $ArpDict = @{}
    foreach ($Line in ($DataDict["ARP_TABLE"] -split "`n")) {
        if ($Line -match "(?<mac>(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})\s+(?<ip>\b(?:\d{1,3}\.){3}\d{1,3}\b)") {
            $macLower = $Matches.mac.ToLower()
            $ArpDict[$macLower] = $Matches.ip
            $NodeData.ArpEntries += [PSCustomObject]@{ MAC = $macLower; IP = $Matches.ip }
        }
    }

    # --- Build Clients from the MAC table (primary source - this is what a switch
    # actually knows about its own connected devices). IP comes from local ARP when
    # available; otherwise "Unknown" until the orchestrator's global enrichment pass. ---
    foreach ($MacKey in $RawMacs.Keys) {
        $Entry = $RawMacs[$MacKey]
        $Client = @{
            IP = if ($ArpDict.ContainsKey($MacKey)) { $ArpDict[$MacKey] } else { "Unknown" }
            MAC = $MacKey; Port = $Entry.Port; PortDesc = "Unknown"
            VLAN_Name = $Entry.VLAN_Name; VLAN_Tag = $Entry.VLAN_Tag; Type = $Entry.Type
            Dot1x_User = "Unknown"; Dot1x_State = "Unknown"
        }

        $physPort = $Client.Port -replace "\.\d+$",""
        if ($NodeData.Interfaces.ContainsKey($physPort)) { $Client.PortDesc = $NodeData.Interfaces[$physPort].Desc }
        if ($Dot1xDict.ContainsKey($MacKey)) {
            $Client.Dot1x_User = $Dot1xDict[$MacKey].User; $Client.Dot1x_State = $Dot1xDict[$MacKey].State
        }
        $NodeData.Clients += [PSCustomObject]$Client
    }

} catch { 
    Write-LogMsg "CRITICAL EXCEPTION: $_"
    if ($HumanReadable) { Write-Host "`n[!] SCRIPT EXCEPTION: $_" -ForegroundColor Red }
}

$InterfaceArray = @()
foreach ($Key in $NodeData.Interfaces.Keys) { $InterfaceArray += [PSCustomObject]$NodeData.Interfaces[$Key] }
$NodeData.Interfaces = $InterfaceArray | Sort-Object Port

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

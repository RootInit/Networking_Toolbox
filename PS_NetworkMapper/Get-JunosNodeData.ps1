[CmdletBinding()]
param (
    [Parameter(Mandatory=$true)]
    [string]$TargetIP,
    
    [string]$AuthFile = ".\Auth.json",
    
    [switch]$HumanReadable,
    
    # NEW: Only write raw payload text files if this flag is present
    [switch]$Log 
)

if (-not (Test-Path $AuthFile)) { throw "Auth file missing at $AuthFile! Copy Auth.example.json to Auth.json and fill in real credentials." }
$AuthData = Get-Content $AuthFile -Raw | ConvertFrom-Json
$Username = $AuthData.Username
$Password = $AuthData.Password

$AskPassPath = Join-Path $env:TEMP "ssh_askpass_$($PID)_$([guid]::NewGuid().Guid.Substring(0,8)).bat"
$AskPassText = Join-Path $env:TEMP "ssh_pass_$($PID)_$([guid]::NewGuid().Guid.Substring(0,8)).txt"
[System.IO.File]::WriteAllText($AskPassText, $Password)
[System.IO.File]::WriteAllText($AskPassPath, "@type `"$AskPassText`"")

# Everything below runs inside a try/finally so the plaintext askpass files
# (containing the real switch password) are always removed, even on error or exit.
try {

$Logs = [System.Collections.Generic.List[string]]::new()
function Write-LogMsg { param([string]$msg) $Logs.Add("[$TargetIP] $msg") }

function Invoke-InteractiveBatch {
    $TempOut = Join-Path $env:TEMP "ssh_out_$([guid]::NewGuid().Guid.Substring(0,8)).txt"
    $TempErr = Join-Path $env:TEMP "ssh_err_$([guid]::NewGuid().Guid.Substring(0,8)).txt"
    
    $SshArgs = @("-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=NUL", "-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no", "$Username@$TargetIP")
    $ProcInfo = New-Object System.Diagnostics.ProcessStartInfo("cmd.exe", "/c ssh.exe $($SshArgs -join ' ') > `"$TempOut`" 2> `"$TempErr`"")
    $ProcInfo.UseShellExecute = $false; $ProcInfo.CreateNoWindow = $true
    $ProcInfo.RedirectStandardInput = $true
    
    $ProcInfo.EnvironmentVariables["DISPLAY"] = "dummy:0"
    $ProcInfo.EnvironmentVariables["SSH_ASKPASS"] = $AskPassPath
    $ProcInfo.EnvironmentVariables["SSH_ASKPASS_REQUIRE"] = "force"
    
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
    $Process.StandardInput.WriteLine("quit")
    $Process.StandardInput.Close()

    $Process.WaitForExit(30000) | Out-Null
    if (-not $Process.HasExited) { $Process.Kill(); Write-LogMsg "TIMEOUT on interactive batch." }
    
    $Output = if (Test-Path $TempOut) { Get-Content $TempOut -Raw } else { "" }
    $Error  = if (Test-Path $TempErr) { Get-Content $TempErr -Raw } else { "" }
    
    if (Test-Path $TempOut) { Remove-Item $TempOut -Force -ErrorAction SilentlyContinue }
    if (Test-Path $TempErr) { Remove-Item $TempErr -Force -ErrorAction SilentlyContinue }
    
    return @{ Output = $Output; Error = $Error }
}

$NodeData = @{
    DeviceIP = $TargetIP; Hostname = "Unknown"; JunosVersion = "Unknown"; Gateway = "Unknown";
    StackMembers = @(); Neighbors = @(); Clients = @(); ArpEntries = @(); Interfaces = @{}
}

try {
    if ($HumanReadable) { Write-Host "`nGathering node data for $TargetIP..." -ForegroundColor Cyan }

    $Result = Invoke-InteractiveBatch
    $RawOutput = $Result.Output

    # --- CONDITIONAL RAW LOG DUMP ---
    if ($Log -and -not [string]::IsNullOrWhiteSpace($RawOutput)) {
        $DumpDir = Join-Path $PWD "RawDumps"
        if (-not (Test-Path $DumpDir)) { New-Item -ItemType Directory -Path $DumpDir -Force | Out-Null }
        $RawLogPath = Join-Path $DumpDir "Raw_$TargetIP.txt"
        $RawOutput | Out-File $RawLogPath -Force
        Write-LogMsg "Raw payload saved to $RawLogPath"
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
    }

    # --- Parse Identity ---
    if ($DataDict["VERSION"] -match "(?i)Hostname:\s*(?<host>\S+)") { $NodeData.Hostname = $Matches.host }
    if ($DataDict["VERSION"] -match "(?i)Junos:\s*(?<ver>\S+)") { $NodeData.JunosVersion = $Matches.ver }
    
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

    # --- Parse LLDP Neighbors ---
    $Blocks = $DataDict["LLDP"] -split "(?i)(?=Local Interface\s*:)"
    foreach ($Block in $Blocks) {
        if ($Block -match "Class III Device" -or $Block -match "Bridge Telephone" -or $Block -match "WLAN Access Point" -or $Block -match "ArubaOS") { continue }
        $Neigh = @{ LocalPort = "Unknown"; RemotePort = "Unknown"; Hostname = "Unknown"; MacAddress = "Unknown"; ManagementIP = "Unknown"; Description = "Unknown" }
        if ($Block -match "(?i)Local Interface\s*:\s*(?<port>[^\r\n]+)") { $Neigh.LocalPort = $Matches.port.Trim() }
        if ($Block -match "(?i)Port ID\s*:\s*(?<rport>[^\r\n]+)") { $Neigh.RemotePort = $Matches.rport.Trim() }
        if ($Block -match "(?i)System Name\s*:\s*(?<name>[^\r\n]+)") { $Neigh.Hostname = $Matches.name.Trim() }
        if ($Block -match "(?i)Chassis ID\s*:\s*(?<mac>[^\r\n]+)") { $Neigh.MacAddress = $Matches.mac.Trim() }
        if ($Block -match "(?i)(?:Management Address|Address)\s*:\s*(?<ip>\b(?:\d{1,3}\.){3}\d{1,3}\b)") { $Neigh.ManagementIP = $Matches.ip.Trim() }
        if ($Block -match "(?i)System Description\s*:\s*(?<desc>[^\r\n]+)") { $Neigh.Description = $Matches.desc.Trim() }
        
        if ($Neigh.ManagementIP -ne "Unknown" -and $Neigh.ManagementIP -ne $TargetIP -and $Neigh.ManagementIP -ne "0.0.0.0") {
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
    Remove-Item -Path $AskPassPath, $AskPassText -Force -ErrorAction SilentlyContinue
}

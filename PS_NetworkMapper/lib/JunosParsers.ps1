# Pure text->object parsers for Junos operational output, split out of Get-JunosNodeData.ps1 so they
# can be exercised against canned output: the worker itself only ever produces text through a live
# ssh.exe session, which no test can stand up.
#
# Every function here takes the raw section text (already stripped of its echoed command line by the
# worker's section splitter) and returns plain objects. None of them touch $NodeData, log, or throw
# on malformed input - an unrecognized line is skipped, because a single odd line from one Junos
# release must not cost the whole section.

# Physical interface names the switch data plane uses. vcp/bme/me/vme/reth are management or
# virtual-chassis and appear in some sections but not others; irb/vlan are L3 interfaces.
$Script:JunosPhysPortPattern = '(?:ge|xe|et|ae|mge)[\w\-/:.]*'
$Script:JunosAnyPortPattern  = '(?:ge|xe|et|ae|mge|vcp|bme|reth|me|vme|irb|vlan|fxp|em|lo)[\w\-/:.]*'

function ConvertTo-JunosPhysicalPort {
    param([string]$Port)
    # "ge-0/0/1.100" and "ge-0/0/1.0" are logical units of one physical port; the rest of the worker
    # keys interfaces by the physical name.
    return ($Port -replace '\.\d+$', '')
}

function ConvertFrom-JunosVlanTable {
    <#
    .SYNOPSIS
    Parses "show vlans" into one object per VLAN, including interface membership.

    .DESCRIPTION
    Two layouts exist. With routing instances configured the columns are
    "Routing instance / VLAN name / Tag / Interfaces"; without them they are "Name / Tag / Interfaces".
    Member interfaces reach us in three shapes across releases: one per indented continuation line;
    comma-separated and wrapped across several continuation lines (non-ELS EX); and space-separated
    on the VLAN row itself. All three are handled. A trailing "*" marks an interface that is
    currently forwarding for that VLAN, and a VLAN with no tag prints the literal "None".
    #>
    param([string]$Text)

    $Vlans = @()
    if ([string]::IsNullOrWhiteSpace($Text)) { return $Vlans }

    $HasRoutingInstanceColumn = $Text -match '(?im)^\s*Routing instance\s'
    $LastInstance = $null
    $Current = $null

    # An indented line of nothing but interface names - one, or a comma-separated run that wrapped.
    # (?-i) matters: interface names are lowercase, and case-insensitively a VLAN named LOBBY, GENERAL
    # or EMERGENCY matches the lo/ge/em prefixes and its row would be eaten as a member list.
    $MemberOnlyLine = "(?-i)^\s+(?:$Script:JunosAnyPortPattern\*?\s*,?\s*)+$"

    function Add-Members {
        param($Vlan, [string]$Fragment)
        if (-not $Vlan -or [string]::IsNullOrWhiteSpace($Fragment)) { return }
        foreach ($M in [regex]::Matches($Fragment, "(?<if>$Script:JunosAnyPortPattern)(?<active>\*)?")) {
            $Name = $M.Groups['if'].Value
            $Vlan.Interfaces += [PSCustomObject]@{
                Port   = (ConvertTo-JunosPhysicalPort -Port $Name)
                Unit   = $Name
                Active = $M.Groups['active'].Success
            }
        }
    }

    foreach ($RawLine in ($Text -split "`n")) {
        $Line = $RawLine -replace "`r", ""
        if ([string]::IsNullOrWhiteSpace($Line)) { continue }
        # Column headers and the trailing shell prompt.
        if ($Line -match '(?i)^\s*(Routing instance\s+VLAN name|Name\s+Tag|VLAN name\s+Tag)') { continue }
        if ($Line -match '^\S+@\S+[>#]') { continue }

        # Guarded on a VLAN already being open: the first data row of the table cannot be a member list.
        if ($Current -and $Line -match $MemberOnlyLine) {
            Add-Members -Vlan $Current -Fragment $Line
            continue
        }

        $Inst = $null; $Name = $null; $Tag = $null; $Rest = ''
        if ($HasRoutingInstanceColumn -and $Line -match '^(?<inst>\S+)\s+(?<name>\S+)\s+(?<tag>\d+|None)\s*(?<rest>.*)$') {
            $Inst = $Matches.inst; $Name = $Matches.name; $Tag = $Matches.tag; $Rest = $Matches.rest
            $LastInstance = $Inst
        } elseif ($HasRoutingInstanceColumn -and $LastInstance -and $Line -match '^\s+(?<name>\S+)\s+(?<tag>\d+|None)\s*(?<rest>.*)$') {
            # Junos prints the instance once and leaves it blank on the instance's remaining VLANs.
            $Inst = $LastInstance; $Name = $Matches.name; $Tag = $Matches.tag; $Rest = $Matches.rest
        } elseif (-not $HasRoutingInstanceColumn -and $Line -match '^\s*(?<name>\S+)\s+(?<tag>\d+|None)\s*(?<rest>.*)$') {
            $Name = $Matches.name; $Tag = $Matches.tag; $Rest = $Matches.rest
        } elseif (-not $HasRoutingInstanceColumn -and $Line -match '^\s*(?<name>[A-Za-z][\w\-]*)\s*$') {
            # Some releases print an untagged VLAN as a bare name with the Tag column left empty.
            $Name = $Matches.name
        } else {
            continue
        }

        $Current = [PSCustomObject]@{
            RoutingInstance = $Inst
            Name            = $Name
            # "None" is the switch saying this VLAN has no 802.1Q tag, not a tag whose value is zero.
            Tag             = if ($Tag -and $Tag -ne 'None') { [int]$Tag } else { $null }
            Interfaces      = @()
        }
        $Vlans += $Current
        Add-Members -Vlan $Current -Fragment $Rest
    }

    return $Vlans
}

function ConvertFrom-JunosStpInterface {
    <#
    .SYNOPSIS
    Parses "show spanning-tree interface" into per-port, per-scope state.

    .DESCRIPTION
    Returns a hashtable keyed by physical port, each value an array of records carrying the scope the
    switch reported them under. The scope string differs by protocol - VSTP prints "VLAN 110", RSTP
    "instance 0", MSTP "MSTI 1" - so it is kept verbatim rather than parsed into a VLAN id, and an
    output with no scope header at all lands under "default".
    #>
    param([string]$Text)

    $ByPort = @{}
    if ([string]::IsNullOrWhiteSpace($Text)) { return $ByPort }

    $Scope = 'default'
    foreach ($RawLine in ($Text -split "`n")) {
        $Line = ($RawLine -replace "`r", "").TrimEnd()
        if ($Line -match '(?i)^\s*Spanning tree interface parameters for\s+(?<scope>.+?)\s*$') {
            $Scope = $Matches.scope
            continue
        }
        if ($Line -match '(?i)^\s*Interface\s+Port\s*ID') { continue }

        $Record = $null
        if ($Line -match "^\s*(?<port>$Script:JunosPhysPortPattern)\s+(?<pid>\d+:\d+)\s+(?<dpid>\d+:\d+)\s+(?<dbridge>\S+)\s+(?<cost>\d+)\s+(?<state>FWD|BLK|DIS|LRN|LST)(?:\s+(?<role>\S+))?\s*$") {
            $Record = [PSCustomObject]@{
                Scope            = $Scope
                Port             = (ConvertTo-JunosPhysicalPort -Port $Matches.port)
                PortId           = $Matches.pid
                DesignatedPortId = $Matches.dpid
                DesignatedBridge = $Matches.dbridge
                Cost             = [int]$Matches.cost
                State            = $Matches.state
                Role             = if ($Matches.role) { $Matches.role } else { $null }
            }
        } elseif ($Line -match "^\s*(?<port>$Script:JunosPhysPortPattern)\s+.*?\s(?<state>FWD|BLK|DIS|LRN|LST)(?:\s+(?<role>\S+))?\s*$") {
            # Releases that drop or reorder the middle columns still carry the state, which is the one
            # field the rest of the worker depends on.
            $Record = [PSCustomObject]@{
                Scope            = $Scope
                Port             = (ConvertTo-JunosPhysicalPort -Port $Matches.port)
                PortId           = $null
                DesignatedPortId = $null
                DesignatedBridge = $null
                Cost             = $null
                State            = $Matches.state
                Role             = if ($Matches.role) { $Matches.role } else { $null }
            }
        }
        if ($null -eq $Record) { continue }

        if (-not $ByPort.ContainsKey($Record.Port)) { $ByPort[$Record.Port] = @() }
        $ByPort[$Record.Port] += $Record
    }

    return $ByPort
}

function ConvertFrom-JunosAeMembership {
    <#
    .SYNOPSIS
    Parses "show interfaces terse" into a physical-port -> "aeN" LACP bundle map.
    #>
    param([string]$Text)

    $Map = @{}
    if ([string]::IsNullOrWhiteSpace($Text)) { return $Map }
    foreach ($RawLine in ($Text -split "`n")) {
        $Line = ($RawLine -replace "`r", "").Trim()
        if ($Line -match '^(?<phys>(?:ge|xe|et|mge)\S+)\.\d+\s+(?:up|down)\s+(?:up|down)\s+aenet\s+-->\s+(?<ae>ae\d+)\.') {
            $Map[$Matches.phys] = $Matches.ae
        }
    }
    return $Map
}

function ConvertFrom-JunosErrorCounters {
    <#
    .SYNOPSIS
    Reads the "Input errors:" / "Output errors:" stanza of one "show interfaces extensive" block.

    .DESCRIPTION
    The stanza is one or more indented lines of comma-separated "Label: N" pairs. The field SET
    differs by interface type - a virtual-chassis port reports Giants where an access port reports
    Collisions - so counters are keyed by label and never by position.

    Termination is by line SHAPE, not by indentation: the sections that follow ("Egress queues",
    "Queue counters", LACP and MACsec tables) are indented at least as deeply, so a
    "keep consuming indented lines" rule swallows them and invents counters out of table columns.
    #>
    param([string]$Block, [ValidateSet('Input', 'Output')][string]$Direction)

    $Counters = @{}
    if ([string]::IsNullOrWhiteSpace($Block)) { return $Counters }

    # Every segment on a counter line is "<label>: <number>"; anything else ends the stanza.
    $CounterLine = '^\s{2,}[A-Za-z][A-Za-z0-9 \-/\.]*:\s*\d+(?:\s*,\s*[A-Za-z][A-Za-z0-9 \-/\.]*:\s*\d+)*\s*$'
    $InStanza = $false
    foreach ($RawLine in ($Block -split "`n")) {
        $Line = $RawLine -replace "`r", ""
        if ($Line -match "(?i)^\s*$Direction errors:\s*$") { $InStanza = $true; continue }
        if (-not $InStanza) { continue }
        if ($Line -notmatch $CounterLine) { break }
        foreach ($M in [regex]::Matches($Line, '(?<label>[A-Za-z][A-Za-z0-9 \-/\.]*?)\s*:\s*(?<value>\d+)')) {
            $Counters[$M.Groups['label'].Value.Trim()] = [int64]$M.Groups['value'].Value
        }
    }
    return $Counters
}

function ConvertFrom-JunosInterfaceExtensive {
    <#
    .SYNOPSIS
    Parses "show interfaces extensive" into a hashtable keyed by physical port.

    .DESCRIPTION
    The field line after "Link-level type:" varies by interface type: an access port carries
    Link-mode/Speed/Auto-negotiation/Media type, a virtual-chassis port carries Type/Clocking and puts
    duplex on a separate "Link type" line. Both the configured speed ("Speed: Auto") and the
    negotiated one ("Link partner Speed: 1000 Mbps") are kept, since a duplex or speed mismatch is
    only visible as a disagreement between them.
    #>
    param([string]$Text)

    $ByPort = @{}
    if ([string]::IsNullOrWhiteSpace($Text)) { return $ByPort }

    foreach ($Block in ($Text -split '(?=Physical interface:)')) {
        if ($Block -notmatch "^Physical interface:\s*(?<port>$Script:JunosPhysPortPattern)\s*,\s*(?<admin>Enabled|Disabled)\s*,\s*Physical link is\s*(?<link>\S+)") { continue }
        $Detail = [ordered]@{
            Port               = (ConvertTo-JunosPhysicalPort -Port $Matches.port)
            AdminStatus        = $Matches.admin
            LinkStatus         = $Matches.link
            Description        = $null
            LinkLevelType      = $null
            Mtu                = $null
            SpeedConfigured    = $null
            SpeedNegotiated    = $null
            Duplex             = $null
            DuplexNegotiated   = $null
            AutoNegotiation    = $null
            NegotiationStatus  = $null
            MediaType          = $null
            MacAddress         = $null
            CarrierTransitions = $null
            InputBytes         = $null
            OutputBytes        = $null
            InputBps           = $null
            OutputBps          = $null
            InputErrors        = @{}
            OutputErrors       = @{}
            ActiveAlarms       = $null
            ActiveDefects      = $null
        }

        if ($Block -match '(?im)^\s*Description:\s*(?<v>.+?)\s*$')          { $Detail.Description = $Matches.v }
        if ($Block -match '(?i)Link-level type:\s*(?<v>[^,\r\n]+)')         { $Detail.LinkLevelType = $Matches.v.Trim() }
        if ($Block -match '(?i)\bMTU:\s*(?<v>\d+)')                         { $Detail.Mtu = [int]$Matches.v }
        # Anchored to a field boundary so "Link partner Speed:" in the autonegotiation stanza cannot
        # supply the configured speed on a block whose own field line omits it.
        if ($Block -match '(?im)(?:^|,)\s*Speed:\s*(?<v>[^,\r\n]+)')        { $Detail.SpeedConfigured = $Matches.v.Trim() }
        if ($Block -match '(?i)Link-mode:\s*(?<v>[^,\r\n]+)')               { $Detail.Duplex = $Matches.v.Trim() }
        elseif ($Block -match '(?im)^\s*Link type\s*:\s*(?<v>[^,\r\n]+)')   { $Detail.Duplex = $Matches.v.Trim() }
        if ($Block -match '(?i)Auto-negotiation:\s*(?<v>[^,\r\n]+)')        { $Detail.AutoNegotiation = $Matches.v.Trim() }
        if ($Block -match '(?i)Media type:\s*(?<v>[^,\r\n]+)')              { $Detail.MediaType = $Matches.v.Trim() }
        if ($Block -match '(?i)Current address:\s*(?<v>(?:[0-9a-f]{2}:){5}[0-9a-f]{2})') { $Detail.MacAddress = $Matches.v.ToLower() }
        elseif ($Block -match '(?i)Hardware address:\s*(?<v>(?:[0-9a-f]{2}:){5}[0-9a-f]{2})') { $Detail.MacAddress = $Matches.v.ToLower() }
        if ($Block -match '(?i)Negotiation status:\s*(?<v>\S+)')            { $Detail.NegotiationStatus = $Matches.v }

        # Scoped to the "Link partner:" stanza: "Local resolution:" below it repeats both labels with
        # this end's values, which is exactly the comparison a mismatch check needs kept apart.
        if ($Block -match '(?is)Link partner:(?<lp>.*?)(?:Local resolution:|Packet Forwarding Engine|\z)') {
            $Partner = $Matches.lp
            if ($Partner -match '(?i)Link partner Speed:\s*(?<v>[^,\r\n]+)') { $Detail.SpeedNegotiated = $Matches.v.Trim() }
            if ($Partner -match '(?i)Link mode:\s*(?<v>[^,\r\n]+)')          { $Detail.DuplexNegotiated = $Matches.v.Trim() }
        }

        # Bounded to the physical counters: "IPv6 transit statistics" repeats the same four labels.
        if ($Block -match '(?is)Traffic statistics:(?<t>.*?)(?:IPv6 transit statistics:|Input errors:|\z)') {
            $Traffic = $Matches.t
            if ($Traffic -match '(?i)Input\s+bytes\s*:\s*(?<b>\d+)(?:\s+(?<r>\d+)\s*bps)?')  { $Detail.InputBytes = [int64]$Matches.b; if ($Matches.r) { $Detail.InputBps = [int64]$Matches.r } }
            if ($Traffic -match '(?i)Output\s+bytes\s*:\s*(?<b>\d+)(?:\s+(?<r>\d+)\s*bps)?') { $Detail.OutputBytes = [int64]$Matches.b; if ($Matches.r) { $Detail.OutputBps = [int64]$Matches.r } }
        }

        $Detail.InputErrors = ConvertFrom-JunosErrorCounters -Block $Block -Direction 'Input'
        $Detail.OutputErrors = ConvertFrom-JunosErrorCounters -Block $Block -Direction 'Output'
        # Junos files carrier transitions under Output errors on most platforms and on its own line on
        # others, so it is promoted to a field rather than left for callers to hunt for.
        if ($Detail.OutputErrors.ContainsKey('Carrier transitions')) { $Detail.CarrierTransitions = $Detail.OutputErrors['Carrier transitions'] }
        elseif ($Block -match '(?i)Carrier transitions:\s*(?<v>\d+)')  { $Detail.CarrierTransitions = [int64]$Matches.v }

        if ($Block -match '(?im)^\s*Active alarms\s*:\s*(?<v>.+?)\s*$')  { $Detail.ActiveAlarms = $Matches.v }
        if ($Block -match '(?im)^\s*Active defects\s*:\s*(?<v>.+?)\s*$') { $Detail.ActiveDefects = $Matches.v }

        $ByPort[$Detail.Port] = $Detail
    }

    return $ByPort
}

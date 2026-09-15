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

    # "show vlans extensive" is not a table at all - it is one stanza per VLAN, in two shapes. Detected
    # here rather than by the caller, so the section key, the returned shape and every consumer stay the
    # same whichever command produced the text.
    if ($Text -match '(?im)^\s*(?:VLAN Name\s*:|VLAN:\s*\S)') {
        return (ConvertFrom-JunosVlanExtensive -Text $Text)
    }

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
                # The table form does not print either; $null is "not measured", not "untagged".
                Tagged = $null
                Mode   = $null
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
            # R14. The L2 switching instance ("default-switch" on a single-instance box), NOT an L3
            # VRF. Two VLANs in different routing instances can carry the same tag and still be
            # separate broadcast domains, but this field says nothing about L3 reachability - do not
            # read it as a VRF name when deciding whether two addresses can reach each other.
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

function ConvertFrom-JunosVlanExtensive {
    <#
    .SYNOPSIS
    Parses "show vlans extensive" (and "show vlans detail") into the same objects the table form yields.

    .DESCRIPTION
    Two stanza layouts, one per platform generation:

      ELS (EX2300/EX3400/EX4300/QFX)          pre-ELS EX
      Routing instance: default-switch        VLAN: COM1, Created at: Tue May 11 18:16:05 2010
      VLAN Name: c1                           802.1Q Tag: 100, Internal index: 3, Admin State: Enabled
      State: Active                           Protocol: Port Mode, Mac aging time: 300 seconds
      Tag: 20                                 Number of interfaces: Tagged 3 (Active = 3), Untagged 1
      MAC aging time: 300 seconds                   ge-0/0/20.0*, tagged, trunk
      Interfaces: ge-0/0/0.0*,tagged,trunk          ge-0/0/7.0*, untagged, access
                 ge-1/0/0.0*,tagged,trunk

    The member lines are the reason for the upgrade: they carry tagged/untagged and the port mode, which
    is the only place a NATIVE VLAN is visible - an untagged member of a tagged VLAN on a trunk port. The
    table form carries neither, so `Tagged` and `Mode` stay $null there rather than being guessed (S9.5:
    a field absent from an older snapshot is unmeasured, never false).

    Layouts seen only in "show vlans detail" ("Untagged interfaces: a, b, c") are read too, so a fleet
    that answers one command with another still yields membership rather than an empty VLAN list.

    Shapes are derived from Juniper's published sample output, NOT from a device this project has seen:
    https://www.juniper.net/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-vlans-bridging-qfx-series.html
    https://www.juniper.net/documentation/en_US/junos12.3/topics/reference/command-summary/show-vlans-bridging-ex-series.html
    #>
    param([string]$Text)

    $Vlans = @()
    if ([string]::IsNullOrWhiteSpace($Text)) { return $Vlans }

    # "ge-0/0/20.0*, tagged, trunk" and the ELS spelling with no spaces. The tagging word is required:
    # without it this is an ordinary member list and the table parser's rules apply.
    $MemberPattern = "(?-i)(?<if>$Script:JunosAnyPortPattern)(?<active>\*)?\s*,\s*(?i)(?<tagging>tagged|untagged)(?:\s*,\s*(?<mode>access|trunk))?"
    $PendingInstance = $null
    $Current = $null

    $AddMembers = {
        param($Vlan, [string]$Fragment, $DefaultTagged)
        if (-not $Vlan -or [string]::IsNullOrWhiteSpace($Fragment)) { return }
        $Matched = $false
        foreach ($M in [regex]::Matches($Fragment, $MemberPattern)) {
            $Matched = $true
            $Name = $M.Groups['if'].Value
            $Vlan.Interfaces += [PSCustomObject]@{
                Port   = (ConvertTo-JunosPhysicalPort -Port $Name)
                Unit   = $Name
                Active = $M.Groups['active'].Success
                # R2/G5. $true means the frame leaves this port with its 802.1Q tag; $false means it
                # leaves untagged, which on a trunk is that trunk's native VLAN.
                Tagged = $M.Groups['tagging'].Value.ToLower() -eq 'tagged'
                Mode   = if ($M.Groups['mode'].Success) { $M.Groups['mode'].Value.ToLower() } else { $null }
            }
        }
        if ($Matched -or $null -eq $DefaultTagged) { return }
        # "show vlans detail" prints the two lists separately and annotates neither member.
        foreach ($M in [regex]::Matches($Fragment, "(?-i)(?<if>$Script:JunosAnyPortPattern)(?<active>\*)?")) {
            $Name = $M.Groups['if'].Value
            $Vlan.Interfaces += [PSCustomObject]@{
                Port   = (ConvertTo-JunosPhysicalPort -Port $Name)
                Unit   = $Name
                Active = $M.Groups['active'].Success
                Tagged = $DefaultTagged
                Mode   = $null
            }
        }
    }

    foreach ($RawLine in ($Text -split "`n")) {
        $Line = ($RawLine -replace "`r", "").TrimEnd()
        if ([string]::IsNullOrWhiteSpace($Line)) { continue }
        if ($Line -match '^\S+@\S+[>#]') { continue }

        if ($Line -match '(?i)^\s*Routing instance\s*:\s*(?<inst>\S+)\s*$') {
            $PendingInstance = $Matches.inst
            continue
        }
        # ELS opens the stanza with the name and prints the tag on its own line further down.
        if ($Line -match '(?i)^\s*VLAN Name\s*:\s*(?<name>\S+)\s*$') {
            $Current = [PSCustomObject]@{
                RoutingInstance = $PendingInstance
                Name            = $Matches.name
                Tag             = $null
                Interfaces      = @()
            }
            $Vlans += $Current
            continue
        }
        # pre-ELS opens with "VLAN: name, Created at: ..." - and "show vlans detail" with
        # "VLAN: name, Tag: 802.1Q Tag 3, Admin state: Enabled", so the tag can be on this line too.
        if ($Line -match '(?i)^\s*VLAN\s*:\s*(?<name>[^,\s]+)\s*(?<rest>,.*)?$') {
            # Both taken before the next -match: $Matches is global and the tag test below replaces it.
            $Name = $Matches.name
            $Rest = if ($Matches.rest) { $Matches.rest } else { '' }
            $Tag = $null
            if ($Rest -match '(?i)(?:802\.1Q\s+)?Tag\s*:?\s*(?:802\.1Q\s+Tag\s+)?(?<tag>\d+)\b') { $Tag = [int]$Matches.tag }
            $Current = [PSCustomObject]@{
                RoutingInstance = $PendingInstance
                Name            = $Name
                Tag             = $Tag
                Interfaces      = @()
            }
            $Vlans += $Current
            continue
        }
        if (-not $Current) { continue }

        # "Tag: 20" (ELS) and "802.1Q Tag: 100, Internal index: 3, ..." (pre-ELS). "Untagged" and "None"
        # are the switch saying this VLAN carries no 802.1Q tag, which is not a tag whose value is zero.
        if ($null -eq $Current.Tag -and $Line -match '(?i)^\s*(?:802\.1Q\s+)?Tag\s*:\s*(?<tag>\d+)\b') {
            $Current.Tag = [int]$Matches.tag
            continue
        }
        if ($Line -match '(?i)^\s*Interfaces\s*:\s*(?<rest>.*)$') {
            & $AddMembers $Current $Matches.rest $null
            continue
        }
        if ($Line -match '(?i)^\s*(?<tagging>Tagged|Untagged) interfaces\s*:\s*(?<rest>.*)$') {
            & $AddMembers $Current $Matches.rest ($Matches.tagging.ToLower() -eq 'tagged')
            continue
        }
        # A continuation line of members, indented under either of the above. Counted lines
        # ("Number of interfaces: Tagged 3 , Untagged 0") carry no interface name and fall through.
        if ($Line -match '^\s') { & $AddMembers $Current $Line $null }
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
            # R10. Counter baselines and the one-way-link / L2-error signals. The four *Error fields
            # print on EVERY port's Link-level line and none was parsed; between them they supply
            # most of the "why is this port blocking" answer section 4.3 was going to spend a whole
            # extra command on.
            StatisticsLastCleared  = $null
            InputPackets           = $null
            OutputPackets          = $null
            RemoteFault            = $null
            InterfaceFlags         = $null
            DeviceFlags            = $null
            BpduError              = $null
            LoopDetectPduError     = $null
            EthernetSwitchingError = $null
            MacRewriteError        = $null
            # R4. The fixed-width statistics tables, which the error-counter parser cannot reach.
            MacStatistics          = [ordered]@{}
            PcsStatistics          = [ordered]@{}
            FecStatistics          = [ordered]@{}
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
            # R10. Packet counts, in the same bounded stanza - "IPv6 transit statistics" repeats these
            # labels with a subset of the traffic, which is why the bound exists.
            if ($Traffic -match '(?i)Input\s+packets\s*:\s*(?<p>\d+)')  { $Detail.InputPackets = [int64]$Matches.p }
            if ($Traffic -match '(?i)Output\s+packets\s*:\s*(?<p>\d+)') { $Detail.OutputPackets = [int64]$Matches.p }
        }

        # R10. Scoped to the Link-level type LINE, not the block: "Remote fault" also appears in the
        # Link partner stanza ("OK") and in Local resolution ("Link OK"), with different meanings, so
        # an unscoped match returns whichever Junos happened to print first. Same trap the configured
        # Speed field already had to dodge.
        $LinkLevelLine = $null
        if ($Block -match '(?im)^[ \t]*Link-level type:.*$') { $LinkLevelLine = $Matches[0] }
        if ($LinkLevelLine) {
            if ($LinkLevelLine -match '(?i)\bRemote fault:\s*(?<v>[^,\r\n]+)')               { $Detail.RemoteFault = $Matches.v.Trim() }
            if ($LinkLevelLine -match '(?i)\bBPDU Error:\s*(?<v>[^,\r\n]+)')                 { $Detail.BpduError = $Matches.v.Trim() }
            if ($LinkLevelLine -match '(?i)\bLoop Detect PDU Error:\s*(?<v>[^,\r\n]+)')      { $Detail.LoopDetectPduError = $Matches.v.Trim() }
            if ($LinkLevelLine -match '(?i)\bEthernet-Switching Error:\s*(?<v>[^,\r\n]+)')   { $Detail.EthernetSwitchingError = $Matches.v.Trim() }
            if ($LinkLevelLine -match '(?i)\bMAC-REWRITE Error:\s*(?<v>[^,\r\n]+)')          { $Detail.MacRewriteError = $Matches.v.Trim() }
        }
        # "Never" is a real value and the common one; it is kept verbatim rather than mapped to $null,
        # which would be indistinguishable from "this platform did not print the line".
        if ($Block -match '(?im)^[ \t]*Statistics last cleared:\s*(?<v>.+?)\s*$') { $Detail.StatisticsLastCleared = $Matches.v }
        # These two carry their own colons in the value ("Internal: 0x4000"), so the value runs to
        # end of line rather than stopping at the next colon.
        if ($Block -match '(?im)^[ \t]*Device flags\s*:\s*(?<v>.+?)\s*$')    { $Detail.DeviceFlags = $Matches.v }
        if ($Block -match '(?im)^[ \t]*Interface flags\s*:\s*(?<v>.+?)\s*$') { $Detail.InterfaceFlags = $Matches.v }

        $Detail.MacStatistics = ConvertFrom-JunosStatisticsTable -Block $Block -Label 'MAC statistics'
        $Detail.PcsStatistics = ConvertFrom-JunosStatisticsTable -Block $Block -Label 'PCS statistics'
        $Detail.FecStatistics = ConvertFrom-JunosStatisticsTable -Block $Block -Label 'Ethernet FEC statistics'

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

# R15. Which command sections actually came back, as a sorted array of the section keys used by
# Get-JunosNodeData.ps1's $DataDict.
#
# A truncated session does not report an error - it simply stops producing output, so the later
# sections are absent from $DataDict entirely. That absence is the only truncation signal that
# survives once the command set is trimmed, and it is what tells "this switch has no LLDP
# neighbours" apart from "the session died before it was asked". A section whose body is blank does
# not count as captured: an echoed command with no output is the shape a cut-off session leaves.
function Get-JunosSectionErrors {
    <#
    .SYNOPSIS
    Section keys whose command was refused by the CLI, mapped to the message it printed.

    .DESCRIPTION
    Section 3.5's second open question, answered without needing to know the exact string a given
    chassis prints. `SectionsCaptured` records a key when its output is non-whitespace, so three
    different things used to look alike: the section arrived, the command was refused (an error IS
    output, so the key was recorded and the parse then found nothing), and the session was cut off
    before the command ran. The caller now records which commands were ATTEMPTED - the echoed prompt
    proves that much - and this says which of them answered with an error instead of data.

    A feature-absent command on a chassis without that feature (PoE on a non-PoE model) lands here, so
    the engine can report "the command was refused" rather than "the capture stopped early" on a switch
    that is simply built differently.
    #>
    param([AllowNull()]$DataDict)

    $Errors = @{}
    if ($null -eq $DataDict) { return $Errors }
    foreach ($Key in $DataDict.Keys) {
        $Body = [string]$DataDict[$Key]
        if ([string]::IsNullOrWhiteSpace($Body)) { continue }
        # Junos prints the offending token under a caret on a syntax error, and a leading "error:" for
        # everything else. Anchored to the first few lines: the word "error" inside a config or an
        # interface counter name is not a refused command.
        $Head = ($Body -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 3) -join "`n"
        # "permission denied" is the message a class-restricted command answers with; it is the one
        # refusal that carries no "error:" prefix of its own (py-junos-eznc's rpc-error fixture).
        if ($Head -match '(?im)^\s*(?<msg>(?:error:|unknown command|syntax error|permission denied)[^\r\n]*)') {
            $Errors[[string]$Key] = $Matches.msg.Trim()
        }
    }
    return $Errors
}

function Get-JunosCapturedSections {
    # Not Mandatory: binding rejects $null before the body runs, and a caller whose section split
    # produced nothing should get an empty array rather than a binding exception.
    param([AllowNull()]$DataDict)

    # ARRAY CONTRACT, shared by every array-returning parser here: the value is returned plainly and
    # the CALLER wraps it in @(). PowerShell enumerates a returned collection on the way out, so an
    # empty result reaches the caller as nothing and a single result as a bare scalar; @() at the call
    # site normalizes both. Returning `,$array` to dodge that instead breaks the callers that do wrap,
    # handing them one element containing the whole array.
    if ($null -eq $DataDict) { return @() }
    $Captured = @()
    foreach ($Key in $DataDict.Keys) {
        if (-not [string]::IsNullOrWhiteSpace([string]$DataDict[$Key])) { $Captured += [string]$Key }
    }
    if ($Captured.Count -eq 0) { return @() }
    return @($Captured | Sort-Object)
}

# R4. The fixed-width statistics tables inside a "show interfaces extensive" block: "MAC statistics:"
# (Receive/Transmit), "PCS statistics" (Seconds) and "Ethernet FEC statistics" (Errors).
#
# None of these is reachable through ConvertFrom-JunosErrorCounters, which correctly stops at the
# first line that is not a counter - and on this platform that line is "Egress queues:", well before
# the MAC table. The cost is concrete: CRC/Align errors, Jabber frames, Fragment frames and Code
# violations are all in the collected payload and none of them reaches the snapshot.
#
# The header names its own columns and they differ per table, so they are read rather than assumed:
# the column name is what makes a bare integer mean something to a rule.
function ConvertFrom-JunosStatisticsTable {
    param([string]$Block, [string]$Label)

    $Result = [ordered]@{}
    if ([string]::IsNullOrWhiteSpace($Block) -or [string]::IsNullOrWhiteSpace($Label)) { return $Result }

    # "MAC statistics:" carries a colon; "PCS statistics" and "Ethernet FEC statistics" do not.
    $HeaderMatch = [regex]::Match($Block, '(?im)^[ \t]*' + [regex]::Escape($Label) + ':?[ \t]+(?<cols>\S.*?)[ \t]*$')
    if (-not $HeaderMatch.Success) { return $Result }
    $Columns = @([regex]::Split($HeaderMatch.Groups['cols'].Value, '\s{2,}') | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })
    if ($Columns.Count -eq 0) { return $Result }

    # Terminate on line SHAPE and require the rows to be contiguous. These three tables sit directly
    # against one another, so anything looser runs the first table into the next table's header, and
    # a fixed row-count guess breaks on any platform that prints a row more or fewer.
    $Rest = $Block.Substring($HeaderMatch.Index + $HeaderMatch.Length)
    $RowPattern = '^[ \t]{3,}(?<label>\S.*?)[ \t]{2,}(?<v1>\d+)(?:[ \t]+(?<v2>\d+))?[ \t]*$'
    $Started = $false
    foreach ($Line in ($Rest -split "`r?`n")) {
        $RowMatch = [regex]::Match($Line, $RowPattern)
        if (-not $RowMatch.Success) {
            # The split's first element is the empty remainder of the header line itself, so a blank
            # line before the first row is skipped rather than treated as the end of the table.
            if (-not $Started -and [string]::IsNullOrWhiteSpace($Line)) { continue }
            break
        }
        $Started = $true
        $Row = [ordered]@{}
        $Row[$Columns[0]] = [int64]$RowMatch.Groups['v1'].Value
        # A row with one value in a two-column table is Receive-only ("Oversized frames", "Jabber
        # frames"); the absent column stays absent rather than being invented as zero.
        if ($RowMatch.Groups['v2'].Success -and $Columns.Count -gt 1) {
            $Row[$Columns[1]] = [int64]$RowMatch.Groups['v2'].Value
        }
        $Result[$RowMatch.Groups['label'].Value.Trim()] = $Row
    }
    return $Result
}

# R3. Every row of "show ethernet-switching table", not the de-duplicated view Clients needs.
#
# The client list is keyed by MAC and keeps one row per address, deliberately: it answers "what is
# plugged in where". That collapse destroys three things a diagnostic needs - the same MAC appearing
# on two ports (a loop, or a moved device still aged-in on the old port), the raw flag character
# (S/D/L/P/C/SE/NM distinguish a statically configured MAC from a learned one, where Clients keeps
# only "Dynamic" vs "Static/Other"), and transit sightings of a MAC whose access port is elsewhere.
function ConvertFrom-JunosMacTable {
    param([string]$Text)

    # See the ARRAY CONTRACT note in Get-JunosCapturedSections: returned plain, wrapped by the caller.
    $Rows = @()
    if ([string]::IsNullOrWhiteSpace($Text)) { return $Rows }

    $Instance = $null
    foreach ($Line in ($Text -split "`r?`n")) {
        if ($Line -match '(?i)^\s*Routing instance\s*:\s*(?<inst>\S+)') { $Instance = $Matches.inst; continue }
        # Anchored on the MAC address rather than on column positions: the GBP Tag column is empty on
        # this platform, so counting fields from the left mis-assigns everything after it.
        if ($Line -notmatch ('(?i)^\s*(?<vlan>\S+)\s+(?<mac>(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})\s+(?<flags>[A-Za-z]{1,3})\s+(?<age>\S+)\s+.*?(?<iface>' + $Script:JunosAnyPortPattern + ')')) { continue }
        $Rows += [PSCustomObject]@{
            RoutingInstance = $Instance
            VlanName        = $Matches.vlan
            MacAddress      = $Matches.mac.ToLower()
            # Verbatim. "D" is dynamic, "S" static, "SE" statistics-enabled, "NM" non-configured;
            # collapsing them is what made sticky-MAC and duplicate-MAC undetectable.
            Flags           = $Matches.flags
            # "-" is the switch saying it does not age this entry, which is not the same as 0 seconds.
            Age             = if ($Matches.age -eq '-') { $null } else { $Matches.age }
            Interface       = $Matches.iface
            PhysicalPort    = (ConvertTo-JunosPhysicalPort -Port $Matches.iface)
        }
    }
    return $Rows
}

# R6. Per-port dot1x, keyed by physical port.
#
# The existing parse keys by MAC, which drops every row that has no MAC - and "Initialize" rows never
# have one. Those are precisely the ports where dot1x is configured and nothing has authenticated,
# which is the state worth alerting on. A port can also carry several rows: the second and later ones
# leave the Role column blank, so Role is optional rather than required.
function ConvertFrom-JunosDot1xInterface {
    param([string]$Text)

    $ByPort = @{}
    if ([string]::IsNullOrWhiteSpace($Text)) { return $ByPort }

    # "show dot1x interface detail" is stanzas, not a table. Same rows out either way, with the two
    # fields only the detail form carries: which VLAN the supplicant was actually put in, and whether a
    # guest VLAN is configured on the port - i.e. whether a client landed in a fallback VLAN.
    if ($Text -match '(?im)^\s*(?:Role\s*:|Number of connected supplicants\s*:|Supplicant\s*:)') {
        return (ConvertFrom-JunosDot1xDetail -Text $Text)
    }

    foreach ($Line in ($Text -split "`r?`n")) {
        if ($Line -notmatch ('(?i)^\s*(?<iface>' + $Script:JunosPhysPortPattern + ')\s+(?<rest>\S.*)$')) { continue }
        $Rest = $Matches.rest
        $Iface = $Matches.iface
        # Role is optional: a continuation row for a second MAC on the same port omits it.
        if ($Rest -notmatch '(?i)^(?:(?<role>Authenticator|Supplicant)\s+)?(?<state>Authenticated|Initialize|Connecting|Held|Auto|Disconnected|Failed)\b\s*(?<tail>.*)$') { continue }
        $Tail = $Matches.tail
        $Entry = [PSCustomObject]@{
            Interface  = $Iface
            Role       = if ($Matches.role) { $Matches.role } else { $null }
            State      = $Matches.state
            MacAddress = $null
            User       = $null
            # Only the detail form prints these; unmeasured here, never "no fallback VLAN".
            AuthenticatedVlan = $null
            GuestVlan         = $null
        }
        if ($Tail -match '(?<mac>(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})\s*(?<user>\S+)?') {
            $Entry.MacAddress = $Matches.mac.ToLower()
            if ($Matches.user) { $Entry.User = $Matches.user }
        }
        $Port = ConvertTo-JunosPhysicalPort -Port $Iface
        if (-not $ByPort.ContainsKey($Port)) { $ByPort[$Port] = @() }
        $ByPort[$Port] += $Entry
    }
    return $ByPort
}

function ConvertFrom-JunosDot1xDetail {
    <#
    .SYNOPSIS
    Parses "show dot1x interface detail" into the same per-port rows the brief table yields.

    .DESCRIPTION
    One stanza per interface, "Label: value" one field per line, with a nested block per connected
    supplicant. Read by LABEL rather than by indentation: the labels are documented, the column the
    values start in is not, and a release that reflows the stanza must not empty the section.

    The two fields the upgrade is for are `Authenticated VLAN` (which VLAN the supplicant was actually
    put in - a client in the guest or server-fail VLAN is authenticated AND on the wrong network, which
    the brief form cannot show) and `Guest VLAN member`.

    A port whose stanza lists no supplicant still yields one row, with State $null: "dot1x is configured
    here and nothing is authenticated" is a state R6 exists to represent, and dropping the port would
    make it indistinguishable from a port with no dot1x at all.

    Field labels are from Juniper's published output-field table, NOT from a device this project has
    seen. The layout is inferred from the standard Junos "detail" stanza shape:
    https://www.juniper.net/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-dot1x-interface-802-1x-security.html
    #>
    param([string]$Text)

    $ByPort = @{}
    if ([string]::IsNullOrWhiteSpace($Text)) { return $ByPort }

    $States = 'Authenticated|Authenticating|Initialize|Connecting|Held|Auto|Disconnected|Failed'
    $Iface = $null
    $PortRole = $null
    $PortGuestVlan = $null
    $Rows = @()          # supplicant rows for the interface currently open
    $Current = $null     # the supplicant row being filled

    $Flush = {
        if (-not $Iface) { return }
        $Port = ConvertTo-JunosPhysicalPort -Port $Iface
        if (-not $Rows.Count) {
            $Rows = @([PSCustomObject]@{
                Interface = $Iface; Role = $PortRole; State = $null; MacAddress = $null; User = $null
                AuthenticatedVlan = $null; GuestVlan = $PortGuestVlan
            })
        }
        if (-not $ByPort.ContainsKey($Port)) { $ByPort[$Port] = @() }
        $ByPort[$Port] += $Rows
    }

    foreach ($RawLine in ($Text -split "`n")) {
        $Line = ($RawLine -replace "`r", "").TrimEnd()
        if ([string]::IsNullOrWhiteSpace($Line)) { continue }
        if ($Line -match '^\S+@\S+[>#]') { continue }

        # A bare interface name on its own line opens the stanza; some releases label it.
        if ($Line -match ('(?i)^\s*(?:Interface\s*:\s*)?(?<iface>' + $Script:JunosPhysPortPattern + ')\s*$')) {
            & $Flush
            $Iface = $Matches.iface
            $PortRole = $null; $PortGuestVlan = $null
            $Rows = @(); $Current = $null
            continue
        }
        if (-not $Iface) { continue }

        if ($Line -match '(?i)^\s*Role\s*:\s*(?<role>\S+)') { $PortRole = $Matches.role; continue }
        if ($Line -match '(?i)^\s*Guest VLAN member\s*:\s*(?<vlan>\S+)') {
            # "<not configured>" is the switch saying there is none; keep it out of the data as $null.
            $PortGuestVlan = if ($Matches.vlan -match '^<') { $null } else { $Matches.vlan }
            continue
        }
        if ($Line -match '(?i)^\s*Supplicant\s*:\s*(?<rest>\S.*)$') {
            $Rest = $Matches.rest
            $Current = [PSCustomObject]@{
                Interface = $Iface; Role = $PortRole; State = $null; MacAddress = $null; User = $null
                AuthenticatedVlan = $null; GuestVlan = $PortGuestVlan
            }
            if ($Rest -match '(?<mac>(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})') { $Current.MacAddress = $Matches.mac.ToLower() }
            # "Supplicant: <user>, <mac>" - and under MAC RADIUS the username IS the MAC, which is not
            # a username worth recording twice.
            $Name = ($Rest -split ',')[0].Trim()
            if ($Name -and $Name -notmatch '^(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$') { $Current.User = $Name }
            $Rows += $Current
            continue
        }
        if (-not $Current) {
            # Port-level lines that precede any supplicant, e.g. a MAC printed for the port itself.
            continue
        }
        if ($Line -match "(?i)^\s*(?:Operational state|State)\s*:\s*(?<state>$States)\b") { $Current.State = $Matches.state; continue }
        if ($Line -match '(?i)^\s*Authenticated VLAN\s*:\s*(?<vlan>\S+)') {
            $Current.AuthenticatedVlan = if ($Matches.vlan -match '^<') { $null } else { $Matches.vlan }
            continue
        }
        if ($null -eq $Current.MacAddress -and $Line -match '(?i)^\s*MAC address\s*:\s*(?<mac>(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})') {
            $Current.MacAddress = $Matches.mac.ToLower()
        }
    }
    & $Flush

    return $ByPort
}

function ConvertFrom-JunosStpBridge {
    <#
    .SYNOPSIS
    Parses "show spanning-tree bridge" into one record per spanning-tree scope.

    .DESCRIPTION
    One stanza per instance, opened by a heading whose tail names the scope:

      STP bridge parameters                  -> RSTP/STP, the single instance
      STP bridge parameters for VLAN 100     -> VSTP
      STP bridge parameters for CIST         -> MSTP's common instance
      STP bridge parameters for MSTI 1       -> MSTP

    `Scope` is normalised to the SAME strings "show spanning-tree interface" prints in its own headings
    ("instance 0", "VLAN 100", "MSTI 1"), because the only reason to collect this is to join it to
    per-port state - and a join on two spellings of one instance is not a join.

    The fields that earn the command are `TopologyChangeCount` and `TimeSinceLastChangeSeconds`: for
    "why is this broken now", a VLAN that reconverged forty seconds ago says more than which bridge is
    root (Appendix B, G4). Root ID is collected too - today the root is only inferred from the absence
    of a ROOT-role port.

    Headings and labels are from Juniper's published documentation and a published lab capture, NOT from
    a device this project has seen:
    https://www.juniper.net/documentation/en_US/junos/topics/reference/command-summary/show-spanning-tree-bridge-spanning-trees-ex-series.html
    https://netlabs.gitbook.io/juniper/6-stp-rstp-vstp-mstp/vstp
    #>
    param([string]$Text)

    $Scopes = @()
    if ([string]::IsNullOrWhiteSpace($Text)) { return $Scopes }

    $Current = $null
    foreach ($RawLine in ($Text -split "`n")) {
        $Line = ($RawLine -replace "`r", "").TrimEnd()
        if ([string]::IsNullOrWhiteSpace($Line)) { continue }
        if ($Line -match '^\S+@\S+[>#]') { continue }

        if ($Line -match '(?i)^\s*STP bridge parameters(?:\s+for\s+(?<scope>.+?))?\s*:?\s*$') {
            $Scope = if ($Matches.scope) { $Matches.scope.Trim() } else { 'instance 0' }
            # VSTP prints "VLAN 100"; MSTP "CIST" and "MSTI 1"; a bare heading is the single RSTP
            # instance, which the interface command calls "instance 0".
            if ($Scope -match '(?i)^CIST$') { $Scope = 'CIST' }
            $Current = [PSCustomObject]@{
                Scope                      = $Scope
                EnabledProtocol            = $null
                RootId                     = $null
                RootCost                   = $null
                RootPort                   = $null
                BridgeId                   = $null
                TopologyChangeCount        = $null
                TimeSinceLastChangeSeconds = $null
            }
            $Scopes += $Current
            continue
        }
        if (-not $Current) { continue }

        if ($Line -match '(?i)^\s*Enabled protocol\s*:\s*(?<v>\S+)') { $Current.EnabledProtocol = $Matches.v; continue }
        if ($Line -match '(?i)^\s*Root ID\s*:\s*(?<v>\S+)') { $Current.RootId = $Matches.v; continue }
        if ($Line -match '(?i)^\s*Root cost\s*:\s*(?<v>\d+)') { $Current.RootCost = [int]$Matches.v; continue }
        if ($Line -match '(?i)^\s*Root port\s*:\s*(?<v>\S+)') { $Current.RootPort = $Matches.v; continue }
        # "Local parameters" opens the local bridge's own block; Bridge ID is the only field there this
        # collects, and it is what makes "this switch IS the root" a fact rather than an inference.
        if ($Line -match '(?i)^\s*Bridge ID\s*:\s*(?<v>\S+)') { $Current.BridgeId = $Matches.v; continue }
        if ($Line -match '(?i)^\s*Number of topology changes\s*:\s*(?<v>\d+)') { $Current.TopologyChangeCount = [int]$Matches.v; continue }
        if ($Line -match '(?i)^\s*Time since last topology change\s*:\s*(?<v>\d+)') {
            $Current.TimeSinceLastChangeSeconds = [int]$Matches.v
            continue
        }
    }

    return $Scopes
}

# R7. The whole PoE row, keyed by physical port.
#
# Admin status was captured and thrown away, which left "administratively disabled" and "enabled but
# nothing drawing power" both reading as OFF - a distinction that decides whether a dead access point
# is a config error or a dead access point. Max power and Priority matter when a budget is
# oversubscribed; Pair/Mode says whether the port is 2-pair or 4-pair.
function ConvertFrom-JunosPoeInterface {
    param([string]$Text)

    $ByPort = @{}
    if ([string]::IsNullOrWhiteSpace($Text)) { return $ByPort }

    $PortPat = $Script:JunosPhysPortPattern
    foreach ($Line in ($Text -split "`r?`n")) {
        $Trimmed = $Line.Trim()
        $Full = [regex]::Match($Trimmed, "(?i)^(?<port>$PortPat)\s+(?<admin>Enabled|Disabled)\s+(?<oper>\S+)\s+(?<pair>\S+)\s+(?<maxpower>[\d.]+W?)\s+(?<priority>\S+)\s+(?<consumption>[\d.]+W?)\s+(?<class>\S+)$")
        if ($Full.Success) {
            $ByPort[(ConvertTo-JunosPhysicalPort -Port $Full.Groups['port'].Value)] = [PSCustomObject]@{
                AdminStatus      = $Full.Groups['admin'].Value
                OperStatus       = $Full.Groups['oper'].Value
                PairMode         = $Full.Groups['pair'].Value
                MaxPower         = $Full.Groups['maxpower'].Value
                Priority         = $Full.Groups['priority'].Value
                PowerConsumption = $Full.Groups['consumption'].Value
                Class            = $Full.Groups['class'].Value
            }
            continue
        }
        # The column count between Oper and Class varies by release, so a row that does not match the
        # full shape still yields the two fields every release prints in the same place.
        $Min = [regex]::Match($Trimmed, "(?i)^(?<port>$PortPat)\s+(?<admin>Enabled|Disabled)\s+(?<oper>\S+)")
        if ($Min.Success) {
            $ByPort[(ConvertTo-JunosPhysicalPort -Port $Min.Groups['port'].Value)] = [PSCustomObject]@{
                AdminStatus      = $Min.Groups['admin'].Value
                OperStatus       = $Min.Groups['oper'].Value
                PairMode         = $null
                MaxPower         = $null
                Priority         = $null
                PowerConsumption = $null
                Class            = $null
            }
        }
    }
    return $ByPort
}

# R9. The default route in full, not just its next-hop address.
#
# Gateway = "Unknown" currently means two different things: there is no default route, or there is
# one in a shape the regex missed. Those need different answers from an operator, so an unmatched
# but non-empty section reports the "Unparsed" sentinel instead.
function ConvertFrom-JunosDefaultRoute {
    param([string]$Text)

    $Route = [ordered]@{
        Table = $null; Destination = $null; Protocol = $null; Preference = $null
        NextHop = $null; EgressInterface = $null; State = 'NoSection'
    }
    if ([string]::IsNullOrWhiteSpace($Text)) { return $Route }
    $Route.State = 'Unparsed'

    if ($Text -match '(?m)^(?<table>\S+\.\d+):\s+\d+\s+destinations') { $Route.Table = $Matches.table }
    # "0.0.0.0/0          *[Static/5] 1w2d 03:04:05" - the protocol and preference share one bracket.
    if ($Text -match '(?m)^(?<dest>\d{1,3}(?:\.\d{1,3}){3}/\d{1,2})\s+[*+-]*\[(?<proto>[^/\]]+)(?:/(?<pref>\d+))?\]') {
        $Route.Destination = $Matches.dest
        $Route.Protocol = $Matches.proto.Trim()
        if ($Matches.pref) { $Route.Preference = [int]$Matches.pref }
    }
    # The next hop sits on its own continuation line: ">  to 10.0.0.1 via irb.188".
    if ($Text -match '(?im)to\s+(?<gw>\d{1,3}(?:\.\d{1,3}){3})\s+via\s+(?<iface>\S+)') {
        $Route.NextHop = $Matches.gw
        $Route.EgressInterface = $Matches.iface.TrimEnd(',')
    }
    if ($Route.NextHop -or $Route.Destination) { $Route.State = 'Parsed' }
    return $Route
}

# R11. Virtual-chassis members with the Status column and the Neighbor List continuation rows.
#
# Status is what says a member dropped out - "Prsnt" against "NotPrsnt" - and the existing parse
# discarded it, so a stack missing a member looked identical to a healthy one. The neighbour rows
# wrap: a member with two VCP links puts the second on its own line carrying only the trailing two
# columns, which the member-row pattern must not swallow.
function ConvertFrom-JunosVirtualChassis {
    param([string]$Text)

    $Members = @()
    if ([string]::IsNullOrWhiteSpace($Text)) { return $Members }

    $Current = $null
    foreach ($Line in ($Text -split "`r?`n")) {
        if ($Line -match '^\s*(?<id>\d+)\s+\(FPC\s+(?<fpc>\d+)\)\s+(?<status>\S+)\s+(?<serial>\S+)\s+(?<model>\S+)\s+(?<prio>\d+)\s+(?<role>\S+)(?<tail>.*)$') {
            $Role = $Matches.role
            $Current = [PSCustomObject]@{
                MemberId     = $Matches.id
                FPC          = $Matches.fpc
                # "Prsnt" / "NotPrsnt" - the only statement that a configured member is actually there.
                Status       = $Matches.status
                Serial       = $Matches.serial
                Model        = $Matches.model
                MasterPriority = [int]$Matches.prio
                # Junos marks the member that answered with a trailing "*".
                Role         = $Role.TrimEnd('*')
                IsMaster     = $Role.EndsWith('*')
                NeighborList = @()
            }
            $Tail = $Matches.tail
            if ($Tail -match '(?<nid>\d+)\s+(?<iface>(?:vcp|ge|xe|et)[\w\-/.:]+)\s*$') {
                $Current.NeighborList += [PSCustomObject]@{ MemberId = $Matches.nid; Interface = $Matches.iface }
            }
            $Members += $Current
            continue
        }
        # A continuation row carries only "<neighbour id>  <vcp interface>". It must be attached to
        # the member above it, never parsed as a member of its own - after trimming it also starts
        # with a digit, which is what made it look like one.
        if ($Current -and $Line -match '^\s+(?<nid>\d+)\s+(?<iface>(?:vcp|ge|xe|et)[\w\-/.:]+)\s*$') {
            $Current.NeighborList += [PSCustomObject]@{ MemberId = $Matches.nid; Interface = $Matches.iface }
        }
    }
    return $Members
}

# R8. "show chassis hardware" as FPC -> PIC -> Xcvr.
#
# The absence of an Xcvr row under a PIC is the only reliable "nothing is plugged in" signal for a
# fibre port: a cage with no optic reports link down exactly like a cage with a dead optic.
#
# Parsed by the header's own column offsets rather than by splitting on whitespace: Version is
# "REV 12" (two words) and Description is free text, so field-counting mis-assigns both.
function ConvertFrom-JunosChassisHardware {
    param([string]$Text)

    $Items = @()
    if ([string]::IsNullOrWhiteSpace($Text)) { return $Items }

    $Lines = $Text -split "`r?`n"
    $Offsets = $null
    foreach ($Line in $Lines) {
        if ($Line -match '^Item\s+Version\s+Part number\s+Serial number\s+Description') {
            $Offsets = [ordered]@{}
            foreach ($Col in 'Item', 'Version', 'Part number', 'Serial number', 'Description') {
                $Offsets[$Col] = $Line.IndexOf($Col)
            }
            break
        }
    }
    if (-not $Offsets) { return $Items }

    function Get-Field {
        param([string]$Line, [int]$Start, [int]$End)
        if ($Start -lt 0 -or $Start -ge $Line.Length) { return $null }
        $Stop = if ($End -lt 0 -or $End -gt $Line.Length) { $Line.Length } else { $End }
        if ($Stop -le $Start) { return $null }
        $V = $Line.Substring($Start, $Stop - $Start).Trim()
        if ([string]::IsNullOrWhiteSpace($V)) { return $null }
        return $V
    }

    $Names = @($Offsets.Keys)
    foreach ($Line in $Lines) {
        if ($Line -match '^Item\s+Version' -or [string]::IsNullOrWhiteSpace($Line)) { continue }
        if ($Line -match '^\s*Hardware inventory') { continue }
        $Item = Get-Field -Line $Line -Start $Offsets['Item'] -End $Offsets['Version']
        if (-not $Item) { continue }
        # Indentation is the hierarchy: FPC at column 0, PIC two in, Xcvr four in.
        $Indent = $Line.Length - $Line.TrimStart().Length
        $Items += [PSCustomObject]@{
            Item        = $Item
            Indent      = $Indent
            Level       = [int]([math]::Floor($Indent / 2))
            Version     = Get-Field -Line $Line -Start $Offsets['Version'] -End $Offsets['Part number']
            PartNumber  = Get-Field -Line $Line -Start $Offsets['Part number'] -End $Offsets['Serial number']
            Serial      = Get-Field -Line $Line -Start $Offsets['Serial number'] -End $Offsets['Description']
            Description = Get-Field -Line $Line -Start $Offsets['Description'] -End -1
        }
    }
    return $Items
}

# R2. The "Organization Info" stanzas of an LLDP neighbour block.
#
# These carry the 802.3 TLVs - MAC/PHY Configuration/Status, Maximum Frame Size, MDI Power, Link
# Aggregation - which state the FAR end's autonegotiation, MTU and PoE negotiation. That is a
# duplex/speed mismatch and an MTU mismatch diagnosable from one end, without scanning the peer,
# which matters most for the peers a crawl cannot reach.
#
# One block carries several stanzas and each repeats the same three labels, so they are split on the
# "Organization Info" heading rather than matched across the whole block.
function ConvertFrom-JunosLldpOrgInfo {
    param([string]$Block)

    $Stanzas = @()
    if ([string]::IsNullOrWhiteSpace($Block)) { return $Stanzas }

    foreach ($Chunk in ($Block -split '(?im)^\s*Organization Info\s*$')) {
        if ($Chunk -notmatch '(?im)^\s*OUI\s*:') { continue }
        $Entry = [PSCustomObject]@{ OUI = $null; Subtype = $null; Info = $null }
        if ($Chunk -match '(?im)^\s*OUI\s*:\s*(?<v>.+?)\s*$')     { $Entry.OUI = $Matches.v }
        if ($Chunk -match '(?im)^\s*Subtype\s*:\s*(?<v>.+?)\s*$') { $Entry.Subtype = $Matches.v }
        # Info is the payload and is the only free-form one; it runs to end of line.
        if ($Chunk -match '(?im)^\s*Info\s*:\s*(?<v>.+?)\s*$')    { $Entry.Info = $Matches.v }
        $Stanzas += $Entry
    }
    return $Stanzas
}

# R2b. LLDP timing: Ageout Count from the block header, and Time to live / Time mark / Age from the
# "Local Information" line. Age is seconds since this neighbour was last heard from, which is the
# closest thing to a per-port last-seen the scan collects - see port-last-used-spec.md section 1.3.
function ConvertFrom-JunosLldpTiming {
    param([string]$Block)

    $Timing = [ordered]@{ AgeoutCount = $null; TimeToLive = $null; TimeMark = $null; AgeSeconds = $null }
    if ([string]::IsNullOrWhiteSpace($Block)) { return $Timing }

    if ($Block -match '(?im)^\s*Ageout Count\s*:\s*(?<v>\d+)') { $Timing.AgeoutCount = [int]$Matches.v }
    if ($Block -match '(?i)Time to live\s*:\s*(?<v>\d+)')      { $Timing.TimeToLive = [int]$Matches.v }
    # "Time mark: Tue Sep  9 12:34:56 2026 Age: 15 secs" - the mark is free-form and runs up to "Age:".
    if ($Block -match '(?i)Time mark\s*:\s*(?<v>.+?)\s+Age\s*:') { $Timing.TimeMark = $Matches.v.Trim() }
    if ($Block -match '(?i)\bAge\s*:\s*(?<v>\d+)\s*secs')        { $Timing.AgeSeconds = [int]$Matches.v }
    return $Timing
}

# R13. LLDP-MED inventory. Every field carries a "MED " prefix in the output, which is why a pattern
# anchored on "Model name" finds nothing. Present on 25 of the capture's 43 blocks, and it is the only
# statement of what a phone or access point actually IS - model and manufacturer are otherwise
# unknowable from the switch.
function ConvertFrom-JunosLldpMedInventory {
    param([string]$Block)

    $Med = [ordered]@{
        Manufacturer = $null; ModelName = $null; SerialNumber = $null
        HardwareRevision = $null; SoftwareRevision = $null; FirmwareRevision = $null
    }
    if ([string]::IsNullOrWhiteSpace($Block)) { return $Med }

    $Map = [ordered]@{
        'Manufacturer name' = 'Manufacturer'; 'Model name' = 'ModelName'; 'Serial number' = 'SerialNumber'
        'Hardware revision' = 'HardwareRevision'; 'Software revision' = 'SoftwareRevision'
        'Firmware revision' = 'FirmwareRevision'
    }
    foreach ($Label in $Map.Keys) {
        if ($Block -match ('(?im)^\s*MED\s+' + [regex]::Escape($Label) + '\s*:\s*(?<v>.+?)\s*$')) {
            $Med[$Map[$Label]] = $Matches.v
        }
    }
    return $Med
}

# R1. Logical units from "show interfaces terse", one row per (parent, unit, family, address).
#
# The physical-port rows in $NodeData.Interfaces deliberately strip the ".unit" suffix - their identity
# is the physical port and window.normalizePort joins depend on it - so unit-level facts have nowhere
# to live there. Emitted flat with a Parent field: the L3 addresses a gateway-candidate rule needs sit
# on irb.N / vme.0 / me.0 / lo0.N, whose parents are not physical ports and get no Interfaces row.
#
# Parsed by the header's column offsets rather than by whitespace runs, because the Local column is
# optional independently of Proto (vcp units have neither) and a unit may continue onto further lines:
# a lone token at the Proto offset is another family on the same unit, one at the Local offset is
# another address on the same family.
function ConvertFrom-JunosInterfacesTerse {
    param([string]$Text)

    $Rows = @()
    if ([string]::IsNullOrWhiteSpace($Text)) { return $Rows }

    $ProtoCol = -1
    $Parent = $null
    $Unit = $null
    $Admin = $null
    $Link = $null
    $Proto = $null

    foreach ($Line in ($Text -split "`r?`n")) {
        if ($ProtoCol -lt 0) {
            if ($Line -match 'Admin' -and $Line -match 'Link' -and $Line -match 'Proto') {
                $ProtoCol = $Line.IndexOf('Proto')
            }
            continue
        }
        if ([string]::IsNullOrWhiteSpace($Line)) { continue }

        if ($Line[0] -match '\S') {
            if ($Line -notmatch '^(?<if>\S+)\s+(?<admin>up|down)\s+(?<link>up|down)') { continue }
            $IfName = $Matches.if
            $Admin = $Matches.admin
            $Link = $Matches.link
            $Parent = $null
            $Unit = $null
            $Proto = $null
            # Unit-less parents carry no address and are not emitted.
            if ($IfName -match '^(?<p>.+)\.(?<u>\d+)$') { $Parent = $Matches.p; $Unit = [int]$Matches.u }
            if ($null -eq $Parent) { continue }
        } elseif ($null -eq $Parent) {
            continue
        }

        # Everything from the Proto offset rightwards, split on tokens rather than on the header's Local
        # and Remote offsets: "eth-switch" is one character wider than the Proto column, so a fixed-width
        # read truncates it. A line blank at the Proto offset is a continuation carrying only an address.
        $Tail = ""
        if ($Line.Length -gt $ProtoCol) { $Tail = $Line.Substring($ProtoCol) }
        if ($Tail -match '^(?<proto>\S+)(?<rest>.*)$') {
            $Proto = $Matches.proto
            $Tail = $Matches.rest
        }
        # A bundle member prints its aggregate as "--> ae0.0"; the arrow is not part of the address.
        $Tail = $Tail.Trim() -replace '^-->\s*',''
        $Local = $null
        $Remote = $null
        if ($Tail -match '^(?<local>\S+)(?:\s+(?<remote>.+?))?\s*$') {
            $Local = $Matches.local
            if ($Matches.remote) { $Remote = $Matches.remote.Trim() }
        }

        $Rows += [PSCustomObject]@{
            Parent = $Parent
            Unit = $Unit
            Family = $Proto
            LocalAddress = $Local
            Remote = $Remote
            Admin = $Admin
            Link = $Link
        }
    }
    return $Rows
}

# C1. What kind of failure ssh reported, from its stderr.
#
# "Unreachable" conflated four different facts. "Connection refused" means the device IS L3-reachable
# and sshd answered - a service or ACL problem, not a dead box. "No route to host" is a fault in THIS
# host's routing, not the target's. A DNS failure means nothing was ever contacted. Only a timeout
# leaves the target's reachability genuinely unknown.
#
# Order is load-bearing: a hard failure's stderr can carry several lines (a connect error followed by
# a banner), and the authentication case must win over anything that mentions a closed connection.
function Get-JunosScanFailureClass {
    param([string]$Stderr)

    if ($Stderr -match "(?i)permission denied|authentication failed|too many authentication failures") { return "AuthFailed" }
    if ($Stderr -match "(?i)connection refused") { return "Refused" }
    if ($Stderr -match "(?i)could not resolve hostname|no address associated|name or service not known|nodename nor servname") { return "DnsFailed" }
    if ($Stderr -match "(?i)no route to host|network is unreachable|host is down") { return "NoRoute" }
    if ($Stderr -match "(?i)timed out") { return "Timeout" }
    return "Error"
}

# C5. "Last flapped" from one "show interfaces extensive" block, as a duration and a state.
#
# The state exists because $null seconds meant two opposite things: "Never" - the port has not flapped
# since boot, which is the healthy case - and a duration this parser could not decode, which is a bug
# to chase. Only the relative "(... ago)" part is read: the absolute timestamp's abbreviated timezone
# is not reliably resolvable and the switch clock may differ from the scan host's.
function ConvertFrom-JunosLastFlapped {
    param([string]$Block)

    if ([string]::IsNullOrWhiteSpace($Block) -or $Block -notmatch '(?im)^\s*Last flapped\s*:') {
        return @{ Seconds = $null; State = $null }
    }
    if ($Block -match '(?im)^\s*Last flapped\s*:\s*Never') {
        return @{ Seconds = $null; State = 'Never' }
    }
    # The y unit precedes w, and an interface up for over a year matched neither branch below - so the
    # longest-running ports in a fleet were the ones reported as unreadable.
    if ($Block -match '(?im)^\s*Last flapped\s*:[^\(]*\(\s*(?:(?<y>\d+)y)?\s*(?:(?<w>\d+)w)?\s*(?:(?<d>\d+)d)?\s*(?:(?<h>\d+):(?<m>\d+)(?::(?<s>\d+))?)?\s*ago\s*\)') {
        $TotalSeconds = 0
        if ($Matches.y) { $TotalSeconds += [int]$Matches.y * 31536000 }
        if ($Matches.w) { $TotalSeconds += [int]$Matches.w * 604800 }
        if ($Matches.d) { $TotalSeconds += [int]$Matches.d * 86400 }
        if ($Matches.h) { $TotalSeconds += [int]$Matches.h * 3600 }
        if ($Matches.m) { $TotalSeconds += [int]$Matches.m * 60 }
        if ($Matches.s) { $TotalSeconds += [int]$Matches.s }
        # An empty parenthesis group matches every optional unit and yields zero, which is a real value
        # for a port that flapped this second - so require that at least one unit was actually present.
        if ($Matches.y -or $Matches.w -or $Matches.d -or $Matches.h) {
            return @{ Seconds = $TotalSeconds; State = 'Parsed' }
        }
    }
    if ($Block -match '(?im)^\s*Last flapped\s*:[^\(]*\(\s*(?<secs>\d+)\s*secs?\s*ago\s*\)') {
        return @{ Seconds = [int]$Matches.secs; State = 'Parsed' }
    }
    return @{ Seconds = $null; State = 'Unparsed' }
}

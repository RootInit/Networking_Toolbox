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

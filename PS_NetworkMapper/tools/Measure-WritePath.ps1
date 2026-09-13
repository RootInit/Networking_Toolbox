<#
    Measures FleetCrawl's snapshot write path at the post-diagnostics field density.

    Produces the numbers recorded in docs/diagnostics-spec.md section 9.1. Run it on Windows
    PowerShell 5.1 - the ratios differ by several times from pwsh 7, so an off-target run proves
    nothing.

        .\tools\Measure-WritePath.ps1 -LibPath .\lib

    Generates a synthetic topology whose OBJECT TYPES and BYTE DENSITY match a real scanned node
    (Hashtable node, Object[] of PSCustomObject interfaces, nested hashtables for StpDetail /
    InputErrors / OutputErrors / Vlans), then times each stage of Write-TopologyOutputLocal
    separately for both the plaintext and the encrypted branch.

    Nothing here is derived from a real capture except the per-field byte counts used to size the
    filler, so the script is safe to commit.
#>
[CmdletBinding()]
param(
    [int]$Devices = 350,
    [int]$PortsPerDevice = 48,
    # "show configuration | display set" is stored verbatim for backup. Sweep it: the real size is
    # site-specific and it is the one section that could plausibly dominate everything else.
    [int[]]$ConfigKiB = @(0, 40, 120),
    [int]$Runs = 3,
    [string]$LibPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'lib'),
    # Serialize with -Compress instead of the shipped pretty-printer, to price the alternative.
    [switch]$CompressJson
)

$ErrorActionPreference = 'Stop'
. (Join-Path $LibPath 'FileHelpers.ps1')
. (Join-Path $LibPath 'TopologyCrypto.ps1')

$OutDir = Join-Path ([System.IO.Path]::GetTempPath()) 'pnm-writepath-bench'
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

# ---------------------------------------------------------------- synthetic topology

$Rand = New-Object System.Random 20260913
function Get-Filler {
    param([int]$Length)
    # Deterministic and incompressible-ish; a constant string would let nothing vary between ports.
    $Chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    $Sb = New-Object System.Text.StringBuilder $Length
    for ($i = 0; $i -lt $Length; $i++) { [void]$Sb.Append($Chars[$Rand.Next($Chars.Length)]) }
    $Sb.ToString()
}

function New-SyntheticInterface {
    param([int]$Index, [int]$Fpc)
    $Port = "ge-$Fpc/0/$Index"
    # 3 STP scopes/port (VSTP prints one row per VLAN) ~= 303 B/port compressed.
    $Stp = @{}
    foreach ($V in 110, 120, 130) {
        $Stp["VLAN $V"] = @{ Role = 'DESG'; State = 'FWD'; Cost = 20000; Priority = 128; DesignatedBridge = "32768.aabbcc0011$($Fpc)$Index" }
    }
    # Junos prints ~12 named counters per direction; only the non-zero ones survive the parser.
    $InErr = @{}; $OutErr = @{}
    foreach ($K in 'Errors', 'Drops', 'Framing errors', 'Runts', 'Policed discards', 'L3 incompletes',
                   'L2 channel errors', 'L2 mismatch timeouts', 'FIFO errors', 'Resource errors') {
        $InErr[$K] = $Rand.Next(0, 5)
    }
    foreach ($K in 'Carrier transitions', 'Errors', 'Drops', 'Collisions', 'Aged packets',
                   'FIFO errors', 'HS link CRC errors', 'MTU errors', 'Resource errors') {
        $OutErr[$K] = $Rand.Next(0, 5)
    }
    $Vlans = if ($Index % 100 -lt 56) { @(@{ Name = "vlan-$(110 + ($Index % 6))"; Tag = 110 + ($Index % 6); Mode = 'tagged' }) } else { @() }

    [pscustomobject]@{
        Port                = $Port
        Desc                = "AP-$Fpc-$Index $(Get-Filler 78)"
        Admin               = 'up'
        Link                = if ($Index % 4 -eq 0) { 'down' } else { 'up' }
        STP                 = 'FWD'
        PoE                 = 'Powered'
        MacAddress          = "aa:bb:cc:{0:x2}:{1:x2}:{2:x2}" -f $Fpc, ($Index -shr 8), ($Index -band 0xFF)
        Mtu                 = 1514
        LinkLevelType       = 'Ethernet'
        MediaType           = 'Fiber'
        SpeedConfigured     = 'Auto'
        SpeedNegotiated     = '1000mbps'
        Duplex              = 'Full-Duplex'
        DuplexNegotiated    = 'Full'
        AutoNegotiation     = 'Enabled'
        NegotiationStatus   = 'Complete'
        ActiveAlarms        = 'None'
        ActiveDefects       = 'None'
        LastFlappedSeconds  = $Rand.Next(0, 9000000)
        CarrierTransitions  = $Rand.Next(0, 400)
        InputBytes          = [int64]$Rand.Next() * 1000
        OutputBytes         = [int64]$Rand.Next() * 1000
        InputBps            = $Rand.Next(0, 900000)
        OutputBps           = $Rand.Next(0, 900000)
        InputErrors         = $InErr
        OutputErrors        = $OutErr
        Vlans               = $Vlans
        StpDetail           = $Stp
        Bundle              = $null
        BundleMembers       = @()
    }
}

function New-SyntheticNode {
    param([int]$Index, [int]$Ports, [string]$Config)
    $Octet3 = [int]($Index / 250); $Octet4 = ($Index % 250) + 1
    $Interfaces = New-Object System.Collections.Generic.List[object]
    for ($p = 0; $p -lt $Ports; $p++) { $Interfaces.Add((New-SyntheticInterface -Index $p -Fpc ([int]($p / 48)))) }

    # Real capture ratio: 61 clients / 75 ports, 235 B each.
    $Clients = @(for ($c = 0; $c -lt [int]($Ports * 0.81); $c++) {
        [pscustomobject]@{
            MacAddress = "de:ad:{0:x2}:{1:x2}:{2:x2}:{3:x2}" -f $Octet3, $Octet4, ($c -shr 8), ($c -band 0xFF)
            Port = "ge-0/0/$($c % $Ports)"; Vlan = "vlan-$(110 + ($c % 6))"; VlanTag = 110 + ($c % 6)
            Age = "$($Rand.Next(0,300))"; Flags = 'Learn'; Type = 'Learn'
            IPAddress = "10.$Octet3.$($c % 250).$Octet4"; Vendor = (Get-Filler 70)
        }
    })
    $Vlans = @(for ($v = 0; $v -lt 17; $v++) {
        [pscustomobject]@{ Name = "vlan-$(110 + $v)"; Tag = 110 + $v; RoutingInstance = 'default-switch'
                           Members = @(for ($m = 0; $m -lt 40; $m++) { "ge-0/0/$m.0" }) }
    })
    $Med = @(for ($m = 0; $m -lt [int]($Ports * 0.37); $m++) {
        [pscustomobject]@{ LocalPort = "ge-0/0/$m"; ChassisId = (Get-Filler 17); PortId = (Get-Filler 17)
                           SystemName = "phone-$Octet3-$m"; Age = $Rand.Next(0, 120); Class = 'Endpoint Class III' }
    })
    $Neighbors = @(for ($k = 0; $k -lt 5; $k++) {
        [pscustomobject]@{ LocalPort = "xe-0/1/$k"; RemotePort = "xe-0/1/$k"; RemoteSystem = "core-sw-$k"
                           RemoteIP = "10.0.0.$($k + 1)"; ChassisIdType = 'Mac address'; PortIdType = 'Interface name'; Age = $Rand.Next(0, 120) }
    })

    @{
        DeviceIP = "10.$Octet3.0.$Octet4"; Hostname = "sw-$Octet3-$Octet4"; ScanStatus = 'Ok'; ScanError = ''
        JunosVersion = '21.4R3-S5.4'; Uptime = '2026-01-14 03:22:11 UTC'; Gateway = "10.$Octet3.0.1"
        LastConfigured = '2026-08-02 11:04:55 UTC'; LastConfiguredBy = 'netops'
        MasterCpuUtilization = 12; MasterMemoryUtilization = 41; Alarms = @()
        StackMembers = @(
            [pscustomobject]@{ Slot = 0; Role = 'Master'; Serial = (Get-Filler 12); Model = 'ex4300-48t' }
            [pscustomobject]@{ Slot = 1; Role = 'Backup'; Serial = (Get-Filler 12); Model = 'ex4300-48t' }
        )
        ArpEntries = @(for ($a = 0; $a -lt 4; $a++) {
            [pscustomobject]@{ MacAddress = "aa:00:00:00:00:0$a"; IPAddress = "10.$Octet3.1.$a"; Interface = "irb.$(110 + $a)"; PhysicalPort = "ge-0/0/$a.0"; Flags = 'none' }
        })
        Interfaces = $Interfaces.ToArray()
        Clients = $Clients
        Vlans = $Vlans
        MedNeighbors = $Med
        Neighbors = $Neighbors
        Configuration = $Config
    }
}

# ---------------------------------------------------------------- harness

function Measure-Stage {
    param([string]$Name, [scriptblock]$Body)
    $Sw = [System.Diagnostics.Stopwatch]::StartNew()
    $Result = & $Body
    $Sw.Stop()
    [pscustomobject]@{ Stage = $Name; Ms = [int]$Sw.Elapsed.TotalMilliseconds; Result = $Result }
}

$Report = New-Object System.Text.StringBuilder
function Emit { param([string]$Line) Write-Host $Line; [void]$Report.AppendLine($Line) }

Emit ("PSVersion      : {0} ({1})" -f $PSVersionTable.PSVersion, $PSVersionTable.PSEdition)
Emit ("Host           : {0}  {1} logical CPUs" -f $env:COMPUTERNAME, $env:NUMBER_OF_PROCESSORS)
Emit ("Topology       : {0} devices x {1} ports" -f $Devices, $PortsPerDevice)
Emit ("Runs per case  : {0} (plus one discarded warmup)" -f $Runs)
Emit ("Serializer     : {0}" -f $(if ($CompressJson) { 'ConvertTo-Json -Depth 100 -Compress' } else { 'ConvertTo-Json -Depth 100 (shipped)' }))
Emit ""

$Salt = New-Object byte[] 16
$EncKey = New-Object byte[] 32
$MacKey = New-Object byte[] 32
(New-Object System.Random 7).NextBytes($Salt)
(New-Object System.Random 8).NextBytes($EncKey)
(New-Object System.Random 9).NextBytes($MacKey)

foreach ($Kib in $ConfigKiB) {
    $Config = if ($Kib -gt 0) { Get-Filler ($Kib * 1024) } else { 'Unknown' }

    $BuildSw = [System.Diagnostics.Stopwatch]::StartNew()
    $Topology = New-Object System.Collections.Generic.List[object]
    for ($d = 0; $d -lt $Devices; $d++) { $Topology.Add((New-SyntheticNode -Index $d -Ports $PortsPerDevice -Config $Config)) }
    $BuildSw.Stop()

    Emit ("=== config {0} KiB/device ===  (topology built in {1:n1}s)" -f $Kib, $BuildSw.Elapsed.TotalSeconds)

    $Wrap = @{ Topology = $Topology; ScanTimestamp = '2026-09-13T00:00:00Z' }
    $null = $Wrap | ConvertTo-Json -Depth 100   # warmup, discarded

    for ($run = 1; $run -le $Runs; $run++) {
        [System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers(); [System.GC]::Collect()
        $Before = [System.GC]::GetTotalMemory($false)

        $Pretty   = Measure-Stage 'ConvertTo-Json -Depth 100'          { $Wrap | ConvertTo-Json -Depth 100 }
        $Compress = Measure-Stage 'ConvertTo-Json -Depth 100 -Compress'{ $Wrap | ConvertTo-Json -Depth 100 -Compress }
        $Json = if ($CompressJson) { $Compress.Result } else { $Pretty.Result }

        $Prot = Measure-Stage 'Protect-TopologyPayload' {
            Protect-TopologyPayload -PlainJson $Json -EncKey $EncKey -MacKey $MacKey -Salt $Salt -Iterations 200000
        }
        $Env5 = Measure-Stage 'envelope ConvertTo-Json -Depth 5' { $Prot.Result | ConvertTo-Json -Depth 5 }

        $PlainPath = Join-Path $OutDir 'plain.json'
        $EncPath   = Join-Path $OutDir 'enc.json'
        $WritePlain = Measure-Stage 'Out-File plaintext' { $Json | Out-File -FilePath $PlainPath -Encoding utf8; (Get-Item $PlainPath).Length }
        $WriteEnc   = Measure-Stage 'Out-File envelope'  { $Env5.Result | Out-File -FilePath $EncPath -Encoding utf8; (Get-Item $EncPath).Length }

        $DestPath = Join-Path $OutDir 'dest.json'
        $Move = Measure-Stage 'Move-FileAtomic' { Move-FileAtomic -SourcePath $EncPath -DestinationPath $DestPath; $true }

        $Peak = [System.Diagnostics.Process]::GetCurrentProcess().PeakWorkingSet64
        $Managed = [System.GC]::GetTotalMemory($false)

        $SerMs = if ($CompressJson) { $Compress.Ms } else { $Pretty.Ms }
        $PlainTotal = $SerMs + $WritePlain.Ms
        $EncTotal   = $SerMs + $Prot.Ms + $Env5.Ms + $WriteEnc.Ms + $Move.Ms

        Emit ("  run {0}:" -f $run)
        foreach ($S in $Pretty, $Compress, $Prot, $Env5, $WritePlain, $WriteEnc, $Move) {
            Emit ("    {0,-34} {1,7} ms" -f $S.Stage, $S.Ms)
        }
        Emit ("    pretty JSON chars                  {0,7}  ({1:n1} MiB)" -f $Json.Length, ($Json.Length / 1mb))
        Emit ("    compressed JSON chars              {0,7}  (pretty is {1:n2}x)" -f $Compress.Result.Length, ($Json.Length / $Compress.Result.Length))
        Emit ("    plaintext file bytes               {0,7}  ({1:n1} MiB)" -f $WritePlain.Result, ($WritePlain.Result / 1mb))
        Emit ("    envelope file bytes                {0,7}  ({1:n1} MiB)" -f $WriteEnc.Result, ($WriteEnc.Result / 1mb))
        Emit ("    managed heap after                 {0:n1} MiB    process peak working set {1:n1} MiB" -f ($Managed/1mb), ($Peak/1mb))
        Emit ("    TOTAL plaintext branch             {0,7} ms" -f $PlainTotal)
        Emit ("    TOTAL encrypted branch             {0,7} ms" -f $EncTotal)
        Emit ""

        $Json = $null; $Pretty = $null; $Compress = $null; $Prot = $null; $Env5 = $null
    }

    $Topology = $null; $Wrap = $null
    [System.GC]::Collect()
}

$ReportPath = Join-Path $OutDir 'bench-results.txt'
[System.IO.File]::WriteAllText($ReportPath, $Report.ToString())
Write-Host "`nwrote $ReportPath"

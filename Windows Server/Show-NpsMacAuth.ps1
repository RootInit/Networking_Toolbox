<#
.SYNOPSIS
    Show-NpsMacAuth.ps1 - GUI viewer for Windows Server Network Policy Server audit events,
    grouped by unique MAC address.
 
.DESCRIPTION
    Reads Security log events 6272 (granted), 6273 (denied), 6274 (discarded),
    6276 (quarantined), 6277 (probation) and 6278 (full access), extracts the
    Calling-Station-ID / identity, normalizes it to a MAC address, de-duplicates,
    and displays results in two scrollable, sortable lists.
 
    Denied entries include the NPS Reason Code and Reason text.
 
.NOTES
    Run elevated (Security log access required).
    Remote queries use the Event Log RPC channel (TCP 135 + dynamic RPC),
    not WinRM.
#>
 
#Requires -Version 5.1
 
[CmdletBinding()]
param(
    [string]$ComputerName = $env:COMPUTERNAME,
    [int]$Hours = 24
)
 
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
 
#region ------------------------------------------------------------ Worker
 
# Runs inside a background runspace so the UI never freezes.
$WorkerScript = {
    param(
        [string]$ComputerName,
        [int]$Hours,
        [int]$MaxEvents,
        [string]$MacFormat,
        [bool]$MacOnly,
        $Credential
    )
 
    # Fallback text only - the event itself normally carries a Reason string.
    $ReasonTable = @{
        0   = 'Success'
        1   = 'Internal error'
        8   = 'The specified user account does not exist'
        16  = 'Authentication failed due to a user credentials mismatch (unknown MAC or bad password)'
        21  = 'An NPS extension DLL rejected the connection request'
        23  = 'An error occurred during the NPS use of EAP'
        36  = 'The user account is disabled'
        48  = 'The connection request did not match any configured network policy'
        49  = 'The connection request did not match any configured connection request policy'
        65  = 'Network access permission for the user account was denied'
        66  = 'The user attempted to use an authentication method that is not enabled'
        262 = 'The EAP type cannot be processed by the server'
    }
 
    function ConvertTo-Mac {
        param([string]$Value, [string]$Format)
        if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
        $v = $Value
        if ($v.Contains('\')) { $v = $v.Substring($v.LastIndexOf('\') + 1) }
        if ($v.Contains('@')) { $v = $v.Split('@')[0] }
        $hex = ($v -replace '[^0-9A-Fa-f]', '')
        if ($hex.Length -ne 12) { return $null }
        $u = $hex.ToUpper()
        $p = @(0..5 | ForEach-Object { $u.Substring($_ * 2, 2) })
        switch ($Format) {
            'AA-BB-CC-DD-EE-FF' { return ($p -join '-') }
            'AABBCCDDEEFF'      { return $u }
            'aabbccddeeff'      { return $u.ToLower() }
            'aabb.ccdd.eeff'    { return ("{0}.{1}.{2}" -f $u.Substring(0,4), $u.Substring(4,4), $u.Substring(8,4)).ToLower() }
            default             { return ($p -join ':') }
        }
    }
 
    $result = [pscustomobject]@{
        Granted = @()
        Denied  = @()
        Total   = 0
        Skipped = 0
        Error   = $null
        Server  = $ComputerName
    }
 
    $start  = (Get-Date).AddHours(-1 * $Hours)
    $filter = @{
        LogName   = 'Security'
        Id        = 6272, 6273, 6274, 6276, 6277, 6278
        StartTime = $start
    }
 
    $p = @{ FilterHashtable = $filter; ErrorAction = 'Stop' }
    if ($MaxEvents -gt 0) { $p['MaxEvents'] = $MaxEvents }
 
    $localNames = @($env:COMPUTERNAME, 'localhost', '.', '127.0.0.1', '::1')
    if ($ComputerName -and ($localNames -notcontains $ComputerName)) {
        $p['ComputerName'] = $ComputerName
        if ($Credential) { $p['Credential'] = $Credential }
    }
 
    try {
        $events = @(Get-WinEvent @p)
    }
    catch {
        if ($_.Exception.Message -match 'No events were found') {
            $events = @()
        }
        else {
            $result.Error = $_.Exception.Message
            return $result
        }
    }
 
    $result.Total = $events.Count
 
    $granted = [ordered]@{}
    $denied  = [ordered]@{}
 
    foreach ($evt in $events) {
        try { $xml = [xml]$evt.ToXml() } catch { continue }
 
        $d = @{}
        foreach ($node in $xml.Event.EventData.Data) {
            if ($node.Name) { $d[$node.Name] = [string]$node.'#text' }
        }
 
        # Prefer the RADIUS Calling-Station-ID, then fall back to the identity.
        $mac = $null
        $rawId = $null
        foreach ($key in 'CallingStationID', 'SubjectUserName', 'FullyQualifiedSubjectUserName', 'SubjectMachineName') {
            if ($d.ContainsKey($key) -and $d[$key]) {
                if (-not $rawId) { $rawId = $d[$key] }
                $try = ConvertTo-Mac -Value $d[$key] -Format $MacFormat
                if ($try) { $mac = $try; break }
            }
        }
 
        if (-not $mac) {
            if ($MacOnly) { $result.Skipped++; continue }
            $mac = if ($rawId) { $rawId } else { '(unknown)' }
        }
 
        $id = [int]$evt.Id
        $isGranted = ($id -eq 6272 -or $id -eq 6277 -or $id -eq 6278)
 
        $code = $null
        if ($d.ContainsKey('ReasonCode') -and $d['ReasonCode'] -match '^\d+$') { $code = [int]$d['ReasonCode'] }
 
        $reason = $d['Reason']
        if ([string]::IsNullOrWhiteSpace($reason) -and $code -ne $null -and $ReasonTable.ContainsKey($code)) {
            $reason = $ReasonTable[$code]
        }
        if ([string]::IsNullOrWhiteSpace($reason)) {
            $reason = switch ($id) {
                6274 { 'NPS discarded the request (malformed or unmatched RADIUS packet)' }
                6276 { 'Client quarantined by NAP health policy' }
                default { 'No reason supplied by NPS' }
            }
        }
 
        $client = $d['ClientName']
        if ([string]::IsNullOrWhiteSpace($client)) { $client = $d['NASIdentifier'] }
        if ([string]::IsNullOrWhiteSpace($client)) { $client = $d['ClientIPAddress'] }
        if ([string]::IsNullOrWhiteSpace($client)) { $client = $d['NASIPv4Address'] }
 
        $detail = ($d.GetEnumerator() | Sort-Object Name |
            ForEach-Object { '{0,-34} {1}' -f $_.Name, $_.Value }) -join "`r`n"
        $detail = "Event ID   : $id`r`nTime       : $($evt.TimeCreated)`r`nMachine    : $($evt.MachineName)`r`n" +
                  ('-' * 70) + "`r`n" + $detail
 
        $bucket = if ($isGranted) { $granted } else { $denied }
 
        if ($bucket.Contains($mac)) {
            $row = $bucket[$mac]
            $row.Count++
            if ($evt.TimeCreated -gt $row.LastSeenRaw) {
                $row.LastSeenRaw = $evt.TimeCreated
                $row.LastSeen    = $evt.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss')
                $row.Policy      = $d['NetworkPolicyName']
                $row.Client      = $client
                $row.AuthType    = $d['AuthenticationType']
                $row.Identity    = $d['SubjectUserName']
                $row.Detail      = $detail
                if (-not $isGranted) {
                    $row.Code    = $(if ($null -ne $code) { $code } else { '' })
                    $row.Reason  = $reason
                    $row.EventId = $id
                }
            }
            if ($evt.TimeCreated -lt $row.FirstSeenRaw) {
                $row.FirstSeenRaw = $evt.TimeCreated
                $row.FirstSeen    = $evt.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss')
            }
        }
        else {
            $row = [pscustomobject]@{
                Mac          = $mac
                Count        = 1
                FirstSeen    = $evt.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss')
                FirstSeenRaw = $evt.TimeCreated
                LastSeen     = $evt.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss')
                LastSeenRaw  = $evt.TimeCreated
                Code         = $(if (-not $isGranted -and $null -ne $code) { $code } else { '' })
                Reason       = $(if (-not $isGranted) { $reason } else { '' })
                Policy       = $d['NetworkPolicyName']
                Client       = $client
                AuthType     = $d['AuthenticationType']
                Identity     = $d['SubjectUserName']
                EventId      = $id
                Detail       = $detail
            }
            $bucket[$mac] = $row
        }
    }
 
    $result.Granted = @($granted.Values | Sort-Object LastSeenRaw -Descending)
    $result.Denied  = @($denied.Values  | Sort-Object LastSeenRaw -Descending)
    return $result
}
 
#endregion
 
#region ------------------------------------------------------------ State
 
$script:GrantedAll   = @()
$script:DeniedAll    = @()
$script:Cred         = $null
$script:Runspace     = $null
$script:PS           = $null
$script:Handle       = $null
$script:Busy         = $false
 
$GrantedCols = @(
    @{ H = 'MAC Address';    P = 'Mac';      S = 'Mac';         W = 160 }
    @{ H = 'Hits';           P = 'Count';    S = 'Count';       W = 55  }
    @{ H = 'Last Seen';      P = 'LastSeen'; S = 'LastSeenRaw'; W = 145 }
    @{ H = 'Network Policy'; P = 'Policy';   S = 'Policy';      W = 190 }
    @{ H = 'NAS / Client';   P = 'Client';   S = 'Client';      W = 150 }
    @{ H = 'Auth Type';      P = 'AuthType'; S = 'AuthType';    W = 90  }
)
 
$DeniedCols = @(
    @{ H = 'MAC Address';    P = 'Mac';      S = 'Mac';         W = 160 }
    @{ H = 'Hits';           P = 'Count';    S = 'Count';       W = 55  }
    @{ H = 'Last Seen';      P = 'LastSeen'; S = 'LastSeenRaw'; W = 145 }
    @{ H = 'Code';           P = 'Code';     S = 'Code';        W = 50  }
    @{ H = 'Reason';         P = 'Reason';   S = 'Reason';      W = 380 }
    @{ H = 'Network Policy'; P = 'Policy';   S = 'Policy';      W = 170 }
    @{ H = 'NAS / Client';   P = 'Client';   S = 'Client';      W = 150 }
)
 
$script:GSortIdx = 2; $script:GSortAsc = $false
$script:DSortIdx = 2; $script:DSortAsc = $false
 
#endregion
 
#region ------------------------------------------------------------ UI build
 
$form = New-Object System.Windows.Forms.Form
$form.Text = 'NPS Unique MAC Viewer'
$form.Size = New-Object System.Drawing.Size(1280, 780)
$form.MinimumSize = New-Object System.Drawing.Size(960, 600)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)
 
# --- Split container (added first so it takes the leftover space) ---
$split = New-Object System.Windows.Forms.SplitContainer
$split.Dock = 'Fill'
$split.Orientation = 'Vertical'
$split.SplitterWidth = 6
 
function New-ResultPane {
    param($Title, $Cols, $ForeColor)
 
    $gb = New-Object System.Windows.Forms.GroupBox
    $gb.Text = $Title
    $gb.Dock = 'Fill'
    $gb.Padding = New-Object System.Windows.Forms.Padding(6, 4, 6, 6)
 
    $lv = New-Object System.Windows.Forms.ListView
    $lv.Dock = 'Fill'
    $lv.View = 'Details'
    $lv.FullRowSelect = $true
    $lv.GridLines = $true
    $lv.HideSelection = $false
    $lv.MultiSelect = $true
    $lv.Scrollable = $true
    $lv.Font = New-Object System.Drawing.Font('Consolas', 9)
    $lv.ForeColor = $ForeColor
    foreach ($c in $Cols) { [void]$lv.Columns.Add($c.H, $c.W) }
 
    $bar = New-Object System.Windows.Forms.Panel
    $bar.Dock = 'Bottom'
    $bar.Height = 34
 
    $btnCopy = New-Object System.Windows.Forms.Button
    $btnCopy.Text = 'Copy MACs'
    $btnCopy.Location = New-Object System.Drawing.Point(0, 4)
    $btnCopy.Size = New-Object System.Drawing.Size(100, 26)
 
    $btnCsv = New-Object System.Windows.Forms.Button
    $btnCsv.Text = 'Export CSV'
    $btnCsv.Location = New-Object System.Drawing.Point(106, 4)
    $btnCsv.Size = New-Object System.Drawing.Size(100, 26)
 
    $lbl = New-Object System.Windows.Forms.Label
    $lbl.Location = New-Object System.Drawing.Point(214, 9)
    $lbl.AutoSize = $true
    $lbl.Text = '0 unique'
 
    $bar.Controls.AddRange(@($btnCopy, $btnCsv, $lbl))
    $gb.Controls.Add($lv)
    $gb.Controls.Add($bar)
 
    return [pscustomobject]@{ Group = $gb; List = $lv; Copy = $btnCopy; Csv = $btnCsv; Label = $lbl }
}
 
$paneOk  = New-ResultPane -Title 'Authenticated - unique MAC addresses' -Cols $GrantedCols -ForeColor ([System.Drawing.Color]::FromArgb(0, 100, 0))
$paneNo  = New-ResultPane -Title 'Denied / Rejected - unique MAC addresses' -Cols $DeniedCols -ForeColor ([System.Drawing.Color]::FromArgb(150, 0, 0))
 
$split.Panel1.Controls.Add($paneOk.Group)
$split.Panel2.Controls.Add($paneNo.Group)
 
# --- Top control panel ---
$top = New-Object System.Windows.Forms.Panel
$top.Dock = 'Top'
$top.Height = 86
$top.Padding = New-Object System.Windows.Forms.Padding(8, 6, 8, 6)
 
function New-Lbl { param($t, $x, $y)
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $t; $l.Location = New-Object System.Drawing.Point($x, $y); $l.AutoSize = $true
    return $l
}
 
$txtServer = New-Object System.Windows.Forms.TextBox
$txtServer.Location = New-Object System.Drawing.Point(12, 26)
$txtServer.Size = New-Object System.Drawing.Size(200, 23)
$txtServer.Text = $ComputerName
 
$numHours = New-Object System.Windows.Forms.NumericUpDown
$numHours.Location = New-Object System.Drawing.Point(224, 26)
$numHours.Size = New-Object System.Drawing.Size(70, 23)
$numHours.Minimum = 1; $numHours.Maximum = 8760; $numHours.Value = $Hours
 
$numMax = New-Object System.Windows.Forms.NumericUpDown
$numMax.Location = New-Object System.Drawing.Point(302, 26)
$numMax.Size = New-Object System.Drawing.Size(90, 23)
$numMax.Minimum = 0; $numMax.Maximum = 1000000; $numMax.Increment = 1000; $numMax.Value = 50000
 
$cmbFmt = New-Object System.Windows.Forms.ComboBox
$cmbFmt.Location = New-Object System.Drawing.Point(400, 26)
$cmbFmt.Size = New-Object System.Drawing.Size(150, 23)
$cmbFmt.DropDownStyle = 'DropDownList'
[void]$cmbFmt.Items.AddRange(@('AA:BB:CC:DD:EE:FF', 'AA-BB-CC-DD-EE-FF', 'AABBCCDDEEFF', 'aabbccddeeff', 'aabb.ccdd.eeff'))
$cmbFmt.SelectedIndex = 0
 
$txtFilter = New-Object System.Windows.Forms.TextBox
$txtFilter.Location = New-Object System.Drawing.Point(558, 26)
$txtFilter.Size = New-Object System.Drawing.Size(210, 23)
 
$btnRefresh = New-Object System.Windows.Forms.Button
$btnRefresh.Text = 'Refresh'
$btnRefresh.Location = New-Object System.Drawing.Point(780, 24)
$btnRefresh.Size = New-Object System.Drawing.Size(90, 27)
 
$chkCred = New-Object System.Windows.Forms.CheckBox
$chkCred.Text = 'Alternate credentials'
$chkCred.Location = New-Object System.Drawing.Point(884, 8)
$chkCred.AutoSize = $true
 
$chkMacOnly = New-Object System.Windows.Forms.CheckBox
$chkMacOnly.Text = 'MAC-format identities only (MAB)'
$chkMacOnly.Location = New-Object System.Drawing.Point(884, 30)
$chkMacOnly.AutoSize = $true
$chkMacOnly.Checked = $true
 
$chkAuto = New-Object System.Windows.Forms.CheckBox
$chkAuto.Text = 'Auto-refresh every'
$chkAuto.Location = New-Object System.Drawing.Point(884, 52)
$chkAuto.AutoSize = $true
 
$numAuto = New-Object System.Windows.Forms.NumericUpDown
$numAuto.Location = New-Object System.Drawing.Point(1010, 50)
$numAuto.Size = New-Object System.Drawing.Size(60, 23)
$numAuto.Minimum = 10; $numAuto.Maximum = 3600; $numAuto.Value = 60
 
$top.Controls.AddRange(@(
    (New-Lbl 'NPS server' 14 6), $txtServer,
    (New-Lbl 'Hours back' 226 6), $numHours,
    (New-Lbl 'Max events' 304 6), $numMax,
    (New-Lbl 'MAC format' 402 6), $cmbFmt,
    (New-Lbl 'Filter (MAC / reason / policy)' 560 6), $txtFilter,
    $btnRefresh, $chkCred, $chkMacOnly, $chkAuto, $numAuto,
    (New-Lbl 'sec' 1074 54)
))
 
# --- Status strip ---
$status = New-Object System.Windows.Forms.StatusStrip
$lblStatus = New-Object System.Windows.Forms.ToolStripStatusLabel
$lblStatus.Text = 'Ready.'
$lblStatus.Spring = $true
$lblStatus.TextAlign = 'MiddleLeft'
[void]$status.Items.Add($lblStatus)
 
$form.Controls.Add($split)
$form.Controls.Add($top)
$form.Controls.Add($status)
 
$form.Add_Shown({ $split.SplitterDistance = [int]($split.Width * 0.42) })
 
#endregion
 
#region ------------------------------------------------------------ Rendering
 
function Get-FilteredRows {
    param($Rows)
    $f = $txtFilter.Text.Trim()
    if (-not $f) { return $Rows }
    $pattern = [regex]::Escape($f)
    return @($Rows | Where-Object {
        $_.Mac -match $pattern -or $_.Reason -match $pattern -or
        $_.Policy -match $pattern -or $_.Client -match $pattern -or $_.Identity -match $pattern
    })
}
 
function Update-Pane {
    param($Pane, $Cols, $Rows, $SortIdx, $SortAsc)
 
    # Not '$rows' -- PowerShell variable names are case-insensitive, so that name would
    # overwrite the $Rows parameter and make the unfiltered total below equal $shown.
    $key  = $Cols[$SortIdx].S
    $view = @(Get-FilteredRows -Rows $Rows | Sort-Object -Property $key -Descending:(-not $SortAsc))
 
    $lv = $Pane.List
    $lv.BeginUpdate()
    $lv.Items.Clear()
    foreach ($r in $view) {
        $item = New-Object System.Windows.Forms.ListViewItem([string]$r.($Cols[0].P))
        for ($i = 1; $i -lt $Cols.Count; $i++) {
            [void]$item.SubItems.Add([string]$r.($Cols[$i].P))
        }
        $item.Tag = $r
        [void]$lv.Items.Add($item)
    }
    $lv.EndUpdate()
 
    $total = @($Rows).Count
    $shown = $view.Count
    $Pane.Label.Text = if ($shown -eq $total) { "$total unique" } else { "$shown of $total unique" }
}
 
function Update-Both {
    Update-Pane -Pane $paneOk -Cols $GrantedCols -Rows $script:GrantedAll -SortIdx $script:GSortIdx -SortAsc $script:GSortAsc
    Update-Pane -Pane $paneNo -Cols $DeniedCols  -Rows $script:DeniedAll  -SortIdx $script:DSortIdx -SortAsc $script:DSortAsc
}
 
function Show-Detail {
    param($Row)
    if (-not $Row) { return }
    $d = New-Object System.Windows.Forms.Form
    $d.Text = "Latest event - $($Row.Mac)"
    $d.Size = New-Object System.Drawing.Size(720, 620)
    $d.StartPosition = 'CenterParent'
    $tb = New-Object System.Windows.Forms.TextBox
    $tb.Multiline = $true; $tb.ReadOnly = $true; $tb.ScrollBars = 'Both'
    $tb.WordWrap = $false; $tb.Dock = 'Fill'
    $tb.Font = New-Object System.Drawing.Font('Consolas', 9)
    $tb.Text = [string]$Row.Detail
    $d.Controls.Add($tb)
    [void]$d.ShowDialog($form)
    $d.Dispose()
}
 
#endregion
 
#region ------------------------------------------------------------ Query plumbing
 
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
 
$autoTimer = New-Object System.Windows.Forms.Timer
 
function Stop-Worker {
    if ($script:PS) { try { $script:PS.Dispose() } catch {} ; $script:PS = $null }
    if ($script:Runspace) { try { $script:Runspace.Close(); $script:Runspace.Dispose() } catch {} ; $script:Runspace = $null }
    $script:Handle = $null
}
 
function Start-Query {
    if ($script:Busy) { return }
 
    if ($chkCred.Checked -and -not $script:Cred) {
        $script:Cred = Get-Credential -Message 'Credentials for the remote NPS server'
        if (-not $script:Cred) { $chkCred.Checked = $false; return }
    }
    if (-not $chkCred.Checked) { $script:Cred = $null }
 
    $script:Busy = $true
    $btnRefresh.Enabled = $false
    $btnRefresh.Text = 'Working...'
    $lblStatus.Text = "Querying $($txtServer.Text) ..."
 
    $script:Runspace = [runspacefactory]::CreateRunspace()
    $script:Runspace.ApartmentState = 'STA'
    $script:Runspace.ThreadOptions = 'ReuseThread'
    $script:Runspace.Open()
 
    $script:PS = [powershell]::Create()
    $script:PS.Runspace = $script:Runspace
    [void]$script:PS.AddScript($WorkerScript.ToString())
    [void]$script:PS.AddArgument($txtServer.Text.Trim())
    [void]$script:PS.AddArgument([int]$numHours.Value)
    [void]$script:PS.AddArgument([int]$numMax.Value)
    [void]$script:PS.AddArgument([string]$cmbFmt.SelectedItem)
    [void]$script:PS.AddArgument([bool]$chkMacOnly.Checked)
    [void]$script:PS.AddArgument($script:Cred)
 
    $script:Handle = $script:PS.BeginInvoke()
    $timer.Start()
}
 
$timer.Add_Tick({
    if (-not $script:Handle -or -not $script:Handle.IsCompleted) { return }
    $timer.Stop()
 
    $res = $null
    try { $res = $script:PS.EndInvoke($script:Handle) | Select-Object -Last 1 }
    catch {
        [System.Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, 'Query failed', 'OK', 'Error') | Out-Null
    }
    Stop-Worker
 
    $script:Busy = $false
    $btnRefresh.Enabled = $true
    $btnRefresh.Text = 'Refresh'
 
    if ($null -eq $res) { $lblStatus.Text = 'Query returned nothing.'; return }
 
    if ($res.Error) {
        $lblStatus.Text = "Error: $($res.Error)"
        [System.Windows.Forms.MessageBox]::Show($form, $res.Error, 'Get-WinEvent error', 'OK', 'Error') | Out-Null
        return
    }
 
    $script:GrantedAll = @($res.Granted)
    $script:DeniedAll  = @($res.Denied)
    Update-Both
 
    $lblStatus.Text = ("{0}  |  {1} raw events in last {2}h  |  {3} granted MACs, {4} denied MACs  |  {5} non-MAC identities skipped  |  refreshed {6}" -f
        $res.Server, $res.Total, [int]$numHours.Value, $script:GrantedAll.Count, $script:DeniedAll.Count, $res.Skipped, (Get-Date).ToString('HH:mm:ss'))
})
 
$autoTimer.Add_Tick({ Start-Query })
 
#endregion
 
#region ------------------------------------------------------------ Events
 
$btnRefresh.Add_Click({ Start-Query })
$txtFilter.Add_TextChanged({ Update-Both })
$cmbFmt.Add_SelectedIndexChanged({ if (-not $script:Busy) { Start-Query } })
 
$txtServer.Add_KeyDown({ if ($_.KeyCode -eq 'Enter') { $_.SuppressKeyPress = $true; Start-Query } })
 
$chkCred.Add_CheckedChanged({ if (-not $chkCred.Checked) { $script:Cred = $null } })
 
$chkAuto.Add_CheckedChanged({
    if ($chkAuto.Checked) {
        $autoTimer.Interval = [int]$numAuto.Value * 1000
        $autoTimer.Start()
    } else { $autoTimer.Stop() }
})
$numAuto.Add_ValueChanged({ if ($chkAuto.Checked) { $autoTimer.Interval = [int]$numAuto.Value * 1000 } })
 
$paneOk.List.Add_ColumnClick({
    param($s, $e)
    if ($script:GSortIdx -eq $e.Column) { $script:GSortAsc = -not $script:GSortAsc }
    else { $script:GSortIdx = $e.Column; $script:GSortAsc = $true }
    Update-Both
})
$paneNo.List.Add_ColumnClick({
    param($s, $e)
    if ($script:DSortIdx -eq $e.Column) { $script:DSortAsc = -not $script:DSortAsc }
    else { $script:DSortIdx = $e.Column; $script:DSortAsc = $true }
    Update-Both
})
 
$paneOk.List.Add_DoubleClick({ if ($paneOk.List.SelectedItems.Count) { Show-Detail $paneOk.List.SelectedItems[0].Tag } })
$paneNo.List.Add_DoubleClick({ if ($paneNo.List.SelectedItems.Count) { Show-Detail $paneNo.List.SelectedItems[0].Tag } })
 
function Copy-Macs {
    param($ListView)
    $items = if ($ListView.SelectedItems.Count) { $ListView.SelectedItems } else { $ListView.Items }
    $macs = @($items | ForEach-Object { $_.Tag.Mac })
    if ($macs.Count) {
        [System.Windows.Forms.Clipboard]::SetText(($macs -join "`r`n"))
        $lblStatus.Text = "$($macs.Count) MAC address(es) copied to clipboard."
    }
}
 
function Export-Rows {
    param($Rows, $DefaultName)
    $view = @(Get-FilteredRows -Rows $Rows)
    if (-not $view.Count) {
        [System.Windows.Forms.MessageBox]::Show($form, 'Nothing to export.', 'Export', 'OK', 'Information') | Out-Null
        return
    }
    $dlg = New-Object System.Windows.Forms.SaveFileDialog
    $dlg.Filter = 'CSV file (*.csv)|*.csv'
    $dlg.FileName = "$DefaultName-$(Get-Date -Format 'yyyyMMdd-HHmmss').csv"
    if ($dlg.ShowDialog($form) -eq 'OK') {
        $view | Select-Object Mac, Count, FirstSeen, LastSeen, Code, Reason, Policy, Client, AuthType, Identity, EventId |
            Export-Csv -Path $dlg.FileName -NoTypeInformation -Encoding UTF8
        $lblStatus.Text = "Exported $($view.Count) row(s) to $($dlg.FileName)"
    }
}
 
$paneOk.Copy.Add_Click({ Copy-Macs $paneOk.List })
$paneNo.Copy.Add_Click({ Copy-Macs $paneNo.List })
$paneOk.Csv.Add_Click({ Export-Rows -Rows $script:GrantedAll -DefaultName 'NPS-Authenticated' })
$paneNo.Csv.Add_Click({ Export-Rows -Rows $script:DeniedAll  -DefaultName 'NPS-Denied' })
 
$form.Add_FormClosing({
    $timer.Stop(); $autoTimer.Stop()
    Stop-Worker
})
 
#endregion
 
# Elevation check
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    # The status strip is overwritten by the first query a moment later, so the warning
    # goes on the title bar where it survives every refresh.
    $form.Text = "$($form.Text)  [NOT ELEVATED - reading the Security log will likely fail]"
}
 
$form.Add_Shown({ $form.Activate(); Start-Query })
[void]$form.ShowDialog()
$form.Dispose()

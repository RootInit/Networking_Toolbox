# No '#Requires -Modules ActiveDirectory' on purpose: that aborts before the form exists, so a
# workstation without RSAT gets a bare parser error instead of Initialize-AD's message.
#Requires -Version 5.1
<#
    Register-MacDevice.ps1
    GUI tool to register MAC-based device accounts in Active Directory. Enter a single MAC, or
    select a text file of MACs (one per line). Every account is created in the Computers OU and
    added to the ComputerMACs group. Optionally overwrite (delete + recreate) existing MACs.
#>

# CONFIG - edit to match your environment (the group and OU must already exist)
$TempPassword     = ConvertTo-SecureString '$ecur3T3mpP@ssW0rd' -AsPlainText -Force
$OUPath           = 'OU=Computers,OU=Authorized_Devices,DC=627,DC=SCOI'
$GroupName        = 'ComputerMACs'
$StripOtherGroups = $true   # make ComputerMACs primary and remove all other groups

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---- colours for the log pane ----
$ColOk   = [System.Drawing.Color]::ForestGreen
$ColErr  = [System.Drawing.Color]::Firebrick
$ColSkip = [System.Drawing.Color]::Gray
$ColWarn = [System.Drawing.Color]::DarkGoldenrod
$ColInfo = [System.Drawing.Color]::Black

# session-wide running totals
$script:Tally = @{ added = 0; existed = 0; invalid = 0; error = 0 }

# Set-Busy re-enables controls on finish, so it must know which were disabled for other reasons.
$script:AdReady    = $false
$script:FileChosen = $false

function Initialize-AD {
    try {
        Import-Module ActiveDirectory -ErrorAction Stop
        $script:DC    = (Get-ADDomainController -Discover -NextClosestSite).HostName[0]
        $script:Group = Get-ADGroup $GroupName -Properties PrimaryGroupToken -Server $script:DC
        return $true
    } catch {
        $script:InitError = $_.Exception.Message
        return $false
    }
}

function New-DeviceAccount($mac) {
    $user = New-ADUser -Name $mac -SamAccountName $mac -AccountPassword $TempPassword `
                       -Enabled $true -Path $OUPath -PassThru -Server $script:DC

    Add-ADGroupMember $script:Group -Members $user -Server $script:DC
    if ($StripOtherGroups) {
        Set-ADUser $user -Replace @{ primaryGroupID = $script:Group.PrimaryGroupToken } -Server $script:DC
        $others = Get-ADPrincipalGroupMembership $user -Server $script:DC |
                  Where-Object ObjectGUID -ne $script:Group.ObjectGUID
        if ($others) { Remove-ADPrincipalGroupMembership $user -MemberOf $others -Confirm:$false -Server $script:DC }
    }

    Set-ADAccountPassword $user -Reset -Server $script:DC `
        -NewPassword (ConvertTo-SecureString $mac -AsPlainText -Force)
}

# Returns one status string: 'added' | 'existed' | 'invalid' | 'error'
function Register-Mac($rawMac, $overwrite) {
    $mac = ($rawMac -replace '[:\-\.\s]').ToLower()
    if ($mac -notmatch '^[0-9a-f]{12}$') {
        Write-Log "  SKIP  '$rawMac' is not a valid 12 hex-digit MAC" $ColWarn
        return 'invalid'
    }
    try {
        if (Get-ADUser -Filter "SamAccountName -eq '$mac'" -Server $script:DC -ErrorAction SilentlyContinue) {
            if (-not $overwrite) {
                Write-Log "  SKIP  '$mac' already exists (overwrite off)" $ColSkip
                return 'existed'
            }
            Remove-ADUser $mac -Confirm:$false -Server $script:DC
            New-DeviceAccount $mac
            Write-Log "  OK    '$mac' overwritten -> $GroupName" $ColOk
            return 'added'
        }
        New-DeviceAccount $mac
        Write-Log "  OK    '$mac' -> $GroupName" $ColOk
        return 'added'
    } catch {
        Write-Log "  ERROR '$mac': $($_.Exception.Message)" $ColErr
        return 'error'
    }
}

# "24 added, 2 already existed, 1 error"  (omits zero buckets except 'added')
function Format-Tally($t) {
    $parts = @("$($t.added) added")
    if ($t.existed) { $parts += "$($t.existed) already existed" }
    if ($t.invalid) { $parts += "$($t.invalid) invalid" }
    if ($t.error)   { $parts += "$($t.error) error"   + $(if ($t.error   -ne 1) { 's' }) }
    $parts -join ', '
}

$form               = New-Object System.Windows.Forms.Form
$form.Text          = "RADIUS Device Registration  -  $GroupName"
$form.ClientSize    = New-Object System.Drawing.Size(560, 480)
$form.StartPosition = 'CenterScreen'
$form.MinimumSize   = New-Object System.Drawing.Size(500, 420)
$form.Font          = New-Object System.Drawing.Font('Segoe UI', 9)

# --- single MAC entry ---
$lblMac = New-Object System.Windows.Forms.Label
$lblMac.Text = 'Single MAC address:'; $lblMac.AutoSize = $true
$lblMac.Location = New-Object System.Drawing.Point(15, 15)
$form.Controls.Add($lblMac)

$txtMac = New-Object System.Windows.Forms.TextBox
$txtMac.Location = New-Object System.Drawing.Point(15, 35)
$txtMac.Size     = New-Object System.Drawing.Size(410, 25)
$txtMac.Anchor   = 'Top,Left,Right'
$form.Controls.Add($txtMac)

$btnAdd = New-Object System.Windows.Forms.Button
$btnAdd.Text = 'Add'
$btnAdd.Location = New-Object System.Drawing.Point(435, 34); $btnAdd.Size = New-Object System.Drawing.Size(110, 26)
$btnAdd.Anchor = 'Top,Right'
$form.Controls.Add($btnAdd)

# --- "or" divider ---
$lblOr = New-Object System.Windows.Forms.Label
$lblOr.Text = 'or select a file of MACs (one per line):'; $lblOr.AutoSize = $true
$lblOr.Location = New-Object System.Drawing.Point(15, 72)
$form.Controls.Add($lblOr)

# --- file picker ---
$txtFile = New-Object System.Windows.Forms.TextBox
$txtFile.Location = New-Object System.Drawing.Point(15, 95); $txtFile.Size = New-Object System.Drawing.Size(310, 25)
$txtFile.ReadOnly = $true; $txtFile.Anchor = 'Top,Left,Right'
$form.Controls.Add($txtFile)

$btnBrowse = New-Object System.Windows.Forms.Button
$btnBrowse.Text = 'Browse...'
$btnBrowse.Location = New-Object System.Drawing.Point(335, 94); $btnBrowse.Size = New-Object System.Drawing.Size(95, 26)
$btnBrowse.Anchor = 'Top,Right'
$form.Controls.Add($btnBrowse)

$btnFile = New-Object System.Windows.Forms.Button
$btnFile.Text = 'Process File'
$btnFile.Location = New-Object System.Drawing.Point(435, 94); $btnFile.Size = New-Object System.Drawing.Size(110, 26)
$btnFile.Anchor = 'Top,Right'; $btnFile.Enabled = $false
$form.Controls.Add($btnFile)

# --- overwrite toggle ---
$chkOverwrite = New-Object System.Windows.Forms.CheckBox
$chkOverwrite.Text = 'Overwrite existing accounts (delete and recreate)'; $chkOverwrite.AutoSize = $true
$chkOverwrite.Location = New-Object System.Drawing.Point(15, 130)
$form.Controls.Add($chkOverwrite)

# --- log label + clear ---
$lblLog = New-Object System.Windows.Forms.Label
$lblLog.Text = 'Log:'; $lblLog.AutoSize = $true
$lblLog.Location = New-Object System.Drawing.Point(15, 160)
$form.Controls.Add($lblLog)

$btnClear = New-Object System.Windows.Forms.Button
$btnClear.Text = 'Clear'
$btnClear.Location = New-Object System.Drawing.Point(470, 155); $btnClear.Size = New-Object System.Drawing.Size(75, 24)
$btnClear.Anchor = 'Top,Right'
$form.Controls.Add($btnClear)

# --- log pane ---
$log = New-Object System.Windows.Forms.RichTextBox
$log.Location = New-Object System.Drawing.Point(15, 182)
$log.Size = New-Object System.Drawing.Size(530, 258)
$log.ReadOnly = $true; $log.Anchor = 'Top,Bottom,Left,Right'
$log.Font = New-Object System.Drawing.Font('Consolas', 9)
$form.Controls.Add($log)

# --- status bar (session totals) ---
$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Location = New-Object System.Drawing.Point(15, 448)
$statusLabel.Size = New-Object System.Drawing.Size(530, 22)
$statusLabel.Anchor = 'Bottom,Left,Right'
$statusLabel.BorderStyle = 'FixedSingle'
$statusLabel.TextAlign = 'MiddleLeft'
$statusLabel.Padding = New-Object System.Windows.Forms.Padding(6, 0, 0, 0)
$statusLabel.Text = 'Session: ready'
$form.Controls.Add($statusLabel)

function Write-Log($text, $color) {
    if (-not $color) { $color = $ColInfo }
    $log.SelectionStart = $log.TextLength
    $log.SelectionColor = $color
    $log.AppendText($text + "`r`n")
    $log.SelectionColor = $ColInfo
    $log.ScrollToCaret()
    [System.Windows.Forms.Application]::DoEvents()
}

function Update-Status {
    $statusLabel.Text = "Session:  " + (Format-Tally $script:Tally)
}

function Set-Busy($busy) {
    $form.Cursor = if ($busy) { 'WaitCursor' } else { 'Default' }
    $btnClear.Enabled  = -not $busy
    $txtMac.Enabled    = (-not $busy) -and $script:AdReady
    $btnAdd.Enabled    = (-not $busy) -and $script:AdReady
    $btnBrowse.Enabled = (-not $busy) -and $script:AdReady
    $btnFile.Enabled   = (-not $busy) -and $script:AdReady -and $script:FileChosen
    [System.Windows.Forms.Application]::DoEvents()
}

$btnAdd.Add_Click({
    $val = $txtMac.Text.Trim()
    if (-not $val) { Write-Log '  (enter a MAC address first)' $ColWarn; return }
    Set-Busy $true
    $status = Register-Mac $val $chkOverwrite.Checked
    $script:Tally[$status]++
    Update-Status
    Set-Busy $false
    $txtMac.Clear(); $txtMac.Focus()
})

# Enter key in the MAC box = Add
$txtMac.Add_KeyDown({
    if ($_.KeyCode -eq 'Enter') { $_.SuppressKeyPress = $true; $btnAdd.PerformClick() }
})

$btnBrowse.Add_Click({
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Filter = 'Text files (*.txt)|*.txt|All files (*.*)|*.*'
    if ($dlg.ShowDialog() -eq 'OK') {
        $txtFile.Text      = $dlg.FileName
        $script:FileChosen = $true
        $btnFile.Enabled   = $true
    }
})

$btnFile.Add_Click({
    $path = $txtFile.Text
    if (-not (Test-Path $path)) { Write-Log "  ERROR file not found: $path" $ColErr; return }
    $lines = Get-Content $path | Where-Object { $_.Trim() }
    Write-Log "--- Processing $($lines.Count) entries from $([System.IO.Path]::GetFileName($path)) ---" $ColInfo
    Set-Busy $true

    $batch = @{ added = 0; existed = 0; invalid = 0; error = 0 }
    foreach ($line in $lines) {
        $s = Register-Mac $line $chkOverwrite.Checked
        $batch[$s]++
        $script:Tally[$s]++
        Update-Status
    }

    Set-Busy $false
    $summary = Format-Tally $batch
    $col = if ($batch.error) { $ColErr } elseif ($batch.existed -or $batch.invalid) { $ColWarn } else { $ColOk }
    Write-Log "--- Results: $summary ---" $col
    Update-Status

    $icon = if ($batch.error) { [System.Windows.Forms.MessageBoxIcon]::Warning }
            else { [System.Windows.Forms.MessageBoxIcon]::Information }
    [System.Windows.Forms.MessageBox]::Show($summary, 'Results',
        [System.Windows.Forms.MessageBoxButtons]::OK, $icon) | Out-Null
})

$btnClear.Add_Click({ $log.Clear() })

$form.Add_Shown({
    $txtMac.Focus()
    if (Initialize-AD) {
        $script:AdReady = $true
        Write-Log "Connected to $script:DC. Target group: $GroupName" $ColInfo
        Update-Status
    } else {
        Write-Log "Could not initialize Active Directory:" $ColErr
        Write-Log "  $script:InitError" $ColErr
        Write-Log "Run on an admin workstation with RSAT installed, elevated." $ColWarn
        $statusLabel.Text = 'Session: AD not available'
    }
    Set-Busy $false
})

[void]$form.ShowDialog()
$form.Dispose()

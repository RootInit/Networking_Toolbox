<#
    .SYNOPSIS
    Asynchronous IPv4 network scanner.

    .DESCRIPTION
    Scans an arbitrary IPv4 range (172.16.1.47 to 172.16.2.5) or a whole subnet given as an
    address plus mask/CIDR. Output carries IPv4-Address, Status and Hostname by default; the
    remaining columns are opt-in via parameter.

    .EXAMPLE
    .\Ipv4Scan.ps1 -StartIPv4Address 192.168.178.0 -EndIPv4Address 192.168.178.20

    .EXAMPLE
    .\Ipv4Scan.ps1 -IPv4Address 192.168.178.0 -Mask 255.255.255.0 -DisableDNSResolving

    .EXAMPLE
    .\Ipv4Scan.ps1 -IPv4Address 192.168.178.0 -CIDR 25 -EnableMACResolving

    .LINK
    https://github.com/BornToBeRoot/PowerShell_IPv4NetworkScanner/blob/master/README.md
#>

[CmdletBinding(DefaultParameterSetName = 'CIDR')]
param(
[Parameter(
    ParameterSetName = 'Range',
    Position = 0,
    Mandatory = $true,
    HelpMessage = 'Start IPv4-Address like 192.168.1.10')]
[IPAddress]$StartIPv4Address,

[Parameter(
    ParameterSetName = 'Range',
    Position = 1,
    Mandatory = $true,
    HelpMessage = 'End IPv4-Address like 192.168.1.100')]
[IPAddress]$EndIPv4Address,

[Parameter(
    ParameterSetName = 'CIDR',
    Position = 0,
    Mandatory = $true,
    HelpMessage = 'IPv4-Address which is in the subnet')]
[Parameter(
    ParameterSetName = 'Mask',
    Position = 0,
    Mandatory = $true,
    HelpMessage = 'IPv4-Address which is in the subnet')]
[IPAddress]$IPv4Address,

[Parameter(
    ParameterSetName = 'CIDR',
    Position = 1,
    Mandatory = $true,
    HelpMessage = 'CIDR like /24 without "/"')]
[ValidateRange(0,31)]
[Int32]$CIDR,

[Parameter(
    ParameterSetName = 'Mask',
    Position = 1,
    Mandatory = $true,
    HelpMessage = 'Subnetmask like 255.255.255.0')]
[ValidateScript({
    if ($_ -match "^(254|252|248|240|224|192|128).0.0.0$|^255.(254|252|248|240|224|192|128|0).0.0$|^255.255.(254|252|248|240|224|192|128|0).0$|^255.255.255.(254|252|248|240|224|192|128|0)$") {
        $true
    }
    else {
        throw "Enter a valid subnetmask (like 255.255.255.0)!"
    }
})]
[String]$Mask,

[Parameter(
    HelpMessage = 'TCP port to test. Use 0 for ICMP ping (Default=0)')]
[ValidateRange(0,65535)]
[Int32]$Port = 0,

[Parameter(
    HelpMessage = 'Maximum number of ICMP/TCP checks for each IPv4-Address (Default=2)')]
[Int32]$Tries = 2,

[Parameter(
    HelpMessage = 'Maximum number of threads at the same time (Default=256)')]
[Int32]$Threads = 256,

[Parameter(
    HelpMessage = 'Resolve DNS for each IP (Default=Enabled)')]
[Switch]$DisableDNSResolving,

[Parameter(
    HelpMessage = 'Resolve MAC-Address for each IP (Default=Disabled)')]
[Switch]$EnableMACResolving,

[Parameter(
    HelpMessage = 'Get extended informations like BufferSize, ResponseTime and TTL (Default=Disabled)')]
[Switch]$ExtendedInformations,

[Parameter(
    HelpMessage = 'Include inactive devices in result')]
[Switch]$IncludeInactive
)

Begin {
    Write-Verbose -Message "Script started at $(Get-Date)"
    
    $OUIListPath = "$PSScriptRoot\oui.txt"

    function Convert-Subnetmask {
        [CmdLetBinding(DefaultParameterSetName = 'CIDR')]
        param( 
            [Parameter( 
                ParameterSetName = 'CIDR',       
                Position = 0,
                Mandatory = $true,
                HelpMessage = 'CIDR like /24 without "/"')]
            [ValidateRange(0, 32)]
            [Int32]$CIDR,

            [Parameter(
                ParameterSetName = 'Mask',
                Position = 0,
                Mandatory = $true,
                HelpMessage = 'Subnetmask like 255.255.255.0')]
            [ValidateScript({
                    if ($_ -match "^(254|252|248|240|224|192|128).0.0.0$|^255.(254|252|248|240|224|192|128|0).0.0$|^255.255.(254|252|248|240|224|192|128|0).0$|^255.255.255.(255|254|252|248|240|224|192|128|0)$") {
                        return $true
                    }
                    else {
                        throw "Enter a valid subnetmask (like 255.255.255.0)!"    
                    }
                })]
            [String]$Mask
        )

        Begin {

        }

        Process {
            switch ($PSCmdlet.ParameterSetName) {
                "CIDR" {                          
                    $CIDR_Bits = ('1' * $CIDR).PadRight(32, "0")
                    
                    $Octets = $CIDR_Bits -split '(.{8})' -ne ''
                    $Mask = ($Octets | ForEach-Object -Process { [Convert]::ToInt32($_, 2) }) -join '.'
                }

                "Mask" {
                    $Octets = $Mask.ToString().Split(".") | ForEach-Object -Process { [Convert]::ToString($_, 2) }
                    $CIDR_Bits = ($Octets -join "").TrimEnd("0")

                    $CIDR = $CIDR_Bits.Length             
                }               
            }

            [pscustomobject] @{
                Mask = $Mask
                CIDR = $CIDR
            }
        }

        End {
            
        }
    }

    function Convert-IPv4Address {
        [CmdletBinding(DefaultParameterSetName = 'IPv4Address')]
        param(
            [Parameter(
                ParameterSetName = 'IPv4Address',
                Position = 0,
                Mandatory = $true,
                HelpMessage = 'IPv4-Address as string like "192.168.1.1"')]
            [IPaddress]$IPv4Address,

            [Parameter(
                ParameterSetName = 'Int64',
                Position = 0,
                Mandatory = $true,
                HelpMessage = 'IPv4-Address as Int64 like 2886755428')]
            [long]$Int64
        ) 

        Begin {

        }

        Process {
            switch ($PSCmdlet.ParameterSetName) {
                "IPv4Address" {
                    $Octets = $IPv4Address.ToString().Split(".") 
                    $Int64 = [long]([long]$Octets[0] * 16777216 + [long]$Octets[1] * 65536 + [long]$Octets[2] * 256 + [long]$Octets[3]) 
                }
        
                "Int64" {            
                    $IPv4Address = (([System.Math]::Truncate($Int64 / 16777216)).ToString() + "." + ([System.Math]::Truncate(($Int64 % 16777216) / 65536)).ToString() + "." + ([System.Math]::Truncate(($Int64 % 65536) / 256)).ToString() + "." + ([System.Math]::Truncate($Int64 % 256)).ToString())
                }      
            }

            [pscustomobject] @{   
                IPv4Address = $IPv4Address
                Int64       = $Int64
            }
        }

        End {

        }
    }

    function Get-IPv4Subnet {
        [CmdletBinding(DefaultParameterSetName = 'CIDR')]
        param(
            [Parameter(
                Position = 0,
                Mandatory = $true,
                HelpMessage = 'IPv4-Address which is in the subnet')]
            [IPAddress]$IPv4Address,

            [Parameter(
                ParameterSetName = 'CIDR',
                Position = 1,
                Mandatory = $true,
                HelpMessage = 'CIDR like /24 without "/"')]
            [ValidateRange(0, 31)]
            [Int32]$CIDR,

            [Parameter(
                ParameterSetName = 'Mask',
                Position = 1,
                Mandatory = $true,
                Helpmessage = 'Subnetmask like 255.255.255.0')]
            [ValidateScript({
                    if ($_ -match "^(254|252|248|240|224|192|128).0.0.0$|^255.(254|252|248|240|224|192|128|0).0.0$|^255.255.(254|252|248|240|224|192|128|0).0$|^255.255.255.(254|252|248|240|224|192|128|0)$") {
                        return $true
                    }
                    else {
                        throw "Enter a valid subnetmask (like 255.255.255.0)!"    
                    }
                })]
            [String]$Mask
        )

        Begin {
        
        }

        Process {
            switch ($PSCmdlet.ParameterSetName) {
                "CIDR" {                          
                    $Mask = (Convert-Subnetmask -CIDR $CIDR).Mask            
                }
                "Mask" {
                    $CIDR = (Convert-Subnetmask -Mask $Mask).CIDR          
                }                  
            }
            
            $CIDRAddress = [System.Net.IPAddress]::Parse([System.Convert]::ToUInt64(("1" * $CIDR).PadRight(32, "0"), 2))
        
            $NetworkID_bAND = $IPv4Address.Address -band $CIDRAddress.Address

            $NetworkID = [System.Net.IPAddress]::Parse([System.BitConverter]::GetBytes([UInt32]$NetworkID_bAND) -join ("."))
            
            $HostBits = ('1' * (32 - $CIDR)).PadLeft(32, "0")
            
            $AvailableIPs = [Convert]::ToInt64($HostBits, 2)

            $NetworkID_Int64 = (Convert-IPv4Address -IPv4Address $NetworkID.ToString()).Int64

            $Broadcast = [System.Net.IPAddress]::Parse((Convert-IPv4Address -Int64 ($NetworkID_Int64 + $AvailableIPs)).IPv4Address)
            
            $AvailableIPs += 1

            # Hosts = AvailableIPs - Network Address + Broadcast Address
            $Hosts = ($AvailableIPs - 2)
                
            [pscustomobject] @{
                NetworkID = $NetworkID
                Broadcast = $Broadcast
                IPs       = $AvailableIPs
           	    Hosts     = $Hosts
            }
        }

        End {

        }
    }     
}

Process {
    if ($PSCmdlet.ParameterSetName -eq 'CIDR' -or $PSCmdlet.ParameterSetName -eq 'Mask') {
        if ($PSCmdlet.ParameterSetName -eq 'Mask') {
            $CIDR = (Convert-Subnetmask -Mask $Mask).CIDR     
        }

        $Subnet = Get-IPv4Subnet -IPv4Address $IPv4Address -CIDR $CIDR

        $StartIPv4Address = $Subnet.NetworkID
        $EndIPv4Address = $Subnet.Broadcast
    }

    $StartIPv4Address_Int64 = (Convert-IPv4Address -IPv4Address $StartIPv4Address.ToString()).Int64
    $EndIPv4Address_Int64 = (Convert-IPv4Address -IPv4Address $EndIPv4Address.ToString()).Int64

    if ($StartIPv4Address_Int64 -gt $EndIPv4Address_Int64) {
        Write-Error -Message "Invalid IP-Range... Check your input!" -Category InvalidArgument -ErrorAction Stop
    }

    $IPsToScan = ($EndIPv4Address_Int64 - $StartIPv4Address_Int64)
    
    Write-Verbose -Message "Scanning range from $StartIPv4Address to $EndIPv4Address ($($IPsToScan + 1) IPs)"
    Write-Verbose -Message "Running with max $Threads threads"
    Write-Verbose -Message "ICMP checks per IP: $Tries"

    $PropertiesToDisplay = @()
    $PropertiesToDisplay += "IPv4Address", "Status"

    if ($DisableDNSResolving -eq $false) {
        $PropertiesToDisplay += "Hostname"
    }

    if ($EnableMACResolving) {
        $PropertiesToDisplay += "MAC"
    }

    if ($EnableMACResolving) {
        if (Test-Path -Path $OUIListPath -PathType Leaf) {
            $OUIHashTable = @{ }

            Write-Verbose -Message "Read oui.txt and fill hash table..."

            foreach ($Line in Get-Content -Path $OUIListPath -Encoding UTF8) {
                if (-not([String]::IsNullOrEmpty($Line))) {
                    $HashTableData = $Line.Split('|')
                    if ($HashTableData.Count -lt 2 -or [String]::IsNullOrEmpty($HashTableData[0])) {
                        continue # Malformed line (e.g. missing '|' separator) - skip rather than insert a null vendor
                    }
                    try {
                        $OUIHashTable.Add($HashTableData[0], $HashTableData[1])
                    }
                    catch [System.ArgumentException] { } # Catch if mac is already added to hash table
                }
            }

            $AssignVendorToMAC = $true

            $PropertiesToDisplay += "Vendor"
        }
        else {
            $AssignVendorToMAC = $false

            Write-Warning -Message "No OUI-File to assign vendor with MAC-Address found! Execute the script ""Create-OUIListFromWeb.ps1"" to download the latest version. This warning does not affect the scanning procedure."
        }
    }  
    
    if ($ExtendedInformations) {
        $PropertiesToDisplay += "BufferSize", "ResponseTime", "TTL"
    }

    [System.Management.Automation.ScriptBlock]$ScriptBlock = {
        Param(
            $IPv4Address,
            $Port,
            $Tries,
            $DisableDNSResolving,
            $EnableMACResolving,
            $ExtendedInformations,
            $IncludeInactive
        )
        $Status = [String]::Empty

for ($i = 0; $i -lt $Tries; $i++) {
    try {
        $Timeout = 1000
        if ($Port -eq 0) {
                $PingObj = New-Object System.Net.NetworkInformation.Ping
                $Buffer = New-Object Byte[] 32
                $Result = $PingObj.Send($IPv4Address, $Timeout, $Buffer)

            if ($Result.Status -eq "Success") {
                    $Status = "Up"
                    break # Exit loop, if host is reachable
                }
                else {
                    $Status = "Down"
                }
        }
        else {
            $Client = New-Object System.Net.Sockets.TcpClient

            $Connect = $Client.BeginConnect($IPv4Address, $Port, $null, $null)

            if ($Connect.AsyncWaitHandle.WaitOne($Timeout, $false)) {
                 $Client.EndConnect($Connect)
                $Client.Close()
                $Status = "Up"
                break
            }
            else {
                $Client.Close()
                $Status = "Down"
            }
        }
    }
    catch {
        Write-Host "error $($_.Exception.Message)"
        $Status = "Down"
    }
}
             
        $Hostname = [String]::Empty     

        if ((-not($DisableDNSResolving)) -and ($Status -eq "Up" -or $IncludeInactive)) {   	
            try { 
                $Hostname = ([System.Net.Dns]::GetHostEntry($IPv4Address).HostName)
            } 
            catch { } # No DNS      
        }
     
        $MAC = [String]::Empty 

        if (($EnableMACResolving) -and (($Status -eq "Up") -or ($IncludeInactive))) {
            try {
                $Arp_Result = (arp -a).ToUpper().Trim()

                foreach ($Line in $Arp_Result) {
                    if ($Line.Split(" ")[0] -eq $IPv4Address) {
                        $MAC = [Regex]::Matches($Line, "([0-9A-F][0-9A-F]-){5}([0-9A-F][0-9A-F])").Value
                    }
                }
            }
            catch {
                Write-Warning -Message "MAC resolution via 'arp -a' failed for $($IPv4Address): $($_.Exception.Message)"
            } # arp.exe unavailable/failed - leave MAC empty
        }

        $BufferSize = [String]::Empty 
        $ResponseTime = [String]::Empty 
        $TTL = $null

        if ($ExtendedInformations -and ($Status -eq "Up") -and ($Port -eq 0)) {
            try {
                $BufferSize = $Result.Buffer.Length
                $ResponseTime = $Result.RoundtripTime
                $TTL = $Result.Options.Ttl
            }
            catch { } # Failed to get extended informations
        }	
	
        if (($Status -eq "Up") -or ($IncludeInactive)) {
            [pscustomobject] @{
                IPv4Address  = $IPv4Address
                Status       = $Status
                Hostname     = $Hostname
                MAC          = $MAC   
                BufferSize   = $BufferSize
                ResponseTime = $ResponseTime
                TTL          = $TTL
            }
        }
        else {
            $null
        }
    } 

    Write-Verbose -Message "Setting up RunspacePool..."

    $RunspacePool = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspacePool(1, $Threads, $Host)
    $RunspacePool.Open()
    [System.Collections.ArrayList]$Jobs = @()

    Write-Verbose -Message "Setting up jobs..."

    for ($i = $StartIPv4Address_Int64; $i -le $EndIPv4Address_Int64; $i++) { 
        $IPv4Address = (Convert-IPv4Address -Int64 $i).IPv4Address                

        $ScriptParams = @{
            IPv4Address          = $IPv4Address
            Port                 = $Port
            Tries                = $Tries
            DisableDNSResolving  = $DisableDNSResolving
            EnableMACResolving   = $EnableMACResolving
            ExtendedInformations = $ExtendedInformations
            IncludeInactive      = $IncludeInactive
        }       

        # Catch when trying to divide through zero
        try {
            $Progress_Percent = (($i - $StartIPv4Address_Int64) / $IPsToScan) * 100 
        } 
        catch { 
            $Progress_Percent = 100 
        }

        Write-Progress -Activity "Setting up jobs..." -Id 1 -Status "Current IP-Address: $IPv4Address" -PercentComplete $Progress_Percent
						 
        $Job = [System.Management.Automation.PowerShell]::Create().AddScript($ScriptBlock).AddParameters($ScriptParams)
        $Job.RunspacePool = $RunspacePool
        
        $JobObj = [pscustomobject] @{
            RunNum = $i - $StartIPv4Address_Int64
            Pipe   = $Job
            Result = $Job.BeginInvoke()
        }

        [void]$Jobs.Add($JobObj)
    }

    Write-Verbose -Message "Waiting for jobs to complete & starting to process results..."

    # Total jobs to calculate percent complete, because jobs are removed after they are processed
    $Jobs_Total = $Jobs.Count

    try {
        Do {
            $Jobs_ToProcess = $Jobs | Where-Object -FilterScript { $_.Result.IsCompleted }

            if ($null -eq $Jobs_ToProcess) {
                Write-Verbose -Message "No jobs completed, wait 250ms..."

                Start-Sleep -Milliseconds 250
                continue
            }

            $Jobs_Remaining = ($Jobs | Where-Object -FilterScript { $_.Result.IsCompleted -eq $false }).Count

            try {
                $Progress_Percent = 100 - (($Jobs_Remaining / $Jobs_Total) * 100)
            }
            catch {
                $Progress_Percent = 100
            }

            Write-Progress -Activity "Waiting for jobs to complete... ($($Threads - $($RunspacePool.GetAvailableRunspaces())) of $Threads threads running)" -Id 1 -PercentComplete $Progress_Percent -Status "$Jobs_Remaining remaining..."

            Write-Verbose -Message "Processing $(if($null -eq $Jobs_ToProcess.Count){"1"}else{$Jobs_ToProcess.Count}) job(s)..."

            foreach ($Job in $Jobs_ToProcess) {
                try {
                    $Job_Result = $Job.Pipe.EndInvoke($Job.Result)
                }
                catch {
                    Write-Warning -Message "Scan job for run #$($Job.RunNum) failed: $($_.Exception.Message)"
                    $Job_Result = $null
                }
                finally {
                    $Job.Pipe.Dispose()
                    $Jobs.Remove($Job)
                }

                if ($null -eq $Job_Result) { continue }

                if ($Job_Result.Status) {
                    if ($AssignVendorToMAC) {
                        $Vendor = [String]::Empty

                        if (-not([String]::IsNullOrEmpty($Job_Result.MAC))) {
                            # Split it, so we can search the vendor (XX-XX-XX-XX-XX-XX to XXXXXX)
                            $MAC_VendorSearch = $Job_Result.MAC.Replace("-", "").Substring(0, 6)

                            $Vendor = $OUIHashTable.Get_Item($MAC_VendorSearch)
                        }

                        [pscustomobject] @{
                            IPv4Address  = $Job_Result.IPv4Address
                            Status       = $Job_Result.Status
                            Hostname     = $Job_Result.Hostname
                            MAC          = $Job_Result.MAC
                            Vendor       = $Vendor
                            BufferSize   = $Job_Result.BufferSize
                            ResponseTime = $Job_Result.ResponseTime
                            TTL          = $Job_Result.TTL
                        } | Select-Object -Property $PropertiesToDisplay
                    }
                    else {
                        $Job_Result | Select-Object -Property $PropertiesToDisplay
                    }
                }
            }

        } While ($Jobs.Count -gt 0)
    }
    finally {
        Write-Verbose -Message "Closing RunspacePool and free resources..."

        $RunspacePool.Close()
        $RunspacePool.Dispose()
    }

    Write-Verbose -Message "Script finished at $(Get-Date)"
}

End {
    
}
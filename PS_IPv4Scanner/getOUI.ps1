#$LatestOUI = Get-Content -Path "$PSScriptRoot\oui_from_web.txt"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

$Headers = @{
    "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
}

$LatestOUIs = (Invoke-WebRequest `
    -Uri "https://standards-oui.ieee.org/oui/oui.txt" `
    -WebSession $session `
    -Headers $Headers
).Content

$Output = ""

foreach($Line in $LatestOUIs -split '[\r\n]')
{
    if($Line -match "^[A-F0-9]{6}")
    {        
        # Line looks like: 2405F5     (base 16)		Integrated Device Technology (Malaysia) Sdn. Bhd.
        $Output += ($Line -replace '\s+', ' ').Replace(' (base 16) ', '|').Trim() + "`n"
    }
}

Out-File -InputObject $Output -FilePath "$PSScriptRoot\oui.txt" -Encoding utf8
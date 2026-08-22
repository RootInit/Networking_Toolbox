# Opens a genuine interactive SSH session to a Juniper switch using the credentials in
# Auth.json - for when you just want to log in and look around, rather than run the full
# scripted crawl (Get-JunosNodeData.ps1) or wait for a topology map. A browser page still
# can't spawn a process directly (no such API exists in any mainstream browser), but in V2
# the "Launch SSH Session" button now gets there indirectly: it POSTs to the local
# Start-WebServer.ps1 server, which is itself a PowerShell process and runs this script via
# Start-Process on the browser's behalf. Kept as a real -TargetIP parameter (not something
# request-controlled beyond that already-validated IP) so this is still just as safe to
# run by hand.
#
# Uses the same SSH_ASKPASS password-injection approach as the crawler (see
# Connect-JunosSsh.ps1), but attaches ssh.exe directly to this console instead of
# redirecting its output to temp files and feeding it scripted commands - that's a
# genuinely different shape of invocation, not shared with the crawler beyond the
# askpass setup itself.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true, HelpMessage="IP address of the switch to connect to")]
    [string]$TargetIP,

    [string]$AuthFile = (Join-Path $PSScriptRoot "..\..\..\PS_NetworkMapper\Network_Mapper\Auth.json")
)

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
. (Join-Path $ScriptDir "Connect-JunosSsh.ps1")

$Auth = Get-JunosAuth -AuthFile $AuthFile
$AskPass = New-JunosAskPass -Password $Auth.Password

try {
    $SshArgs = Get-JunosSshArgs -Username $Auth.Username -TargetIP $TargetIP
    Write-Host "Connecting to $TargetIP as $($Auth.Username)..." -ForegroundColor Cyan

    # No cmd.exe wrapper and no redirection here, unlike the crawler's batch mode - stdin/
    # stdout/stderr all stay attached to this console for a real interactive session.
    $ProcInfo = New-Object System.Diagnostics.ProcessStartInfo("ssh.exe", ($SshArgs -join ' '))
    $ProcInfo.UseShellExecute = $false
    foreach ($EnvKey in $AskPass.EnvironmentVariables.Keys) { $ProcInfo.EnvironmentVariables[$EnvKey] = $AskPass.EnvironmentVariables[$EnvKey] }

    $Process = [System.Diagnostics.Process]::Start($ProcInfo)
    $Process.WaitForExit()
} finally {
    Remove-JunosAskPass -AskPassContext $AskPass
}

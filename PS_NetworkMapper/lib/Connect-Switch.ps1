# Opens a genuine interactive SSH session to a Juniper switch, using credentials handed off
# via a short-lived -CredentialFile (written by WebServer.ps1's Invoke-ConnectAction). Since
# a browser can't spawn a process directly, the "Launch SSH Session" button POSTs to
# WebServer.ps1, which runs this script via Start-Process on the browser's behalf.
#
# Uses the same SSH_ASKPASS approach as the crawler (see SshHelpers.ps1), but attaches
# ssh.exe directly to this console instead of redirecting to temp files with scripted stdin.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true, HelpMessage="IP address of the switch to connect to")]
    [string]$TargetIP,

    [Parameter(Mandatory=$true, HelpMessage="Path to a short-lived {Username, Password} JSON file written by the caller")]
    [string]$CredentialFile
)

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
. (Join-Path $ScriptDir "SshHelpers.ps1")

# Everything that touches the credential file lives inside the try, so the finally always
# runs cleanup even if e.g. New-JunosAskPass fails partway (%TEMP% full/locked), which would
# otherwise leave the plaintext credential on disk with nothing to remove it.
$AskPass = $null
try {
    # -Encoding UTF8 explicit: this always runs as Windows PowerShell 5.1 (hardcoded in
    # Invoke-ConnectAction), whose Get-Content falls back to the ANSI codepage on a BOM-less
    # file - and New-JunosCredentialFile deliberately writes without one (server side may be
    # pwsh, where "utf8" means no-BOM).
    $CredData = Get-Content $CredentialFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $Username = $CredData.Username
    $AskPass = New-JunosAskPass -Password $CredData.Password

    $SshArgs = Get-JunosSshArgs -Username $Username -TargetIP $TargetIP
    Write-Host "Connecting to $TargetIP as $Username..." -ForegroundColor Cyan

    # No cmd.exe wrapper/redirection here, unlike the crawler's batch mode - stdin/stdout/
    # stderr stay attached to this console for a real interactive session.
    $ProcInfo = New-Object System.Diagnostics.ProcessStartInfo("ssh.exe", ($SshArgs -join ' '))
    $ProcInfo.UseShellExecute = $false
    foreach ($EnvKey in $AskPass.EnvironmentVariables.Keys) { $ProcInfo.EnvironmentVariables[$EnvKey] = $AskPass.EnvironmentVariables[$EnvKey] }

    $Process = [System.Diagnostics.Process]::Start($ProcInfo)
    $Process.WaitForExit()
} finally {
    # Null-guarded: the throw may have happened before New-JunosAskPass ever ran.
    if ($AskPass) { Remove-JunosAskPass -AskPassContext $AskPass }
    Remove-JunosCredentialFile -CredentialFile $CredentialFile
}

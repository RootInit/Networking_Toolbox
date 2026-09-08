# Opens an interactive SSH session to a Juniper switch, using credentials handed off via a
# short-lived -CredentialFile. The browser's "Launch SSH Session" button POSTs to
# WebServer.ps1, which runs this script via Start-Process on its behalf.
#
# Same SSH_ASKPASS approach as the crawler (see SshHelpers.ps1), but ssh.exe attaches directly
# to this console instead of redirecting to temp files with scripted stdin.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true, HelpMessage="IP address of the switch to connect to")]
    [string]$TargetIP,

    [Parameter(Mandatory=$true, HelpMessage="Path to a short-lived {Username, Password} JSON file written by the caller")]
    [string]$CredentialFile
)

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
. (Join-Path $ScriptDir "SshHelpers.ps1")

# Sweep plaintext credential/askpass files a prior crashed run left in %TEMP%.
Clear-StaleJunosTempFiles

# Everything touching the credential file lives inside the try, so a partway failure (e.g.
# %TEMP% full) still reaches the finally rather than leaving the plaintext credential on disk.
$AskPass = $null
try {
    # -Encoding UTF8 explicit: this always runs as Windows PowerShell 5.1, whose Get-Content
    # falls back to the ANSI codepage on the BOM-less file New-JunosCredentialFile writes.
    $CredData = Get-Content $CredentialFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $Username = $CredData.Username
    $AskPass = New-JunosAskPass -Password $CredData.Password

    $SshArgs = Get-JunosSshArgs -Username $Username -TargetIP $TargetIP
    Write-Host "Connecting to $TargetIP as $Username..." -ForegroundColor Cyan

    # No cmd.exe wrapper/redirection, unlike the crawler - stdin/stdout/stderr stay attached to
    # this console for a real interactive session.
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

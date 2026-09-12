# Opens an interactive SSH session to a Juniper switch, using credentials handed off via a
# short-lived -CredentialFile; WebServer.ps1 runs this via Start-Process for the browser's button.
# Same SSH_ASKPASS approach as the crawler, but ssh.exe attaches directly to this console.
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

# Everything touching the credential file is inside the try, so a partway failure still reaches the
# finally rather than leaving plaintext on disk.
$AskPass = $null
try {
    # -Encoding UTF8 explicit: 5.1's Get-Content falls back to ANSI on the BOM-less credential file.
    $CredData = Get-Content $CredentialFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $Username = $CredData.Username
    $AskPass = New-JunosAskPass -Password $CredData.Password

    $SshArgs = Get-JunosSshArgs -Username $Username -TargetIP $TargetIP
    Write-Host "Connecting to $TargetIP as $Username..." -ForegroundColor Cyan

    # No redirection, unlike the crawler - stdio stays attached for a real interactive session.
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

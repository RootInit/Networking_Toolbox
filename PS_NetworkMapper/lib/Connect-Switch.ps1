# Opens a genuine interactive SSH session to a Juniper switch, using credentials handed off
# via a short-lived -CredentialFile (written by WebServer.ps1's Invoke-ConnectAction
# right before launching this script) - for when you just want to log in and look around,
# rather than run the full scripted crawl (Get-JunosNodeData.ps1) or wait for a topology map.
# A browser page still can't spawn a process directly (no such API exists in any mainstream
# browser), so the "Launch SSH Session" button gets there indirectly: it POSTs to
# the local WebServer.ps1 server, which is itself a PowerShell process and runs this
# script via Start-Process on the browser's behalf. Kept as a real -TargetIP parameter (not
# something request-controlled beyond that already-validated IP) so this is still just as
# safe to run by hand.
#
# Uses the same SSH_ASKPASS password-injection approach as the crawler (see
# SshHelpers.ps1), but attaches ssh.exe directly to this console instead of
# redirecting its output to temp files and feeding it scripted commands - that's a
# genuinely different shape of invocation, not shared with the crawler beyond the
# askpass setup itself.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true, HelpMessage="IP address of the switch to connect to")]
    [string]$TargetIP,

    [Parameter(Mandatory=$true, HelpMessage="Path to a short-lived {Username, Password} JSON file written by the caller")]
    [string]$CredentialFile
)

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
. (Join-Path $ScriptDir "SshHelpers.ps1")

# Everything that touches the credential file lives INSIDE the try, so the finally below
# always runs: reading it, and writing the askpass files derived from it. Done outside (as
# it was), a failure between "the credential file exists" and "the try block starts" - e.g.
# New-JunosAskPass failing because %TEMP% is full or write-locked - left the switch
# username/password sitting in plaintext at %TEMP% with nothing left to clean it up.
$AskPass = $null
try {
    # -Encoding UTF8 explicit, not the default: this always runs as Windows PowerShell 5.1
    # (hardcoded "powershell.exe" in Invoke-ConnectAction), whose Get-Content falls back to
    # the system ANSI code page when the file has no BOM - and New-JunosCredentialFile
    # (SshHelpers.ps1) deliberately writes without one, since the SERVER side may be
    # running under pwsh instead, where "utf8" means no-BOM. Forcing UTF8 here decodes
    # correctly either way, regardless of which runtime wrote the file or whether a
    # username/password contains a non-ASCII character.
    $CredData = Get-Content $CredentialFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $Username = $CredData.Username
    $AskPass = New-JunosAskPass -Password $CredData.Password

    $SshArgs = Get-JunosSshArgs -Username $Username -TargetIP $TargetIP
    Write-Host "Connecting to $TargetIP as $Username..." -ForegroundColor Cyan

    # No cmd.exe wrapper and no redirection here, unlike the crawler's batch mode - stdin/
    # stdout/stderr all stay attached to this console for a real interactive session.
    $ProcInfo = New-Object System.Diagnostics.ProcessStartInfo("ssh.exe", ($SshArgs -join ' '))
    $ProcInfo.UseShellExecute = $false
    foreach ($EnvKey in $AskPass.EnvironmentVariables.Keys) { $ProcInfo.EnvironmentVariables[$EnvKey] = $AskPass.EnvironmentVariables[$EnvKey] }

    $Process = [System.Diagnostics.Process]::Start($ProcInfo)
    $Process.WaitForExit()
} finally {
    # Null-guarded: the throw may have happened before New-JunosAskPass ever ran, and
    # Remove-JunosAskPass dereferences .AskPassPath/.AskPassText on its argument. Both
    # Remove-* helpers use -ErrorAction SilentlyContinue internally, so a file that was
    # never created (or already gone) is not an error here.
    if ($AskPass) { Remove-JunosAskPass -AskPassContext $AskPass }
    Remove-JunosCredentialFile -CredentialFile $CredentialFile
}

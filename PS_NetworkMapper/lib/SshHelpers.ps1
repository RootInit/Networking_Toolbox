# Shared SSH/askpass helper, dot-sourced by Get-JunosNodeData.ps1 (scripted batch mode) and
# Connect-Switch.ps1 (interactive quick-connect). Only askpass plumbing and credential
# loading are shared - the actual ssh.exe invocation stays separate per script since batch
# mode redirects stdout/stderr to temp files while interactive mode needs a directly
# attached console.
#
# Not meant to be run directly - dot-source it: `. (Join-Path $PSScriptRoot "SshHelpers.ps1")`

# Writes {Username, Password} to a short-lived %TEMP% file for handoff to Connect-Switch.ps1,
# which runs as a separate OS process via Start-Process (unlike Get-JunosNodeData.ps1, which
# runs in-process via a runspace and gets credentials directly through .AddParameter, never
# touching a file). Caller passes only the returned path to Start-Process; the reader
# (Connect-Switch.ps1) must call Remove-JunosCredentialFile once done, in a finally block.
function New-JunosCredentialFile {
    param([Parameter(Mandatory=$true)][string]$Username, [Parameter(Mandatory=$true)][string]$Password)
    $CredPath = Join-Path $env:TEMP "junos_cred_$($PID)_$([guid]::NewGuid().Guid.Substring(0,8)).json"
    $Json = @{ Username = $Username; Password = $Password } | ConvertTo-Json -Compress
    # WriteAllText, not Out-File -Encoding utf8: "utf8" means BOM in Windows PowerShell 5.1
    # but no-BOM in pwsh Core, while the reader (Connect-Switch.ps1) is always hardcoded
    # powershell.exe (5.1). A BOM-less file would hit its Get-Content ANSI-codepage fallback
    # and corrupt non-ASCII credentials. WriteAllText is UTF-8-without-BOM on both runtimes.
    [System.IO.File]::WriteAllText($CredPath, $Json)
    return $CredPath
}

function Remove-JunosCredentialFile {
    param([Parameter(Mandatory=$true)][string]$CredentialFile)
    Remove-Item -Path $CredentialFile -Force -ErrorAction SilentlyContinue
}

# Writes the plaintext-password askpass temp files SSH_ASKPASS needs, and returns their
# paths plus the env vars ssh.exe requires. Caller must call Remove-JunosAskPass in a
# finally block - these files hold the real switch password in plaintext while they exist.
function New-JunosAskPass {
    param([Parameter(Mandatory=$true)][string]$Password)
    $AskPassPath = Join-Path $env:TEMP "ssh_askpass_$($PID)_$([guid]::NewGuid().Guid.Substring(0,8)).bat"
    $AskPassText = Join-Path $env:TEMP "ssh_pass_$($PID)_$([guid]::NewGuid().Guid.Substring(0,8)).txt"
    [System.IO.File]::WriteAllText($AskPassText, $Password)
    [System.IO.File]::WriteAllText($AskPassPath, "@type `"$AskPassText`"")
    return [PSCustomObject]@{
        AskPassPath          = $AskPassPath
        AskPassText          = $AskPassText
        EnvironmentVariables = @{ DISPLAY = "dummy:0"; SSH_ASKPASS = $AskPassPath; SSH_ASKPASS_REQUIRE = "force" }
    }
}

function Remove-JunosAskPass {
    param([Parameter(Mandatory=$true)]$AskPassContext)
    Remove-Item -Path $AskPassContext.AskPassPath, $AskPassContext.AskPassText -Force -ErrorAction SilentlyContinue
}

# Standard SSH client options used everywhere in this repo for talking to Junos switches:
# short connect timeout, no host-key prompt/storage (these are internal, frequently
# reimaged switches), and password-only auth so SSH_ASKPASS is what actually gets used
# instead of falling back to an interactively-prompted key passphrase.
function Get-JunosSshArgs {
    param([Parameter(Mandatory=$true)][string]$Username, [Parameter(Mandatory=$true)][string]$TargetIP)
    return @("-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=NUL", "-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no", "$Username@$TargetIP")
}

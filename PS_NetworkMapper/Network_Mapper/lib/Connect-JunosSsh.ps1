# Shared SSH/askpass helper, dot-sourced by both Get-JunosNodeData.ps1 (scripted
# command-batch mode) and Connect-Switch.ps1 (interactive quick-connect mode). Only the
# askpass password-injection plumbing and credential loading are shared - the actual
# ssh.exe invocation stays separate per script, since batch mode needs stdout/stderr
# redirected to temp files with scripted stdin commands while interactive mode needs a
# directly-attached console with neither. Forcing those into one shared function would
# hide, not remove, the real difference between the two.
#
# Not meant to be run directly - dot-source it: `. (Join-Path $PSScriptRoot "Connect-JunosSsh.ps1")`

function Get-JunosAuth {
    param([string]$AuthFile = ".\Auth.json")
    if (-not (Test-Path $AuthFile)) { throw "Auth file missing at $AuthFile! Copy lib\Auth.example.json to Auth.json (in this directory) and fill in real credentials." }
    $AuthData = Get-Content $AuthFile -Raw | ConvertFrom-Json
    return @{ Username = $AuthData.Username; Password = $AuthData.Password }
}

# Writes the plaintext-password askpass temp files SSH_ASKPASS needs and returns their
# paths plus the exact three environment variables ssh.exe requires to use them. The
# caller is responsible for calling Remove-JunosAskPass in a finally block once done -
# these files hold the real switch password in plaintext for as long as they exist.
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

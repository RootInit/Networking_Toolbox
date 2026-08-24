# Shared SSH/askpass helper, dot-sourced by both Get-JunosNodeData.ps1 (scripted
# command-batch mode) and Connect-Switch.ps1 (interactive quick-connect mode). Only the
# askpass password-injection plumbing and credential loading are shared - the actual
# ssh.exe invocation stays separate per script, since batch mode needs stdout/stderr
# redirected to temp files with scripted stdin commands while interactive mode needs a
# directly-attached console with neither. Forcing those into one shared function would
# hide, not remove, the real difference between the two.
#
# Not meant to be run directly - dot-source it: `. (Join-Path $PSScriptRoot "Connect-JunosSsh.ps1")`

# Writes {Username, Password} to a short-lived %TEMP% file for handoff to Connect-Switch.ps1,
# which runs via Start-Process as a genuinely separate OS process (unlike Get-JunosNodeData.ps1,
# which runs in-process via a runspace and receives credentials directly through
# .AddParameter(...), never touching a file). Mirrors New-JunosAskPass's own "shortest
# possible plaintext-on-disk window, owned by the reader, cleaned up even on error" posture -
# not a new exposure, the same one already accepted for the SSH password itself, now also
# covering the credential handoff into that separate process. The caller passes only the
# returned path to Start-Process; the reader (Connect-Switch.ps1) is responsible for calling
# Remove-JunosCredentialFile once it has read the file, in a finally block.
function New-JunosCredentialFile {
    param([Parameter(Mandatory=$true)][string]$Username, [Parameter(Mandatory=$true)][string]$Password)
    $CredPath = Join-Path $env:TEMP "junos_cred_$($PID)_$([guid]::NewGuid().Guid.Substring(0,8)).json"
    $Json = @{ Username = $Username; Password = $Password } | ConvertTo-Json -Compress
    # [System.IO.File]::WriteAllText's 2-arg overload, not Out-File -Encoding utf8: "utf8"
    # means UTF-8-WITH-BOM in Windows PowerShell 5.1 but UTF-8-WITHOUT-BOM in PowerShell
    # Core - and the reader (Connect-Switch.ps1) is always a hardcoded powershell.exe (5.1),
    # regardless of which runtime THIS process is running under. If this server is started
    # under pwsh and a credential contains a non-ASCII character (ConvertTo-Json emits those
    # raw, not \u-escaped - confirmed directly, not assumed), a BOM-less file here would hit
    # Get-Content's ANSI-codepage fallback on the 5.1 side and silently corrupt the
    # credential. WriteAllText(path, text) is UTF-8-without-BOM on both runtimes - same
    # idiom New-JunosAskPass already uses for the password text file below, now applied
    # here too so the round trip is deterministic regardless of which runtime writes it.
    [System.IO.File]::WriteAllText($CredPath, $Json)
    return $CredPath
}

function Remove-JunosCredentialFile {
    param([Parameter(Mandatory=$true)][string]$CredentialFile)
    Remove-Item -Path $CredentialFile -Force -ErrorAction SilentlyContinue
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

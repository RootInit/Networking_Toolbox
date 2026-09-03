# Shared SSH/askpass helper, dot-sourced by Get-JunosNodeData.ps1 (scripted batch mode) and
# Connect-Switch.ps1 (interactive quick-connect). Only askpass plumbing and credential
# loading are shared - the actual ssh.exe invocation stays separate per script since batch
# mode redirects stdout/stderr to temp files while interactive mode needs a directly
# attached console.
#
# Not meant to be run directly - dot-source it: `. (Join-Path $PSScriptRoot "SshHelpers.ps1")`

# Restricts a just-written credential/askpass temp file's ACL to the current user only,
# removing any inherited access (e.g. other local accounts/Administrators group entries
# %TEMP%'s default ACL may grant), so the plaintext password these files hold is only
# readable by the identity that wrote it while it exists on disk. Best-effort/defense-in-
# depth: logs a warning on failure (e.g. non-NTFS temp) rather than blocking the SSH flow
# on an ACL-hardening step.
function Protect-JunosTempFileAcl {
    param([Parameter(Mandatory=$true)][string]$Path)
    try {
        $CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $Acl = New-Object System.Security.AccessControl.FileSecurity
        $Acl.SetAccessRuleProtection($true, $false)
        $Rule = New-Object System.Security.AccessControl.FileSystemAccessRule($CurrentUser, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
        $Acl.AddAccessRule($Rule)
        [System.IO.File]::SetAccessControl($Path, $Acl)
    } catch {
        Write-Warning "ACL hardening failed for temp file '$Path': $_"
    }
}

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
    Protect-JunosTempFileAcl -Path $CredPath
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
    try {
        [System.IO.File]::WriteAllText($AskPassText, $Password)
        Protect-JunosTempFileAcl -Path $AskPassText
        [System.IO.File]::WriteAllText($AskPassPath, "@type `"$AskPassText`"")
        Protect-JunosTempFileAcl -Path $AskPassPath
    } catch {
        # Partial-write failure: clean up whichever of the two files actually made it to disk
        # before re-throwing, so the caller (whose $AskPass stays $null since we never return)
        # has nothing left to leak - it can't call Remove-JunosAskPass without a context object.
        if (Test-Path -LiteralPath $AskPassText) {
            Remove-Item -LiteralPath $AskPassText -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $AskPassPath) {
            Remove-Item -LiteralPath $AskPassPath -Force -ErrorAction SilentlyContinue
        }
        throw
    }
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

# New-JunosCredentialFile/New-JunosAskPass write the real switch password in plaintext to
# %TEMP%; normal cleanup happens in a `finally` block that's skipped if the process is
# hard-killed (crash, task-killed, power loss), so those files can survive indefinitely. Call
# this once at the start of a new crawl/connect session to sweep up whatever a prior crashed
# run left behind. Age-gated (not "delete everything matching the pattern") so a genuinely
# concurrent crawl/connect session running on the same machine doesn't get its still-in-use
# files deleted out from under it.
function Clear-StaleJunosTempFiles {
    param([int]$MaxAgeHours = 4)
    $Cutoff = (Get-Date).AddHours(-$MaxAgeHours)
    $Patterns = @("junos_cred_*.json", "ssh_pass_*.txt", "ssh_askpass_*.bat")
    foreach ($Pattern in $Patterns) {
        try {
            Get-ChildItem -Path $env:TEMP -Filter $Pattern -File -ErrorAction SilentlyContinue |
                Where-Object { $_.LastWriteTime -lt $Cutoff } |
                Remove-Item -Force -ErrorAction SilentlyContinue
        } catch {}
    }
}

# Standard SSH client options used everywhere in this repo for talking to Junos switches:
# short connect timeout, no host-key prompt/storage (these are internal, frequently
# reimaged switches), and password-only auth so SSH_ASKPASS is what actually gets used
# instead of falling back to an interactively-prompted key passphrase.
function Get-JunosSshArgs {
    param([Parameter(Mandatory=$true)][string]$Username, [Parameter(Mandatory=$true)][string]$TargetIP)
    # Single choke point every SSH-invoking caller in this repo funnels through (CLI crawl,
    # web-triggered connect/rescan/scan-network, startup-loaded config) - validating here
    # closes the injection even for a $Username that reached this function without ever
    # passing through WebServer.ps1's save-time check (e.g. loaded straight from
    # Configuration.json/.enc at process startup). Same character class as that check.
    if ($Username -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}\z') {
        throw "Invalid Junos username: must start with a letter or digit and contain only letters, digits, '.', '_', or '-'"
    }
    # Same rationale as the $Username check above: this is the one choke point every
    # SSH-invoking caller funnels through, so validating $TargetIP here closes the gap even
    # for a caller that never ran it through a prior shape check (e.g. Start-NetworkMapper.ps1's
    # -SwitchIP CLI parameter, which reaches here via Invoke-FleetCrawl's -StartIP with no
    # validation of its own). Octet-range regex (0-255 each), not just WebServer.ps1's looser
    # `\d{1,3}` shape check, so "10.1.2.999" is rejected here too.
    $Octet = '(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
    if ($TargetIP -notmatch "^$Octet\.$Octet\.$Octet\.$Octet\z") {
        throw "Invalid Junos target IP: must be a well-formed IPv4 address (four dot-separated octets, each 0-255)"
    }
    # ServerAliveInterval/ServerAliveCountMax: without a keepalive, a session wedged on a dead
    # link (e.g. the switch stops responding mid-command) just sits there until something
    # external notices - for Get-JunosNodeData.ps1's batch mode, that's the orchestrator's 65s
    # hang timeout in FleetCrawl.ps1, which still has to abandon the job and reap the process.
    # 10s x 3 unanswered keepalives (30s) lets ssh.exe itself detect the dead session and exit
    # well before that, instead of the connection just going idle.
    return @("-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=NUL", "-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no", "$Username@$TargetIP")
}

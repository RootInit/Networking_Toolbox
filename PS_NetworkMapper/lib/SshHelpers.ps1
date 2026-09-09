# Shared SSH/askpass plumbing and credential loading, dot-sourced by Get-JunosNodeData.ps1
# (scripted batch mode) and Connect-Switch.ps1 (interactive quick-connect). The ssh.exe
# invocation itself stays separate per script: batch mode starts ssh.exe with its stdio pipes
# redirected into the worker, interactive mode needs a directly attached console.
#
# Dot-source it: `. (Join-Path $PSScriptRoot "SshHelpers.ps1")`

# Replaces a file's ACL with a single full-control ACE for the current user, dropping any
# inherited access, so plaintext secrets it holds are readable only by the writer. Touches the
# ACL only, never content, so it is also reusable on files that already hold data (FleetCrawl.ps1
# uses it for -NoEncryption snapshots). Best-effort: warns instead of throwing, so callers
# relying on it must treat hardening as possibly absent.
function Protect-JunosSensitiveFileAcl {
    param([Parameter(Mandatory=$true)][string]$Path)
    try {
        $CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $Acl = New-Object System.Security.AccessControl.FileSecurity
        $Acl.SetAccessRuleProtection($true, $false)
        $Rule = New-Object System.Security.AccessControl.FileSystemAccessRule($CurrentUser, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
        $Acl.AddAccessRule($Rule)
        [System.IO.File]::SetAccessControl($Path, $Acl)
    } catch {
        Write-Warning "ACL hardening failed for file '$Path': $_"
    }
}

# Writes {Username, Password} to a short-lived %TEMP% file for handoff to Connect-Switch.ps1,
# which runs as a separate OS process (Get-JunosNodeData.ps1 runs in-process in a runspace and
# gets credentials via .AddParameter, never touching a file). The reader must call
# Remove-JunosCredentialFile in a finally block.
function New-JunosCredentialFile {
    param([Parameter(Mandatory=$true)][string]$Username, [Parameter(Mandatory=$true)][string]$Password)
    $CredPath = Join-Path $env:TEMP "junos_cred_$($PID)_$([guid]::NewGuid().Guid.Substring(0,8)).json"
    $Json = @{ Username = $Username; Password = $Password } | ConvertTo-Json -Compress
    # OPEN QUESTION (unverifiable off Windows): whether a hardened ACL on an empty file survives
    # the later WriteAllText, or NTFS resets it to the parent's inherited default.
    try {
        # Create empty and harden the ACL BEFORE writing plaintext, so the content is never on
        # disk under %TEMP%'s broader default ACL. Only a guarantee when
        # Protect-JunosSensitiveFileAcl succeeds - it swallows its own failures.
        [System.IO.File]::WriteAllText($CredPath, "")
        Protect-JunosSensitiveFileAcl -Path $CredPath
        # WriteAllText, not Out-File -Encoding utf8: "utf8" means BOM in Windows PowerShell 5.1
        # but no-BOM in pwsh Core, while the reader is always hardcoded powershell.exe (5.1),
        # whose Get-Content falls back to the ANSI codepage on a BOM-less file and corrupts
        # non-ASCII credentials. WriteAllText is UTF-8-without-BOM on both runtimes.
        [System.IO.File]::WriteAllText($CredPath, $Json)
    } catch {
        # The caller never receives a path (we don't return), so it can't clean up after a
        # partial write - do it here before re-throwing.
        if (Test-Path -LiteralPath $CredPath) {
            Remove-Item -LiteralPath $CredPath -Force -ErrorAction SilentlyContinue
        }
        throw
    }
    return $CredPath
}

function Remove-JunosCredentialFile {
    param([Parameter(Mandatory=$true)][string]$CredentialFile)
    Remove-Item -Path $CredentialFile -Force -ErrorAction SilentlyContinue
}

# Writes the plaintext-password askpass temp files SSH_ASKPASS needs, and returns their paths
# plus the env vars ssh.exe requires. Caller must call Remove-JunosAskPass in a finally block -
# these hold the real switch password in plaintext while they exist.
function New-JunosAskPass {
    param([Parameter(Mandatory=$true)][string]$Password)
    $AskPassPath = Join-Path $env:TEMP "ssh_askpass_$($PID)_$([guid]::NewGuid().Guid.Substring(0,8)).bat"
    $AskPassText = Join-Path $env:TEMP "ssh_pass_$($PID)_$([guid]::NewGuid().Guid.Substring(0,8)).txt"
    try {
        # Create empty, harden the ACL, then write - same ordering rationale and same
        # ACL-persistence open question as New-JunosCredentialFile above.
        [System.IO.File]::WriteAllText($AskPassText, "")
        Protect-JunosSensitiveFileAcl -Path $AskPassText
        [System.IO.File]::WriteAllText($AskPassText, $Password)
        [System.IO.File]::WriteAllText($AskPassPath, "")
        Protect-JunosSensitiveFileAcl -Path $AskPassPath
        [System.IO.File]::WriteAllText($AskPassPath, "@type `"$AskPassText`"")
    } catch {
        # The caller never receives a context object (we don't return), so it can't clean up
        # after a partial write - do it here before re-throwing.
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

# Plaintext password files are normally removed in a `finally`, which a hard kill (crash,
# task-kill, power loss) skips - so sweep at the start of each crawl/connect session. Age-gated
# rather than "delete every match" so a concurrent session's in-use files survive.
function Clear-StaleJunosTempFiles {
    param([int]$MaxAgeHours = 4)
    $Cutoff = (Get-Date).AddHours(-$MaxAgeHours)
    # ssh_out_/ssh_err_ were Invoke-InteractiveBatch's redirected stdout/stderr before it owned
    # ssh.exe's pipes directly; it no longer writes them, but a machine that ran an older build
    # can still hold one, and ssh_out_ was the most sensitive thing ever written to %TEMP%: raw
    # `show configuration | display set` - SNMP communities, TACACS secrets, encrypted root
    # password - with none of Save-RawDump's redaction applied. Kept so those get swept.
    $Patterns = @("junos_cred_*.json", "ssh_pass_*.txt", "ssh_askpass_*.bat", "ssh_out_*.txt", "ssh_err_*.txt")
    foreach ($Pattern in $Patterns) {
        try {
            Get-ChildItem -Path $env:TEMP -Filter $Pattern -File -ErrorAction SilentlyContinue |
                Where-Object { $_.LastWriteTime -lt $Cutoff } |
                Remove-Item -Force -ErrorAction SilentlyContinue
        } catch {}
    }
}

# Standard SSH client options for talking to Junos switches: short connect timeout, no host-key
# prompt/storage (internal, frequently reimaged switches), and password-only auth so SSH_ASKPASS
# is used instead of falling back to an interactively-prompted key passphrase.
function Get-JunosSshArgs {
    param(
        [Parameter(Mandatory=$true)][string]$Username,
        [Parameter(Mandatory=$true)][string]$TargetIP
    )
    # SECURITY: this is the single choke point every SSH-invoking caller funnels through, so
    # both checks below close command injection even for values that never passed WebServer.ps1's
    # save-time check (config loaded at startup; Start-NetworkMapper.ps1's -SwitchIP).
    if ($Username -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}\z') {
        throw "Invalid Junos username: must start with a letter or digit and contain only letters, digits, '.', '_', or '-'"
    }
    # Octet-range regex (0-255), stricter than WebServer.ps1's `\d{1,3}` shape check, so
    # "10.1.2.999" is rejected here too.
    $Octet = '(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
    if ($TargetIP -notmatch "^$Octet\.$Octet\.$Octet\.$Octet\z") {
        throw "Invalid Junos target IP: must be a well-formed IPv4 address (four dot-separated octets, each 0-255)"
    }
    # ServerAliveInterval/ServerAliveCountMax let a dead session's ssh.exe terminate ITSELF.
    # Defense in depth now that Get-JunosNodeData.ps1 kills ssh.exe directly: it still cannot
    # do so if the PowerShell host itself dies, and an orphan holds the switch session open.
    #
    # INVARIANT: this budget (15s x 6 = 90s) must stay LONGER than Get-JunosNodeData.ps1's
    # per-batch Process.WaitForExit timeout (50s). A shorter budget tears down healthy sessions
    # the batch is still waiting on - switches with a slow/loaded RE stall during
    # `show interfaces extensive` / `show configuration | display set` and return an empty
    # payload every time, while faster switches look fine.
    $BaseArgs = @("-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=6", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=NUL", "-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no")
    return $BaseArgs + @("$Username@$TargetIP")
}

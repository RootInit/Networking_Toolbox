# Shared SSH/askpass plumbing and credential loading, dot-sourced by Get-JunosNodeData.ps1 (batch)
# and Connect-Switch.ps1 (interactive). The ssh.exe invocation stays separate per script: batch
# redirects its stdio into the worker, interactive needs a directly attached console.

# Replaces a file's ACL with a single full-control ACE for the current user, dropping inherited
# access. Touches the ACL only, so it is reusable on files that already hold data. Best-effort:
# warns instead of throwing, so callers must treat hardening as possibly absent.
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

# Writes {Username, Password} to a short-lived %TEMP% file for handoff to Connect-Switch.ps1, which
# runs as a separate process. The reader must call Remove-JunosCredentialFile in a finally block.
function New-JunosCredentialFile {
    param([Parameter(Mandatory=$true)][string]$Username, [Parameter(Mandatory=$true)][string]$Password)
    $CredPath = Join-Path $env:TEMP "junos_cred_$($PID)_$([guid]::NewGuid().Guid.Substring(0,8)).json"
    $Json = @{ Username = $Username; Password = $Password } | ConvertTo-Json -Compress
    # OPEN QUESTION (unverifiable off Windows): whether a hardened ACL on an empty file survives the
    # later WriteAllText, or NTFS resets it to the parent's inherited default.
    try {
        # Create empty and harden the ACL BEFORE writing plaintext, so the content is never on disk
        # under %TEMP%'s default ACL. Only a guarantee when Protect-JunosSensitiveFileAcl succeeds.
        [System.IO.File]::WriteAllText($CredPath, "")
        Protect-JunosSensitiveFileAcl -Path $CredPath
        # WriteAllText, not Out-File -Encoding utf8: "utf8" means BOM on 5.1 but no-BOM on Core, and
        # the reader is always powershell.exe (5.1), whose Get-Content falls back to ANSI on a
        # BOM-less file and corrupts non-ASCII credentials. WriteAllText is UTF-8-no-BOM on both.
        [System.IO.File]::WriteAllText($CredPath, $Json)
    } catch {
        # The caller never receives a path, so it can't clean up after a partial write.
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

# Writes the plaintext-password askpass temp files SSH_ASKPASS needs. Caller must call
# Remove-JunosAskPass in a finally block - these hold the real switch password while they exist.
function New-JunosAskPass {
    param([Parameter(Mandatory=$true)][string]$Password)
    $AskPassPath = Join-Path $env:TEMP "ssh_askpass_$($PID)_$([guid]::NewGuid().Guid.Substring(0,8)).bat"
    $AskPassText = Join-Path $env:TEMP "ssh_pass_$($PID)_$([guid]::NewGuid().Guid.Substring(0,8)).txt"
    try {
        # Same create-empty-then-harden ordering as New-JunosCredentialFile above.
        [System.IO.File]::WriteAllText($AskPassText, "")
        Protect-JunosSensitiveFileAcl -Path $AskPassText
        [System.IO.File]::WriteAllText($AskPassText, $Password)
        [System.IO.File]::WriteAllText($AskPassPath, "")
        Protect-JunosSensitiveFileAcl -Path $AskPassPath
        [System.IO.File]::WriteAllText($AskPassPath, "@type `"$AskPassText`"")
    } catch {
        # The caller never receives a context object, so it can't clean up after a partial write.
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

# Plaintext password files are normally removed in a `finally`, which a hard kill skips - so sweep
# at the start of each session. Age-gated so a concurrent session's in-use files survive.
function Clear-StaleJunosTempFiles {
    param([int]$MaxAgeHours = 4)
    $Cutoff = (Get-Date).AddHours(-$MaxAgeHours)
# ssh_out_/ssh_err_ were the batch's redirected stdout/stderr before it owned ssh.exe's pipes; it no
# longer writes them, but an older build's leftovers can remain, and ssh_out_ held raw
# `show configuration | display set` output with none of Save-RawDump's redaction.
    $Patterns = @("junos_cred_*.json", "ssh_pass_*.txt", "ssh_askpass_*.bat", "ssh_out_*.txt", "ssh_err_*.txt")
    foreach ($Pattern in $Patterns) {
        try {
            Get-ChildItem -Path $env:TEMP -Filter $Pattern -File -ErrorAction SilentlyContinue |
                Where-Object { $_.LastWriteTime -lt $Cutoff } |
                Remove-Item -Force -ErrorAction SilentlyContinue
        } catch {}
    }
}

# Standard SSH options for Junos: short connect timeout, no host-key prompt/storage (internal,
# frequently reimaged switches), and password-only auth so SSH_ASKPASS is used.
function Get-JunosSshArgs {
    param(
        [Parameter(Mandatory=$true)][string]$Username,
        [Parameter(Mandatory=$true)][string]$TargetIP
    )
    # SECURITY: the single choke point every SSH-invoking caller funnels through, so both checks
    # close command injection even for values that never passed WebServer.ps1's save-time check.
    if ($Username -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}\z') {
        throw "Invalid Junos username: must start with a letter or digit and contain only letters, digits, '.', '_', or '-'"
    }
    # Octet-range regex, stricter than WebServer.ps1's shape check, so "10.1.2.999" is rejected.
    $Octet = '(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
    if ($TargetIP -notmatch "^$Octet\.$Octet\.$Octet\.$Octet\z") {
        throw "Invalid Junos target IP: must be a well-formed IPv4 address (four dot-separated octets, each 0-255)"
    }
    # ServerAliveInterval/CountMax let a dead session's ssh.exe terminate ITSELF - defense in depth,
    # since Get-JunosNodeData.ps1 cannot kill it if the PowerShell host itself dies.
    #
    # INVARIANT: this budget (15s x 10 = 150s) must stay LONGER than the worker's per-batch
    # WaitForExit (120s), or healthy sessions to slow-RE switches are torn down mid-batch.
    $BaseArgs = @("-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=10", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=NUL", "-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no")
    return $BaseArgs + @("$Username@$TargetIP")
}

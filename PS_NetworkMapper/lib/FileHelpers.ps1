# Shared filesystem-write helpers. Not meant to be run directly - dot-source it:
# `. (Join-Path $PSScriptRoot "FileHelpers.ps1")`

# Atomically replaces $DestinationPath with the contents of $SourcePath (an already-written
# temp file) in a single rename() syscall - whether or not $DestinationPath exists yet.
# Callers write their new content to a uniquely-named temp file next to the destination,
# then call this to swap it into place, so a crash/disk-full mid-write can never leave
# $DestinationPath truncated or half-written (the operator's topology/config data is either
# the old file intact or the new one, never a corrupt in-between - INV-DATA).
#
# [System.IO.File]::Move($src, $dst, overwrite:$true) - the 3-arg overload - was confirmed
# via strace against the real pwsh 7.6.2 binary to issue exactly one rename() syscall
# regardless of whether $dst already exists, so it's atomic in both cases. This replaces the
# previous pattern of [System.IO.File]::Replace() when the destination exists, falling back
# to Move-Item -Force when it doesn't - correct, but two code paths, independently
# reimplemented in multiple files, one of which carried a [NullString]::Value gotcha
# ($null coerces to an empty string across the PowerShell/.NET boundary, which .Replace()
# then rejects).
#
# [System.IO.File]::Move is a raw .NET static call - it resolves a relative path against
# [Environment]::CurrentDirectory, NOT PowerShell's $PWD (which Set-Location doesn't keep in
# sync) - unlike Move-Item/Test-Path. Convert-Path -LiteralPath resolves the source (which
# must already exist - the caller just wrote it) to a full path against $PWD first, so this
# can't silently touch the wrong directory. $DestinationPath may not exist yet, so it can't
# be Convert-Path'd directly; its parent directory is resolved instead and the leaf name
# rejoined onto it.
function Move-FileAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )

    $ResolvedSource = Convert-Path -LiteralPath $SourcePath

    $DestDir = Split-Path -Path $DestinationPath -Parent
    $DestLeaf = Split-Path -Path $DestinationPath -Leaf
    $ResolvedDestDir = if ([string]::IsNullOrEmpty($DestDir)) { Convert-Path -LiteralPath '.' } else { Convert-Path -LiteralPath $DestDir }
    $ResolvedDestination = Join-Path $ResolvedDestDir $DestLeaf

    [System.IO.File]::Move($ResolvedSource, $ResolvedDestination, $true)
}

# Convenience wrapper for the common "write $Content to $DestinationPath without ever
# leaving it truncated" case: writes to a fresh temp file next to the destination, then
# Move-FileAtomic's it into place, cleaning the temp file up on any failure. The temp name
# mixes $PID with a GUID (not just a timestamp) so two near-simultaneous writers - separate
# processes, or two operations racing within the same process - can never collide on the
# same temp path. -LiteralPath (not -Path) throughout avoids glob-interpretation of bracket
# characters that can legitimately appear in a topology/config path.
function Set-FileContentAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [Parameter(Mandatory = $true)][string]$Content,
        [string]$Encoding = 'utf8',
        # Off by default, matching Out-File's own default of a trailing newline (the pattern
        # every call site but Update-OuiDatabase.ps1 already relied on). Pass this to suppress
        # it for a call site (like Update-OuiDatabase.ps1's generated .js asset) that
        # deliberately writes no trailing newline.
        [switch]$NoNewline
    )

    $TempPath = "$DestinationPath.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        Set-Content -LiteralPath $TempPath -Value $Content -Encoding $Encoding -NoNewline:$NoNewline
        Move-FileAtomic -SourcePath $TempPath -DestinationPath $DestinationPath
    } finally {
        if (Test-Path -LiteralPath $TempPath) { Remove-Item -LiteralPath $TempPath -Force }
    }
}

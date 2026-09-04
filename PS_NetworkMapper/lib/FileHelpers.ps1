# Shared filesystem-write helpers. Not meant to be run directly - dot-source it:
# `. (Join-Path $PSScriptRoot "FileHelpers.ps1")`

# Atomically replaces $DestinationPath with the contents of $SourcePath (an already-written
# temp file) in a single rename() syscall - whether or not $DestinationPath exists yet.
# Callers write their new content to a uniquely-named temp file next to the destination,
# then call this to swap it into place, so a crash/disk-full mid-write can never leave
# $DestinationPath truncated or half-written (the operator's topology/config data is either
# the old file intact or the new one, never a corrupt in-between - INV-DATA).
#
# [System.IO.File]::Replace($src, $dst, $null) is used rather than the 3-arg
# [System.IO.File]::Move($src, $dst, overwrite:$true) overload: that Move overload was only
# added in .NET Core 3.0/.NET 5+ and does not exist on .NET Framework, which Windows
# PowerShell 5.1 (a real deployment target for this tool) runs on - PowerShell can't resolve
# that overload at all there, so every save through this helper would throw on PS 5.1.
# File.Replace(), by contrast, has existed on both .NET Framework and .NET Core/5+ since
# early versions, giving one code path that works unchanged on PS 5.1 and PS 7. Its one
# quirk is that it requires $dst to already exist (it's designed to atomically swap one
# existing file for another, unlike Move, which is happy with a brand-new destination) - so
# an empty placeholder is created first when $dst doesn't exist yet. [NullString]::Value is
# passed for the backup-path argument (no backup of the replaced file is kept) rather than a
# plain $null literal - confirmed empirically on pwsh 7.6.2 here that a bare $null coerces to
# an empty string across the PowerShell/.NET boundary, which .Replace() then rejects with
# "The value cannot be an empty string. (Parameter 'path')"; [NullString]::Value is the
# documented way to pass a true null string argument to a .NET method from PowerShell, and
# does not hit that coercion.
#
# [System.IO.File]::Replace, like any raw .NET static call, resolves a relative path against
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

    if (-not (Test-Path -LiteralPath $ResolvedDestination)) {
        New-Item -ItemType File -Path $ResolvedDestination -Force | Out-Null
    }
    [System.IO.File]::Replace($ResolvedSource, $ResolvedDestination, [NullString]::Value)
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

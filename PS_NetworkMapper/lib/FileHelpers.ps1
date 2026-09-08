# Shared filesystem-write helpers. Not meant to be run directly - dot-source it:
# `. (Join-Path $PSScriptRoot "FileHelpers.ps1")`

# Swaps an already-written temp file into place in a single rename, so a crash/disk-full
# mid-write can never leave $DestinationPath truncated.
#
# File.Replace rather than the 3-arg File.Move(overwrite) overload: that overload doesn't
# exist on .NET Framework, so it would throw under Windows PowerShell 5.1 (a real deployment
# target). Replace's quirk is that it requires $dst to already exist, hence the placeholder.
# [NullString]::Value (not a bare $null) for the backup-path argument: $null coerces to an
# empty string across the PowerShell/.NET boundary and Replace rejects that.
#
# Raw .NET static calls resolve relative paths against [Environment]::CurrentDirectory, not
# PowerShell's $PWD - so both paths are Convert-Path'd first or this could touch the wrong
# directory. $DestinationPath may not exist yet, so its parent is resolved and the leaf
# rejoined instead.
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

# Write-then-Move-FileAtomic wrapper. The temp name mixes $PID with a GUID so two
# near-simultaneous writers (separate processes, or racing operations in one) can't collide
# on the same temp path. -LiteralPath throughout avoids glob-interpreting bracket characters
# that can legitimately appear in a topology/config path.
function Set-FileContentAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [Parameter(Mandatory = $true)][string]$Content,
        [string]$Encoding = 'utf8',
        # Off by default, matching Out-File's own default of a trailing newline.
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

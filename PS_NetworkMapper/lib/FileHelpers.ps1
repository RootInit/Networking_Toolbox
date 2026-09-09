# Shared filesystem-write helpers. Not meant to be run directly - dot-source it:
# `. (Join-Path $PSScriptRoot "FileHelpers.ps1")`

# Raw .NET static calls ([System.IO.File]::...) resolve a relative path against
# [Environment]::CurrentDirectory, which PowerShell does NOT keep in step with $PWD - so a
# relative path handed to one can land in a completely different directory. Everything below
# routes through here first. The leaf is rejoined rather than resolved because the target file
# often doesn't exist yet, which Convert-Path rejects.
function Resolve-PathForDotNetIo {
    param([Parameter(Mandatory = $true)][string]$Path)

    $Dir = Split-Path -Path $Path -Parent
    $Leaf = Split-Path -Path $Path -Leaf
    $ResolvedDir = if ([string]::IsNullOrEmpty($Dir)) { Convert-Path -LiteralPath '.' } else { Convert-Path -LiteralPath $Dir }
    return Join-Path $ResolvedDir $Leaf
}

# Swaps an already-written temp file into place in a single rename, so a crash/disk-full
# mid-write can never leave $DestinationPath truncated.
#
# File.Replace rather than the 3-arg File.Move(overwrite) overload: that overload doesn't
# exist on .NET Framework, so it would throw under Windows PowerShell 5.1 (a real deployment
# target). Replace's quirk is that it requires $dst to already exist, hence the placeholder.
# [NullString]::Value (not a bare $null) for the backup-path argument: $null coerces to an
# empty string across the PowerShell/.NET boundary and Replace rejects that.
function Move-FileAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )

    $ResolvedSource = Convert-Path -LiteralPath $SourcePath
    $ResolvedDestination = Resolve-PathForDotNetIo -Path $DestinationPath

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

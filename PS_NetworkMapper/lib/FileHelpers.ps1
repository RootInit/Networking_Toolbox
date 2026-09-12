# Shared filesystem-write helpers. Dot-source it rather than running it.

# Raw [System.IO.File] calls resolve a relative path against [Environment]::CurrentDirectory, which
# PowerShell does NOT keep in step with $PWD. The leaf is rejoined rather than resolved because the
# target often doesn't exist yet, which Convert-Path rejects.
function Resolve-PathForDotNetIo {
    param([Parameter(Mandatory = $true)][string]$Path)

    $Dir = Split-Path -Path $Path -Parent
    $Leaf = Split-Path -Path $Path -Leaf
    $ResolvedDir = if ([string]::IsNullOrEmpty($Dir)) { Convert-Path -LiteralPath '.' } else { Convert-Path -LiteralPath $Dir }
    return Join-Path $ResolvedDir $Leaf
}

# Swaps an already-written temp file into place in a single rename, so a crash mid-write can never
# leave $DestinationPath truncated. File.Replace rather than File.Move(overwrite), which doesn't
# exist on .NET Framework; Replace requires $dst to already exist, hence the placeholder.
# [NullString]::Value for the backup argument: a bare $null coerces to "" and Replace rejects that.
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

# Write-then-Move-FileAtomic wrapper. The temp name mixes $PID with a GUID so two near-simultaneous
# writers can't collide. -LiteralPath throughout avoids glob-interpreting bracket characters.
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

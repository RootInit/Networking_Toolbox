# Standalone CLI to encrypt or decrypt a topology snapshot (Network_Maps\NetworkMap_*.json[.enc])
# or Configuration.json[.enc] outside of a live crawl/webserver session - e.g. to inspect an
# encrypted file's contents offline, re-encrypt a plaintext snapshot captured under
# -NoEncryption, rotate a file onto a new password, or hand a decrypted copy to another tool.
# Uses the exact same AES-256-CBC + PBKDF2-SHA256 + HMAC-SHA256 envelope as the rest of the
# app (TopologyCrypto.ps1, dot-sourced below - not reimplemented here), so a file this script
# encrypts opens normally in Start-NetworkMapper.ps1/the web UI, and vice versa.
#
# Not part of the app's own runtime - nothing here is called automatically. Run it directly:
#   .\Protect-MapperFile.ps1 -InputFile .\Network_Maps\NetworkMap_2026-08-28_120000.json          # encrypt
#   .\Protect-MapperFile.ps1 -InputFile .\Network_Maps\NetworkMap_2026-08-28_120000.json.enc -Decrypt
#   .\Protect-MapperFile.ps1 -InputFile .\Configuration.json.enc -Decrypt -OutputFile plain.json
#
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateScript({ Test-Path $_ -PathType Leaf })]
    [string]$InputFile,

    # Defaults to InputFile with ".enc" added (encrypting) or stripped (decrypting) - see
    # the Default computation below for the exact rule when the name doesn't end in .enc.
    [string]$OutputFile,

    # Default action is encrypt; pass this to reverse it. Mirrors -NoEncryption's existing
    # "switch flips the default" idiom elsewhere in this app (Start-NetworkMapper.ps1).
    [switch]$Decrypt,

    # Only meaningful when encrypting - which envelope `format` to stamp the file with.
    # Start-NetworkMapper.ps1 refuses to load Configuration.json.enc under any format but
    # "PSNetworkMapper-EncryptedConfig" (a deliberate safety check - see
    # TopologyCrypto.ps1/web-src/topology-crypto.js's decryptEnvelope), so getting this
    # wrong produces a file that LOOKS encrypted correctly but the app itself will reject.
    # Auto-detected from the input filename by default; override only when the file doesn't
    # follow the app's own Configuration*.json / NetworkMap_*.json naming.
    [ValidateSet('Auto', 'Topology', 'Config')]
    [string]$Type = 'Auto',

    # Non-interactive use (scripting/automation) - e.g.
    # -Password (ConvertTo-SecureString 'x' -AsPlainText -Force). Prompted interactively
    # when omitted, same Read-Host -AsSecureString idiom Start-NetworkMapper.ps1 uses.
    [securestring]$Password,

    # Skips the overwrite confirmation if OutputFile already exists. Does not disable
    # -WhatIf/-Confirm (SupportsShouldProcess above still governs those normally).
    [switch]$Force
)

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
. (Join-Path $ScriptDir "TopologyCrypto.ps1")

# Same cross-runtime idiom as Start-NetworkMapper.ps1's own copy of this (works identically
# on Windows PowerShell 5.1 and pwsh 7+, unlike manually marshaling the BSTR).
function ConvertFrom-SecurePassword {
    param([Parameter(Mandatory = $true)][securestring]$SecureString)
    return [System.Net.NetworkCredential]::new('', $SecureString).Password
}

# Auto-detects the envelope format from filename, matching the two files this app ever
# encrypts - anything literally named Configuration.json(.enc) is the config file, every
# other .json(.enc) is treated as a topology snapshot.
function Resolve-EnvelopeFormat {
    param([string]$Type, [string]$Path)
    if ($Type -eq 'Config') { return 'PSNetworkMapper-EncryptedConfig' }
    if ($Type -eq 'Topology') { return 'PSNetworkMapper-EncryptedTopology' }
    if ((Split-Path -Leaf $Path) -match '^Configuration\.json(\.enc)?$') { return 'PSNetworkMapper-EncryptedConfig' }
    return 'PSNetworkMapper-EncryptedTopology'
}

if (-not $Password) { $Password = Read-Host -Prompt "Enter encryption password" -AsSecureString }
$PlainPassword = ConvertFrom-SecurePassword -SecureString $Password
if ([string]::IsNullOrEmpty($PlainPassword)) { throw "Password cannot be empty." }

$ResolvedInput = (Resolve-Path -LiteralPath $InputFile).Path

function Confirm-Overwrite {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    if ($Force) { return $true }
    return $PSCmdlet.ShouldProcess($Path, "Overwrite existing file")
}

if ($Decrypt) {
    # -Encoding UTF8 explicit, not the default - Get-Content -Raw with no -Encoding falls
    # back to the system's ANSI codepage on a BOM-less file, which would corrupt this before
    # it even reaches ConvertFrom-Json if the envelope (or, on encrypt below, a plaintext
    # snapshot's device data - hostnames, LLDP banners) carries any non-ASCII byte. Same bug
    # class as Get-JunosNodeData.ps1's ssh output reads and WebServer.ps1's
    # Invoke-GetConfigAction - see either of those for the full explanation.
    $Envelope = Get-Content -LiteralPath $ResolvedInput -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $Envelope.format) {
        throw "$ResolvedInput does not look like an encrypted PS_NetworkMapper file (no 'format' field) - nothing to decrypt."
    }

    # Either known format decrypts fine here - unlike Start-NetworkMapper.ps1's own decrypt
    # call, this script has no downstream logic that cares WHICH kind of file it was, so
    # there's no reason to make the caller specify -Type just to decrypt.
    $PlainJson = Unprotect-TopologyPayload -Envelope $Envelope -Password $PlainPassword -ExpectedFormats @('PSNetworkMapper-EncryptedTopology', 'PSNetworkMapper-EncryptedConfig')
    Write-Host "Decrypted (format: $($Envelope.format))" -ForegroundColor Green

    $DefaultOutput = if ($ResolvedInput -match '\.enc$') { $ResolvedInput -replace '\.enc$', '' } else { "$ResolvedInput.decrypted.json" }
    $TargetPath = if ($OutputFile) { $OutputFile } else { $DefaultOutput }

    if (-not (Confirm-Overwrite -Path $TargetPath)) { return }
    # Re-serialize (not a raw string write) so the output is normalized, readable JSON
    # regardless of exact whitespace the original plaintext happened to have - same "always
    # re-serialize rather than write the raw body through" convention WebServer.ps1's
    # Invoke-SaveConfigAction already uses for its own plaintext write path.
    ($PlainJson | ConvertFrom-Json) | ConvertTo-Json -Depth 100 | Out-File -FilePath $TargetPath -Encoding utf8 -Force
    Write-Host "Wrote plaintext to: $TargetPath" -ForegroundColor Green

} else {
    # -Encoding UTF8 explicit - see the -Decrypt branch's comment above.
    $RawInput = Get-Content -LiteralPath $ResolvedInput -Raw -Encoding UTF8
    $ParsedInput = $null
    try { $ParsedInput = $RawInput | ConvertFrom-Json } catch { throw "$ResolvedInput is not valid JSON - nothing to encrypt." }
    # Refuses to re-wrap an already-encrypted envelope as if it were plaintext - that would
    # silently produce a file nothing can ever decrypt back to the real data (the "plaintext"
    # being encrypted is itself ciphertext-plus-metadata, not the original content).
    if ($ParsedInput.format -match '^PSNetworkMapper-Encrypted') {
        throw "$ResolvedInput is already an encrypted envelope (format: $($ParsedInput.format)) - use -Decrypt instead, or point -InputFile at the original plaintext source."
    }

    $Format = Resolve-EnvelopeFormat -Type $Type -Path $ResolvedInput

    $SaltBytes = [byte[]]::new(16)
    $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $Rng.GetBytes($SaltBytes)
    $Rng.Dispose()

    $Iterations = Get-TopologyPbkdf2Iterations
    $KeyMaterial = Get-TopologyKeyMaterial -Password $PlainPassword -Salt $SaltBytes -Iterations $Iterations
    $Envelope = Protect-TopologyPayload -PlainJson $RawInput -EncKey $KeyMaterial.EncKey -MacKey $KeyMaterial.MacKey -Salt $SaltBytes -Iterations $Iterations -Format $Format

    $DefaultOutput = if ($ResolvedInput -match '\.enc$') { $ResolvedInput } else { "$ResolvedInput.enc" }
    $TargetPath = if ($OutputFile) { $OutputFile } else { $DefaultOutput }

    if (-not (Confirm-Overwrite -Path $TargetPath)) { return }
    $Envelope | ConvertTo-Json -Depth 10 | Out-File -FilePath $TargetPath -Encoding utf8 -Force
    Write-Host "Encrypted (format: $Format) to: $TargetPath" -ForegroundColor Green
}

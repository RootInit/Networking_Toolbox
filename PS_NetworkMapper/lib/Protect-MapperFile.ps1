# Standalone CLI to encrypt or decrypt a topology snapshot or Configuration.json[.enc] outside a
# live crawl/webserver session, using the same TopologyCrypto.ps1 envelope as the rest of the app.
#   .\Protect-MapperFile.ps1 -InputFile .\Network_Maps\NetworkMap_2026-08-28_120000.json          # encrypt
#   .\Protect-MapperFile.ps1 -InputFile .\Network_Maps\NetworkMap_2026-08-28_120000.json.enc -Decrypt
#   .\Protect-MapperFile.ps1 -InputFile .\Configuration.json.enc -Decrypt -OutputFile plain.json
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateScript({ Test-Path $_ -PathType Leaf })]
    [string]$InputFile,

    # Defaults to InputFile with ".enc" added (encrypting) or stripped (decrypting).
    [string]$OutputFile,

    # Default action is encrypt; pass this to reverse it.
    [switch]$Decrypt,

    # Which envelope `format` to stamp when encrypting; auto-detected from the filename. Start-
    # NetworkMapper.ps1 loads Configuration.json.enc only as "PSNetworkMapper-EncryptedConfig".
    [ValidateSet('Auto', 'Topology', 'Config')]
    [string]$Type = 'Auto',

    # Non-interactive use; prompted interactively when omitted.
    [securestring]$Password,

    # Skips the overwrite confirmation if OutputFile already exists.
    [switch]$Force
)

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
. (Join-Path $ScriptDir "TopologyCrypto.ps1")
. (Join-Path $ScriptDir "FileHelpers.ps1")

# Cross-runtime SecureString->plaintext idiom; avoids manual BSTR marshaling/cleanup.
function ConvertFrom-SecurePassword {
    param([Parameter(Mandatory = $true)][securestring]$SecureString)
    return [System.Net.NetworkCredential]::new('', $SecureString).Password
}

function Resolve-EnvelopeFormat {
    param([string]$Type, [string]$Path)
    if ($Type -eq 'Config') { return 'PSNetworkMapper-EncryptedConfig' }
    if ($Type -eq 'Topology') { return 'PSNetworkMapper-EncryptedTopology' }
    if ((Split-Path -Leaf $Path) -match '^Configuration\.json(\.enc)?$') { return 'PSNetworkMapper-EncryptedConfig' }
    return 'PSNetworkMapper-EncryptedTopology'
}

# Before the prompt - see Assert-TopologyCryptoRuntime.
Assert-TopologyCryptoRuntime

if (-not $Password) { $Password = Read-Host -Prompt "Enter encryption password" -AsSecureString }
$PlainPassword = ConvertFrom-SecurePassword -SecureString $Password
if ([string]::IsNullOrEmpty($PlainPassword)) { throw "Password cannot be empty." }

$ResolvedInput = (Resolve-Path -LiteralPath $InputFile).Path

# -Force works through $ConfirmPreference rather than skipping the check: the ShouldProcess call
# below is also what makes -WhatIf work, and Set-FileContentAtomic can't carry it.
if ($Force) { $ConfirmPreference = 'None' }

if ($Decrypt) {
    # -Encoding UTF8 explicit, or a BOM-less file is read as ANSI and non-ASCII is corrupted.
    $Envelope = Get-Content -LiteralPath $ResolvedInput -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $Envelope.format) {
        throw "$ResolvedInput does not look like an encrypted PS_NetworkMapper file (no 'format' field) - nothing to decrypt."
    }

    # Either known format decrypts fine here - no downstream logic cares which kind it was.
    try {
        $PlainJson = Unprotect-TopologyPayload -Envelope $Envelope -Password $PlainPassword -ExpectedFormats @('PSNetworkMapper-EncryptedTopology', 'PSNetworkMapper-EncryptedConfig')
    } catch {
        throw "Failed to decrypt $ResolvedInput - $_"
    }
    Write-Host "Decrypted (format: $($Envelope.format))" -ForegroundColor Green

    $DefaultOutput = if ($ResolvedInput -match '\.enc$') { $ResolvedInput -replace '\.enc$', '' } else { "$ResolvedInput.decrypted.json" }
    $TargetPath = if ($OutputFile) { $OutputFile } else { $DefaultOutput }

    if (-not $PSCmdlet.ShouldProcess($TargetPath, "Write decrypted plaintext")) { return }
    # Written verbatim: a ConvertFrom-Json/ConvertTo-Json round-trip would reformat date-like string
    # fields by version/culture. Atomic because -OutputFile can equal -InputFile, making $TargetPath
    # the operator's only copy.
    Set-FileContentAtomic -DestinationPath $TargetPath -Content $PlainJson -Encoding utf8
    Write-Host "Wrote plaintext to: $TargetPath" -ForegroundColor Green

} else {
    # -Encoding UTF8 explicit - see the -Decrypt branch's comment above.
    $RawInput = Get-Content -LiteralPath $ResolvedInput -Raw -Encoding UTF8
    $ParsedInput = $null
    try { $ParsedInput = $RawInput | ConvertFrom-Json } catch { throw "$ResolvedInput is not valid JSON - nothing to encrypt." }
    # Re-wrapping an already-encrypted envelope would produce a file nothing can decrypt.
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

    if (-not $PSCmdlet.ShouldProcess($TargetPath, "Write encrypted envelope")) { return }
    Set-FileContentAtomic -DestinationPath $TargetPath -Content ($Envelope | ConvertTo-Json -Depth 10) -Encoding utf8
    Write-Host "Encrypted (format: $Format) to: $TargetPath" -ForegroundColor Green
}

#
# Shared AES-256-CBC + PBKDF2-SHA256 + HMAC-SHA256 (encrypt-then-MAC) envelope logic,
# used by Start-NetworkMapper.ps1 (topology snapshots) and WebServer.ps1
# (Configuration.json.enc). Mirrors web-src/topology-crypto.js's decryptEnvelope.
#
# Not meant to be run directly - dot-source it.

# Single source of truth for the PBKDF2 iteration count, so it can't drift between the
# crawler and the webserver. A function (not a variable) so it resolves through however
# many layers of dot-sourcing sit between caller and file.
# OWASP's current PBKDF2-HMAC-SHA256 guidance (600k). Safe to raise later - iterations is
# stored per-file in the envelope and read back on decrypt, not assumed.
function Get-TopologyPbkdf2Iterations {
    return 600000
}

function Get-TopologyKeyMaterial {
    param(
        [Parameter(Mandatory=$true)][string]$Password,
        [Parameter(Mandatory=$true)][byte[]]$Salt,
        [Parameter(Mandatory=$true)][int]$Iterations
    )
    $Kdf = [System.Security.Cryptography.Rfc2898DeriveBytes]::new($Password, $Salt, $Iterations, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
    $KeyMaterial = $Kdf.GetBytes(64)
    $Kdf.Dispose()
    return @{ EncKey = $KeyMaterial[0..31]; MacKey = $KeyMaterial[32..63] }
}

# Builds an encrypted envelope from a plaintext JSON string. IV is fresh per call; caller
# derives EncKey/MacKey/Salt via Get-TopologyKeyMaterial above.
function Protect-TopologyPayload {
    param(
        [Parameter(Mandatory=$true)][string]$PlainJson,
        [Parameter(Mandatory=$true)][byte[]]$EncKey,
        [Parameter(Mandatory=$true)][byte[]]$MacKey,
        [Parameter(Mandatory=$true)][byte[]]$Salt,
        [Parameter(Mandatory=$true)][int]$Iterations,
        [string]$Format = "PSNetworkMapper-EncryptedTopology"
    )

    $Aes = [System.Security.Cryptography.Aes]::Create()
    $Aes.KeySize = 256
    $Aes.Key = $EncKey
    $Aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
    $Aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
    $Aes.GenerateIV()
    $IvBytes = $Aes.IV

    $PlainBytes = [System.Text.Encoding]::UTF8.GetBytes($PlainJson)
    $Encryptor = $Aes.CreateEncryptor()
    $CipherBytes = $Encryptor.TransformFinalBlock($PlainBytes, 0, $PlainBytes.Length)
    $Encryptor.Dispose()
    $Aes.Dispose()

    $Hmac = [System.Security.Cryptography.HMACSHA256]::new($MacKey)
    $MacBytes = $Hmac.ComputeHash($IvBytes + $CipherBytes)
    $Hmac.Dispose()

    return [ordered]@{
        format       = $Format
        version      = 1
        kdf          = "PBKDF2-SHA256"
        iterations   = $Iterations
        cipher       = "AES-256-CBC"
        macAlgorithm = "HMAC-SHA256"
        salt         = [Convert]::ToBase64String($Salt)
        iv           = [Convert]::ToBase64String($IvBytes)
        mac          = [Convert]::ToBase64String($MacBytes)
        ciphertext   = [Convert]::ToBase64String($CipherBytes)
    }
}

# PowerShell mirror of web-src/topology-crypto.js's decryptEnvelope. Verifies the HMAC
# before decrypting (encrypt-then-MAC) so a wrong password or tampered file fails with one
# clear error instead of an AES-CBC padding exception.
function Unprotect-TopologyPayload {
    param(
        [Parameter(Mandatory=$true)]$Envelope,
        [Parameter(Mandatory=$true)][string]$Password,
        [string[]]$ExpectedFormats = @("PSNetworkMapper-EncryptedTopology")
    )

    if (-not $Envelope -or $ExpectedFormats -cnotcontains $Envelope.format) {
        throw "Not a recognized encrypted file (expected one of: $($ExpectedFormats -join ', '))."
    }
    # JS's `envelope.version !== 1` is strict: a JSON string "1" is rejected, not coerced.
    # PowerShell's -ne coerces the right operand to the left operand's (int) type, so a
    # string "1" would otherwise compare equal - check the runtime type explicitly first,
    # mirroring the iterations numeric-type check below.
    if ($Envelope.version -isnot [int] -and $Envelope.version -isnot [long] -and $Envelope.version -isnot [double] -and $Envelope.version -isnot [decimal]) {
        throw "Unsupported envelope version: $($Envelope.version)"
    }
    if ($Envelope.version -cne 1) {
        throw "Unsupported envelope version: $($Envelope.version)"
    }
    if ($Envelope.kdf -cne "PBKDF2-SHA256" -or $Envelope.cipher -cne "AES-256-CBC" -or $Envelope.macAlgorithm -cne "HMAC-SHA256") {
        throw "Unsupported encryption parameters: $($Envelope.kdf)/$($Envelope.cipher)/$($Envelope.macAlgorithm)"
    }
    # Same bounds as topology-crypto.js's MIN_ITERATIONS/MAX_ITERATIONS - a CPU-burn guard
    # against a tampered file forcing an absurd PBKDF2 cost, not a security boundary.
    # Must reject a JSON string value (e.g. "600000") the same way topology-crypto.js's
    # Number.isInteger(envelope.iterations) check does - ConvertFrom-Json already types a
    # well-formed JSON number as int/long/double, so require that instead of stringifying
    # first via [long]::TryParse([string]...), which would silently accept a string.
    $IterationsValue = $Envelope.iterations
    $IsNumericType = $IterationsValue -is [int] -or $IterationsValue -is [long] -or $IterationsValue -is [double] -or $IterationsValue -is [decimal]
    if (-not $IsNumericType) {
        throw "Iteration count out of range: $($Envelope.iterations)"
    }
    # A double/decimal far outside Int64 range (e.g. what ConvertFrom-Json produces for a
    # JSON number like 1e300) makes the [long] cast itself throw a raw
    # System.Management.Automation.RuntimeException ("Arithmetic operation resulted in an
    # overflow") before the min/max range check below ever runs. Range-check against the
    # double's own comparable bounds first so an out-of-range value hits the clean error
    # instead.
    if ($IterationsValue -lt [long]::MinValue -or $IterationsValue -gt [long]::MaxValue) {
        throw "Iteration count out of range: $($Envelope.iterations)"
    }
    $IterCheck = [long]$IterationsValue
    if ($IterCheck -ne $IterationsValue -or $IterCheck -lt 1000 -or $IterCheck -gt 5000000) {
        throw "Iteration count out of range: $($Envelope.iterations)"
    }

    try {
        $SaltBytes = [Convert]::FromBase64String($Envelope.salt)
        $IvBytes = [Convert]::FromBase64String($Envelope.iv)
        $CipherBytes = [Convert]::FromBase64String($Envelope.ciphertext)
        $MacBytes = [Convert]::FromBase64String($Envelope.mac)
    } catch {
        throw "Incorrect password, or the file is corrupted."
    }

    # [Convert]::FromBase64String("") succeeds and returns a 0-length array, so it doesn't
    # hit the catch above. An empty array would then hit Get-TopologyKeyMaterial's Mandatory
    # -Salt parameter binding and throw a raw ParameterBindingValidationException instead of
    # this function's clean error - check explicitly instead of letting parameter binding be
    # the thing that throws.
    if ($SaltBytes.Length -eq 0 -or $IvBytes.Length -eq 0 -or $CipherBytes.Length -eq 0 -or $MacBytes.Length -eq 0) {
        throw "Incorrect password, or the file is corrupted."
    }
    # A present-but-abnormally-short salt (1-7 bytes) can make Rfc2898DeriveBytes throw an
    # unhandled/raw exception on some .NET runtimes instead of this function's clean error.
    # 8 bytes is the standard PBKDF2 salt minimum.
    if ($SaltBytes.Length -lt 8) {
        throw "Incorrect password, or the file is corrupted."
    }

    $KeyMaterial = Get-TopologyKeyMaterial -Password $Password -Salt $SaltBytes -Iterations $IterCheck

    $Hmac = [System.Security.Cryptography.HMACSHA256]::new($KeyMaterial.MacKey)
    $ComputedMac = $Hmac.ComputeHash($IvBytes + $CipherBytes)
    $Hmac.Dispose()

    # Byte-by-byte, not constant-time - acceptable given this app's threat model (localhost-
    # only server, single local operator).
    $MacOk = $ComputedMac.Length -eq $MacBytes.Length
    if ($MacOk) {
        for ($i = 0; $i -lt $ComputedMac.Length; $i++) {
            if ($ComputedMac[$i] -ne $MacBytes[$i]) { $MacOk = $false; break }
        }
    }
    if (-not $MacOk) { throw "Incorrect password, or the file is corrupted." }

    $Aes = [System.Security.Cryptography.Aes]::Create()
    $Aes.KeySize = 256
    $Aes.Key = $KeyMaterial.EncKey
    $Aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
    $Aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
    $Aes.IV = $IvBytes

    $Decryptor = $Aes.CreateDecryptor()
    $PlainBytes = $Decryptor.TransformFinalBlock($CipherBytes, 0, $CipherBytes.Length)
    $Decryptor.Dispose()
    $Aes.Dispose()

    return [System.Text.Encoding]::UTF8.GetString($PlainBytes)
}

#
# Shared AES-256-CBC + PBKDF2-SHA256 + HMAC-SHA256 (encrypt-then-MAC) envelope logic,
# used by Start-NetworkMapper.ps1 (topology snapshots) and WebServer.ps1
# (Configuration.json.enc). Mirrors web-src/topology-crypto.js's decryptEnvelope.
#
# Not meant to be run directly - dot-source it.

# Single source of truth for the iteration count (OWASP's current PBKDF2-HMAC-SHA256
# guidance), so it can't drift between crawler and webserver. A function, not a variable, so
# it resolves through however many layers of dot-sourcing sit between caller and file. Safe
# to raise: iterations is stored per-file in the envelope and read back on decrypt.
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

# IV is fresh per call; caller derives EncKey/MacKey/Salt via Get-TopologyKeyMaterial.
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

# Must stay in lockstep with web-src/topology-crypto.js's decryptEnvelope. Verifies the HMAC
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
    # PowerShell's -ne coerces the right operand to the left's type, so a JSON string "1"
    # would compare equal - the JS side's strict !== rejects it. Check the runtime type
    # explicitly to match.
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
    # Requiring a numeric runtime type (rather than parsing a string) mirrors the JS side's
    # Number.isInteger check, which rejects a JSON string like "600000".
    $IterationsValue = $Envelope.iterations
    $IsNumericType = $IterationsValue -is [int] -or $IterationsValue -is [long] -or $IterationsValue -is [double] -or $IterationsValue -is [decimal]
    if (-not $IsNumericType) {
        throw "Iteration count out of range: $($Envelope.iterations)"
    }
    # A JSON number like 1e300 parses as a double whose [long] cast throws a raw overflow
    # RuntimeException before the range check below could run - bound it as a double first.
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

    # FromBase64String("") succeeds with a 0-length array, so it escapes the catch above and
    # would surface as a raw ParameterBindingValidationException downstream instead of this
    # function's clean error.
    if ($SaltBytes.Length -eq 0 -or $IvBytes.Length -eq 0 -or $CipherBytes.Length -eq 0 -or $MacBytes.Length -eq 0) {
        throw "Incorrect password, or the file is corrupted."
    }
    # Below PBKDF2's 8-byte salt minimum, Rfc2898DeriveBytes throws a raw exception on some
    # .NET runtimes instead of this function's clean error.
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

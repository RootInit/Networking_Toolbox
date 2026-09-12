# Shared AES-256-CBC + PBKDF2-SHA256 + HMAC-SHA256 (encrypt-then-MAC) envelope logic, used by
# Start-NetworkMapper.ps1 (topology snapshots) and WebServer.ps1 (Configuration.json.enc). Mirrors
# web-src/topology-crypto.js's decryptEnvelope. Dot-source it rather than running it.

# Single source of truth for the iteration count, so it can't drift between crawler and webserver. A
# function so it resolves through dot-sourcing layers. Safe to raise: it is stored per envelope.
function Get-TopologyPbkdf2Iterations {
    return 600000
}

# The SHA-256 Rfc2898DeriveBytes overload Get-TopologyKeyMaterial needs (the 3-arg constructor is
# SHA-1 only and derives different keys) requires .NET Framework 4.7.2+. Windows Server 2016 and
# Windows 10 up to 1709 ship 4.6.2/4.7/4.7.1 by default, so this is reachable on plausible targets.
# Without the check the shortfall surfaces from inside a password-retry loop, re-prompting three
# times for something no password can fix. Called once at startup, not at dot-source time.
function Assert-TopologyCryptoRuntime {
    $Signature = [type[]]@([string], [byte[]], [int], [System.Security.Cryptography.HashAlgorithmName])
    if ($null -eq [System.Security.Cryptography.Rfc2898DeriveBytes].GetConstructor($Signature)) {
        throw "This runtime is too old for PS_NetworkMapper's encryption: Rfc2898DeriveBytes(String, Byte[], Int32, HashAlgorithmName) requires .NET Framework 4.7.2 or later. Install .NET Framework 4.7.2+ (or run under PowerShell 7), or re-run with -NoEncryption."
    }
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

# Must stay in lockstep with topology-crypto.js's decryptEnvelope. Verifies the HMAC before
# decrypting, so a wrong password fails with one clear error instead of an AES padding exception.
function Unprotect-TopologyPayload {
    param(
        [Parameter(Mandatory=$true)]$Envelope,
        [Parameter(Mandatory=$true)][string]$Password,
        [string[]]$ExpectedFormats = @("PSNetworkMapper-EncryptedTopology")
    )

    if (-not $Envelope -or $ExpectedFormats -cnotcontains $Envelope.format) {
        throw "Not a recognized encrypted file (expected one of: $($ExpectedFormats -join ', '))."
    }
    # PowerShell's -ne coerces the right operand, so a JSON string "1" compares equal - check the type.
    if ($Envelope.version -isnot [int] -and $Envelope.version -isnot [long] -and $Envelope.version -isnot [double] -and $Envelope.version -isnot [decimal]) {
        throw "Unsupported envelope version: $($Envelope.version)"
    }
    if ($Envelope.version -cne 1) {
        throw "Unsupported envelope version: $($Envelope.version)"
    }
    if ($Envelope.kdf -cne "PBKDF2-SHA256" -or $Envelope.cipher -cne "AES-256-CBC" -or $Envelope.macAlgorithm -cne "HMAC-SHA256") {
        throw "Unsupported encryption parameters: $($Envelope.kdf)/$($Envelope.cipher)/$($Envelope.macAlgorithm)"
    }
    # Same bounds as topology-crypto.js - a CPU-burn guard against a tampered file, not a security
    # boundary. A numeric runtime type is required, mirroring the JS Number.isInteger check.
    $IterationsValue = $Envelope.iterations
    $IsNumericType = $IterationsValue -is [int] -or $IterationsValue -is [long] -or $IterationsValue -is [double] -or $IterationsValue -is [decimal]
    if (-not $IsNumericType) {
        throw "Iteration count out of range: $($Envelope.iterations)"
    }
    # 1e300 parses as a double whose [long] cast throws before the range check - bound it as a double.
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

    # FromBase64String("") succeeds with a 0-length array, escaping the catch above and surfacing as
    # a raw binding exception downstream instead of this function's clean error.
    if ($SaltBytes.Length -eq 0 -or $IvBytes.Length -eq 0 -or $CipherBytes.Length -eq 0 -or $MacBytes.Length -eq 0) {
        throw "Incorrect password, or the file is corrupted."
    }
    # Below PBKDF2's 8-byte salt minimum, Rfc2898DeriveBytes throws a raw exception on some runtimes.
    if ($SaltBytes.Length -lt 8) {
        throw "Incorrect password, or the file is corrupted."
    }

    $KeyMaterial = Get-TopologyKeyMaterial -Password $Password -Salt $SaltBytes -Iterations $IterCheck

    $Hmac = [System.Security.Cryptography.HMACSHA256]::new($KeyMaterial.MacKey)
    $ComputedMac = $Hmac.ComputeHash($IvBytes + $CipherBytes)
    $Hmac.Dispose()

    # Not constant-time - acceptable for a localhost-only server with a single local operator.
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

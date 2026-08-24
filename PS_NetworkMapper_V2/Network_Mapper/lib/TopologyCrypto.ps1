#
# Shared AES-256-CBC + PBKDF2-SHA256 + HMAC-SHA256 (encrypt-then-MAC) envelope logic,
# used by both Start-NetworkMapper.ps1 (topology snapshot writes) and Start-WebServer.ps1
# (Configuration.json.enc writes via /api/save-config) - extracted so this crypto exists
# in exactly one place instead of drifting between the crawler and the webserver.
# Mirrors Network_Visualizer/src/topology-crypto.js's decryptEnvelope on the browser side.
#
# Not meant to be run directly - dot-source it.

# Single source of truth for the PBKDF2 iteration count used by every encrypted write in
# this app - topology/client/config-backup snapshots via Start-NetworkMapper.ps1, and
# Configuration.json.enc via Start-WebServer.ps1's /api/save-config. Both call sites used to
# each hardcode their own literal `600000`; harmless while they happened to agree, but it
# defeated the whole point of extracting this file in the first place (stop crypto
# parameters drifting between the crawler and the webserver). A function, not a bare
# variable, so it resolves correctly no matter how many layers of dot-sourcing sit between
# the caller and this file (Start-WebServer.ps1 dot-sources this file directly;
# Start-NetworkMapper.ps1 dot-sources both Start-WebServer.ps1 and this file) - the same
# nested dot-source chain Get-TopologyKeyMaterial/Protect-TopologyPayload below already rely
# on successfully.
#
# OWASP's current PBKDF2-HMAC-SHA256 guidance (600k, up from 310k a few years ago). Safe to
# raise without breaking old files: iterations is stored per-file in the envelope and read
# back from it on decrypt, not assumed - see MIN/MAX_ITERATIONS in topology-crypto.js's
# decryptEnvelope, which accepts anything from 200k-era files up through this.
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

# Builds an encrypted envelope from a plaintext JSON string. IV is fresh per call; the
# caller derives (and may cache/reuse across multiple calls) EncKey/MacKey/Salt via
# Get-TopologyKeyMaterial above.
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

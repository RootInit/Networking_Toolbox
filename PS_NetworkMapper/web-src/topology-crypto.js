// Decrypts a "PSNetworkMapper-EncryptedTopology" envelope (Start-NetworkMapper.ps1's default
// output unless -NoEncryption): AES-256-CBC, key/HMAC key from PBKDF2-SHA256, encrypt-then-MAC
// with HMAC-SHA256 over IV+ciphertext. Not AES-GCM: must also run under Windows PowerShell
// 5.1, whose .NET Framework lacks AesGcm. Self-contained; only caller is app.js.
var TopologyCrypto = (function() {
    function b64ToBytes(b64) {
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    function concatBytes(a, b) {
        var out = new Uint8Array(a.length + b.length);
        out.set(a, 0);
        out.set(b, a.length);
        return out;
    }

    async function deriveKeyMaterial(password, saltBytes, iterations) {
        var passBytes = new TextEncoder().encode(password);
        var baseKey = await crypto.subtle.importKey('raw', passBytes, 'PBKDF2', false, ['deriveBits']);
        var bits = await crypto.subtle.deriveBits(
            { name: 'PBKDF2', salt: saltBytes, iterations: iterations, hash: 'SHA-256' },
            baseKey, 512
        );
        var keyMaterial = new Uint8Array(bits);
        // Same 32/32 split as Protect-TopologyPayload in Start-NetworkMapper.ps1.
        return { encKeyBytes: keyMaterial.slice(0, 32), macKeyBytes: keyMaterial.slice(32, 64) };
    }

    // MIN must stay <= any real file's iteration count (currently 200,000) or it stops
    // decrypting. MAX is just a CPU-burn guard against a maliciously-crafted file, not a
    // security boundary.
    var MIN_ITERATIONS = 1000;
    var MAX_ITERATIONS = 5000000;

    async function decryptEnvelope(envelope, password, expectedFormats) {
        expectedFormats = expectedFormats || ['PSNetworkMapper-EncryptedTopology'];
        if (!envelope || expectedFormats.indexOf(envelope.format) === -1) {
            throw new Error('Not a recognized encrypted file (expected one of: ' + expectedFormats.join(', ') + ').');
        }
        if (envelope.version !== 1) {
            throw new Error(`Unsupported envelope version: ${envelope.version}`);
        }
        if (envelope.kdf !== 'PBKDF2-SHA256' || envelope.cipher !== 'AES-256-CBC' || envelope.macAlgorithm !== 'HMAC-SHA256') {
            throw new Error(`Unsupported encryption parameters: ${envelope.kdf}/${envelope.cipher}/${envelope.macAlgorithm}`);
        }
        // Validate type AND range - a tampered envelope could carry a string or float.
        if (!Number.isInteger(envelope.iterations) || envelope.iterations < MIN_ITERATIONS || envelope.iterations > MAX_ITERATIONS) {
            throw new Error(`Iteration count out of range: ${envelope.iterations}`);
        }

        var saltBytes = b64ToBytes(envelope.salt);
        var ivBytes = b64ToBytes(envelope.iv);
        var cipherBytes = b64ToBytes(envelope.ciphertext);
        var macBytes = b64ToBytes(envelope.mac);

        var keys = await deriveKeyMaterial(password, saltBytes, envelope.iterations);

        // Verify MAC before decrypting: a wrong password fails clearly here instead of
        // producing a confusing AES-CBC padding exception.
        var macKey = await crypto.subtle.importKey('raw', keys.macKeyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
        var macOk = await crypto.subtle.verify('HMAC', macKey, macBytes, concatBytes(ivBytes, cipherBytes));
        if (!macOk) throw new Error('Incorrect password, or the file is corrupted.');

        var encKey = await crypto.subtle.importKey('raw', keys.encKeyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
        var plainBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, encKey, cipherBytes);
        return new TextDecoder().decode(plainBuf);
    }

    var TopologyCryptoExports = { decryptEnvelope: decryptEnvelope };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { TopologyCrypto: TopologyCryptoExports };
    } else if (typeof window !== 'undefined') {
        window.TopologyCrypto = TopologyCryptoExports;
    }
    return TopologyCryptoExports;
})();

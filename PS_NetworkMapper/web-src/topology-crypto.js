// Decrypts a "PSNetworkMapper-EncryptedTopology" envelope: AES-256-CBC, keys from
// PBKDF2-SHA256, encrypt-then-MAC with HMAC-SHA256 over IV+ciphertext. Every parameter here
// must stay in lockstep with lib/TopologyCrypto.ps1, which writes the envelope. Not AES-GCM
// because that side must also run under Windows PowerShell 5.1, whose .NET Framework lacks
// AesGcm.
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
        // Same 32/32 split as Protect-TopologyPayload in lib/TopologyCrypto.ps1.
        return { encKeyBytes: keyMaterial.slice(0, 32), macKeyBytes: keyMaterial.slice(32, 64) };
    }

    // MIN must stay <= any real file's iteration count (the shared count is 600,000) or
    // decryption stops working. MAX is a CPU-burn guard, not a security boundary.
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
        // Type as well as range: a tampered envelope could carry a string or a float.
        if (!Number.isInteger(envelope.iterations) || envelope.iterations < MIN_ITERATIONS || envelope.iterations > MAX_ITERATIONS) {
            throw new Error(`Iteration count out of range: ${envelope.iterations}`);
        }

        // A corrupted envelope throws raw DOMExceptions here (atob on non-base64,
        // crypto.subtle.decrypt on a non-block-multiple ciphertext). Collapse them into the
        // same message as a bad MAC so no raw exception escapes and the caller cannot
        // distinguish "wrong password" from "corrupt file".
        try {
            var saltBytes = b64ToBytes(envelope.salt);
            var ivBytes = b64ToBytes(envelope.iv);
            var cipherBytes = b64ToBytes(envelope.ciphertext);
            var macBytes = b64ToBytes(envelope.mac);

            var keys = await deriveKeyMaterial(password, saltBytes, envelope.iterations);

            // MAC is verified before decrypting: a wrong password fails clearly here rather
            // than as a confusing AES-CBC padding exception.
            var macKey = await crypto.subtle.importKey('raw', keys.macKeyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
            var macOk = await crypto.subtle.verify('HMAC', macKey, macBytes, concatBytes(ivBytes, cipherBytes));
            if (!macOk) throw new Error('Incorrect password, or the file is corrupted.');

            var encKey = await crypto.subtle.importKey('raw', keys.encKeyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
            var plainBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, encKey, cipherBytes);
            return new TextDecoder().decode(plainBuf);
        } catch (err) {
            if (err instanceof Error && err.message === 'Incorrect password, or the file is corrupted.') {
                throw err;
            }
            throw new Error('Incorrect password, or the file is corrupted.');
        }
    }

    var TopologyCryptoExports = { decryptEnvelope: decryptEnvelope };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { TopologyCrypto: TopologyCryptoExports };
    } else if (typeof window !== 'undefined') {
        window.TopologyCrypto = TopologyCryptoExports;
    }
    return TopologyCryptoExports;
})();

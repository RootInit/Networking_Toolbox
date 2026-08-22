// Decrypts a "PSNetworkMapper-EncryptedTopology" envelope (Start-NetworkMapper.ps1's
// -EncryptOutput format): AES-256-CBC, key/HMAC key from PBKDF2-SHA256, encrypt-then-MAC
// with HMAC-SHA256 covering IV+ciphertext. Deliberately not AES-GCM - the PowerShell side
// has to run under Windows PowerShell 5.1 too, whose .NET Framework has no AesGcm type, so
// both ends use only primitives available everywhere: Aes/CBC, PBKDF2, HMAC-SHA256.
// Self-contained (no dependency on any other file in this app) - see app.js's
// window.promptForPassword / readSnapshotFile for the only caller.
window.TopologyCrypto = (function() {
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
        // Same 32/32 split as Protect-TopologyPayload in Start-NetworkMapper.ps1 - must match.
        return { encKeyBytes: keyMaterial.slice(0, 32), macKeyBytes: keyMaterial.slice(32, 64) };
    }

    // Bounds on iterations from an untrusted file: must stay <= the lowest iteration
    // count any real file was ever encrypted with (currently 200,000, incl. the sample
    // map already shared), or those files stop decrypting. The upper bound exists only
    // to stop a maliciously-crafted file from forcing an absurd PBKDF2 cost on whoever
    // opens it - it's a CPU-burn guard, not a security boundary (raising it doesn't
    // weaken anything; a real file just never needs to go anywhere near this high).
    var MIN_ITERATIONS = 1000;
    var MAX_ITERATIONS = 5000000;

    async function decryptEnvelope(envelope, password) {
        if (!envelope || envelope.format !== 'PSNetworkMapper-EncryptedTopology') {
            throw new Error('Not a recognized encrypted topology file.');
        }
        if (envelope.version !== 1) {
            throw new Error(`Unsupported envelope version: ${envelope.version}`);
        }
        if (envelope.kdf !== 'PBKDF2-SHA256' || envelope.cipher !== 'AES-256-CBC' || envelope.macAlgorithm !== 'HMAC-SHA256') {
            throw new Error(`Unsupported encryption parameters: ${envelope.kdf}/${envelope.cipher}/${envelope.macAlgorithm}`);
        }
        // Validate type AND range - a tampered envelope could carry a string, a float,
        // or a huge number for iterations, none of which the range check alone catches.
        if (!Number.isInteger(envelope.iterations) || envelope.iterations < MIN_ITERATIONS || envelope.iterations > MAX_ITERATIONS) {
            throw new Error(`Iteration count out of range: ${envelope.iterations}`);
        }

        var saltBytes = b64ToBytes(envelope.salt);
        var ivBytes = b64ToBytes(envelope.iv);
        var cipherBytes = b64ToBytes(envelope.ciphertext);
        var macBytes = b64ToBytes(envelope.mac);

        var keys = await deriveKeyMaterial(password, saltBytes, envelope.iterations);

        // Verify the MAC before decrypting (encrypt-then-MAC) - a wrong password or a
        // corrupted/tampered file fails here with a clear error instead of feeding
        // AES-CBC garbage ciphertext and producing a confusing padding exception.
        var macKey = await crypto.subtle.importKey('raw', keys.macKeyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
        var macOk = await crypto.subtle.verify('HMAC', macKey, macBytes, concatBytes(ivBytes, cipherBytes));
        if (!macOk) throw new Error('Incorrect password, or the file is corrupted.');

        var encKey = await crypto.subtle.importKey('raw', keys.encKeyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
        var plainBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, encKey, cipherBytes);
        return new TextDecoder().decode(plainBuf);
    }

    return { decryptEnvelope: decryptEnvelope };
})();

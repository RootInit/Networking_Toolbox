// Decrypts a "PSNetworkMapper-EncryptedTopology" envelope: AES-256-CBC, keys from PBKDF2-SHA256,
// encrypt-then-MAC with HMAC-SHA256 over IV+ciphertext. Must stay in lockstep with
// lib/TopologyCrypto.ps1. Not AES-GCM because that side also runs under Windows PowerShell 5.1.
var TopologyCrypto = (function() {
    function b64ToBytes(b64) {
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    // Decodes base64 straight into a buffer that already holds `prefix`, so the MAC input exists
    // once instead of as a separate array plus a concatenated copy. At fleet size the ciphertext is
    // tens of MB and that copy was pure waste - the same mistake lib/TopologyCrypto.ps1 made on the
    // PowerShell side, where byte-array concatenation also built a second full buffer.
    function prefixedB64ToBytes(prefix, b64) {
        var bin = atob(b64);
        var out = new Uint8Array(prefix.length + bin.length);
        out.set(prefix, 0);
        for (var i = 0; i < bin.length; i++) out[prefix.length + i] = bin.charCodeAt(i);
        return out;
    }

    // Snapshots written by one crawl session share a salt and iteration count, so autoloading an
    // archive re-derives the same key up to 20 times at 600,000 iterations each. Cached on the exact
    // inputs that determine the result; the IV is per-envelope and is not part of the key, so this
    // cannot cross envelopes. Small and bounded - it holds derived key material (and the password,
    // as part of the cache key) for the page's lifetime, which is already true of the session
    // password the server hands the browser.
    var keyCache = [];
    var KEY_CACHE_MAX = 4;

    function bytesToB64(bytes) {
        var s = '';
        for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s);
    }

    async function deriveKeyMaterial(password, saltBytes, iterations) {
        var cacheKey = iterations + ':' + bytesToB64(saltBytes) + ':' + password;
        for (var i = 0; i < keyCache.length; i++) {
            if (keyCache[i].k === cacheKey) return keyCache[i].v;
        }
        var passBytes = new TextEncoder().encode(password);
        var baseKey = await crypto.subtle.importKey('raw', passBytes, 'PBKDF2', false, ['deriveBits']);
        var bits = await crypto.subtle.deriveBits(
            { name: 'PBKDF2', salt: saltBytes, iterations: iterations, hash: 'SHA-256' },
            baseKey, 512
        );
        var keyMaterial = new Uint8Array(bits);
        // Same 32/32 split as Protect-TopologyPayload in lib/TopologyCrypto.ps1.
        var derived = { encKeyBytes: keyMaterial.slice(0, 32), macKeyBytes: keyMaterial.slice(32, 64) };
        keyCache.push({ k: cacheKey, v: derived });
        if (keyCache.length > KEY_CACHE_MAX) keyCache.shift();
        return derived;
    }

    // MIN must stay <= any real file's iteration count; MAX is a CPU-burn guard, not a boundary.
    var MIN_ITERATIONS = 1000;
    var MAX_ITERATIONS = 5000000;

    // The one failure a different password could fix. Callers re-prompt only on this flag.
    function wrongPasswordError() {
        var err = new Error('Incorrect password, or the file is corrupted.');
        err.wrongPassword = true;
        return err;
    }

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

        // A corrupted envelope throws raw DOMExceptions here (atob, or a non-block-multiple
        // ciphertext). Collapse them into the same message as a bad MAC. Everything thrown from here
        // is tagged wrongPassword; the checks above are password-independent, so they are not.
        try {
            var saltBytes = b64ToBytes(envelope.salt);
            var ivBytes = b64ToBytes(envelope.iv);
            var macBytes = b64ToBytes(envelope.mac);
            // iv||ciphertext in one buffer: the MAC is computed over the whole thing and the cipher
            // is a view into its tail, so the ciphertext is never materialized twice.
            var macInput = prefixedB64ToBytes(ivBytes, envelope.ciphertext);
            var cipherBytes = macInput.subarray(ivBytes.length);

            var keys = await deriveKeyMaterial(password, saltBytes, envelope.iterations);

            // MAC verified before decrypting: a wrong password fails clearly, not as a padding error.
            var macKey = await crypto.subtle.importKey('raw', keys.macKeyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
            var macOk = await crypto.subtle.verify('HMAC', macKey, macBytes, macInput);
            if (!macOk) throw wrongPasswordError();

            var encKey = await crypto.subtle.importKey('raw', keys.encKeyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
            var plainBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, encKey, cipherBytes);
            macInput = null; cipherBytes = null; // release before the plaintext is turned into a string
            return new TextDecoder().decode(plainBuf);
        } catch (err) {
            if (err instanceof Error && err.wrongPassword) throw err;
            throw wrongPasswordError();
        }
    }

    var TopologyCryptoExports = {
        decryptEnvelope: decryptEnvelope,
        _clearKeyCache: function() { keyCache = []; },
        _keyCacheSize: function() { return keyCache.length; }
    };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { TopologyCrypto: TopologyCryptoExports };
    } else if (typeof window !== 'undefined') {
        window.TopologyCrypto = TopologyCryptoExports;
    }
    return TopologyCryptoExports;
})();

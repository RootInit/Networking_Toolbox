import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TopologyCrypto } from '../topology-crypto.js';

const PASSWORD = 'correct-horse-battery-staple';
const ITERATIONS = 1000; // MIN_ITERATIONS in topology-crypto.js; keeps tests fast

function b64(bytes) { return Buffer.from(bytes).toString('base64'); }

async function buildEnvelope(plainJson, password, format, iterations = ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(16));

  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, baseKey, 512);
  const keyMaterial = new Uint8Array(bits);
  const encKeyBytes = keyMaterial.slice(0, 32), macKeyBytes = keyMaterial.slice(32, 64);

  const encKey = await crypto.subtle.importKey('raw', encKeyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, encKey, new TextEncoder().encode(plainJson));
  const cipherBytes = new Uint8Array(cipherBuf);

  const macKey = await crypto.subtle.importKey('raw', macKeyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const macBuf = await crypto.subtle.sign('HMAC', macKey, new Uint8Array([...iv, ...cipherBytes]));

  return {
    format, version: 1, kdf: 'PBKDF2-SHA256', iterations,
    cipher: 'AES-256-CBC', macAlgorithm: 'HMAC-SHA256',
    salt: b64(salt), iv: b64(iv), mac: b64(new Uint8Array(macBuf)), ciphertext: b64(cipherBytes),
  };
}

test('decryptEnvelope round-trips a real envelope built independently (cross-implementation check)', async () => {
  const envelope = await buildEnvelope('{"hello":"world"}', PASSWORD, 'PSNetworkMapper-EncryptedTopology');
  const plain = await TopologyCrypto.decryptEnvelope(envelope, PASSWORD);
  assert.equal(plain, '{"hello":"world"}');
});

test('decryptEnvelope defaults expectedFormats to the topology format (backward compatible)', async () => {
  const envelope = await buildEnvelope('{"a":1}', PASSWORD, 'PSNetworkMapper-EncryptedTopology');
  const plain = await TopologyCrypto.decryptEnvelope(envelope, PASSWORD); // no third arg
  assert.equal(plain, '{"a":1}');
});

test('decryptEnvelope accepts a config envelope when PSNetworkMapper-EncryptedConfig is in expectedFormats', async () => {
  const envelope = await buildEnvelope('{"devices":[]}', PASSWORD, 'PSNetworkMapper-EncryptedConfig');
  const plain = await TopologyCrypto.decryptEnvelope(envelope, PASSWORD, ['PSNetworkMapper-EncryptedConfig']);
  assert.equal(plain, '{"devices":[]}');
});

test('decryptEnvelope rejects a config envelope when only the topology format is expected', async () => {
  const envelope = await buildEnvelope('{"devices":[]}', PASSWORD, 'PSNetworkMapper-EncryptedConfig');
  await assert.rejects(
    () => TopologyCrypto.decryptEnvelope(envelope, PASSWORD), // default expectedFormats = topology only
    /Not a recognized encrypted file/
  );
});

test('decryptEnvelope rejects the wrong password with a clear error, not a crypto exception', async () => {
  const envelope = await buildEnvelope('{"x":1}', PASSWORD, 'PSNetworkMapper-EncryptedTopology');
  await assert.rejects(
    () => TopologyCrypto.decryptEnvelope(envelope, 'wrong-password'),
    /Incorrect password, or the file is corrupted/
  );
});

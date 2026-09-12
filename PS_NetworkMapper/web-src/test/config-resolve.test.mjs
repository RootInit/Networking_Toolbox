import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDeviceKeys, resolveDeviceLocation, bestKeyForSave } from '../config-resolve.js';

const STANDALONE = { DeviceIP: '10.0.0.1', Hostname: 'sw1', StackMembers: [{ Serial: 'SER1', Role: 'Standalone' }] };
const STACK = { DeviceIP: '10.0.0.2', Hostname: 'sw2', StackMembers: [{ Serial: 'S-MASTER', Role: 'Master' }, { Serial: 'S-BACKUP', Role: 'Backup' }] };
const NO_SERIAL = { DeviceIP: '10.0.0.3', Hostname: 'sw3', StackMembers: [] };
const NO_SERIAL_NO_HOSTNAME = { DeviceIP: '10.0.0.4', Hostname: 'Unknown', StackMembers: [] };

test('extractDeviceKeys reads a standalone device\'s serial', () => {
  assert.deepEqual(extractDeviceKeys(STANDALONE), { serial: 'SER1', hostname: 'sw1', ip: '10.0.0.1' });
});

test('extractDeviceKeys picks the Master member\'s serial for a stack, not Backup/Linecard', () => {
  assert.equal(extractDeviceKeys(STACK).serial, 'S-MASTER');
});

test('extractDeviceKeys returns null serial when no StackMembers entry has role Standalone or Master', () => {
  assert.equal(extractDeviceKeys(NO_SERIAL).serial, null);
});

test('extractDeviceKeys returns null hostname when Hostname is "Unknown"', () => {
  assert.equal(extractDeviceKeys(NO_SERIAL_NO_HOSTNAME).hostname, null);
});

test('extractDeviceKeys always returns ip', () => {
  assert.equal(extractDeviceKeys(NO_SERIAL_NO_HOSTNAME).ip, '10.0.0.4');
});

test('extractDeviceKeys tolerates a null/undefined element in StackMembers (malformed scan data)', () => {
  const withNulls = { DeviceIP: '10.0.0.5', Hostname: 'sw5', StackMembers: [null, { Serial: 'SER5', Role: 'Standalone' }, undefined] };
  assert.equal(extractDeviceKeys(withNulls).serial, 'SER5');
});

test('resolveDeviceLocation matches by serial first', () => {
  const entries = [
    { key: '10.0.0.1', keyType: 'ip', building: 'Wrong (stale IP-keyed entry)' },
    { key: 'SER1', keyType: 'serial', building: 'Right' },
  ];
  assert.equal(resolveDeviceLocation(STANDALONE, entries).building, 'Right');
});

test('resolveDeviceLocation falls back to hostname when no serial entry matches', () => {
  const entries = [{ key: 'sw3', keyType: 'hostname', building: 'By hostname' }];
  assert.equal(resolveDeviceLocation(NO_SERIAL, entries).building, 'By hostname');
});

test('resolveDeviceLocation falls back to ip as a last resort', () => {
  const entries = [{ key: '10.0.0.4', keyType: 'ip', building: 'By IP' }];
  assert.equal(resolveDeviceLocation(NO_SERIAL_NO_HOSTNAME, entries).building, 'By IP');
});

test('resolveDeviceLocation prefers serial over hostname when both entries exist', () => {
  const entries = [
    { key: 'sw1', keyType: 'hostname', building: 'Wrong (hostname-keyed)' },
    { key: 'SER1', keyType: 'serial', building: 'Right (serial-keyed)' },
  ];
  assert.equal(resolveDeviceLocation(STANDALONE, entries).building, 'Right (serial-keyed)');
});

test('resolveDeviceLocation prefers hostname over ip when both entries exist', () => {
  const entries = [
    { key: '10.0.0.3', keyType: 'ip', building: 'Wrong (ip-keyed)' },
    { key: 'sw3', keyType: 'hostname', building: 'Right (hostname-keyed)' },
  ];
  assert.equal(resolveDeviceLocation(NO_SERIAL, entries).building, 'Right (hostname-keyed)');
});

test('resolveDeviceLocation returns null when nothing matches', () => {
  assert.equal(resolveDeviceLocation(STANDALONE, []), null);
});

test('bestKeyForSave prefers serial when available', () => {
  assert.deepEqual(bestKeyForSave(STANDALONE), { key: 'SER1', keyType: 'serial' });
});

test('bestKeyForSave falls back to hostname when there is no serial', () => {
  assert.deepEqual(bestKeyForSave(NO_SERIAL), { key: 'sw3', keyType: 'hostname' });
});

test('bestKeyForSave falls back to ip as a last resort', () => {
  assert.deepEqual(bestKeyForSave(NO_SERIAL_NO_HOSTNAME), { key: '10.0.0.4', keyType: 'ip' });
});

// Matches a scanned device to its Configuration.json location entry. Keyed by chassis
// serial first (survives IP/hostname changes/reimaging), then hostname, then DeviceIP
// as a last resort.

// Local copy of utils.js's window.asArray - this file also runs under plain Node (see the
// dual-mode export below), where window.asArray doesn't exist. PowerShell's ConvertTo-Json
// serializes a single-element array as a bare object, so a standalone (non-stacked) switch's
// StackMembers - normally exactly one entry - arrives as {..} instead of [{..}] and must be
// normalized before .forEach, or every standalone device throws here.
function asArray(val) {
  if (Array.isArray(val)) return val;
  if (val === null || val === undefined) return [];
  return [val];
}

function extractDeviceKeys(device) {
  var serial = null;
  asArray(device.StackMembers).forEach(function (member) {
    if (member && (member.Role === 'Standalone' || member.Role === 'Master') && member.Serial) {
      serial = member.Serial;
    }
  });
  var hostname = (device.Hostname && device.Hostname !== 'Unknown') ? device.Hostname : null;
  return { serial: serial, hostname: hostname, ip: String(device.DeviceIP) };
}

function resolveDeviceLocation(device, configEntries) {
  var keys = extractDeviceKeys(device);
  var byKeyType = { serial: [], hostname: [], ip: [] };
  configEntries.forEach(function (entry) {
    if (byKeyType[entry.keyType]) byKeyType[entry.keyType].push(entry);
  });

  var tiers = [['serial', keys.serial], ['hostname', keys.hostname], ['ip', keys.ip]];
  for (var i = 0; i < tiers.length; i++) {
    var keyType = tiers[i][0], value = tiers[i][1];
    if (!value) continue;
    var match = byKeyType[keyType].find(function (e) { return e.key === value; });
    if (match) return match;
  }
  return null;
}

function bestKeyForSave(device) {
  var keys = extractDeviceKeys(device);
  if (keys.serial) return { key: keys.serial, keyType: 'serial' };
  if (keys.hostname) return { key: keys.hostname, keyType: 'hostname' };
  return { key: keys.ip, keyType: 'ip' };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { extractDeviceKeys: extractDeviceKeys, resolveDeviceLocation: resolveDeviceLocation, bestKeyForSave: bestKeyForSave };
} else if (typeof window !== 'undefined') {
    window.ConfigResolve = { extractDeviceKeys: extractDeviceKeys, resolveDeviceLocation: resolveDeviceLocation, bestKeyForSave: bestKeyForSave };
}

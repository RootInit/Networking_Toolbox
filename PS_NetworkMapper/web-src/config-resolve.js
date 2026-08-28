//
// Matches a scanned device to its Configuration.json location entry (if any). Keyed by
// chassis serial first (survives IP renumbering/hostname changes/reimaging - only the
// physical unit's own identity), hostname second, DeviceIP only as a last resort for the
// rare device whose chassis hardware never got parsed. See the geo-map-view design spec
// for why DeviceIP alone isn't durable enough for this file specifically (the rest of the
// app still keys by DeviceIP - that's a separate, existing, much larger concern).

function extractDeviceKeys(device) {
  var serial = null;
  (device.StackMembers || []).forEach(function (member) {
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

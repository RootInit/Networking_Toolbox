import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// persistence.js is browser-only (no module.exports), so it is evaluated against a minimal
// stub of just the browser surface it touches. Dark mode is the interesting part: it is the
// one preference that lives in BOTH localStorage (index.html's first-paint cache, read before
// the encrypted config can be decrypted) and Configuration.json.enc (the source of truth that
// follows the operator between browsers), so the two have to stay reconciled.
const src = fs.readFileSync(new URL('../persistence.js', import.meta.url), 'utf8');

function makeEnv({ loadedSettings = {}, checked = false, theme = 'light' } = {}) {
  const store = {};
  const elements = {
    'setting-darkMode': { checked, addEventListener(_, fn) { this._onChange = fn; } },
    'setting-junosUsername': { value: '' },
    'setting-junosPassword': { value: '' },
  };
  // Every numeric setting input, so populateSettingsInputs' loop finds a target.
  for (const key of Object.keys(NUMERIC_IDS)) elements[key] = { value: '' };

  const root = {
    attrs: { 'data-theme': theme },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
  };
  const document = {
    documentElement: root,
    getElementById: (id) => elements[id] || null,
    addEventListener() {},
  };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const saved = { settings: null, configSaves: 0 };
  const window = {
    getLoadedSettings: () => loadedSettings,
    setLoadedSettings: (s) => { saved.settings = s; },
    getLoadedCredentials: () => ({ username: '', password: '' }),
    setLoadedCredentials: () => {},
    ensureConfigLoaded: async () => true,
    saveConfiguration: async () => { saved.configSaves++; return true; },
    setStatus: () => {},
    renderCrawlAge: () => {},
    renderTrendChart: () => { saved.trendRendered = true; },
  };

  // The free globals persistence.js shares with the other page scripts.
  const fn = new Function('window', 'document', 'localStorage', 'loadedSnapshots',
    'activeSnapshotIndex', 'network', src);
  fn(window, document, localStorage, [], 0, null);

  return { window, document, localStorage, elements, root, store, saved };
}

const NUMERIC_IDS = {
  'setting-cpuWarnPct': 1, 'setting-cpuCriticalPct': 1, 'setting-memWarnPct': 1,
  'setting-memCriticalPct': 1, 'setting-crawlAgeFreshMin': 1, 'setting-crawlAgeStaleMin': 1,
  'setting-recentRebootMin': 1, clusterThreshold: 1, nodeSpacing: 1, leafSpacing: 1, minRadius: 1,
};

test('toggling dark mode applies the theme, syncs the checkbox and updates the first-paint cache', () => {
  const env = makeEnv({ theme: 'light' });
  env.window.initDarkModeToggle();
  const box = env.elements['setting-darkMode'];

  box.checked = true;
  box._onChange();

  assert.equal(env.root.getAttribute('data-theme'), 'dark');
  assert.equal(env.localStorage.getItem('darkMode'), 'dark');
  assert.equal(box.checked, true);
});

test('a darkMode saved in the configuration overrides the first-paint cache', () => {
  // Boots light (what localStorage/OS said), config says dark - the config wins.
  const env = makeEnv({ theme: 'light', loadedSettings: { darkMode: true } });
  env.window.populateSettingsInputs();

  assert.equal(env.root.getAttribute('data-theme'), 'dark');
  assert.equal(env.elements['setting-darkMode'].checked, true);
  // Written back so the next first paint has no flash.
  assert.equal(env.localStorage.getItem('darkMode'), 'dark');
});

test('a configuration saved before dark mode moved there leaves the current theme alone', () => {
  const env = makeEnv({ theme: 'dark', loadedSettings: { cpuWarnPct: 70 } });
  env.window.populateSettingsInputs();

  assert.equal(env.root.getAttribute('data-theme'), 'dark');
  assert.equal(env.localStorage.getItem('darkMode'), null, 'nothing should be written for an absent key');
});

test('saving the settings panel carries darkMode into the configuration', async () => {
  const env = makeEnv({ theme: 'light' });
  for (const id of Object.keys(NUMERIC_IDS)) env.elements[id].value = '50';
  env.elements['setting-darkMode'].checked = true;

  await env.window.saveSettingsPanel();

  assert.equal(env.saved.settings.darkMode, true);
  assert.equal(env.saved.configSaves, 1);
});

test('darkMode survives a save made while the checkbox is off (false, not dropped)', async () => {
  const env = makeEnv({ theme: 'dark', loadedSettings: { darkMode: true } });
  for (const id of Object.keys(NUMERIC_IDS)) env.elements[id].value = '50';
  env.elements['setting-darkMode'].checked = false;

  await env.window.saveSettingsPanel();

  // setLoadedSettings REPLACES the object, so an omitted key would silently revert the
  // preference to "unset" on the next save rather than recording the operator's choice.
  assert.equal(env.saved.settings.darkMode, false);
});

# Network Visualizer: Credentials & Settings in Configuration.json

Date: 2026-08-23
Status: Draft, pending user review

## Problem

Two independent, inconsistent persistence stories exist today, both worth
folding into the single encrypted `Configuration.json.enc` the geo-map-view
feature already introduced:

1. **Juniper switch login** lives in `Auth.json` (plaintext on disk,
   `Username`/`Password`/`EncryptionPassword`), read directly by four
   PowerShell files. `EncryptionPassword` is sourced from that same file so
   unattended crawls don't block on a prompt — a deliberate trade-off at the
   time, now being reversed.
2. **App settings** (fleet-health thresholds, graph-layout tuning) are
   split across two mechanisms that don't agree with each other: thresholds
   persist to `localStorage`; layout values are read live from DOM inputs
   and never persist at all, resetting to their HTML defaults on every page
   load.

This spec:
- Moves Juniper `Username`/`Password` into `Configuration.json`, optional —
  absent means every action that needs them (crawl, rescan, SSH launch)
  fails cleanly, pointing at the Settings tab, rather than prompting inline
  anywhere.
- Makes the encryption password **always** interactively entered when
  `Start-NetworkMapper.ps1` runs (crawl or server-only mode) — never read
  from a file again.
- Eliminates `Auth.json` and `-AuthFile` entirely — once Username/Password/
  EncryptionPassword all move out, nothing is left in it.
- Moves both settings groups (thresholds + layout) into `Configuration.json`
  too, replacing `localStorage` and DOM-only storage with the one encrypted,
  server-persisted file the location editor already writes to.

## Non-goals

- **PS_NetworkMapper (V1) is untouched.** It has its own independent
  `Auth.json`, its own crawler, no web UI, no `Configuration.json` concept.
  This migration is V2-only. Confirmed by checking: V1's `Connect-JunosSsh.ps1`
  is a genuinely separate copy with its own default path
  (`.\Auth.json`, not V2's shared `..\..\PS_NetworkMapper\Network_Mapper\Auth.json`).
- **No PowerShell-side interactive credential prompt for Juniper login.**
  Confirmed with the user directly: every action needing switch credentials
  (crawl, `/api/rescan`, `/api/connect`) checks `Configuration.json` and, if
  absent, fails with a message pointing at the Settings tab — it does not
  prompt inline, even where a real console is attached (`/api/connect`'s
  interactive SSH launch could technically support a prompt; the user chose
  the uniform "always fail to Settings" behavior over a special case there).
- **Device/alarm history caches (`persistence.js`'s
  `updateDeviceHistory`/`updateAlarmHistory`) stay in `localStorage`.**
  These are large, auto-rebuilding derived caches keyed off whatever
  snapshots happen to be loaded this session, not user-configured settings —
  "everything in Settings" means the `#sidebar-tab-settings` tab's own
  fields (thresholds + layout), not the Analysis Dashboard's history.
- **The `Scan Network` browser button and last-scan file-path features are
  separate, later work.** The button depends on this spec (it needs
  server-side access to stored Juniper credentials); the file-path/
  "prepopulate browse" idea was explicitly dropped by the user.
- **`-NoEncryption` still exists**, but only controls whether *this run's
  topology-snapshot output* gets encrypted — it no longer skips the password
  prompt. Credentials now live exclusively in encrypted `Configuration.json`,
  so a crawl needs the password to read them regardless of `-NoEncryption`;
  server-only mode needs it too, for `/api/save-config`. Caught during this
  spec's self-review: an earlier draft had `-NoEncryption` skip the prompt
  entirely, which would have made crawling with `-NoEncryption` silently
  incompatible with ever having stored credentials to read. "Always manually
  entered" is taken literally — the prompt is now unconditional whenever
  `Start-NetworkMapper.ps1` runs, in both modes.

## Architecture

### 1. `Configuration.json`'s decrypted shape

```json
{
  "devices": [ { "key": "...", "keyType": "serial", "lat": 0, "lng": 0, "building": "", "room": "", "notes": "" } ],
  "credentials": { "username": "", "password": "" },
  "settings": {
    "cpuWarnPct": 70, "cpuCriticalPct": 90, "memWarnPct": 75, "memCriticalPct": 90,
    "crawlAgeFreshMin": 60, "crawlAgeStaleMin": 1440, "recentRebootMin": 60,
    "clusterThreshold": 50, "nodeSpacing": 350, "leafSpacing": 250, "minRadius": 250
  }
}
```

`credentials` may be absent entirely, or present with empty/partial fields —
any consumer treats "both `username` and `password` are non-empty strings"
as the only "configured" state; anything else is "not configured." `settings`
missing entirely, or missing individual keys, falls back to today's hardcoded
defaults per-key (same merge-over-defaults approach `persistence.js`
already uses for thresholds).

### 2. PowerShell gains decrypt capability

New `Unprotect-TopologyPayload` in `TopologyCrypto.ps1`, the mirror of
`topology-crypto.js`'s `decryptEnvelope`: given an envelope object and a
password, derive keys from the envelope's own stored salt/iterations,
verify the HMAC (fail closed — wrong password / tampered file both surface
as one clear "decryption failed" condition, matching the browser's
behavior), AES-CBC decrypt, return the plaintext JSON string. This is new
capability — until now only the browser ever decrypted anything; the
PowerShell side only ever encrypted.

### 3. `Start-NetworkMapper.ps1` startup sequence

Runs in both crawl mode (`-SwitchIP` given) and server-only mode, before
either branches:

1. Always prompt (`Read-Host -AsSecureString`) for the encryption password —
   unconditional, both modes, regardless of `-NoEncryption` (see Non-goals
   for why an earlier draft's `-NoEncryption`-skips-the-prompt idea was
   wrong).
2. If `Configuration.json.enc` exists, attempt `Unprotect-TopologyPayload`
   with the entered password. On success: parse JSON, extract
   `.credentials` (may be null) and `.settings` (may be partial) into
   script-scoped variables for this run. On failure (HMAC mismatch): show a
   clear mismatch warning, re-prompt (a small retry budget, e.g. 2 more
   attempts) — a retry's password becomes the one password for the rest of
   this run, used both for re-attempting this decrypt and for this run's
   own topology-write encryption (if not `-NoEncryption`). After retries
   are exhausted, ask whether to continue with no server-side credentials/
   settings, or abort.
3. If `Configuration.json.enc` doesn't exist: nothing to decrypt, proceed
   with empty credentials and default settings.
4. Derive this run's `EncKey`/`MacKey` from the entered password, for
   topology-snapshot writes — skipped only if `-NoEncryption` was passed
   (plain `.json` output, no encryption keys needed for that part); the
   password itself was still collected in step 1 regardless, for step 2's
   `Configuration.json.enc` read.
5. **Crawl mode only:** if Username/Password aren't both present after step
   2/3, throw immediately, before the crawl loop starts: *"No Juniper login
   configured — set it in the Settings tab of the web viewer, then run a
   crawl."* Crawling every device needs SSH credentials; there's no partial
   crawl to attempt without them, and this holds regardless of
   `-NoEncryption` (that flag only affects topology-write encryption, not
   whether credentials are needed to crawl at all).
6. **Server-only mode:** proceeds regardless of whether credentials are
   present — browsing existing snapshots needs no switch credentials, same
   reasoning as today's `Auth.json`-existence check being skipped for this
   branch. The password collected in step 1 is still needed here for any
   future `/api/save-config` call this session.

### 4. Credential consumers change from "read `Auth.json`" to "receive a value"

- **`Get-JunosNodeData.ps1`** (runs via `[powershell]::Create()` in a
  runspace pool — a thread within the *same process*, not a separate OS
  process, for both the crawl loop and `/api/rescan`): drops its own
  `-AuthFile`/`Get-JunosAuth` call entirely, takes `-Username`/`-Password`
  as mandatory parameters instead, passed via `.AddParameter(...)` directly
  from in-memory strings — this already never touches a command line or a
  temp file, no change needed to that plumbing.
- **`Connect-Switch.ps1`** (launched via `Start-Process powershell.exe` — a
  genuinely separate OS process, for `/api/connect`'s interactive SSH
  session) can't receive credentials via in-memory parameter binding the
  same way. New paired helpers in `Connect-JunosSsh.ps1`, `New-JunosCredentialFile`/
  `Remove-JunosCredentialFile`, mirror the existing `New-JunosAskPass`/
  `Remove-JunosAskPass` pattern exactly: `Invoke-ConnectAction` writes
  `{Username, Password}` to a short-lived `%TEMP%` file right before
  `Start-Process`, passes only its *path* as `-CredentialFile`;
  `Connect-Switch.ps1` reads it, uses the values, deletes the file itself
  in a `finally` block (same "shortest possible plaintext-on-disk window,
  owned by the reader, cleaned up even on error" posture as the existing
  askpass files — not a new exposure, the same one already accepted for the
  SSH password itself, now covering the credential handoff too instead of
  a file path).
- **`Connect-JunosSsh.ps1`**: `Get-JunosAuth` is deleted (nothing reads
  `Auth.json` anymore). `New-JunosAskPass`/`Remove-JunosAskPass`/
  `Get-JunosSshArgs` are unchanged.
- **`Start-WebServer.ps1`**: `Start-MapperWebServer` gains
  `-JunosUsername`/`-JunosPassword` (optional strings) and
  `-EncryptionPassword` (mandatory string) parameters, replacing `-AuthFile`
  entirely.
  - `Invoke-ConnectAction`/`Invoke-RescanAction`: check Username+Password
    presence *before* doing anything else; if either is missing, respond
    with a 400 and the same clear message as the crawl-mode check above,
    and don't touch the runspace pool / `Start-Process` at all.
  - `Invoke-SaveConfigAction`: uses the passed-in `$EncryptionPassword`
    instead of reading `Auth.json`.
  - `Invoke-GetConfigAction`: unchanged — still serves the raw encrypted
    bytes; the browser decrypts independently with its own prompt, exactly
    as today.

### 5. `Auth.json` elimination

`-AuthFile` and every `Test-Path`/`Get-Content` reference to it removed
from `Start-NetworkMapper.ps1`, `Start-WebServer.ps1`, `Connect-Switch.ps1`,
`Get-JunosNodeData.ps1`, `Connect-JunosSsh.ps1`. `Auth.example.json` and the
`.gitignore` line for the real `Auth.json` are removed too (V2-side only —
V1's own `Auth.json`/`Auth.example.json` are untouched, see Non-goals).

### 6. Browser: Settings tab becomes `Configuration.json`-backed

- New Username/Password fields added to `#sidebar-tab-settings`, under a
  new subhead (matching the existing `.settings-subhead` convention already
  used for "Fleet Health Thresholds"/"Graph Layout").
- `map.js` already owns the one decrypted config object and its load/save
  machinery (`loadMapConfiguration`, `saveConfiguration`, the `mapConfigEntries`
  array). That gets generalized to hold the *whole* parsed object
  (`devices`/`credentials`/`settings`), not just the devices array — the
  location editor's existing save flow already merges pending device edits
  into whatever was loaded; credentials and settings become two more pieces
  of that same merged object, written back on every save regardless of
  which tab triggered it.
- `persistence.js`'s threshold functions (`loadSettings`/`saveSettings`/
  `populateSettingsInputs`/`saveSettingsPanel`/`resetSettingsPanel`) stop
  touching `localStorage` and instead read/write through that same shared
  config object. `graph.js`'s `getClusterThreshold`/`getLayoutSettings`
  keep reading live from the DOM (unchanged — still correct, still avoids
  the stale-cache bug their own comments describe), but the DOM inputs
  themselves now get *populated* from the loaded config (on Settings-tab
  open) instead of sitting at their static HTML defaults forever.
- **Config loading trigger widens.** Today, `loadMapConfiguration()` only
  ever fires lazily on first switch to Map view. It needs to fire on first
  access to *either* Map view or the Settings tab, whichever comes first —
  both check the same "already loaded" flag, so the password prompt and
  fetch only ever happen once per session regardless of entry point.
- Saving the Settings tab (`saveSettingsPanel`) now goes through the same
  `/api/save-config` round trip the location editor already uses, not a
  separate `localStorage.setItem` call.

## New / changed files

- Changed: `TopologyCrypto.ps1` (`Unprotect-TopologyPayload`)
- Changed: `Start-NetworkMapper.ps1` (password prompt, config decrypt,
  credential-presence check, `-AuthFile` removed)
- Changed: `Start-WebServer.ps1` (`-JunosUsername`/`-JunosPassword`/
  `-EncryptionPassword` params, presence checks in `Invoke-ConnectAction`/
  `Invoke-RescanAction`, `-AuthFile` removed)
- Changed: `Connect-JunosSsh.ps1` (`Get-JunosAuth` removed, new
  `New-JunosCredentialFile`/`Remove-JunosCredentialFile`)
- Changed: `Connect-Switch.ps1` (`-CredentialFile` replaces `-AuthFile`)
- Changed: `Get-JunosNodeData.ps1` (`-Username`/`-Password` replace `-AuthFile`)
- Removed: `Auth.json` (runtime, was never committed), `Auth.example.json`,
  the `.gitignore` line for it (V2-side only)
- Changed: `map.js` (config object generalized beyond just `devices`)
- Changed: `persistence.js` (threshold functions become config-backed, not
  localStorage-backed)
- Changed: `network_vis.html` (Username/Password fields in Settings tab)
- Unchanged (confirmed in scope check): `graph.js`'s live-DOM-read approach
  for layout settings, `Invoke-GetConfigAction`, device/alarm history
  localStorage caches, all of V1 (`PS_NetworkMapper/`)

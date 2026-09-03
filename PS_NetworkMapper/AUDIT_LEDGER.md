# AUDIT_LEDGER.md — PS_NetworkMapper Full-Depth Audit

## Repo map
- **Backend**: PowerShell 7 (`Start-NetworkMapper.ps1` entry point; `lib/*.ps1`).
  - `lib/WebServer.ps1` (1023 lines) — local HTTP server, dispatches JSON API requests, spawns PowerShell runspaces for background scan/crawl/ping jobs, serves the web UI.
  - `lib/FleetCrawl.ps1` (513) — orchestrates crawling a fleet of switches over SSH/LLDP to build topology.
  - `lib/Get-JunosNodeData.ps1` (609) — SSHes into a single Junos device, parses CLI output into structured node data.
  - `lib/Connect-Switch.ps1` — opens an interactive/managed SSH session to a real switch (direct command-and-control path to production hardware).
  - `lib/SshHelpers.ps1` (85) — credential file / askpass helpers for SSH auth; temp file cleanup.
  - `lib/TopologyCrypto.ps1` (177) / `web-src/topology-crypto.js` (93) — AES encryption of topology/config files; two independent implementations (PS write path, JS read path in-browser) that must round-trip.
  - `lib/Protect-MapperFile.ps1` (125) — wraps files in the encrypted envelope.
  - `lib/Update-OuiDatabase.ps1` — MAC OUI vendor lookup DB updater.
- **Frontend**: vanilla JS served by WebServer.ps1, no build step beyond `web-src/tools/build-inline.mjs`.
  - `web-src/dashboard.js` (904), `web-src/drawer.js` (1084), `web-src/map.js` (725, Leaflet), `web-src/graph.js` (431) + `graph-layout.js` (535) + `elk-layout.js` (115) (topology graph rendering/layout), `app.js` (531, top-level wiring), `persistence.js` (265), `config-resolve.js`, `scan-network.js`, `search.js`, `utils.js`.
  - Tests: `web-src/test/*.test.mjs`, run via Node's built-in `node --test` (no package.json/build tool — plain ESM).
- **Data**: `Network_Maps/` — persisted, encrypted topology snapshots (user's actual network inventory; loss/corruption is data loss of something not easily re-crawlable if devices are offline/changed).
- No MCU/firmware/RTOS code — **EMBEDDED track not applicable** in the literal sense, but `Connect-Switch.ps1` / `Get-JunosNodeData.ps1` / `FleetCrawl.ps1` are a direct command-and-control path to real network hardware (production switches), so category-39-style reasoning ("can any failure mode prevent a valid command from reaching the device, or corrupt what's sent") is applied under CORE/SERVICE instead.

## Critical invariants
1. **INV-DATA**: A saved `Network_Maps` topology file is never silently corrupted or unrecoverable — encrypt (PS) → decrypt (JS) round-trips exactly, and a failed decrypt/save never destroys the prior good file.
2. **INV-CREDS**: SSH credentials (password/keys) used to reach switches are never left behind in plaintext on disk (temp cred files, askpass scripts) beyond the single operation's lifetime, and never logged.
3. **INV-CMDPATH**: Commands the operator issues against a real switch (via `Connect-Switch.ps1` / crawl operations) reach the device as intended — no injection, truncation, or silent misrouting to the wrong device/IP.
4. **INV-JOBS**: Background runspace jobs (scan/crawl/ping) spawned by `WebServer.ps1` are always cleaned up — no leaked SSH sessions/processes/runspaces on error, cancel, or client disconnect.
5. **INV-UI-TRUTH**: The dashboard/map/graph never presents stale or misinterpreted device data as current truth (e.g. previously found: `Uptime` field is a boot timestamp, not a duration — display code must not treat it as elapsed time).
6. **INV-NO-LOCKOUT**: The operator is never locked out of their own topology data (e.g. wrong/forgotten-password handling on encrypted files fails safely with a clear path forward, not data loss).

## Tracks active
CORE, USER-FACING, SERVICE (local HTTP server + background jobs), DATA (encrypted persistence). EMBEDDED not literally applicable; command-and-control-path categories folded into CORE/SERVICE.

## Baseline
- `cd web-src && node --test` → **80 tests, 80 pass, 0 fail**, 833ms. (2026-09-02)
- No PowerShell test suite exists (no Pester tests found). `pwsh` 7.6.2 available via `nix develop`-free PATH (`/run/current-system/sw/bin/pwsh`).
- No `package.json` / build step for web-src beyond `web-src/tools/build-inline.mjs` (inlines JS into `lib/Network_Visualizer.html`? — verify in Phase 1).
- Working tree clean at start (git status: clean, branch main, HEAD c531285).

## Prior context (from repo history / memory, not re-litigated as bugs)
- 3 prior "multi-agent debugging pass" commits already landed (c531285, ee8e125, 1c3fae9) — this audit is pass 1 of a *new*, more exhaustive protocol; do not assume prior passes were exhaustive.
- Known-resolved-as-not-a-bug: map coordinate wrong-hemisphere pins = operator data entry, not renderer bug.
- Known-resolved-as-not-a-bug: `device.Uptime` = boot timestamp string, reboot-detection equality check is correct as written. (Still worth re-verifying no *new* code path misuses `Uptime` as a duration — see INV-UI-TRUTH.)

## Risk ranking (initial, by size/churn/domain sensitivity)
1. `lib/WebServer.ps1` — largest backend file, request dispatch + concurrency + job lifecycle (INV-JOBS, INV-CMDPATH, INV-CREDS surface)
2. `lib/TopologyCrypto.ps1` + `web-src/topology-crypto.js` — dual-implementation crypto, INV-DATA/INV-NO-LOCKOUT
3. `web-src/drawer.js`, `web-src/dashboard.js` — largest frontend files, most direct operator-facing surface
4. `lib/Get-JunosNodeData.ps1`, `lib/FleetCrawl.ps1`, `lib/Connect-Switch.ps1`, `lib/SshHelpers.ps1` — SSH/command-and-control path, INV-CMDPATH/INV-CREDS
5. `web-src/graph-layout.js`/`elk-layout.js`/`map.js`/`graph.js` — rendering correctness, already had one major shear-bug fix (a238c3c) and layout-algorithm regressions (per test comments) — recently fragile
6. `lib/Protect-MapperFile.ps1`, `web-src/persistence.js`, `web-src/config-resolve.js` — file save/load paths, INV-DATA
7. Everything else (search.js, utils.js, scan-network.js, Update-OuiDatabase.ps1)

## Findings table (Phase 1 complete, all 7 category agents returned; full detail in .claude/audit-findings-*.md)
| ID | Track | File:line | Severity | Verdict | Notes |
|----|-------|-----------|----------|---------|-------|
| SSH-001 | CORE/SERVICE | SshHelpers.ps1:76-85, Connect-Switch.ps1:42 | CRITICAL | pending verify | Username unvalidated, interpolated into ssh.exe cmdline → ProxyCommand injection |
| SSH-002 | CORE/SERVICE | Get-JunosNodeData.ps1:35 | CRITICAL | pending verify | Same username also routed through cmd.exe /c on every crawl (wider injection) |
| SEC-3 | SERVICE | Get-JunosNodeData.ps1:35, SshHelpers.ps1:84 | INFO | pending verify | Independent corroboration of SSH-001/002 root cause — merge into SSH-001/002 |
| CRYPTO-001 | DATA | Protect-MapperFile.ps1:94,123 | HIGH | pending verify | In-place Out-File write, no temp+rename; crash mid-write truncates operator's only copy |
| WS-1 | SERVICE | WebServer.ps1:1004-1022 | HIGH | pending verify | Unguarded .Dispose() in shutdown finally can abort cleanup, leaking live SSH session to a switch |
| UX-001 | USER-FACING | scan-network.js:70-81 | HIGH | pending verify | Fleet-wide SSH crawl fires with zero confirmation |
| UX-002 | USER-FACING | app.js / drawer.js polling | HIGH | pending verify | Page refresh mid-crawl loses job state; reattach shows 409 as failure |
| CFG-001 | CORE | Start-NetworkMapper.ps1:6, FleetCrawl.ps1:318-327 | HIGH | pending verify | Hardcoded org IP scope silently drops out-of-scope neighbors, no log |
| CFG-002 | CORE | web-src/tools/build-inline.mjs | HIGH | pending verify | Build exits 0 on failed inline (reproduced live by agent) |
| CFG-003 | DATA | topology-crypto.test.mjs | HIGH (coverage gap) | pending verify | Zero test coverage of version/kdf/cipher validation despite 3 prior debug passes touching this file |
| WS-2 | SERVICE | WebServer.ps1:191-198,247-254 | MEDIUM | pending verify | Late-completing orphaned job results silently discarded, no log |
| SEC-1 | CORE | SshHelpers.ps1:14-45 | MEDIUM | pending verify | Plaintext SSH cred temp files, no explicit ACL |
| UX-003 | USER-FACING | app.js:16-28 | MEDIUM | pending verify | Uncaught JS errors shown as raw stack dump |
| UX-004 | USER-FACING | dashboard.js | MEDIUM | pending verify | Warn/critical severity conveyed by color only |
| UX-005 | USER-FACING | drawer.js tabs | MEDIUM | pending verify | Tabs/close button not keyboard-reachable |
| UX-006 | USER-FACING | dashboard.js:147-161,222-225 | MEDIUM | pending verify | "None." conflates zero-reboots with uncomputable |
| CRYPTO-002 | DATA | topology-crypto.js:33 | LOW | pending verify | Stale iteration-count comment (doc drift only) |
| GRAPH-001 | USER-FACING | map.js | LOW | pending verify | Dangling `once` click listener on rearmed marker teardown |
| GRAPH-002 | CORE | graph.js extractVlans | LOW | pending verify | VLAN string/number mismatch risk (author flags low confidence) |
| SEC-2 | CORE | app.js:16-28 | LOW | pending verify | Unescaped innerHTML in window.onerror handler — same code as UX-003, merge |
| CFG-004 | CORE | (repo-wide) | LOW | pending verify | No PowerShell test suite at all |
| CFG-005 | CORE | graph-layout.test.mjs:56-69 | LOW | pending verify | Loose assertion can't catch tie-break regression |
| CFG-006 | CORE | elk-layout.test.mjs | LOW | pending verify | Fallback/catch path in elk-layout.js never tested |

Note: SEC-3 duplicates SSH-001/002 root cause (independently found) — verify once under SSH-001/002. SEC-2 and UX-003 are the same code location (app.js:16-28) found from two angles — verify once, keep both severity notes.

## Phase 2 verdicts (final, adjudicated where verifiers disagreed)
| ID | Verdict | Final severity | Fix group |
|----|---------|-----------------|-----------|
| SSH-001 | CONFIRMED (2 verifiers + 3rd adjudicator; disagreed Critical vs Medium, resolved via CSRF/cross-principal analysis neither original verifier weighed) | HIGH | 1 |
| SSH-002 | CONFIRMED (same adjudication) | HIGH | 1 |
| SEC-3 | duplicate of SSH-001/002, no separate fix | — | 1 |
| CRYPTO-001 | CONFIRMED | HIGH | 2 |
| CRYPTO-002 | CONFIRMED (doc drift only) | LOW | 2 |
| CFG-003 | CONFIRMED (coverage gap, reproducible) | HIGH | 2 |
| WS-1 | **REJECTED** — verifier empirically tested `PowerShell.Dispose()` on Running/Stopping/double-dispose/pool-closed, never throws; no live trigger for the claimed cleanup-abort | — | — |
| WS-2 | CONFIRMED | MEDIUM | 3 |
| CFG-001 | CONFIRMED | HIGH | 3 |
| CFG-002 | CONFIRMED (reproduced live) | HIGH | 3 |
| UX-001 | CONFIRMED | HIGH | 4 |
| UX-002 | CONFIRMED | HIGH | 4 |
| UX-003 | CONFIRMED but DOWNGRADED to LOW (has working dismiss, rare trigger) | LOW | 5 (optional) |
| UX-004 | CONFIRMED | MEDIUM | 5 |
| UX-005 | CONFIRMED | MEDIUM | 5 |
| UX-006 | CONFIRMED | MEDIUM | 5 |
| SEC-1 | CONFIRMED | MEDIUM | 6 |
| SEC-2 | CONFIRMED (real sink, currently unreachable — defense in depth) | LOW/MEDIUM | 6 |
| GRAPH-001 | CONFIRMED | LOW | 6 |
| GRAPH-002 | DOWNGRADED to informational (VLAN_Tag producer regex-constrained to \d+, trigger condition can't occur against real Junos output) | INFO | 6 (cheap defensive fix, optional) |
| CFG-004 | CONFIRMED (no PS test suite at all) | LOW | **ESCALATE** — standing up Pester is a design-scope addition, not a minimal-diff fix; recommend in final report, do not auto-implement |
| CFG-005 | CONFIRMED (reproduced live) | LOW | 7 |
| CFG-006 | CONFIRMED | LOW | 7 |

## Fix groups for Phase 3 (severity order: HIGH group 1-4, then MEDIUM/LOW 5-7)
1. SSH-001/002 — lib/SshHelpers.ps1, lib/Connect-Switch.ps1, lib/Get-JunosNodeData.ps1: validate Username server-side + eliminate raw string-Arguments injection surface
2. CRYPTO-001/002/CFG-003 — lib/Protect-MapperFile.ps1 (temp+rename), topology-crypto.js comment fix, add version/kdf/cipher/iterations validation tests
3. WS-2/CFG-001/CFG-002 — WebServer.ps1 logging, FleetCrawl.ps1 scope-drop logging, build-inline.mjs fail-loud
4. UX-001/UX-002 — scan-network.js confirm dialog, app.js/drawer.js reattach-on-load
5. UX-004/005/006 (+ UX-003 optional) — dashboard.js/drawer.js/index.html
6. SEC-1/SEC-2/GRAPH-001(/GRAPH-002 optional) — SshHelpers.ps1 ACL, app.js textContent, map.js listener cleanup
7. CFG-005/CFG-006 — test-only fixes, no production code change

## Phase 3 fix-review (combined diff, run after all 7 fix agents completed)
Fix-review agent found all fixes correct except one: **UX-005b (new, LOW/MEDIUM)** — sidebar tabs got `role="tab"`/keyboard handling but no `aria-selected` wiring (unlike drawer tabs, which correctly got it in the same diff), and `lib/Network_Visualizer.html` (the artifact WebServer.ps1 actually serves) had drifted from `index.html` — hand-edited with `aria-selected` markup that didn't exist in source and was never toggled by JS, rather than being regenerated from a fixed source. **Fixed directly**: added `aria-selected` toggling to `switchSidebarTab` (app.js) and initial `aria-selected="true/false"` attributes to the sidebar tabs (index.html), matching the drawer-tab pattern exactly, then regenerated `lib/Network_Visualizer.html` via the real `build-inline.mjs` build (not hand-edited). Full suite re-confirmed 91/91 after this fix.

Two other items surfaced by fix-review, judged non-blocking, logged for awareness (not fixed — informational/deferred):
- SSH-001/002's username validation regex (`^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`) rejects realm-qualified usernames (`user@realm`, used by some TACACS+/RADIUS shops) and caps length below Junos's real 64-char limit. Does not lock out already-saved credentials (validation is save-path-only). Flagged as a possible follow-up if this deployment actually needs such usernames — deferred to the human, not auto-loosened, since loosening a freshly-closed injection surface without knowing the real requirement is exactly the kind of judgment call that shouldn't be guessed.
- `Protect-MapperFile.ps1`'s new temp+rename doesn't clean up the `.tmp` file if `Move-Item` itself fails after a successful `Out-File` — could leak a stray `.tmp` in Network_Maps/ on a rare permission/lock failure. Cosmetic disk-clutter only, does not violate INV-DATA (original file is untouched either way). Deferred as LOW.

WS-1 remains REJECTED (not fixed — no real bug, see Phase 2 verdicts).

## Pass counter (final)
Pass 1: complete. 23 raw findings → 21 unique after dedup → 20 CONFIRMED (1 REJECTED: WS-1, 1 downgraded to informational: GRAPH-002 but still given a cheap defensive fix) → 19 fixed + 1 new finding from fix-review (UX-005b) also fixed = 20 total fixes landed. Full test suite: 80 → 91 passing (11 new regression tests added). Not yet at the 2-consecutive-clean-passes termination condition — see final report for residual risk / recommended next pass scope.

## User request (out-of-band, handled directly, not part of audit findings)
User asked to remove any code migrating previous scan/config formats. Searched whole repo (envelope `version`/`format` handling in TopologyCrypto.ps1/topology-crypto.js/Protect-MapperFile.ps1, persistence.js localStorage keys, app.js snapshot loading) — **no migration code exists**. Envelope version check is strict (`version === 1`, no fallback/upgrade path). persistence.js's `_v2` localStorage key bump deliberately abandons old entries rather than migrating them (already the "no migration" behavior). Nothing to remove. (2026-09-02)

## Pass counter
Pass 1: IN PROGRESS (Phase 1 dispatched, 6/7 category agents returned)

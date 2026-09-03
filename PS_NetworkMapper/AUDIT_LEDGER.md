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

## Pass counter
Pass 1: complete, committed (10 commits, `13736ee`..`949e803`). 23 raw findings → 21 unique after dedup → 20 CONFIRMED (1 REJECTED: WS-1, 1 downgraded to informational: GRAPH-002 but still given a cheap defensive fix) → 19 fixed + 1 new finding from fix-review (UX-005b) also fixed = 20 total fixes landed. Full test suite: 80 → 91 passing (11 new regression tests added).

## Pass 2 — re-ranked risk (files touched by Pass 1 fixes move to top, per protocol)
1. `lib/WebServer.ps1` — SSH-001/002 username validation + WS-2 logging landed here; re-scan for the escalated regex-strictness concern and any new bug from the fix itself
2. `lib/SshHelpers.ps1` — SEC-1 ACL fix landed here
3. `lib/Protect-MapperFile.ps1` — CRYPTO-001 temp+rename landed here
4. `lib/FleetCrawl.ps1` — CFG-001 logging landed here
5. `web-src/scan-network.js`, `web-src/app.js`, `web-src/index.html` — UX-001/002/SEC-2/UX-005b landed here (most files touched by any single fix group, highest re-scan priority for interaction bugs)
6. `web-src/dashboard.js`, `web-src/drawer.js`, `web-src/utils.js` — UX-004/005/006 landed here
7. `web-src/map.js`, `web-src/graph.js` — GRAPH-001/002 landed here
8. `web-src/tools/build-inline.mjs` — CFG-002 landed here
9. `web-src/test/*.mjs`, `lib/Network_Visualizer.html` — test/generated-artifact changes, lower priority (test-only / derived)
10. Everything not touched by Pass 1 fixes (Connect-Switch.ps1, Get-JunosNodeData.ps1, Update-OuiDatabase.ps1, Start-NetworkMapper.ps1, search.js, config-resolve.js, persistence.js, elk-layout.js, graph-layout.js) — re-scan per protocol ("do not skip categories because we already looked there"), lower priority than fixed files but not zero

## Pass 2 — Phase 1 complete (all 7 agents returned)
16 raw findings, deduplicated to 11 unique clusters (2 pairs independently corroborated by different agents — strong signal):

| Cluster ID | Merged from | Track | Severity | Claim |
|---|---|---|---|---|
| P2-SSH-STARTUP | P2SSH-1 + P2WS-001 (independently found twice) | CORE/SERVICE | HIGH | SSH-001/002's username validation only runs at the web save endpoint; `Start-NetworkMapper.ps1` loading `Configuration.json(.enc)` at startup, and the CLI crawl path, reach `ssh.exe`/`cmd.exe` with a completely unvalidated username |
| P2WS-002 | P2WS-002 | SERVICE | LOW | WS-2's logging fix only covered 2 of 4 structurally identical silent-discard sites in WebServer.ps1 |
| P2-ACL-SILENT | P2SSH-2 + P2REC-003 (independently found twice) | CORE | LOW/MED | `Protect-JunosTempFileAcl` (SEC-1 fix) fails open with a bare `catch {}` — an ACL-hardening failure is invisible, in the same commit that fixed an identical pattern (WS-2) elsewhere |
| P2CRYPTO-001 | P2CRYPTO-001 | DATA | HIGH | CRYPTO-001's "atomic" `Move-Item -Force` isn't atomic on overwrite — strace-confirmed `unlink(dest)` then `rename(tmp,dest)` as separate syscalls; a kill in that gap leaves the target file entirely gone |
| P2CRYPTO-002 | P2CRYPTO-002 | DATA | MEDIUM | Fixed temp filename (no per-run uniqueness, no try/finally) unlike the FleetCrawl.ps1 pattern it claims to follow — concurrent-run collision + orphaned `.tmp` on failure |
| P2FRESH-001 | P2FRESH-001 | CORE | HIGH | `Get-JunosNodeData.ps1`'s `New-JunosAskPass` call sits outside its own try/finally (unlike the correct sibling in Connect-Switch.ps1) — plaintext askpass file orphaned up to 4h on failure, INV-CREDS |
| P2FRESH-002 | P2FRESH-002 | DATA | MEDIUM | `Update-OuiDatabase.ps1` writes in place with no temp+rename — same failure class as original CRYPTO-001, never scanned in Pass 1 (low-priority file) |
| P2DASH-001/002 | P2DASH-001 + P2DASH-002 | USER-FACING | MED/HIGH | The Diagram/Map center-panel toggle shares drawer.js's `.tab` class (selector collision, pre-existing) but UX-005's keyboard fix never touched it — now also getting invalid `aria-selected` stamped on it by drawer.js's `switchTab` |
| P2DASH-003 | P2DASH-003 | USER-FACING | MEDIUM | UX-006's fix only gates at snapshot level (`scanTimestamp` present); a snapshot with a timestamp but zero devices with valid `Uptime` still renders "None." — same conflation one level deeper |
| P2SCAN-CLUSTER | P2SCAN-001 + P2SCAN-002 + P2REC-002 (independently found 3x from different angles) | USER-FACING | HIGH | UX-002's reattach fix has no sequencing against `autoloadLastScan` (deterministic stale-data-shown-as-success on mid-scan refresh with a prior snapshot) and `pollRunningScan` has no re-entrancy guard (shared timer var lets concurrent loops cancel each other) |
| P2REC-001 | P2REC-001 | — | LOW/informational | Pass 1 commit `804e8c6`'s message doesn't mention UX-005 though its diff includes UX-005 markup, and `5c4058d`'s message claims tabindex/role work its diff doesn't contain — intermediate commits reference `activateOnKey` before it's defined. HEAD is fine (bisect-hygiene issue only, not a live bug) |

## Pass 2 — Phase 2 verification: COMPLETE, all 11 clusters CONFIRMED
- P2-SSH-STARTUP (HIGH): CONFIRMED — validation only exists at WebServer.ps1's save endpoint; every other path (startup config load, CLI crawl) reaches ssh.exe/cmd.exe unvalidated.
- P2WS-002 (LOW): CONFIRMED — 2 of 4 identical silent-discard sites still unfixed.
- P2-ACL-SILENT (LOW/MED): CONFIRMED, slightly stronger — no logging function is even in scope in SshHelpers.ps1/Get-JunosNodeData.ps1/Connect-Switch.ps1, so this needs a small plumbing addition, not a one-liner.
- P2CRYPTO-001 (HIGH): CONFIRMED via independent strace re-repro (not just re-reading prior evidence) — `Move-Item -Force` is genuinely non-atomic on overwrite. **Scope widened**: FleetCrawl.ps1's own topology writes use the identical non-atomic pattern (the pattern pass 1 held up as "the established safe pattern" has the same flaw) — include it in the fix.
- P2CRYPTO-002 (MEDIUM): CONFIRMED — no try/finally, fixed non-unique temp name.
- P2FRESH-001 (HIGH): CONFIRMED — exposure capped at ~4h by FleetCrawl.ps1's existing Clear-StaleJunosTempFiles sweep (mitigating factor noted, doesn't change verdict).
- P2FRESH-002: CONFIRMED but DOWNGRADED HIGH→LOW/MEDIUM (checked-into-git vendored asset, trivially recoverable, not part of the automated crawl path).
- P2DASH-001/002 (MED/HIGH): CONFIRMED with a live visible-regression repro (drawer tab click strips highlight from the Diagram/Map toggle).
- P2DASH-003 (MEDIUM): CONFIRMED — plausible real scan-failure mode, not contrived.
- P2SCAN-CLUSTER (HIGH): CONFIRMED, and P2REC-002 reclassified as a subset of P2SCAN-001 (merge, track as one HIGH finding) rather than a separate LOW.
- P2REC-001: informational only, HEAD state is fine, no code fix needed (bisect-hygiene note, not tracked as a fix item).

## Pass 2 — Phase 3 fix groups (dispatched)
1. lib/SshHelpers.ps1 — P2-SSH-STARTUP (move validation into Get-JunosSshArgs, the single choke point all paths funnel through, closing CLI/startup/web paths uniformly) + P2-ACL-SILENT (log ACL failures)
2. lib/Get-JunosNodeData.ps1 — P2FRESH-001 (move New-JunosAskPass call inside try/finally)
3. lib/WebServer.ps1 — P2WS-002 (2 remaining silent-discard logging sites)
4. lib/Protect-MapperFile.ps1 + lib/FleetCrawl.ps1 — P2CRYPTO-001/002 (true atomic replace, unique temp name, try/finally cleanup, applied to both files)
5. lib/Update-OuiDatabase.ps1 — P2FRESH-002 (temp+rename)
6. web-src/drawer.js + web-src/index.html — P2DASH-001/002 (scope switchTab's selector, add keyboard accessibility to the Diagram/Map toggle)
7. web-src/dashboard.js — P2DASH-003 (third state for "possible but zero valid devices")
8. web-src/app.js + web-src/scan-network.js — P2SCAN-CLUSTER (sequence resumeScanIfInProgress before autoloadLastScan proceeds; add re-entrancy guard to pollRunningScan)

## Pass 2 — Phase 3 complete, fix-review complete, committed
All 8 fix groups landed (10 findings + P2REC-001 informational-only). Fix-review over the combined Pass 2 diff found and fixed one small bug directly (Remove-JunosAskPass's mandatory parameter rejecting a null $AskPass in the P2FRESH-001 fix's cleanup guard — empirically confirmed via pwsh, re-verified fixed). Everything else in the fix-review's 8-point checklist (atomic-replace correctness incl. two bugs the fix agent itself caught during its own verification, SSH validation error propagation at every call site, app.js await-ordering on first-load, poll re-entrancy guard's every exit path, drawer-tab container scoping, cross-cutting hunk check, full test suite, build artifact freshness) checked out clean. Manually fixed one additional small gap noticed during this pass: web-src/map.js's switchCenterView wasn't updating aria-pressed on view switch after the drawer-tab fix added that attribute to the Diagram/Map toggle.

Full test suite: 91/91 passing throughout. Commits: `e24f17e`..`0948584` (7 commits, one per fix group; two groups combined per commit where a single root cause spanned files).

## Pass 2 — final tally
11 unique clusters → 11 CONFIRMED (0 rejected, 1 downgraded HIGH→LOW/MEDIUM on severity) → 10 fixed as code changes + 1 informational-only (P2REC-001, no fix needed) = 10 total fixes landed, plus 1 more caught by Pass 2's own fix-review, plus 1 manual incidental fix.

## Pass counter (updated)
Pass 1: complete, committed. 20 fixes landed (19 original + 1 from fix-review).
Pass 2: complete, committed. 12 fixes landed (10 original + 1 from fix-review + 1 manual incidental).
**Pass 2 was NOT clean** (11 confirmed findings, several in files Pass 1 itself had just fixed — proving fixes can and did introduce new bugs). Termination condition (2 consecutive clean passes) not yet reached. The trend across two passes (Pass 1: 20 fixes; Pass 2: 12 fixes, several of which were bugs in Pass 1's own fixes — P2SCAN-CLUSTER, P2CRYPTO-001's non-atomicity, P2-SSH-STARTUP's incomplete coverage) suggests continued high-value findings are still plausible on a Pass 3, though the count is dropping (20 → 12).

## User request (out-of-band, handled directly, not part of audit findings)
User asked to remove any code migrating previous scan/config formats. Searched whole repo (envelope `version`/`format` handling in TopologyCrypto.ps1/topology-crypto.js/Protect-MapperFile.ps1, persistence.js localStorage keys, app.js snapshot loading) — **no migration code exists**. Envelope version check is strict (`version === 1`, no fallback/upgrade path). persistence.js's `_v2` localStorage key bump deliberately abandons old entries rather than migrating them (already the "no migration" behavior). Nothing to remove. (2026-09-02)

## Pass counter
Pass 1: IN PROGRESS (Phase 1 dispatched, 6/7 category agents returned)

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

## Pass 3 — re-ranked risk (files touched by Pass 2 fixes move to top)
1. `lib/SshHelpers.ps1` — validation choke-point + ACL warning landed here (P2-SSH-STARTUP, P2-ACL-SILENT), twice-touched
2. `lib/Get-JunosNodeData.ps1` — try/finally restructure + cleanup guard landed here (P2FRESH-001 + fix-review's follow-on), twice-touched
3. `lib/Protect-MapperFile.ps1`, `lib/FleetCrawl.ps1` — new atomic-replace helper landed here (P2CRYPTO-001/002), most structurally-changed files this pass
4. `web-src/app.js`, `web-src/scan-network.js` — reattach sequencing + re-entrancy guard landed here (P2SCAN-CLUSTER), the area that already produced a Pass-1→Pass-2 regression once
5. `lib/WebServer.ps1` — 2 more logging sites (P2WS-002), lower-risk addition
6. `web-src/drawer.js`, `web-src/index.html`, `web-src/map.js`, `lib/Network_Visualizer.html` — tab-selector scoping + keyboard/ARIA wiring (P2DASH-001/002)
7. `web-src/dashboard.js` — third reboot-state (P2DASH-003)
8. `lib/Update-OuiDatabase.ps1` — temp+rename (P2FRESH-002)
9. Everything not touched by any Pass 1 or Pass 2 fix — second consecutive re-scan per protocol: `lib/Connect-Switch.ps1` (already correct, re-verify still correct), `Start-NetworkMapper.ps1`, `web-src/graph.js`, `graph-layout.js`, `elk-layout.js`, `persistence.js`, `config-resolve.js`, `search.js`, `topology-crypto.js`/`.ps1`, `utils.js`

## Pass 3 — Phase 1 complete (all 7 agents returned): 16 raw findings, notable pattern emerging
**Structural observation**: two bug classes have now resurfaced in a THIRD file each, across three passes, because each pass's fix was scoped to specific files rather than factored into one shared implementation:
- Non-atomic-write bug: Protect-MapperFile.ps1 (Pass 1) → FleetCrawl.ps1 also had it (Pass 2) → WebServer.ps1's Configuration.json save ALSO has it, still unfixed (Pass 3: P3WS-001) → AND FleetCrawl.ps1's own temp-naming still has a gap the sibling fix didn't get (P3ATOMIC-001) → AND the fallback branch has a TOCTOU race reintroducing the exact bug the fix eliminates (P3ATOMIC-002).
- SSH validation gap: Username-only-at-save (Pass 1) → moved to choke point but warning-log ineffective in the dominant automated path (Pass 3: P3SSH-001) → TargetIP was never validated at all in the same choke point (P3FRESH-001).
This suggests Pass 4 (if run) should prioritize **consolidation** (one shared atomic-write function, one shared validation module) over continuing to patch individual call sites, or the pattern will likely continue.

| ID | Sev | Claim |
|---|---|---|
| P3WS-001 | HIGH | WebServer.ps1's own Configuration.json(.enc) save (`Invoke-SaveConfigAction`) still writes in-place, never got the atomic-write fix applied to Protect-MapperFile.ps1/FleetCrawl.ps1 |
| P3ATOMIC-001 | HIGH | FleetCrawl.ps1's temp filename has only 1s timestamp granularity, no PID/GUID — two near-simultaneous crawls can still collide |
| P3SSH-001 | MED/HIGH | P2-ACL-SILENT's Write-Warning fix is silently dropped in the dominant automated (hostless runspace) path — nothing drains .Streams.Warning |
| P3ATOMIC-002 | MEDIUM | Atomic-write helper's fallback branch (destination absent) has a TOCTOU race that can reintroduce the exact non-atomic Move-Item -Force behavior the fix eliminates |
| P3SCAN-001 | MEDIUM | pollRunningScan's poll() has zero rejection handling — an exception before finish() leaves the guard stuck true forever, buttons disabled forever, no error shown (defensive gap, no live trigger found) |
| P3UX-001 | MEDIUM | P2DASH-003's anyUptimeUsable gate validates device Uptime but not scanTimestamp itself — unparseable timestamp still renders "None." instead of "Unable to determine" |
| P3WS-002 | MEDIUM | Ping/Rescan status actions can lose an already-completed job's result if the client disconnected before the response write (ScanNetworkStatusAction already avoids this, siblings don't) |
| P3FRESH-001 | MEDIUM | Get-JunosSshArgs (the SSH validation choke point) validates Username but never TargetIP; CLI -SwitchIP reaches SSH unvalidated (lower severity: no cross-principal trigger) |
| P3FRESH-004 | MEDIUM | -AllowedScopes does a bare substring-prefix match, no octet boundary — "10.1" also admits 10.19.x.x, reachable by operator typo |
| P3REC-002 | LOW/MED | Protect-MapperFile.ps1's new finally cleanup pairs Test-Path -LiteralPath with Remove-Item -Path (no -LiteralPath) — a bracket character in the directory name makes cleanup silently no-op |
| P3ATOMIC-003 | LOW | New Convert-Path call is itself a new uncaught-exception failure point in a narrow TOCTOU gap |
| P3WS-003 | LOW | /api/session-password missing Cache-Control: no-store |
| P3SSH-002 | LOW/INFO | Stale comment now misleading after the new validation throw, no functional impact |
| P3UX-002 | LOW/INFO | ARIA pattern calibration note on the Diagram/Map toggle, not a clear defect |
| P3SCAN-INFO-001 | INFO | No fetch timeout, but concluded NOT a regression (old behavior was worse: showed stale data as success) |
| P3REC-001 | INFO | Bisect-hygiene only — an intermediate Pass 2 commit's build artifact doesn't match its own source if checked out standalone; HEAD is fine |

## Pass 3 — Phase 2 verification / Phase 3 fixes (deviation logged)
Given the strong pattern already visible in Phase 1 (two bug classes independently resurfacing in a third file each), consulted the advisor tool before dispatching formal double-verification. Advisor's read: the atomic-write cluster (P3WS-001/P3ATOMIC-001/002/003/P3REC-002) and the SSH/IP-validation cluster (P3SSH-001/P3FRESH-001) are not 5+2 separate bugs but one missing abstraction each, instantiated repeatedly — continuing to verify-then-patch each file individually would reproduce the exact whack-a-mole pattern being complained about. Recommended: (1) empirically re-measure whether a simpler atomic primitive exists before sizing a consolidated helper, (2) escalate the consolidation itself to the human per the protocol's design-change threshold (>~50 lines / touches a critical invariant's implementation) rather than auto-dispatching it, (3) dispatch the genuinely-independent minimal-diff findings immediately without ceremony.

**Empirical re-check**: stracing `[System.IO.File]::Move($src, $dst, $true)` against the real pwsh 7.6.2 binary showed a single `rename()` syscall, atomic regardless of whether the destination exists — simpler than the `File.Replace` pattern already in use (no `[NullString]::Value`, no backup-file semantics). This meant a consolidated helper could be small, which shrank the case for further per-file patching.

**Escalated to user** (3 questions via AskUserQuestion): (1) consolidate now vs. keep patching per-file vs. consolidate-then-stop — user chose **consolidate now**; (2) require new Pester coverage for the consolidated helper vs. manual verification — user chose **manual verification is fine**; (3) P3FRESH-004's octet-boundary fix is a user-visible behavior change (existing `-AllowedScopes` values could admit fewer IPs than before) — fix now with documented change vs. defer — user chose **fix now, document it**.

**Verdicts and outcomes** (informal verify-and-fix per finding, not double-blind adversarial verification — deviation from strict protocol, justified by the corroboration already present across 3 passes for the two dominant bug classes, and by AskUserQuestion putting the one genuinely irreversible/design-level call to the human):
| ID | Verdict | Outcome |
|---|---|---|
| P3WS-001 | CONFIRMED | Fixed via consolidation — `Invoke-SaveConfigAction` now calls shared `Set-FileContentAtomic` |
| P3ATOMIC-001 | CONFIRMED | Fixed via consolidation — FleetCrawl.ps1 temp names now use `$PID` + GUID, not just 1s timestamp |
| P3ATOMIC-002 | CONFIRMED | Fixed via consolidation — new `Move-FileAtomic` uses a single `File.Move(...,true)` call, no destination-exists/absent branching, so the TOCTOU race is structurally gone |
| P3ATOMIC-003 | CONFIRMED | Fixed via consolidation, same reasoning — no separate `Convert-Path`-then-branch sequence remains |
| P3SSH-001 | CONFIRMED | Fixed — `.Streams.Warning` now drained alongside `.Streams.Error` in FleetCrawl.ps1's job-completion loop (general fix: covers any hostless-job warning, not just this one) |
| P3FRESH-001 | CONFIRMED | Fixed — `Get-JunosSshArgs` now validates `$TargetIP` (0-255-bounded octet regex); traced end-to-end, `Start-NetworkMapper.ps1 -SwitchIP` confirmed to flow through this choke point |
| P3FRESH-004 | CONFIRMED | Fixed (user-approved behavior change) — `AllowedScopes` matching now requires an exact match or a literal `.` boundary; default `"131.30."`-style trailing-dot scopes still work via `TrimEnd('.')` |
| P3SCAN-001 | CONFIRMED (defensive, no live trigger found) | Fixed — `poll()` calls now go through a `runPoll()` wrapper with `.catch`, resetting the guard and surfacing an error via the existing `setStatus` mechanism |
| P3UX-001 | CONFIRMED | Fixed — `rebootCheckPossible` now also requires `scanTimestamp` to parse (`!isNaN(new Date(...).getTime())`), reusing the same check `utils.js`'s `renderCrawlAge` already uses |
| P3WS-002 | CONFIRMED | Fixed — `Invoke-PingAction`/`Invoke-RescanAction` job objects now carry `Collected`/`Outcome`; status actions cache the outcome before the response write instead of losing it on a failed write, matching `Invoke-ScanNetworkStatusAction`'s existing pattern |
| P3REC-002 | CONFIRMED | Fixed — both `Remove-Item -Path` sites in Protect-MapperFile.ps1's cleanup (decrypt + encrypt branches) now use `-LiteralPath` |
| P3WS-003 | CONFIRMED | Fixed — `/api/session-password` now sends `Cache-Control: no-store` |
| P3SSH-002 | CONFIRMED (doc-only) | Fixed — stale "swallows failures" comment corrected to describe the current `Write-Warning` behavior |
| P3UX-002 | Not a defect (re-confirmed) | No fix — `role="tab"` would be worse with no `role="tablist"` present; left as-is |
| P3SCAN-INFO-001 | Not a regression (re-confirmed) | No fix needed |
| P3REC-001 | Informational only (re-confirmed) | No fix needed, bisect-hygiene note only |

**Fix-review** (dedicated agent, adversarial pass over the full combined diff spanning 6 concurrently-edited files + 1 new file): checked path-resolution correctness of the new `Move-FileAtomic`/`Set-FileContentAtomic` helpers (parent-dir-missing case throws a clear error, no silent wrong-directory write), confirmed no dead code left behind (`Move-TopologyOutputLocal` and the old local `Move-FileAtomic` fully removed, nothing still references them), traced P3WS-002's job-outcome caching for a double-`EndInvoke`/race risk (none — the HTTP listener handles one request at a time, and double-`Dispose`/`Stop` was empirically confirmed harmless via a live pwsh repro), stress-tested the two new independent IP/scope regexes against edge cases (leading zeros, out-of-range octets, IPv6, empty string, a scope of just `"."` — all handled correctly, `"."` fails closed), and re-read `dashboard.js`/`scan-network.js` in full file context. **Zero new bugs found.** One harmless style asymmetry noted (not fixed): WebServer.ps1's shutdown block disposes `$script:PendingScan`/`$script:PendingPing` unconditionally while `$script:PendingScanNetwork` guards on `.Collected` — proven not to throw either way, cosmetic only.

Full test suite: 91/91 passing throughout (both after the fix batch and after fix-review). All `.ps1` files touched pass a syntax check.

## Pass 3 — final tally
16 raw findings → 13 CONFIRMED and fixed (4 via consolidation into a new shared `lib/FileHelpers.ps1`, 9 fixed individually) → 3 re-confirmed as not requiring a fix (informational/non-defect). New shared infrastructure: `lib/FileHelpers.ps1` (`Move-FileAtomic`, `Set-FileContentAtomic`), now used by `Protect-MapperFile.ps1`, `FleetCrawl.ps1`, `WebServer.ps1`, `Update-OuiDatabase.ps1` — this directly addresses the whack-a-mole pattern flagged after Phase 1: one write path now serves all four call sites instead of four independent implementations.

## Pass counter (updated)
Pass 1: complete, committed. 20 fixes landed.
Pass 2: complete, committed. 12 fixes landed. NOT clean.
Pass 3: complete, not yet committed. 13 fixes landed (including a consolidation that structurally closes 4 findings at once). NOT clean — but the atomic-write and SSH-validation bug classes that resurfaced in Pass 1→2→3 are now backed by one shared implementation each rather than per-file patches, which is the change most likely to make a Pass 4 clean if run.

## Pass 3 — Phase 2 verification (complete, see above)

## User request (out-of-band, handled directly, not part of audit findings)
User asked to remove any code migrating previous scan/config formats. Searched whole repo (envelope `version`/`format` handling in TopologyCrypto.ps1/topology-crypto.js/Protect-MapperFile.ps1, persistence.js localStorage keys, app.js snapshot loading) — **no migration code exists**. Envelope version check is strict (`version === 1`, no fallback/upgrade path). persistence.js's `_v2` localStorage key bump deliberately abandons old entries rather than migrating them (already the "no migration" behavior). Nothing to remove. (2026-09-02)

## Pass 4 — Phase 1 (7 parallel agents, read-only): 20+ raw findings across FileHelpers.ps1 deep re-scan, SSH/IP re-verification, WebServer.ps1 re-scan, scan/UX re-scan, fresh-look at previously-untouched files, recent-change review of Pass 3's 7 commits, and a security/invariant cross-cut. Most of Pass 3's own fixes re-verified clean (no regressions from the consolidation). Two clusters of new findings:
- **P4SEC-CMDPATH-1 (HIGH)**: every security-validation regex in the codebase (`Get-JunosSshArgs`'s Username/TargetIP checks, WebServer.ps1's IP-shape and username checks) used `$` as its end anchor. .NET regex `$` matches end-of-string OR immediately before a single trailing `\n` — not true end-of-string — so a value like `"admin\n"` passed validation and reached a raw `ProcessStartInfo` command-line string, defeating the choke-point validation this audit has hardened across three prior passes. Independently re-verified myself via live `pwsh` before treating as confirmed (not just trusting the reporting agent), given the severity.
- **Timestamp-parseability bug class, round 2**: the "truthy-but-unparseable `scanTimestamp` treated as valid" bug Pass 3 fixed once (dashboard.js's reboot-history gate) turned out to have 6 more untouched instances: `dashboard.js`'s `computeConfigChanges` and Trends chart, `persistence.js`'s `updateDeviceHistory` and `updateAlarmHistory`, `drawer.js`'s config-compare picker and search. Same whack-a-mole shape as the atomic-write pattern from Pass 1-3, just in a different bug class.
- Also: `New-JunosAskPass` (P4FRESH-1, MEDIUM) can leak a plaintext credential file for up to 4h if its second sequential write fails, since the caller's null-guarded cleanup has nothing to clean up in that case (INV-CREDS). `Invoke-PingStatusAction`/`Invoke-RescanStatusAction` (P4SEC-JOBS-1, LOW) never got the `.Streams.Warning` drain Pass 3 added to FleetCrawl.ps1. One more `-Path`/`-LiteralPath` cleanup site missed in Pass 3 (`FleetCrawl.ps1:543`, P4REC-002). A `resumeScanIfInProgress()` guard race (P4UX-001, MEDIUM) and an error-message-clobbering bug in `runPoll()`'s catch (P4UX-002, LOW). Several LOW/INFO items re-confirmed as pre-existing/harmless, not fixed (documented per-finding in the fix commits below).

## Pass 4 — Phase 2/3: fix without a separate formal verification step (deviation continued from Pass 3, same justification — findings were concrete with clear triggers, several independently empirically re-verified by me directly for the HIGH one). 13 findings fixed across 5 concurrent fix agents, several editing the same files simultaneously (`SshHelpers.ps1` and `WebServer.ps1` each touched by two independent agents) — fix-review specifically checked these didn't clobber each other, confirmed clean.

**Fix-review** (dedicated agent over the full combined diff): confirmed both concurrent edits to `SshHelpers.ps1` (regex-anchor fix + askpass cleanup fix, different functions) and both concurrent edits to `WebServer.ps1` (regex-anchor fix + stream-draining fix) coexist correctly with no clobbering; re-ran the bypass-payload test live and confirmed still rejected; verified the new stream-draining code sits inside the existing `Collected` guard so it can't double-drain or read a disposed job; checked all `finish()` call sites in scan-network.js for reliance on its now-optional message argument (none rely on it). **Zero new bugs found.**

Full test suite: 91/91 passing throughout. All `.ps1` files touched pass a syntax check.

## Pass 4 — final tally
7 review agents → ~20 raw findings → 13 CONFIRMED and fixed (1 HIGH, 2 MEDIUM, 3 LOW/nitpick individually + a 4-site consolidation replacing 6 individual timestamp-parseability findings with 1 shared helper) → remainder re-confirmed as pre-existing/harmless, not requiring a fix. Commits: `70d6f6c`, `14e8bb2`, `ee28a70`, `37b38ca`, `0587f8c` (5 commits).

## Pass 5 — Phase 1 (7 parallel agents, read-only, "re-derive invariants from scratch" methodology continued given its Pass 4 track record): regex/validation fix re-verified clean (no bypass remaining); credential lifecycle re-derivation found one new low finding (write-before-ACL-harden ordering); WebServer.ps1 fresh re-scan found a genuine MEDIUM (P5WS-001 — `-AllowedScopes` enforced on crawl-discovered neighbors but not the manually-entered scan/rescan entry-point IP) plus two low/info items; the `parseTimestampMs` consolidation from Pass 4 was itself found incomplete — 9 more unguarded sites across `app.js`/`search.js`/`dashboard.js` (third round of this bug class); fresh-look at build/graph files found a currently-latent HIGH (`build-inline.mjs` silently drops script attributes when inlining, and only matches double-quoted attrs) plus a missing `.catch()` in `search.js` and OUI-download encoding gaps; recent-change review independently confirmed the timestamp gap; security cross-cut found a low exception-safety gap in WebServer.ps1's startup pool-opening.

**Escalated to user before fixing**: whether `-AllowedScopes` should also gate a manually-entered scan/rescan IP (a real behavior-change question, not an obvious bugfix, matching the P3FRESH-004 precedent) — user approved enforcing it there too.

**Pass 5 — Phase 2/3**: 5 concurrent fix agents (same informal verify-and-fix pattern as Passes 3-4, justified by findings being concrete with clear triggers). Fixed: P5WS-001 (scope enforcement, with the matching logic extracted into a shared `Test-IpInAllowedScopes` used by both `FleetCrawl.ps1` and `WebServer.ps1` rather than reimplemented a second time), P5SEC-JOBS-1 (pool-open exception safety), P5WS-002 (response-write/close safety), P5CRED-01 (write-before-ACL-harden ordering — implemented the ordering fix rather than just documenting it, judged low-risk), P5SEC-DATA-1 (doc-only), P5FRESH-001/002 (build-inline.mjs attribute preservation + single-quote matching + a leftover-tag safety net — confirmed this wasn't just latent: the *already-committed* build artifact had already silently dropped a real attribute), P5FRESH-003 (OUI download explicit UTF-8), P5FRESH-005 (search.js missing `.catch()`), P5FRESH-007/008 (config-resolve.js edge cases), and the timestamp-parseability sweep's 9 sites — this time backed by a new `web-src/test/utils.test.mjs` testing `parseTimestampMs`'s contract directly, specifically to try to prevent a 4th round of this bug class. The fix agent doing the timestamp sweep caught and corrected its own regression mid-task (a `|| 0` fallback that reintroduced the exact truthy-check anti-pattern being fixed) and found 2 more instances beyond its assigned list (a stale-localStorage self-heal gap in `persistence.js`, a stat card silently showing "0" instead of "N/A").

**Fix-review** (dedicated agent over the full combined diff, including two agents' concurrent edits to `search.js`): confirmed the `Test-IpInAllowedScopes` extraction preserved FleetCrawl.ps1's original crawl-time behavior exactly, confirmed `Invoke-RescanAction`'s new `-AllowedScopes` parameter is actually populated at its call site (not silently `$null`), confirmed the pool-open try/catch doesn't mask the original exception or double-dispose, confirmed both `search.js` edits coexist, confirmed `??` (not `||`) is used at the self-corrected call sites, re-ran the build and confirmed `Network_Visualizer.html` is in sync with no further diff, and confirmed the new test file is correctly discovered by the test runner. **Zero new bugs found.**

Full test suite: 95/95 passing (91 baseline + 4 new). All `.ps1` files touched pass a syntax check. Commits: `2ab7fdb`, `b90dcb3`, `fe44d07`, `394b485`, `4cef0e1`, `f1104a9` (6 commits).

## Pass 5 — final tally
7 review agents → ~15 raw findings (excluding the fully-clean regex re-verification) → 13 CONFIRMED and fixed (1 MEDIUM behavior-change requiring escalation, several LOW/INFO, one HIGH-but-latent build bug, and a 9-site timestamp consolidation) → remainder (P5CRED-02, P5FRESH-004, P5FRESH-006, P5WS-003, assorted nitpicks) re-confirmed as informational/accepted-risk/documented-tradeoffs, not requiring a fix.

Also this session (not part of the audit findings — a user feature request handled alongside Pass 5): added an "Inactive Ports" Analysis Dashboard view (`web-src/dashboard.js`, `web-src/index.html`) backed by a new `show interfaces extensive` SSH command and "Last flapped" duration parser in `Get-JunosNodeData.ps1`. Not verified against a live device (no hardware-in-the-loop coverage in this codebase); verified via a standalone synthetic integration test of the parsing logic. Commit `a6dc4e8`.

## Pass counter (updated)
Pass 1: complete, committed. 20 fixes landed. NOT clean.
Pass 2: complete, committed. 12 fixes landed. NOT clean.
Pass 3: complete, committed. 13 fixes landed (consolidation of atomic-write logic into lib/FileHelpers.ps1). NOT clean.
Pass 4: complete, committed. 13 fixes landed (consolidation of timestamp-parseability logic into utils.js's parseTimestampMs; HIGH-severity regex-anchor command-injection-choke-point bypass closed). NOT clean.
Pass 5: complete, committed. 13 fixes landed (AllowedScopes entry-point enforcement, a latent HIGH build-artifact-integrity bug, and — after two prior incomplete attempts — what is hopefully a genuinely complete timestamp-parseability fix, now backed by a dedicated regression test). NOT clean.

## Pass 6 — Phase 1 (7 parallel agents, read-only): dedicated adversarial review of the new Inactive Ports feature (added mid-audit, never verified against real hardware) found a real HIGH (P6PORT-01, command placement risk to timeout-protected commands) and a real MEDIUM (P6PORT-02, missing sub-minute duration format); re-scans of Pass 5's WebServer.ps1/FleetCrawl.ps1 fixes and the credential-ACL-ordering fix both held up under independent re-derivation, with the credential-ACL re-scan honestly flagging that its Windows-specific correctness genuinely can't be verified from this Linux dev machine; a from-scratch INV-UI-TRUTH re-derivation (deliberately avoiding the timestamp angle already hunted 3 times) found two genuine HIGH bugs — the Analysis Dashboard never re-renders on snapshot switch, and an existing anti-staleness fix's refresh call was ordered one line too early; fresh-look at drawer.js/map.js/index.html/existing tests found only LOW/INFO items (a real XSS-shaped question was checked exhaustively and came back clean); recent-change review of Pass 5's 7 commits found nothing; security cross-cut independently re-confirmed the `-SwitchIP`/`AllowedScopes` gap (corroborating a second agent's finding) plus a MEDIUM about the error message giving no actionable guidance.

**Escalated to user before fixing**: whether `-SwitchIP` should be brought in line with the web UI's `-AllowedScopes` enforcement (same category of decision as Pass 5) — user approved.

**Pass 6 — Phase 2/3**: 5 concurrent fix agents. Fixed: P6UI-001/002 (Analysis Dashboard staleness — refresh moved into `setActiveSnapshot` itself, guarded on tab visibility since the render functions do real work rather than being cheap no-ops when hidden; the fix agent caught and corrected its own initial unconditional-call mistake before finishing), P6PORT-01/02/03/04 (command reordering, sub-minute duration format, Description-field regex-collision guard, missing log entry — each verified via a standalone synthetic test), P6SEC-01 (CLI `-SwitchIP` scope enforcement, user-approved) + P6SEC-02 (error messages now include the actual configured scope list) + P6SEC-04 (Interfaces `@()` consistency), P6CRED-02 (`New-JunosCredentialFile` cleanup asymmetry — verified via a real forced-failure repro, not just theoretical) + P6CRED-03 (honest documentation of the ACL-ordering fix's actual guarantees, including flagging the unverified-on-Windows question explicitly rather than asserting it's fine), P6SEC-03 (2 more stray timestamp checks routed through `parseTimestampMs`), P6FRESH-01/02/03 (esc() test coverage, a shared-array-mutation fix in `renderClients`, a misleading comment correction).

**Fix-review** (dedicated agent over the full combined diff, including the two-agent `app.js` overlap): traced every caller of `setActiveSnapshot` and every `processSelectedFiles` code path to confirm no caller is left stale and no double-refresh; empirically verified the reordered SSH command batch doesn't break the CONFIG section's parsing and that the two "Last flapped" regex branches are mutually exclusive; confirmed `New-JunosCredentialFile`'s new catch block cleans up only its own single file, not copy-pasted from its sibling's two-file version; confirmed `$AllowedScopes` can't be `$null` in practice and the new CLI check correctly no-ops when `-SwitchIP` isn't provided. **Zero new bugs found.**

Full test suite: 98/98 passing (95 + 3 new `esc()` tests). All `.ps1` files touched pass a syntax check. Commits: `afd2e7d`, `221db8d`, `153c704`, `97e869e`, `1c6f112` (5 commits).

## Pass 6 — final tally
7 review agents → ~20 raw findings → 15 CONFIRMED and fixed (2 HIGH in the dashboard, 1 HIGH-but-latent in the new feature's command ordering, several MEDIUM, several LOW) → remainder (the intentionally-unrestricted `/api/connect` design choice, various clean/informational verdicts) require no fix. Notably: this pass's two highest-severity findings (dashboard staleness, command-ordering regression risk) came from methodologies specifically designed to avoid re-treading already-hunted ground (a "find a DIFFERENT INV-UI-TRUTH bug, not timestamps" agent, and a dedicated review of new/unverified code) — suggesting continued passes are still finding real, previously-unreachable bug classes rather than just diminishing re-confirmations.

## Pass counter (updated)
Pass 1: complete, committed. 20 fixes landed. NOT clean.
Pass 2: complete, committed. 12 fixes landed. NOT clean.
Pass 3: complete, committed. 13 fixes landed (consolidation of atomic-write logic into lib/FileHelpers.ps1). NOT clean.
Pass 4: complete, committed. 13 fixes landed (consolidation of timestamp-parseability logic into utils.js's parseTimestampMs; HIGH-severity regex-anchor command-injection-choke-point bypass closed). NOT clean.
Pass 5: complete, committed. 13 fixes landed (AllowedScopes entry-point enforcement, a latent HIGH build-artifact-integrity bug, and — after two prior incomplete attempts — what is hopefully a genuinely complete timestamp-parseability fix, now backed by a dedicated regression test). NOT clean.
Pass 6: complete, committed. 15 fixes landed (2 HIGH Analysis Dashboard staleness bugs found via a deliberately-different-angle INV-UI-TRUTH re-derivation; hardening of the new Inactive Ports feature against real Junos output variance it was never tested against; CLI/web AllowedScopes enforcement made consistent). NOT clean. 6 of 8 passes used.

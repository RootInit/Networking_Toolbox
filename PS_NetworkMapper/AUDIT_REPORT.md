# AUDIT_REPORT.md — PS_NetworkMapper Full-Depth Audit

Date: 2026-09-02 to 2026-09-03. Full detail and raw agent output live in `.claude/audit-findings-*.md`, `.claude/verify-*.md` (Pass 1), `.claude/p2-findings-*.md`, `.claude/p2-verify-*.md` (Pass 2), `.claude/p3-findings-*.md` (Pass 3); process state in `AUDIT_LEDGER.md`.

## Status: three passes complete (Phase 0-3 each). Termination condition (2 consecutive clean passes) NOT reached — none of the three passes was clean. Stopped after Pass 3 by user direction, with remaining risk accepted rather than continuing to the 8-pass cap.

## Passes run
- **Pass 1**: 23 findings reported → 21 unique after dedup → 20 CONFIRMED, 1 REJECTED (WS-1), 1 downgraded to informational. 20 fixed; fix-review found 1 more (UX-005b) from the fix diff itself. **21 total fixes.**
- **Pass 2**: 11 unique clusters, all CONFIRMED (several inside Pass 1's own fixes — proving a fix pass can introduce new bugs even within the same review). 10 fixed as code changes, 1 informational-only. Fix-review found 1 more; 1 additional manual incidental fix. **12 total fixes.**
- **Pass 3**: 16 raw findings → 13 CONFIRMED and fixed, 3 re-confirmed as not requiring a fix. A structural pattern emerged during Phase 1: the non-atomic-write bug and the SSH/IP-validation gap had each independently resurfaced in a *third* file, because each pass's fix was scoped to specific call sites rather than a shared implementation. Consulted the advisor tool, empirically re-measured the atomic-write primitive (confirmed `[System.IO.File]::Move(...,true)` is a single atomic `rename()` on this pwsh — simpler than the pattern already in use), and escalated the consolidation decision to the user rather than auto-implementing a >50-line, invariant-touching design change. User approved consolidation now, manual verification (no new Pester dependency), and a documented behavior change to `-AllowedScopes` matching. 4 findings collapsed into one new shared `lib/FileHelpers.ps1`; 9 more fixed individually. Fix-review over the full combined diff (spanning 6 concurrently-edited files) found zero new bugs. **13 total fixes.**

Total across all three passes: **46 fixes landed**, plus the consolidation of what had been 3 independent atomic-write implementations (and would likely have become a 4th) into 1 shared function.

## Critical invariants — evidence they hold after Pass 3
1. **INV-DATA** (topology file never silently corrupted) — every write path in the codebase (`Protect-MapperFile.ps1`, `FleetCrawl.ps1`, `WebServer.ps1`'s config save, `Update-OuiDatabase.ps1`) now goes through one shared `lib/FileHelpers.ps1` (`Move-FileAtomic`/`Set-FileContentAtomic`), built on an empirically-verified single-syscall atomic rename. This is materially stronger evidence than Pass 1's or Pass 2's per-file fixes, both of which turned out to have gaps found in the following pass.
2. **INV-CREDS** — unchanged from Pass 1/2 status; no new findings in Pass 3 (re-scanned fresh, clean).
3. **INV-CMDPATH** — the SSH-arg choke point (`Get-JunosSshArgs`) now validates both `$Username` (Pass 1/2) and `$TargetIP` (Pass 3, P3FRESH-001), traced end-to-end to confirm `Start-NetworkMapper.ps1 -SwitchIP` actually flows through it. `-AllowedScopes` matching now respects octet boundaries (P3FRESH-004, user-approved behavior change — see below).
4. **INV-JOBS** — WS-1 (Pass 1) correctly rejected via live empirical testing. `.Streams.Warning` from hostless runspace jobs is now drained (P3SSH-001), closing a gap where a Pass 2 fix (`Write-Warning` on ACL failure) was silently ineffective in the dominant automated path. Ping/rescan job outcomes are now cached before the response write (P3WS-002), closing a result-loss gap `Invoke-ScanNetworkStatusAction` already avoided.
5. **INV-UI-TRUTH** — P3UX-001 closed the same bug class as Pass 1's UX-006 and Pass 2's P2DASH-003, but on the other operand (`scanTimestamp` parseability, not just `Uptime`). This is itself a small instance of the whack-a-mole pattern — worth checking `persistence.js`, noted but not separately filed, if a future pass runs.
6. **INV-NO-LOCKOUT** — no new findings in Pass 3.

No critical invariant has a known-live violation remaining as of Pass 3. The atomic-write consolidation is the single strongest piece of new evidence this pass produced, since it removes an entire class of "same bug, different file" recurrence rather than patching one more instance of it.

## Fixed bugs by pass
See `AUDIT_LEDGER.md` for the full per-finding tables (Pass 1, Pass 2, Pass 3 sections) including finding IDs, severities, files, and verification method for all 46 fixes. Pass 3's table is reproduced below since it's the newest and includes the consolidation:

| ID | Sev | Description | Outcome |
|----|-----|-------------|---------|
| P3WS-001 | HIGH | WebServer.ps1's config save never got atomic-write protection | Fixed via consolidation |
| P3ATOMIC-001 | HIGH | FleetCrawl.ps1 temp-filename collision (1s granularity, no PID/GUID) | Fixed via consolidation |
| P3SSH-001 | MED/HIGH | `.Streams.Warning` never drained from hostless jobs, silently dropping a Pass 2 fix | Fixed |
| P3ATOMIC-002 | MEDIUM | TOCTOU race in the destination-absent fallback branch | Fixed via consolidation (branch eliminated) |
| P3SCAN-001 | MEDIUM | `poll()` had no rejection handling; guard could stick `true` forever | Fixed |
| P3UX-001 | MEDIUM | reboot-history gate didn't validate `scanTimestamp` parseability | Fixed |
| P3WS-002 | MEDIUM | Ping/rescan status actions could lose a completed job's result | Fixed |
| P3FRESH-001 | MEDIUM | SSH choke point validated Username but never TargetIP | Fixed |
| P3FRESH-004 | MEDIUM | `-AllowedScopes` bare substring match, no octet boundary | Fixed (user-approved behavior change) |
| P3REC-002 | LOW/MED | Temp-file cleanup used `-Path` not `-LiteralPath` (glob-interpretation gap) | Fixed |
| P3ATOMIC-003 | LOW | `Convert-Path` was a new uncaught-exception failure point | Fixed via consolidation (call eliminated) |
| P3WS-003 | LOW | `/api/session-password` missing `Cache-Control: no-store` | Fixed |
| P3SSH-002 | LOW/INFO | Stale comment describing removed silent-catch behavior | Fixed |
| P3UX-002 | LOW/INFO | ARIA role calibration note on Diagram/Map toggle | Not a defect, re-confirmed |
| P3SCAN-INFO-001 | INFO | No fetch timeout | Not a regression, re-confirmed |
| P3REC-001 | INFO | Bisect-hygiene note on an intermediate Pass 2 commit | No fix needed, HEAD is fine |

Commits: `b95caa3`, `c5e5cd2`, `8776511`, `7590a58`, `d256ee7`, `e17f476` (6 commits, one per file/theme group).

## REJECTED findings (kept for future-pass dedup, not proof of correctness)
- **WS-1** (Pass 1): claimed unguarded `.Dispose()` could throw and leak an SSH session. Empirically disproven — `PowerShell.Dispose()` doesn't throw under Running/Stopping/double-dispose/pool-closed conditions.

## CONFIRMED-UNTESTABLE findings
None across all three passes — every CONFIRMED finding got either an automated JS regression test or a documented/live-repro'd manual PS verification (no Pester framework exists — see CFG-004, still open).

## Escalated to the human
1. **SSH-001/002's validation regex strictness** (Pass 1) — still open; needs a real-world answer about whether this deployment uses realm-qualified usernames.
2. **CFG-004 (no PowerShell test suite)** (Pass 1) — still open. Directly relevant to Pass 3: the consolidation of atomic-write logic into one shared function was explicitly offered with Pester coverage as an option; user chose manual verification, accepting that the shared helper's only regression coverage is the manual scripts run during this audit, not an automated suite.
3. **Pass 3 consolidation decision** — resolved. User approved consolidating atomic-write and SSH/IP-validation logic into shared implementations (`lib/FileHelpers.ps1`, extended `Get-JunosSshArgs`) rather than continuing per-file patches.
4. **P3FRESH-004's `-AllowedScopes` behavior change** — resolved. User approved fixing the octet-boundary bug now, with the understanding that an existing config relying on the old loose substring match to admit a wider range than a plain reading of the value suggests should be reviewed.

## UX gaps summary
Unchanged from Pass 1/2's summary for anything not re-touched. Pass 3 added: reboot-history "None." vs "Unable to determine" now correctly handles a bad `scanTimestamp`, not just a bad `Uptime` (closing the same INV-UI-TRUTH class Pass 1's UX-006 and Pass 2's P2DASH-003 opened, on the other operand); scan polling now fails visibly instead of silently wedging the UI.

## Remaining risk (top areas for a human to look at next)
1. **No PowerShell test infrastructure** (CFG-004) — still the single biggest gap in "evidence a fix stays fixed." Every PS-side fix across all three passes, including the new shared `lib/FileHelpers.ps1`, was verified by manual trace/live-repro scripts, not a running regression suite.
2. **SSH username validation strictness** — still needs a real-world answer (see above).
3. **`persistence.js` may share P3UX-001's root cause** (noted in Pass 3 but not separately filed/fixed) — worth a quick look if any future pass runs.
4. **Hardware-in-the-loop / simulator coverage** — unchanged from Pass 1: nothing is tested against a real or simulated Junos device.
5. **Screen-reader-level accessibility** beyond keyboard/aria-selected — not audited in any pass.
6. **The audit did not reach 2 consecutive clean passes** — Pass 3 found and fixed 13 real issues, so a hypothetical Pass 4 could still find something, though the trend across all three passes (20 → 12 → 13, with Pass 3's count including 4 collapsed by one consolidation rather than 4 independent patches) suggests the *rate of newly-appearing bug classes* is dropping even where raw counts don't. The consolidation done this pass is the change most likely to produce an actually-clean Pass 4, since it removes the mechanism (per-file patching) that produced a new instance of the same two bug classes in each of the first three passes.

## Baseline vs final (Pass 1 start → Pass 3 end)
- JS test count: **80 → 91** passing throughout Pass 2 and Pass 3 (no new JS tests added after Pass 1's +11; Pass 3 fixes were verified via the existing suite plus manual click-path/rejection-handling checks, consistent with the user's choice not to add new automated coverage this pass).
- PowerShell: 0 → 0 tests (still no framework — CFG-004 remains open across all three passes).
- Write-path architecture: went from 4 independent atomic-write implementations across 3 files (1 of them, WebServer.ps1's, not atomic at all) to 1 shared implementation used by all 4 call sites, built on an empirically-simpler primitive (`File.Move(...,true)`, single `rename()` syscall) than any of the prior per-file implementations used.
- SSH-arg validation: went from Username-only (Pass 1/2) to Username+TargetIP, at the same single choke point, traced end-to-end against the one live unvalidated entry point (`-SwitchIP`).
- Working tree: clean after 6 commits this pass; no unrelated changes.

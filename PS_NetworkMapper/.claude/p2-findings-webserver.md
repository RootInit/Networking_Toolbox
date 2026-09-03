# Pass 2 findings — lib/WebServer.ps1

Scope: job lifecycle, SSH-001/002 username validation, WS-2 logging (per `13736ee`, `efbc0df`).
WS-1 (Pass 1 REJECTED) not re-reported — no new trigger condition found.

---

## P2WS-001 — Username validation is save-path-only; startup-loaded credentials reach SSH invocation with zero validation

**Track:** CORE/SERVICE (SSH-001/002 follow-up)
**File:line:** `lib/WebServer.ps1:883-884` (root cause), `lib/WebServer.ps1:952,959,994` (sinks); root config load: `Start-NetworkMapper.ps1:61-63,99-101,169`
**Severity:** MEDIUM
**Confidence:** HIGH

**Claim:** The SSH-001/002 fix (13736ee) validates `$Parsed.credentials.username` against `^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$` only inside `Invoke-SaveConfigAction` (line 729), immediately before it's written to `Configuration.json(.enc)` and pushed into `$script:JunosUsername` (line 761). But `$script:JunosUsername` has a second, earlier write site that is never validated: `Start-MapperWebServer`'s param default is assigned straight into the script-scope variable at line 883 (`$script:JunosUsername = $JunosUsername`), fed from the `-JunosUsername` parameter that `Start-NetworkMapper.ps1` populates directly from whatever `Configuration.json(.enc)` already contains on disk at process start (`Start-NetworkMapper.ps1:61-63` and `:99-101`, no regex check anywhere in that file — confirmed by grep, only `SshHelpers.ps1`/`Connect-Switch.ps1`/`Get-JunosNodeData.ps1`/`FleetCrawl.ps1` reference `Username` and none of them validate it either, per grep across all four files). That value then flows unvalidated into `Invoke-ConnectAction` (line 952), `Invoke-RescanAction` (line 959), and `Invoke-ScanNetworkAction` (line 994), each of which hands it to `Get-JunosSshArgs` and from there into an unescaped `ssh.exe`/`cmd.exe` command-line string (`Connect-Switch.ps1:36`, `SshHelpers.ps1:105`) — the exact sink SSH-001/002 closed for the save path.

**Trigger:**
1. A `Configuration.json.enc` written by any pre-13736ee build of this app (or a downgraded/rolled-back copy of it) with a malicious username (e.g. `admin -oProxyCommand=calc.exe x`) already saved. Loading it under the *current, fixed* binary still arms the injection on the very first Connect/Rescan/Scan-network click — no save-config round-trip is required.
2. `-NoEncryption` mode: `Configuration.json` is plaintext with no integrity check at all; anyone with filesystem write access to it (a lower bar than knowing the encryption password) can plant a malicious username that loads unvalidated at next startup.

**Evidence:**
- `lib/WebServer.ps1:883-884` — unconditional, unvalidated assignment at startup.
- `lib/WebServer.ps1:729-733` — the only validation site, gated inside `Invoke-SaveConfigAction`, unreachable from the startup path.
- `grep -n "Username" lib/SshHelpers.ps1 lib/Connect-Switch.ps1 lib/Get-JunosNodeData.ps1 lib/FleetCrawl.ps1` shows no independent/defense-in-depth check anywhere downstream — the save-path regex is the *only* gate in the entire call chain.
- `Start-NetworkMapper.ps1:61-63,99-101` load `$JunosUsername`/`$JunosPassword` straight from the parsed config with no format check before passing them to `Start-MapperWebServer -JunosUsername ...` (line 169).
- Encrypted-envelope integrity: `TopologyCrypto.ps1`'s `Unprotect-TopologyPayload` does verify HMAC before returning content (`lib/TopologyCrypto.ps1:150-162`), so scenario 1 requires either (a) the file was saved legitimately by an *older, unfixed* build under the real password, or (b) an attacker who already knows the encryption password (a stronger prerequisite, but the fix's own commit message frames the injection as closed "at the single point of entry," which this disproves as a categorical claim).

**Invariant hit:** INV-CMDPATH (a stray value can still reach `ssh.exe`/`cmd.exe` unescaped) — this is the invariant SSH-001/002 was written to restore, and it is only restored for the save-config request path, not for process startup.

**Impact:** A previously-saved (pre-fix, or filesystem-tampered under `-NoEncryption`) malicious username silently re-arms the exact injection SSH-001/002 was supposed to close, the first time the operator clicks Connect/Rescan/Scan-network after upgrading to the fixed binary — with no warning, no re-validation, and no log line calling out that the loaded username failed the new format check.

**Repro:**
1. On the pre-13736ee commit (or by directly writing a `-NoEncryption` `Configuration.json` with `"credentials":{"username":"admin -oProxyCommand=calc.exe x","password":"x"}}`), save that config.
2. Checkout current `HEAD` (with the fix) and run `Start-NetworkMapper.ps1` against that file.
3. Click "Launch SSH Session" (`/api/connect`) against any IP — `Invoke-ConnectAction` uses `$script:JunosUsername` set at line 883, never touches the line-729 regex, and reaches `Connect-Switch.ps1`'s unescaped command-line build.

**Fix sketch:** Validate `$JunosUsername` once, in `Start-MapperWebServer`, at the same point it's assigned to `$script:JunosUsername` (line 883-884) — using the same regex/character-class as `Invoke-SaveConfigAction` — and refuse to arm SSH-dependent endpoints (or blank the in-memory username, matching the existing "no configured Juniper login" 400 behavior already used elsewhere in this file) if it fails. This closes the gap without requiring a config migration/rewrite.

---

## P2WS-002 — WS-2's "silently discarded" fix is incomplete: two structurally identical orphaned-job-result discards were left unlogged

**Track:** SERVICE (WS-2 follow-up)
**File:line:** `lib/WebServer.ps1:269-273` (`Invoke-PingAction`'s unpolled-ping reap), `lib/WebServer.ps1:462-468` (`Invoke-ScanNetworkAction`'s unpolled-scan reap)
**Severity:** LOW
**Confidence:** HIGH

**Claim:** The WS-2 commit's stated rationale is: "results from late-completing orphaned rescan/ping jobs were discarded via Out-Null with no log trace, unlike every other error/completion path in this file. Now logged." That statement is not accurate as a description of the file after the fix — there are two more sites with the exact same shape (a completed background job's `EndInvoke()` result discarded via `Out-Null` inside a `try {} catch {}` with no log line either way) that the commit did not touch:
- `Invoke-PingAction:269-273` — reaps `$script:PendingPing` when the *client never polled* for its result (drawer closed / page reload) before submitting a new ping. Both the success and failure (`catch {}`) branches are silent.
- `Invoke-ScanNetworkAction:462-468` — reaps `$script:PendingScanNetwork` under the identical "client never polled" circumstance for a fleet crawl (a scan can run for minutes and touch multiple real switches, making this the highest-value case to have logged, not the lowest).

These are a different orphan mechanism than the ones WS-2 fixed (`$script:OrphanedScans`/`$script:OrphanedPings`, populated only after a server-side *timeout* — 90s/20s), but the failure mode and information loss are identical: a job's outcome (including any error) vanishes with no trace in `Mapper_Debug.log`, making a scan/ping that quietly failed after the tab was closed just as undiagnosable as the case WS-2 was written to fix.

**Trigger:** Close the browser tab (or navigate away) while a ping or a fleet scan-network job is in flight, then later start a new ping / scan-network request from a fresh tab. The reap silently swallows whatever the abandoned job returned or threw.

**Evidence:** Direct line comparison — `lib/WebServer.ps1:194-199` (fixed, now logs both branches) vs. `lib/WebServer.ps1:270` and `:465` (same `EndInvoke(...) | Out-Null` / `try {} catch {}` shape, no `Write-MapperDebugLog` call in either).

**Invariant hit:** INV-JOBS (background jobs must be cleaned up traceably; silent loss of a failed job's diagnostic info undermines the "no leaked/undiagnosable job" guarantee WS-2 was meant to restore file-wide).

**Impact:** Low — no resource leak (Dispose still runs), no security impact, purely an observability gap. But it means WS-2's fix is inconsistent within the same file: two of the four analogous "orphaned/abandoned job result discarded" sites now log, two still don't, contradicting the commit's own "unlike every other ... path in this file" framing.

**Repro:** Read `lib/WebServer.ps1:269-273` and `:462-468` next to the fixed `:191-203`/`:252-264` — no code execution needed to confirm; it's a straightforward code-comparison finding.

**Fix sketch:** Add the same `Write-MapperDebugLog` success/failure lines used in the WS-2 fix to both of these reap sites, for consistency and so an abandoned scan/ping's failure is diagnosable from the log like every other job-completion path now claims to be.

---

## Categories checked with no surviving finding

- **Concurrency:** Single-threaded accept loop (confirmed via file header comment and structure at `:901-943`) rules out races on `$script:Pending*`/`$script:Orphaned*` state; no new bug found here.
- **Resource leaks (WS-2 code itself):** `Write-MapperDebugLog` has its own internal `try/catch` (line 58) and cannot throw, so it can't interrupt the `Orphan.PS.Dispose()` / `RemoveAt()` cleanup that follows it in either modified block — no new leak introduced by the logging additions.
- **Secret logging (WS-2):** Traced the only two log message shapes added (`"... Job completed after client timeout (result discarded)"` and `"... but failed: $_"`) against `Get-JunosNodeData.ps1`/`SshHelpers.ps1` — neither the worker script nor the SSH-arg builder embeds `$Password` in any string that could reach a thrown exception's `.Message`; no secret-logging path found.
- **Regex bypass (character class itself):** No case found where a value matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$` (or the empty string) can still carry a shell/SSH metacharacter — the class excludes spaces, `@`, quotes, and all `-o...=` injection syntax used in the original SSH-001/002 PoC.
- **WS-1 (Dispose-in-finally):** Not re-tested; no new trigger condition found beyond what Pass 1's verifier already empirically disproved. Not re-reported per instructions.

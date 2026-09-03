# Pass 3 findings — lib/WebServer.ps1

Scope per dispatch: full comprehensive re-read of the entire ~1050-line file (not just
job-lifecycle/logging/SSH areas prior passes concentrated on), with extra attention to HTTP
dispatch table, non-scan/rescan/ping/connect endpoints, static file serving, session/password
handling, response headers, and error formatting. `git show 788dea4` (P2WS-002, the only diff
to this file since Pass 2) reviewed directly — see "P2WS-002 diff re-verification" below.

---

## P3WS-001 — `Invoke-SaveConfigAction` writes `Configuration.json(.enc)` in place with no temp+rename; a crash mid-write truncates the operator's only saved config/credentials, indistinguishable from a wrong password at next startup

**Track:** DATA / CORE (same bug class as Pass 1's CRYPTO-001, missed in both Pass 1 and Pass 2)
**File:line:** `lib/WebServer.ps1:748` (plaintext/`-NoEncryption` branch), `lib/WebServer.ps1:761` (encrypted branch), both inside `Invoke-SaveConfigAction` (`lib/WebServer.ps1:701-780`)
**Severity:** HIGH
**Confidence:** HIGH

**Claim:** `Invoke-SaveConfigAction` — the sole write path for `Configuration.json` / `Configuration.json.enc` (verified by repo-wide grep: no other function in `lib/*.ps1` or `Start-NetworkMapper.ps1` ever writes to `$ConfigPath`) — writes directly to the live config file with a bare `Out-File -FilePath $ConfigPath`:

```powershell
# plaintext / -NoEncryption path, line 748
$Parsed | ConvertTo-Json -Depth 10 | Out-File -FilePath $ConfigPath -Encoding utf8
...
# encrypted path, line 761
$Envelope | ConvertTo-Json -Depth 10 | Out-File -FilePath $ConfigPath -Encoding utf8
```

This is the exact failure class Pass 1's CRYPTO-001 found and fixed in `Protect-MapperFile.ps1` (in-place `Out-File` → truncation on crash) and Pass 2's P2CRYPTO-001/002 widened to `FleetCrawl.ps1`'s topology writes (`lib/FleetCrawl.ps1:77-86`, which now writes to a `.tmp` file and calls the new `Move-TopologyOutputLocal` — `[System.IO.File]::Replace` when the destination exists, `Move-Item` otherwise — for a true atomic replace; see `lib/FleetCrawl.ps1:50-86`). Both prior fix passes explicitly scoped their fix-groups to `Protect-MapperFile.ps1` + `FleetCrawl.ps1` (`AUDIT_LEDGER.md` fix groups, Pass 1 group 2 and Pass 2 group 4) and never touched `WebServer.ps1`'s own independent write path for the same file (`Configuration.json.enc`), even though it is a second, structurally identical writer of exactly the file type CRYPTO-001 was written to protect. This is a real gap, not a stylistic inconsistency: `Configuration.json.enc` holds the operator's saved Junos SSH username/password and scan settings, and `Invoke-SaveConfigAction` is hit on every "Save" click from the Settings tab — a far more frequent write than a topology snapshot.

**Trigger:** Kill the `pwsh` process (crash, OOM, forced shutdown, power loss) at any point during the `Out-File` call at line 748 or 761 — e.g. mid-write while saving updated SSH credentials from the Settings tab. `Out-File` is not atomic; a partial write leaves `Configuration.json.enc` truncated or zero-length on disk, and there is no `.tmp` file and no prior-good copy to recover from (unlike the now-fixed `Protect-MapperFile.ps1`/`FleetCrawl.ps1` paths, which never touch the destination file directly).

**Evidence:**
- `grep -rn "Out-File" lib/*.ps1` shows `WebServer.ps1:748,761` writing directly to `$ConfigPath`/`$Path`-as-final-destination, vs. `Protect-MapperFile.ps1:130,168` and `FleetCrawl.ps1:82,84` which write to a `$TempTargetPath`/temp-named path that a subsequent atomic-replace step (`Move-Item`/`[System.IO.File]::Replace`) then promotes to the real destination.
- `grep -rn "ConfigPath\|Configuration.json" lib/*.ps1 Start-NetworkMapper.ps1` confirms `Invoke-SaveConfigAction` is the only writer of this file; `Protect-MapperFile.ps1` is a standalone admin CLI script never invoked from `WebServer.ps1` or `Start-NetworkMapper.ps1` for this file.
- `Start-NetworkMapper.ps1:80-110` (config-load path) confirms the consequence: a corrupted/truncated `Configuration.json.enc` fails `Unprotect-TopologyPayload` (or fails `ConvertFrom-Json` before that) exactly the same way a wrong password does — three re-prompt attempts, then forced into "continue without server-side credentials" (blanking `$EncryptionPassword`, which also then disables all future saves per the fail-closed check at `WebServer.ps1:704-711`) or an outright `throw` abort. There is no code path that distinguishes "you typed the wrong password" from "the file itself is truncated garbage," and no backup copy exists anywhere to recover the pre-crash config from.

**Invariant hit:** INV-DATA (the saved config file is not corruption-proof against a mid-write crash) and INV-NO-LOCKOUT (the resulting failure is indistinguishable from a wrong password, and the only offered recovery is "continue without server-side credentials," i.e. permanent loss of the saved config with no path back to the last-good version) — the same two invariants CRYPTO-001 was adjudicated CONFIRMED/HIGH against for `Protect-MapperFile.ps1`.

**Impact:** A crash/kill/power-loss during any Settings-tab "Save" (a routine, frequent action — far more common than a full fleet crawl's periodic topology write) can permanently destroy the operator's saved Junos credentials and scan configuration, with the failure surfacing at next startup as an indistinguishable-from-wrong-password decrypt failure and no recovery path other than re-entering everything from scratch.

**Repro (code trace, no execution needed to confirm the missing atomicity — matches this file's own established manual-repro convention since no PS test runner exists):**
1. `POST /api/save-config` with a valid body and matching `Origin` header while encryption is enabled.
2. Inside `Invoke-SaveConfigAction`, execution reaches line 761: `$Envelope | ConvertTo-Json -Depth 10 | Out-File -FilePath $ConfigPath -Encoding utf8`.
3. If the process is killed while this `Out-File` call is writing (e.g. `Stop-Process -Force` on the `pwsh` PID, or a real crash/power-loss), `$ConfigPath` is left partially written — `Out-File` provides no atomicity guarantee, and unlike `Protect-MapperFile.ps1`/`FleetCrawl.ps1` there is no temp file and no `Move-Item`/`[System.IO.File]::Replace` step that could have been aborted before touching the real file.
4. Next launch: `Start-NetworkMapper.ps1:87-88` — `Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json` throws on the truncated JSON, or `Unprotect-TopologyPayload` throws on a truncated/HMAC-mismatched envelope — either way `Start-NetworkMapper.ps1:89-104` treats it identically to "wrong password," offering 3 retries then "continue without credentials or abort," never "restore from a backup," because no backup was ever made.

**Fix sketch:** Route `Invoke-SaveConfigAction`'s writes through the same atomic-replace helper `FleetCrawl.ps1` now uses (or through `Protect-MapperFile.ps1`'s temp+`Out-File`+`Move-Item`/`Replace` pattern) instead of writing `$ConfigPath` directly — write to a uniquely-named `.tmp` file first, then atomically replace, exactly as P2CRYPTO-001/002 already established as the correct pattern elsewhere in this codebase.

---

## P3WS-002 — `Invoke-PingStatusAction`/`Invoke-RescanStatusAction` consume the job result (null the pending slot, `EndInvoke`, `Dispose`) *before* sending the response; if the client has already disconnected, `Send-WebJson` fails and the result is unrecoverably lost even though the job itself succeeded

**Track:** SERVICE (job-lifecycle, same functional family as WS-2/P2WS-002 but a different failure axis — send-path failure, not job-completion discard)
**File:line:** `lib/WebServer.ps1:393-448` (`Invoke-RescanStatusAction`), `lib/WebServer.ps1:338-390` (`Invoke-PingStatusAction`)
**Severity:** MEDIUM
**Confidence:** HIGH

**Claim:** Both status-poll endpoints follow the same shape: once `$Job.Handle.IsCompleted`, they (1) null the script-scoped pending slot, (2) call `EndInvoke()` — which cannot be called a second time on the same handle — (3) `Dispose()` the `[powershell]` instance, and only *then* (4) call `Send-WebJson` to write the result to the HTTP response. Concretely, `Invoke-RescanStatusAction`: `$script:PendingScan = $null` (line 404) → `EndInvoke` (406) → `$Job.PS.Dispose()` (412) → `Send-WebJson ... node = $Result.Node` (429). `Invoke-PingStatusAction` is identical: `$script:PendingPing = $null` (349) → `EndInvoke` (351) → `Dispose()` (357) → `Send-WebJson` (367-370).

These are exactly the endpoints this file's own comments describe as being polled every 1-2s and abandoned mid-poll ("client abandoned poll", "drawer closed, page reload" — see the P2WS-002 orphan-reap comments a few lines above each of these functions). If the browser has already navigated away or closed the tab by the time this response write happens, `$Response.OutputStream.Write` (inside `Send-WebResponse`, called from `Send-WebJson`) throws (the underlying `HttpListenerResponse` stream throws on a write to a socket whose peer has disconnected). By that point in the function, the job's state has already been irreversibly destroyed: the pending slot is null, `EndInvoke` has already been consumed (a second call throws `InvalidOperationException`), and `PS` is disposed. The exception propagates out to the request-level catch-all (`:1042-1045`), which logs `"UNHANDLED REQUEST ERROR [GET /api/rescan/status] ..."` and attempts a second `Send-WebJson` that will also fail on the same dead connection (swallowed by its own empty `catch {}` at :1044). If the browser reconnects and re-polls the same `jobId`, `Invoke-RescanStatusAction`/`Invoke-PingStatusAction`'s guard clause (`-not $script:PendingScan -or $script:PendingScan.JobId -ne $JobId`) now fails — the slot is null — and it gets a `404 "Unknown or expired job id"`. The rescan/ping actually completed successfully (for rescan: a real ~90s SSH session against a live switch, fetching fresh device data), but that result is gone with no way to retrieve it; the operator has to notice the loss and manually re-trigger.

This exact pattern is what `Invoke-ScanNetworkStatusAction` was built to avoid, in the same file: it caches the outcome into `$Job.Outcome` and sets `$Job.Collected = $true` *before* the `Send-WebJson` call (`:551-583` collect, `:587` send), specifically so a re-poll after a failed send can re-serve the same cached result idempotently (its own comment: "later polls just re-serve the cached outcome"). `Invoke-PingStatusAction`/`Invoke-RescanStatusAction` do not have this safety net — they were apparently never brought in line with that pattern.

**Trigger:** Start a rescan or ping; close the browser tab (or navigate away) in the ~1-2s window between the poll request landing and `Send-WebJson` writing the response, after the job has completed. This is not a contrived race — it's the ordinary shape of "abandon a poll" that this file's own comments treat as a routine, expected occurrence for these same two endpoints.

**Evidence:** Direct structural comparison within the same file: `Invoke-ScanNetworkStatusAction:551-587` (collect-then-cache-then-send, safe against a failed send) vs. `Invoke-RescanStatusAction:404-429` and `Invoke-PingStatusAction:349-370` (null-slot-then-EndInvoke-then-Dispose-then-send, unsafe). The request-level catch-all at `:1042-1045` confirms a thrown exception here is caught (not a process crash) but only logs — it has no way to restore `$script:PendingScan`/`$script:PendingPing` or replay `EndInvoke`.

**Invariant hit:** INV-JOBS (background job results must not be lost/undiagnosable) — the job itself is cleaned up correctly (no leak, `Dispose()` still runs), but its *result* is lost on the specific interleaving of "job finishes right as the client that would receive it disconnects," which is the designed-for common case for these polling endpoints, not an edge case.

**Impact:** MEDIUM — no resource leak, no security impact, but a real, moderately likely loss of a genuinely completed rescan/ping result (for rescan, discarding a live SSH round-trip's worth of fresh switch data) with no automatic recovery; the operator sees a job that silently vanished and must manually retry.

**Repro:** Code trace only (matches this file's own established manual-repro convention, no PS test runner exists): follow `Invoke-RescanStatusAction:404` (`$script:PendingScan = $null`) through `:429` (`Send-WebJson`) and note nothing between those lines can restore the slot or replay `EndInvoke` if the intervening `Send-WebJson` throws; compare directly against `Invoke-ScanNetworkStatusAction:554-587`'s collect-before-send/cache-and-replay structure, which was clearly written specifically to prevent this class of loss.

**Fix sketch:** Apply the same `Collected`/`Outcome`-caching pattern `Invoke-ScanNetworkStatusAction` already uses: collect (`EndInvoke`+`Dispose`) into a cached result object, mark the job collected, *then* attempt to send — with the pending slot only nulled (or the job moved to an already-collected state) after a successful send, so a failed send due to a dead connection can be retried against the same cached outcome on the next poll with the same `jobId`, instead of the slot being unconditionally destroyed up front.

---

## P3WS-003 — `/api/session-password` response carries no `Cache-Control` header, and the browser's `fetch()` call doesn't request `no-store`

**Track:** SERVICE/CORE (INV-CREDS-adjacent)
**File:line:** `lib/WebServer.ps1:636-639` (`Invoke-GetSessionPasswordAction`) and `lib/WebServer.ps1:26-33` (`Send-WebResponse`, which never sets `Cache-Control` on any response); client side `web-src/app.js:168` (`fetch('/api/session-password')`, no `cache` option)
**Severity:** LOW
**Confidence:** MEDIUM

**Claim:** `Invoke-GetSessionPasswordAction` hands the browser the plaintext topology-encryption password in a plain `GET` JSON response. `Send-WebResponse` (the single function every response in this file goes through) sets only `StatusCode`, `ContentType`, and `ContentLength64` — no `Cache-Control: no-store` (or `Pragma: no-cache`) is ever emitted, on this or any other endpoint. The one client call to this endpoint, `web-src/app.js:168`, is a bare `fetch('/api/session-password')` with no `cache: 'no-store'` option, so both sides of this exchange rely on the browser's default heuristics rather than an explicit no-caching directive. This is the file's own stated threat model for this exact endpoint (the comment at `:630-633` explicitly reasons about DNS-rebinding and calls the leaked-password scenario "silent and durable ... decrypts every archived snapshot offline, indefinitely" as the reason this GET is CSRF-gated at all) — an explicit `Cache-Control: no-store` is the standard, cheap complement to that same reasoning: without it, nothing stops a browser's on-disk HTTP cache (or a caching proxy, though not applicable on localhost) from persisting the plaintext password outside the app's own encrypted-envelope storage model.

**Trigger:** Not independently confirmed to actually populate the browser's disk cache in this specific case (a response with no `Last-Modified`/`ETag`/`Expires`/`Cache-Control` at all is not reliably heuristically cacheable per RFC 7234 in most browsers, since there's no validator to revalidate against) — this is flagged as a missing defense-in-depth header on a request the file's own comments already treat as unusually sensitive, not as a demonstrated live leak.

**Evidence:** `lib/WebServer.ps1:26-33` (`Send-WebResponse`, no cache header ever set, by grep across the whole file); `web-src/app.js:168` (`fetch('/api/session-password')`, no `cache` option, confirmed by direct read).

**Invariant hit:** INV-CREDS (the encryption password should not be left behind outside its intended lifetime/storage) — marginal, since the primary channel (in-memory JS variable via `sessionPasswordPromise`) is already correct; this is about a secondary, unlikely-but-uncosted persistence path.

**Impact:** LOW — the file's own comment already frames a leaked session password as high-consequence ("silent and durable"), which is why this is worth flagging even at low likelihood; the fix is a one-line header addition with no behavior change for the legitimate path.

**Fix sketch:** Add `$Response.Headers.Add("Cache-Control", "no-store")` (or equivalent) at least to `Invoke-GetSessionPasswordAction`'s response, and pass `cache: 'no-store'` on the `fetch()` call in `app.js:168` as belt-and-suspenders.

---

## P2WS-002 diff re-verification (`git show 788dea4`)

Re-read the actual landed diff line-by-line rather than trusting the ledger's "CONFIRMED, fixed" summary. Both new sites (`Invoke-PingAction:269-278`, `Invoke-ScanNetworkAction:467-480`) correctly wrap `EndInvoke()` in try/catch with a `Write-MapperDebugLog` call on both the success and failure branch, structurally matching the two sites Pass 1's WS-2 fixed (`Invoke-RescanAction:191-203`, `Invoke-PingAction`'s own orphan-list loop at `:250-264`). No shadowing of `$_`/loop variables (unlike the pattern `Invoke-GetSnapshotsAction` had to guard against with its `$File = $_` capture — not applicable here since neither new block is inside a `ForEach-Object`), no double-dispose, no new resource leak, no secret (`$JunosPassword`) reachable from either new log line. The diff itself is clean — no new bug found in the P2WS-002 change.

---

## Categories checked with no surviving finding

- **HTTP dispatch table completeness:** Every `elseif` branch in `Start-MapperWebServer`'s accept loop (`:957-1041`) was enumerated against the endpoint functions defined earlier in the file — no route dispatches to the wrong handler, no handler is unreachable, and every state-changing/sensitive-data endpoint (`/api/connect`, `/api/rescan`, `/api/rescan/status`, `/api/ping`, `/api/ping/status`, `/api/client-error`, `/api/scan-network`, `/api/scan-network/status`, `/api/config`, `/api/session-password`, `/api/snapshots`, `/api/save-config`) is gated by `Test-SameOriginRequest`, matching Pass 1's security cross-cut finding (still true after 2 passes of edits — sanity-checked directly by re-reading all 12 gated branches, not just spot-checking).
- **Static file serving / path traversal:** `Invoke-StaticFile`'s `GetFullPath` + trailing-separator `StartsWith` guard was independently re-tested (`pwsh -Command` against `/tmp/vizroot`) with a `../../../../etc/passwd` payload — correctly resolves outside root and is rejected (`startsWith=False`). `Invoke-SingleFileVisualizer` only ever resolves `/` or `/Network_Visualizer.html` and never falls through to `$VisualizerRoot`, so single-file mode can't be widened back to whole-tree serving.
- **Session/password handling:** `Invoke-GetSessionPasswordAction` is gated by `Test-SameOriginRequest` with a specific comment explaining why a GET still needs the CSRF guard (DNS-rebinding); traced that `$EncryptionPassword` never appears in any `Write-MapperDebugLog` call anywhere in the file (grep confirms every log line references `$_`/IP/path/job-id, never a credential variable).
- **Response header / error-formatting consistency:** `Send-WebJson`'s own serialization-failure fallback (`:37-47`) and every endpoint's catch-block error body were checked for a consistent `{error: "..."}` JSON shape reaching the client on every failure path (400/403/404/409/500) — no endpoint falls through to a non-JSON body that would break the browser's blanket `.json()` parsing.
- **Resource limits:** `Invoke-GetSnapshotsAction`'s `$MaxSnapshots = 20` cap and per-file try/catch (re-verified still present, unchanged since Pass 1/2) still bound that endpoint's cost. Checked, not "no gap": `Read-WebRequestBody` (`:88-92`) has no request-body size cap, and `Invoke-ClientErrorAction` writes an attacker/bug-controlled stack trace into `Mapper_Debug.log` line-by-line with no length limit — both are judged acceptable under this app's stated trust boundary (single local analyst, same OS user as the process owner; see the file's own header comment), not evidence of an actual bound. Not re-reported as a new finding since Pass 1/2 already established and accepted this trust boundary for the file as a whole.
- **Concurrency:** Confirmed (again) that the accept loop is single-threaded (`BeginGetContext`/`WaitOne(250)` polling, one request dispatched at a time) — rules out races on any `$script:Pending*`/`$script:Orphaned*` state touched by the P2WS-002 diff or elsewhere in the file.
- **WS-1 (Dispose-in-finally):** Not re-tested; still no new trigger condition beyond Pass 1's empirical disproof. Not re-reported.

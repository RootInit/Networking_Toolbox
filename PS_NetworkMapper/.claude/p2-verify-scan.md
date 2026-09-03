# Pass 2 adversarial verification — P2SCAN-CLUSTER (P2SCAN-001, P2SCAN-002, P2REC-002)

Method: read `web-src/app.js` and `web-src/scan-network.js` in full at current HEAD (no
edits made anywhere in this pass), traced the exact synchronous/microtask/macrotask sequence
by hand against real `async function` suspension semantics (a function body runs
synchronously up to its first `await`, then returns a pending promise and yields control
back to its caller — this is the crux fact both original findings lean on and it checks out).
No server was run; this is a code trace, same evidentiary basis the original findings used.

---

## P2SCAN-001

**Verdict: CONFIRMED — HIGH. Deterministic given the stated precondition, not narrowly
timing-dependent. My own trace finds the bug is actually *more* robustly deterministic than
the original writeup argued (see below) — this strengthens the original finding rather than
weakening it.**

### Exact sequence traced

`DOMContentLoaded` (app.js:375-380) runs synchronously:
1. `resumeScanIfInProgress()` is invoked. As an `async function`, it executes synchronously
   up to its first `await`: the guard at scan-network.js:145
   (`if (loadedSnapshots.length > 0 || scanNetworkPollTimer) return;`) evaluates on a fresh
   page load with both operands false/null, so it falls through, synchronously starts
   `fetch('/api/scan-network/status')`, hits the `await`, and suspends — control returns to
   the caller *before* any response has arrived.
2. `autoloadLastScan()` is invoked next, in the same synchronous tick. Its own guard at
   app.js:325 (`if (loadedSnapshots.length > 0) return;`) is also false at this point (nothing
   has populated `loadedSnapshots` yet — step 1 never got that far), so it captures
   `myGenerationAtStart = loadFilesGeneration` (0), starts `fetch('/api/snapshots')`, and
   suspends at its own `await`.

At this point both fetches are in flight concurrently and `DOMContentLoaded` has returned.
Two continuations are now pending, and their relative resolution order is the only thing that
depends on network timing — but (this is the key point the original finding gets right) **the
outcome does not depend on which one resolves first**:

- **Order A (status fetch resolves first, sees `running`):** `resumeScanIfInProgress`'s
  continuation checks `status.status !== 'running'` (false), calls `pollRunningScan()`
  synchronously. `pollRunningScan` synchronously sets `scanNetworkBtn.disabled = true`,
  `loadBtn.disabled = true`, `loadFolderBtn.disabled = true` (scan-network.js:86-88), then
  calls `poll()` (async, immediately yields at its own `await fetch(...)`). Neither this call
  nor anything inside `poll()`'s `'running'` branch (scan-network.js:116-119) ever touches
  `loadedSnapshots` or `loadFilesGeneration` — confirmed by reading the whole function body.
  So `autoloadLastScan`'s in-flight continuation is completely unaffected by this.
- **Order B (`/api/snapshots` resolves first):** `autoloadLastScan`'s continuation runs first,
  reaches its pre-`processSelectedFiles` re-check (app.js:361:
  `if (loadFilesGeneration !== myGenerationAtStart || loadedSnapshots.length > 0) return;`) —
  both still false/0, since nothing has bumped either yet — and calls
  `await window.processSelectedFiles(files)` with the **stale archived snapshot list**.
  `processSelectedFiles` (app.js:413) synchronously bumps `loadFilesGeneration` to 1, disables
  the three buttons (already-redundant if Order A's disable also lands, harmless either way),
  and proceeds through its `for` loop over files, each iteration doing a real
  `await new Promise(r => setTimeout(r, 20))` plus a `FileReader` round trip — genuinely slow
  compared to a same-machine status poll. Whichever order the two initial fetches resolved in,
  `resumeScanIfInProgress`'s status check (a single fast fetch + JSON parse) will essentially
  always land *during* this multi-file/multi-await stretch, not after it.

Splitting the claim into its two halves, since they have different strength of determinism:

- **Stale snapshot loaded and shown as green "Success!":** logically order-independent, not
  just "usually" — neither function ever reads the other's state. `loadFilesGeneration` and
  `loadedSnapshots.length` are the *only* signals `autoloadLastScan`/`processSelectedFiles`
  consult, and `pollRunningScan`/`resumeScanIfInProgress` never write to either one until the
  real scan actually completes (confirmed by reading every line of both functions). So
  regardless of which of the two initial fetches resolves first, `autoloadLastScan` proceeds
  to `processSelectedFiles(files)` with the stale archived snapshot and it renders.
- **Buttons end up enabled during the still-running scan:** this occurs in *every* ordering I
  traced, but strictly speaking it is guaranteed only when the status fetch's continuation
  (`resumeScanIfInProgress` → `pollRunningScan`'s synchronous disable) lands *before*
  `processSelectedFiles`'s `finally` runs — not a logical certainty, since if `finally` somehow
  ran and then the status fetch's continuation ran after it, `pollRunningScan`'s disable would
  land last and the buttons would stay disabled. What makes this deterministic *in practice*
  rather than a coin flip is the cost asymmetry: `resumeScanIfInProgress`'s path is one
  localhost GET plus a JSON parse, while `processSelectedFiles`'s path is a `20ms`-per-file
  `setTimeout`, a `FileReader` round trip, JSON parse, search-index build, two `nextPaint()`
  awaits, and an awaited `buildSwitchMap()` inside `setActiveSnapshot` — several real,
  unavoidable macrotask-boundary delays stacked on top of each other. The status fetch will
  essentially always land inside that window. So: guaranteed for the "stale data shown" half,
  overwhelmingly reliable-in-practice (not a strict logical guarantee) for the "buttons end up
  enabled" half — both still satisfy "deterministic given the precondition, not a narrow
  interleaving" as the original finding claimed, but I want the distinction on record rather
  than asserting a logical guarantee the code doesn't quite provide for the second half.
  `pollRunningScan`'s poll loop (scan-network.js:116-119) never modifies `.disabled` on any
  tick except the terminal `finish()` call, so once the buttons are wrongly re-enabled nothing
  in the poll loop itself ever notices or corrects it — that part *is* a hard guarantee.

3. Confirmed the displayed status text: `processSelectedFiles` sets green
   `"Success! Mapped N nodes."` (app.js:519) using the **stale** snapshot's device count, and
   this happens while `scanNetworkBtn.textContent` still reads `"Scanning (N found)..."` (set
   by whichever of `resumeScanIfInProgress`/`pollRunningScan`'s ticks ran) — the two visible UI
   surfaces contradict each other, both live at once, and there is nothing that reconciles them
   until the real scan eventually completes.

### On P2REC-002's narrower reframing (potential conflict, adjudicated)

P2REC-002 explicitly argues the reverse: that `autoloadLastScan`'s generation-guard plus
`processSelectedFiles`'s "newest-generation-wins" semantics mean *"the final displayed
topology can never end up wrong/stale in either ordering"* and downgrades this to a narrow,
Low-severity, button-only, non-deterministic ("not deterministic every time") finding.

This is true about the **eventual, post-scan-completion** state (once `pollRunningScan`'s
`finish()` on the `'complete'` branch calls `processSelectedFiles` again with the real
`syntheticFile`, generation bumps again and the real data does overwrite the stale display).
But P2REC-002 is answering a different, narrower question than P2SCAN-001 asks. P2SCAN-001's
claim is about the **interim** state — for the entire remaining duration of the fleet crawl
(which is the whole point of the async job/poll design; can be minutes), the operator is shown
a green "Success!" banner and a fully-rendered stale topology, both of which they have every
reason to believe are current and correct, while the one honest signal
(`scanNetworkBtn`'s text) is easy to miss or misread as "the scan is still finishing up
something unrelated." That interim window is real, is not self-evidently harmless just because
it self-heals later, and is exactly the class of finding this audit's INV-UI-TRUTH invariant
(closest named analogue, even though P2SCAN-001 doesn't cite it directly) was written to catch
("the dashboard/map/graph never presents stale or misinterpreted device data as current
truth"). P2REC-002's own severity note ("a UI-control-state consistency bug... below the bar
of the invariants that would make it more than Low") only evaluates the *button* half and
explicitly declines to re-litigate the data-clobber half, treating it as already resolved by
the generation-guard argument — but the generation guard only protects the **final** state, not
the **interim** one, and interim-state truth is squarely what P2SCAN-001 is about. I side with
P2SCAN-001's severity here: HIGH, not Low, for the reasons above. (P2REC-002's narrower
"button re-enable" observation is subsumed by and consistent with P2SCAN-001's fuller trace,
not contradictory on the facts — only on how much weight to give the interim-state impact.)

### Precise repro

Precondition: (1) at least one archived, loadable snapshot exists on disk in the snapshot
folder `/api/snapshots` serves from (plaintext, or encrypted with a session password the
server already handed the browser via `/api/session-password`); (2) a fleet scan is genuinely
running server-side (`$script:PendingScanNetwork` populated, `/api/scan-network/status`
returns `{status:'running', visited: N}`).

Verified `Invoke-GetSnapshotsAction` (`lib/WebServer.ps1:639-684`, backs `GET /api/snapshots`):
returns `{snapshots: [{name, content}]}` as assumed above, and filters with the exact same
`^NetworkMap_.*\.json(\.enc)?$` / `\.tmp\.json(\.enc)?$`-exclusion pattern app.js's
`forceLoadFolder` uses client-side (WebServer.ps1:656) — so a scan's in-progress `.tmp.json`
write is never served by this endpoint. What autoload loads is always the previous *complete*
snapshot, not a partial in-progress one; the impact description above (stale-but-complete data
shown as current) is accurate as written, not understated.

1. Complete one scan normally so a prior snapshot exists on disk.
2. Start a new scan (`POST /api/scan-network` succeeds, 200).
3. While it's still running (before it reaches `'complete'`), refresh the browser tab.
4. `DOMContentLoaded` fires `resumeScanIfInProgress()` then `autoloadLastScan()`, unawaited,
   as traced above.
5. Within roughly one to a few hundred milliseconds (two fast localhost fetches plus file-read/
   parse of the archived snapshot — trivial compared to an SSH fleet crawl),
   `processSelectedFiles` reaches its `finally` and re-enables Load/Load Folder/Scan Network.
   Observe: status line reads green `"Success! Mapped N nodes."` (N = the *old* snapshot's
   device count), the graph/dashboard show the *old* topology, all three buttons are clickable,
   and `scanNetworkBtn`'s own text still says `"Scanning (M found)..."` — deterministically, on
   this refresh and any other mid-scan refresh meeting the precondition.

**Fix sketch (matches original):** give `pollRunningScan`/`resumeScanIfInProgress` a way to
claim ownership of the load-button/status-line state that `autoloadLastScan` and
`processSelectedFiles` are required to check before proceeding — simplest: have
`resumeScanIfInProgress` synchronously (before its own `await`) set a flag/bump
`loadFilesGeneration` once it confirms `status.status === 'running'`, and have
`autoloadLastScan` re-check that same signal immediately before its own
`processSelectedFiles` call, the same way it already re-checks `loadedSnapshots.length`.

---

## P2SCAN-002

**Verdict: CONFIRMED — MEDIUM-HIGH, as originally rated. Reachable via a concrete, realistic
path (not contrived), contingent on one extra user click, correctly described as such by the
original finding.**

### Verified against source

- `scan-network.js:4`: `var scanNetworkPollTimer = null;` — single module-level variable, no
  per-invocation identity anywhere in the file.
- `pollRunningScan()` (scan-network.js:73-137) defines fresh `finish`/`poll` closures on every
  call, but both close over the *same* free variable `scanNetworkPollTimer`. Confirmed no
  generation token, no reentrancy guard (`if (scanNetworkPollTimer) return;` is absent),
  nothing scoped to the call.
- `finish()` (scan-network.js:78-84): `clearTimeout(scanNetworkPollTimer)` — clears whatever
  value the shared variable currently holds, which after two independent chains have each done
  at least one `setTimeout(poll, 2000)` (line 118) is not reliably "this chain's own" timer id.
- `poll()`'s `'running'` branch (scan-network.js:116-119): `scanNetworkPollTimer =
  setTimeout(poll, 2000);` — each chain's tick unconditionally overwrites the shared slot with
  its own next timer id, clobbering whatever the other chain last wrote.

### Reachability, traced independently of the original writeup

Verified the concrete path the original finding claims, step by step against the code:

1. After P2SCAN-001's clobber (confirmed above), `scanNetworkBtn` is enabled while
   `resumeScanIfInProgress`'s original `pollRunningScan()` chain (call it Chain 1) is still
   alive and ticking every 2s (nothing ever stopped it — the real scan is still running).
2. `loadedSnapshots.length > 0` is now true (the stale snapshot was loaded), so a click on
   "Scan Network" routes `startNetworkScan()` (scan-network.js:167) into the
   *already-loaded* branch: `bestStartIpFromActiveSnapshot()` (computed off the stale
   snapshot, succeeds fine — verified it degrades to `null`/blank input only on empty
   topology, not relevant here) → `promptForStartIp(computedIp, true)` shows the
   replace-confirm modal, pre-filled.
3. On confirm, `POST /api/scan-network` is sent. Verified server-side
   (`lib/WebServer.ps1:447-473`, `Invoke-ScanNetworkAction`): a scan already in
   `$script:PendingScanNetwork` causes an immediate `Send-WebJson -StatusCode 409` reply
   (WebServer.ps1:473) — genuinely reachable, not a hypothetical status code.
4. `startNetworkScan`'s 409 handling (scan-network.js:212-217) re-enables buttons, sets an
   orange "reattaching" status, and calls `pollRunningScan()` a **second time** (Chain 2),
   while Chain 1 (from step 1) is still alive and holds/writes the shared
   `scanNetworkPollTimer`.
5. From here the two chains' `setTimeout`/`clearTimeout` calls race on the single shared
   variable exactly as described: whichever chain's tick runs later overwrites the id the
   other chain needs to cancel its *own* pending timer, and whichever chain's `finish()` fires
   first (on any transient fetch error, a 404 from a server restart, or a non-`running`
   response) calls `clearTimeout` on whatever the shared variable currently holds — which, once
   both chains have ticked at least once, is not guaranteed to be its own id, and can silently
   cancel the other, still-healthy chain's next tick with no error, no log, and no user-visible
   indication beyond that chain simply going quiet.

This matches the original finding's mechanism and repro exactly; I found no guard anywhere in
`pollRunningScan`, `finish`, `resumeScanIfInProgress`, or `startNetworkScan` that would prevent
two concurrent chains from being created, and no coordination between them once both exist.

**Severity note:** correctly rated below P2SCAN-001 — it requires an extra user action (a
click + modal confirm) on top of P2SCAN-001's fully-passive precondition, and its worst-case
symptom (one of two redundant poll chains going silently dead) is recoverable by a manual
refresh, per the original's own impact analysis, which I found accurate.

**Fix sketch (matches original):** simplest fix is making `pollRunningScan()` a no-op when a
poll is already active (`if (scanNetworkPollTimer) return;` — since `resumeScanIfInProgress`
and a 409-triggered retry are both trying to converge on the same server-side job, letting the
existing chain keep driving is sufficient); the more general fix is a per-call generation
token, matching `loadFilesGeneration`'s existing pattern in app.js.

---

## P2REC-002

**Verdict: CONFIRMED — duplicate/subset of P2SCAN-001; severity revised Low → HIGH via merge;
no separate fix needed.** See the P2SCAN-001 section above for the full adjudication. The
button-re-enable mechanism P2REC-002 describes is
real and correctly traced (`processSelectedFiles`'s `finally` re-enabling buttons out from
under `pollRunningScan`'s disable) — my independent trace confirms the *mechanism*. Where I
disagree with P2REC-002 is (a) its claim that this is *"not deterministic every time"*: my
trace above shows the button re-enable is actually deterministic given the precondition,
because `processSelectedFiles`'s `finally` unconditionally wins the race regardless of which
of the two initial fetches resolves first (it is structurally the slower of the two paths in
both orderings); and (b) its decision to downgrade to Low by ruling out the "wrong displayed
data" angle as already resolved by the generation guard — that guard protects the *final*
state, not the multi-minute *interim* state a real fleet crawl guarantees, which is exactly
what P2SCAN-001 is about and where I believe the real severity lives. Recommend treating
P2REC-002 as a duplicate/subset of P2SCAN-001 rather than a separately-tracked Low finding,
with P2SCAN-001's HIGH severity and single fix (participate in `loadFilesGeneration`, or
equivalent) closing both.

---

## Summary of what to fix

One coordinated fix closes all three: give `resumeScanIfInProgress`/`pollRunningScan` a
synchronous-before-any-await claim on a shared "who owns the load buttons and the status line
right now" signal that `autoloadLastScan`/`processSelectedFiles` must check immediately before
proceeding (reusing or paralleling the existing `loadFilesGeneration` mechanism), plus a
reentrancy guard or generation token on `pollRunningScan` itself so a 409-triggered retry
converges on the existing poll chain instead of spawning a second one that fights it over the
shared `scanNetworkPollTimer` variable.

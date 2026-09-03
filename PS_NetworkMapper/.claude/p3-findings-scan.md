# Pass 3 Findings - web-src/app.js, web-src/scan-network.js

Third re-scan of the scan/reattach/poll area, focused on Pass 2's P2SCAN-CLUSTER fix
(commit `0948584`: awaited `resumeScanIfInProgress()` sequencing in app.js +
`scanNetworkPollActive` re-entrancy guard in scan-network.js). Read-only, no fixes applied.
Full current text of both files was read and traced by hand; `lib/WebServer.ps1`'s
`/api/scan-network` and `/api/scan-network/status` handlers were also read to check
plausibility of the server-side payload shapes referenced below.

---

## P3SCAN-001

**Track:** USER-FACING / CORE (error handling / silent-hang UX)

**File:line:** web-src/scan-network.js:99-146 (`pollRunningScan`'s inner `poll` closure and
its unguarded call site at line 145)

**Severity:** Medium

**Confidence:** High

**Claim:** `pollRunningScan()`'s `poll` closure is invoked fire-and-forget (`poll();` at
line 145 - no `await`, no `.catch`). Any exception thrown synchronously inside `poll`
(not just a network error, which is already caught) becomes an **unhandled promise
rejection** with no handler anywhere in the app: `window.onerror` (app.js:16) only catches
synchronous top-level errors and the `error` DOM event, not `unhandledrejection` - there is
no `window.onunhandledrejection` handler in app.js or anywhere else in web-src. When this
happens, `finish()` never runs, so `scanNetworkPollActive` is stuck `true`, `scanNetworkBtn`
/`loadBtn`/`loadFolderBtn` stay disabled, `scanNetworkBtn` is left reading
`"Scanning (N found)..."` forever, and **no status message is ever shown** - unlike every
other failure branch in `poll()` (network error, 404, bad JSON, `!ok`, `!status.ok`), all of
which call `finish(msg, "red")` and leave the user an explanation. Only a manual page
reload recovers (a fresh JS context resets `scanNetworkPollActive` to `false`, and the
reattach check on the next `DOMContentLoaded` re-evaluates server state from scratch).

The concrete throw site: `poll()` does `status = await statusResp.json();` (guarded by its
own try/catch for parse failure) but then accesses `status.reason` (line 122) and
`status.status`/`status.visited` (lines 125-126) with **no check that the parsed value is a
non-null object**. `JSON.parse` (and therefore `Response.json()`) succeeds on the literal
JSON `null` - a syntactically valid response body that isn't an object. `null.status` throws
a `TypeError` synchronously inside the `async` `poll` function, which turns the throw into a
rejected promise rather than a caught error, since nothing awaits or catches `poll()`'s
own promise.

This is a real asymmetry against its sibling function: `window.resumeScanIfInProgress()`
(scan-network.js:157-179) has the exact same unguarded `status.status` access pattern after
its own `await statusResp.json()`, but that function's caller - app.js:383 - wraps the call
in `.catch(function() { return false; })`, so the identical throw there fails safe (treated
as "not resumed", falls through to `autoloadLastScan()`). `pollRunningScan`'s `poll()` has
no equivalent safety net at any level.

**Trigger:** Any response from `/api/scan-network/status` that is valid JSON but not an
object (`null`, a bare number/string, `[]`), received while a poll loop is active (i.e.
during `pollRunningScan`, not just at initial reattach). Checked whether the real server can
produce this: `lib/WebServer.ps1`'s `/api/scan-network/status` handler (lines ~540-596)
always sends a PowerShell hashtable through `Send-WebJson`/`ConvertTo-Json`, and its own
`Send-WebJson` wrapper falls back to a `{error: ...}` object on a serialization failure
(WebServer.ps1:35-49) rather than emitting `null` - so this specific shape is not reachable
through the server's current code paths I read. This is a defensive-coding gap rather than a
demonstrated live server behavior: reported because (a) the task explicitly asked for the
malformed-JSON outcome to be walked through, (b) the gap is asymmetric with a sibling
function that got the safety net and this one didn't, and (c) the actual root problem -
`poll()` has literally zero rejection handling for *any* throw, not just this one - is a
standing landmine for any future edit inside the loop, not a one-off.

**Checked the one other reachable throw inside `poll()`:** the completion branch
(scan-network.js:142-143) calls `finish(...)` (green, buttons re-enabled) and then
`await window.processSelectedFiles([syntheticFile]);` with no try/catch around it.
`processSelectedFiles` (app.js:526-533) rethrows on a genuine render error after already
setting `window.setStatus("Render error - see details.", "red")` and, in its own `finally`,
re-enabling its own busy-state buttons (since `myGeneration === loadFilesGeneration` still
holds). So a throw on *that* specific path is benign in practice - `finish()` already ran
and `processSelectedFiles`'s own error handling leaves the UI in a consistent (if red)
state before the unhandled rejection reaches the console. This confirms the actual hazard
is concentrated in the pre-`finish()` portion of `poll()` (network/parse/shape errors before
line 142), where no other code gets a chance to leave the UI consistent.

**Evidence:**
```js
// scan-network.js:113-126
var status;
try {
    status = await statusResp.json();
} catch (e) {
    finish("Lost connection to the local server - the scan may still be running server-side.", "red");
    return;
}

if (!statusResp.ok) {
    finish("Scan failed: " + (status.reason || ('HTTP ' + statusResp.status)), "red");   // status.reason: throws if status is null
    return;
}
if (status.status === 'running') {   // throws if status is null
```
```js
// scan-network.js:145 - fire-and-forget, no .catch anywhere
poll();
```
Contrast with `resumeScanIfInProgress`'s caller in app.js:383, which *does* have a `.catch`:
```js
resumed = await window.resumeScanIfInProgress().catch(function() { return false; });
```

**Invariant hit:** Every other terminal branch of `poll()` calls `finish()` with a
user-visible red/orange status before returning - the implicit contract is "the poll loop
always ends in a state the user can see and buttons that reflect it." An unhandled
rejection breaks that contract silently.

**Impact:** Scan Network/Load/Load Folder become permanently unusable for the rest of the
page session with zero on-screen explanation (only a browser devtools console entry, which
a normal user never opens) - worse than every neighboring failure mode, which at least
shows red text. Recoverable only by reloading the page.

**Fix sketch:** Either (a) validate `status` is a non-null object right after
`statusResp.json()` (treat a non-object as a parse failure, same `finish("Lost connection...",
"red")` branch already used for a JSON syntax error), or (b) wrap the `poll` closure's body
in a top-level try/catch that calls `finish("Unexpected error - see console.", "red")` on any
throw, so future edits inside the loop can't reintroduce this same silent-hang class of bug.
(b) is the more robust fix since it also covers the `processSelectedFiles` throw path noted
above, even though that one is currently benign.

---

## P3SCAN-INFO-001 (informational, not rated as a bug)

**Track:** CORE (robustness)

**File:line:** web-src/app.js:375-385 (`DOMContentLoaded` handler), web-src/scan-network.js:157-179 (`resumeScanIfInProgress`)

**Claim:** Neither `fetch('/api/scan-network/status')` (in `resumeScanIfInProgress`) nor
`fetch('/api/snapshots')` (in `autoloadLastScan`) has an `AbortController`/timeout. Pass 2's
fix makes `autoloadLastScan()` strictly downstream of `await resumeScanIfInProgress()`
completing (app.js:383-384), so if that fetch never resolves, `autoloadLastScan()` never
runs either - the page silently sits with nothing loaded and Load/Load Folder/Scan Network
enabled, forever, with no error shown.

Checked whether this is a live regression worth rating as a bug: it is not, on balance.
`lib/WebServer.ps1`'s accept loop (`BeginGetContext`/`EndGetContext` with a 250ms
`WaitOne` tick, lines 911-952) processes one HTTP request at a time but the scan/rescan/ping
work itself runs in separate runspace pools (`RescanPool`, `PingPool`,
`$script:PendingScanNetwork`'s background handle) rather than blocking the accept loop, so I
found no code path in the parts of WebServer.ps1 I read that would make a status request
hang indefinitely rather than just queue briefly behind another request. And the
counterfactual isn't a clean regression either: under the pre-Pass-2 (UX-002-only) code, a
hung/slow status fetch meant `autoloadLastScan()` ran anyway and could load the stale
snapshot as if it were current - i.e. exactly the P2SCAN-CLUSTER bug Pass 2 fixed. The
new code's failure mode for a hung fetch (no data shown, buttons enabled, silently) is a
safer degradation than the old one's (wrong data shown as a false success). Recorded as an
informational defense-in-depth item, not a confirmed finding: a bounded timeout on both
fetches (e.g. `AbortSignal.timeout(10000)`, falling back to autoload on timeout) would close
the gap cheaply, but there's no demonstrated trigger for it in the current server code.

---

## Other categories checked, nothing survived scrutiny (with reasoning)

- **Every outcome of `resumeScanIfInProgress()` vs. the `autoloadLastScan()` gate
  (app.js:375-385):** enumerated all five outcomes - (1) resolves `true` (reattached), (2)
  resolves `false` via any of its four early-return branches (already loaded/already
  polling, fetch throws, 404/`!ok`, JSON parse fails), (3) resolves `false` via
  `status.status !== 'running'`, (4) an uncaught throw from `status.status` access on a
  non-object body (see P3SCAN-001's discussion of the *sibling* code path - here it's caught
  by app.js:383's `.catch(() => false)`, so it fails safe into "run autoload"), (5) the fetch
  hangs (see P3SCAN-INFO-001). In every resolved case the boolean returned correctly gates
  `autoloadLastScan()`. Specifically checked whether anything between the `pollRunningScan()`
  call and `return true;` (scan-network.js:177-178) could throw and cause a "reattached but
  reported false" mismatch: no - `pollRunningScan()` cannot throw synchronously under normal
  DOM conditions (`getElementById` never throws; `if (btn)` guards every mutation; `poll()`
  is called as a fire-and-forget async function, so a throw *inside* it becomes an unhandled
  rejection in `poll()`'s own promise, not a synchronous throw back into
  `resumeScanIfInProgress`). Confirmed clean.

- **`scanNetworkPollActive` re-entrancy across every call site
  (scan-network.js:79-80,157-179,231,245):** `scanNetworkPollActive = true` is the *first*
  statement inside `pollRunningScan()`, synchronous, before any `await`. JavaScript's
  single-threaded event loop means there is no yield point between the guard's read and its
  write, so two calls - however they're triggered (reattach at line 177, the `startNetworkScan`
  409-retry at line 231, a fresh scan's own call at line 245) - can never interleave between
  check and set; the second call always sees the flag already `true` and no-ops immediately.
  Verified `scanNetworkPollTimer` is *only* ever assigned inside `poll()` (line 128), so the
  guard/timer invariant ("a pending timer only exists while the guard is held") holds in
  every branch, including every `finish()` exit path. "Call `pollRunningScan()` twice in
  immediate, non-overlapping succession" and "call it from two different back-to-back
  triggers" both behave correctly - no double-poll, no lost `setTimeout` id (the class of bug
  P2SCAN-002 originally found is closed for real).

- **Cross-tab / page-navigation / tab-close mid-poll:** `scanNetworkPollTimer` and
  `scanNetworkPollActive` are plain module-level JS variables with no `localStorage`/
  `sessionStorage`/cookie backing (grepped both files - the only `localStorage` keys touched
  anywhere in app.js are `rightPanelWidth` and the dark-mode preference in persistence.js,
  neither scan-related). A tab close or navigation with no clean JS exit simply discards the
  entire JS context; a fresh load starts both flags at their `false`/`null` defaults and
  re-derives real state via `resumeScanIfInProgress`'s server round-trip. No stuck
  cross-reload state is possible by construction - there is nothing to get stuck in.

- **Double `DOMContentLoaded` firing / `resumeScanIfInProgress` called from more than one
  place:** grepped both files and `index.html`/`lib/Network_Visualizer.html` - `app.js` is
  included via a single `<script src="app.js">` tag (index.html:867), registers exactly one
  `DOMContentLoaded` listener that calls `resumeScanIfInProgress` (app.js:375-385), and that
  is the only call site for `window.resumeScanIfInProgress` in the whole tree. Not reachable.

- **Item 3 - other buttons/state that could desync after a refresh
  (dashboard.js/drawer.js):** grepped dashboard.js for any reference to
  `scanNetworkPollActive`/`scanNetworkPollTimer`/`loadedSnapshots` at module/init scope - no
  hits; dashboard.js has no dependency on scan-in-progress state at all. drawer.js's
  `#rescanBtn`/`#pingBtn` are per-device, gated by their own `rescanPollTargetIp`/
  `pingPollTargetIp` module vars (drawer.js:57-75, 200-214) with the same "plain JS var, no
  persistence" property as the scan flags above - a refresh closes the drawer (fresh page,
  no device selected) and both buttons default to enabled in `index.html` with no `disabled`
  attribute. Neither has a `resumeScanIfInProgress`-style reattach-on-load, but this is
  pre-existing behavior unrelated to the P2SCAN-CLUSTER fix (rescan/ping are short - 100s/25s
  server-side hard caps - single-device jobs, not the long fleet crawl this pass's remit is
  about), and `rescanDevice`'s existing 409-plus-matching-IP branch (drawer.js:119-126)
  already reattaches cleanly if the user manually clicks "Re-scan" again for the same device
  after a refresh. No live desync found; not raised as a new finding since it has no repro
  path tied to this pass's fix and no invariant it violates.

- **Generated-artifact freshness (`lib/Network_Visualizer.html`):** Pass 1's own
  fix-review previously caught this drifting from source (UX-005b). Re-ran
  `node tools/build-inline.mjs` from current `web-src/` and diffed the result against the
  committed `lib/Network_Visualizer.html` - `git diff` was empty, confirming the checked-in
  build artifact is byte-for-byte in sync with the current `app.js`/`scan-network.js` despite
  slightly out-of-order commit timestamps between `56edb1e` and `0948584` (a red herring
  chased and ruled out, not a bug). Working tree confirmed clean of the rebuild
  (`git status --short` shows no change to `lib/Network_Visualizer.html`).

- **`status.visited`/`status.visitedCount` field-name consistency:** unchanged by Pass 2's
  diff (pre-existing code), re-verified against `lib/WebServer.ps1:570,594` - the two
  different field names the client reads for the two different server states (`running` vs
  `complete`) match exactly. Not a bug, not new.

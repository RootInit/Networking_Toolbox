# Adversarial Verification — SEC-1, SEC-2, GRAPH-001, GRAPH-002

## SEC-1: Plaintext SSH credential temp files, no explicit ACL

**Verdict: CONFIRMED**

Traced `lib/SshHelpers.ps1:14-24` (`New-JunosCredentialFile`) and `:34-45`
(`New-JunosAskPass`) directly. Both write via `[System.IO.File]::WriteAllText` to
`$env:TEMP` with no `Set-Acl`/`icacls`/chmod call anywhere in the file, and none in
`Get-JunosNodeData.ps1` or `Connect-Switch.ps1` either (grepped both, no ACL calls).
Confirmed the invariant framing in the finding is accurate: `Clear-StaleJunosTempFiles`
(`:59-70`) is a genuine, age-gated crash-survival sweep, not a claim this is otherwise
unguarded — so the finding's own scoping (this is a *confidentiality-during-lifetime*
gap, not a violation of the "never left behind beyond lifetime" invariant) holds up.

No test coverage exists for ACL behavior on these files (no `lib/test*` directory found
at all in the repo). Nothing rebuts the claim — this is a real, if low-severity-in-the-
stated-threat-model, gap. Confirmed as written, including the "materially worse on a
shared/multi-session host" impact framing, which is a correct qualification, not
overreach.

## SEC-2: `window.onerror` renders error text via unescaped `innerHTML`

**Verdict: CONFIRMED (sink is real), with one factual correction to the evidence — does not change the reachability verdict**

Read `web-src/app.js:16-28` directly — the sink is exactly as described:
`textEl.innerHTML = errText` where `errText` string-interpolates `message`, `lineno`,
`colno`, `source`, and `error.stack` with no escaping. Confirmed it is the only
unescaped `innerHTML` sink in the frontend sweep (grepped all `innerHTML` assignments
in `app.js`/`map.js`; every other one is either a static literal or passes through
`window.esc()` — e.g. `map.js:324` explicitly comments on why `esc()` is required for
the Leaflet tooltip).

Traced all three `decryptEnvelope()` call sites (`app.js:288`, `app.js:349`, `map.js:160`)
— each is wrapped in a local `try/catch` routing to `promptForPassword()`, which uses
`errEl.textContent` (`app.js:124`), not `innerHTML`. Confirmed via a broader grep of
every `throw new Error(...)` in `web-src/*.js`: `app.js:296` (topology JSON shape),
`drawer.js:43` (rescan/connect API `result.error` — itself potentially
server/device-influenced text), `graph-layout.js:254`, `topology-crypto.js` (4 sites),
`graph.js:59` — every one of these is inside a local `try/catch` at its call site (spot
checked `drawer.js:30-50`: `copyConnectCommand` wraps the fetch/throw in `try { ... }
catch (e) { ... }`). No path was found where an Error carrying untrusted text reaches
`window.onerror` uncaught.

**Correction to the finding's evidence**: the finding states "`window.onerror` does not
fire for unhandled Promise rejections at all... no such handler exists" for
`window.onunhandledrejection`. This is **factually wrong** — `web-src/utils.js:56-61`
registers exactly such a handler: `window.addEventListener('unhandledrejection',
function(e) {...})`. However, this doesn't rescue the reachability argument for the
XSS sink: that handler calls `window.reportClientError()` (`utils.js:27-47`), which only
fire-and-forget POSTs the message to `/api/client-error` — it never touches
`fatal-error-text`/`innerHTML` at all. So an unhandled rejection is caught and reported,
just not through the vulnerable sink. Net effect: the finding's *conclusion*
("today's unreachable verdict is stronger, not just not-found-yet") is actually
**stronger** than the finding claims, since unhandled rejections are positively handled
elsewhere rather than merely absent from window.onerror's coverage — but the specific
supporting claim "no such handler exists" should be corrected to "such a handler exists,
but it doesn't feed the vulnerable sink."

Also worth noting: `window.onerror` (assigned as a property in `app.js`) and
`window.addEventListener('error', ...)` (`utils.js:51-55`) both fire independently on
the same synchronous uncaught-exception event — confirmed both coexist without
interference, consistent with the finding's framing that only the `app.js` handler uses
`innerHTML`.

No test coverage found for this handler (no test file references `window.onerror` or
`fatal-error`). Severity/confidence as stated (Low severity, currently unreachable,
genuine latent landmine) stands.

## GRAPH-001: Dangling `leafletMap.once('click', ...)` listener from "Edit position"

**Verdict: CONFIRMED**

Read `web-src/map.js:280-420` directly.

- `renderMapMarkers()` teardown (`:285-290`): removes every marker layer, clears
  `mapMarkersByIp`, resets `currentlyArmedMarker = null` — but **never** calls
  `leafletMap.off('click', ...)` for any pending `_disarmOnMapClick` closure. Confirmed.
- Marker's own `click` handler (`:329-337`): disables `marker.dragging` and resets
  `currentlyArmedMarker` if it matches, but also never calls
  `leafletMap.off('click', marker._disarmOnMapClick)`. Confirmed — this is a second,
  independent path to the same leak the finding calls out, not just the
  `renderMapMarkers` one.
- Contrast case cited by the finding — `dragend` handler (`:389-398`) — does call
  `leafletMap.off('click', marker._disarmOnMapClick); marker._disarmOnMapClick = null;`
  explicitly, confirming the "author intended paired cleanup, this path is just missed"
  reading is correct, not speculative.
- Verified the call sites claimed to trigger `renderMapMarkers()` while armed:
  `graph.js` VLAN-filter path, snapshot switch in `app.js:86`
  (`window.setActiveSnapshot`) — both call `window.renderMapMarkers()` with no
  precondition check on `currentlyArmedMarker`/pending drag state.
- Impact analysis (self-heals via Leaflet's `once` semantics on next map click, inert
  no-op on an orphaned marker) is architecturally sound: `Draggable.disable()` on an
  already-disabled/detached instance and a `currentlyArmedMarker === marker` check that's
  already false are both safe no-ops in Leaflet — did not find a crash path, consistent
  with the finding's own "Low" severity call.

No test coverage exists for map.js marker lifecycle (no `web-src/test/*map*` file).
Confirmed exactly as claimed — genuine accumulating-listener leak, correctly scoped as
low-impact/no-crash.

## GRAPH-002: VLAN filter `Number()` round-trip vs. raw-string filter predicate

**Verdict: DOWNGRADED — real code defect, but effectively unreachable given current Junos parsing; treat as informational, not a live bug**

Read `web-src/graph.js:66-87` and `lib/Get-JunosNodeData.ps1:376-503` directly.

Confirmed the JS-side mismatch exactly as described: `allVlans` is keyed by
`String(c.VLAN_Tag)` (`:72`), the dropdown re-derives via
`Array.from(allVlans.keys()).map(Number).sort(...)` and `allVlans.get(tag.toString())`
(`:82-84`), while the actual filter predicates (`graph.js:336`-equivalent,
`map.js:316`) compare against the raw string kept in `vlanCache`
(`topology-graph.js`'s `computeVlanCache`, confirmed at `String(c.VLAN_Tag)` with no
normalization, matching `web-src/test/topology-graph.test.mjs:140`). No normalization
ties the two paths together in the code itself — the finding's "no normalization
guarantee" claim is accurate as a static-code-shape observation.

However, traced the only path that actually produces a `VLAN_Tag` string reaching
`extractVlans`: `Get-JunosNodeData.ps1:475-484`. The MAC-table parse only ever assigns
`$VlanTag` from (a) the literal string `"Unknown"` (filtered out by `extractVlans`'s own
`.toLowerCase() !== "unknown"` check, `graph.js:71`), or (b) `$VlanDict`/
`$VlanNameTagIndex`, both populated exclusively from `(?<tag>\d+)` regex captures
(`:403`, `:408`, `:430`) — i.e. **only ever a string of digit characters 0-9, `\d+`,
nothing else can reach this map.** `Number(x).toString() !== x` for a pure-digit string
is possible in exactly one practical case: a leading zero (e.g. `"010"` vs `"10"`).
Real Junos `show vlans` output renders the Tag column as a plain unpadded decimal
integer (1-4094) — it does not zero-pad. No code path in this file (or anywhere else
that writes to `VLAN_Tag`) introduces a leading zero or non-canonical digit string.

So: the code genuinely lacks a normalization *guarantee* (agreeing with the reporter's
own low-confidence framing), but the one and only producer of these strings
(`Get-JunosNodeData.ps1`'s regex-constrained VLAN parser) cannot emit a value that would
trigger the bug against real Junos devices. This matches — and confirms — the reporter's
own stated uncertainty ("likely keeps this latent rather than live in practice").
Verdict: downgrade from "Low severity/Low confidence potential bug" to **informational
landmine** — worth the trivial fix (stop round-tripping through `Number`) as
defense-in-depth against a future non-Junos data source or parser change, but not a
live, reachable bug against this tool's actual target devices today. No test covers this
path either way.

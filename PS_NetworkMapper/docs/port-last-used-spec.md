# Port Last-Used — Specification

Status: revision 2, after adversarial review. Branch: `feature/auto-diagnostics`.

Answers *"when was this switch port last actually carrying traffic?"* — a question the obvious
field, `Last flapped`, does not answer.

Companion to `diagnostics-spec.md`.

> **Revision note.** Revision 1 claimed Junos exposes no per-port last-active timestamp. That was
> wrong — see §1.3. It also built its central signal on cumulative input bytes without a floor,
> which misclassifies idle-but-chattering ports as active (§2.3), and its reboot test was unsound on
> a virtual chassis (§4.4). All three are corrected here. Measurements from revision 1 that were
> taken with a loose port-name pattern have been recomputed against the shipped parser's pattern.

---

## 1. The problem

### 1.1 `Last flapped` is a link-transition timestamp

Juniper's field definition for `show interfaces`:

> **Last flapped:** "Date, time, and how long ago the interface went from down to up."

At boot every connected port transitions once, so it is stamped with the boot time and then frozen
for as long as the cable stays in and the far end stays up. A workstation plugged in and passing
traffic for three weeks has had no transition since boot; there is nothing to update.

This is correct behaviour. No amount of parsing changes it.

### 1.2 Measured on a real fleet

A production access switch (2-member virtual chassis), booted `T`, protocols started `T+5:18`,
scanned 2w4d later. Of **75 physical interfaces** matched by the shipped parser's port pattern:

| Link | Carrier transitions | `Last flapped` falls | Count | What it means |
|---|---|---|---|---|
| Down | 0 | in the boot window | 25 | **Meaningless.** No transition ever occurred; the stamp is an ifd-init artifact |
| Up | 1 | in the boot window | 11 | Live port, came up at boot, never moved. *The reported complaint* |
| Up | 5–7 | in the boot window | 5 | Bounced during boot convergence, then settled |
| Up | 3–207 | later | 33 | Genuine post-boot flaps |

**41 of 75 ports (55%)** carry a `Last flapped` that says nothing about when the port was last used.
All extensive blocks on the device report `Statistics last cleared: Never`, so counters are
cumulative since boot.

Two facts the rest of the spec depends on, both verified:

- **Every link-down port has zero input bytes** (no exceptions), and **every boot-window link-up port
  has a large nonzero count** (no exceptions). Byte counters separate "live port frozen at the boot
  date" from "dark port" where `Last flapped` cannot.
- The 25 zero-transition stamps take exactly **two distinct values, 4 s apart** — one per VC member,
  ~32 s after each member's `Protocols started:`. That is ifd creation, not boot and not link-up.
  Note this **contradicts the Juniper definition quoted above**: a stamp exists where no down→up
  transition occurred.

### 1.3 Junos *does* expose a per-port last-seen — via LLDP

Revision 1 asserted otherwise. `show lldp neighbors detail` — **already in the crawler's command
set** — prints per local interface:

```
Index: 188  Time to live: 180  Time mark: <switch-clock timestamp>  Age: 35 secs
Local Interface    : ge-0/0/25
Ageout Count       : 0
```

Juniper defines `Age` as seconds since the TLV was received from the neighbour
([show lldp neighbors](https://www.juniper.net/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-lldp-neighbors.html)).
That is a per-port, **switch-clock**, second-resolution last-seen — skew-free by construction, which
is the property §4.3 otherwise goes to trouble to manufacture.

Measured: present on all 43 LLDP blocks, `Age` spanning **0–917 s**. Values well past the 180 s TTL
mean entries are retained after ageout and the counter keeps running, so it is a bounded last-seen
rather than a liveness bit. `Ageout Count` gives a flap-independent "this neighbour went away N
times".

**Coverage is the limit, not correctness.** LLDP speakers only — phones, APs, switches, managed
servers; not a stock workstation. On the measured device, 42 of 48 up ports (88%) have a neighbour,
but that fleet is phone-dense. Treat 88% as an upper bound for similar estates and expect much less
on a server or desktop VLAN.

The parser currently discards it: `lib/Get-JunosNodeData.ps1:517-552` extracts six identity fields
per block and nothing else.

**Two more presence signals, both already collected, both missed by revision 1:**

- **PoE `Power consumption`** (`show poe interface`, `lib/Get-JunosNodeData.ps1:502-504`). `ON / 1.4 W`
  vs `OFF / 0.0 W` is a direct "the attached device is drawing power" for phones and APs — precisely
  the discriminator the "dead PC still plugged in" case needs. Only the oper status and wattage are
  kept today; `Admin status` is captured and discarded.
- **802.1X per-port state.** Revision 1 dismissed this as "only authenticated ports". On the measured
  fleet dot1x is configured on **every** access port, and `Authenticated` vs `Initialize` is per-port
  endpoint presence. The parser keys dot1x by MAC and discards the interface
  (`lib/Get-JunosNodeData.ps1:509-513`), and `Initialize` rows carry no MAC so they are dropped
  entirely — 25 such rows in the capture.

### 1.4 Other candidates, checked and rejected

| Candidate | Verdict |
|---|---|
| MAC table `Age` column | **Unavailable on ELS.** Reads `-` throughout the capture; the column exists but is unpopulated, and the parser has no age group at `:621` |
| `show ethernet-switching mac-learning-log` | Timestamped learn/delete events. Documented through current Junos with an ELS config hierarchy (`[edit protocols l2-learning mac-learning-log]`), so ELS support is **not** the concern revision 1 claimed — but the ring-buffer depth is undocumented. Validate on hardware before relying on it |
| SNMP `ifLastChange` | Identical semantics to `Last flapped` |

---

## 2. Design principles

### 2.1 The output is a bounded interval, not a timestamp

```js
{
  port:        'ge-0/0/12',
  deviceKey:   'serial:ABC123',      // see §6 — resolved once per history, not per snapshot
  state:       'ACTIVE_NOW' | 'TRANSMITTER_PRESENT' | 'IDLE_SINCE'
             | 'NEVER_USED_THIS_EPOCH' | 'DISABLED' | 'UNKNOWN',
  lastActive:  { notBefore: <epochMs|null>, notAfter: <epochMs|null> },
  resolution:  <seconds|null>,       // the gap that bounds the answer
  confidence:  'high' | 'medium' | 'low',
  evidence:    [ { source, detail }, … ],   // always populated, on every path
  caveats:     [ … ],                       // always populated, on every path
}
```

`resolution` is load-bearing: it is usually the inter-snapshot gap, and it tells the operator that
"last used about three weeks ago" means "somewhere in the week between these two scans."

### 2.2 Resolution is bounded by scan cadence — except where §1.3 applies

A fleet scanned weekly resolves last-used to a week. The one exception is LLDP `Age`, which gives
second-resolution *at the moment of the scan* for LLDP-speaking endpoints. That is why §3 puts it in
its own tier above everything else.

### 2.3 A positive input delta proves a transmitter is present, not that the port was used

Revision 1 claimed input bytes are "the endpoint's evidence". The narrow mechanism is right —
switch-originated LLDP/BPDU/LACP are egress and land in `Output bytes`, `Loopback` is `Disabled` on
every port, so input really is far-end traffic. **But "the far end transmitted" is not "the port was
used", and the capture shows the gap.**

Three up ports carry mean input frames of **72–76 bytes at 0.07–0.24 pps** — one ~64-byte frame
every 11–15 seconds, sustained for eighteen days. That is EAPOL/ARP/keepalive chatter from a
present, powered, unattended NIC. Across all up ports the mean input frame size is bimodal: min
72.5 B, **median 585 B**, max 1416 B. Two of those three ports also report a nonzero `InputBps`.

Under a naive rule every one reads *active* at the highest confidence — and they are exactly the
ports a reclaim view exists to surface.

**Requirements:**

- The state produced by byte-delta evidence is named **`TRANSMITTER_PRESENT`**, not `ACTIVE`.
- Promotion to `ACTIVE_NOW` requires clearing a **rate floor**. Default: mean input frame size
  ≥ 128 B *or* ≥ 0.5 pps sustained across the gap. Both are configurable and both must be shown in
  `evidence`. The 128 B threshold sits between the observed clusters (~76 B vs ~585 B); it is a
  starting point derived from one fleet, not a universal constant.
- Mean input frame size (`InputBytes / InputPackets`) is the cleanest discriminator and is free once
  packets are parsed (P4).

**Output bytes remain corroboration only.** A switch floods broadcast and multicast out every port
in the VLAN regardless of whether anything is listening, so output climbs on a port whose device is
powered off but linked. Measured: 44 of 50 up ports have `OutputBytes > InputBytes`, ratios reaching
~80:1, median 1.62. (Revision 1 attributed this to unknown-unicast flooding as well; that stops once
the destination is learned, and every up port here has a learned MAC. The surplus is broadcast and
multicast.)

### 2.4 `null` is unmeasured, and JavaScript will not respect that for you

`InputBytes` is `$null` when the traffic stanza did not match, and serializes as literal `null`. In
JS, `5e9 > null` is **true** and `null < 5e9` is **true**, while `null == 0` is **false**. Left
unguarded that produces, in turn: a false active claim across a window nothing was read in, a false
counter reset, and a false idle verdict — the last being verbatim the damaging answer this section
exists to forbid.

**Requirement: every numeric comparison is explicitly type-guarded (`typeof x === 'number'`).** An
observation whose counter is `null` is excluded from the delta walk and from `seg.first` selection,
and contributes a caveat. This is not advice; it is the single most likely way this feature ships a
confidently wrong answer.

### 2.5 `NEVER_USED_THIS_EPOCH` is the strongest claim in the model and needs the strongest guard

It may be emitted **only** when no loaded observation of that port, in any segment, showed input
bytes above zero. A reset must never be able to produce it — see §5.2.

---

## 3. Evidence sources

| # | Source | Field | Yields | Bound |
|---|---|---|---|---|
| **E0** | **LLDP neighbour age** | `Age: N secs` per `Local Interface` | The far end transmitted an LLDP frame N seconds before the scan | **Direct read, switch clock, second resolution.** LLDP speakers only |
| E0b | PoE power draw | `Power consumption > 0 W` | The attached PD is powered at scan time | Powered devices only; presence, not traffic |
| E0c | 802.1X per-port state | `Authenticated` vs `Initialize` | A supplicant is present and responding | Requires P7; dot1x-configured ports only |
| E1 | Live input rate | `InputBps > 0` **and rate floor met** | Active within the last statistics-polling interval | Interval length is not documented — state it as "the last polling interval", not "seconds" |
| E2 | Dynamic MAC on the port | `MacTable[]` entry with flag `D` | The endpoint transmitted within the MAC aging time | Aging time not collected; default 300 s. Confidence downgraded when the port has > 4 MACs |
| E3 | Input byte delta | `InputBytes(N) > InputBytes(N-1)` | A transmitter was present in `(ts(N-1), ts(N)]` | The workhorse. Resolution = the gap. Subject to §2.3's floor |
| E4 | Cumulative input > 0, no earlier snapshot | `InputBytes > 0` | A transmitter was present at least once since the epoch | Lower bound only |
| E5 | Cumulative input == 0 | `InputBytes == 0` | Nothing transmitted since the epoch | **On the measured device this is coextensive with `Link == down`** — no up port has zero input. It is a real bound, but it fires independently far less often than revision 1 claimed |
| E6 | Link up | `Link == 'up'` | A cable is connected, far end powered | Not traffic |
| E7 | Carrier-transition delta | see §4.2 | Something is attached and cycling | Presence, not traffic |
| E8 | `LastFlappedSeconds`, post-filter | §4.2 | The port last changed link state then | Weakest |

Evidence from a device whose `ScanStatus` is not `Ok` or `Partial` is discarded. On a `Partial`
node, E1/E3/E4/E5/E7 are unavailable **and must be gated per-source**, not merely filtered at
intake — revision 1's §3 and §5 disagreed on this and §5 won, silently.

---

## 4. Corrections to the raw signals

### 4.1 Counter epoch

`InputBytes` is cumulative since boot **or** since the last `clear interfaces statistics`.
`Statistics last cleared:` is printed on every extensive block and is **not parsed**
(`lib/JunosParsers.ps1:262-299`). It reads `Never` throughout the capture, so the epoch is boot
there — but that must be read per device, not assumed.

**P2:** capture it, absolute and relative. `Never` maps to "epoch = boot".

**`epochStart` is defined as** `perDeviceCaptureTs − UptimeSeconds` (requires P1 and P3), widened by
the crawl span. It is **never** derived from the absolute `System booted:` stamp — the codebase
already declares that stamp's abbreviated timezone unresolvable
(`lib/Get-JunosNodeData.ps1:417-418`). Before P3, `epochStart` may be used as a `notAfter` bound
only, with a caveat.

### 4.2 Carrier transitions count *both* directions

Juniper documents `Carrier transitions` as "Number of times the interface has gone from down to up."
**The capture contradicts this**, and the evidence is not marginal:

- **48 of 48** up `ge-` ports have an **odd** count.
- **25 of 25** down `ge-` ports have an **even** count (all zero).
- Zero violations. Under a down→up-only counter, uniform parity across 48 ports has probability
  2⁻⁴⁸.

The counter increments on every carrier state change; parity tracks current link state.

**Consequences:**

- Flap counts in §1.2 are transitions, not flaps — the 207 port has had ~103 flaps.
- **E7 must halve the delta**, and an *odd* delta carries information revision 1 discarded: the port
  ended the window in a different link state than it started.
- **Free parse-time invariant:** `CarrierTransitions % 2 == (Link == 'up' ? 1 : 0)`. A violation
  means a counter reset or a missed transition. Assert it; it costs nothing.

**The boot-event filter.** E8 is usable only after removing the boot stamp. Two checks:

1. `CarrierTransitions == 0` → no transition ever occurred; discard. **Note this is inert in
   practice**: no link-up port in the capture has a zero count, and every zero-count port is
   link-down where E5 already answers. Keep it as a guard, not as a mechanism.
2. `LastFlappedSeconds ≈ UptimeSeconds` → the flap *is* the boot event; discard. **This is the check
   that does the work**, and it rests entirely on P1.

**P1:** parse `UptimeSeconds` from the relative `(… ago)` form of `System booted:`, which
`lib/Get-JunosNodeData.ps1:350` currently discards. Both values are then switch-relative, so the
switch-vs-collector offset cancels.

Two residuals remain, and revision 1's "clock skew cancels entirely" was overstated: the relative
form is **minute-quantized** above one hour (±30 s each), and the two values come from different
commands executed minutes apart in one batch. Default tolerance **15 minutes** absorbs both.

### 4.3 Reset detection — per FPC, on relative uptime

Revision 1 used `Uptime(N) != Uptime(N-1)` and cited `web-src/persistence.js:298` as precedent. That
line is not that test:

```js
var rebootedToday = !!(device.Uptime && device.Uptime !== "Unknown" && prevUptime && device.Uptime !== prevUptime);
```

The `"Unknown"` and `prevUptime` guards are load-bearing — `Uptime` defaults to `"Unknown"` and
stays there on any scan that missed the section, including a `Partial`. Bare inequality turns a
`Partial` scan into a false reset.

Three further failures, all of which apply to the measured device because it is a virtual chassis:

1. **Non-master member reboot.** `show system uptime` emits one block per member and the parser
   scopes to the master (`lib/Get-JunosNodeData.ps1:300-304`). If a non-master FPC reboots, *its*
   ports' counters reset while the master's timestamp is unchanged. Undetected.
2. **Mastership change.** The parser reads a different member's block; the timestamps differ (4 s
   here, potentially weeks after a member swap). False reset, history discarded, no outage.
3. **Clock step.** `Time Source: LOCAL CLOCK` on this device — no NTP. Junos recomputes boot time
   when the wall clock is stepped, so the absolute stamp can move with no reboot. Verify on
   hardware; the fix below is strictly better regardless.

**Requirements:**

- Reset test is `UptimeSeconds(N) < UptimeSeconds(N-1)` (allowing for the inter-scan gap) — monotonic
  and immune to both clock steps and mastership swaps.
- **Per FPC.** P1 must capture per-member boot times, and the test is evaluated against the FPC the
  port lives on, derived from the port name.
- `"Unknown"` on either side yields **neither** a reset nor a continuation — a caveat and a segment
  boundary of unknown type.
- A decrease in `InputBytes`, or a change in `StatisticsLastCleared`, is also a reset.

### 4.4 Per-device capture time

One `ScanTimestamp` covers a crawl spanning many minutes (`lib/FleetCrawl.ps1:86,144`), and retries
run later still. **P3** adds a per-device timestamp. Until then every interval is widened by the
observed crawl span, with a caveat.

---

## 5. Algorithm

### 5.1 Structure: gather, then reduce

Revision 1 specified a precedence chain of early returns, which contradicted §3's own promise that
"the engine takes the tightest consistent combination", never attached `resolution`/`evidence`/
`caveats`, and left the E6–E8 epilogue unreachable. The corrected structure:

```
computeLastUsed(portHistory):
  obs = portHistory.observations
          .filter(o => o != null && o.scanStatus in {Ok, Partial})
          .filter(o => o.tsMs != null)                  // drop unparseable timestamps + caveat
          .dedupeBy(o => o.tsMs)                        // a file loaded twice must not change state
          .sortAscending(o => o.tsMs)                   // never trust caller ordering
  assert strictly increasing timestamps

  if obs.isEmpty: return UNKNOWN(reason)                 // distinguish the two reasons — see §5.3
  if obs.last.Admin == 'down': return DISABLED(evidence)

  segments = splitOnResets(obs)                          // §4.3; also split on port-absent-while-
                                                         // device-scanned-Ok (hardware swap)
  contributions = []
  for each source E0..E8: contributions += source.evaluate(segments)

  return reduce(contributions)                           // tightest consistent interval;
                                                         // state from the strongest contributor;
                                                         // evidence and caveats always attached
```

### 5.2 Segment handling — the rule revision 1 got dangerously wrong

Revision 1 said "only the most recent segment is usable." Under weekly snapshots, a port carrying
900 GB that then saw a device reboot returns a one-observation segment with zero bytes, and the
model emits **`NEVER_USED_THIS_EPOCH` at high confidence** for a port that was busy four days
earlier. It lands on the reclaim list.

**Corrected:**

- Prior segments cannot supply a *delta*, but they are valid **lower bounds**.
- If any earlier segment showed activity: `IDLE_SINCE`, with `notAfter` = the reset point and
  `notBefore` = the last pre-reset activity. **Never** `NEVER_USED_THIS_EPOCH`.
- `NEVER_USED_THIS_EPOCH` requires zero input bytes in **every** observation across **every**
  segment (§2.5).

### 5.3 States

| State | Meaning |
|---|---|
| `ACTIVE_NOW` | E0 age below threshold, or E1 with the rate floor met |
| `TRANSMITTER_PRESENT` | Input delta in the most recent gap, floor not met or not evaluable |
| `IDLE_SINCE` | Last activity bounded to an earlier interval |
| `NEVER_USED_THIS_EPOCH` | No input in any observation, any segment |
| `DISABLED` | `Admin == 'down'`. Excluded from the reclaim view |
| `UNKNOWN` | Insufficient data. Two distinct reasons, reported distinctly: *port not present in any loaded snapshot* vs *present, but every observation was unusable* |

The `TRANSMITTER_PRESENT` / `IDLE_SINCE` boundary must not be decided by "is this the last gap"
alone: a port that transmitted once at the start of a week-long gap would read "in use" while one
quiet for a second before the last scan reads "idle". Both are bounded by the same interval and must
present identically; the phrasing comes from the interval's `notAfter`, not from the index.

---

## 6. Identity

`resolveDeviceIdentity` (`web-src/utils.js:231` → `bestKeyForSave`, `web-src/config-resolve.js:39-43`)
resolves serial → hostname → IP. A `Partial` scan that missed chassis hardware has empty
`StackMembers`, so the key **silently drops from `serial:` to `hostname:`** — splitting one port's
history into two contradictory rows, one saying active and one saying idle.

**Requirement:** resolve identity **once per port-history**, not per snapshot. Union the per-snapshot
key set for a device across the loaded window and merge histories whose key sets intersect; emit a
caveat when the key type changed. A key-type downgrade between adjacent snapshots with no
intersection forces `UNKNOWN`, never a silent split.

Revision 1's §10.6 claimed "`resolveDeviceIdentity` handles the device half". It does not.

---

## 7. Data prerequisites

| # | Requirement | Site | Without it |
|---|---|---|---|
| **P0** | **Parse LLDP `Age`, `Time mark`, `Ageout Count` per local interface** | `lib/Get-JunosNodeData.ps1:517-552` | E0 — the only direct per-port last-seen — does not exist |
| P1 | `UptimeSeconds` from the relative form, **per FPC** | `lib/Get-JunosNodeData.ps1:350` | The boot filter and the reset test both fail (§4.2, §4.3) |
| P2 | `Statistics last cleared`, absolute + relative | `lib/JunosParsers.ps1:262-299` | E4/E5 cannot state their epoch; a manual clear looks like "never used" |
| P3 | Per-device capture timestamp | `lib/Get-JunosNodeData.ps1:194-210`, `lib/FleetCrawl.ps1:111-122` | `epochStart` undefinable; every interval widened by the crawl span |
| P4 | `Input packets` / `Output packets` | `lib/JunosParsers.ps1:285-289` | No mean frame size, so §2.3's floor falls back to the coarser pps form |
| **P5** | **Retain every MAC-table row with its raw flag character** | `lib/Get-JunosNodeData.ps1:616-649` | E2 cannot tell a dynamic entry (evidence) from a static or persistent one (none). **Promoted to prerequisite** — §8's E2 tests are unwritable without it |
| P6 | PoE `Admin status` and `Power consumption` retained separately | `lib/Get-JunosNodeData.ps1:502-504` | E0b unavailable; admin-disabled and no-PD both read `OFF` |
| P7 | Per-port dot1x state keyed by interface | `lib/Get-JunosNodeData.ps1:509-513` | E0c unavailable; `Initialize` rows dropped entirely |
| ~~P8~~ | ~~MAC aging time from `Configuration`~~ — **dropped.** The configuration is not parsed (`diagnostics-spec.md` §4.4). E2 assumes the 300 s default and says so in `caveats` | — | A nominal bound on one evidence source, which E2 already carries a caveat for. Note dot1x session pinning may override aging on this fleet, so the configured value would not have been authoritative either |
| P9 | `y` (year) unit in the relative-duration regex | `lib/Get-JunosNodeData.ps1:432` | An interface or device up over a year yields `$null` silently. Inherited by P1 |

Already retained: `InputBytes`, `OutputBytes`, `InputBps`, `OutputBps`, `CarrierTransitions`,
`LastFlappedSeconds`, `Link`, `Admin`, `Uptime`.

---

## 8. Storage

### 8.1 Primary computation needs no persistence

`loadedSnapshots` are already decrypted and in memory. The loaded window **is** the resolution
window. This is the default and it requires no storage.

### 8.2 The naive store does not fit, by more than revision 1 said

The 350-device reference fixture contains **25,378 interfaces**. A realistic entry —
`"serial:ABCD1234EFGH|ge-0/0/12":{"lastActiveTs":…,"lastSeenTs":…,"lastInputBytes":…,…}` — is **253
characters**, not the 180 revision 1 assumed. That is **6.1 MB** of JSON, and `localStorage` is
charged in **UTF-16 code units**, so it costs **~12.3 MB** of a typical 5 MB origin quota.

Revision 1's "bounded" 20,000-entry cap is ~9.7 MB of quota — still ~2× over, i.e. it lands in
exactly the silent failure it was introduced to avoid (`web-src/persistence.js:196` only
`console.warn`s).

### 8.3 If persistence is built

- **Store every observed port.** Revision 1's "store only idle ports" is a bug: evicting a port when
  it becomes active destroys the baseline, so the next time it falls quiet there is nothing to
  compute a delta against and it degrades to "idle since boot". The `lastActiveTs` field was defined
  and then made unreachable by the eviction rule.
- **Shrink the value instead**: numeric epoch-ms rather than ISO strings, boot-ms integer rather
  than an uptime string. ~110 chars/entry makes 20,000 viable; otherwise cap at 8,000–10,000.
- **Trim by entry age** (`lastSeenTs` older than a retention horizon), never by current state. LRU
  by `lastSeenTs` is also the wrong key — it updates for every port on every scan, so all survivors
  share a value and eviction becomes arbitrary. (`trimDeviceHistory`'s comparator at
  `persistence.js:174-178` additionally returns `NaN` when both values are unparseable, which is
  undefined sort behaviour; do not mirror it.)
- **Version the key** so a schema change abandons old entries.
- **Surface quota failure in the UI**, not only the console.

### 8.4 Idempotency

`updateAlarmHistory` carries a hard-won note (`web-src/persistence.js:273-275`): a derived value must
not persist between runs, because re-walking from the oldest snapshot against an already-advanced
value falsely flags a reboot, and the flag sticks.

**Revision 1 reintroduced exactly that trap** — `lastInputBytes` and `lastUptime` *are* persisted
derived values used for delta comparison. Re-running over the same snapshots compares the oldest
against the stored newest, fires the decrease rule, and drifts monotonically.

**Requirement:** the persisted rollup carries the **timestamp of the observation it summarises**, and
a stored baseline may only be compared against snapshots **strictly newer** than that timestamp.
Snapshots at or before it are ignored entirely. That is what makes re-running idempotent, and it
needs a test at the *persistence* level — the pure-module test table cannot reach it.

---

## 9. Testing

### 9.1 PowerShell (`Run-Tests.ps1` §12)

Synthetic samples only; no byte of the production capture enters the repo.

- LLDP `Age` / `Time mark` / `Ageout Count` parsed per local interface, including a block with none.
- `UptimeSeconds` from the relative form: weeks/days/hours, a `y` unit (P9), `Never`, and malformed —
  each distinguishable, not all collapsing to `$null`.
- Per-FPC boot times from a multi-member `show system uptime`.
- `Statistics last cleared`: `Never`, an absolute+relative stamp, absent — three distinct outcomes.
- MAC-table flag preserved as `D` / `S` / `P`.
- The parity invariant `CarrierTransitions % 2 == (Link == 'up' ? 1 : 0)` asserted on parse.

### 9.2 JavaScript (`web-src/test/port-last-used.test.mjs`)

| Case | Asserts |
|---|---|
| LLDP `Age: 12 secs` on the port | `ACTIVE_NOW`, high, resolution = seconds not the scan gap |
| LLDP `Age: 900 secs`, no byte delta | Bounded at ~15 min, not "idle since the last scan" |
| Single snapshot, input 0, uptime 3 weeks | `NEVER_USED_THIS_EPOCH`, `notAfter == epochStart` |
| Single snapshot, input > 0 | `IDLE_SINCE` from `epochStart` — **not** active |
| Two snapshots, delta above the floor | `ACTIVE_NOW`; interval and `resolution` == the gap |
| Two snapshots, delta below the floor (64 B frames, 0.1 pps) | **`TRANSMITTER_PRESENT`, not `ACTIVE_NOW`** — the §2.3 regression test |
| Output grows, input flat | `IDLE_SINCE` — the §2.3 corroboration test |
| **Activity, then reboot, then idle** | **`IDLE_SINCE` with `notBefore` in the pre-reboot segment; asserts `state !== 'NEVER_USED_THIS_EPOCH'`** — the §5.2 regression test |
| `InputBytes: null` in one snapshot | Excluded from the walk; no false active, no false reset, no false idle; caveat present — the §2.4 test |
| `Uptime: "Unknown"` in one snapshot | Neither reset nor continuation; caveat present |
| Counter cleared, post-clear bytes *higher* than pre-clear | Reset detected via `StatisticsLastCleared`; epoch correct |
| Non-master FPC reboot | Reset detected for that FPC's ports only |
| Snapshots supplied out of order | Sorted internally; no negative `resolution` |
| Same snapshot loaded twice | State unchanged — dedupe test |
| Port absent from a middle snapshot, device `Ok` | Segment break (hardware swap); no delta across it |
| Port absent because the device was not scanned | `resolution` widened to span both gaps; caveat present |
| Device identity flips `serial:` → `hostname:` | One merged history, caveat present; **not** two rows |
| `Admin: down` | `DISABLED`; absent from the reclaim view |
| Static MAC only (flag `S`) | Does not satisfy E2 *(requires P5)* |
| Port with > 4 MACs | E2 confidence downgraded |
| Re-run over the same snapshots **through the persisted path** | Byte-identical; no drift — §8.4 |

Every path must return `evidence` and `caveats` populated; assert that generically.

### 9.3 Fixture

`generate-fixture.mjs:298` (`accessRow`) emits none of the counter fields. The three snapshots are
**not** generated independently — `ageFleet` (`:658-690`) mutates the same topology in place between
writes, which is the right hook: add counters to `accessRow`, then advance them inside `ageFleet` in
step with each port's link state.

Inject: a never-used port, an idle-since port, an active port, a chattering-but-idle port (the §2.3
case), a port whose device rebooted between snapshots, and one whose counters were cleared without a
reboot.

---

## 10. Known limitations — to be shown, not hidden

1. **Resolution is the scan cadence**, except where E0 applies.
2. **E0 covers LLDP speakers only.** A silent workstation is invisible to it.
3. **Below the counter's notice is invisible.** A port carrying a handful of packets between scans
   reads as a transmitter present; one carrying none reads idle even with a healthy device attached.
4. **The rate floor is calibrated on one fleet.** 128 B / 0.5 pps separates the clusters observed
   here. It is a default, not a constant, and it must be configurable and displayed.
5. **MAC aging time is assumed** at the 300 s default — the configuration is not parsed — and dot1x
   session pinning may override it in either direction.
6. **A counter clear is only detectable after P2.**
7. **"The port is active" says nothing about any particular device** behind an unmanaged switch.
8. **Ports are identified by name, and names move.** §6 handles the device half; a port on a replaced
   FPC has no history and no equivalent mechanism.
9. **JavaScript `Number` is exact to 2⁵³, not 2⁶⁴.** Deltas are far above the rounding error, so no
   wrong answer follows — but `InputBytes` must never be compared for *equality*.

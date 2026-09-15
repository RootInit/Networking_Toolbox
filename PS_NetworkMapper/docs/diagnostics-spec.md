# Reachability Diagnostics — Specification

Status: revision 2, after adversarial review. Branch: `feature/auto-diagnostics`.

Answers *"why can't switch A reach switch B, or client C reach the network?"* from data already in a
snapshot, plus the data changes needed to answer it well.

> **Revision note.** Revision 1 was reviewed by three independent passes: mechanical citation
> checking, Junos/network correctness, and architecture/testability. It contained four errors serious
> enough to have produced wrong software, all corrected here and all called out in place:
> §2.1's security rationale was false; §2.2's evidence double-counted a column; §5.2's LLDP
> statistics were computed over the wrong population and led to an unsound design; and three of
> §4.3's proposed commands would have silently destroyed existing snapshot data.
>
> Where a claim below is derived from one production capture of one access switch, it says so. That
> is a sample of one and several revision-1 errors came from over-generalising it.

---

## 1. Scope

### 1.1 In scope

A **derived-analysis layer** over snapshots already taken and loaded: a catalogue of fault rules, a
path computation so per-hop rules can be applied along a route, and the data-retention changes in
the PowerShell worker that give the rules something to read.

### 1.2 Explicitly not in scope

`README.md:35-37` states the tool "does not monitor, alert, poll continuously, page anyone, store
anything centrally… A crawl is a point-in-time snapshot you deliberately took," restated at
`README.md:378-381`. That is a product decision. Therefore: no background polling, no alerting, no
central store, and no active probing by default (see `active-probing.md`, split out of this spec
because it is a separate decision with its own risks).

### 1.3 Non-goals

- **Deciding what the operator intended.** The snapshot records what a switch is doing, never what it
  was meant to do. Rules needing intent must take operator input or be framed as peer-comparisons.
- **Adjudicating firewall filter semantics.** Display matching terms; do not evaluate them (§6.5).
- **Replacing an engineer.** Every output is evidence with a stated confidence.

---

## 2. Architecture decisions

### 2.1 The engine runs in browser-side JavaScript

**Decision.** A new `web-src/diagnostics/` module set, using the dual-mode export at
`web-src/topology-graph.js:88-93`.

> **Correction.** Revision 1's top-weighted rationale — "the server never holds the key; the
> plaintext only exists in the browser" — is **false**. `Start-NetworkMapper.ps1:155,196` pass
> `-EncKey`/`-MacKey`/`-Salt`/`-Iterations` into the web server; `WebServer.ps1:869` derives key
> material for config writes; `GET /api/session-password` (`WebServer.ps1:733-738`, routed at
> `:1120-1125`) returns the plaintext password to the browser as a documented deliberate exception;
> and because the crawl runs in-process, `FleetCrawl.ps1:86` builds the full plaintext topology in
> the server's memory before `:87-89` encrypts it. Only the snapshot-*read* path is key-free.

**Rationale, as it actually stands:**

1. **The data is already parsed and indexed in memory.** `globalTopologyData`, `deviceByIp` and
   `searchIndex` (`web-src/search.js:12-45`) are built at load; endpoint resolution largely reuses
   the search index.
2. **The consumer is the UI** — path highlighting on `web-src/graph.js`, per-hop drawer links.
3. **The engine must work with no server running**, against an archived snapshot file.
4. **The test harness fits.** `node --test` with real assertions, versus `Run-Tests.ps1`'s
   boolean-returning smoke harness which has no vocabulary for comparing hop lists.
5. **It sidesteps PowerShell 5.1, FIPS, and the single-threaded accept loop** (`WebServer.ps1:1055`).

**Consequence, corrected.** Revision 1 concluded that nothing may be computed at crawl time. That
followed only from the false rationale. Since plaintext already exists in the crawl process,
crawl-time derivation adds **zero** new exposure and is available wherever it is cheaper — provided
the result is written into the snapshot so the archived-file path still works.

### 2.2 Path computation prunes a physical graph per-VLAN by STP state

**Decision.** Physical adjacency → prune to edges whose local port at *both* ends carries VLAN *T*
(`lib/Get-JunosNodeData.ps1:596-603`) → prune to edges forwarding for *T*'s scope
(`lib/Get-JunosNodeData.ps1:485-492`).

> **Correction.** Revision 1 justified this with "125 FWD / 28 BLK / 25 DIS … a device with 28
> blocked port-instances is a coin flip." That triple double-counts a column. The `show
> spanning-tree interface` table's last two columns are `State  Role`, and the real tally over the
> capture's 153 rows is **FWD/DESG 113, BLK/DIS 25, FWD/ROOT 12, BLK/ALT 3** — **zero rows in state
> `DIS`**. The 25 "DIS" are the *Role* of 25 BLK rows, and that set is **identical to the 25
> link-down data ports**, which physical adjacency already excludes. Genuinely election-blocked:
> **3 rows on 2 ports**.

**The correct evidence, which is stronger as an argument even though the number is smaller.** One
VLAN in the capture has a LAG bundle and one fibre uplink both `BLK ALT` while a second fibre uplink
is `FWD ROOT`. Those same two ports are `FWD` in other VLANs on the same device. So:

- Physical shortest-path on that VLAN selects a blocked link.
- The flattened `Interfaces[].STP` scalar collapses the bundle (DESG in 11 scopes, ALT in 2) to
  `BLK` and would prune a link that forwards 11 VLANs.

**Hard rule.** Path code reads `Interfaces[].StpDetail[scope]`, never `Interfaces[].STP`. The
collapse at `lib/Get-JunosNodeData.ps1:493-495` uses the precedence map at `:477`, which is
worst-case only among BLK/LST/LRN — `DIS = 1` ranks *below* `FWD = 2`, so a port forwarding in one
VLAN and disabled in another flattens to `FWD`. This rule needs its own regression test (F5).

**A VLAN may have no STP instance at all.** The capture carries 17 VLANs and `show spanning-tree
interface` produces 13 scopes — **4 VLANs are unpruned**. For those, the STP filter is vacuous and
the answer degrades to unpruned physical shortest path, which is exactly what this decision exists
to prevent. That must be its own reported state, not folded into "STP data absent" (§2.3).

### 2.3 Confidence ladder

| Level | Meaning |
|---|---|
| `VERIFIED` | Both ends scanned, both carry the VLAN, both report `FWD` for its scope |
| `VLAN_ONLY` | Both ends carry the VLAN; scope present but not per-VLAN (RSTP/MSTP) |
| `NO_STP_INSTANCE` | **This VLAN has no spanning-tree instance on this device.** The hop is unpruned, not merely unverified |
| `PHYSICAL_ONLY` | LLDP adjacency only; VLAN or STP data missing at one end |
| `INFERRED` | No LLDP; adjacency from MAC-table or STP evidence |
| `UNVERIFIED` | A datum the level above required was absent |

Six levels, used consistently. Revision 1 defined four and then used a fifth.

### 2.4 Integrity gates run before any rule

- **G-SECTIONS.** A `Partial` scan truncates a **suffix of unknown length**, not one command.
  Revision 1's "loses exactly the extensive-derived fields" is wrong, and its ordering claim was
  inverted: `show interfaces extensive` is **last** (`:163`) so it is lost *first*;
  `show configuration | display set` (`:162`) is lost second. Since §4.3 inserts new commands ahead
  of both, any hard-coded field list rots on every addition.
  **Requirement (R15): record which section keys actually arrived — `$DataDict` already knows — into
  the snapshot as `SectionsCaptured[]`.** Every gate and guard reads that, not a field list.
- **G-NOSCAN.** `ScanStatus` in `AuthFailed | Unreachable | Error | Timeout | Aborted`: the device
  contributes nothing, and no two-ended rule may read its absence as "the far end is fine".
- **G-BASELINE.** Before any counter delta, detect a reset. **This gate depends on `Uptime`, which is
  fifth-from-last in the batch and may itself be missing on a `Partial` node** — so G-SECTIONS runs
  first and G-BASELINE reports `NOT_EVALUATED` when its own input is absent. See
  `port-last-used-spec.md` §4.3 for the per-FPC form, which is the one to implement.

### 2.5 `$null` means unmeasured

`lib/Get-JunosNodeData.ps1:386,389-395` sets extensive-derived fields to `$null` deliberately, to
separate "not reported" from "zero". **No rule may treat `$null` as a pass or as zero**, and in
JavaScript that requires explicit type guards — `5e9 > null` is `true`.

---

## 3. Rule framework

### 3.1 Keep it small and mostly table-driven

Revision 1 specified a per-rule object for all 117 catalogued rules. At that shape — id, layer,
severity, scope, dependencies, suppressors, evidence construction, plus a fixture fault and a test
each — that is on the order of 2,000 lines of rule code and as much test, all of which rots when a
parser field is renamed.

**Decision:**

- Build the **~44 rules supported by today's data** first, minus the subset needing a delta.
- Express the ~80% that are single- or two-field comparisons as **table rows** (subject, field,
  comparator, threshold, suppressors, severity).
- Reserve a full function for genuinely multi-hop path rules. *If the table cannot express a rule,
  that is the signal it deserves a function.*

### 3.2 Data dependencies are checked by a guard, not a path string

Revision 1 specified a `needs: ['Interfaces[].Duplex']` list checked for `null`/absent. That cannot
deliver its guarantee:

- Five interface fields default to **empty collections** — `InputErrors`/`OutputErrors` (`:394`),
  `StpDetail` (`:399`), `BundleMembers` (`:401`), `Vlans` (`:403`). They serialize as `{}`/`[]`,
  which is neither null nor absent, so a rule reading STP data on a device whose spanning-tree
  section was truncated **passes the gate with zero data** — the exact false-clean the gate exists
  to prevent.
- `StpDetail` is keyed by the switch-reported scope string and `InputErrors` by the error label. A
  static path can assert the container exists; it cannot assert *`StpDetail` has a key for VLAN T*,
  which is what every path rule actually needs.

**Decision:** each rule supplies `guard(ctx) -> string|null`, returning the name of the first missing
datum. Same `NOT_EVALUATED` guarantee, no path evaluator, and a guard can express data-dependent
keys.

### 3.3 Suppression is first-class

A rule declares its suppressors; a finding records which were evaluated. Common ones: the port faces
an LLDP-MED endpoint; the port has never been in service; the condition is STP working correctly;
the device rebooted recently.

### 3.4 Two traps to encode explicitly

- **Output `Drops` is not an error.** Junos documents it as packets dropped by the output queue's RED
  mechanism. The capture's healthiest access port carries 14,635 drops against zero errors in both
  directions, and 34 ports carry non-zero drops. A rule treating it as an error flags every busy
  uplink.
- **Duplex rules must hard-gate on `Link -eq 'up'`.** All 25 link-down ports in the capture print
  `Link-mode: Half-duplex` while all 47 up ports print `Full-duplex`. Ungated, a duplex-mismatch rule
  fires on every dark port in the estate. Suppressing by description or byte counters does not catch
  a port that was in service last week.
- *(Revision 1 also forbade an `ActiveAlarms == 'LINK'` rule outright. Scope the suppression to
  `Link -ne 'up'` instead — `LINK` on a port reporting `up` is a real alarm.)*

### 3.5 Built — 2026-09-13: `web-src/rules.js` and the L1 catalogue

**Work order item 11.** The engine and 23 L1 rules, with one fault injector per rule and the delta
oracle §8.3 asks for. Five things came out differently from the plan above, and one of them is the whole
reason the file is worth having.

**There was no rule catalogue to build from.** Appendix A's 117 rules are a count from an audit that is
not in this tree, and nothing in the repo or its history enumerates them. So the table in `rules.js`
**is** the catalogue, derived from §4.1's *Unlocks* column (the fields Phase 1 retained specifically so
these rules could exist), §3.4's three traps, and G5. Appendix A's "L1: 14 supported today" is superseded
by the 23 below; the estimate was not wrong so much as unattributable.

| Rule | Reads | Note |
|---|---|---|
| `duplex-half-on-up-link` | `Duplex` | §3.4's second trap: gated on `Link = up` by the rule's `only`, so a dark port is not a subject at all |
| `negotiation-incomplete` | `NegotiationStatus` | |
| `autoneg-disabled` | `AutoNegotiation` | Fires on 11 of a clean 60-device fleet's ports and is suppressed on 38 more facing MED endpoints. Copper only — see the fourth trap below |
| `autoneg-mismatch` | `AutoNegotiation` + the neighbour's `MAC/PHY` TLV | R2 without scanning the peer. Has subjects only on copper trunks (19 of the fleet's 136 links) |
| `mtu-mismatch` | `Mtu` + the neighbour's `Maximum Frame Size` TLV | **G5, which the spec listed as described nowhere.** In the measured capture the local `MTU: 1514` and the TLV `MTU Size (1514)` carry the same number on one wire, which is what makes equality the right comparison |
| `duplex-mismatch` | both ends' `Duplex` | The only two-ended rule, and so the only user of the two-ended G-NOSCAN gate. Anchored on the half-duplex end |
| `crc-align-errors` | `MacStatistics[CRC/Align errors]` | R4's own purpose — the one non-zero CRC value in the capture sits in a table the counter parser cannot reach |
| `input-errors-present`, `output-errors-present`, `framing-errors-present` | `InputErrors`/`OutputErrors` keys | **Never `Drops`** — §3.4's first trap |
| `remote-fault` | `RemoteFault` | R10, field-line scoped |
| `link-alarm-on-up-port` | `ActiveAlarms` | §3.4's third trap, the one revision 1 had backwards |
| `bpdu-error`, `loop-detect-pdu-error`, `ethernet-switching-error`, `mac-rewrite-error` | R10's four error fields | They print on every port's link-level line and none was parsed before Phase 1 |
| `port-flapped-recently` | `LastFlappedSeconds` + `LastFlappedState` | C5's reason for two fields: `Never` is the healthy case, not a missing duration |
| `lag-member-down` | `BundleMembers` + each member's `Link` | §5.3. The one rule with no fixture injector — see below |
| `poe-admin-disabled-with-endpoint` | `PoeAdminStatus` + `MedNeighbors` | R7's own purpose: without `AdminStatus` this reads the same as a phone drawing nothing |
| `poe-denied` | `PoeOperStatus` | |
| `dot1x-held`, `dot1x-auth-failed`, `dot1x-unauthenticated-traffic` | `Dot1x[].State` (+ `MacTable`) | R6. The third is the state the MAC-keyed parse structurally could not represent |

Excluded deliberately: every rule needing a counter **delta** (Appendix A's "+6"), which waits on
G-BASELINE's reset detection. No rule reads the configuration (§4.4).

- **Four outcomes per subject, and a fifth thing that is not an outcome.** `FIRED`, `PASSED`,
  `SUPPRESSED`, `NOT_EVALUATED` are recorded per subject and counted per rule, with a `missing` histogram
  keyed by datum. *Skipped* is separate and uncounted in those four: a rule whose `only` predicate says
  the subject does not exist here (no aggregate on this row, no neighbour on this port, a dark port for a
  duplex rule) has not passed. On a clean 60-device fleet that is most of the 4,220 port subjects, and
  folding them into `PASSED` would bury the histogram the outcomes exist to produce.
- **The guard reads `SectionsCaptured` through one `FIELD_SECTION` map before it reads the field**, so
  `section:INTERFACES_EXT` and `Interfaces[].Duplex` stay distinct strings — "the capture stopped" and
  "the platform does not report this" call for different actions. A test asserts `FIELD_SECTION` against
  the fixture's own section-blanking table in both directions; it immediately found `LastFlappedSeconds`
  surviving a dropped `INTERFACES_EXT` in the generator, which is the false clean §3.2 is about.
- **The load-bearing test is a mutation, not an assertion about a `Partial` node.** Reading the truncated
  node and finding `NOT_EVALUATED` proves little on its own. So the test then sets `Duplex =
  'Half-duplex'` and `Link = 'up'` on that node while leaving `SectionsCaptured` truncated — exactly the
  state a `needs: ['Interfaces[].Duplex']` list passes — and asserts the rule *still* reports
  `section:INTERFACES_EXT`.
- **A subject filter may not read a field its own section supplies.** The two are one decision made twice:
  `only` runs before the guard, so a filter that reads a blanked field turns a truncated capture into
  "not a subject" — silence with no datum named, which is the §3.2 failure the guard exists to prevent.
  Every such filter goes through `reports(ctx, field)`, or the same section test inline where the filter
  compares a value rather than asking whether the field is there at all: while the section is missing the port stays a
  subject and the guard speaks; once the section has arrived, a field the port does not report is hardware
  absence (an optical port has no duplex, a non-PoE port no PoE row) and not a subject. A fleet-scale
  test asserts that every rule reading an `INTERFACES_EXT` field carries `section:INTERFACES_EXT` in its
  `missing` histogram, with the PoE, dot1x and LAG rules listed as the rules that must *not*.
- **Suppression has three states, not two.** A suppressor can itself be unevaluable: whether a port faces
  an MED endpoint is unknown when the LLDP section never arrived, and whether the device rebooted
  recently is unknown when `Uptime` (fifth-from-last in the batch) is missing. A finding records
  `{by, evaluated, unevaluated}`, because "not suppressed" and "cannot tell whether it is suppressed" are
  different facts and the second one is what a `Partial` node produces.
- **`lag-member-down` has no fault injector, deliberately.** The fixture contains no aggregate at all, and
  an aggregate is ordinary topology rather than a fault — inventing one inside `injectFaults` would put a
  normal shape behind a fault manifest and make the delta oracle describe the generator's own gap. The
  `lag-two-members-one-down` micro-topology covers the rule; the fixture-side gap is recorded at §8.2.

**A fourth trap, found in the capture while writing these rules and not in revision 2's list.** A fibre
port's link-level line carries **no `Link-mode`, no `Auto-negotiation` and no `Remote fault`**, and no
autonegotiation stanza follows it: on optics those four fields are absent, not zero. And the LLDP
`MAC/PHY` TLV states two things, `[supported|not supported, enabled|disabled]` — 27 of the capture's 43
blocks advertise `[not supported, disabled (0x0)]`, **every one of them a switch on an optical port**. So:

- `advertisedAutoneg` returns `null` for `not supported`. Reading it as "disabled" — which the first cut
  of this file did — fires `autoneg-mismatch` on every fibre uplink in the estate, 27 of 43 here.
- `negotiation-incomplete` is gated on autonegotiation being *enabled* as well as on the link being up.
  All 25 of the capture's down ports print `Incomplete`; the status means nothing where negotiation was
  never attempted.
- The fixture was wrong in the same three places and now reproduces all of them, plus the PoE table's real
  vocabulary — see §8.2.

`poe-denied`'s fault vocabulary is **provisional**: the capture's PoE table prints only `ON` and `OFF`,
and `OFF` with Admin `Enabled` is the ordinary "nothing plugged in" state, so the values the rule matches
are derived from documentation rather than observed. A fixture pass there is evidence the plumbing works,
not that those are the strings a PoE fault prints. Treat a `poe-denied` finding on hardware as unverified
until a real PoE fault has been seen.

**Narrowed 2026-09-14 (item 12).** Juniper's published output-field table for `show poe interface`
enumerates the Oper-status column as **`ON` / `OFF` / `FAULT` / `Disabled`** — four values, where this
rule matched five, of which four (`Denied`, `Power-Denied`, `Overload`, `Powered-down`) were invented.
Matching invented strings made the rule look better-founded than it was, so the predicate is now a
case-insensitive substring test for `fault` alone, and the fault *reason* (`Overload`,
`Connection Check error`, …) is documented as a separate `Operational status detail` field the brief
table does not carry. Still unconfirmed against hardware: what changed is that the guess is now the
documentation's, not this project's.

The same holds for **R15 on a chassis whose PoE command prints nothing at all**. `Get-JunosCapturedSections`
records a section key when the command's output is non-whitespace, and a feature-absent command normally
prints an error, which counts. A command that prints *nothing* is indistinguishable from truncation, and
the engine would then report `section:POE` — "the capture stopped early" — on a switch that simply has no
PoE.

**Answered 2026-09-14 (item 12), and without needing to know what any given chassis prints.** No public
capture shows what an EX with no PoE hardware answers, and guessing the string would have been the same
mistake §8.2 catalogues four times. The fix is structural instead, and it holds whatever the string turns
out to be. Three states, recorded separately:

| State | `SectionsAttempted` | `SectionsCaptured` | `SectionErrors` | Means |
|---|---|---|---|---|
| Normal | yes | yes | — | the command answered with data |
| Refused | yes | yes | the message | the CLI rejected it — a feature-absent chassis, or a release without the command |
| Silent | yes | no | — | the command ran and printed nothing |
| Truncated | no | no | — | the session ended before the command was issued |

`SectionsAttempted` is recorded from the **echoed command line**, which proves the command was issued
whatever it printed, so truncation is now the only state in which a key is absent from it.
`Get-JunosSectionErrors` anchors on `error:` / `unknown command` / `syntax error` **in the first three
non-blank lines only** — the word "error" inside an interface counter block is not a refused command.
The remaining unknown is narrow and harmless: which of "refused" and "silent" a non-PoE EX actually
produces. Both are now distinguishable from truncation, which is what the guard framework needed.

Measured on a clean 60-device fleet (`--seed 5`): 72 findings across 23 rules, with every two-ended and
every advertisement-versus-local rule at **zero** — which is the point of the wire-property change noted
at §8.2. The faulted fleet adds 29.

### 3.6 Built — 2026-09-14: the L2 and L3 rules

**Work order item 13.** Sixteen more rules on the same engine — eleven L2, five L3 — one fault injector
per rule, and the delta oracle extended to cover them. Appendix A's L2 and L3 rows are superseded the
same way §3.5 superseded the L1 row: the table below is the catalogue.

The scope is set by two things already decided. §3.1 builds only what today's data supports, and ~~item 12
is **blocked** (no switch to verify against), so a rule needing a §4.3 command is named here and *not*
declared~~ — *item 12 landed 2026-09-14 (§4.3.1) and the three rules that waited on it are in §3.7; while
it was blocked, a rule needing a §4.3 command was named here and not declared* — a rule reading a section `CAPTURE_SECTIONS` never collects would report `section:X` on every
device in the fleet, which says "the capture stopped early" about something nobody ever asked for.

| Rule | Reads | Note |
|---|---|---|
| `stp-port-not-converged` | `StpDetail[].State` | F9, per scope. The third port state a path computer reading only FWD/BLK has no answer for |
| `duplicate-mac-across-devices` | `MacTable` across the fleet | F1/F4. Transit ports excluded through the graph's own `transitPorts`: every client is visible on its uplink, and counting those would report the whole estate as duplicated |
| `mac-in-vlan-not-on-port` | `MacTable[].VlanName` + `Interfaces[].Vlans` | The switch answers both questions and they disagree |
| `shared-segment-not-a-link` | `groupSharedSegments` | F14. Two ports facing one address-less bridge; chaining them would invent a link |
| `bridge-without-management-address` | the `addressless-bridge` terminal | R5/F6, single-ended — two ends of one bridge are the row above |
| `unmanaged-segment-inferred` | the `inferred-segment` terminal | §5.3's fourth fleet edge: three or more MACs behind a port with no neighbour of any kind |
| `neighbour-never-scanned` | the `unscanned` terminal | `info`. Not a device fault: a coverage gap, and the reason a path stops at F8 |
| `vlan-absent-on-one-trunk-end` | both ends' `Vlans` | F11, anchored on the end that is **missing** the VLAN |
| `stp-both-ends-claim-segment` | both ends' `StpDetail[].Role` | §6.3, sharing `l2-path.js`'s `bothEndsClaimSegment` so the rule and the path computer cannot drift apart |
| `stp-scope-drift` | both ends' `StpDetail` keys | **G2 closed.** One end runs an instance the other does not, so the pruning happens on one side of the wire only |
| `lldp-one-sided` | `edge.reciprocal` | Both devices answered and only one sees the other |
| `duplicate-ip-two-macs` | `ArpEntries` across the fleet | C2's ambiguity, reported rather than resolved |
| `default-route-unreadable` | `DefaultRoute.State` | R9's `Unparsed` sentinel surfaced: no default route, or a shape the regex misses — both want a human |
| `gateway-not-on-a-local-subnet` | `DefaultRoute.NextHop` + R1's units | The device cannot ARP for a next hop on no subnet it holds an address on |
| `routed-unit-down` | `LogicalUnits[].Admin/Link` | The device's own L3 presence in a VLAN, enabled and down — no physical port's state says this |
| `client-outside-scope` | `Clients[].IP` + the caller's scopes | The scopes are an **option**, so without them the guard reports `option:allowedScopes` rather than calling every address out of scope |

**Not built, and why.** ~~`show spanning-tree bridge` carries the topology-change count and time since last
change per scope (**G4**), which is the "why is this broken *now*" datum; it needs the §4.3 command and
waits on item 12.~~ **Built 2026-09-14 (item 15) — see §3.7.** **G3** (VRRP) is not a rule at all: a VIP MAC on a trunk is how VRRP is supposed to
look, so the `00:00:5e:00:01:<VRID>` detection ships as `vridOf`, exported for §6.4's gateway report, and
`duplicate-mac-across-devices` skips those MACs rather than reporting every redundant gateway in the
estate. ~~Native-VLAN mismatch (G5's second half) stays blocked on retention — no native-VLAN field exists.~~
**Built 2026-09-14 (item 15) — see §3.7.**
Firewall-filter rules remain §6.5's "report, do not adjudicate", and §4.4 still stands: nothing here
reads the configuration.

**The L2 trap, stated so a later rule does not re-derive it.** Asymmetric spanning-tree *state* on one
wire is normal — the designated end forwards, the alternate end blocks, and that is the tree working.
What is not normal is two ends holding the same *role*. `l2-path.js` already drew that line for §6.3, so
the rule imports it instead of restating it, and the role vocabulary is the switch's own (§8.2's fifth
correction).

**Three rules have no subject on a healthy fleet** — `shared-segment-not-a-link`, `neighbour-never-scanned`
and `lag-member-down`. Each is a defect or a coverage gap rather than a shape, so the fixture contains
none until one is injected; the first two have injectors, and the third is §5.3's documented exception.
The fleet test names all three, so a fourth appearing there is a subject shape that exists nowhere.

Measured on the same clean 60-device fleet (`--seed 5`, 60 devices / 4,816 ports / 136 edges): **76
findings across 39 rules** — the 72 L1 findings unchanged, plus four true statements about the fixture's
own topology (two address-less bridges, two inferred segments) and **zero L3 findings**. The faulted
fleet (`--faults 40`, now 38 injector kinds) reaches 128: +30 L1, +16 L2, +6 L3, with nothing lost.
*(Item 15 adds three injectors, so the faulted run is `--faults 43` over 41 kinds.)*

### 3.7 Built — 2026-09-14: the three rules item 12 unblocked

**Work order item 15.** Three rules on the same engine, one injector each, the delta oracle extended to
them, and the §2.4 histogram taught to say *refused* where a section was refused rather than absent.

**Every field these read is UNVERIFIED on hardware** (§4.3.1). That is one statement about all three, not
three separate caveats: if a release prints those stanzas differently the parsers return nothing, and the
right outcome then is a `NOT_EVALUATED` row naming the datum — never a clean fleet. Each rule has a test
for exactly that case, which is the part of this item that matters most.

| Rule | Reads | Note |
|---|---|---|
| `native-vlan-mismatch` (L2, `error`, edge) | both ends' `Vlans[].Tagged`/`.Mode` | **G5 closed.** The untagged member of a trunk *is* the native VLAN. Untagged frames leaving one end arrive in a different broadcast domain at the other, and nothing else in the snapshot reports it. `Tagged = null` (the brief form) is unmeasured, so a fleet captured that way reports the gap rather than passing |
| `stp-topology-change-recent` (L2, `warning`, device) | `StpBridge[].TimeSinceLastChangeSeconds` | **G4 closed.** Device-scope, because the bridge view is per bridge; the ports are joined on from `StpDetail` by the scope string the parser normalises, so a finding names ports and not only a VLAN |
| `dot1x-fallback-vlan` (L1, `info`, port) | `Dot1x[].AuthenticatedVlan` vs `.GuestVlan` | The supplicant authenticated and landed in the guest VLAN: it is on the network, so no other rule sees anything wrong. Fires on the landing, never on the configuration — a guest VLAN nobody is in is the normal case |

**`TopologyChangeCount` is retained and deliberately not read.** With no previous snapshot to subtract it
from, a large count is an old switch rather than a fault; that comparison belongs behind G-BASELINE (§2.4)
and is a different rule. A test asserts the count alone fires nothing.

**A snapshot captured before item 12 grows rows here, and that is the right answer.** On a scan that
predates the four commands, `stp-topology-change-recent` reports `section:STP_BRIDGE` on every device and
`native-vlan-mismatch` reports `Interfaces[].Vlans[].Tagged` on every edge end — the data was never
collected, so §2.5 says unmeasured, not clean. Expect the §6.6 unevaluated count to rise on old captures;
it reads like truncation and is not, and `SectionsAttempted` — which would say "never asked" — does not
exist on those snapshots either.

**Refusals are their own line, not a histogram annotation - and the difference was found on screen.**
The first build annotated `section:X` rows with the refusal. That annotation could never appear: a refused
command still prints output, so `Get-JunosCapturedSections` records the key, the rules reading it skip
those ports as non-subjects, and there is no unevaluated subject to make a row from. The silence is
*correct* and *invisible*, which is exactly what wanted saying - so `sectionRefusals` renders it as its
own sentence above the table ("`POE` on 20 devices - error: PoE is not supported on this platform",
measured on the 60-device fixture). `hasSection` still reads `SectionsCaptured` alone: a port on a chassis
without the feature is not a subject, and making it one would turn a non-PoE switch into a fleet of
findings.

---

## 4. Data model changes

### 4.1 Phase 1 — retention (no new commands)

Data already in the collected payload and discarded by the parser. The largest category of blocked
rules and the cheapest to fix.

> **Progress (2026-09-13): all of Phase 1 has landed.** Each item moved all three mirrors of the node
> shape together (worker initializer, `New-PlaceholderNodeLocal`, `blankNode`) plus its tests, as §8.1
> requires. The interface-level ones grew `ACCESS_ROW_GAP` from 23 to 44 rather than closing it, since
> filling the fixture's values waits on the initializer settling; `LogicalUnits[]` is the exception,
> emitted by the fixture because R1's own tests need units to assert against.
>
> Two predictions in this section were checked against the real capture and held: R5 admits **zero**
> neighbours there (all 11 address-less blocks are endpoints), and 25 of 43 LLDP blocks carry MED
> inventory. R2b's `Age` is present on 42 of 43.

| # | Change | Site | Unlocks |
|---|---|---|---|
| R1 **[done]** | Parse logical units — `irb\|vlan\|lo0\|me\|vme\|fxp\|em\|vcp` — with their address and family, into a **new `LogicalUnits[]` array on each physical interface row** | `lib/Get-JunosNodeData.ps1:378-407` | ~10 L3 rules, VC interconnect health. **Corrected from revision 1**, which proposed re-keying `Interfaces` by unit: that redefines the array's member identity, which `window.normalizePort` joins depend on at `utils.js:199,273` and `drawer.js:667`, and violates §9.5. **Deviation, deliberate:** the units this
unlocks sit on `irb`/`vme`/`me0`/`lo0`, whose parents get no `Interfaces` row at all, so the array is
**node-level** (`$NodeData.LogicalUnits`) and each physical row carries the subset belonging to it as a
filtered view of the same parse. Creating rows for those parents would have been revision 1 in a
different hat: every "N ports, M down" the UI derives from `Interfaces` would change value |
| R2 **[done]** | Parse LLDP `Organization Info` stanzas: 802.3 `MAC/PHY Configuration/Status`, `Maximum Frame Size`, `MDI Power`, `Link Aggregation` | `lib/Get-JunosNodeData.ps1:517-552` | Far-end autoneg, MTU and PoE negotiation **without scanning the peer**. 27 of 43 blocks advertise autoneg disabled |
| R2b **[done]** | Parse LLDP `Age`, `Time mark`, `Ageout Count` per local interface | same | Per-port last-seen — see `port-last-used-spec.md` §1.3 |
| R3 **[done]** | Retain every MAC-table row in `Node.MacTable` (MAC, port, VLAN, **raw flag char**, age) alongside the de-duplicated `Clients` | `lib/Get-JunosNodeData.ps1:616-649` | Duplicate-MAC and sticky-MAC detection, **transit sightings (G1)**. `$RawMacs` is keyed by MAC last-wins and `:645` collapses the flag to `"Static/Other"` |
| R4 **[done]** | `ConvertFrom-JunosMacStatistics` for the fixed-width `MAC statistics:` table; likewise `PCS statistics` and `Ethernet FEC statistics` | `lib/JunosParsers.ps1` | `CRC/Align errors`, `Jabber`, `Fragment frames`, `Code violations`. One port in the capture carries **51 CRC/Align errors — the only non-zero CRC value present — and the snapshot cannot see it**, because `ConvertFrom-JunosErrorCounters` correctly terminates at the first non-counter line, which is `Egress queues:` |
| R5 **[done]** | Record LLDP neighbours that advertise **`Bridge` or `Router` capability** but no management address, with `Reachable = $false` | `lib/Get-JunosNodeData.ps1:541-548` | **Corrected from revision 1**, which gated on the *absence of an address*. All 11 address-less blocks in the capture are endpoints — 10 workstations (`Class I Device`, chassis ID a hostname string under `Locally assigned`) and 1 telephone. Zero are bridges. Gating on absence would inject ~11 phantom "unreachable switch" nodes per access switch |
| R6 **[done]** | Per-port dot1x state keyed by **interface** | `lib/Get-JunosNodeData.ps1:509-513` | The captured interface is discarded and `Initialize` rows carry no MAC, so 25 rows are dropped. **No per-port dot1x state exists in the snapshot today** |
| R7 **[done]** | PoE: keep `Admin status`, `Max power`, `Priority`, `Pair/Mode` | `lib/Get-JunosNodeData.ps1:502-504` | `Admin status` is captured into `$Matches.status` and dropped, so "PoE admin-disabled" and "no PD connected" both read `OFF` |
| R8 **[done]** | Parse `show chassis hardware` into `FPC → PIC → Xcvr` | `lib/Get-JunosNodeData.ps1:340-345` | Absence of an `Xcvr` row is the only reliable "nothing plugged in" discriminator for a fibre port |
| R9 **[done]** | Route regex: capture egress interface, protocol tag, table name; distinct `"Unparsed"` sentinel | `lib/Get-JunosNodeData.ps1:348` | `Gateway = "Unknown"` currently conflates *no default route* with *a shape the regex misses* |
| R10 **[done]** | From extensive: `Statistics last cleared`, `Input/Output packets`, `Remote fault` (field-line scoped), `Interface flags`, `Device flags`, **and `BPDU Error` / `Loop Detect PDU Error` / `Ethernet-Switching Error` / `MAC-REWRITE Error`** | `lib/JunosParsers.ps1:262-299` | Exact counter baselines; error ratios; one-way-link detection. The four error fields print on **every** port's Link-level line and none is parsed — they partly supply the "blocking reason" §4.3 was going to spend a command on |
| R11 **[done]** | VC member `Status` column and `Neighbor List` continuation rows | `lib/Get-JunosNodeData.ps1:314-335` | A stack member that dropped out is invisible |
| R12 **[done]** | Per-device capture timestamp | `:194-210`, `lib/FleetCrawl.ps1:111-122` | One `ScanTimestamp` covers a crawl spanning many minutes |
| R13 **[done]** | LLDP-MED `Model name`, `Manufacturer`, `Serial number`, revisions | `:517-552` | Present on 25 of 43 blocks; phone/AP model is currently unknowable |
| R15 **[done]** | **`SectionsCaptured[]` from `$DataDict`**, joined 2026-09-14 by `SectionsAttempted[]` and `SectionErrors{}` | `lib/Get-JunosNodeData.ps1:264-292` | §2.4. The truncation signal that survives §4.3 — now three signals, which is what tells a refused command and a silent one apart from a session that ended early (§3.5) |

**R14 (comments, not behaviour). [done]** Document at the field that `Vlans[].RoutingInstance`
(`lib/JunosParsers.ps1:92`) is the **L2 switching instance, not an L3 VRF**; and that `Interfaces[]`
identity is the physical port, so unit-level data lives in `LogicalUnits[]`.

### 4.2 Phase 2 — correctness

| # | Change | Site | Why |
|---|---|---|---|
| C1 **[done]** | Split `Unreachable` into `Refused` / `NoRoute` / `Timeout` / `DnsFailed` | `:259-260` | `connection refused` means **the device is L3-reachable and sshd refused** — reported identically to a dead box. `no route to host` is a fault in *the scan host's* routing. Classification only; `ScanError` already holds the stderr |
| C2 **[done]** | Fleet ARP map: deterministic, and filter `Flags -eq 'permanent'` on `bme*` | `lib/FleetCrawl.ps1:125-140` | Last-write-wins in job-completion order, so a MAC in two ARP tables resolves differently between runs. **Three of the four ARP entries in the capture are exactly these internal entries** |
| C3 **[done]** | `Interfaces = @()` on placeholders | `lib/FleetCrawl.ps1:115` | `@{}` serializes as `{}`; `window.asArray` (`utils.js:13-17`) returns `[{}]`, and four consumers call it on `device.Interfaces` (`chassis.js:548,650`, `drawer.js:587,670`). Note `fixture.test.mjs:160-163` asserts `length === 0`, so **the fixture passes a shape assertion production would fail** |
| C4 **[done]** | Reconcile VLAN tag types | `:622-630` vs `lib/JunosParsers.ps1:95` | `Clients[].VLAN_Tag` is a string or `"Unknown"`; `Vlans[].Tag` is an int or `$null` |
| C5 **[done]** | Distinguish `LastFlappedSeconds` "Never" from unparseable | `:427-442` | Both yield `$null`. Also add a `y` unit — an interface up over a year silently fails both branches |
| C6 **[done]** | Frame `AuthFailed` as positive reachability evidence in the UI | — | TCP/22 completed and sshd responded |

> **Progress (2026-09-13): all of Phase 2 has landed.**
>
> **Migration notes.** §9.5 requires these, because C1 and C4 change *values* rather than adding
> fields. Both are read-tolerant in the UI, not rewritten in old files:
>
> - **C1.** A snapshot written before this change carries `ScanStatus = "Unreachable"`. Every UI path
>   already keys on `!== "Ok"`, so nothing breaks; `window.scanStatusMeaning` carries an entry for
>   `Unreachable` that says what it was split into. The classifier now lives in
>   `Get-JunosScanFailureClass` so its stderr shapes are testable without a live ssh.
> - **C4.** A snapshot written before this change carries `Clients[].VLAN_Tag` as a **string**, with
>   `"Unknown"` for no tag. The read pattern is `String()` on both sides, which every filter and the
>   VLAN dropdown already used; `window.formatVlanTag` handles all three shapes (int, `null`, and a
>   pre-C4 `"Unknown"`). `Vlans[].Tag` was already canonical and did not move.
> - **C5** is additive: `LastFlappedState` is new, `LastFlappedSeconds` keeps its meaning. An old
>   snapshot has no state field, which reads as `undefined` - the same "no extensive block" case as
>   `$null`.
> - **C2, C3, C6** need no migration. C2 changes only which address a backfill picks, C3 changes a
>   placeholder's `{}` to `[]`, and C6 is UI wording.
>
> Two things landed differently from the table above. `Get-FleetArpMap` was lifted to file scope in
> `FleetCrawl.ps1` so the order-independence C2 is *about* can be tested - a test that feeds the
> devices in one order cannot fail on the bug. And `ConvertFrom-JunosLastFlapped` was extracted for the
> same reason, which also removed the `continue` that had forced the extensive parse into two loops.
>
> C3 and C5 each had a test asserting the defect: `"placeholder node initializes Interfaces as a
> hashtable"` pinned C3 in place, and the fixture stamped a flap duration onto uplink ports *after*
> `accessRow` had recorded why there was none. Both were inverted rather than deleted.

### 4.3 Phase 3 — new commands

> **CRITICAL — prefix collision.** Sections are split on the echoed prompt and matched by **prefix in
> an `elseif` chain, last-write-wins** (`lib/Get-JunosNodeData.ps1:264-292`). Four commands revision 1
> proposed would **silently destroy existing data**:
>
> | Proposed | Collides with | Destroys |
> |---|---|---|
> | `show virtual-chassis vc-port` | `^virtual-chassis\b` | `StackMembers` |
> | `show vlans extensive` | `^vlans\b` | **the VLAN name→tag index the whole `Clients[].VLAN_Tag` join depends on** |
> | `show dot1x interface detail` | `^dot1x interface\b` | the dot1x parse |
> | `show arp no-resolve expiration-time` | `^arp no-resolve\b` | `ARP_TABLE`, and the added TTE column shifts the optional `Flags` capture at `:663` |
>
> Each is placed *after* its short form, so the new one wins.
>
> **Resolution: replace rather than add.** Three of the four are more-detailed forms of a command
> already in the batch, so running the detailed form *instead of* the brief one removes the collision
> entirely — same section key, same batch length, strictly more data. The fourth
> (`show virtual-chassis vc-port`) is complementary rather than a superset and is cut instead. That
> leaves the exact-matcher fix worth doing for safety but **no longer a prerequisite**.
>
> Revision 1's stated worry — that an unrecognised command could corrupt section parsing — is wrong
> in both directions: the split is on the echoed prompt, so a CLI syntax error leaves the bad
> command's section containing an error string and the next section intact.

**Strategy: upgrade in place, add almost nothing.** Three of the four collisions disappear if the
*existing* command is replaced by its more detailed form rather than run alongside it — the batch
length does not grow, the section key stays the same, and the matcher fix becomes a nice-to-have
rather than a prerequisite. Everything else is cut unless it earns a place.

**Net effect: 18 commands → 19.**

#### Upgrades in place (no net new commands, no collision)

| Replace | With | Gains | Risk |
|---|---|---|---|
| `show arp no-resolve` | `show arp no-resolve expiration-time` | ARP entry age, which materially cuts duplicate-IP false positives | ~~**Low — verified.** Same table plus one TTE column; documented option since 8.1. The added column shifts the optional `Flags` capture at `:663`, so the regex needs updating with it~~ **Landed 2026-09-14 — see §4.3.1.** The documentation also settled two things this row did not anticipate: `Flags` can be two words, and a non-expiring entry prints no TTE at all |
| `show vlans` | `show vlans extensive` | Per-interface `ge-0/0/20.0*, tagged, trunk` lines: the active marker, **tagged/untagged (i.e. native VLAN)** and **port mode** — which is most of what `show ethernet-switching interface` was wanted for | ~~**Medium — needs a one-off check on hardware.** Juniper's published sample output for `extensive` shows **no routing instance**, and the parser keys `$VlanDict` on `"<instance>\|<name>"` to disambiguate a VLAN name reused across instances (`:580-586`). Harmless on a single-instance fleet; on a multi-instance fleet the name-only fallback must detect two same-named VLANs with different tags and refuse the join rather than guess.~~ **Landed 2026-09-14 — see §4.3.1.** The risk is RETIRED: the ELS stanza does print `Routing instance:`. The real change was that the tag index had to move off the table and onto the parsed objects |
| `show dot1x interface` | `show dot1x interface detail` | `Authenticated VLAN` and `Guest VLAN member` per port — i.e. whether a client landed in a fallback VLAN rather than its intended one | ~~**Medium — size unverified.** Per-port stanzas; on a fleet with dot1x on every access port that is ~48 stanzas per switch. **Measure the output against the 120 s cap before committing**; if it is large, keep the brief form and take per-port state from R6 instead~~ **Landed 2026-09-14 — see §4.3.1.** ~1,000 lines per switch against `show interfaces extensive`, which already emits several times that — so the size worry is answered by arithmetic. The cap itself stays unmeasured until a switch is available |

#### Added (one command)

| Command | Unlocks |
|---|---|
| `show spanning-tree bridge` | Root bridge ID, root cost, root port and protocol per scope — and **topology-change count and time since last change**, which for "why is this broken *now*" matters more than the root ID. Small output (one stanza per scope). Today the root is only *inferred* from "a node with no `ROOT`-role port", and `DesignatedBridge` is not the root ID **Landed 2026-09-14 — see §4.3.1.** Its headings name the scope, and the parser normalises them to the strings the per-port view uses, so the two join |

### 4.3.1 Built — 2026-09-14: landed from published output, unverified on hardware

All four command changes are in `lib/Get-JunosNodeData.ps1`'s batch, with parsers, fixture data and
tests. **Every shape below is derived from Juniper's published sample output and from published lab
captures — not from a device this project has seen.** No switch is available (§3.5), and the user's
direction was to make the best-supported guess from the documentation rather than leave the item
blocked. So this is *provisional in a specific way*: the plumbing is tested end to end, and the
question of whether a real EX prints these exact strings is open. The samples live in the PowerShell
suite with their source URLs beside them, which is what a real capture gets diffed against.

**What the documentation settled — each of these changed the design:**

- **`show vlans extensive` on ELS DOES print `Routing instance:`**, as the first line of each stanza.
  §4.3's stated risk — that it does not, and that `$VlanDict`'s `"<instance>|<name>"` key would have
  nothing to build from — is **retired**. The pre-ELS form prints no instance and falls back to the
  name-only index, which already refuses a name two instances disagree about.
- **There are two extensive layouts, not one.** ELS: `VLAN Name:` / `Tag:` / `Interfaces:
  ge-0/0/0.0*,tagged,trunk`. Pre-ELS: `VLAN: NAME, Created at: …` / `802.1Q Tag: 100, …` with members
  indented as `ge-0/0/20.0*, tagged, trunk`. Both are parsed, plus `show vlans detail`'s
  `Untagged interfaces:` / `Tagged interfaces:` lists, so a fleet that answers one command with
  another still yields membership instead of an empty VLAN list.
- **The tag index had to move off the table.** The extensive form has no columns to read, so
  `$VlanDict` and `$VlanNameTagIndex` are now built from the **parsed `Vlans[]` objects**. That is the
  load-bearing change in the worker: `Clients[].VLAN_Tag` depends on that index, and it now cannot
  disagree with `Vlans[].Tag` because both come from one parse.
- **`show arp … expiration-time` appends `TTE` after `Flags`, and `Flags` can be two words**
  (`permanent published`), while a non-expiring entry prints **no TTE at all**. A "one token" flags
  capture would have swallowed the number or reported a TTE as a flag, so the capture is anchored to
  the documented vocabulary (`none|permanent|published|gateway|remote`) with the TTE as its own
  numeric group. The bracketed physical port the worker already read survives in front of both.
- **The dot1x size worry is answered by arithmetic, not by hardware.** A detail stanza is ~20 lines;
  48 ports is ~1,000 lines, against `show interfaces extensive`, which already emits several times
  that on the same switch and is deliberately issued last for exactly that reason. The brief form's
  parser is kept for old snapshots and detected by content, not by configuration.
- **`show spanning-tree bridge`'s headings name the scope**: `STP bridge parameters` (the single
  RSTP/STP instance), `… for VLAN 100` (VSTP), `… for CIST` and `… for MSTI 1` (MSTP). The parser
  normalises these to the **same strings `show spanning-tree interface` prints in its own headings** —
  `instance 0`, `VLAN 100`, `MSTI 1` — because the only reason to collect the bridge view is to join
  it to per-port state, and a join on two spellings of one instance is not a join. A bare heading
  mapping to `instance 0` is the one inference here rather than a quotation.

**What is still unmeasured, and cannot be measured without a switch:** the 120-second session cap with
four changed commands, and whether any given release reflows these stanzas. The parsers read by label
rather than by column or indentation for that reason, and every one of them returns an empty result
rather than throwing on text it does not recognise.

**New data on the node**, all additive (§9.5) and `$null`/empty on every existing snapshot:

| Field | From | Unlocks |
|---|---|---|
| `Vlans[].Interfaces[].Tagged`, `.Mode` — mirrored onto `Interfaces[].Vlans[]` | `show vlans extensive` | The **native VLAN**: an untagged member of a tagged VLAN on a trunk. G5's second half is no longer blocked on retention |
| `Interfaces[].Dot1x[].AuthenticatedVlan`, `.GuestVlan` | `show dot1x interface detail` | A supplicant that authenticated **into the wrong VLAN** — guest or server-fail fallback — which the brief form cannot express |
| `ArpEntries[].Tte` | `show arp no-resolve expiration-time` | Entry age, against duplicate-IP false positives |
| `StpBridge[]` — `Scope`, `EnabledProtocol`, `RootId`, `RootCost`, `RootPort`, `BridgeId`, `TopologyChangeCount`, `TimeSinceLastChangeSeconds` | `show spanning-tree bridge` | G4. Also makes "this switch **is** the root" a fact rather than an inference from the absence of a `ROOT`-role port |
| `SectionsAttempted[]`, `SectionErrors{}` | the section splitter | §3.5's R15 question, below |

**Nothing read the new fields when this landed, and that was deliberate** — the parsers and the rules
went in as two steps so a defect in either could be found on its own. ~~Three follow-ons, none of them
part of this item~~ **all four landed 2026-09-14 as item 15 (§3.7)**: G4's topology-change rule over
`StpBridge[]`, a native-VLAN mismatch rule over `Tagged`/`Mode`, a dot1x fallback-VLAN rule over
`AuthenticatedVlan`, and the Diagnostics tab reading `SectionErrors` so the histogram says *refused*
rather than *missing*. `hasSection` still consults `SectionsCaptured` alone, which is the right
reading: a port on a chassis without the feature is not a subject.

**Provenance of each sample in `Run-Tests.ps1` §19**, graded, because that is the point of keeping them:

| Sample | Grade | Source |
|---|---|---|
| `show vlans extensive`, pre-ELS stanza | **Verbatim** from the published sample | the Junos 12.3 `show vlans` page |
| `show vlans extensive`, ELS stanza | **Summarised** — the current doc page would not render its sample blocks on fetch, so the field names and the `Interfaces: ge-0/0/0.0*,tagged,trunk` spelling come from a search engine's rendering of that page | the current CLI-reference `show vlans` page |
| `show arp … expiration-time` | **Verbatim** column order and flag vocabulary; the "no TTE on a non-expiring entry" case is read off the published sample's own first row | the Junos 12.3 and current `show arp` pages |
| `show dot1x interface detail` | **Inferred** — the label strings are documented in the output-field table, the stanza LAYOUT is the standard Junos detail shape and is this project's inference. The parser reads by label for exactly that reason | the current `show dot1x interface` page |
| `show spanning-tree bridge` | **Documented headings and label list**, plus a published lab capture for the VSTP per-VLAN heading | the EX `show spanning-tree bridge` page and a public VSTP lab writeup |

**Cross-checked 2026-09-14 against `Juniper/py-junos-eznc`** (Juniper's own Python library), at the
user's suggestion. It speaks XML RPC rather than CLI text, so it holds no sample of any of these four
commands — but two things in it bear on this section. Its `op/vlan.yml` view names `vlan-instance`,
`vlan-tag` and `vlan-member-interface`, which is the pre-ELS stanza's field set and corroborates the
layout graded *verbatim* above. And its `rpc-reply` fixtures carry two genuine Junos refusal shapes,
`error: device asdf not found` and a bare `permission denied` — the second has no `error:` prefix, so
`Get-JunosSectionErrors` now anchors on it too (`Run-Tests.ps1` §19). The library remains a good source
for *field names*, and no source at all for what the CLI prints around them.

#### Cut

| Command | Why it does not earn a place |
|---|---|
| `show interfaces diagnostics optics` | The measured fleet is 72/75 copper. The cost is paid on every device and the yield is near zero on a copper access estate. Revisit only if a fibre-dense distribution tier is brought into scope |
| `show poe controller` | Per-port PoE already arrives free from `show poe interface`, which is already in the batch; R7 widens what is kept from it. The only loss is the chassis power budget, which explains a rare fault |
| `show virtual-chassis vc-port` | Not a replacement for `show virtual-chassis` — complementary, so it cannot collapse its collision. The important case, a member that dropped out of the stack, is caught by R11's `Status` column at zero cost. The loss is per-VCP error counters |
| `show lacp interfaces` | Bundle membership is already free from `show interfaces terse`, and "bundle down while every member is up" is diagnosable from data already held. The loss is partner system ID and `Collecting`/`Distributing` per member — narrow, and the measured fleet has one two-member bundle |
| `show route protocol direct` | Redundant with R1, which recovers connected subnets and prefix lengths from `show interfaces terse` at no session cost |
| `show route protocol static` | Usually empty on an access switch, and a missing return route is rarely diagnosable from one end anyway |
| `show ethernet-switching interface` | Its three wanted fields are now covered elsewhere: port mode and per-VLAN tagging by `show vlans extensive` above, and the blocking *reason* partly by R10's `BPDU Error` / `Loop Detect PDU Error` / `Ethernet-Switching Error` fields, which print on every port's link-level line in output already collected. **If the `show vlans extensive` upgrade fails its hardware check, this command comes back** |
| `show interfaces filters`, `show firewall` | Speculative until filters are known to be in use — and that is checkable for free, by grepping the `Configuration` text already stored at `:311`. Add them only for a fleet that actually binds filters |

### 4.4 The configuration is not parsed — decided, not deferred

**`$NodeData.Configuration` stays collected and stored verbatim (`:311`) for backup and manual
review, and contributes nothing to the rule engine.** There is no config-parsing phase.

This replaces revision 2's "Phase 4, deferred". Deferral implied it was eventually necessary. It is
not, and the residue does not justify the failure modes.

**The whole config-only residue, and why each one does not need a parser:**

| Item | Disposition |
|---|---|
| Firewall filter bindings and term logic | A non-zero **discard counter** from `show firewall` is proof a filter is dropping; parsed term logic is a guess that one might. Whether a fleet binds filters at all is a substring test on stored text, not a parser — and that test is the trigger for adding the operational command, per §4.3 |
| `mac-limit` / storm-control thresholds | The threshold is not the fault; the enforcement state is, and that is operational |
| Routing-instance (VRF) membership | Moot on a single-instance fleet. Partly recoverable from the route-table names R9 captures |
| Static routes | Rarely diagnosable from one end; on an access switch usually only the default route, which R9 already parses |
| MSTP region / revision / VLAN→MSTI map | Only applies to MSTP fleets, and `show spanning-tree mstp configuration` supplies it operationally if one is ever in scope. Until then, MSTP degrades to `VLAN_ONLY` (§2.3), which is a stated confidence level, not a wrong answer |
| MAC aging time | One statement; the default (300 s) with a caveat is sufficient to bound E2 in `port-last-used-spec.md` |
| Intended VLAN per port | **Not in the config on a NAC fleet.** VLANs assigned by RADIUS at authentication time never appear in `show configuration`, so a config-derived "intent" would raise false findings on exactly the ports working correctly. §1.3 already requires intent-dependent rules to be peer-comparisons, which need no config |

**The failure modes are the stronger argument.** `display set` emits `deactivate …` lines, so a
parser that misses them reads a deactivated IRB as live and **inverts** the fault. `apply-groups` are
not expanded, so a fleet templating IRBs or filters through groups is silently missing the inherited
statements — and fixing that means changing the collection command (`:162`) to
`show configuration | display inheritance no-comments | display set`, lengthening the
second-largest command in a batch §4.3 works to keep short. Both produce **wrong** answers rather
than absent ones, which §2.3 identifies as the failure this design most needs to avoid.

**Existing config parsing in the UI is untouched** and is not diagnostics: port mode for interface
classification (`web-src/drawer.js:604`), the local-account audit (`web-src/dashboard.js:508,515`),
and config-change detection between snapshots (`web-src/dashboard.js:91,146-149`). These work, serve
their own features, and are already the right shape — a handful of anchored regexes. If a specific,
individually-justified statement is ever wanted, it is added there in that shape. What is ruled out
is a config *evaluator* feeding the rule engine.

*(Revision 1 said `Configuration` is "the first casualty of a timeout". It is the second — extensive
is last. And R1's claim that the snapshot has "no prefix length anywhere" was overstated: the config
text holds it, unparsed. The accurate claim is "no parsed address or prefix data" — and since the
config is not parsed, R1 remains the only route to it.)*

---

## 5. Topology graph

### 5.1 Reuse the node set, build a new edge set

`computeDeviceClassification` (`web-src/topology-graph.js:11-35`) is reused verbatim.
`computeNeighborEdges` (`:47-65`) is not reusable: it dedups on a sorted IP pair and keeps only
`{from,to}`, losing `LocalPort` and collapsing a four-member LAG to one unlabelled edge. Build a
parallel port-level graph; the diagram wants the deduped form.

### 5.2 Link identification — scoped to the links that can be hops

> **Correction, and this is the revision's most consequential.** Revision 1 computed LLDP field
> reliability across all 43 blocks and concluded that Port ID is "usually a MAC (38/43)", Chassis ID
> is "MAC-shaped in only 8 of 43 … any design keyed on chassis ID fails on ~80% of this network", and
> that a fleet-wide `portMacIndex` was "the highest-value use of the expanded interface parse". Every
> one of those inverts when the population is scoped to blocks that can actually be a path hop.

Cross-tabbed by the worker's own classification predicates:

| Class | Count | Port type | Chassis type | System name | Mgmt addr |
|---|---|---|---|---|---|
| MED endpoint → `MedNeighbors` | 28 | 28 Mac address | 25 Network address, 3 Mac address | 27 | 27 |
| No capability, no address → dropped | 10 | 10 Mac address | 10 Locally assigned | 0 | 0 |
| **Bridge/Router with address → `Neighbors`** | **5** | **5 Interface name** | **5 Mac address** | **5** | **5** |

**Every switch-to-switch neighbour advertises a real interface name as Port ID and a MAC-shaped
Chassis ID, with System name and management address present — 5/5, no exceptions.** The MAC-shaped
Port IDs are phones, APs and workstations, which will never appear in any fleet member's
`Interfaces` array.

**Consequences:**

- **Drop the `portMacIndex` entirely.** Beyond being unnecessary, it is unsound: per-port MACs are
  not unique on this hardware — 24 physical ports on the one switch print the identical `Current
  address`, and across 82 interfaces with an address line there are only 54 distinct values. Worse,
  `lib/JunosParsers.ps1:272-273` prefers `Current address`, which for a LAG member is the **bundle's**
  MAC, so a bundle and both members collapse to one key. An index returning plausible-but-wrong port
  names is worse than no index.
- `RemotePort` is authoritative for infrastructure links. Use it.
- Chassis ID is a usable cross-check for infrastructure links, and revision 1's hostname-collision
  argument (from "32/43") does not apply to them either.

**Link confirmation, in priority order:** (1) LLDP reciprocity — both ends name each other, each
reporting its own port name; (2) chassis-ID agreement; (3) hostname, last resort.

> **The STP designated-bridge cross-check does not work as revision 1 described it.** It claimed
> "on a `DESG` port, `DesignatedBridge` is the local bridge's ID … establishes adjacency with no LLDP
> at all." `DESG` is precisely the useless case — on a designated port the designated bridge *is* the
> local bridge, which says nothing about the far end. The informative roles are `ROOT`/`ALT`/`BKUP`.
> And the join key does not join: for every uplink port with a `ROOT` or `ALT` row, the
> designated-bridge MAC is **not equal** to that port's LLDP chassis ID — 0 matches out of 3, same
> OUI and adjacent in the chassis pool, but different MACs. The cross-check is only possible between
> two *scanned* devices using each device's own bridge ID, which requires `show spanning-tree bridge`
> (Phase 3). It is not a Phase 1 capability.

### 5.3 LAG, virtual chassis, fleet edge

**LAG.** LLDP runs on members, so a four-member bundle yields four half-edges. **Collapse onto the
bundle during graph construction, not at reporting time** — STP rows exist only on `aeN` (verified:
the bundle has rows in 13 scopes, neither member appears in any), so an edge keyed on a member port
has no `StpDetail` and every LAG hop would be permanently `VLAN_ONLY`. Then fan per-hop L1 rules
across members: a single errored member is exactly the fault class this tool should catch.

**Virtual chassis.** One node. `vcp-*` is internal fabric and not a hop, but report FPC-to-FPC as hop
detail when ingress and egress differ.

**Four fleet-edge cases, four distinct messages:** never-scanned neighbour (path terminates; report
`ScanStatus`/`ScanError`); out-of-scope neighbour (`lib/FleetCrawl.ps1:386-394` logs the skip to the
debug file only — **the reason never reaches the topology**, which is a gap worth closing);
address-less bridge (R5, gated on capability); and an inferred unmanaged segment (≥3 client MACs on a
non-uplink port with no MED and no `Neighbors` entry) reported at `INFERRED` and never traversed.

**Done 2026-09-13 (work order item 9, graph half).** `web-src/l2-graph.js`: `buildPortGraph(topology,
{allowedScopes})` → `{edges, terminals, deviceByIp, transitPorts}`, with the twelve micro-topologies as
its acceptance tests. `computeNeighborEdges` is untouched; the diagram keeps it.

- **Edges and terminals are separate collections, and a test asserts no port is in both.** An edge joins
  two devices in the snapshot and may be traversed; a terminal is where the topology ends. All four
  §5.3 fleet-edge cases are terminal kinds — `unscanned`, `out-of-scope`, `addressless-bridge`,
  `inferred-segment` — because chaining two of them would invent a link (F14).
- **A device in the snapshot is always an edge end, never a terminal**, even when its scan failed. The
  item-7 correction applies here too: a switch we could not log into is still a bridge, and the link to
  it is real because the other end reported it. Those edges come out `reciprocal: false`.
- **Chassis-ID confirmation had to change shape.** §5.2's second tier needs the far end's own chassis
  MAC, and no node field carries one — `show chassis hardware` has no MAC line. What is available is
  agreement between *other* devices' LLDP about one management address, so the tier is
  `chassis-consensus` and requires two distinct reporters. That is corroboration from third parties, not
  the far end confirming, which is why `reciprocal` stays a separate field instead of being folded in.
  Confirmation is `reciprocal` → `chassis-consensus` → `hostname` → `unconfirmed`.
- **`stp` per end is `{scopes, captured, collapsed}`.** An empty `StpDetail` means two different things
  — the section arrived and no instance covers the port (`NO_STP_INSTANCE`), or the section never
  arrived (`NOT_EVALUATED`) — and only `SectionsCaptured` separates them. Item 10's
  `bothEndsHaveScopeFor(T)` needs both answers.
- **The transit predicate is the worker's**, including `$InterconnectPortPattern`: a port facing a
  switch/router LLDP neighbour plus the bundle it belongs to. It is returned as `transitPorts` so
  endpoint resolution uses the same definition — a MAC on one of those ports is a sighting in passing,
  not a location (F4).
- **The generated fixture has no LAG at all**, so bundle collapse is covered only by the micros. That is
  an `accessRow` gap, not a graph gap; ~~it lands with the interface-field work.~~ **Still open after that
  work (item 11).** Filling the interface rows did not create an aggregate: a LAG is a topology shape the
  generator would have to build in `linkDevices`, and the fault injector is the wrong place for it (§3.5).
  It is why `lag-member-down` is the one L1 rule the fixture-scale suite cannot exercise.
- Two micro-topologies were added for this item: `transit-sighting` (F4) and
  `inferred-unmanaged-segment` (F14, §5.3's fourth case), taking the set to twelve.

---

## 6. Endpoint resolution and path computation

### 6.1 Resolution is separate and separately tested

Identifier types: management IP, hostname, serial, client IP, client MAC, 802.1X username, port
description, switch+port, MED endpoint. `TrueClients` is a JS-side alias (`app.js:339`,
`drawer.js:342`), not a worker field.

Every ambiguity is an explicit outcome: same MAC on two devices' access ports (genuine ambiguity —
report both); same MAC on two ports of one device (**silently collapsed today** by last-wins at
`:641`; R3 fixes it); IP with no MAC sighting; hostname not unique; device failed its scan (may be a
waypoint, never an endpoint — and `Partial` is the dangerous case because
`lib/FleetCrawl.ps1:169,188-194` preserves partial data over a placeholder).

**Done 2026-09-13 (work order item 9, resolution half).** `web-src/endpoint-resolution.js`:
`createResolver(topology, {allowedScopes|graph})` → `resolve(query)` →
`{status, matches, locations, claimants, interpretations, notes}`. All nine identifier types; the type
is detected from the string shape and can be forced with `{type}`.

- **`status` is one of `FOUND` / `AMBIGUOUS` / `TRANSIT_ONLY` / `NOT_FOUND`**, computed from *places*
  rather than rows: one location is one `(device, port)` pair, however many tables named it. A client
  that also appears in its own switch's MAC table is one endpoint, not two.
- **`TRANSIT_ONLY` is the F4 outcome.** A switch learns every MAC it forwards, so a host three closets
  away is in the uplink's table too. Transit rows are reported as evidence — they are the only thing
  showing which way the traffic went — but they are not a location. Only a MAC sighting can be "in
  passing": a port named directly is a place whatever crosses it, including a port facing an
  address-less bridge, which is both transit and a real location.
- **A free-text port label is the weakest match there is, so it is a lower tier.** Every uplink is
  labelled `UPLINK to <peer hostname>`, so ranking a substring search alongside the exact identifiers
  made resolving any switch by name come back ambiguous with the ports of everything patched to it.
  Description search now runs only when hostname, serial, 802.1X user and MED system name all found
  nothing. Where a label *is* the identifier the operator has, the ambiguity is real and reported:
  `AP-1000` and `PHONE-2000` are reused across closets by design.
- **`claimants` carries the MACs claiming a queried address even when one has no sighting**, which is
  how the second claimant of a contested address usually appears — an ARP entry and nothing else.
  Without it the reported ambiguity named nothing.
- **A MAC reported verbatim, compared through `macKey`.** The data mixes cases; a normalized-only field
  would have the UI print addresses in a case the drawer never shows.
- **The `Partial`/failed distinction is a note, not a status**: `device-scan-partial:<ip>` or
  `device-scan-failed:<ip>`. Such a device is resolvable — it can be a waypoint — and is never an
  endpoint, and `Partial` is the dangerous one because it carries real data and otherwise reads as
  complete.
- **The item-8 manifests are the oracle for the fixture-scale cases**, as intended: an injected
  duplicate MAC must resolve `AMBIGUOUS` to exactly the two `(device, port)` pairs the manifest names,
  a duplicate IP must report both claimants, a held supplicant must be findable by the identity it
  presented. A test also asserts that no *uninjected* MAC resolves to two **devices** — while one MAC on
  two ports of one switch stays allowed, because `buildMacTable` creates that case deliberately and it
  is R3's real ambiguity.

### 6.2 The algorithm

```
l2Path(a, b, T):
  G = portLevelGraph(snapshot)          // LAG already collapsed (§5.3)
  G = G.filter(e => bothEndsCarryVlan(e, T))
  stpAvailable = bothEndsHaveScopeFor(T)
  if !stpAvailable:  mark all hops NO_STP_INSTANCE or VLAN_ONLY as appropriate
  else:              G = G.filter(e => stpState(e, T) not in {BLK, DIS, LRN, LST})

  paths = enumerateSimplePaths(G, a, b, limit: 8)
  0 paths  -> NO_PATH(last verified hop, specific reason)
  1 path   -> the path, per-hop confidence
  >1 paths -> AMBIGUOUS(all of them)
```

> **BFS is not sufficient, contrary to revision 1.** The `multiple paths → AMBIGUOUS` branch is the
> design's entire safety story, and **BFS cannot produce it** — it returns one shortest path and
> never notices a second. That only mattered if a pruned VLAN topology is always a tree, and it is
> not: 4 of 17 VLANs in the capture have no STP instance; Juniper documents VSTP and RSTP
> **coexisting on one device** above the VSTP VLAN ceiling, so per-VLAN lookup silently misses the
> RSTP-covered VLANs; MSTP without the config-resident VLAN→MSTI map degrades *every* device to
> `VLAN_ONLY`; and a shared segment behind an unmanaged bridge is a multi-access segment with no node
> in an LLDP-derived point-to-point graph, so two `DESG FWD` ports can be chained even though they
> never exchange traffic.
>
> Use bounded simple-path enumeration and report the count. **Do not** use Dijkstra on STP cost — the
> engine reads a converged election's result, and a cost tiebreak would hide the ambiguity.

**Done 2026-09-13 (work order item 10).** `web-src/l2-path.js`:
`computePath(snapshot|graph, {from, to, vlanTag, limit, stepBudget, macAgingSeconds, allowedScopes})` →
`{status, paths, truncated, reasons, lastReachedHop, notes}`, with `status` one of
`PATH` / `AMBIGUOUS` / `NO_PATH`. Deviations and decisions, in the order they were forced:

- **The fixture had no VLAN membership, so the first filter was vacuous.** Every generated device
  carried `Vlans: []` while `SectionsCaptured` claimed the VLANS section arrived — the honest reading
  prunes every hop, and a fixture-scale path test against it would have asserted `NO_PATH` everywhere.
  Membership is now derived in the generator (§8.2) and the F11 injector item 8 deferred exists (§8.3).
- **Two bounds, and `truncated` when either bites.** The path limit (8) bounds what is reported; a step
  budget bounds the walk, because an unpruned VLAN — F13's case — leaves the graph cyclic and a
  fleet-sized cyclic graph holds far more simple paths than anyone will enumerate. "Exactly two paths"
  and "the first two of an unknown number" are different answers and only one of them is safe.
- **Scope lookup is per port and per VLAN, in one precedence (F12).** `VLAN <T>` where it exists, else
  `instance 0` (RSTP covers every VLAN without a VSTP instance of its own, and caps the hop at
  `VLAN_ONLY`), else any `MSTI *` — also `VLAN_ONLY`, because the VLAN→MSTI map lives in the
  configuration and §4.4 decided not to parse it — else `NO_STP_INSTANCE` when the STP section arrived
  and nothing covers this VLAN, else `NOT_CAPTURED`. VSTP and RSTP coexisting on one device resolves to
  whichever applies to *that* VLAN, never to a device-level protocol guess.
- **Blocking is one-ended.** RSTP leaves the far end Designated and forwarding, so a hop is traversable
  only if *neither* end is in `{BLK, DIS, LRN, LST}`. `LRN`/`LST` prune with their own reason
  (`stp-not-converged`, F9) rather than being folded into a settled block.
- **`NO_PATH` names the frontier, not the destination.** The reasons are the pruned edges adjacent to
  what *is* reachable from the source, plus the terminals there — a port facing an address-less bridge
  is where the topology ends, and chaining across it would invent the hop the path is missing (F14).
  `lastReachedHop` is the reachable device fewest unpruned hops from the target, with the route to it.
- **F2's threshold is reported, not applied — measured.** Refusing `VERIFIED` when a path's hops span
  more than one MAC aging interval would demote **71% of paths** on a 60-device fixture (99 of 139
  sampled; 66% of even the two-hop paths; median spread 461 s against a 300 s interval) — because
  `stampCapture` spreads capture over a 14-minute window, as a real crawl does. The threshold is sound
  for MAC-table evidence, which is what ages out in 300 s; a hop's state comes from a spanning tree that
  does not. Every path therefore carries `captureSpreadSeconds` and `macCoherent`, and the caller
  decides. The ladder is unchanged.
- **`VERIFIED` is unreachable on the generated fleet**, by construction: it runs a single RSTP instance
  (§8.2), so every fixture-scale path is honestly `VLAN_ONLY`. The VSTP micro-topologies are where
  `VERIFIED` is exercised, which is what they were built for. **`INFERRED` is unreachable everywhere**,
  not only there: every edge in the graph is LLDP-derived (§5.2), so adjacency from MAC-table or STP
  evidence alone has no producer yet. The level stays in the ladder; nothing emits it.
- **The reasons are a frontier, not a survey.** Only a pruned edge with exactly one end among the devices
  actually reached can be why the target was missed — unpruning one whose ends are both reachable adds no
  device. Without that rule a `NO_PATH` in a sparsely-carried VLAN listed thirty blocked legs and buried
  the one absence that mattered. The same applies to a shared segment whose other side is reachable
  anyway.
- **A path is per VLAN, and no VLAN is not a VLAN.** A missing tag would otherwise be `NaN`, match no
  member anywhere, and prune every hop with a fabricated `VLAN NaN is not on …` — a wrong answer in the
  shape of a real diagnosis. It is refused with `no-vlan-given` instead.
- ~~**Still device-to-device, which item 14 has to close.** §6.2's `a` and `b` are resolver outputs —
  `(device, port)` pairs — and an access port's own membership and spanning-tree state are therefore
  never assessed: a path to a host whose port is not in the VLAN, or whose supplicant is `Held`, reads as
  clean up to the last switch. That belongs where the resolver result is wired into the path call.~~
  **Closed 2026-09-14 (item 14).** `computePath` takes optional `fromPort`/`toPort` and assesses each end
  with the same two filters a hop gets: `endpoint-vlan-absent` (F11) or
  `endpoint-stp-blocking` / `endpoint-stp-not-converged` (F9) is a `NO_PATH` whose reason names the port,
  and no hops are enumerated — the frontier is not the diagnosis when the path stops at one of its own
  ends. A port that carries the VLAN still caps the answer: an endpoint in RSTP's single instance makes
  the path `VLAN_ONLY` and one in no instance `NO_STP_INSTANCE`, which is how the demotion is attributed
  to the endpoint rather than to a hop. A named port the device does not have is reported as
  `unknown-port:<ip> <port>` and never used as a filter. The dot1x half of the note above is not
  included: a `Held` supplicant is a rule (`dot1x-held`, §3.5), and the path computer's job is the
  forwarding question. **`ScanStatus` is not read here** — an endpoint's own scan state is already a note
  from the check above it.
- **The port end is built by `l2-graph.js`, not by the path computer.** `portEndFor(device, port)` returns
  the same shape and the same absent-versus-empty rules as an edge half, so an endpoint and a hop cannot
  come to different conclusions about one row. `ipToLong` / `cidrContains` / `vridOf` moved there for the
  same reason: §6.4 and the L3 rules now test one implementation of containment.

**Done 2026-09-14 (work order item 16) — G1, per-hop forwarding-plane evidence.** Everything above answers
*may* a frame cross this hop: both ends carry the VLAN and neither is blocking. That is a statement about
**configuration**. The MAC table is a statement about **traffic** — a switch learns a MAC on the port it
arrived on — so "the destination is learned on the port facing the next hop" is direct evidence that
frames really go this way. `computePath` takes optional `sourceMac`/`targetMac`, every hop gains
`macEvidence.target` / `.source`, and each path carries the counts. Four decisions, each easy to undo by
accident:

- **Four states, and `ABSENT` is not a fault.** `CONFIRMED` (learned in this VLAN on this hop's port),
  `CONTRADICTED` (learned in this VLAN on a *different* port), `ABSENT` (the table arrived and does not
  hold it), `UNMEASURED` (no MAC given, no `MAC_TABLE` section, or the tag wears no name on this device).
  §6.3 already settled the reading: a switch learns from traffic it has **seen**, so a host that has not
  spoken through here, or whose entry aged out, is simply absent. Only `CONTRADICTED` says the forwarding
  plane disagrees with the computed path.
- **It does not move the confidence ladder.** `VERIFIED` means the spanning tree was read for this VLAN at
  both ends (§2.3). MAC evidence answers a different question, and demoting on it would make one word mean
  two things. A contradiction is a path note (`mac-evidence-contradicts-path`), and §6.5 stands: report,
  do not adjudicate.
- **Both directions over one wire.** The target should be learned on the near end's port and the source on
  the far end's, so a hop carries two independent observations. Either contradicting is a contradiction.
  A MAC learned on two ports of one device in one VLAN is R3's ambiguity, reported in `learnedOn`; if the
  hop's own port is among them, the frame does leave this way and the evidence confirms. The bundle's
  members count as the bundle's port, because an aggregate learns against the member the frame arrived on.
- **Age is reported, not applied.** When a path's `captureSpreadSeconds` exceeds the aging interval the two
  tables were not read at comparable times, which weakens a contradiction without excusing it:
  `mac-evidence-stale` joins the contradiction note rather than suppressing it.

The MAC comes from the resolver — the path computer cannot derive it from a `(device, port)` pair — and
only when the location has exactly one. Two MACs behind one port is an endpoint question, and verifying a
path against a guess between them is worse than not verifying it.

### 6.3 Symmetry

Within one VLAN a correctly pruned topology is a tree *when it is pruned at all* (§6.2), so L2
forward and reverse coincide; two ends disagreeing about state for one scope is a convergence fault
worth reporting. **Below the bundle this does not hold**: Junos load-balance hashing is not
guaranteed symmetric, so A→B and B→A can cross different members, and a hop claimed `VERIFIED` by the
bundle's STP state can be broken for half the flows.

Real asymmetry is L3 and the snapshot cannot detect it — no routing table beyond the default route.
*(Revision 1 said no VRRP state is collected. See G3 — it partly is.)*

The MAC table is directional evidence: a switch learns from traffic it has *seen*, so "A's switch
knows B but B's does not know A" is normal for one-way traffic.

### 6.4 Cross-VLAN

Two L2 segments joined by an explicit L3 hop, marked *not verified*.

> **Revision 1's gateway rule is unsound.** It said "a device holding an ARP entry for the endpoint's
> IP on an `irb.*` interface is that client's L3 gateway." The measured access switch's entire ARP
> table is **four entries** — three internal VC control-plane entries and one on an `irb.N` which is
> the switch's *own* upstream router. Applied as written, the tool declares the switch to be the
> gateway for its own gateway. It is unsound in general too: a device ARPs anything it originates
> traffic to (RADIUS, NTP, syslog); proxy ARP produces entries for other subnets; and under VRRP both
> master and backups hold the IRB.

**Corrected:** candidate gateways are devices with a logical unit (R1) whose **configured address and
prefix** contain the endpoint's IP. More than one candidate is `AMBIGUOUS`, not a pick. Report VRRP
presence (G3) alongside.

**Done 2026-09-14 (work order item 14).** `L2Path.gatewayCandidates(snapshot|graph, ip, {vlanTag})` →
`{status, candidates, vrrp, notes}`, rendered under the path answer rather than inside it — the path is
an L2 question and the gateway an L3 one. Three things it does not do, each deliberate:

- **No ARP anywhere in it**, per the correction above. Only `LogicalUnits[].LocalAddress` with a prefix.
- **`NOT_FOUND` is the usual answer on an access-only crawl and is not dressed up.** The generated
  fleet's only `inet` unit is each device's own `vme.0` management address, so a client address is inside
  no crawled device's prefix and the report says exactly that. A fabricated `irb` to make the fixture
  produce candidates would have been a lie in the test data; the micro test carries the `irb.20` case.
- **VRRP is reported beside the candidates, never folded into them.** A VIP MAC proves a virtual router
  exists and gives its VRID; it gives nothing about which candidate is master, and G3's whole value is
  that "one of N routers" beats a single pick. Filtered by the path's VLAN when one is known, since a VIP
  in another VLAN is not evidence about this one.

### 6.5 Report, do not adjudicate

Firewall filter term evaluation — implicit-discard semantics, term ordering, `then accept` vs
`then count` — is the most error-prone item in the catalogue. A binding is a lead; a non-zero
discard counter is evidence.

---

### 6.6 Built — 2026-09-14: the Diagnostics sub-tab

`web-src/diagnostics.js`, an eighth tab in `#analysisview`. Three panels: the path tracer at the top,
the findings grouped by severity then rule, and the `missing` histogram under them. Decisions worth
keeping, each of which is easy to undo by accident:

- **The histogram is on the screen, not behind a toggle.** §2.4's whole point is that "nothing fired" and
  "nothing was read" look identical on a findings-only screen. Every rule with an unevaluated subject is
  listed with the datum that was missing and how many times — a truncated capture reads as a table of
  `section:MAC_TABLE`, not as a clean fleet. Measured on a 40-device faulted fixture with `10.20.` as the
  allowed scope: **131 findings, 3,185 unevaluated subjects across 21 of the 39 rules**, and the
  histogram's largest row by far is `section:INTERFACES_EXT` at 2,496 — the §4.3 section this fleet's
  devices do not all capture, which is a statement about the data and not about the network. (Run with no
  scopes configured the same snapshot reports 47 findings and 3,445 unevaluated, the difference being
  `client-outside-scope`'s 260 subjects going from evaluated to `option:allowedScopes` — which is why the
  summary line says so rather than showing a smaller number as an improvement.)
- **`severity: 'info'` is mapped explicitly.** The dashboard's vocabulary is `ok`/`warn`/`crit` and the
  stat cards' is `critical`/`warn`; `info` arrived with `neighbour-never-scanned` in item 13 and belongs
  to neither by default. A test asserts every severity in the catalogue has a tier and a band, so a new
  one cannot be added without the screen gaining a place to put it.
- **The evaluation is memoised per snapshot AND per allowed-scope list**, and the tab is the only
  dashboard render gated on being visible: a fleet-scale `evaluate` builds the port graph and every
  fleet-level join. Editing the scopes in Settings changes which neighbours are in the fleet at all, so a
  cached result from before the edit answers a different question and is discarded.
- **No allowed scopes is stated, not silently absorbed.** Without them `client-outside-scope` reports
  `option:allowedScopes` for every subject, and the summary says so rather than showing a zero.
- **The diagram is drawn on only for an unambiguous path**, and the hop TABLE is the report. The
  highlight is the red edges; the nodes are merely selected, which already means "this device's drawer is
  open". A hop whose devices are inside a collapsed cluster has no edge to colour, so the panel says how
  many of the hops were drawn rather than implying the picture is complete.
- **A path query refuses rather than guesses.** An `AMBIGUOUS` endpoint is an answer (§6.1) and is shown
  as one; a VLAN is taken from the resolved client's own sighting only when exactly one non-transit
  sighting agrees, and a typed tag always wins over an inferred one.

Per-hop and per-finding links go through `window.goToSearchResult(ip, 'tab-interfaces', snapshot, {port})`
— the same navigation the search results and the Fleet Health drill-downs use, so the drawer opens on the
right snapshot, the interfaces tab, and the right jack.

---

## 7. Failure modes

| # | Failure | Mitigation |
|---|---|---|
| F1 | Stale MAC table places an endpoint on the wrong switch (300 s default aging; the `Age` column reads `-` on ELS and is unparsed at `:621`) | Report snapshot age; treat multi-sighting as the moved-device signal; R3 |
| F2 | Devices scanned at different times under one `ScanTimestamp` | R12; show the spread. **Threshold: refuse `VERIFIED` when a path's hops span more than one MAC aging interval** — no coherent MAC-table story exists across it |
| F3 | Retry data desynchronised (`lib/FleetCrawl.ps1:358-363`) | R12 |
| F4 | Transiting devices unfindable — `:674` drops uplink MACs | R3 |
| F5 | Flattened `STP` used by mistake | §2.2 hard rule + regression test |
| F6 | Address-less **bridge** invisible | R5, capability-gated |
| F7 | Endpoint not found | Distinguish no-sighting / unscanned-device / ambiguous |
| F8 | Graph disconnected | The diagnosis itself, or a scan gap — check `ScanStatus` |
| F9 | STP not converged (`LRN`/`LST`) | Refuse `VERIFIED`. Also see G4 |
| F10 | Multiple surviving paths | Enumerate and report all (§6.2) |
| F11 | VLAN absent on an intermediate trunk | A **first-class diagnosis**, not a path failure |
| F12 | RSTP/MSTP, or **VSTP and RSTP on one device** | Per-VLAN scope lookup, not a device-level protocol guess |
| F13 | **A VLAN with no STP instance at all** | `NO_STP_INSTANCE` (§2.3) — the hop is unpruned |
| F14 | **A shared segment behind an unmanaged bridge** | No node exists for it; two `DESG FWD` ports must not be chained |

---

## 8. Testing

### 8.1 Fixture parity

`generate-fixture.mjs:298` (`accessRow`) emits **7** fields; the worker's interface initializer
(`lib/Get-JunosNodeData.ps1:384-404`) emits **30** — 26 plus `StpDetail`, `Bundle`, `BundleMembers`
and `Vlans`. *(Revision 1 said 26, having named three of the four missing ones two sentences
earlier.)*

Write a parity test locking `accessRow` to that initializer. **Do not copy the existing top-level
test's regex** (`fixture.test.mjs:169`) — it anchors on a `}` at column 0, and the interface
initializer's brace is indented 16 spaces, so it would match nothing and the
`assert.ok(expected.length > 10)` guard would fire.

Note the existing top-level parity test asserts **exact set equality in both directions**
(`fixture.test.mjs:167-176`), so the moment R3 adds `MacTable` to `$NodeData` the suite breaks until
`blankNode` matches. That is a virtue, but it means Phase 1 is **not** "thirteen edit sites sharing
one test pass": every site touching `$NodeData` or the interface initializer lands with its fixture
counterpart.

#### Built — 2026-09-13

Two tests at the end of `web-src/test/fixture.test.mjs`. The gap is **locked, not closed**:
`ACCESS_ROW_GAP` enumerates the 23 fields `accessRow` does not emit, and the assertion is exact set
equality against it, so the test fails in **both** directions — a new initializer field nobody
accounted for widens the list, filling one in narrows it, and either way that list is what gets
edited, deliberately. Both directions were verified by injecting each kind of drift.

Closing the gap now was deliberately declined: the fixture's values have to be meaningful
(consistent with link state, spread across the bands the sorts depend on), and 23 fields of
plausible-looking data invented before the initializer settles would bake in assumptions Phase 1 is
still moving.

Implementation notes worth keeping:

- The regex anchors the closing brace on **the opening line's own indentation via a backreference**,
  not on column zero — as this section warned.
- **Comment lines are stripped before key extraction.** The initializer's prose contains semicolons,
  and the key pattern treats `;` as a separator, so comments would contribute stray field names.
  This one is not obvious from reading the device-level test, whose initializer has no comments.
- The field set is compared across **every** generated row, not the first. `accessRow` branches on
  cage / PoE / live, and a field set that varies by branch is the same defect as one missing
  outright.

### 8.2 The fixture asserts an impossible topology

Worse than "no blocked uplinks": the generator creates real cycles — core ICL (`:477`), every zone's
first frame linked to both cores (`:501-502`), 8% access dual-homing (`:541-544`), daisy chains
(`:552-558`) — and `linkDevices` (`:381`) stamps `FWD` on every one. It claims a converged spanning
tree forwarding on a loop.

**Prerequisite: give the generator a real per-VLAN spanning-tree pass** — root election by the
`bridge-priority` it already writes (`:580`), BFS, `BLK` on non-tree ports — before fault injection
means anything. This is a larger job than revision 1 budgeted and belongs in the work order.

> **Done 2026-09-13 (work order item 7).** `computeSpanningTree` in `generate-fixture.mjs`, run per
> snapshot on the fleet **before** `withFailures`: **a scan failure is not a bridge failure.**
> `AuthFailed`, `Refused` and `Timeout` all describe our ssh attempt, and a switch we cannot log into is
> still running RSTP and still sending BPDUs. The first implementation excluded scan-failed devices from
> the bridge graph, which made their neighbours' ports read `Designated` and would have orphaned
> anything behind an unreachable distribution switch as an island root with no root port. A snapshot's
> shape for such a device is that its own end of the link is **unobservable** (`Interfaces: []`), not
> that the link is an endpoint. Root elected on `(bridge-priority, chassis MAC)`; least-cost tree by **Dijkstra, not BFS by
> hops** — with 1G and 10G uplinks mixed the two differ, and the cost charged is the receiving port's,
> as RSTP charges it. Per-link roles are Root/Designated on tree links and Designated/Alternate
> elsewhere, with `BLK` on the Alternate end. `StpDetail` is now emitted, so it left `ACCESS_ROW_GAP`
> (44 → 43 fields).
>
> **One deviation: a single RSTP instance, not per-VLAN.** The config text writes
> `set protocols rstp`, which is one instance, so the scope key is `"instance 0"` and nothing else.
> Faking `VLAN N` scopes on an RSTP config would assert a state no such switch can produce; a port that
> forwards in one VLAN and blocks in another needs VSTP config generation, which belongs with item 8.
>
> Two prerequisites fell out of it. Each device now has **one chassis MAC** rather than one per link —
> a real switch advertises the same chassis ID to every neighbour, and it is the tie-break the root
> election turns on. And `withFailures` hands the pass *clones*, which are what get serialized, so the
> identity fields it elects on are dropped after the tree is computed rather than being listed in
> `SCRATCH`.
>
> The tree invariant - forwarding edges = devices - 1, and connected - is asserted inside the generator
> beside `assertNothingOrphaned`, so every generated fixture passes through it rather than only the one
> the test suite builds.
>
> One test premise here was wrong on the first try and is worth recording: a dual-homed access switch
> can legitimately forward on two links — one up to the root, one down to a daisy-chained closet. The
> assertion is about its **upward** links: exactly one Root port, every other path to the root
> `Alternate` and blocked.

> **A second impossible topology, found 2026-09-14 by item 16.** The generator put every MAC in exactly
> one place: the access port its owner is plugged into. A switch learns every MAC it **forwards**, so a
> host three closets away is in every uplink table between it and here — the measured capture holds 1,030
> entries on one access switch, and §6.1's `TRANSIT_ONLY` exists because of it. The fixture asserted that
> a frame reaches its destination without any switch in between ever seeing it. `applyTransitLearning`
> now walks the forwarding tree out from each host and learns its MAC on the port facing back toward it,
> stopping wherever the VLAN stops and crossing only links **both** ends forward on. Fleet MAC rows go
> from 528 to 22,339 (a core holds 542, an access switch a handful) and the fixture from 11.9 to 15.5 MiB.
>
> It exposed a real defect in the graph, not only in the fixture. `transitPorts` was built from a device's
> **own** LLDP neighbours, so the silent end of a one-sided link — which has its own rule (§3.6) — read as
> an access port holding every MAC behind it: every client in that subtree reported duplicated, and the
> uplink reported as an unmanaged segment. A port the graph knows is an end of a switch-to-switch edge is
> now transit whichever end advertised it.

*(Revision 1 also complained that `:376` sets `RemotePort` to a real port name "where reality
supplies a MAC 38 times out of 43". Per §5.2 the fixture is **correct** — it only creates
switch-to-switch links, and reality supplies a real port name on 5 of 5 of those.)*

**Done 2026-09-13 (work order item 10, prerequisite).** VLAN membership, which the fixture never had:
every device carried `Vlans: []` while `SectionsCaptured` claimed the VLANS section arrived, so §6.2's
first filter read every port as carrying nothing. Two derivation rules, chosen so the result cannot be
accidentally faulty:

- **A trunk carries what is behind it.** Cores and frames carry the whole campus set; a closet carries
  its own draw, plus the voice VLAN unconditionally (`addClients` puts phones in it whether the draw
  picked it or not, and a phone in a VLAN its own switch does not configure is not a state to test on),
  plus everything the closets daisy-chained below it carry. A redundant leg learns the union of both
  ends before that propagation, so moving the tree onto it strands nothing.
- **A trunk's two ends take the intersection of what the two devices configure.** That is what makes
  F11 injectable rather than ambient: the two ends of a link cannot disagree unless something
  deliberately removes a tag, and the test asserts the clean fleet has no disagreement anywhere.

**One §8.2 divergence left standing deliberately.** A fixture device whose scan "failed" keeps its real
`Hostname` beside an empty `SectionsCaptured`, which is a shape the crawler never produces: a true
placeholder has `Hostname = "Unknown"` (`FleetCrawl.ps1`, `New-PlaceholderNodeLocal`), and a failure that
preserved data is a `$LastFailedNode` with real sections. The generator keeps the name on purpose — a
placeholder has no serial, so cross-snapshot identity in the inventory diff falls back to the hostname
(`generate-fixture.mjs:1066`). The consumer side is closed instead: nothing treats a node that captured
nothing as having spoken for itself, which is why the L2 graph's hostname confirmation tier now tests
`SectionsCaptured` rather than the name alone.

Membership is rebuilt per snapshot, after `computeSpanningTree`, because the `*` marking a member as
currently forwarding for a VLAN moves when the tree does. `Vlans` accordingly left `ACCESS_ROW_GAP`
(43 → 42 fields). Access-port membership is exactly the VLANs of the clients standing on the port, so
the MAC table and the membership are one fact told twice — the injectors that add a client add its
membership too.

**Four vocabularies corrected against the capture — 2026-09-13 (item 11).** Writing the L1 rules meant
reading what the switch actually prints, and the fixture was inventing four things. Each one is a rule
that would have passed here and misbehaved on hardware, which is what §8.2 exists to prevent:

- **Optics report no duplex, no autonegotiation and no remote fault.** Every fibre port in the capture
  omits `Link-mode`, `Auto-negotiation` and `Remote fault` from its link-level line and prints no
  autonegotiation stanza; the fixture filled all four on every port. Now null on fibre, and the trap test
  asserts it.
- **`Autonegotiation [not supported, disabled (0x0)]` is the field being unavailable**, not
  autonegotiation switched off — 27 of 43 blocks, every one a switch on an optical port. The fixture had
  been using that string for "disabled". The deliberate-off form is `[supported, disabled (0x1)]`, which
  the capture shows the same TLV family using on its `Aggregation Status` line.
- **The media is the transceiver's, not the cage's.** One uplink in five now carries a copper SFP, because
  with every trunk optical the three rules that compare a wire's two ends would have no subject at all at
  fixture scale — and the mismatch injectors could never place.
- **The PoE table prints `ON`/`OFF`, `2P/AT`, a bare class digit.** `PoE` is `"$oper ($consumption)"`
  built by the worker at `Get-JunosNodeData.ps1:559`, so the fixture's `Delivering (12.3W)` and
  `Class 3` were shapes no switch emits. The test now asserts the display string against the two fields
  it is built from rather than matching a prefix.

**A fifth, found the same way — 2026-09-14 (item 13).** The spanning-tree **Role** column prints Junos
abbreviations, not words: `DESG`, `ROOT`, `ALT`, `DIS` (113/12/3/25 in the capture). The fixture had been
emitting `Designated`/`Root`/`Alternate`/`Disabled`, so §6.3's both-ends-designated check
(`l2-path.js`) compared against strings the parser has never produced — **dead code on hardware since it
was written**, and a rule repeating the comparison would have been dead too. Two more facts came with it:

- **A down port prints `State BLK` with `Role DIS`** — the disabled *role*, blocking a port with no link
  behind it. The state column never carries `DIS`. The fixture had it the other way round, which also
  meant the F9 injector, drawing from "any port whose state is BLK", could land its learning port on a
  dark endpoint port that is no edge at all. It now draws from the alternate ports — the redundant links
  the tree actually blocked.
- **A port that goes down between snapshots has to lose its old role.** `computeSpanningTree` skipped any
  row that already carried detail, so a port taken down by `ageFleet` kept the `FWD DESG` it held while it
  was up. It now tracks what *this* pass assigned. 31 of 120 devices' rows were in that impossible state.

`BKUP` and `MSTR` roles, and the `LRN`/`LST` states in `NOT_FORWARDING`, are **unobserved** — the capture
holds a converged tree. They stay as written; see §3.5's provisional list.

### 8.3 Fault injection

- **Two injection sites, not one.** `assertNothingOrphaned` is at `:572` but `addClients` runs at
  `:576-584`, so client-array faults (duplicate MAC, duplicate IP, off-subnet client, dot1x held) are
  uninjectable at revision 1's stated site. Structural faults after `:572`, client faults after
  `:584`.
- **Inject inside the snapshot loop and emit a manifest per snapshot.** `ageFleet` (`:658-690`)
  mutates the same topology in place between writes — flipping links, retiring a device — and
  `withFailures` (`:697-718`) replaces `chronicallyFailing` devices with `blankNode`. A single
  manifest is wrong for snapshots 2..N, and a fault injected on a failing device exists in the
  manifest and nowhere in the JSON. Exclude `chronicallyFailing` from injection.
- **Use a separate seeded sub-PRNG** — but for the right reason. Revision 1 said reusing the main
  PRNG would break the byte-determinism asserted at `fixture.test.mjs:364`; it would not, because
  that test generates the same seed twice and compares. The real trap is that injection helpers must
  not call `pick`/`int`/`chance`/`shuffled`, which reach `rnd()` at `:32`.
- **The oracle is the manifest, not golden files** — golden output is invalidated by any generator
  edit.

**Done 2026-09-13 (work order item 8, injection half).** `--faults N` in `generate-fixture.mjs`, one
`FaultManifest_<stamp>.fixture.json` per snapshot, eight kinds at first (28 after item 11 — see below): `duplicate-mac` (F1),
`duplicate-ip`/`off-subnet-client`/`dot1x-held`/`autoneg-asymmetric` (F4), `stp-unconverged` (F9),
`unmanaged-bridge-shared-segment` (F14), `vlan-missing-from-trunk` (F11). Default is 0 — a fault nobody has a manifest for is worth
less than a clean fleet. Deviations from the plan above:

- **One injection site, not two.** Injection runs on the fleet `withFailures` has already cloned, where
  `Interfaces`, `Neighbors`, `Clients`, `ArpEntries` and `MacTable` all exist together, so both fault
  families are reachable from one place — which is what the two-site requirement was for. It also
  settles the other two problems directly: a placeholder is skipped by reading the `ScanStatus` already
  on the clone, and since the clone is discarded after the write, nothing leaks into the next snapshot.
- **The cost is that an injector owns the whole shape of its fault.** `stampCapture` has already
  derived `MacTable` and `LogicalUnits` by then, so an injected client carries its own MAC-table row.
  That is §8.2 applied to injection.
- **The sub-PRNG rule is a test, not a review note.** Untouched devices must be byte-identical between
  `--faults 0` and `--faults 30`; an injector that reached `rnd()` shifts the main stream and fails it.
  Verified by making one injector call `int()` and watching the test fail.
- **The manifest is not named `NetworkMap_*`.** Both loaders match `/^NetworkMap_.*\.json$/`, so a
  manifest named after its map would be offered to the operator as a snapshot to open.
- ~~**F11 (a VLAN missing from a trunk) has no injector.** `Vlans[]` is empty on every fixture device,
  so there is no membership to remove. It lands with the VLAN retention work.~~ **Landed 2026-09-13
  with item 10**, which is that work's consumer: `vlan-missing-from-trunk` removes one tag from one end
  of one otherwise healthy trunk, from the node's `Vlans[]` and the port row alike. It is an eighth
  kind, so `--faults 9` still wrapped the cycle. The test is the strongest oracle in this file: the clean
  fleet has **no** trunk whose two ends disagree, so every disagreement in the faulted fleet must be one
  the manifest names, and every named one must be present on the end the manifest names.
- **A fault kind §7 does not catalogue carries an empty `failureModes`**, not a label chosen to fill the
  field: the label is what item 11 maps a finding to, so a wrong one is a wrong oracle.
  `off-subnet-client`, `dot1x-held` and `autoneg-asymmetric` have none and say why at their injectors;
  `duplicate-ip` is F7 (ambiguous, not resolvable by picking one), not F4. A test reads the F-numbers
  out of §7 and rejects any label that is not there.
- **The manifest is written on every run**, `Faults: []` at `--faults 0`. A file that appeared only
  sometimes would leave a stale manifest from an earlier run describing faults the current one did not
  inject, and deleting it is not this tool's business.
- `stp-unconverged` only ever relabels an already-blocked port, so the forwarding subgraph the
  generator asserted is untouched; the test states that as an equality against the clean run rather
  than as `devices - 1`, because a placeholder device's links are unobservable in the written snapshot.

**Extended 2026-09-13 (work order item 11).** Twenty more kinds, one per L1 rule, so §3.5's table has an
oracle per row: `mtu-mismatch`, `duplex-mismatch`, `dot1x-auth-failed`, `dot1x-connecting`, and sixteen
`l1-*` port defects generated from a table by `injectPortDefect`. `--faults 30` against 28 kinds, so every
injector places once and the cycle still wraps. Four notes:

- **The delta is the oracle, in three directions.** The fleet is byte-identical between `--faults 0` and
  `--faults 30` apart from the faults, so `findings(30) − findings(0)` is exactly what the faults caused.
  Every `expected.finding` the manifest promised must appear in that set; every finding in it must sit at
  a device and port some manifest entry names; and **no finding may disappear**. The second direction
  catches a rule firing on collateral, and the third caught a real defect in `injectAutonegAsymmetric`,
  which asserted `Enabled` on the near end and so silenced an `autoneg-disabled` finding the clean fleet
  legitimately reported there. It now changes the far end only. Measured: 29 new findings, none lost.
- **An injector whose fault has a narrow home has to filter before it draws, not after.** Autoneg and
  duplex mismatches only exist on copper, which is 19 of this fleet's 136 links; picking a link blind and
  giving up placed the fault about one time in twelve, and a kind that usually fails to place is a kind
  whose manifest entry usually cannot be checked. `pickReciprocalLink` takes the predicate.
- **A fault's collateral is part of its location, not noise.** An asymmetric autoneg is visible from both
  ends, so the manifest records `params.peerIp`/`peerPort` and the oracle accepts findings there;
  a supplicant moved out of `Authenticated` takes `dot1x-unauthenticated-traffic` with it on the same
  port. What the oracle rejects is a finding somewhere else entirely.
- **A mutation has to move every mirror of the fact it changes.** What a device advertises over LLDP and
  what its own interface row says are one fact seen twice, so `injectAutonegAsymmetric` now writes the TLV
  *and* the row at both ends. It previously wrote only the TLVs, and in invented wording — a rule written
  against that string would have worked on fixtures and on nothing else.
- **A defect lands on a client port unless the rule needs otherwise**, because a defect on a trunk is read
  by the rule at the far end too; and `port-flapped-recently` refuses a device that booted within the
  hour, where the engine correctly suppresses and the manifest would be promising a finding that is right
  to be withheld.

### 8.4 Hand-built micro-topologies

A triangle with one leg blocked in VLAN 10 and forwarding in VLAN 20 (the F5 regression); a VLAN with
no STP instance (F13); two paths surviving pruning (F10 — the test BFS would fail); a two-member LAG
with and without a down member; a VC spanning FPCs; an unscanned waypoint; an address-less bridge; an
out-of-scope neighbour; a `Partial` node asserting `NOT_EVALUATED`, not clean.

**Done 2026-09-13 (work order item 8, micro-topology half).** All ten in
`web-src/tools/micro-topologies.mjs`, four devices or fewer each, no PRNG anywhere in the file — a
regression test needs a fixed input, and a test asserts two imports are byte-identical. Each is
asserted on its structural property, not on a rule verdict: the rule engine is item 11, and when it
arrives these are its inputs.

- **The VSTP cases are where the per-VLAN requirement lives**, as §8.2 decided. `setStp` writes the
  per-scope detail and the collapsed field together, and a test requires every instance of every VSTP
  topology to be a spanning tree in its own right — hand-authored per-VLAN state is easy to get subtly
  wrong, and the wrongness would surface later as a rule that looks broken.
- **The diamond gives three different wrong answers from one input**: two paths ignoring STP, one path
  per VLAN, and *none at all* pruning on the collapsed field, because both of the access switch's
  uplinks read `BLK` once collapsed. That is F5 and F10 in one topology.
- **Shape parity is checked against the worker's own initializers**, read out of
  `Get-JunosNodeData.ps1` at test time rather than restated in the test: every node and interface key a
  micro-topology uses must appear in `$NodeData = @{` or `$NodeData.Interfaces[$p] = @{`. Verified by
  adding a misspelled key and watching it fail.
- **`node web-src/tools/micro-topologies.mjs --out <dir>`** writes each one as a loadable
  `NetworkMap_micro_*.fixture.json`, so a case can be opened in the visualizer by hand.
- **The `Partial` node drops what the lost sections supplied**, the same rule `SECTION_SUPPLIES` applies
  in the generator: truncating at `STP` also empties `Neighbors`, `Clients`, `MacTable`, `ArpEntries`
  and `Vlans` and blanks `Uptime`, `LastConfigured*`, the RE counters and `Configuration`. Without that
  it asserted a state no switch produces — a guard-gated LLDP rule reading `NOT_EVALUATED` beside
  neighbours that are plainly there. The one-sided LLDP that remains (the healthy side still reports
  it) is what a session dying mid-capture actually leaves.
- **Only six cases carry a §7 label.** The LAG pair, the VC, the out-of-scope neighbour and the
  `Partial` node model shapes and guarantees §7 does not catalogue, and say so at their builders; a
  label invented to satisfy the test would mis-train item 11.

### 8.5 PowerShell tests

`Run-Tests.ps1` §12 style: synthetic text in, objects out. **No byte of the production capture enters
the repo.** Existing invariants to preserve: error counters keyed by label, never position; VLAN
member-line matching case-sensitive (`LOBBY`/`GENERAL`/`EMERGENCY` collide with `lo`/`ge`/`em` under
PowerShell's case-insensitive `-match`).

**§19, added 2026-09-14 with item 12: the provenance section.** 23 cases over the four Phase 3
commands, each sample carrying the URL it was derived from. These are the tree's record of what
Juniper's documentation says these commands print, and they exist to be *diffed against a real
capture* when one becomes available — a case failing there is the documentation being wrong about
hardware, which is a finding rather than a regression. Nothing in them came from a device.

### 8.6 Automation

No CI, no test script, both suites manual. A single runner is a cheap prerequisite — but it **must
record which host ran the PowerShell suite and mark a pwsh-only run as unverified**, because
`Run-Tests.ps1` targets Windows PowerShell 5.1 and a green run under pwsh 7 on Linux is not evidence
for it.

#### Built — 2026-09-13: `Run-AllTests.ps1`

Runs both suites, reports host / PowerShell version / edition, and marks anything that is not
Windows PowerShell 5.1 as **SECONDARY**.

The requirement understated the problem: **no single host can run everything.** The Windows test VM
has no Node, and Linux cannot be 5.1. A single per-run verdict would therefore always have been
partial, so each run appends one JSON line to `test-results/runs.jsonl` (gitignored) and the summary
reports coverage for the current commit across every host that has reported, as two independent
facts with the host and timestamp that produced each:

    Coverage for commit 33e805b, across all hosts that have reported:
      [ok] PowerShell verified on 5.1  (PNM-TEST, 5.1.17763.1, 2026-09-13T15:46:30Z)
      [ok] web-src suite passed        (alexander-laptop, 2026-09-13T15:46:01Z)

A dirty tree, or a commit that cannot be determined, is attributed to nothing. Hosts without git
take `-Commit`, recorded as *supplied* rather than verified. The ledger is JSON-per-line so entries
from different machines merge by concatenation; nothing reconciles them automatically.

The runner also **fails on a stale `lib/Network_Visualizer.html`** (the §9.3 hazard, which bit for
real while measuring §9.2 — a `dashboard.js` edit was invisible until a rebuild, so the JS suite had
been testing source that does not ship). `-AllowStaleBuild` overrides it.

One trap worth recording: capturing `Run-Tests.ps1` requires `*>&1`, not `2>&1`. It reports through
`Write-Host`, so an error-stream redirect captures nothing and a 184/184 run parses as zero tests.
The first version of the runner reported a failure on a passing suite for exactly that reason.

---

## 9. Constraints and risks

### 9.1 The write path is the size problem, and it is already shipped

> **This is the most urgent item in the document and revision 1 filed it as browser performance.**

`Write-TopologyOutputLocal` serializes the **whole** topology with `ConvertTo-Json -Depth 100`
(`lib/FleetCrawl.ps1:86`) on the init write (`:262`), **every periodic write** (`:489`), and the final
writes (`:514`, `:544`) — on the orchestrator's own poll loop. The backoff is `elapsed × 10` clamped
to a **120 s ceiling** (`:202`, `:495`), so it cannot back off further; the same loop checks the
145 s job-abandon timer (`:157`, `:317`), so a long serialize starves abandon checks and healthy
devices get abandoned. `lib/WebServer.ps1:757` already documents ~40 MB taking 5.1 minutes in this
runtime.

Current fixture: **4.4 MiB for 25,378 interfaces** across 350 devices. At the measured 2.5 KiB/port
the expanded parse takes that to ~63 MiB — a **14×** growth, not the 4.8× a single-switch
50 KiB→238 KiB figure implies. *(Superseded by the measurement below, which puts 16,800 interfaces
at 30.6 MiB compressed / 142.5 MiB pretty; scaled to 25,378 that is ~46 MiB and ~215 MiB. The
direction was right, the pretty-printer was the missing multiplier.)*

One in-tree claim did **not** reproduce: `WebServer.ps1:757` states "one `ConvertTo-Json` over a
~40MB archive takes 5.1 minutes, on this thread." A `ConvertTo-Json -Depth 100` producing 142.5 MiB
measured **1.4 s** here. The comment's workaround — listing names and sizes only — is still right
for its own reasons, but the figure behind it is unexplained and should not be cited as a
constraint until someone reproduces it.

#### Measured — 2026-09-13, and the conclusion changed

Measured on a Server 2019 Core VM, **Windows PowerShell 5.1.17763.1 / .NET 4.7.2**, 4 vCPU
host-passthrough, 4 GB RAM. Synthetic 350-device × 48-port topology built from the same object
types production uses (`Hashtable` node, `Object[]` of `PSCustomObject` interfaces, nested
hashtables for `StpDetail` / `InputErrors` / `OutputErrors` / `Vlans`) and calibrated against a real
scanned node to within 0.5%: **1390 B/port** compressed, 132.1 KiB/node vs the real 132.7 KiB.
Three timed runs per case after a discarded warmup, `[GC]::Collect()` between.

The heading is right that the write path is the problem. It is wrong about which part of it.

**1. The encrypted write path did not complete at all — it threw.**

    Array dimensions exceeded supported range
      at Protect-TopologyPayload, lib/TopologyCrypto.ps1:61

`Protect-` and `Unprotect-TopologyPayload` hashed over `($IvBytes + $CipherBytes)`. PowerShell's
`+` on a `byte[]` does not concatenate buffers — it builds an `Object[]` and boxes every byte,
roughly 32 bytes of allocation per ciphertext byte. At fleet size that exceeds the 2 GB
single-object limit and the crawl cannot write an encrypted snapshot at any speed. Fixed by
feeding the HMAC two blocks; the bytes hashed are unchanged, so `topology-crypto.js` stays in
lockstep. **This was shipped, and no existing test reached a payload large enough to see it.**

**2. Once it completes, time is not the problem — memory and file size are.**

Per-stage, config excluded, three runs:

| stage | pretty (shipped) | `-Compress` |
|---|---|---|
| `ConvertTo-Json -Depth 100` | 1350–1435 ms | 1228–1312 ms |
| `Protect-TopologyPayload` | 1212–1215 ms | ~420 ms |
| envelope `ConvertTo-Json -Depth 5` | 1596–1996 ms | ~520 ms |
| `Out-File` + `Move-FileAtomic` | 231–1190 ms | ~200 ms |
| **total, encrypted branch** | **4701–5526 ms** | **2347 ms** |
| **total, plaintext branch** | **1634–2161 ms** | **1632 ms** |
| snapshot JSON | 142.5 MiB | 30.6 MiB |
| encrypted envelope on disk | 190.0 MiB | 40.8 MiB |
| **process peak working set** | **3.27–3.58 GB** | **1.80–1.93 GB** |

At ~5.5 s the write is **~4% of a device's 145 s abandon budget** — the starvation risk in the
paragraph above is real but small, and the `elapsed × 10` backoff never reaches its 120 s ceiling.
*Time was never the binding constraint.*

#### Peak working set is elastic; the live set is the requirement

The peak figures above are **not** a memory requirement, and reading them as one was the second
mistake in this section. .NET's workstation GC defers gen2 collections while there is headroom, so
the same workload peaks higher on a bigger machine. Re-running on an 8 GB guest:

| | 4 GB guest | 8 GB guest |
|---|---|---|
| pretty, peak WS | 3.27–3.58 GB | **3.48–4.35 GB** |
| `-Compress`, peak WS | 1.80–1.93 GB | 0.85–1.88 GB |

The 4 GB numbers were being *pressured down*, not measured. What must actually fit is the live set
after a forced full collect — measured in a **fresh process per case**, reproducible to the MiB
(216 / 244 / 216 MiB across three runs):

| 350 devices × 48 ports, `-Compress` | config 0 | config 40 KiB/device |
|---|---|---|
| topology object graph, live | **216 MiB** | **244 MiB** |
| live set after a write (graph + retained envelope) | 506 MiB | 634 MiB |
| process peak WS, same run | 849–850 MiB | 1055 MiB |

The +28 MiB for configuration is exactly 350 × 40 KiB × 2 bytes of UTF-16 — the model accounts for
itself. *(An earlier pass reported a 442 MiB graph. That was measurement-order contamination: cases
sharing one process, and one config string shared across all 350 nodes. Both are fixed in
`tools/Measure-WritePath.ps1` — it now gives each device its own config text, and each case must be
run in its own process.)*

#### Budget against the production host — 16 GB

| component | | basis |
|---|---|---|
| topology object graph (resident for the crawl) | 244 MiB | measured |
| write transients (UTF-16 string, UTF-8 bytes, ciphertext, base64, envelope) | ~390 MiB | measured as the 634 − 244 MiB delta |
| 25 concurrent runspaces × raw capture + redacted copy | ~50 MiB | **estimated**, not benchmarked |
| PowerShell + web server baseline | ~200 MiB | measured |
| **total live** | **≈ 0.9 GB** | **≈ 6% of 16 GB** |

**Per-device streaming is not needed and is off the work order.** `-Compress` is sufficient with an
order of magnitude to spare. Peak WS will float well above the live set on a 16 GB box — that is
the GC using memory it has, not a shortage — and it is bounded by the `[GC]::Collect()` already at
`FleetCrawl.ps1:507` after each periodic write.

**The precondition is being 64-bit.** A 32-bit PowerShell host caps the process at 2–4 GB of
address space no matter how much RAM the machine has, which a ~250 MiB resident graph plus write
transients plus an elastic GC will eventually exhaust — as an `OutOfMemoryException` hours into a
crawl, with the crawl lost. `Start-NetworkMapper.ps1` now refuses to start under a 32-bit host
(verified against the real `SysWOW64` shell on the 5.1 VM), and the CLI path no longer captures
the crawl's return value, which had pinned the whole graph for the blocking web server's lifetime.

**Candidate, not shipped:** `GCSettings.LargeObjectHeapCompactionMode = 'CompactOnce'` before that
`[GC]::Collect()`. Every string in the write path is a large-object allocation and .NET 4.7.2 does
not compact the LOH by default, so fragmentation could creep over a long crawl of repeated writes.
Unmeasured, and at 16 GB probably irrelevant — it needs a "20 periodic writes in a loop, working
set after each" mode in the benchmark before it earns a line of code.

**`-Depth 100` pretty-printing costs 4.66× on 5.1** — far worse than the 1.79× the same topology
shows under pwsh 7, so this could not have been inferred off-target. Switching the crawl to
`-Compress` (`lib/FleetCrawl.ps1`) halves peak memory, more than halves the encrypted write, and
cuts the retained snapshots the browser eager-loads (§9.2) by 4.66× — **20 × 190 MiB ≈ 3.8 GB on
disk becomes ≈ 860 MB**. Nothing reads a snapshot by lines (the server sends the file verbatim as
bytes, `WebServer.ps1:795`) and `Configuration` is a JSON string with escaped newlines either way,
so indentation never aided manual review.

**Storing the configuration is affordable.** At 40 KiB/device it adds 13.7 MiB to the compressed
payload (30.6 → 44.3 MiB); at 120 KiB/device, 43 MiB. It is the largest single lever after
`-Compress` but it does not dominate, and §4.4's decision — collect and store, never parse — costs
nothing the crawl cannot afford.

**The read path is not a problem.** Nothing in the crawl or the server parses a snapshot: the
server streams bytes, and the only PowerShell `ConvertFrom-Json` over a snapshot is
`lib/Protect-MapperFile.ps1:90`, a user-invoked tool that parses the whole file solely to read
`.format` for its double-encryption guard. Measured on 5.1: **6.6 s at 156 MiB, 5.9 s at 44 MiB**.
Worth narrowing to a prefix check eventually; not a crawl blocker, so not filed as work.

**16 GB host RAM does nothing for §9.2.** A browser tab's JS heap is capped independently of
machine memory (~4 GB on 64-bit Chrome), so eager-loading 20 snapshots stays the next blocker even
though `-Compress` cut them from 190 MiB to 41 MiB each.

**Still unmeasured:** `Update-ClientIpCorrelationLocal` runs inside the same blocking write and was
not isolated (it is a nested local function). The 25-runspace figure in the budget is an estimate
from raw-capture size, not a benchmark — faking SSH state was judged not worth the fidelity it
would buy.

### 9.2 The browser load path is the other half, and it is also already shipped

`autoloadLastScan` (`web-src/app.js:354-414`, on `DOMContentLoaded` at `:421`) fetches **every**
snapshot the server lists — capped at 20 by `WebServer.ps1:751` — accumulating raw text in
`entries[]` (`:380`) with all of them live at once, then retains every parsed topology in
`loadedSnapshots` (`:502`) and builds a fleet-wide `searchIndex` over all of them. Several
representations of each snapshot are alive simultaneously (raw text → `File` → `FileReader` result →
base64 ciphertext → binary string → `Uint8Array` → plaintext → parsed object), and `:396-403`
decrypts the first snapshot **twice**, running 600,000-iteration PBKDF2 twice.

#### Measured — 2026-09-13. The retention premise was wrong; the transient was the problem.

Measured against the built `lib/Network_Visualizer.html` in headless Chromium 150, driven over CDP,
with 20 synthetic 350-device x 48-port snapshots at the current field density (44.0 MiB plaintext /
58.6 MiB enveloped each, matching the PowerShell-side figures to within 1%) served by a stand-in for
`/api/snapshots`, `/api/snapshot` and `/api/session-password`.

**Retained heap is not a problem.** All 20 snapshots load, and after a forced GC the V8 heap holds
**725 MiB** — nowhere near a tab's limit. Attributed by dropping one section at a time with a
collection between:

| section (20 snapshots, 7,000 device-records, 336,000 interfaces) | MiB |
|---|---|
| `Configuration` | 274 |
| `Interfaces` | 224 |
| `Vlans` + `MedNeighbors` + `Neighbors` + `ArpEntries` + `StackMembers` | 162 |
| `Clients` + `TrueClients` | 39 |
| `searchIndex` (560,000 entries) | 20 |
| **total** | **725** |

So **bounding the autoload to the most recent snapshot is not needed and is dropped.** That would
have cost the snapshot switcher, cross-snapshot search, the config/topology diffs and the
reliability heatmap — `dashboard.js` reads `d.Configuration` per device per snapshot for the config
history — to save memory that was never scarce. The `Vlans` line is the one surprise worth
remembering: 162 MiB in the *small* collections, dominated by ~4.8 million short member-port strings.

**The real cost was invisible to heap accounting.** `Runtime.getHeapUsage` sees only the V8 heap;
fetch bodies, `Blob`/`File` backing stores and external strings sit outside it. Sampling the
renderer process tree's RSS instead:

| | before | after |
|---|---|---|
| plaintext, peak RSS during autoload | **3,499 MiB** | **1,948 MiB** |
| enveloped, peak RSS during autoload | 3,058 MiB | 3,038 MiB |
| settled RSS once loaded (either) | ~720 MiB | ~720 MiB |

`autoloadLastScan` fetched all 20 bodies into `entries[]`, wrapped each in a `File`, and
`processSelectedFiles` read them straight back out with a `FileReader` — every snapshot held three
times over, for a peak 4.8x the 725 MiB actually retained. It now passes **lazy `{name, fetchText}`
sources** through the same loader, so one body is fetched, parsed and released before the next is
requested. The `File`/`FileReader` wrapper stays for the manual Load / Load Folder paths.

Also landed: the pre-flight probe that decrypted the first snapshot a second time is gone (the first
real parse is the probe, with a `noPrompt` batch flag so startup never raises a password dialog),
and `deriveKeyMaterial` caches on password+salt+iterations, so an archive written by one crawl
session costs **one** 600,000-iteration PBKDF2 instead of twenty.

**Not fixed, and honestly reported:** the enveloped path still peaks near 3 GB. Removing
`concatBytes(iv, cipher)` — a full second copy of the ciphertext built only to feed the HMAC, the
same mistake §9.1 found in `lib/TopologyCrypto.ps1` — was kept because it is strictly less
allocation, but it **did not measurably move the peak** (3,058 -> 3,038 MiB). The peak is set by how
far GC falls behind across each snapshot's envelope text, its base64 `ciphertext` string, `atob`'s
binary string and the decoded buffer, not by any single copy. Bringing it down needs a streaming
base64 decode, which is a separate piece of work and is not required by any measurement here.

### 9.3 The build hazard

`Start-NetworkMapper.ps1:23-27` and `WebServer.ps1:1146-1149` make the built
`lib/Network_Visualizer.html` (2.35 MB, committed) win outright — `web-src/` is never served.
Editing `web-src/*.js` has **no runtime effect** until `build-inline.mjs` re-runs, with no error.
Add a check that fails when any `web-src/*.js` is newer than the artifact; ten lines.
**Done 2026-09-13** — it lives in `Run-AllTests.ps1` (§8.6), which aborts on a stale artifact unless
`-AllowStaleBuild` is passed. It caught a real instance during the §9.2 work.

### 9.4 Server-side and FIPS

Every new route needs its **own** `Test-SameOriginRequest` gate — 14 hand-written instances, no
middleware — and the accept loop is single-threaded.

**FIPS is enforced by a regression test with a scope gap.** `Run-Tests.ps1:640-641` asserts no
`System.Security.Cryptography` type appears in `$JunosNodeDataSrc`, which is
`Get-JunosNodeData.ps1` **alone**. The worker dot-sources `SshHelpers.ps1` and `JunosParsers.ps1`
(`:22-23`) and neither is scanned — a hash added to the parsers would pass. Widen the test. Any
fingerprint in the worker uses the FNV-1a at `lib/Get-JunosNodeData.ps1:63-68`.

PowerShell 5.1 traps documented in-tree: no `-AsHashtable` (`WebServer.ps1:707`), no
`Kill(entireProcessTree)` (`Get-JunosNodeData.ps1:108`), `Out-File` defaults to UTF-16LE
(`FleetCrawl.ps1:80`), `Get-Content` ANSI fallback on BOM-less UTF-8.

### 9.5 Additive-only invariant

The expanded parse was additive and this must stay true. C1 and C4 change *values* and need migration
notes. R1 is filed as retention but was, in revision 1's form, a redefinition — hence the
`LogicalUnits[]` correction.

---

## 10. Work order

1. ~~**Measure the crawl write path** (§9.1) on 5.1. Fix it if slow.~~ **Done 2026-09-13.** It did
   not merely run slowly — the encrypted branch threw. Fixed the byte-array boxing in
   `TopologyCrypto.ps1`, switched the crawl to `ConvertTo-Json -Compress`, added a 64-bit host guard,
   and stopped the CLI pinning the topology behind the blocking web server. Against the production
   host's **16 GB**: live set ≈ 0.9 GB, ~6%. Encrypted write 4.7–9.5 s → 2.2–2.7 s; snapshots
   190 MiB → 41 MiB. **Per-device streaming is not needed — dropped.**
2. ~~**Bound the browser autoload** (§9.2).~~ **Done 2026-09-13**, though not as written: measurement
   showed 20 snapshots retain only 725 MiB, so nothing was bounded and no feature was given up. The
   autoload now streams lazily instead of triple-buffering every body (peak RSS 3,499 -> 1,948 MiB
   plaintext), decrypts the first snapshot once instead of twice, and derives the PBKDF2 key once per
   archive instead of once per snapshot. The enveloped path still peaks near 3 GB - see §9.2.
3. ~~**Test runner with host recording** (§8.6).~~ **Done 2026-09-13** — `Run-AllTests.ps1`. Records
   host and edition, marks non-5.1 runs SECONDARY, and because no single host runs both suites,
   keeps a per-commit ledger that reports 5.1 verification and web-src separately. Also fails on a
   stale build artifact (§9.3).
4. ~~**Parity-test mechanism** (§8.1) — ship the mechanism first; it will start failing usefully. Fill
   in `accessRow`'s values **after** Phase 1 settles the initializer, not before.~~ **Done
   2026-09-13.** Mechanism shipped with the 23-field gap enumerated in `ACCESS_ROW_GAP`; it fails on
   drift in either direction. `accessRow`'s values stay unfilled, as directed — Phase 1 (item 5)
   narrows the list one field at a time.
5. ~~**Phase 1 retention R1–R15** (§4.1), each landing with its fixture counterpart.~~ **Done
   2026-09-13.** All fifteen landed. Three shapes came out differently from revision 1's proposal and
   are noted at their rows: R1 is node-level with a per-row view, R5 gates on a positive Bridge/Router
   capability rather than on a missing address, and R3 keeps the raw flag character rather than the
   collapsed `"Static/Other"`. The crawl enqueue loop gained a skip for both an `"Unknown"` management
   address and `Reachable = $false`, since it walks `Neighbors[]` to decide what to scan next and R5
   puts entries there that are not addresses.
6. ~~**Phase 2 correctness C1–C6** (§4.2).~~ **Done 2026-09-13.** Migration notes for C1 and C4 are
   with the table in §4.2.
7. ~~**Generator spanning-tree pass** (§8.2) — the blocker for everything path-related.~~ **Done
   2026-09-13.** Single RSTP instance, matching the config text; see §8.2 for why not per-VLAN.
8. ~~**Fault injection + per-snapshot manifests** (§8.3), micro-topologies (§8.4).~~ **Done
   2026-09-13.** Seven fault kinds behind `--faults N` with a manifest per snapshot, and ten
   hand-built micro-topologies. Both halves came out differently from revision 2's proposal and are
   noted at §8.3 and §8.4: injection runs on the cloned fleet (one site, not two), and the F11
   injector is deferred until `Vlans[]` carries trunk membership.
9. ~~**Topology graph + endpoint resolution** (§5, §6.1).~~ **Done 2026-09-13.** `web-src/l2-graph.js`
   and `web-src/endpoint-resolution.js`, with the twelve micro-topologies as acceptance tests and the
   item-8 manifests as the fixture-scale oracle. Both halves deviated from revision 2 and are noted at
   §5 and §6.1: chassis-ID confirmation became third-party consensus because no node field carries a
   device's own chassis MAC, and a port-label search had to become a lower tier than the exact
   identifiers.
10. ~~**Path computation** (§6.2) with the F5 and F10 regression tests.~~ **Done 2026-09-13.**
    `web-src/l2-path.js`. Two prerequisites landed with it and are noted at §8.2 and §8.3: the fixture
    had no VLAN membership at all, which made §6.2's first filter vacuous, and the F11 injector item 8
    deferred now exists. F2's threshold is reported rather than applied — measured, see §6.2.
11. ~~**Rule framework** (§3) and the L1 rules — the best-supported layer.~~ **Done 2026-09-13.**
    `web-src/rules.js`: the engine, 23 L1 rules, one fault injector per rule and the delta oracle. See
    §3.5 for the catalogue and the five deviations, §8.3 for the injectors. Two deviations matter beyond
    this item: there was no rule catalogue in the tree to build from, so §3.5's table is now it and
    Appendix A's L1 column is superseded; and `lag-member-down` has no fixture injector, because the
    fixture holds no aggregate at all and one invented inside `injectFaults` would put ordinary topology
    behind a fault manifest.
12. ~~**Phase 3 command changes** (§4.3): verify the two upgrades on real hardware, then land the three
    in-place replacements and `show spanning-tree bridge`, measuring session time against the 120 s
    cap each time.~~ **Landed 2026-09-14 from published output; UNVERIFIED on hardware.** Blocked
    2026-09-13 for want of a switch, then re-scoped on direction: make the best-supported guess from
    Juniper's documentation and published lab captures rather than leave the item stalled. All four
    command changes, their parsers, their fixture counterparts and 23 PowerShell cases are in — see
    §4.3.1 for what the documentation settled (the ELS stanza *does* carry `Routing instance:`, the
    two extensive layouts, the ARP column order, the bridge-view headings) and for the two things that
    stay unmeasured: the 120 s session cap with four changed commands, and whether a given release
    reflows these stanzas. The parsers read by label rather than by column for that reason. §3.5's two
    open questions are answered with it: `poe-denied`'s vocabulary is narrowed to the documented
    `FAULT`, and R15's third state is now structural (`SectionsAttempted` / `SectionErrors`) rather
    than dependent on a string nobody has seen. **What is still owed is a hardware capture of the four
    commands, diffed against the samples in `Run-Tests.ps1` §19.**
13. ~~**L2 and L3 rules** gated on the commands they need.~~ **Done 2026-09-14.** Sixteen rules — eleven
    L2, five L3 — on the item-11 engine, one injector each, the delta oracle extended to all three
    layers. See §3.6 for the catalogue and for what stayed out: every command-dependent rule (G4
    included) waits on item 12, and G3 turned out not to be a rule at all. G2 is closed. Appendix A's L2
    and L3 rows are superseded the way item 11 superseded the L1 row.
14. ~~**UI**: analysis sub-tab, path highlighting, per-hop drawer links.~~ **Done 2026-09-14.**
    `web-src/diagnostics.js` plus the `Diagnostics` analysis sub-tab: the findings grouped by severity and
    rule, the §2.4 `missing` histogram beside them, and a path tracer that resolves both ends (§6.1) and
    passes the resolved PORTS into `computePath` — which is the functional half, recorded at §6.2. §6.4's
    gateway report lands with it, which closes G3's placed half. See §6.6 for what the screen does and the
    three decisions that are easy to undo by accident.
15. ~~**The rules item 12 unblocked**: G4's topology-change rule, G5's native-VLAN comparison, a dot1x
    fallback-VLAN rule, and `SectionErrors` in the §2.4 histogram.~~ **Done 2026-09-14.** See §3.7 for the
    catalogue and for the two decisions that are easy to undo by accident: `TopologyChangeCount` is
    retained and not read, and the refusal annotation is presentation only. G4 and G5 close with it.
    Every field these rules read is **unverified on hardware** — item 12's hardware capture is still owed,
    and it is what would confirm them.
16. ~~**G1 — per-hop MAC learning as path verification** (§6, Appendix B). §6 computes a path and never
    *checks* it.~~ **Done 2026-09-14.** `macEvidence` on every hop, both directions, four states, reported
    beside the confidence rather than folded into it — see §6.2 for the four decisions and §8.2 for the
    fixture change it needed first. One micro-topology (`mac-path-verification`) and one injector
    (`mac-learned-off-path`, the only fault kind that promises no finding, because G1 is path verification
    and not a rule).
*(There is no config-parsing step. See §4.4 — the configuration is collected and stored for backup
and manual review, and stays out of the rule engine.)*

---

## Appendix A — rule counts

From the six-way audit, before deduplication across layers. Treat as an order-of-magnitude estimate,
not a plan: §3.1 scopes the build to the "supported today" column.

| Layer | Rules | Supported today | Blocked on retention | Blocked on a command | Not attempted (config-only) | Undetectable passively |
|---|---|---|---|---|---|---|
| L1 / link | 45 | 14 (+6 needing a delta) — **built: 23**, see §3.5 | 17 | 8 | — | — |
| L2 switching | 33 | 15 — **built: 11**, see §3.6 | 11 | 7 | — | — |
| L3 / policy | 39 | 9 — **built: 5**, see §3.6 | 8 | 11 | 5 | 6 |
| **Total** | **117** | **~44** | **~36** | **~26** | **5** | **6** |

The shape is the finding: the largest category is data the tool already collects and discards.

**Superseded for L1, 2026-09-13.** These counts come from an audit that is not in this tree, and nothing
in the repo enumerates the rules behind them. §3.5's table is the L1 catalogue and it holds 23 rules
rather than 14 — mostly because R10's four link-level error fields and R6's three dot1x states are each
several rules rather than one. Treat the L2 and L3 rows the same way when item 13 reaches them: the
column is an order of magnitude, not a list.

**Superseded for L2 and L3, 2026-09-14.** §3.6 is the catalogue for both. It holds fewer rules than the
"supported today" column rather than more — 11 against 15, and 5 against 9 — because several of the
audit's counts are one rule per field where the data supports one rule per comparison, and because item
12 being blocked keeps every command-dependent rule out. The named gaps are in §3.6, not in this table.

The "not attempted" column is the §4.4 decision — those 5 rules are out of scope, not pending. The
buildable target is therefore **~106 of 117**, and §3.1 scopes the *first* build to the ~44 supported
by today's data.

---

## Appendix B — gaps identified in review, not yet placed

| # | Gap |
|---|---|
| ~~G1~~ | ~~**MAC learning as per-hop path verification.** The spec computes a path and never *checks* it. At each hop, the destination's MAC should be learned on the port facing the next hop — direct forwarding-plane evidence, far stronger than "both ends report FWD". The data exists (1030 entries in the capture) and `:674` discards exactly the transit sightings needed. R3 retains them; nothing in §6 uses them. **The largest missed opportunity in the document.**~~ **Closed 2026-09-14 (item 16):** `macEvidence` per hop, in both directions, four states — see §6.2. Closing it needed §8.2's other half first: the fixture put every MAC only on the access port its owner was plugged into, so there was no transit evidence anywhere to read |
| ~~G2~~ | ~~**Per-VLAN STP scope drift between neighbours.** A link where one end runs an instance for VLAN *T* and the other does not. Detectable today by comparing each end's `StpDetail` scope set against its `Vlans` membership. §6.3 only compares states within a scope both ends have. With 4 of 17 VLANs instance-less on one device, not hypothetical~~ **Closed 2026-09-14 (item 13):** `stp-scope-drift` (§3.6) is the comparison, with an injector that plants it on an already-blocked link so the forwarding tree is untouched |
| ~~G3~~ | ~~**VRRP is partly detectable** and §6.3 says it is not. The `00:00:5e:00:01:xx` virtual-MAC prefix appears in the capture's MAC table and identifies both VRRP presence and the VRID. It gives no master/backup, but "this VLAN's gateway is a VIP, so the L3 hop is one of N routers" beats §6.4's single pick. **Placed 2026-09-14 (item 13):** not a rule — a VIP on a trunk is how VRRP is meant to look — so the detection ships as `vridOf` for §6.4 to report with its gateway pick, and `duplicate-mac-across-devices` skips those MACs.~~ **Closed 2026-09-14 (item 14):** `gatewayCandidates` reports every VIP and its VRID beside its candidates, filtered by the path's VLAN — see §6.4 |
| ~~G4~~ | ~~**Topology-change churn, not root ID.** `show spanning-tree bridge` also carries topology-change count and time since last change per scope. For "why is this broken *now*", a VLAN that reconverged 40 seconds ago explains more than which bridge is root. ~~Needs the §4.3 command, so it queues behind item 12~~ **The command landed 2026-09-14 (§4.3.1)**: `StpBridge[].TopologyChangeCount` and `.TimeSinceLastChangeSeconds` are retained and in the fixture, per scope, joinable to `StpDetail` by scope string.~~ **Closed 2026-09-14 (item 15):** `stp-topology-change-recent` (§3.7) reads the AGE, per scope, and joins the ports on; the count stays unread and says why |
| ~~G5~~ | ~~**MTU and native-VLAN mismatch rules are injected as test faults (§8.3) but described nowhere.** R2 retains the LLDP `Maximum Frame Size` TLV without saying what compares it to the local MTU~~ **Closed 2026-09-13 (item 11)** for the MTU half: `mtu-mismatch` (§3.5) is the comparison, with an injector of its own. ~~The native-VLAN half stays open and is blocked on retention rather than undescribed — the snapshot carries no native-VLAN field at all~~ **Unblocked 2026-09-14 (item 12):** `show vlans extensive` annotates each member `tagged`/`untagged` with its port mode, so an untagged member of a tagged VLAN on a trunk IS the native VLAN. `Vlans[].Interfaces[].Tagged`/`.Mode` are retained and in the fixture, where every trunk carries exactly one untagged VLAN so the two ends agree by construction and a mismatch can only be injected deliberately.~~ **Closed 2026-09-14 (item 15):** `native-vlan-mismatch` (§3.7) is the comparison |

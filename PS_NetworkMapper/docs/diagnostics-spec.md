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

---

## 4. Data model changes

### 4.1 Phase 1 — retention (no new commands)

Data already in the collected payload and discarded by the parser. The largest category of blocked
rules and the cheapest to fix.

| # | Change | Site | Unlocks |
|---|---|---|---|
| R1 | Parse logical units — `irb\|vlan\|lo0\|me\|vme\|fxp\|em\|vcp` — with their address and family, into a **new `LogicalUnits[]` array on each physical interface row** | `lib/Get-JunosNodeData.ps1:378-407` | ~10 L3 rules, VC interconnect health. **Corrected from revision 1**, which proposed re-keying `Interfaces` by unit: that redefines the array's member identity, which `window.normalizePort` joins depend on at `utils.js:199,273` and `drawer.js:667`, and violates §9.5 |
| R2 | Parse LLDP `Organization Info` stanzas: 802.3 `MAC/PHY Configuration/Status`, `Maximum Frame Size`, `MDI Power`, `Link Aggregation` | `lib/Get-JunosNodeData.ps1:517-552` | Far-end autoneg, MTU and PoE negotiation **without scanning the peer**. 27 of 43 blocks advertise autoneg disabled |
| R2b | Parse LLDP `Age`, `Time mark`, `Ageout Count` per local interface | same | Per-port last-seen — see `port-last-used-spec.md` §1.3 |
| R3 | Retain every MAC-table row in `Node.MacTable` (MAC, port, VLAN, **raw flag char**, age) alongside the de-duplicated `Clients` | `lib/Get-JunosNodeData.ps1:616-649` | Duplicate-MAC and sticky-MAC detection, **transit sightings (G1)**. `$RawMacs` is keyed by MAC last-wins and `:645` collapses the flag to `"Static/Other"` |
| R4 | `ConvertFrom-JunosMacStatistics` for the fixed-width `MAC statistics:` table; likewise `PCS statistics` and `Ethernet FEC statistics` | `lib/JunosParsers.ps1` | `CRC/Align errors`, `Jabber`, `Fragment frames`, `Code violations`. One port in the capture carries **51 CRC/Align errors — the only non-zero CRC value present — and the snapshot cannot see it**, because `ConvertFrom-JunosErrorCounters` correctly terminates at the first non-counter line, which is `Egress queues:` |
| R5 | Record LLDP neighbours that advertise **`Bridge` or `Router` capability** but no management address, with `Reachable = $false` | `lib/Get-JunosNodeData.ps1:541-548` | **Corrected from revision 1**, which gated on the *absence of an address*. All 11 address-less blocks in the capture are endpoints — 10 workstations (`Class I Device`, chassis ID a hostname string under `Locally assigned`) and 1 telephone. Zero are bridges. Gating on absence would inject ~11 phantom "unreachable switch" nodes per access switch |
| R6 | Per-port dot1x state keyed by **interface** | `lib/Get-JunosNodeData.ps1:509-513` | The captured interface is discarded and `Initialize` rows carry no MAC, so 25 rows are dropped. **No per-port dot1x state exists in the snapshot today** |
| R7 | PoE: keep `Admin status`, `Max power`, `Priority`, `Pair/Mode` | `lib/Get-JunosNodeData.ps1:502-504` | `Admin status` is captured into `$Matches.status` and dropped, so "PoE admin-disabled" and "no PD connected" both read `OFF` |
| R8 | Parse `show chassis hardware` into `FPC → PIC → Xcvr` | `lib/Get-JunosNodeData.ps1:340-345` | Absence of an `Xcvr` row is the only reliable "nothing plugged in" discriminator for a fibre port |
| R9 | Route regex: capture egress interface, protocol tag, table name; distinct `"Unparsed"` sentinel | `lib/Get-JunosNodeData.ps1:348` | `Gateway = "Unknown"` currently conflates *no default route* with *a shape the regex misses* |
| R10 | From extensive: `Statistics last cleared`, `Input/Output packets`, `Remote fault` (field-line scoped), `Interface flags`, `Device flags`, **and `BPDU Error` / `Loop Detect PDU Error` / `Ethernet-Switching Error` / `MAC-REWRITE Error`** | `lib/JunosParsers.ps1:262-299` | Exact counter baselines; error ratios; one-way-link detection. The four error fields print on **every** port's Link-level line and none is parsed — they partly supply the "blocking reason" §4.3 was going to spend a command on |
| R11 | VC member `Status` column and `Neighbor List` continuation rows | `lib/Get-JunosNodeData.ps1:314-335` | A stack member that dropped out is invisible |
| R12 | Per-device capture timestamp | `:194-210`, `lib/FleetCrawl.ps1:111-122` | One `ScanTimestamp` covers a crawl spanning many minutes |
| R13 | LLDP-MED `Model name`, `Manufacturer`, `Serial number`, revisions | `:517-552` | Present on 25 of 43 blocks; phone/AP model is currently unknowable |
| **R15** | **`SectionsCaptured[]` from `$DataDict`** | `lib/Get-JunosNodeData.ps1:264-292` | §2.4. The only truncation signal that survives §4.3 |

**R14 (comments, not behaviour).** Document at the field that `Vlans[].RoutingInstance`
(`lib/JunosParsers.ps1:92`) is the **L2 switching instance, not an L3 VRF**; and that `Interfaces[]`
identity is the physical port, so unit-level data lives in `LogicalUnits[]`.

### 4.2 Phase 2 — correctness

| # | Change | Site | Why |
|---|---|---|---|
| C1 | Split `Unreachable` into `Refused` / `NoRoute` / `Timeout` / `DnsFailed` | `:259-260` | `connection refused` means **the device is L3-reachable and sshd refused** — reported identically to a dead box. `no route to host` is a fault in *the scan host's* routing. Classification only; `ScanError` already holds the stderr |
| C2 | Fleet ARP map: deterministic, and filter `Flags -eq 'permanent'` on `bme*` | `lib/FleetCrawl.ps1:125-140` | Last-write-wins in job-completion order, so a MAC in two ARP tables resolves differently between runs. **Three of the four ARP entries in the capture are exactly these internal entries** |
| C3 | `Interfaces = @()` on placeholders | `lib/FleetCrawl.ps1:115` | `@{}` serializes as `{}`; `window.asArray` (`utils.js:13-17`) returns `[{}]`, and four consumers call it on `device.Interfaces` (`chassis.js:548,650`, `drawer.js:587,670`). Note `fixture.test.mjs:160-163` asserts `length === 0`, so **the fixture passes a shape assertion production would fail** |
| C4 | Reconcile VLAN tag types | `:622-630` vs `lib/JunosParsers.ps1:95` | `Clients[].VLAN_Tag` is a string or `"Unknown"`; `Vlans[].Tag` is an int or `$null` |
| C5 | Distinguish `LastFlappedSeconds` "Never" from unparseable | `:427-442` | Both yield `$null`. Also add a `y` unit — an interface up over a year silently fails both branches |
| C6 | Frame `AuthFailed` as positive reachability evidence in the UI | — | TCP/22 completed and sshd responded |

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
| `show arp no-resolve` | `show arp no-resolve expiration-time` | ARP entry age, which materially cuts duplicate-IP false positives | **Low — verified.** Same table plus one TTE column; documented option since 8.1. The added column shifts the optional `Flags` capture at `:663`, so the regex needs updating with it |
| `show vlans` | `show vlans extensive` | Per-interface `ge-0/0/20.0*, tagged, trunk` lines: the active marker, **tagged/untagged (i.e. native VLAN)** and **port mode** — which is most of what `show ethernet-switching interface` was wanted for | **Medium — needs a one-off check on hardware.** Juniper's published sample output for `extensive` shows **no routing instance**, and the parser keys `$VlanDict` on `"<instance>\|<name>"` to disambiguate a VLAN name reused across instances (`:580-586`). Harmless on a single-instance fleet; on a multi-instance fleet the name-only fallback must detect two same-named VLANs with different tags and refuse the join rather than guess. **Confirm the ELS form before committing** |
| `show dot1x interface` | `show dot1x interface detail` | `Authenticated VLAN` and `Guest VLAN member` per port — i.e. whether a client landed in a fallback VLAN rather than its intended one | **Medium — size unverified.** Per-port stanzas; on a fleet with dot1x on every access port that is ~48 stanzas per switch. **Measure the output against the 120 s cap before committing**; if it is large, keep the brief form and take per-port state from R6 instead |

#### Added (one command)

| Command | Unlocks |
|---|---|
| `show spanning-tree bridge` | Root bridge ID, root cost, root port and protocol per scope — and **topology-change count and time since last change**, which for "why is this broken *now*" matters more than the root ID. Small output (one stanza per scope). Today the root is only *inferred* from "a node with no `ROOT`-role port", and `DesignatedBridge` is not the root ID |

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

### 6.5 Report, do not adjudicate

Firewall filter term evaluation — implicit-discard semantics, term ordering, `then accept` vs
`then count` — is the most error-prone item in the catalogue. A binding is a lead; a non-zero
discard counter is evidence.

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

### 8.2 The fixture asserts an impossible topology

Worse than "no blocked uplinks": the generator creates real cycles — core ICL (`:477`), every zone's
first frame linked to both cores (`:501-502`), 8% access dual-homing (`:541-544`), daisy chains
(`:552-558`) — and `linkDevices` (`:381`) stamps `FWD` on every one. It claims a converged spanning
tree forwarding on a loop.

**Prerequisite: give the generator a real per-VLAN spanning-tree pass** — root election by the
`bridge-priority` it already writes (`:580`), BFS, `BLK` on non-tree ports — before fault injection
means anything. This is a larger job than revision 1 budgeted and belongs in the work order.

*(Revision 1 also complained that `:376` sets `RemotePort` to a real port name "where reality
supplies a MAC 38 times out of 43". Per §5.2 the fixture is **correct** — it only creates
switch-to-switch links, and reality supplies a real port name on 5 of 5 of those.)*

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

### 8.4 Hand-built micro-topologies

A triangle with one leg blocked in VLAN 10 and forwarding in VLAN 20 (the F5 regression); a VLAN with
no STP instance (F13); two paths surviving pruning (F10 — the test BFS would fail); a two-member LAG
with and without a down member; a VC spanning FPCs; an unscanned waypoint; an address-less bridge; an
out-of-scope neighbour; a `Partial` node asserting `NOT_EVALUATED`, not clean.

### 8.5 PowerShell tests

`Run-Tests.ps1` §12 style: synthetic text in, objects out. **No byte of the production capture enters
the repo.** Existing invariants to preserve: error counters keyed by label, never position; VLAN
member-line matching case-sensitive (`LOBBY`/`GENERAL`/`EMERGENCY` collide with `lo`/`ge`/`em` under
PowerShell's case-insensitive `-match`).

### 8.6 Automation

No CI, no test script, both suites manual. A single runner is a cheap prerequisite — but it **must
record which host ran the PowerShell suite and mark a pwsh-only run as unverified**, because
`Run-Tests.ps1` targets Windows PowerShell 5.1 and a green run under pwsh 7 on Linux is not evidence
for it.

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
*Time was never the binding constraint.* **Peak working set is**, and 3.3–3.6 GB on a 4 GB box is
not survivable with the crawl's runspaces and SSH state on top. Treat the pretty figure as a floor:
the harness holds one string production would not (it measures both serializers), but production
adds everything else the process is doing. The `-Compress` figure is *over*-stated for the opposite
reason — that run still built and held the 156 MiB pretty string it was measuring against, so a
production crawl writing only compressed output sits meaningfully below 1.8 GB.

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

**Still unmeasured:** `Update-ClientIpCorrelationLocal` runs inside the same blocking write and was
not isolated (it is a nested local function). **Open question for the operator: how much RAM does
the production host have?** That single number decides whether `-Compress` is sufficient or the
write must also stream per device.

### 9.2 The browser load path is the other half, and it is also already shipped

`autoloadLastScan` (`web-src/app.js:354-414`, on `DOMContentLoaded` at `:421`) fetches **every**
snapshot the server lists — capped at 20 by `WebServer.ps1:751` — accumulating raw text in
`entries[]` (`:380`) with all of them live at once, then retains every parsed topology in
`loadedSnapshots` (`:502`) and builds a fleet-wide `searchIndex` over all of them. Several
representations of each snapshot are alive simultaneously (raw text → `File` → `FileReader` result →
base64 ciphertext → binary string → `Uint8Array` → plaintext → parsed object), and `:396-403`
decrypts the first snapshot **twice**, running 600,000-iteration PBKDF2 twice.

**Requirement:** bound the autoload to the most recent snapshot, reuse the derived key across the
batch, drop `entries[]` as it converts. This is a prerequisite for multi-snapshot analysis, not a
consequence of it.

### 9.3 The build hazard

`Start-NetworkMapper.ps1:23-27` and `WebServer.ps1:1146-1149` make the built
`lib/Network_Visualizer.html` (2.35 MB, committed) win outright — `web-src/` is never served.
Editing `web-src/*.js` has **no runtime effect** until `build-inline.mjs` re-runs, with no error.
Add a check that fails when any `web-src/*.js` is newer than the artifact; ten lines.

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
   `TopologyCrypto.ps1` and switched the crawl to `ConvertTo-Json -Compress`; peak working set
   3.3–3.6 GB → 1.8–1.9 GB, encrypted write 4.7–9.5 s → 2.3 s, snapshots 190 MiB → 41 MiB.
   Remaining: confirm the production host's RAM, and decide from that whether per-device streaming
   is still needed.
2. **Bound the browser autoload** (§9.2).
3. **Test runner with host recording** (§8.6).
4. **Parity-test mechanism** (§8.1) — ship the mechanism first; it will start failing usefully. Fill
   in `accessRow`'s values **after** Phase 1 settles the initializer, not before.
5. **Phase 1 retention R1–R15** (§4.1), each landing with its fixture counterpart.
6. **Phase 2 correctness C1–C6** (§4.2).
7. **Generator spanning-tree pass** (§8.2) — the blocker for everything path-related.
8. **Fault injection + per-snapshot manifests** (§8.3), micro-topologies (§8.4).
9. **Topology graph + endpoint resolution** (§5, §6.1).
10. **Path computation** (§6.2) with the F5 and F10 regression tests.
11. **Rule framework** (§3) and the L1 rules — the best-supported layer.
12. **Phase 3 command changes** (§4.3): verify the two upgrades on real hardware, then land the three
    in-place replacements and `show spanning-tree bridge`, measuring session time against the 120 s
    cap each time. The exact-matcher fix is worth doing alongside but no longer gates this.
13. **L2 and L3 rules** gated on the commands they need.
14. **UI**: analysis sub-tab, path highlighting, per-hop drawer links.
*(There is no config-parsing step. See §4.4 — the configuration is collected and stored for backup
and manual review, and stays out of the rule engine.)*

---

## Appendix A — rule counts

From the six-way audit, before deduplication across layers. Treat as an order-of-magnitude estimate,
not a plan: §3.1 scopes the build to the "supported today" column.

| Layer | Rules | Supported today | Blocked on retention | Blocked on a command | Not attempted (config-only) | Undetectable passively |
|---|---|---|---|---|---|---|
| L1 / link | 45 | 14 (+6 needing a delta) | 17 | 8 | — | — |
| L2 switching | 33 | 15 | 11 | 7 | — | — |
| L3 / policy | 39 | 9 | 8 | 11 | 5 | 6 |
| **Total** | **117** | **~44** | **~36** | **~26** | **5** | **6** |

The shape is the finding: the largest category is data the tool already collects and discards.

The "not attempted" column is the §4.4 decision — those 5 rules are out of scope, not pending. The
buildable target is therefore **~106 of 117**, and §3.1 scopes the *first* build to the ~44 supported
by today's data.

---

## Appendix B — gaps identified in review, not yet placed

| # | Gap |
|---|---|
| **G1** | **MAC learning as per-hop path verification.** The spec computes a path and never *checks* it. At each hop, the destination's MAC should be learned on the port facing the next hop — direct forwarding-plane evidence, far stronger than "both ends report FWD". The data exists (1030 entries in the capture) and `:674` discards exactly the transit sightings needed. R3 retains them; nothing in §6 uses them. **The largest missed opportunity in the document.** |
| G2 | **Per-VLAN STP scope drift between neighbours.** A link where one end runs an instance for VLAN *T* and the other does not. Detectable today by comparing each end's `StpDetail` scope set against its `Vlans` membership. §6.3 only compares states within a scope both ends have. With 4 of 17 VLANs instance-less on one device, not hypothetical |
| G3 | **VRRP is partly detectable** and §6.3 says it is not. The `00:00:5e:00:01:xx` virtual-MAC prefix appears in the capture's MAC table and identifies both VRRP presence and the VRID. It gives no master/backup, but "this VLAN's gateway is a VIP, so the L3 hop is one of N routers" beats §6.4's single pick |
| G4 | **Topology-change churn, not root ID.** `show spanning-tree bridge` also carries topology-change count and time since last change per scope. For "why is this broken *now*", a VLAN that reconverged 40 seconds ago explains more than which bridge is root |
| G5 | **MTU and native-VLAN mismatch rules are injected as test faults (§8.3) but described nowhere.** R2 retains the LLDP `Maximum Frame Size` TLV without saying what compares it to the local MTU |

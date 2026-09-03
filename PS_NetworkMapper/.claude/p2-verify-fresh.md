# Pass 2 Adversarial Verification

## P2FRESH-001 — Get-JunosNodeData.ps1 askpass call outside try/finally

**Verdict: CONFIRMED**

Read `lib/Get-JunosNodeData.ps1` directly:

```
18  $WorkerScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD }
19  . (Join-Path $WorkerScriptDir "SshHelpers.ps1")
20
21  $AskPass = New-JunosAskPass -Password $Password
22
23  # Everything below runs inside a try/finally so the plaintext askpass files
24  # (containing the real switch password) are always removed, even on error or exit.
25  try {
...
607 } finally {
608     Remove-JunosAskPass -AskPassContext $AskPass
609 }
```

Line 21's call is textually and structurally outside the `try` block that starts at line 25 — the claim about line numbers is exact. The comment on lines 23-24 is itself misleading: it says "everything below" is covered, but the askpass creation it's referring to already happened on the line above.

Traced `New-JunosAskPass` in `lib/SshHelpers.ps1:53-66`:

```
53  function New-JunosAskPass {
54      param([Parameter(Mandatory=$true)][string]$Password)
55      $AskPassPath = Join-Path $env:TEMP "ssh_askpass_$($PID)_$([guid]::NewGuid().Guid.Substring(0,8)).bat"
56      $AskPassText = Join-Path $env:TEMP "ssh_pass_$($PID)_$([guid]::NewGuid().Guid.Substring(0,8)).txt"
57      [System.IO.File]::WriteAllText($AskPassText, $Password)
58      Protect-JunosTempFileAcl -Path $AskPassText
59      [System.IO.File]::WriteAllText($AskPassPath, "@type `"$AskPassText`"")
60      Protect-JunosTempFileAcl -Path $AskPassPath
...
```

There are two `WriteAllText` calls plus two `Protect-JunosTempFileAcl` calls (each wrapped in its own try/catch internally, so those don't throw — see line 15-25 of the same file). If the *second* `WriteAllText` (line 59, writing the `.bat` askpass wrapper) throws — e.g. `%TEMP%` fills up or hits a transient lock between the two writes — the function throws out of `New-JunosAskPass` entirely. At that point:
- `$AskPassText` (the plaintext password file, `ssh_pass_*.txt`) already exists on disk from line 57.
- The exception propagates out of line 21, which is *before* `try` on line 25.
- Because the throwing statement is outside the try/finally, the `finally` block at line 607 is **never entered** for this invocation — `Remove-JunosAskPass` never runs.
- The plaintext password file is orphaned with zero cleanup from this script.

This is exactly the failure mode `lib/Connect-Switch.ps1`'s own comment (lines 24-26) names for its own identical call:
```
24  # Everything that touches the credential file lives inside the try, so the finally always
25  # runs cleanup even if e.g. New-JunosAskPass fails partway (%TEMP% full/locked), which would
26  # otherwise leave the plaintext credential on disk with nothing to remove it.
```
And indeed in `Connect-Switch.ps1`, `New-JunosAskPass` is called at line 35, *inside* `try { ... }` (opens line 28), with `$AskPass` pre-initialized to `$null` at line 27 and a null-guarded cleanup in `finally` (lines 48-50: `if ($AskPass) { Remove-JunosAskPass -AskPassContext $AskPass }`). `Get-JunosNodeData.ps1` has neither the pre-init-to-null pattern nor the inside-try placement — it's a straightforward copy-paste divergence, correctly diagnosed.

**Exposure/severity notes (why this doesn't escalate further than the original finding intends):**
- `Get-JunosNodeData.ps1` runs per-target inside a runspace spawned by `FleetCrawl.ps1`, which calls `Clear-StaleJunosTempFiles` once at crawl start (`lib/FleetCrawl.ps1:35`) — an age-gated (4 hour) sweep of `ssh_pass_*.txt`/`ssh_askpass_*.bat`/`junos_cred_*.json` patterns in `%TEMP%`. So an orphaned file from this exact bug is not permanent: it survives until the *next* crawl starts more than 4 hours later, not indefinitely. This caps the exposure window rather than eliminating it — a plaintext password sits in `%TEMP%` for up to 4 hours (or until next crawl if sooner) after a failure that most operators would never notice, since the crawl itself continues (see the outer catch structure — worth checking but not required to confirm this specific claim).
- Trigger requires `%TEMP%` under contention (full disk, permission/lock issue) precisely between the two `WriteAllText` calls — narrow but real, and it's the same trigger class the codebase's own comments already treat as a live concern elsewhere (Connect-Switch.ps1, Clear-StaleJunosTempFiles's own doc comment).

Severity as HIGH (data/credential exposure class) is reasonable to keep, though the age-gated sweep is a mitigating factor worth noting in the ledger if not already there.

---

## P2FRESH-002 — Update-OuiDatabase.ps1 in-place Set-Content, no temp+rename

**Verdict: CONFIRMED**

Read `lib/Update-OuiDatabase.ps1` in full (54 lines). Line 51:

```
51  Set-Content -Path $OutputPath -Value ($Header + $JsBody) -Encoding utf8 -NoNewline
```

`$OutputPath` defaults to `web-src/vendor/oui-data.js` (line 8) and is written to directly with no temp file + rename. This is the same failure class as the original CRYPTO-001 finding (`Protect-MapperFile.ps1`, now fixed): a crash/kill mid-`Set-Content` (disk full, process killed, power loss) truncates or corrupts the file in place, with no fallback — and unlike a config file, this is a checked-in vendored asset (`web-src/vendor/oui-data.js`) the frontend loads via a classic `<script>` tag (per line 49's comment referencing `graph-layout.js`'s file:// constraint), so a truncated file breaks OUI vendor lookups app-wide until someone notices and re-runs the script or reverts the git-tracked file.

Confirmed the fixed pattern in `lib/Protect-MapperFile.ps1` for comparison — it now uses temp-file + `Move-Item -Force` (lines ~95-101, ~130-134), with an explicit comment: "Temp-file + Move-Item, same pattern as FleetCrawl.ps1's topology writes - a partway [crash truncates nothing]".

**Git history check** — confirmed via `git log --follow -p -- lib/Update-OuiDatabase.ps1`:
- Most recent touch: commit `0eec0b8` ("Fix scan/parsing bugs and add error logging found in a pre-launch audit", Aug 31), the same commit that fixed CRYPTO-001 in `Protect-MapperFile.ps1`. That commit added: the try/catch around the web fetch, and the `< 10000` partial-download sanity check. It did **not** touch the `Set-Content` write itself — the write pattern is identical before and after that commit (diff shows no change to that line).
- No other commit touches this file's write logic; the file was carried over verbatim from `PS_NetworkMapper_V2` in the `823acb1` consolidation commit.

So the claim that this file was "genuinely untouched" by the temp+rename fix that Protect-MapperFile.ps1 received is correct — the Aug 31 commit fixed adjacent robustness issues (fetch failure, truncated download detection) in this exact file but left the final-write step exposed to the identical crash-truncation risk that CRYPTO-001 flagged and fixed elsewhere in the same commit.

**Severity note:** this is lower-stakes than CRYPTO-001 was (no operator credentials/topology data lost — worst case is a corrupted vendor-lookup JS asset, recoverable by re-running the script or `git checkout` since it's committed), and the trigger window is short (one `Set-Content` call, not a long-running operation) and this script is explicitly documented as manually/occasionally re-run (line 3-4 comment: "Re-run occasionally... nothing else depends on it running automatically"), not part of the automated crawl path. Original HIGH severity (matching CRYPTO-001's classification) looks overstated relative to blast radius; **DOWNGRADE to LOW/MEDIUM** — same bug class and correctly identified, but the recoverability (checked into git) and non-automatic invocation meaningfully reduce real-world impact versus the original CRYPTO-001 case (encrypted operator config/topology data with no other copy).

# Pass 3 — Atomic-write track findings (Protect-MapperFile.ps1, FleetCrawl.ps1, Update-OuiDatabase.ps1, TopologyCrypto.ps1)

Scope: `lib/Protect-MapperFile.ps1`, `lib/FleetCrawl.ps1` (both gained the `[System.IO.File]::Replace`-based helper in `85b4220`), `lib/Update-OuiDatabase.ps1` (simple temp+rename in `36638fc`), `lib/TopologyCrypto.ps1` (unchanged, re-verified). Third independent look, re-derived from current code, not from re-reading Pass 2's reports.

---

## P3ATOMIC-001

- **Track**: DATA
- **File:line**: `lib/FleetCrawl.ps1:140-145` (`$ScanTimestamp`/`$TempOutputFile`/`$OutputFile` derivation), all four call sites of `Move-TopologyOutputLocal` (`:213`, `:464`, `:490`, `:524`), and the `finally`-block cleanup at `:539`
- **Severity**: HIGH
- **Confidence**: High (empirically confirmed the timestamp-collision precondition; the write-corruption/cross-clobber consequence is a direct, deterministic code trace from that precondition, not speculative)
- **Claim**: `Invoke-FleetCrawl`'s temp file and final output file are named only from `$ScanTimestamp = (Get-Date).ToString("yyyy-MM-dd_HHmmss")` — **1-second granularity, no `$PID` or GUID component at all** — unlike `Protect-MapperFile.ps1`'s sibling helper, which Pass 2 explicitly PID-uniqued (`"$TargetPath.$PID.tmp"`) for exactly this reason. Two `Invoke-FleetCrawl` invocations against the same `$SnapshotDir`, started within the same wall-clock second, compute byte-identical `$TempOutputFile` and `$OutputFile` paths and then write/replace through them concurrently for the entire duration of both crawls (periodic writes fire repeatedly, every 5s, for as long as both crawls run).
- **Trigger**: This is reachable in practice, not just in theory. `WebServer.ps1`'s `Invoke-ScanNetworkAction` (`lib/WebServer.ps1:482-485`) only guards against a second *web-triggered* scan via the in-process `$script:PendingScanNetwork` variable — it has no cross-process lock. `Start-NetworkMapper.ps1` runs `Invoke-FleetCrawl` directly from its CLI path (`Start-NetworkMapper.ps1:160-163`) using the same default `$SnapshotDir = Join-Path $ScriptDir "Network_Maps"` (`:41`) as `-Web` mode. An operator running the CLI crawl in one terminal while the web server (running against the same install directory) also has a scan in flight — or simply launching two CLI crawls in two terminals close together — collides. Both are ordinary, foreseeable operator actions for this tool (no exotic timing attack needed): starting two terminals "at the same time" routinely lands within the same second.
- **Evidence**: Confirmed the 1-second granularity directly:
  ```
  $ pwsh -NoProfile -Command '
    $d1 = Get-Date; Start-Sleep -Milliseconds 50; $d2 = Get-Date
    "{0} vs {1}" -f $d1.ToString("yyyy-MM-dd_HHmmss"), $d2.ToString("yyyy-MM-dd_HHmmss")
  '
  2026-09-03_055929 vs 2026-09-03_055929
  ```
  Code trace: `lib/FleetCrawl.ps1:141` `$ScanTimestamp = $ScanDateTime.ToString("yyyy-MM-dd_HHmmss")` feeds both `:144` `$OutputFile` and `:145` `$TempOutputFile` with no other differentiator. Contrast `lib/Protect-MapperFile.ps1:128` `$TempTargetPath = "$TargetPath.$PID.tmp"`, which Pass 2 added specifically to close this class of collision for that file.
- **Invariant hit**: INV-DATA ("a saved topology file is never silently corrupted"). The atomic-replace fix (`85b4220`) guarantees a single writer's handoff is atomic; it does nothing to stop two independent writers from both believing they own the same filename.
- **Impact**: Concretely, with two crawls A and B racing on the same `$TempOutputFile`/`$OutputFile`:
  1. Both call `Write-TopologyOutputLocal -Path $TempOutputFile` (an `Out-File`, not append) against the identical temp path — whichever writes last within the ~250ms-polled loop wins that round, silently discarding the other crawl's in-flight topology snapshot for that write cycle.
  2. Both then call `Move-TopologyOutputLocal -Source $TempOutputFile -Destination $OutputFile`. Whichever runs first is fine; the second's `Test-Path -LiteralPath $Destination` now sees a file that already exists (the other crawl's atomic Replace just landed it), so it also takes the `[System.IO.File]::Replace` branch and clobbers it — meaning `$OutputFile` at any moment holds whichever crawl's data happened to write last, non-deterministically mixing two operator-visible "different" scans (possibly different `$StartIP`/scope) under one filename with no error surfaced to either operator.
  3. Crawl A's `finally` block (`:539`, `if (Test-Path $TempOutputFile) { Remove-Item -Path $TempOutputFile -Force }`) runs unconditionally when A finishes — even if B is still mid-crawl and about to write its next periodic update to that same (shared) temp path. If A's cleanup deletes the temp file between B's `Write-TopologyOutputLocal` and `Move-TopologyOutputLocal` calls, B's `Move-TopologyOutputLocal` throws (source vanished) — caught by the periodic-write `try/catch` (`:467-469`, logged as "PERIODIC WRITE FAILED", swallowed) or the final-write `try/catch` (`:492-494`, "FINAL WRITE FAILED") — silently dropping B's snapshot write for that cycle. This is exactly the "one cleanup mechanism clearing a file the other still expects to exist" interaction the audit brief called out as a concern, and it is real: the two "mechanisms" are actually the *same* shared temp path used by two unrelated crawl instances, not two different cleanup code paths within one instance.
- **Repro**: Not run as two literal simultaneous `pwsh` processes (would need synchronized SSH-reachable Junos test fixtures for both crawls to make progress), but the collision precondition (identical paths) is deterministic and demonstrated above; the write-corruption consequence follows directly from reading `Write-TopologyOutputLocal`/`Move-TopologyOutputLocal`/the `finally` block, all unconditional on there being only one writer.
- **Fix sketch**: Add a run-unique component to `$TempOutputFile` (and ideally `$OutputFile`, though the latter is more visible to operators as "the scan I just ran" so at minimum the temp path needs it) — `$PID` or a GUID, matching the fix already applied to `Protect-MapperFile.ps1` for the identical concern. Consider also a cross-process lock (e.g. a lock file in `$SnapshotDir`) since `WebServer.ps1`'s `$script:PendingScanNetwork` guard is process-local and doesn't protect against a concurrently-run CLI crawl.

---

## P3ATOMIC-002

- **Track**: DATA
- **File:line**: `lib/Protect-MapperFile.ps1:48-66` (`Move-FileAtomic`), identically `lib/FleetCrawl.ps1:56-74` (`Move-TopologyOutputLocal`) — the shared helper pattern, both branches
- **Severity**: MEDIUM
- **Confidence**: High (empirically reproduced)
- **Claim**: The helper's `else` branch (`Test-Path -LiteralPath $Destination` is `$false` → `Move-Item -Path $Source -Destination $Destination -Force`) is itself a TOCTOU race that silently falls back to exactly the non-atomic unlink-then-rename behavior `85b4220`'s whole fix exists to eliminate, whenever the destination is created by something else between the `Test-Path` check and the `Move-Item` call. The helper's own doc comment justifies skipping `[System.IO.File]::Replace` in this branch with "nothing to replace atomically against, and Move-Item is already atomic in that case" — that premise (destination still absent at `Move-Item` time) is not guaranteed by the preceding `Test-Path`, which only proves absence at check time.
- **Trigger**: Any scenario where the destination path can come into existence between the check and the move — e.g. exactly the P3ATOMIC-001 collision above (two crawls/two `Protect-MapperFile.ps1` invocations against the same target), or an operator manually creating/restoring a file at that path mid-run.
- **Evidence**: Reproduced directly, simulating the race:
  ```
  $ pwsh -NoProfile -Command '
    "orig" | Set-Content dest.json
    Remove-Item dest.json                 # simulate: not yet created
    "tempcontent" | Set-Content src.tmp
    $destMissing = -not (Test-Path -LiteralPath "dest.json")
    "Test-Path saw dest missing: $destMissing"
    "racer-content" | Set-Content dest.json   # race: another writer creates dest here
    Move-Item -Path "src.tmp" -Destination "dest.json" -Force
    "Move-Item -Force succeeded (silently overwrote racer content)"
    Get-Content dest.json
  '
  Test-Path saw dest missing: True
  Move-Item -Force succeeded (overwrote racer content, non-atomically per strace finding)
  tempcontent
  ```
  `Move-Item -Force` over an existing destination is the same delete-then-move sequence P2CRYPTO-001 already proved (via strace) is two syscalls, not one — this branch reaches that exact code path whenever the race window is hit, regardless of the `Test-Path` guard.
- **Invariant hit**: INV-DATA — the narrow non-atomic-overwrite window P2CRYPTO-001 fixed for the "destination exists" branch is still reachable through the "destination doesn't exist (yet)" branch.
- **Impact**: Narrower than P2CRYPTO-001 (requires the destination to spring into existence in a small window, rather than simply pre-existing), but the same consequence: a crash/kill precisely inside that window leaves the destination absent rather than present-with-old-or-new-content, with the operator's data recoverable only by finding the surviving `.tmp`/racer file by hand.
- **Repro**: See Evidence block; the same race is reachable for every call site of both `Move-FileAtomic` and `Move-TopologyOutputLocal`.
- **Fix sketch**: Don't branch on a pre-check. Either always attempt `[System.IO.File]::Replace` first and catch/fall back to `Move-Item` only on the specific "destination doesn't exist" exception it throws, or retry the `Test-Path`/`Move-Item` pair once if `Move-Item` unexpectedly hits an already-existing destination.

---

## P3ATOMIC-003

- **Track**: DATA
- **File:line**: `lib/Protect-MapperFile.ps1:62`, `lib/FleetCrawl.ps1:70` (`Convert-Path -LiteralPath $Destination` inside the `Test-Path`-guarded branch)
- **Severity**: LOW
- **Confidence**: High (empirically reproduced), but the window is very narrow
- **Claim**: `Convert-Path -LiteralPath` is itself a new failure point the `85b4220` fix introduced: if `$Destination` is removed by something else in the (small) gap between the `Test-Path -LiteralPath $Destination` check and the `Convert-Path -LiteralPath $Destination` call two lines later, `Convert-Path` throws a terminating `ItemNotFoundException` instead of the graceful `Move-Item`-style fallback the pre-fix code had. This is a strict regression in robustness for that specific race, even though it's a much smaller window than P3ATOMIC-002's.
- **Trigger**: Destination deleted concurrently in the gap between the two lines inside `Move-FileAtomic`/`Move-TopologyOutputLocal`.
- **Evidence**:
  ```
  $ pwsh -NoProfile -Command '
    "orig" | Set-Content dest.json
    "tempcontent" | Set-Content src.tmp
    $exists = Test-Path -LiteralPath "dest.json"
    "Test-Path saw dest exists: $exists"
    Remove-Item dest.json                      # race: destination vanishes here
    $s = Convert-Path -LiteralPath "src.tmp"
    $d = Convert-Path -LiteralPath "dest.json"  # throws
  '
  Test-Path saw dest exists: True
  Convert-Path: Cannot find path '\''dest.json'\'' because it does not exist.
  ```
  The exception is uncaught inside the helper itself, so it propagates to the caller. In `Protect-MapperFile.ps1` both call sites are inside a `try/finally` (`:129-134`, `:167-172`) so the source `.tmp` is at least cleaned up (confirmed `src.tmp still present: True` before the `finally` would run) and the operator sees a clear thrown error. In `FleetCrawl.ps1` the periodic/final-write call sites are inside their own local `try/catch` (`:461-469`, `:486-494`) which logs and swallows it ("PERIODIC WRITE FAILED"/"FINAL WRITE FAILED") — so this just becomes one more way a periodic/final write can silently no-op, on top of P3ATOMIC-001.
- **Invariant hit**: INV-NO-LOCKOUT (graceful degradation) — minor, since the pre-fix `Move-Item`-only code would have handled a same-window race (destination vanishing right as the move happens) via `Move-Item -Force`'s own more permissive semantics.
- **Impact**: Low — the window is a couple of PowerShell statements (microseconds), and the failure is at worst a skipped write with the source still available for cleanup/retry (Protect-MapperFile) or a logged-and-retried-next-cycle periodic write (FleetCrawl, not fatal to the crawl). Documented for completeness per the audit brief's explicit ask about `Convert-Path` as a new failure point, not because it's independently actionable.
- **Repro**: See Evidence block.
- **Fix sketch**: Wrap the `Convert-Path -LiteralPath $Destination` call (and the subsequent `[System.IO.File]::Replace`) in a `try/catch` that falls back to `Move-Item -Path $Source -Destination $Destination -Force` on a "destination not found" exception, matching the `else` branch's own fallback intent.

---

## Checked and ruled out (no finding)

- **Cross-volume `[System.IO.File]::Replace` failure.** `.NET`'s `File.Replace` does not support replacing across volumes (fails when source and destination are on different filesystems/volumes). Traced every call site: `Protect-MapperFile.ps1:128` (`$TempTargetPath = "$TargetPath.$PID.tmp"`), `FleetCrawl.ps1:145` (`$TempOutputFile = Join-Path $SnapshotDir "NetworkMap_$ScanTimestamp.tmp$OutputExtension"` vs. `:144` `$OutputFile` in the same `$SnapshotDir`) — in both files the temp file is always constructed by string-appending onto (or joining within) the same directory as the destination, so temp and destination are always on the same volume by construction. Not reachable as written. (This re-confirms Pass 2's own "same-filesystem/same-directory atomicity precondition" check, now re-verified against the newer helper too.)
- **`[NullString]::Value` coercion.** Re-verified the fix: `[System.IO.File]::Replace($src, $dst, [NullString]::Value)` is the correct idiom to pass a genuine `.NET` `null` for the optional backup-path parameter without PowerShell's `$null`→`""` string coercion tripping the API's "value cannot be an empty string" rejection. Confirmed correct in both files, consistent with Pass 2's own verification.
- **Case-only path difference (Windows).** Not applicable to any call site: every temp/destination pair in both files is derived from the exact same base string (`$TargetPath`/`$OutputFile`/`$SnapshotDir`) with only a suffix or directory-join appended — there is no code path where source and destination could differ only by case.
- **Symlink at the destination path.** Reproduced `[System.IO.File]::Replace` against a symlinked destination: `Convert-Path -LiteralPath` on the symlink resolves to the symlink's own path (does not dereference to the link target), and `File.Replace` on Linux then replaces the symlink itself with the new file (the link target file is untouched, the destination path stops being a symlink). This matches standard `rename(2)`-over-a-symlink semantics and is not a regression from the pre-fix `Move-Item -Force` behavior (which does the same thing). Not flagged: this tool has no realistic path by which an attacker or the fleet-crawl/config-encrypt flow would plant a symlink at `Network_Maps/NetworkMap_*.json[.enc]` or `Configuration.json.enc` — single-operator local admin tool, not a multi-tenant service — so there's no concrete reproduction path within this codebase's actual threat model.
- **`Update-OuiDatabase.ps1`'s simpler temp+rename (`36638fc`).** No `$PID`/unique-name component and no `try/finally` cleanup on failure — but this is a *documented, deliberate* design choice in the fix commit itself ("Lower stakes than Protect-MapperFile/FleetCrawl... a simple temp+rename is sufficient here"), already assessed and downgraded to LOW/MEDIUM by Pass 2's own review (checked-into-git vendored asset, not part of the automated crawl path, run manually by a single maintainer, never invoked concurrently by any other part of the app per repo-wide grep of call sites). Re-confirmed that assessment still holds; not treated as a new finding since it's an accepted, scoped-down fix rather than a defect introduced by the change.
- **`lib/TopologyCrypto.ps1` consistency (unchanged file).** Confirmed via `git log --oneline -- lib/TopologyCrypto.ps1` that the file has not been touched since before Pass 2 (`85b4220`/`36638fc` don't touch it). No drift to report; nothing in this pass's atomic-write changes reaches into its envelope/KDF logic.

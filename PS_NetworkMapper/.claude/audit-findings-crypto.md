# Audit Findings — Crypto/Persistence Track (Phase 1)

Scope: lib/TopologyCrypto.ps1, web-src/topology-crypto.js, lib/Protect-MapperFile.ps1,
web-src/persistence.js, web-src/config-resolve.js (+ their test files).

---

## CRYPTO-001

- **Track**: DATA
- **File:line**: lib/Protect-MapperFile.ps1:94, lib/Protect-MapperFile.ps1:123
- **Severity**: High
- **Confidence**: High
- **Claim**: `Protect-MapperFile.ps1` writes its output directly in place with `Out-File -Force` (both the `-Decrypt` branch at line 94 and the encrypt branch at line 123), instead of the temp-file + `Move-Item` pattern used everywhere else in this codebase for the same kind of write (see `lib/FleetCrawl.ps1:180-187`, which does temp-file+`Move-Item` specifically so "a partway failure ... leaves no half-written $OutputFile behind instead of a truncated one"). `Out-File` truncates the target on open before streaming content, so any interruption mid-write (process kill, Ctrl+C, disk full, PowerShell crash) leaves a truncated/corrupted file at `$TargetPath`.
- **Trigger**: This is not merely a "what if the disk is full" edge case — it is directly reachable via ordinary invocation:
  1. Encrypt branch: if `-InputFile` is a plaintext JSON file whose name already ends in `.enc` (e.g. a previously-decrypted-in-place output, or a user who renamed a plaintext file), `Resolve-EnvelopeFormat`'s "already encrypted" guard (line 104) only rejects it if the JSON has a `format` field matching `^PSNetworkMapper-Encrypted`; a plain JSON file named `*.enc` passes that check. `$DefaultOutput` for the encrypt branch (line 119) is then `$ResolvedInput` itself (the `.enc`-suffix branch returns the *same* path unchanged) — i.e. the tool encrypts a file **onto itself**, in place, with no backup.
  2. More generally, any explicit `-OutputFile` pointing at the same path as `-InputFile` (a natural "encrypt/decrypt in place" invocation) hits the same in-place `Out-File -Force` with no atomicity.
- **Evidence**:
  ```
  119  $DefaultOutput = if ($ResolvedInput -match '\.enc$') { $ResolvedInput } else { "$ResolvedInput.enc" }
  120  $TargetPath = if ($OutputFile) { $OutputFile } else { $DefaultOutput }
  121
  122  if (-not (Confirm-Overwrite -Path $TargetPath)) { return }
  123  $Envelope | ConvertTo-Json -Depth 10 | Out-File -FilePath $TargetPath -Encoding utf8 -Force
  ```
  Contrast with `lib/FleetCrawl.ps1:180-187`, which explicitly documents and implements the safe pattern for the same class of write (topology snapshot encrypt+write), proving the safe pattern was known and deliberately used elsewhere in this codebase — its absence here reads as an oversight specific to this file, not a considered tradeoff.
- **Invariant hit**: INV-DATA (atomicity of writes), INV-NO-LOCKOUT (a crash during self-overwrite destroys the operator's only copy of the topology/config data with no path forward — not even a wrong password, the plaintext is just gone).
- **Impact**: A user running this standalone CLI to encrypt/decrypt their own `Network_Maps/*.json[.enc]` or `Configuration.json.enc` in place (a natural workflow per the script's own usage examples, which show `-InputFile`/`-OutputFile` freely) can permanently lose that file's contents if the process is interrupted mid-write. Since this script's stated purpose is exactly to operate "outside of a live crawl/webserver session" (line 3), the safer FleetCrawl path is not in effect here.
- **Repro**: `pwsh -File lib/Protect-MapperFile.ps1 -InputFile Network_Maps/NetworkMap_test.json.enc -Decrypt -OutputFile Network_Maps/NetworkMap_test.json.enc -Force` (decrypt in place) — kill the process (e.g. `kill -9`) partway through the `Out-File` write on a large file; the `.enc` file is left truncated/invalid JSON, and there is no other on-disk copy.
- **Fix sketch**: Mirror `FleetCrawl.ps1`'s pattern: write to `"$TargetPath.tmp"` first, then `Move-Item -Path "$TargetPath.tmp" -Destination $TargetPath -Force` only after the write succeeds; clean up the `.tmp` file in a `finally`.

---

## CRYPTO-002

- **Track**: DATA
- **File:line**: web-src/topology-crypto.js:32-34
- **Severity**: Low
- **Confidence**: High
- **Claim**: The comment above `MIN_ITERATIONS`/`MAX_ITERATIONS` states "MIN must stay <= any real file's iteration count (currently 200,000)". This is factually wrong: `git log -p` on `lib/TopologyCrypto.ps1` shows `Get-TopologyPbkdf2Iterations` has returned `600000` since it was introduced, and it is the single source of truth used by every writer (`Start-NetworkMapper.ps1:123`, `lib/WebServer.ps1:714`, `lib/Protect-MapperFile.ps1:115`). No code path in this repo ever produces a 200,000-iteration file.
- **Trigger**: N/A — this is a static comment inaccuracy, not a runtime bug. Flagged because a future maintainer trusting the comment ("real files currently use 200,000") could make a change (e.g. raising `MIN_ITERATIONS` based on a false belief about the real current value, or "cleaning up" the comment by making `MIN_ITERATIONS` match the claimed 200,000) that doesn't reflect what real files actually contain.
- **Evidence**: `function Get-TopologyPbkdf2Iterations { return 600000 }` (lib/TopologyCrypto.ps1:13-15) vs. the JS comment's "(currently 200,000)" (web-src/topology-crypto.js:33).
- **Invariant hit**: None directly (INV-DATA not currently violated — MIN_ITERATIONS=1000 is well below the real 600,000, so decryption is unaffected today).
- **Impact**: Documentation drift only, at present. No user-visible effect.
- **Repro**: N/A (comment inspection + `git log -p -- lib/TopologyCrypto.ps1`).
- **Fix sketch**: Update the comment to reflect the actual current value (600,000) or phrase it version-independently (e.g. "must stay <= whatever `Get-TopologyPbkdf2Iterations` in TopologyCrypto.ps1 currently returns").

---

## Categories checked with no surviving finding

- **KDF/salt/IV/padding match between PS and JS**: Verified byte-for-byte — both derive 64 bytes via PBKDF2-HMAC-SHA256 (32/32 split for enc/mac keys), both compute HMAC-SHA256 over `IV || ciphertext`, both use AES-256-CBC/PKCS7, both encode plaintext/derive password bytes as UTF-8. IV is freshly generated per encrypt call (`$Aes.GenerateIV()`), never reused. Cross-implementation round-trip is additionally exercised by `web-src/test/topology-crypto.test.mjs`'s independently-built-envelope test. No mismatch found.
- **Wrong-password vs. corrupted-file vs. wrong-version error messages**: Both implementations deliberately collapse "wrong password" and "corrupted file" into one message (by design, encrypt-then-MAC, documented in both files) but keep "unsupported format/version" as a distinct, clearer error raised *before* attempting any decrypt. This is a deliberate, matched, non-lockout design (no exception ever destroys the on-disk file — decrypt is read-only). No bug found.
- **Non-constant-time MAC comparison**: PS does a manual byte-by-byte compare (not constant-time), explicitly justified in-code as acceptable given the single-local-operator threat model. JS uses `crypto.subtle.verify` (constant-time). Asymmetric but not a round-trip or lockout bug; accepted per the codebase's own stated threat model note.
- **Hardcoded secrets / weak randomness**: Salt (16 bytes) and IV are both generated via CSPRNG (`RandomNumberGenerator`/`Aes.GenerateIV()` on the PS side). No hardcoded keys/passwords found in the scoped files.
- **persistence.js / config-resolve.js**: Neither file touches the encrypted envelope or does any disk I/O — `persistence.js` is entirely `localStorage`-backed derived caches (explicitly documented as rebuildable, non-authoritative), and `config-resolve.js` is pure in-memory device-to-location matching logic. Reviewed for data-integrity issues anyway; found none rising to the bar for this track (both are well covered by their `.test.mjs` files for the logic in scope here).

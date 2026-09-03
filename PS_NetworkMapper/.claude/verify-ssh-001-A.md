# Adversarial verification: SSH-001 / SSH-002

## Verdict

- **SSH-001**: CONFIRMED, but **DOWNGRADED** from Critical to **Medium** (mechanism is real; blast radius/severity framing is overstated — see below).
- **SSH-002**: CONFIRMED, but **DOWNGRADED** from Critical to **Medium**, same reason. SSH-002 is the stronger/more robust of the two claims (its exploitation doesn't depend on getopt/OpenSSH-specific argument-permutation behavior — see "Payload" below) and should be treated as the primary finding, with SSH-001 as an additional (partially redundant) vector against the same root cause.

## What's confirmed as written

1. **`Get-JunosSshArgs` (`lib/SshHelpers.ps1:76-85`)** returns `"$Username@$TargetIP"` as the final array element with zero validation/escaping of `$Username`. Confirmed by direct read — no regex check, no length check, no character allowlist anywhere in this function.

2. **Both callers use the raw-string `ProcessStartInfo` constructor, not `ArgumentList`:**
   - `lib/Connect-Switch.ps1:42`: `New-Object System.Diagnostics.ProcessStartInfo("ssh.exe", ($SshArgs -join ' '))`
   - `lib/Get-JunosNodeData.ps1:35`: `New-Object System.Diagnostics.ProcessStartInfo("cmd.exe", "/c ssh.exe $($SshArgs -join ' ') > ...")`

   This matters exactly as the finding says. The `(fileName, arguments)` constructor populates the `.Arguments` *string* property. With `UseShellExecute = $false` (set at both call sites), .NET hands that string to Win32 `CreateProcess` as (part of) `lpCommandLine` **verbatim** — no per-token quoting is applied by .NET. Per-argument quoting/escaping only happens via the `.ArgumentList` collection (available since .NET Core 2.1 / PowerShell 7), which neither call site uses. The *child* process (`ssh.exe`, or `cmd.exe`) is solely responsible for parsing that command line into its own argv, via `CommandLineToArgvW`-style splitting on unescaped whitespace (respecting `"..."` quoting, which is absent here). This is standard, well-documented .NET/Win32 behavior — I did not find, and could not find, any code on this path that pre-quotes `$Username` before it reaches the string join. This part of the finding is accurate, not a misread.

3. **No validation anywhere upstream.** Traced `Username` from origin to sink:
   - `lib/WebServer.ps1:728`: `$script:JunosUsername = [string]$Parsed.credentials.username` — straight cast off the parsed JSON POST body, no regex/format/length check.
   - `lib/WebServer.ps1:136,175,443`: `Invoke-ConnectAction`/`Invoke-RescanAction`/`Invoke-ScanNetworkAction` only check `IsNullOrWhiteSpace` — presence, not shape.
   - Contrast confirmed: `$TargetIP` is regex-locked to `^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$` at every call site (`WebServer.ps1:145,184`, and the scan-network path). No equivalent exists for `Username`.
   - `web-src/index.html:559`: the Settings-tab username field (`#setting-junosUsername`) is a bare `<input type="text">` with **no `pattern` attribute at all** (checked directly — the finding didn't even need the "HTML pattern isn't sufficient" argument; there isn't one to begin with). Nothing stops an operator (or a same-machine process) from typing spaces or shell metacharacters into it, and nothing stops a direct POST from doing the same.

4. **`Get-JunosCredentialFile`/JSON round-trip introduces no sanitization.** `New-JunosCredentialFile` (`SshHelpers.ps1:14-24`) writes `{Username, Password}` via `ConvertTo-Json -Compress`/reads back via `ConvertFrom-Json` in `Connect-Switch.ps1:33-34` — this is a lossless string round-trip; JSON string escaping only protects the JSON *syntax*, not the shell/argv boundary the string crosses later. No mitigation here.

## Where the original finding overreaches

**The `HttpListener` is bound to `localhost` only, by explicit design, and this is documented in-repo:**

```
lib/WebServer.ps1:1-2: "HttpListener-based local webserver for Network_Visualizer. Localhost-only by design:
                         binds "localhost" specifically (no netsh urlacl/admin needed), ..."
lib/WebServer.ps1:5:   "... true for localhost and false the moment this is rebound to a LAN address."
lib/WebServer.ps1:815: $Prefix = "http://localhost:$Port/"
lib/WebServer.ps1:816: $Listener.Prefixes.Add($Prefix)
```

The finding's "Trigger" section says: *"Operator (or anyone who can reach the local web UI's `/api/save-config`-style credentials endpoint — no auth token is checked in the code paths reviewed)"* and its "Impact" section calls this *"full compromise of the command-and-control host"* achievable "purely by controlling the saved Junos username string." That framing implies a meaningfully separate attacker who reaches the RCE without already controlling the process. On this codebase, that's not accurate as-is:

- The listener only accepts connections from the local machine. A remote network attacker cannot reach `/api/save-config` at all (this is a pre-existing, documented, in-repo design decision, not something this finding surfaces).
- Anyone who *can* reach the endpoint is already running code as the same OS user as `WebServer.ps1` (or is that literal operator, typing into the Settings UI). That principal already possesses:
  - Read access to `Configuration.json.enc` and the decryption password/flow (or the ability to just read `$script:JunosPassword` in the live process / memory, or simply use the Settings UI's "Launch SSH Session" button directly with the real credentials).
  - The ability to run arbitrary other processes as themselves on that same machine — i.e., they don't need `ProxyCommand`/cmd.exe injection to get code execution as their own user; they already have it, trivially.

So this is not "attacker escalates from web-UI access to code execution on the C2 host, gaining every credential it holds" (a privilege boundary crossing) — it's **self-injection**: the same local principal who can already run arbitrary code as themselves triggers a slightly different way to run arbitrary code as themselves, through a needlessly fragile code path. The one genuine, novel value the bug adds beyond what the attacker already has: `ssh.exe`/`cmd.exe` inherit the process's environment, including `SSH_ASKPASS`/askpass file paths that carry the plaintext switch password at that moment. So there is a marginal case for "makes credential exfiltration one step lazier for someone who already has arbitrary local execution" — but that's a narrow, same-principal-only, defense-in-depth gap, not the "attacker gets RCE + full credential-fleet compromise from just a config write" framing in the finding. There's also a documented pre-existing gap at `WebServer.ps1:115-118` (any origin can talk to the listener via CSRF-style request from a same-machine browser/script) which is the actual "who can reach this without being the operator" surface — but that gap is pre-existing/noted elsewhere in the file's own comments, not something SSH-001/002 introduces or that changes the localhost-only trust boundary in a way that turns this into remote/cross-principal RCE.

**Conclusion on severity**: real defect, real missing input validation, real unsafe process-invocation pattern — but "Critical / full C2 host compromise from an unauthenticated network attacker" is not supported by the localhost-only binding. Correct severity is **Medium**: a robustness/defense-in-depth bug (missing input validation + fragile shell-string construction) reachable only by a principal who already has equivalent-or-greater local capability, with a marginal credential-handling benefit to the attacker (askpass-file environment inheritance) as the actual delta in risk.

## Improved, getopt-independent payload (for the regression writeup)

The finding's example payload (`admin -oProxyCommand=calc.exe x`) puts the injected `-o` option *after* a non-option token. Whether `ssh.exe`'s argv parser (OpenSSH's BSD-derived `getopt_long`) still recognizes a `-o...` appearing after a positional argument depends on getopt permutation behavior, which is a real but avoidable dependency. A cleaner, order-independent payload puts the injected option *before* the (still syntactically valid) `user@host` token, so it doesn't rely on any permutation behavior:

```
Username = "-oProxyCommand=C:\Windows\Temp\pwn.bat admin"
```

`Get-JunosSshArgs` produces the last argv element as:
```
-oProxyCommand=C:\Windows\Temp\pwn.bat admin@<TargetIP>
```
which, once whitespace-split by the child process, yields:
```
... -o PubkeyAuthentication=no -oProxyCommand=C:\Windows\Temp\pwn.bat admin@<TargetIP>
```
All options precede the single positional `user@host` argument; `ProxyCommand` is honored under any getopt ordering, and the destination stays syntactically well-formed (`admin@<TargetIP>`) so `ssh.exe` doesn't fail parsing before reaching the option. `pwn.bat` (a single space-free token, so it survives being a `-o` *value*) executes locally, under the C2 host's own process identity, before authentication.

For SSH-002 (`Get-JunosNodeData.ps1:35`, `cmd.exe /c "..."`), an even simpler, shell-native payload works and needs no `ssh.exe` option-syntax knowledge at all:
```
Username = "admin & calc.exe & echo "
```
`cmd.exe` splits on unescaped `&` before `ssh.exe` is ever invoked — this is arguably the more robust/primary finding of the two, since it depends only on well-known cmd.exe behavior rather than any ssh-client-specific argument parsing.

## One correction to the original finding's evidence

`Invoke-ConnectAction` (`WebServer.ps1:153-156`) builds a *separate* `$ArgString` for `Start-Process -FilePath $PowerShellExePath -ArgumentList $ArgString` that launches `Connect-Switch.ps1` itself — that string does **not** contain `$Username` (only `$ConnectScriptPath`/`$TargetIP`/`$CredFile`, and `$TargetIP` is already regex-validated). `$Username` reaches `Connect-Switch.ps1` only via the credential JSON file, then via `Get-JunosSshArgs` inside that script. This isn't a third injection point and the original finding didn't claim one, but it's worth stating explicitly so a reader doesn't conflate this outer `Start-Process` call with the vulnerable one at `Connect-Switch.ps1:42`.

## Regression test sketch (no Windows required to write/reason about it; would need Windows to execute against real `ssh.exe`)

Pure logic-level Pester test, runnable anywhere PowerShell + this repo's `SshHelpers.ps1` can be dot-sourced (no network/ssh.exe needed — just asserting on the returned array):

```powershell
Describe "Get-JunosSshArgs input validation" {
    It "rejects/neutralizes a username containing whitespace" {
        $Args = Get-JunosSshArgs -Username "admin -oProxyCommand=pwn.bat" -TargetIP "10.0.0.1"
        $LastArg = $Args[-1]
        # Today: FAILS - $LastArg contains an embedded, unescaped space, i.e.
        # "admin -oProxyCommand=pwn.bat@10.0.0.1" - a single array element that
        # will still get whitespace-split by the OS/child process once joined
        # into a raw command-line string downstream.
        $LastArg | Should -Not -Match '\s'
    }
}
```

And at the ingestion boundary:
```powershell
Describe "/api/save-config username validation" {
    It "rejects a username containing shell/ssh metacharacters" {
        # POST { credentials: { username: "admin & calc.exe", password: "x" } }
        # Today: 200 "saved" - no validation exists in Invoke-SaveConfigAction (WebServer.ps1:727-729).
    }
}
```

I confirmed via `find`/`grep` that no `*.Tests.ps1` file in this repo references `Get-JunosSshArgs` or exercises username validation — this is not already covered by existing tests ("already tested" does not apply as a REJECTED reason).

## Bottom line

Both SSH-001 and SSH-002 are real, correctly-traced code-path findings: the argv/shell-splitting mechanism is accurately described, the missing validation is real and confirmed end-to-end (including the HTML input field, which has no `pattern` or any other constraint), and the payloads work as claimed (with SSH-002's cmd.exe-metacharacter payload being the more robust of the two, and SSH-001's payload improved above to remove a getopt-permutation dependency). The one thing the original report got wrong is severity: it frames this as attacker-reachable RCE granting "full compromise of the command-and-control host" from an external/lower-privileged actor, but `WebServer.ps1`'s `HttpListener` is explicitly, documented-in-repo, bound to `localhost` only — so the only principal who can set a malicious username already has equivalent-or-greater code-execution capability on that host. Recommend re-filing both as **Medium**: real input-validation/process-invocation hygiene bugs with a narrow genuine risk delta (askpass-file/environment exposure to a same-machine attacker who'd otherwise need one more step), not Critical/full-compromise findings.

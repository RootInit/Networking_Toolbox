# Independent Verification — SSH-001 / SSH-002 (second pass, adversarial)

Verdict: **CONFIRMED** (both SSH-001 and SSH-002, plus SEC-3's corroborating trace)

## What I checked, independently

### 1. Username validation at ingestion (`lib/WebServer.ps1`)

`Invoke-SaveConfigAction` (around line 700-736) is the only write site for
`$script:JunosUsername`:

```
lib/WebServer.ps1:727-729
if ($Parsed.credentials) {
    $script:JunosUsername = [string]$Parsed.credentials.username
    $script:JunosPassword = [string]$Parsed.credentials.password
}
```

`$Parsed` is `ConvertFrom-Json` of the raw POST body (`$Body`). No regex, no
character-class check, no length check — a plain `[string]` cast. Grepped every
`username` occurrence in `WebServer.ps1` (16 hits): the *only* other checks
anywhere near `Username` are `[string]::IsNullOrWhiteSpace($JunosUsername)` guards
in `Invoke-ConnectAction` (line 136), `Invoke-RescanAction` (line 175), and
`Invoke-ScanNetworkAction` (line 443) — presence checks, not format checks. This
is a real, confirmed asymmetry with `$TargetIP`, which the same file locks to
`^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$` at every call site (verified this pattern
appears repeatedly guarding IP inputs; username has no equivalent anywhere in the
file). I found no client-side-only gate that would matter either way, since the
config-save endpoint accepts a direct POST body and there's no server-side schema
enforcement — a hand-crafted request bypasses any UI-level input `pattern=`
attribute trivially.

**Conclusion: the claimed missing-validation premise holds exactly as described.**

### 2. `Get-JunosSshArgs` (`lib/SshHelpers.ps1:76-85`)

```powershell
function Get-JunosSshArgs {
    param([Parameter(Mandatory=$true)][string]$Username, [Parameter(Mandatory=$true)][string]$TargetIP)
    return @("-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3",
             "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=NUL",
             "-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no",
             "$Username@$TargetIP")
}
```

This returns a PowerShell array of tokens, but the *last* token is built by raw
string interpolation of `$Username` with no quoting/escaping applied at this
layer — the function has no opinion about how its caller will serialize the
array. Whether that matters depends entirely on how the caller turns the array
back into a process invocation, which is where I focused next (this is exactly
where a "the array itself is safe" counter-argument could live, and it doesn't
hold up).

### 3. Every process-start call site (`Connect-Switch.ps1`, `Get-JunosNodeData.ps1`)

**`lib/Connect-Switch.ps1:42`:**
```powershell
$ProcInfo = New-Object System.Diagnostics.ProcessStartInfo("ssh.exe", ($SshArgs -join ' '))
```

**`lib/Get-JunosNodeData.ps1:35`:**
```powershell
$ProcInfo = New-Object System.Diagnostics.ProcessStartInfo("cmd.exe", "/c ssh.exe $($SshArgs -join ' ') > `"$TempOut`" 2> `"$TempErr`"")
```

Both use the **two-argument `ProcessStartInfo(string fileName, string arguments)`
constructor**, which sets the `.Arguments` *string* property — not
`.ArgumentList` (the `Collection<string>` property that does per-element Win32
quoting/escaping on `.NET Core`/PowerShell 7). I confirmed by grep that
`ArgumentList` is used exactly once in the whole `lib/` tree (`WebServer.ps1:156`,
for launching `powershell.exe` itself with a `-File`/`-Command` script path built
by the codebase, not with attacker data) — it is never used for the ssh.exe
invocation in either call site under review.

This is the crux of whether the finding is real, and I actively looked for a
counter-argument here (the advisor prompt specifically asks for this). The
candidate rebuttal would be: "`.Arguments` as a string still gets safely
requoted by .NET before hitting `CreateProcess`." That is false — `.NET`'s
`Process.Start` with a string `Arguments` property passes it through **verbatim**,
concatenated after the quoted `FileName`, as the `lpCommandLine` argument to the
Win32 `CreateProcess` API. There is no escaping/re-quoting step for the
`Arguments` string itself — that safety mechanism exists *only* for
`ArgumentList`, precisely because `ArgumentList` is a structured argv array and
`.NET` knows the split points, whereas a raw `Arguments` string is defined to
already be exactly what the child process's command line should contain. This is
documented .NET behavior, not a guess, and it's the standard root cause pattern
for this class of Windows command-injection bug (equivalent to `shell=True` with
string concatenation in other ecosystems). So: no hidden protection here — this
confirms the array is turned into a single raw command-line string with the
join, at exactly the point SSH-001 claims.

Given that, a literal space character embedded in `$Username` (e.g.
`admin -oProxyCommand=calc.exe x`) becomes, after `-join ' '`:

```
-o ConnectTimeout=5 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o PreferredAuthentications=password -o PubkeyAuthentication=no admin -oProxyCommand=calc.exe x@<TargetIP>
```

...as the single `Arguments` string handed to `CreateProcess("ssh.exe", <that string>)`.
`ssh.exe`'s own argv parsing (Win32-OpenSSH does standard `getopt`-style option
parsing, which by default permutes/accepts options interspersed with
positionals) then sees `-oProxyCommand=calc.exe` as a **bona fide `-o` option**
independent of the two flanking tokens `admin` and `x@<TargetIP>` that were
originally meant to be one atomic `$Username@$TargetIP` argument. OpenSSH
executes `ProxyCommand` via a shell (`/bin/sh -c` on POSIX; `cmd /c` via
`CreateProcess` on the Win32 port) as part of establishing the transport,
*before* authentication — so it fires regardless of whatever credentials
end up (or fail to) authenticate. This matches the SSH-001 claim precisely,
including the detail that the `PreferredAuthentications`/`PubkeyAuthentication`
hardening earlier in the same option list does not gate `ProxyCommand`, since
that hardening only constrains the auth phase that comes after transport setup.

### 4. SSH-002 — the `cmd.exe /c` layer specifically

`Get-JunosNodeData.ps1:35` goes one step further than `Connect-Switch.ps1`: it
launches `cmd.exe /c "ssh.exe <args> > ... 2> ..."` — i.e. the joined args string
(embedding `$Username`) is itself substring of a **shell** command line, not
just a raw argv-splitting target. This reintroduces `cmd.exe` metacharacters
(`&`, `|`, `^`, `%...%`, redirection) as a *second*, broader injection class on
top of SSH-001's whitespace/option-injection class — a payload like
`admin & calc.exe & echo ` does not even need to be valid `ssh` option syntax; it
only needs to be valid `cmd.exe` syntax, which is a lower bar. I confirmed there
is no character escaping of `$SshArgs`/`$Username` anywhere before this string is
assembled (`Get-JunosNodeData.ps1:30-39`, reproduced above) — the redirection
target paths (`$TempOut`/`$TempErr`) are the only things the code bothers to
wrap in literal doubled backtick-quotes; the untrusted segment is not.

This exactly matches SEC-3's independent framing of the same code path (which
that reviewer correctly noted is *currently* gated only by the `TargetIP`
regexes, not by anything protecting `$Username` — and indeed nothing protects
`$Username` at all, unlike `TargetIP`).

### 5. Hunting for a guard I might have missed

I specifically searched for:
- Any `-replace`, `Trim`, `[regex]::Match`/`IsMatch`, or `ValidatePattern` applied
  to `Username`/`credentials.username` anywhere in `lib/*.ps1` or `web-src/*.js`
  — none found beyond the client-side HTML form (irrelevant against a direct
  POST, and I did not even find a `pattern=` attribute worth noting as a UX nicety).
- Any use of `ArgumentList` for the ssh.exe/cmd.exe process starts — none; only
  the one unrelated use for `powershell.exe` startup in `WebServer.ps1:156`.
- Any per-argument escaping/quoting helper (a hand-rolled Win32
  quote-wrapping function) anywhere in `lib/` — none exists in this codebase.
- Whether `ProcessStartInfo.Arguments` (string) is silently re-quoted by
  `Process.Start` on `.NET` — it is not; that is exactly what distinguishes it
  from `ArgumentList`.

None of these produced a safe-guard. I could not construct a credible rebuttal.

## Verdict

**CONFIRMED** for both SSH-001 and SSH-002, exactly as filed, with the following
precise reproduction:

1. POST to the config-save endpoint (`Invoke-SaveConfigAction`, reached via
   whatever route handles a config save) with
   `credentials.username = "admin -oProxyCommand=calc.exe x"` (no other gate
   rejects this — `IsNullOrWhiteSpace` only checks the string is non-empty).
2. This is stored verbatim into `$script:JunosUsername` (`WebServer.ps1:728`).
3. Any subsequent `/api/connect`, `/api/rescan`, or `/api/scan-network` call
   passes it to `Get-JunosSshArgs`, which appends it unescaped as
   `"$Username@$TargetIP"` (`SshHelpers.ps1:84`).
4. `Connect-Switch.ps1:42` joins the array with spaces and hands the resulting
   string to `ProcessStartInfo("ssh.exe", <string>)`'s `.Arguments` property,
   which `Process.Start`/`CreateProcess` passes through unmodified as the raw
   Win32 command line — no re-quoting occurs for a string `.Arguments` value.
   `Get-JunosNodeData.ps1:35` additionally wraps the same joined string inside a
   `cmd.exe /c "..."` string (SSH-002), adding shell-metacharacter injection on
   top of the argv-splitting issue.
5. `ssh.exe` (or `cmd.exe`, for SSH-002) receives `-oProxyCommand=calc.exe` as a
   genuine option (or a genuine shell metacharacter sequence for SSH-002) and
   executes it as part of establishing the SSH transport, before authentication,
   independent of whatever credential material is or isn't valid.

This is CONFIRMED (code-trace, not executed against a live device/OS — same
caveat the original finding already carries), not merely CONFIRMED-UNTESTABLE,
because every step is directly evidenced in the current source with no
speculative gap: the missing input validation, the exact string-building code,
and the .NET API behavior for the string-`Arguments` code path are all
independently documented/verifiable facts, not inferred behavior.

No basis found for REJECTED or DOWNGRADED. Severity (Critical) and confidence
(High) as filed both hold up under this second, independent pass.

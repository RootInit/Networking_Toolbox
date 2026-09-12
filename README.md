# Networking_Toolbox

Misc networking tools and scripts created by me or stolen from other people.

- [`PS_NetworkMapper/`](#ps_networkmapper) — crawls a Juniper switch fleet over SSH and renders an interactive topology map in the browser.
- [`PS_IPv4Scanner/`](#ps_ipv4scanner) — async IPv4 range/subnet scanner with optional MAC/vendor resolution.
- [`Windows Server/`](#windows-server) — standalone WinForms GUIs for Active Directory and NPS/RADIUS admin.

All are PowerShell; run them under Windows PowerShell 5.1 or PowerShell 7+ (`pwsh`).
PS_NetworkMapper's encryption additionally needs **.NET Framework 4.7.2 or newer** under 5.1 —
earlier versions cannot derive keys with SHA-256, and the mapper refuses to start rather than write
a file it could not read back. Pass `-NoEncryption` to run without it.

---

## PS_NetworkMapper

Crawls a Juniper (Junos) switch fleet from one seed IP, walks LLDP/neighbor data out across the
network, and serves the result as an interactive map in your browser (topology graph, per-device
config, client lists, history/diffing between snapshots).

### Quick start

```powershell
cd PS_NetworkMapper

# Crawl the fleet starting at a switch, then open the viewer
.\Start-NetworkMapper.ps1 -SwitchIP 131.30.1.1

# Just open the viewer against snapshots already in Network_Maps/, no crawl
.\Start-NetworkMapper.ps1
```

The first run prompts for an encryption password. It protects `Configuration.json.enc` (Juniper SSH
credentials + app settings) and, unless `-NoEncryption` is passed, the topology snapshots and config
backups in `Network_Maps/`. The same password is entered again in the browser to decrypt an opened
snapshot — nothing is written to disk unencrypted by default.

The script opens `http://localhost:8787` (or whatever `-WebPort` you chose) for you.

### Parameters

| Parameter | Default | Description |
|---|---|---|
| `-SwitchIP` | *(none)* | Seed IP to start crawling from. Omit to launch the viewer only, against existing snapshots. |
| `-AllowedScopes` | `131.30.` | IP prefixes the crawl is allowed to follow — keeps it from wandering off the intended network. |
| `-MaxConcurrent` | `10` | Max concurrent SSH connections during a crawl. |
| `-Log` | off | Save raw device payloads to `.\RawDumps\` for debugging. |
| `-NoEncryption` | off | No password prompt; snapshots/config written as plain `.json` (uses `Configuration.json`). |
| `-WebPort` | `8787` | Local port for the viewer/API server (bound to localhost only). |

### Layout

- `Start-NetworkMapper.ps1` — entry point.
- `lib/` — crawl engine, SSH/Junos helpers, encryption, web server, and the built single-file
  visualizer (`Network_Visualizer.html`). This is everything a release needs; `web-src/` is not shipped.
- `web-src/` — dev source for the visualizer. Run `web-src/tools/build-inline.mjs` to rebuild
  `lib/Network_Visualizer.html` after changing anything here.
- `Network_Maps/` — crawl output: one timestamped snapshot per run, used for history/diffing.

Device metadata (map pin coordinates, building/room, notes), Juniper credentials and map/alert
thresholds live in `Configuration.json.enc` next to the script, editable from the web UI's Settings
tab.

Snapshots are keyed by device serial across crawls, not IP, so history and diffing survive
renumbering. The web server binds to `localhost` only.

### Encrypting/decrypting files offline (`Protect-MapperFile.ps1`)

`lib/Protect-MapperFile.ps1` encrypts or decrypts a snapshot or `Configuration.json[.enc]` outside a
live session — to inspect an encrypted file, re-encrypt a `-NoEncryption` snapshot, rotate onto a new
password, or hand a decrypted copy to another tool. Nothing calls it automatically:

```powershell
cd PS_NetworkMapper\lib

.\Protect-MapperFile.ps1 -InputFile .\Network_Maps\NetworkMap_2026-08-28_120000.json          # encrypt
.\Protect-MapperFile.ps1 -InputFile .\Network_Maps\NetworkMap_2026-08-28_120000.json.enc -Decrypt
.\Protect-MapperFile.ps1 -InputFile .\Configuration.json.enc -Decrypt -OutputFile plain.json
```

It uses the same AES-256-CBC + PBKDF2-SHA256 (600,000 iterations) + HMAC-SHA256 encrypt-then-MAC
envelope as the rest of the app (shared via `TopologyCrypto.ps1`), so its output opens normally in
`Start-NetworkMapper.ps1` and the web UI.

| Parameter | Default | Description |
|---|---|---|
| `-InputFile` | *(required)* | File to encrypt or decrypt. |
| `-OutputFile` | *(derived)* | Encrypting: input + `.enc`. Decrypting: `.enc` stripped, or `<input>.decrypted.json`. |
| `-Decrypt` | off | Reverses the default action. |
| `-Type` | `Auto` | Envelope format to stamp when encrypting. `Auto` detects `Configuration.json(.enc)` as `Config`, anything else as `Topology`; a config stamped with the wrong format is rejected at load. |
| `-Password` | *(prompted)* | A `[securestring]`, for non-interactive use. |
| `-Force` | off | Skip the overwrite confirmation. |

It refuses to double-wrap an already-encrypted file, verifies the HMAC before decrypting (so a wrong
password fails cleanly rather than as a padding exception), and supports `-WhatIf`/`-Confirm`.

---

## PS_IPv4Scanner

Async IPv4 scanner (`Ipv4Scan.ps1`) for an address range or a subnet given as address + mask/CIDR,
with optional port check, DNS resolution, and MAC/vendor lookup (via `oui.txt`, refreshed by
`getOUI.ps1`).

```powershell
cd PS_IPv4Scanner

.\Ipv4Scan.ps1 -StartIPv4Address 192.168.178.0 -EndIPv4Address 192.168.178.20
.\Ipv4Scan.ps1 -IPv4Address 192.168.178.0 -Mask 255.255.255.0 -DisableDNSResolving
.\Ipv4Scan.ps1 -IPv4Address 192.168.178.0 -CIDR 24 -Port 22
.\Ipv4Scan.ps1 -IPv4Address 192.168.178.0 -CIDR 25 -EnableMACResolving

.\getOUI.ps1          # refresh oui.txt from the IEEE registry
```

`Get-Help .\Ipv4Scan.ps1 -Full` documents every option.

---

## Windows Server

Two standalone WinForms GUIs for running a MAC Authentication Bypass (MAB) setup on Windows Server:
one registers device MACs as AD accounts, the other reads back what NPS did with them. They share no
code and neither depends on the other.

### `Register-MacDevice.ps1`

Registers MAC-based device accounts in Active Directory. Enter a single MAC, or pick a text file with
one per line; each account is created in the configured OU, added to the device group, and optionally
stripped of every other group membership. Any separator style is accepted (`aa:bb:...`, `aa-bb-...`,
`aabb.ccdd.eeff`, bare hex). A checkbox switches on overwrite (delete + recreate) for existing MACs;
results are tallied per run and for the session.

Edit the CONFIG block at the top — `$OUPath`, `$GroupName`, `$TempPassword`, `$StripOtherGroups` —
before first use; the OU and group must already exist. Needs RSAT and rights to create users in the
target OU; without them the GUI still opens and reports why it can't connect.

### `Show-NpsMacAuth.ps1`

Reads NPS audit events from the Security log — 6272 (granted), 6273 (denied), 6274 (discarded), 6276
(quarantined), 6277 (probation), 6278 (full access) — pulls the RADIUS Calling-Station-ID out of each,
normalizes it to a MAC, and de-duplicates into two sortable lists: authenticated and denied. Denied
rows carry the NPS reason code and text. Double-click a row for the raw event; per-pane buttons copy
the MAC list or export to CSV.

The query runs on a background runspace, so the window stays responsive. The server box accepts a
remote NPS host (Event Log RPC — TCP 135 + dynamic RPC, not WinRM) with optional alternate
credentials. Run elevated: reading the Security log needs it, and the title bar says so if you didn't.

```powershell
.\Show-NpsMacAuth.ps1                              # local server, last 24h
.\Show-NpsMacAuth.ps1 -ComputerName NPS01 -Hours 168
```

| Parameter | Default | Description |
|---|---|---|
| `-ComputerName` | local machine | NPS server to query. Editable in the GUI too. |
| `-Hours` | `24` | How far back to read. Editable in the GUI too. |

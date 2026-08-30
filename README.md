# Networking_Toolbox

Misc networking tools and scripts created by me or stolen from other people.

## Contents

- [`PS_NetworkMapper/`](#ps_networkmapper) — crawls a Juniper switch fleet over SSH and renders an interactive topology map in the browser.
- [`PS_IPv4Scanner/`](#ps_ipv4scanner) — async IPv4 range/subnet scanner with optional MAC/vendor resolution.

Both are PowerShell scripts; run them with either Windows PowerShell 5.1 or PowerShell 7+ (`pwsh`).

---

## PS_NetworkMapper

Crawls a Juniper (Junos) switch fleet starting from one seed IP, walks LLDP/neighbor
data out across the network, and serves the result as an interactive map in your
browser (topology graph, per-device config, client lists, history/diffing between
snapshots).

### Quick start

```powershell
cd PS_NetworkMapper

# Crawl the fleet starting at a switch, then open the viewer
.\Start-NetworkMapper.ps1 -SwitchIP 131.30.1.1

# Just open the viewer against snapshots already in Network_Maps/, no crawl
.\Start-NetworkMapper.ps1
```

The first run prompts for an encryption password. This password protects
`Configuration.json.enc` (Juniper SSH credentials + app settings) and, unless
`-NoEncryption` is passed, the topology snapshots and config backups written to
`Network_Maps/`. The same password is entered again in the browser to decrypt an
opened snapshot — nothing is ever written to disk unencrypted by default.

Once running, open a browser to `http://localhost:8787` (or whatever `-WebPort` you
chose) — `Start-NetworkMapper.ps1` opens it for you automatically.

### Parameters

| Parameter | Default | Description |
|---|---|---|
| `-SwitchIP` | *(none)* | Seed IP to start crawling from. Omit to launch the viewer only, against existing snapshots. |
| `-AllowedScopes` | `131.30.` | IP prefixes the crawl is allowed to follow — keeps it from wandering off the intended network. |
| `-MaxConcurrent` | `10` | Max concurrent SSH connections during a crawl. |
| `-Log` | off | Save raw device payloads to `.\RawDumps\` for debugging. |
| `-NoEncryption` | off | Disable encryption entirely: no password prompt, snapshots/config written as plain `.json` (uses `Configuration.json` instead of `Configuration.json.enc`). |
| `-WebPort` | `8787` | Local port for the viewer/API server (bound to localhost only). |

### Configuration

Device metadata (map pin coordinates, building/room, notes), Juniper credentials, and
map/alert thresholds live in `Configuration.json.enc` (or `Configuration.json` under
`-NoEncryption`), next to the script. See `Configuration.example.json` for the shape —
it's editable from the web UI's Settings tab, so you generally don't need to hand-edit
the file.

### Layout

- `Start-NetworkMapper.ps1` — entry point (see above).
- `lib/` — crawl engine, SSH/Junos helpers, encryption, web server, and the built
  single-file visualizer (`Network_Visualizer.html`). This is everything a release
  needs — `web-src/` is not shipped.
- `web-src/` — the dev source tree for the visualizer (multi-file JS/HTML). Run
  `web-src/tools/build-inline.mjs` to rebuild `lib/Network_Visualizer.html` as a
  single self-contained file after making changes here.
- `Network_Maps/` — crawl output: one timestamped snapshot per run (`.json` or
  `.json.enc`), used for history/diffing and reopened by "Load Folder of Snapshots"
  in the viewer.

### Notes

- The web server only binds to `localhost` — it's not exposed on the LAN.
- Snapshots are keyed by device serial number across crawls (not IP), so history and
  diffing survive IP changes.

### Encrypting/decrypting files offline (`Protect-MapperFile.ps1`)

`lib/Protect-MapperFile.ps1` is a standalone CLI for encrypting or decrypting a
topology snapshot (`Network_Maps\NetworkMap_*.json[.enc]`) or `Configuration.json[.enc]`
outside of a live crawl/webserver session — e.g. to inspect an encrypted file offline,
re-encrypt a plaintext snapshot captured under `-NoEncryption`, rotate a file onto a
new password, or hand a decrypted copy to another tool. It's not part of the app's
runtime (nothing calls it automatically); run it directly:

```powershell
cd PS_NetworkMapper\lib

# Encrypt a plaintext snapshot (default action)
.\Protect-MapperFile.ps1 -InputFile .\Network_Maps\NetworkMap_2026-08-28_120000.json

# Decrypt a snapshot back to plaintext
.\Protect-MapperFile.ps1 -InputFile .\Network_Maps\NetworkMap_2026-08-28_120000.json.enc -Decrypt

# Decrypt to a specific output path
.\Protect-MapperFile.ps1 -InputFile .\Configuration.json.enc -Decrypt -OutputFile plain.json
```

It uses the exact same AES-256-CBC + PBKDF2-SHA256 (600,000 iterations) +
HMAC-SHA256 encrypt-then-MAC envelope as the rest of the app (shared via
`TopologyCrypto.ps1`), so anything it produces opens normally in
`Start-NetworkMapper.ps1`/the web UI, and vice versa.

| Parameter | Default | Description |
|---|---|---|
| `-InputFile` | *(required)* | File to encrypt or decrypt. |
| `-OutputFile` | *(derived)* | Encrypting: input path + `.enc`. Decrypting: input path with `.enc` stripped, or `<input>.decrypted.json` if it didn't end in `.enc`. |
| `-Decrypt` | off | Reverses the default action (encrypt → decrypt). |
| `-Type` | `Auto` | Envelope format to stamp when encrypting: `Auto` detects `Configuration.json(.enc)` as `Config` and anything else as `Topology`. Only override this if the file doesn't follow the app's own naming — `Start-NetworkMapper.ps1` refuses to load a config file stamped with the wrong format. |
| `-Password` | *(prompted)* | Pass a `[securestring]` for non-interactive/scripted use instead of the interactive prompt. |
| `-Force` | off | Skip the overwrite confirmation if the output file already exists. |

Safety behavior worth knowing:
- Refuses to encrypt a file that's already an encrypted envelope (would otherwise
  silently double-wrap ciphertext into something nothing can decrypt back to the
  original data).
- On decrypt, the HMAC is verified before decryption — a wrong password or corrupted
  file fails with a clear error instead of a padding exception or garbage output.
- Supports `-WhatIf`/`-Confirm` (it's `SupportsShouldProcess`) in addition to `-Force`.

---

## PS_IPv4Scanner

Async IPv4 scanner (`Ipv4Scan.ps1`) for a start/end address range or a subnet given as
address + mask/CIDR, with optional port check, DNS resolution, and MAC/vendor lookup
(via `oui.txt`, refreshed by `getOUI.ps1`).

### Usage

```powershell
cd PS_IPv4Scanner

# Address range
.\Ipv4Scan.ps1 -StartIPv4Address 192.168.178.0 -EndIPv4Address 192.168.178.20

# Subnet by mask, skip DNS lookups
.\Ipv4Scan.ps1 -IPv4Address 192.168.178.0 -Mask 255.255.255.0 -DisableDNSResolving

# Subnet by CIDR, check a specific port
.\Ipv4Scan.ps1 -IPv4Address 192.168.178.0 -CIDR 24 -Port 22

# Subnet by CIDR with MAC/vendor resolution
.\Ipv4Scan.ps1 -IPv4Address 192.168.178.0 -CIDR 25 -EnableMACResolving
```

Run `Get-Help .\Ipv4Scan.ps1 -Full` for the complete parameter list — the script's
comment-based help documents every option and example.

### Refreshing the vendor database

`oui.txt` (MAC OUI → vendor name) is used for `-EnableMACResolving`. Refresh it from
the IEEE registry with:

```powershell
.\getOUI.ps1
```

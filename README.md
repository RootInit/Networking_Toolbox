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

Crawls a Juniper (Junos) switch fleet from one seed IP, walks LLDP neighbor data out across the
network, and serves the result as an interactive dashboard in your browser: topology graph, chassis
faceplates, per-device config, client lists, and diffing between snapshots.

```powershell
cd PS_NetworkMapper
.\Start-NetworkMapper.ps1                        # viewer only, against existing snapshots
.\Start-NetworkMapper.ps1 -SwitchIP 192.0.2.1    # crawl from a seed switch, then open the viewer
```

Your switch login and the IP prefixes a crawl may follow are set in the viewer's Settings tab and
stored encrypted — neither has a default, and the crawl refuses to start until the scopes are set.

**→ [`PS_NetworkMapper/README.md`](PS_NetworkMapper/README.md)** for screenshots, how the crawl works,
the security model, and every parameter.

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

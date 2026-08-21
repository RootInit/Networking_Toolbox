// The right-hand device detail drawer: all seven tabs (Summary/Hardware/Alarms/Neighbors/
// Interfaces/Clients/Config), CSV/config export, the printable report, and the drawer's
// own open/close/tab-switch chrome. Reads currentSelectedNodeData/deviceByIp/
// loadedSnapshots/activeSnapshotIndex/searchHighlightQuery (app.js), calls
// window.asArray/lookupVendor/detectDaisyChains/renderDaisyChainBadge/setStatus
// (utils.js), and configSetDiff (dashboard.js, plain function - see its own comment).

window.closeDrawer = function() {
    document.getElementById('right-panel').style.display = 'none';
    currentSelectedNodeData = null;
    if (network) network.unselectAll();
};

window.switchTab = function(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    document.getElementById('btn-' + tabId).classList.add('active');

    if (currentSelectedNodeData) {
        if (tabId === 'tab-neighbors') window.renderNeighbors();
        if (tabId === 'tab-interfaces') window.renderInterfaces();
        if (tabId === 'tab-clients') window.renderClients();
    }
};

// SSH quick-connect: a browser page can't spawn a process (no such API exists in any
// mainstream browser, confirmed - not a workaroundable gap), but it CAN write to the
// clipboard reliably when triggered by a real click (also confirmed - a bare script call
// with no user gesture behind it fails). So the realistic "quick connect" is one click to
// copy the command, one paste into a terminal - see Network_Mapper/lib/Connect-Switch.ps1.
// The path assumes the terminal's CWD is Network_Mapper/ (where Start-NetworkMapper.ps1
// itself lives, so a user already running crawls from there needs no extra `cd`).
window.copyConnectCommand = async function() {
    var ip = document.getElementById('drawer-title').innerText;
    if (!ip) return;
    var command = `pwsh -File "lib\\Connect-Switch.ps1" -TargetIP ${ip}`;
    var btn = document.getElementById('copyConnectBtn');
    try {
        await navigator.clipboard.writeText(command);
        if (btn) {
            var original = btn.textContent;
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = original; }, 1500);
        }
        window.setStatus(`Copied to clipboard: ${command}`, "green");
    } catch (e) {
        window.setStatus("Could not copy to clipboard: " + e.message, "red");
    }
};

window.openRightDrawer = function(ip) {
    currentSelectedNodeData = deviceByIp.get(String(ip));
    var panel = document.getElementById('right-panel');
    document.getElementById('drawer-title').innerText = ip;

    if (!currentSelectedNodeData) {
        document.getElementById('summary-content').innerHTML = `<div style="color:red; padding:20px;">No diagnostic data found (Unscanned Node).</div>`;
        panel.style.display = 'flex';
        return;
    }

    window.renderSummary();
    window.renderStack();
    window.renderNeighbors();
    window.renderInterfaces();
    window.renderClients();
    window.renderConfig();

    panel.style.display = 'flex';
};

window.renderSummary = function() {
    var d = currentSelectedNodeData;
    var alarms = window.asArray(d.Alarms);
    var alarmsHtml = alarms.length > 0
        ? `<span class="badge red">${alarms.length} ACTIVE</span>`
        : `<span class="badge green">None</span>`;

    var html = `
        <div class="summary-item"><label>Hostname</label><div>${esc(d.Hostname) || 'N/A'}</div></div>
        <div class="summary-item"><label>IP Address</label><div>${esc(d.DeviceIP) || 'N/A'}</div></div>
        <div class="summary-item"><label>Junos OS</label><div>${esc(d.JunosVersion) || 'N/A'}</div></div>
        <div class="summary-item"><label>Gateway</label><div>${esc(d.Gateway) || 'N/A'}</div></div>
        <div class="summary-item"><label>Connected Neighbors</label><div>${d.Neighbors ? d.Neighbors.length : 0} Switches</div></div>
        <div class="summary-item"><label>Uptime</label><div>${esc(d.Uptime) || 'N/A'}</div></div>
        <div class="summary-item"><label>Last Configured</label><div>${esc(d.LastConfigured) || 'N/A'} by ${esc(d.LastConfiguredBy) || 'N/A'}</div></div>
        <div class="summary-item"><label>RE CPU / Memory</label><div>${esc(d.MasterCpuUtilization) || 'N/A'} / ${esc(d.MasterMemoryUtilization) || 'N/A'}</div></div>
        <div class="summary-item"><label>Chassis Alarms</label><div>${alarmsHtml}</div></div>
    `;
    document.getElementById('summary-content').innerHTML = html;

    var alarmsTbody = document.getElementById('alarms-tbody');
    if (alarmsTbody) {
        alarmsTbody.innerHTML = alarms.length > 0
            ? alarms.map(a => `<tr>
                <td><span class="badge ${String(a.Class).toLowerCase() === 'major' ? 'red' : 'accent'}">${esc(a.Class)}</span></td>
                <td>${esc(a.Time)}</td>
                <td>${esc(a.Description)}</td>
              </tr>`).join('')
            : `<tr><td colspan="3" style="text-align:center;">No active alarms</td></tr>`;
    }
};

window.renderStack = function() {
    var tbody = document.getElementById('stack-tbody');
    var html = "";
    if (currentSelectedNodeData.StackMembers && currentSelectedNodeData.StackMembers.length > 0) {
        currentSelectedNodeData.StackMembers.forEach(sm => {
            var roleBadge = String(sm.Role).includes("Master") ? "green" : (String(sm.Role).includes("Backup") ? "accent" : "gray");
            html += `<tr>
                <td><b>${esc(sm.FPC) || "?"}</b></td>
                <td><span class="badge ${roleBadge}">${esc(sm.Role) || "?"}</span></td>
                <td>${esc(sm.Model) || "?"}</td>
                <td style="font-family:monospace;">${esc(sm.Serial) || "?"}</td>
            </tr>`;
        });
    }
    tbody.innerHTML = html || `<tr><td colspan="4" style="text-align:center;">No hardware data</td></tr>`;
};

window.renderNeighbors = function() {
    var tbody = document.getElementById('neighbors-tbody');
    var html = "";
    if (currentSelectedNodeData.Neighbors && currentSelectedNodeData.Neighbors.length > 0) {
        currentSelectedNodeData.Neighbors.forEach(n => {
            html += `<tr>
                <td><b>${esc(n.LocalPort) || "?"}</b></td>
                <td>${esc(n.Hostname) || "Unknown"}<br><span style="font-family:monospace; color:#666; font-size:0.75rem;">${esc(n.ManagementIP) || "Unknown"}</span></td>
                <td>${esc(n.RemotePort) || "?"}</td>
                <td style="font-style:italic; color:#666;">${esc(n.Description)}</td>
            </tr>`;
        });
    }
    tbody.innerHTML = html || `<tr><td colspan="4" style="text-align:center;">No LLDP neighbors found</td></tr>`;
};

window.renderInterfaces = function() {
    var tbody = document.getElementById('interfaces-tbody');
    var hideDown = document.getElementById('hideDownPorts').checked;
    var daisyChains = window.detectDaisyChains(currentSelectedNodeData);
    var html = "";

    if (currentSelectedNodeData.Interfaces && Array.isArray(currentSelectedNodeData.Interfaces)) {
        currentSelectedNodeData.Interfaces.forEach(intf => {
            if (!intf.Port || String(intf.Port).includes('.')) return;

            if (hideDown && String(intf.Link).toLowerCase() !== "up") return;

            var linkBadge = String(intf.Link).toLowerCase() === "up" ? "green" : "red";
            var stpBadge = String(intf.STP) === "FWD" ? "green" : (String(intf.STP) === "BLK" ? "red" : "gray");
            var poeTxt = (!intf.PoE || intf.PoE === "Unknown") ? "-" : intf.PoE;

            var chain = daisyChains.get(window.normalizePort(intf.Port));
            var daisyStr = chain
                ? `<br>${window.renderDaisyChainBadge(chain)}`
                : "";

            html += `<tr>
                <td><b>${esc(intf.Port)}</b>${daisyStr}</td>
                <td><span class="badge ${linkBadge}">${esc(intf.Admin)}/${esc(intf.Link)}</span></td>
                <td><span class="badge ${stpBadge}">${esc(intf.STP) || "?"}</span></td>
                <td>${esc(poeTxt)}</td>
                <td style="font-style:italic; color:#666;">${esc(intf.Desc)}</td>
            </tr>`;
        });
    }
    tbody.innerHTML = html || `<tr><td colspan="5" style="text-align:center;">No interface data</td></tr>`;
};

window.renderClients = function() {
    var tbody = document.getElementById('clients-tbody');
    var vlanFilter = document.getElementById('vlanFilter').value;
    var daisyChains = window.detectDaisyChains(currentSelectedNodeData);
    var html = "";

    if (currentSelectedNodeData.TrueClients && currentSelectedNodeData.TrueClients.length > 0) {
        var clients = currentSelectedNodeData.TrueClients;

        if (vlanFilter !== "ALL") {
            clients = clients.filter(c => String(c.VLAN_Tag) === vlanFilter.toString());
        }

        clients = clients.sort((a, b) => {
            if (a.IP === "Unknown IP") return 1; if (b.IP === "Unknown IP") return -1;
            var numA = Number(String(a.IP).split('.').map(n => (`000${n}`).slice(-3)).join(''));
            var numB = Number(String(b.IP).split('.').map(n => (`000${n}`).slice(-3)).join(''));
            return numA - numB;
        });

        clients.forEach(c => {
            var isHighlighted = searchHighlightQuery && ((c.IP && String(c.IP).toLowerCase().includes(searchHighlightQuery)) || (c.MAC && String(c.MAC).toLowerCase().includes(searchHighlightQuery)) || (c.Dot1x_User && String(c.Dot1x_User).toLowerCase().includes(searchHighlightQuery)));
            var rowClass = isHighlighted ? 'highlight' : '';

            var dotUserStr = (c.Dot1x_User && c.Dot1x_User !== "Unknown") ? esc(c.Dot1x_User) : "None";
            var dotStateColor = (c.Dot1x_State && String(c.Dot1x_State).includes('Auth')) ? 'green' : (c.Dot1x_State !== "Unknown" ? 'red' : 'gray');
            var dotStateStr = c.Dot1x_State !== "Unknown" ? `<br><span style="font-size:0.7rem; color:${dotStateColor};">(${esc(c.Dot1x_State)})</span>` : "";
            var descStr = (c.PortDesc && c.PortDesc !== "Unknown") ? `<br><span style="font-size:0.75rem; color:#888;">${esc(c.PortDesc)}</span>` : "";
            var typeClass = String(c.Type).toLowerCase().startsWith('dynamic') ? 'dynamic' : 'static';
            var typeStr = (c.Type && c.Type !== "Unknown") ? `<span class="type-badge ${typeClass}">${esc(c.Type)}</span>` : "";

            var vendorInfo = window.lookupVendor(c.MAC);
            var vendorStr = vendorInfo.vendor
                ? `<br><span class="vendor-tag vendor-${vendorInfo.category.toLowerCase().replace('/', '-')}" title="${esc(vendorInfo.vendor)}">${esc(vendorInfo.category)}</span>`
                : "";

            var chain = daisyChains.get(window.normalizePort(c.Port));
            var daisyStr = chain ? `<br>${window.renderDaisyChainBadge(chain)}` : "";

            html += `<tr class="${rowClass}">
                <td><span style="font-weight:bold; color:#2B7CE9; font-size:1rem;">${esc(c.IP)}</span><br><span style="font-family:monospace; color:#666;">${esc(String(c.MAC).toUpperCase())}</span>${vendorStr}</td>
                <td><b>${esc(c.Port)}</b><br><span class="badge" style="background:#2c3e50;">VLAN ${esc(c.VLAN_Tag)}</span>${typeStr}${descStr}${daisyStr}</td>
                <td><b>${dotUserStr}</b>${dotStateStr}</td>
            </tr>`;
        });
    }
    tbody.innerHTML = html || `<tr><td colspan="3" style="text-align:center;">No edge clients found</td></tr>`;

    if (searchHighlightQuery) {
        var highlightedEl = tbody.querySelector('.highlight');
        if (highlightedEl) highlightedEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
};

// CSV export - mirrors the currently displayed (filtered) rows for the selected switch,
// not the full unfiltered dataset, so what downloads matches what's on screen.
function csvEscapeField(val) {
    var s = (val === null || val === undefined) ? '' : String(val);
    if (/[",\r\n]/.test(s)) { s = '"' + s.replace(/"/g, '""') + '"'; }
    return s;
}

function downloadCsv(filename, rows) {
    var csv = rows.map(row => row.map(csvEscapeField).join(',')).join('\r\n');
    downloadBlob(filename, csv, 'text/csv;charset=utf-8;');
}

function downloadBlob(filename, content, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Config backup (see Get-JunosNodeData.ps1's Invoke-ConfigBackup) - stored verbatim, so
// this tab just displays/copies/downloads it as-is, no parsing or reformatting.
window.renderConfig = function() {
    var el = document.getElementById('config-content');
    if (!el) return;
    var config = currentSelectedNodeData && currentSelectedNodeData.Configuration;
    el.textContent = (config && config !== "Unknown") ? config : "No configuration backup available for this device.";
    window.populateConfigCompareSelect();
};

// Config diff (see configSetDiff in dashboard.js) - lets this device's Config tab compare
// its current config against the SAME device's config from any other loaded snapshot.
// Only offers snapshots that actually have a real config backup for this device; if none
// exist, the picker hides entirely rather than showing an empty/useless control.
window.populateConfigCompareSelect = function() {
    var container = document.getElementById('configCompareContainer');
    var select = document.getElementById('configCompareSelect');
    if (!container || !select) return;

    var d = currentSelectedNodeData;
    var hasOwnConfig = d && d.Configuration && d.Configuration !== "Unknown";
    var options = [];
    if (hasOwnConfig) {
        var ip = String(d.DeviceIP);
        loadedSnapshots.forEach((snap, idx) => {
            if (idx === activeSnapshotIndex) return;
            var other = (snap.topology || []).find(dev => dev && String(dev.DeviceIP) === ip);
            if (other && other.Configuration && other.Configuration !== "Unknown") {
                options.push({
                    idx: idx,
                    ts: snap.scanTimestamp ? new Date(snap.scanTimestamp).getTime() : 0,
                    label: snap.scanTimestamp ? new Date(snap.scanTimestamp).toLocaleString() : snap.sourceFile,
                });
            }
        });
    }

    if (options.length === 0) {
        container.style.display = 'none';
        document.getElementById('config-diff-content').style.display = 'none';
        document.getElementById('config-content').style.display = '';
        return;
    }

    options.sort((a, b) => b.ts - a.ts); // most recent other capture first
    select.innerHTML = '<option value="">-- Raw config only --</option>' + options.map(o => `<option value="${o.idx}">${esc(o.label)}</option>`).join('');
    select.value = '';
    container.style.display = 'flex';
    window.renderConfigDiff();
};

window.renderConfigDiff = function() {
    var select = document.getElementById('configCompareSelect');
    var diffEl = document.getElementById('config-diff-content');
    var rawEl = document.getElementById('config-content');
    if (!select || !diffEl || !rawEl) return;

    if (!select.value) {
        diffEl.style.display = 'none';
        rawEl.style.display = '';
        return;
    }

    var otherSnap = loadedSnapshots[parseInt(select.value, 10)];
    var d = currentSelectedNodeData;
    var other = otherSnap && (otherSnap.topology || []).find(dev => dev && String(dev.DeviceIP) === String(d.DeviceIP));
    var diff = configSetDiff(other ? other.Configuration : '', d.Configuration);

    diffEl.innerHTML = (diff.added.length === 0 && diff.removed.length === 0)
        ? '<div class="config-diff-empty">No differences - configuration is identical between these two snapshots.</div>'
        : diff.removed.map(l => `<div class="config-diff-line removed">- ${esc(l)}</div>`).join('')
          + diff.added.map(l => `<div class="config-diff-line added">+ ${esc(l)}</div>`).join('');
    diffEl.style.display = 'block';
    rawEl.style.display = 'none';
};

window.copyDeviceConfig = async function() {
    var config = currentSelectedNodeData && currentSelectedNodeData.Configuration;
    if (!config || config === "Unknown") { window.setStatus("No configuration backup available for this device.", "red"); return; }
    try {
        await navigator.clipboard.writeText(config);
        window.setStatus("Configuration copied to clipboard.", "green");
    } catch (e) {
        window.setStatus("Could not copy to clipboard: " + e.message, "red");
    }
};

window.downloadDeviceConfig = function() {
    var config = currentSelectedNodeData && currentSelectedNodeData.Configuration;
    if (!config || config === "Unknown") { window.setStatus("No configuration backup available for this device.", "red"); return; }
    var ip = currentSelectedNodeData.DeviceIP || 'device';
    downloadBlob(`${ip}_config.txt`, config, 'text/plain;charset=utf-8;');
};

// Printable device report - same "device needs to be replaced or restored" motivation as
// the config backup itself, but a full paper/PDF copy of everything captured about a
// device, not just its config. Opens a self-contained document in a new tab (no library,
// same "hand-roll it" pattern as everything else) with a visible Print button rather than
// auto-firing window.print() on open - avoids popup/timing edge cases around a new
// window's print dialog firing before content has settled, and lets the user review first.
window.printDeviceReport = function() {
    var d = currentSelectedNodeData;
    if (!d) { window.setStatus("No device selected.", "red"); return; }

    var alarms = window.asArray(d.Alarms);
    var stack = window.asArray(d.StackMembers);
    var neighbors = window.asArray(d.Neighbors);
    var interfaces = Array.isArray(d.Interfaces) ? d.Interfaces : [];
    var clients = d.TrueClients || d.Clients || [];

    function row(cells) { return `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`; }
    function table(headers, rows, emptyText) {
        return `<table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
            rows.length ? rows.join('') : `<tr><td colspan="${headers.length}">${esc(emptyText)}</td></tr>`
        }</tbody></table>`;
    }

    var html = `<!doctype html><html><head><meta charset="utf-8"><title>Device Report - ${esc(d.Hostname || d.DeviceIP)}</title>
<style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #222; margin: 0; padding: 30px; }
    h1 { margin: 0 0 4px; font-size: 1.5rem; }
    h2 { font-size: 1.05rem; margin: 28px 0 8px; border-bottom: 2px solid #2c3e50; padding-bottom: 4px; }
    .subtitle { color: #666; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.82rem; margin-bottom: 4px; }
    th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #ddd; }
    th { background: #f0f0f0; }
    pre { white-space: pre-wrap; word-break: break-word; background: #f7f7f7; border: 1px solid #ddd; padding: 12px; font-size: 0.75rem; }
    #printBar { margin-bottom: 20px; }
    #printBar button { font-size: 0.9rem; padding: 8px 16px; cursor: pointer; }
    @media print { #printBar { display: none; } body { padding: 0; } }
</style>
</head><body>
<div id="printBar"><button onclick="window.print()">Print / Save as PDF</button></div>
<h1>${esc(d.Hostname || 'Unknown')}</h1>
<div class="subtitle">${esc(d.DeviceIP)} &mdash; Junos ${esc(d.JunosVersion)} &mdash; report generated ${esc(new Date().toLocaleString())}</div>

<h2>Identity</h2>
${table(['Field', 'Value'], [
    row([esc('Gateway'), esc(d.Gateway)]),
    row([esc('Uptime'), esc(d.Uptime)]),
    row([esc('Last Configured'), `${esc(d.LastConfigured)} by ${esc(d.LastConfiguredBy)}`]),
    row([esc('RE CPU / Memory'), `${esc(d.MasterCpuUtilization)} / ${esc(d.MasterMemoryUtilization)}`]),
], '')}

<h2>Hardware</h2>
${table(['FPC', 'Role', 'Model', 'Serial'], stack.map(sm => row([esc(sm.FPC), esc(sm.Role), esc(sm.Model), esc(sm.Serial)])), 'No hardware data')}

<h2>Alarms</h2>
${table(['Class', 'Time', 'Description'], alarms.map(a => row([esc(a.Class), esc(a.Time), esc(a.Description)])), 'No active alarms')}

<h2>Neighbors</h2>
${table(['Local Port', 'Neighbor', 'Remote Port', 'Description'], neighbors.map(n => row([esc(n.LocalPort), `${esc(n.Hostname)} (${esc(n.ManagementIP)})`, esc(n.RemotePort), esc(n.Description)])), 'No LLDP neighbors found')}

<h2>Interfaces</h2>
${table(['Port', 'Admin', 'Link', 'STP', 'PoE', 'Description'], interfaces.map(i => row([esc(i.Port), esc(i.Admin), esc(i.Link), esc(i.STP), esc(i.PoE), esc(i.Desc)])), 'No interface data')}

<h2>Clients</h2>
${table(['IP', 'MAC', 'Port', 'VLAN', 'Dot1x User', 'Dot1x State'], clients.map(c => row([esc(c.IP), esc(c.MAC), esc(c.Port), esc(c.VLAN_Tag), esc(c.Dot1x_User), esc(c.Dot1x_State)])), 'No clients')}

<h2>Configuration Backup</h2>
<pre>${(d.Configuration && d.Configuration !== "Unknown") ? esc(d.Configuration) : 'No configuration backup available for this device.'}</pre>

</body></html>`;

    // A Blob URL navigation target, not document.write() - every dynamic field above is
    // already run through esc() (same escaping this codebase uses everywhere else for
    // device-supplied strings like hostnames/LLDP descriptions before innerHTML), so this
    // isn't fixing a missing-escape bug - it's just the cleaner, non-deprecated mechanism.
    // Deliberately NOT revoked: the new tab needs the URL to stay valid for as long as the
    // user keeps it open to review/print, unlike the click-and-forget CSV/config downloads
    // elsewhere in this file that revoke immediately after triggering a save.
    var blob = new Blob([html], { type: 'text/html' });
    var url = URL.createObjectURL(blob);
    var reportWindow = window.open(url, '_blank');
    if (!reportWindow) {
        URL.revokeObjectURL(url);
        window.setStatus("Could not open report - check your browser's popup blocker.", "red");
    }
};

window.exportInterfacesCsv = function() {
    if (!currentSelectedNodeData) { window.setStatus("Select a switch first.", "red"); return; }
    var hideDown = document.getElementById('hideDownPorts').checked;
    var rows = [['Port', 'Admin', 'Link', 'STP', 'PoE', 'Description']];

    (currentSelectedNodeData.Interfaces || []).forEach(intf => {
        if (!intf.Port || String(intf.Port).includes('.')) return;
        if (hideDown && String(intf.Link).toLowerCase() !== "up") return;
        var poeTxt = (!intf.PoE || intf.PoE === "Unknown") ? "-" : intf.PoE;
        rows.push([intf.Port, intf.Admin, intf.Link, intf.STP, poeTxt, intf.Desc]);
    });

    downloadCsv(`${currentSelectedNodeData.DeviceIP}_interfaces.csv`, rows);
};

window.exportClientsCsv = function() {
    if (!currentSelectedNodeData) { window.setStatus("Select a switch first.", "red"); return; }
    var vlanFilter = document.getElementById('vlanFilter').value;
    var clients = (currentSelectedNodeData.TrueClients || []).slice();

    if (vlanFilter !== "ALL") { clients = clients.filter(c => String(c.VLAN_Tag) === vlanFilter.toString()); }
    clients.sort((a, b) => {
        if (a.IP === "Unknown IP") return 1; if (b.IP === "Unknown IP") return -1;
        var numA = Number(String(a.IP).split('.').map(n => (`000${n}`).slice(-3)).join(''));
        var numB = Number(String(b.IP).split('.').map(n => (`000${n}`).slice(-3)).join(''));
        return numA - numB;
    });

    var rows = [['IP', 'MAC', 'Vendor', 'Category', 'Port', 'VLAN_Tag', 'Type', 'PortDesc', 'Dot1x_User', 'Dot1x_State']];
    clients.forEach(c => {
        var vendorInfo = window.lookupVendor(c.MAC);
        rows.push([c.IP, c.MAC, vendorInfo.vendor || '', vendorInfo.category, c.Port, c.VLAN_Tag, c.Type, c.PortDesc, c.Dot1x_User, c.Dot1x_State]);
    });

    downloadCsv(`${currentSelectedNodeData.DeviceIP}_clients.csv`, rows);
};

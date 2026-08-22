# HttpListener-based local webserver for Network_Visualizer. Zero-install by design -
# HttpListener ships in every .NET runtime this repo already targets (Framework 4.x via
# PS 5.1, and Core/5+ via pwsh), same reasoning as the AES/PBKDF2 primitives in
# Start-NetworkMapper.ps1. Localhost-only by design too: it binds "localhost" specifically
# (not "+" or a NIC address), so no netsh urlacl reservation and no admin rights are
# needed, and no auth is needed either, because the only thing this server can do beyond
# serve static files is spawn a process with the live switch credentials in Auth.json -
# that's only safe when "reaches this server" and "already runs as the person who owns
# Auth.json" are the same fact, which is true for localhost and false the moment this is
# ever rebound to a LAN address.
#
# Not meant to be run directly - dot-source it, then call Start-MapperWebServer.

$script:ContentTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".mjs"  = "application/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".svg"  = "image/svg+xml"
    ".png"  = "image/png"
    ".ico"  = "image/x-icon"
}

function Send-WebResponse {
    param($Response, [int]$StatusCode, [byte[]]$Bytes, [string]$ContentType = "text/plain; charset=utf-8")
    $Response.StatusCode = $StatusCode
    $Response.ContentType = $ContentType
    $Response.ContentLength64 = $Bytes.Length
    $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
    $Response.OutputStream.Close()
}

function Send-WebJson {
    param($Response, [int]$StatusCode, [hashtable]$Object, [int]$Depth = 10)
    $Json = $Object | ConvertTo-Json -Depth $Depth -Compress
    Send-WebResponse -Response $Response -StatusCode $StatusCode -Bytes ([System.Text.Encoding]::UTF8.GetBytes($Json)) -ContentType "application/json; charset=utf-8"
}

# Minimal, dependency-free query-string reader. [System.Web.HttpUtility] would do this in
# one call, but System.Web isn't reliably present across both runtimes this repo targets
# (.NET Framework via PS 5.1, .NET Core/5+ via pwsh) - same reasoning as this repo's other
# runtime-portability choices (see Start-NetworkMapper.ps1's AesGcm comment).
# [System.Net.WebUtility] IS available on both, so it's the only cross-runtime dependency.
function Get-QueryParam {
    param([string]$Query, [string]$Name)
    if ([string]::IsNullOrEmpty($Query)) { return $null }
    foreach ($Pair in $Query.TrimStart('?') -split '&') {
        $Parts = $Pair -split '=', 2
        if ($Parts.Length -eq 2 -and [System.Net.WebUtility]::UrlDecode($Parts[0]) -eq $Name) {
            return [System.Net.WebUtility]::UrlDecode($Parts[1])
        }
    }
    return $null
}

# The one action a browser click can trigger server-side: launch Connect-Switch.ps1 (a
# real interactive SSH session, askpass-injected from Auth.json) against a target IP.
# Deliberately narrow - a fixed script, one validated parameter, no free-form command or
# Invoke-Expression surface. $TargetIP is regex-locked to IPv4 shape before it ever
# reaches Start-Process, so it carries no shell metacharacters even though the arguments
# below are also passed as a single pre-quoted string rather than relying on
# Start-Process's own (version-dependent) array-quoting behavior.
function Invoke-ConnectAction {
    param($Response, [string]$Body, [string]$ConnectScriptPath, [string]$AuthFile)

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    $TargetIP = if ($Parsed) { [string]$Parsed.ip } else { $null }

    if (-not $TargetIP -or $TargetIP -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Invalid or missing IP address" }
        return
    }

    try {
        $ArgString = @("-NoExit", "-File", "`"$ConnectScriptPath`"", "-TargetIP", $TargetIP, "-AuthFile", "`"$AuthFile`"") -join ' '
        Start-Process -FilePath "powershell.exe" -ArgumentList $ArgString | Out-Null
        Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "launched"; ip = $TargetIP }
    } catch {
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to launch SSH session: $_" }
    }
}

# Re-scan a single device (see Get-JunosNodeData.ps1) without waiting for a full fleet
# crawl. Async by necessity, not preference: the accept loop below handles one request at
# a time, and a scan can legitimately take up to the worker's own ~50s SSH-batch budget -
# running it inline would freeze the whole server (every static file, /api/connect, a
# page reload) for the duration. Instead this starts the scan in a single-slot runspace
# pool (the same BeginInvoke/RunspacePool mechanism Start-NetworkMapper.ps1 already uses
# and trusts for the whole-fleet crawl, just sized to one) and returns immediately; the
# browser polls Invoke-RescanStatusAction for the result. Exactly one rescan may be
# in-flight at a time - not a security boundary (the analyst already has full SSH access
# via /api/connect), just hygiene: no dictionary of per-IP jobs to leak-sweep, no question
# of how many concurrent authenticated SSH sessions a stuck button should be allowed to
# fire against the fleet.
function Invoke-RescanAction {
    param($Response, [string]$Body, [string]$WorkerPath, [string]$AuthFile)

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    $TargetIP = if ($Parsed) { [string]$Parsed.ip } else { $null }

    if (-not $TargetIP -or $TargetIP -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Invalid or missing IP address" }
        return
    }

    if (-not (Test-Path $AuthFile)) {
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Auth file missing at $AuthFile" }
        return
    }

    # Opportunistically reap any previously-timed-out job that has since actually
    # finished, so its runspace slot and askpass cleanup are accounted for before this
    # decides whether a new scan can start (see the timeout handling in
    # Invoke-RescanStatusAction for why a timed-out job isn't force-stopped).
    for ($i = $script:OrphanedScans.Count - 1; $i -ge 0; $i--) {
        $Orphan = $script:OrphanedScans[$i]
        if ($Orphan.Handle.IsCompleted) {
            try { $Orphan.PS.EndInvoke($Orphan.Handle) | Out-Null } catch {}
            $Orphan.PS.Dispose()
            $script:OrphanedScans.RemoveAt($i)
        }
    }

    if ($script:PendingScan) {
        Send-WebJson -Response $Response -StatusCode 409 -Object @{
            error = "A rescan is already in progress"; jobId = $script:PendingScan.JobId; ip = $script:PendingScan.IP
        }
        return
    }

    # -TargetIP/-AuthFile only, matching Get-JunosNodeData.ps1's fixed read-only "show ..."
    # batch. Never -HumanReadable (that branch ends in `exit`, which would kill this
    # runspace) and never -Log (no reason for an ad-hoc rescan to write RawDumps/).
    $JobId = [guid]::NewGuid().ToString()
    $PS = [powershell]::Create().AddCommand($WorkerPath).AddParameter("TargetIP", $TargetIP).AddParameter("AuthFile", $AuthFile)
    $PS.RunspacePool = $script:RescanPool
    $Handle = $PS.BeginInvoke()

    $script:PendingScan = [PSCustomObject]@{ PS = $PS; Handle = $Handle; IP = $TargetIP; JobId = $JobId; StartTime = (Get-Date) }
    Send-WebJson -Response $Response -StatusCode 202 -Object @{ status = "started"; jobId = $JobId; ip = $TargetIP }
}

# Polled by the browser every ~2s while a rescan is outstanding.
function Invoke-RescanStatusAction {
    param($Response, [string]$JobId)

    if (-not $JobId -or -not $script:PendingScan -or $script:PendingScan.JobId -ne $JobId) {
        Send-WebJson -Response $Response -StatusCode 404 -Object @{ error = "Unknown or expired job id" }
        return
    }

    $Job = $script:PendingScan

    if ($Job.Handle.IsCompleted) {
        $script:PendingScan = $null
        try {
            $Result = $Job.PS.EndInvoke($Job.Handle)
        } catch {
            $Job.PS.Dispose()
            Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "complete"; ok = $false; ip = $Job.IP; reason = "Scan failed: $_" }
            return
        }
        $Job.PS.Dispose()

        # Success/failure is decided here, server-side, from the same CRITICAL log-line
        # signal Get-JunosNodeData.ps1 already emits for exactly this purpose (the
        # empty-payload path and its own catch-all both log a line matching this) - not
        # inferred by the browser from log text. ok:false intentionally omits `node`
        # entirely: a failed scan's Interfaces/etc. are placeholder-shaped, and the only
        # safe thing to do with a failed scan is leave the existing good data untouched.
        $Logs = if ($Result -and $Result.Logs) { @($Result.Logs) } else { @() }
        $HasCritical = $false
        foreach ($LogLine in $Logs) { if ($LogLine -match 'CRITICAL') { $HasCritical = $true; break } }

        if (-not $Result -or -not $Result.Node -or $HasCritical) {
            Send-WebJson -Response $Response -StatusCode 200 -Object @{
                status = "complete"; ok = $false; ip = $Job.IP
                reason = "Switch returned empty payload or scan failed - see logs"; logs = $Logs
            }
            return
        }

        Send-WebJson -Response $Response -StatusCode 200 -Depth 20 -Object @{ status = "complete"; ok = $true; ip = $Job.IP; node = $Result.Node; logs = $Logs }
        return
    }

    $Elapsed = ((Get-Date) - $Job.StartTime).TotalSeconds
    if ($Elapsed -gt 90) {
        # Deliberately not force-stopped. New-JunosAskPass (Connect-JunosSsh.ps1) writes
        # the real switch password to a plaintext %TEMP% file, cleaned up only by the
        # worker's own `finally { Remove-JunosAskPass ... }`. A pipeline .Stop()'d while
        # blocked inside Process.WaitForExit (a synchronous native call) isn't guaranteed
        # to run that finally block promptly - and a browser button invites hitting this
        # far more often than the orchestrator's own rare-hung-switch case. Instead: move
        # it out of the single active slot (freeing it for a new rescan) and into a small
        # list that Invoke-RescanAction opportunistically reaps once it actually finishes
        # on its own schedule.
        $script:OrphanedScans.Add($Job)
        $script:PendingScan = $null
        Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "timeout"; ip = $Job.IP; elapsedSeconds = [math]::Round($Elapsed) }
        return
    }

    Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "running"; ip = $Job.IP; elapsedSeconds = [math]::Round($Elapsed) }
}

# Serves a file under $VisualizerRoot, defaulting "/" to network_vis.html. Resolves the
# request path to an absolute path and rejects anything that lands outside
# $VisualizerRoot (../ traversal, absolute-path requests) before it ever touches disk.
function Invoke-StaticFile {
    param($Response, [string]$AbsolutePath, [string]$VisualizerRoot)

    $RelPath = $AbsolutePath.TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($RelPath)) { $RelPath = "network_vis.html" }

    $RootFull = [System.IO.Path]::GetFullPath($VisualizerRoot)
    $FullPath = [System.IO.Path]::GetFullPath((Join-Path $RootFull $RelPath))

    if (-not $FullPath.StartsWith($RootFull, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $FullPath -PathType Leaf)) {
        Send-WebResponse -Response $Response -StatusCode 404 -Bytes ([System.Text.Encoding]::UTF8.GetBytes("Not found"))
        return
    }

    $Ext = [System.IO.Path]::GetExtension($FullPath).ToLowerInvariant()
    $CType = if ($script:ContentTypes.ContainsKey($Ext)) { $script:ContentTypes[$Ext] } else { "application/octet-stream" }
    Send-WebResponse -Response $Response -StatusCode 200 -Bytes ([System.IO.File]::ReadAllBytes($FullPath)) -ContentType $CType
}

# Starts the listener, opens the default browser to it, then blocks serving requests
# (one at a time - this is a single local analyst's viewer, not a shared service, so the
# synchronous accept loop used everywhere else needing concurrency in this repo isn't
# needed here) until Ctrl+C.
function Start-MapperWebServer {
    param(
        [Parameter(Mandatory=$true)][string]$VisualizerRoot,
        [Parameter(Mandatory=$true)][string]$ConnectScriptPath,
        [Parameter(Mandatory=$true)][string]$AuthFile,
        [Parameter(Mandatory=$true)][string]$WorkerPath,
        [int]$Port = 8787
    )

    $Listener = [System.Net.HttpListener]::new()
    $Prefix = "http://localhost:$Port/"
    $Listener.Prefixes.Add($Prefix)

    try {
        $Listener.Start()
    } catch {
        throw "Could not bind $Prefix - is another instance already running? ($_)"
    }

    # Backs /api/rescan - a single-slot pool, not sized for concurrency (see
    # Invoke-RescanAction's header comment for why one in-flight scan is a deliberate
    # choice, not a resource limit).
    $script:RescanPool = [runspacefactory]::CreateRunspacePool(1, 1)
    $script:RescanPool.Open()
    $script:PendingScan = $null
    $script:OrphanedScans = [System.Collections.Generic.List[object]]::new()

    Write-Host "`nWeb UI listening on $Prefix (localhost only - Ctrl+C to stop)" -ForegroundColor Cyan
    Start-Process $Prefix

    try {
        while ($Listener.IsListening) {
            $Context = $Listener.GetContext()   # blocks until a request arrives
            $Request = $Context.Request
            $Response = $Context.Response

            try {
                if ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/connect") {
                    $Reader = [System.IO.StreamReader]::new($Request.InputStream, $Request.ContentEncoding)
                    $Body = $Reader.ReadToEnd()
                    $Reader.Close()
                    Invoke-ConnectAction -Response $Response -Body $Body -ConnectScriptPath $ConnectScriptPath -AuthFile $AuthFile
                } elseif ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/rescan") {
                    $Reader = [System.IO.StreamReader]::new($Request.InputStream, $Request.ContentEncoding)
                    $Body = $Reader.ReadToEnd()
                    $Reader.Close()
                    Invoke-RescanAction -Response $Response -Body $Body -WorkerPath $WorkerPath -AuthFile $AuthFile
                } elseif ($Request.HttpMethod -eq "GET" -and $Request.Url.AbsolutePath -eq "/api/rescan/status") {
                    $JobId = Get-QueryParam -Query $Request.Url.Query -Name "jobId"
                    Invoke-RescanStatusAction -Response $Response -JobId $JobId
                } else {
                    Invoke-StaticFile -Response $Response -AbsolutePath $Request.Url.AbsolutePath -VisualizerRoot $VisualizerRoot
                }
            } catch {
                try { Send-WebResponse -Response $Response -StatusCode 500 -Bytes ([System.Text.Encoding]::UTF8.GetBytes("Server error: $_")) } catch {}
            }
        }
    } finally {
        $Listener.Stop()
        $Listener.Close()
        if ($script:PendingScan) { try { $script:PendingScan.PS.Stop() } catch {}; $script:PendingScan.PS.Dispose() }
        foreach ($Orphan in $script:OrphanedScans) { try { $Orphan.PS.Stop() } catch {}; $Orphan.PS.Dispose() }
        $script:RescanPool.Close()
        $script:RescanPool.Dispose()
    }
}

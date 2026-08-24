# HttpListener-based local webserver for Network_Visualizer. Zero-install by design -
# HttpListener ships in every .NET runtime this repo already targets (Framework 4.x via
# PS 5.1, and Core/5+ via pwsh), same reasoning as the AES/PBKDF2 primitives in
# Start-NetworkMapper.ps1. Localhost-only by design too: it binds "localhost" specifically
# (not "+" or a NIC address), so no netsh urlacl reservation and no admin rights are
# needed, and no auth is needed either, because the only thing this server can do beyond
# serve static files is spawn a process with the live switch credentials it holds in memory
# (decrypted from Configuration.json.enc at startup by Start-NetworkMapper.ps1) - that's
# only safe when "reaches this server" and "already runs as the person who started this
# process" are the same fact, which is true for localhost and false the moment this is
# ever rebound to a LAN address.
#
# Not meant to be run directly - dot-source it, then call Start-MapperWebServer.

# Invoke-SaveConfigAction (below) needs Get-TopologyKeyMaterial/Protect-TopologyPayload.
# Dot-sourced here directly rather than relying on the caller (Start-NetworkMapper.ps1)
# having already loaded it first, so this file's correctness doesn't depend on caller load
# order. $PSScriptRoot inside a dot-sourced file resolves to that file's own directory, not
# the caller's - both files live in Network_Mapper/lib/, so this resolves correctly
# regardless of how Start-WebServer.ps1 itself gets loaded.
. (Join-Path $PSScriptRoot "TopologyCrypto.ps1")
# Invoke-ConnectAction (below) needs New-JunosCredentialFile. Same "dot-source directly,
# don't rely on caller load order" reasoning as the TopologyCrypto.ps1 dot-source above.
. (Join-Path $PSScriptRoot "Connect-JunosSsh.ps1")
# Invoke-ScanNetworkAction (below) needs Invoke-FleetCrawl.
. (Join-Path $PSScriptRoot "Invoke-FleetCrawl.ps1")

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

# CSRF guard for the two state-changing endpoints (/api/connect, /api/rescan). Binding to
# "localhost" (see the header comment) only proves the CALLER runs as this user - it does
# nothing to prove the caller is OUR page rather than a hidden form on some other site the
# analyst has open in another tab, and either endpoint can trigger an outbound SSH session
# using the real switch password held in this process's memory. Origin (and Referer as fallback, since not
# every browser sends Origin on a same-origin fetch) is the standard defense: both are set
# by the browser itself from the requesting page's actual origin, so page JS cannot forge
# them, and a bare cross-origin <form> POST still carries a truthful Origin header even
# though it needs no CORS preflight to fire. Fail closed - neither header present means
# this wasn't a browser navigating from our own page, so it's refused too.
function Test-SameOriginRequest {
    param($Request, [int]$Port)
    $Expected = "http://localhost:$Port"
    $Origin = $Request.Headers["Origin"]
    if ($Origin) { return $Origin -eq $Expected }
    $Referer = $Request.Headers["Referer"]
    if ($Referer) { return $Referer -eq "$Expected/" -or $Referer.StartsWith("$Expected/") }
    return $false
}

# The one action a browser click can trigger server-side: launch Connect-Switch.ps1 (a
# real interactive SSH session, askpass-injected via a short-lived credential file) against
# a target IP. Deliberately narrow - a fixed script, one validated parameter, no free-form
# command or Invoke-Expression surface. $TargetIP is regex-locked to IPv4 shape before it
# ever reaches Start-Process, so it carries no shell metacharacters even though the
# arguments below are also passed as a single pre-quoted string rather than relying on
# Start-Process's own (version-dependent) array-quoting behavior.
function Invoke-ConnectAction {
    param($Response, [string]$Body, [string]$ConnectScriptPath, [string]$JunosUsername, [string]$JunosPassword)

    if ([string]::IsNullOrWhiteSpace($JunosUsername) -or [string]::IsNullOrWhiteSpace($JunosPassword)) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "No Juniper login configured - set it in the Settings tab, then try again." }
        return
    }

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    $TargetIP = if ($Parsed) { [string]$Parsed.ip } else { $null }

    if (-not $TargetIP -or $TargetIP -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Invalid or missing IP address" }
        return
    }

    # Declared outside the try so the catch can still see it: the credential file (switch
    # username + password, plaintext, in %TEMP%) is written BEFORE Start-Process runs, and is
    # normally removed by Connect-Switch.ps1's own finally block once it has read it.
    $CredFile = $null
    try {
        $CredFile = New-JunosCredentialFile -Username $JunosUsername -Password $JunosPassword
        $ArgString = @("-NoExit", "-File", "`"$ConnectScriptPath`"", "-TargetIP", $TargetIP, "-CredentialFile", "`"$CredFile`"") -join ' '
        Start-Process -FilePath "powershell.exe" -ArgumentList $ArgString | Out-Null
        Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "launched"; ip = $TargetIP }
    } catch {
        # Start-Process (or the credential-file write itself) failed - Connect-Switch.ps1 never
        # launched to clean up the credential file itself, so remove it here instead of leaking
        # the switch password in plaintext at %TEMP% (and accumulating one more file per retry).
        if ($CredFile) { Remove-JunosCredentialFile -CredentialFile $CredFile }
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
    param($Response, [string]$Body, [string]$WorkerPath, [string]$JunosUsername, [string]$JunosPassword)

    if ([string]::IsNullOrWhiteSpace($JunosUsername) -or [string]::IsNullOrWhiteSpace($JunosPassword)) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "No Juniper login configured - set it in the Settings tab, then try again." }
        return
    }

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    $TargetIP = if ($Parsed) { [string]$Parsed.ip } else { $null }

    if (-not $TargetIP -or $TargetIP -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Invalid or missing IP address" }
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

    # -TargetIP/-Username/-Password only, matching Get-JunosNodeData.ps1's fixed read-only
    # "show ..." batch. Never -HumanReadable (that branch ends in `exit`, which would kill
    # this runspace) and never -Log (no reason for an ad-hoc rescan to write RawDumps/).
    $JobId = [guid]::NewGuid().ToString()
    $PS = [powershell]::Create().AddCommand($WorkerPath).AddParameter("TargetIP", $TargetIP).AddParameter("Username", $JunosUsername).AddParameter("Password", $JunosPassword)
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

# Kicks off a full fleet crawl from the browser, via Invoke-FleetCrawl (see that file) run
# asynchronously in its own runspace pool - same "must not block the accept loop" reasoning
# as Invoke-RescanAction, but sized to $MaxConcurrent (a real crawl needs real concurrency,
# unlike a single-device rescan's 1-slot pool). Only one scan may be in flight at a time,
# tracked in $script:PendingScanNetwork exactly like $script:PendingScan does for rescans -
# a second click while one is running is refused with a 409, not queued or stacked.
function Invoke-ScanNetworkAction {
    param($Response, [string]$Body, [string]$WorkerPath, [string]$JunosUsername, [string]$JunosPassword,
          [string]$MaxConcurrent, [string[]]$AllowedScopes, [string]$SnapshotDir, [string]$DeviceHistoryLedger,
          [byte[]]$EncKey, [byte[]]$MacKey, [byte[]]$Salt, [int]$Iterations)

    if ([string]::IsNullOrWhiteSpace($JunosUsername) -or [string]::IsNullOrWhiteSpace($JunosPassword)) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "No Juniper login configured - set it in the Settings tab, then try again." }
        return
    }

    # Opportunistically reap a finished scan job before deciding whether a new one can
    # start - same shape as Invoke-RescanAction's orphan reaping above. Without this, a
    # scan that finished but whose result the browser never polled again (tab closed,
    # page reloaded after the last poll) would sit in $script:PendingScanNetwork forever,
    # 409-ing every future "Scan Network" click even though nothing is actually running.
    # If Invoke-ScanNetworkStatusAction already cached the outcome (.Collected), the
    # PS/Runspace are already disposed and this just clears the slot; if a poll never
    # arrived at all, collect it here so the runspace/pool resources aren't leaked.
    if ($script:PendingScanNetwork -and $script:PendingScanNetwork.Handle.IsCompleted) {
        $Finished = $script:PendingScanNetwork
        if (-not $Finished.Collected) {
            try { $Finished.PS.EndInvoke($Finished.Handle) | Out-Null } catch {}
            try { $Finished.PS.Dispose() } catch {}
            try { $Finished.Runspace.Dispose() } catch {}
        }
        $script:PendingScanNetwork = $null
    }

    if ($script:PendingScanNetwork) {
        Send-WebJson -Response $Response -StatusCode 409 -Object @{ error = "A network scan is already in progress"; ip = $script:PendingScanNetwork.StartIP }
        return
    }

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    $StartIP = if ($Parsed -and $Parsed.startIp) { [string]$Parsed.startIp } else { $null }

    if (-not $StartIP -or $StartIP -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Invalid or missing starting IP address" }
        return
    }

    # A fixed path next to the snapshot output, mirroring the CLI crawl path's own
    # -DebugLogPath (Start-NetworkMapper.ps1's $DebugLog) - without this,
    # Invoke-FleetCrawl's internal Write-DebugLogLocal is a total no-op for every
    # web-triggered scan (see Invoke-ScanNetworkStatusAction's failure message, which
    # otherwise points at a debug log that was never written) and a failed web scan is
    # undiagnosable. Overwritten (not appended) per crawl, same as the CLI path.
    $DebugLogPath = Join-Path $SnapshotDir "ScanNetwork_Debug.log"

    $ProgressTable = [hashtable]::Synchronized(@{ Visited = 0; QueueDepth = 1; ActiveJobs = 0; Done = $false })
    $PS = [powershell]::Create().AddCommand("Invoke-FleetCrawl").
        AddParameter("StartIP", $StartIP).
        AddParameter("AllowedScopes", $AllowedScopes).
        AddParameter("MaxConcurrent", [int]$MaxConcurrent).
        AddParameter("WorkerPath", $WorkerPath).
        AddParameter("Username", $JunosUsername).
        AddParameter("Password", $JunosPassword).
        AddParameter("SnapshotDir", $SnapshotDir).
        AddParameter("DeviceHistoryLedger", $DeviceHistoryLedger).
        AddParameter("ProgressTable", $ProgressTable).
        AddParameter("DebugLogPath", $DebugLogPath)
    if ($EncKey) { $PS.AddParameter("EncKey", $EncKey).AddParameter("MacKey", $MacKey).AddParameter("Salt", $Salt).AddParameter("Iterations", $Iterations) | Out-Null }

    # Invoke-FleetCrawl itself is defined in the caller's session state (dot-sourced at the
    # top of this file) - a fresh [powershell]::Create() runspace does NOT inherit that by
    # default, so the function definition has to travel into the new runspace explicitly.
    $InitialState = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
    $FleetCrawlPath = Join-Path $PSScriptRoot "Invoke-FleetCrawl.ps1"
    $InitialState.StartupScripts.Add($FleetCrawlPath) | Out-Null
    $Runspace = [runspacefactory]::CreateRunspace($InitialState)
    $Runspace.Open()
    $PS.Runspace = $Runspace

    $Handle = $PS.BeginInvoke()
    # Collected/Outcome: filled in once by Invoke-ScanNetworkStatusAction the first time it
    # observes completion (see that function) so a completed result can be re-served
    # idempotently to every later poll instead of being destructively consumed by the
    # first one.
    $script:PendingScanNetwork = [PSCustomObject]@{ PS = $PS; Runspace = $Runspace; Handle = $Handle; StartIP = $StartIP; StartTime = (Get-Date); ProgressTable = $ProgressTable; Collected = $false; Outcome = $null }
    Send-WebJson -Response $Response -StatusCode 202 -Object @{ status = "started"; startIp = $StartIP }
}

# Polled by the browser every ~2s while a scan is outstanding. Unlike Invoke-RescanStatusAction
# (one device, small/bounded runtime), a full fleet crawl can run for many minutes - no
# client-side timeout ceiling is imposed here; the browser just keeps polling until it sees
# "complete". Returns the FULL decrypted topology inline on completion (not a second file
# fetch) - Invoke-FleetCrawl already holds it all in memory at that point, so there is
# nothing to gain by writing it to disk and reading it straight back over a new endpoint,
# and doing so would mean adding new file-serving surface rooted outside $VisualizerRoot.
function Invoke-ScanNetworkStatusAction {
    param($Response)

    if (-not $script:PendingScanNetwork) {
        Send-WebJson -Response $Response -StatusCode 404 -Object @{ error = "No scan is currently running or was ever started this session" }
        return
    }

    $Job = $script:PendingScanNetwork

    if ($Job.Handle.IsCompleted) {
        # Collect (EndInvoke + Dispose) exactly once, the first poll that observes
        # completion, and cache the outcome on the job object itself. Every later poll
        # (including one after $Job has been left in $script:PendingScanNetwork for a
        # while - see Invoke-ScanNetworkAction's reap-before-409, which is what eventually
        # clears this slot) re-serves the SAME cached outcome instead of calling EndInvoke
        # a second time (which throws - a PSDataCollection handle can only be ended once)
        # or losing the result entirely. This is what makes a completed scan's result
        # readable more than once.
        if (-not $Job.Collected) {
            try {
                $Result = $Job.PS.EndInvoke($Job.Handle)
                # $Result is the PSDataCollection[PSObject] EndInvoke wraps the pipeline
                # output in. Invoke-FleetCrawl returns exactly one hashtable via `return
                # @{ Topology = ...; ... }`, so $Result normally holds exactly one item -
                # index into it explicitly rather than dotting straight into $Result.
                # Dotting (e.g. $Result.Topology) is PowerShell member enumeration: for a
                # 1-item collection it unwraps straight through to that single item's own
                # .Topology property, so when the crawl finds exactly 1 device,
                # $Result.Topology would be the bare device PSCustomObject rather than the
                # actual List[object] the function returned - and ConvertTo-Json would then
                # emit "topology":{...} instead of "topology":[{...}], breaking the
                # browser's data.Topology.forEach(...) in readSnapshotFile. Indexing
                # ($Result[0]) always returns the real return value regardless of item
                # count, so .Topology off of THAT is always the actual List[object] -
                # ConvertTo-Json then always renders it as an array ([], [{...}], or
                # [{...},{...}]) no matter how many devices were visited.
                $Payload = if ($Result -and $Result.Count -gt 0) { $Result[0] } else { $null }

                if (-not $Payload -or -not $Payload.Topology) {
                    $Job.Outcome = @{ status = "complete"; ok = $false; reason = "Scan produced no data - see server console/debug log" }
                } else {
                    $Job.Outcome = @{
                        status = "complete"; ok = $true
                        topology = $Payload.Topology; scanTimestamp = $Payload.ScanTimestampIso
                        outputFile = (Split-Path $Payload.OutputFile -Leaf); visitedCount = $Payload.VisitedCount
                    }
                }
            } catch {
                $Job.Outcome = @{ status = "complete"; ok = $false; reason = "Scan failed: $_" }
            }
            try { $Job.PS.Dispose() } catch {}
            try { $Job.Runspace.Dispose() } catch {}
            $Job.Collected = $true
        }

        # -Depth 100 matches Invoke-FleetCrawl.ps1's Write-TopologyOutputLocal (the
        # file-write path) - this endpoint serializes the exact same device-object shape
        # inline, and the old -Depth 30 here risked ConvertTo-Json silently truncating a
        # deeply-nested topology into type-name strings past the depth limit.
        Send-WebJson -Response $Response -StatusCode 200 -Depth 100 -Object $Job.Outcome
        return
    }

    Send-WebJson -Response $Response -StatusCode 200 -Object @{
        status = "running"; startIp = $Job.StartIP
        elapsedSeconds = [math]::Round(((Get-Date) - $Job.StartTime).TotalSeconds)
        visited = $Job.ProgressTable.Visited; queueDepth = $Job.ProgressTable.QueueDepth; activeJobs = $Job.ProgressTable.ActiveJobs
    }
}

# Serves the current Configuration.json.enc envelope as-is (still encrypted - the browser
# decrypts client-side with a human-typed password, exactly like NetworkMap files). 404
# with a JSON body (not the generic Invoke-StaticFile 404) so the browser can tell "no
# config yet" (a normal, expected state on a fresh checkout) apart from a real error.
#
# Deliberately does NOT round-trip through ConvertFrom-Json/Send-WebJson: the brief's
# original draft used `ConvertFrom-Json -AsHashtable` to satisfy Send-WebJson's
# [hashtable] parameter, but -AsHashtable is PowerShell 6.0+ only, and this file (like
# Start-NetworkMapper.ps1's AesGcm avoidance and Get-QueryParam's System.Web avoidance)
# has to run under Windows PowerShell 5.1 too - there it throws a binding error on every
# call, caught below, so /api/config would 500 unconditionally. The envelope is already
# JSON on disk and is served unchanged either way, so skip the parse entirely and write
# the raw bytes straight through (same Send-WebResponse helper Invoke-StaticFile uses).
function Invoke-GetConfigAction {
    param($Response, [string]$ConfigPath)

    if (-not (Test-Path $ConfigPath)) {
        Send-WebJson -Response $Response -StatusCode 404 -Object @{ error = "No configuration file yet" }
        return
    }

    try {
        $Raw = Get-Content $ConfigPath -Raw
        Send-WebResponse -Response $Response -StatusCode 200 -Bytes ([System.Text.Encoding]::UTF8.GetBytes($Raw)) -ContentType "application/json; charset=utf-8"
    } catch {
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to read configuration file: $_" }
    }
}

# Encrypts and writes Configuration.json.enc. The browser sends PLAINTEXT edited config
# JSON - the encryption password never crosses the wire in either direction, same as
# topology writes. $EncryptionPassword is the same password Start-NetworkMapper.ps1 already
# prompted for interactively at startup (see that script's header sequence) and passed
# straight through to Start-MapperWebServer - it is never read from a file. A fresh
# salt/IV is generated per save (unlike a crawl's session-cached key - saves are rare/
# interactive, not periodic, so there's no repeated-PBKDF2-cost reason to cache keys across
# calls here).
function Invoke-SaveConfigAction {
    param($Response, [string]$Body, [string]$ConfigPath, [string]$EncryptionPassword)

    # Fail closed. Start-NetworkMapper.ps1 blanks the password when Configuration.json.enc
    # could not be decrypted at startup and the operator chose to continue anyway - the
    # password typed there is proven wrong, and re-encrypting the whole file under it would
    # permanently and silently change the file's real password to a string nobody has a
    # record of, locking every future session out of its own config.
    if ([string]::IsNullOrWhiteSpace($EncryptionPassword)) {
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "No working encryption password for this session - Configuration.json.enc could not be decrypted at startup, so saving is disabled to avoid rewriting the file under an unverified password. Restart Start-NetworkMapper.ps1 with the correct password." }
        return
    }

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    # Presence check, not truthiness: `-not $Parsed.devices` would also reject a
    # legitimate `devices: []` save (PowerShell treats an empty array as falsy), which is
    # exactly what the in-app editor sends the first time someone deletes their last
    # location entry. $null -eq checks for "key absent (or explicitly null)" instead.
    if (-not $Parsed -or $null -eq $Parsed.devices) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Request body must be JSON with a 'devices' array" }
        return
    }

    try {
        $SaltBytes = [byte[]]::new(16)
        $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $Rng.GetBytes($SaltBytes)
        $Rng.Dispose()

        # Shared with Start-NetworkMapper.ps1's crawl-output encryption via
        # TopologyCrypto.ps1's Get-TopologyPbkdf2Iterations (dot-sourced at the top of this
        # file) - was a duplicated `600000` literal here, defeating the point of extracting
        # TopologyCrypto.ps1 in the first place (stop crypto parameters drifting between the
        # crawler and the webserver).
        $Iterations = Get-TopologyPbkdf2Iterations
        $KeyMaterial = Get-TopologyKeyMaterial -Password $EncryptionPassword -Salt $SaltBytes -Iterations $Iterations
        $Envelope = Protect-TopologyPayload -PlainJson $Body -EncKey $KeyMaterial.EncKey -MacKey $KeyMaterial.MacKey -Salt $SaltBytes -Iterations $Iterations -Format "PSNetworkMapper-EncryptedConfig"

        $Envelope | ConvertTo-Json -Depth 10 | Out-File -FilePath $ConfigPath -Encoding utf8

        # Push the just-saved Juniper credentials into the running server's live copies (see
        # Start-MapperWebServer's $script:JunosUsername/$script:JunosPassword) so /api/connect,
        # /api/rescan and /api/scan-network start using them immediately - without this, the
        # server kept serving requests with whatever was decrypted from disk at process start,
        # so saving credentials in the Settings tab appeared to work but changed nothing until
        # the operator restarted Start-NetworkMapper.ps1.
        #
        # Deliberately after the file write, inside this try: a save that failed to reach disk
        # must not leave the process running credentials that were never actually persisted.
        # Also deliberately a presence check on `credentials` - a body that only carries
        # `devices` (or sends credentials:null, which map.js's saveConfiguration does whenever
        # nothing has been loaded into loadedCredentials) leaves the in-memory copies alone
        # rather than nulling out working credentials. An explicitly-blank {username:"",
        # password:""} DOES clear them, which is the honest reading of "the operator saved
        # empty credentials" - the actions then report "No Juniper login configured" as they
        # would on a fresh install.
        if ($Parsed.credentials) {
            $script:JunosUsername = [string]$Parsed.credentials.username
            $script:JunosPassword = [string]$Parsed.credentials.password
        }

        Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "saved" }
    } catch {
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to save configuration: $_" }
    }
}

# Serves a file under $VisualizerRoot, defaulting "/" to network_vis.html. Resolves the
# request path to an absolute path and rejects anything that lands outside
# $VisualizerRoot (../ traversal, absolute-path requests) before it ever touches disk.
function Invoke-StaticFile {
    param($Response, [string]$AbsolutePath, [string]$VisualizerRoot)

    $RelPath = $AbsolutePath.TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($RelPath)) { $RelPath = "network_vis.html" }

    $RootFull = [System.IO.Path]::GetFullPath($VisualizerRoot)
    if (-not $RootFull.EndsWith([System.IO.Path]::DirectorySeparatorChar)) { $RootFull += [System.IO.Path]::DirectorySeparatorChar }
    $FullPath = [System.IO.Path]::GetFullPath((Join-Path $RootFull $RelPath))

    # StartsWith needs $RootFull's trailing separator (added above) or this containment
    # check is only a string-prefix match, not a path-prefix match - "Network_Visualizer"
    # would then also accept a sibling directory named e.g. "Network_Visualizer_old".
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
        [Parameter(Mandatory=$true)][string]$WorkerPath,
        [Parameter(Mandatory=$true)][string]$ConfigPath,
        # Still mandatory (a caller must make a deliberate decision about it), but empty/null
        # is a legal VALUE: Start-NetworkMapper.ps1 passes $null on the "continue without
        # server-side credentials" path, where the only password typed was proven wrong
        # against Configuration.json.enc. That means "no verified password this session" and
        # Invoke-SaveConfigAction refuses to write the config file at all - do not re-tighten
        # this to reject empty, or that path dies with a raw parameter-binding error on
        # launch instead of serving the viewer read-only.
        [Parameter(Mandatory=$true)][AllowNull()][AllowEmptyString()][string]$EncryptionPassword,
        [string]$JunosUsername = "",
        [string]$JunosPassword = "",
        [Parameter(Mandatory=$true)][int]$MaxConcurrent,
        [Parameter(Mandatory=$true)][string[]]$AllowedScopes,
        [Parameter(Mandatory=$true)][string]$SnapshotDir,
        [Parameter(Mandatory=$true)][string]$DeviceHistoryLedger,
        [byte[]]$EncKey,
        [byte[]]$MacKey,
        [byte[]]$Salt,
        [int]$Iterations,
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
    $script:PendingScanNetwork = $null
    # The Juniper credentials the accept loop below hands to /api/connect, /api/rescan and
    # /api/scan-network. The -JunosUsername/-JunosPassword parameters are only the SEED:
    # Start-NetworkMapper.ps1 decrypts them out of Configuration.json.enc once, before this
    # server ever starts, so passing those frozen locals straight into every request meant
    # credentials saved from the browser's Settings tab (Invoke-SaveConfigAction, below)
    # never reached the running server. A fresh install stayed stuck on "No Juniper login
    # configured" until the whole PowerShell process was restarted, and a rotated password
    # was worse - IsNullOrWhiteSpace still passed, so scans/rescans really started and then
    # failed confusingly against the stale credentials. Script-scoped so
    # Invoke-SaveConfigAction can update them live, same cross-function pattern as
    # $script:PendingScan above.
    $script:JunosUsername = $JunosUsername
    $script:JunosPassword = $JunosPassword

    Write-Host "`nWeb UI listening on $Prefix (localhost only - Ctrl+C to stop)" -ForegroundColor Cyan
    Start-Process $Prefix

    try {
        while ($Listener.IsListening) {
            $Context = $Listener.GetContext()   # blocks until a request arrives
            $Request = $Context.Request
            $Response = $Context.Response

            try {
                if ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/connect") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused" }
                    } else {
                        $Reader = [System.IO.StreamReader]::new($Request.InputStream, $Request.ContentEncoding)
                        $Body = $Reader.ReadToEnd()
                        $Reader.Close()
                        Invoke-ConnectAction -Response $Response -Body $Body -ConnectScriptPath $ConnectScriptPath -JunosUsername $script:JunosUsername -JunosPassword $script:JunosPassword
                    }
                } elseif ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/rescan") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused" }
                    } else {
                        $Reader = [System.IO.StreamReader]::new($Request.InputStream, $Request.ContentEncoding)
                        $Body = $Reader.ReadToEnd()
                        $Reader.Close()
                        Invoke-RescanAction -Response $Response -Body $Body -WorkerPath $WorkerPath -JunosUsername $script:JunosUsername -JunosPassword $script:JunosPassword
                    }
                } elseif ($Request.HttpMethod -eq "GET" -and $Request.Url.AbsolutePath -eq "/api/rescan/status") {
                    $JobId = Get-QueryParam -Query $Request.Url.Query -Name "jobId"
                    Invoke-RescanStatusAction -Response $Response -JobId $JobId
                } elseif ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/scan-network") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused" }
                    } else {
                        $Reader = [System.IO.StreamReader]::new($Request.InputStream, $Request.ContentEncoding)
                        $Body = $Reader.ReadToEnd()
                        $Reader.Close()
                        Invoke-ScanNetworkAction -Response $Response -Body $Body -WorkerPath $WorkerPath -JunosUsername $script:JunosUsername -JunosPassword $script:JunosPassword -MaxConcurrent $MaxConcurrent -AllowedScopes $AllowedScopes -SnapshotDir $SnapshotDir -DeviceHistoryLedger $DeviceHistoryLedger -EncKey $EncKey -MacKey $MacKey -Salt $Salt -Iterations $Iterations
                    }
                } elseif ($Request.HttpMethod -eq "GET" -and $Request.Url.AbsolutePath -eq "/api/scan-network/status") {
                    Invoke-ScanNetworkStatusAction -Response $Response
                } elseif ($Request.HttpMethod -eq "GET" -and $Request.Url.AbsolutePath -eq "/api/config") {
                    Invoke-GetConfigAction -Response $Response -ConfigPath $ConfigPath
                } elseif ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/save-config") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused" }
                    } else {
                        $Reader = [System.IO.StreamReader]::new($Request.InputStream, $Request.ContentEncoding)
                        $Body = $Reader.ReadToEnd()
                        $Reader.Close()
                        Invoke-SaveConfigAction -Response $Response -Body $Body -ConfigPath $ConfigPath -EncryptionPassword $EncryptionPassword
                    }
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
        # .Collected means Invoke-ScanNetworkStatusAction already ran EndInvoke/Dispose on
        # this job and cached its outcome - Stop()/Dispose() again here would double-dispose
        # the PS/Runspace, so only tear down a job that never got collected.
        if ($script:PendingScanNetwork -and -not $script:PendingScanNetwork.Collected) {
            try { $script:PendingScanNetwork.PS.Stop() } catch {}
            try { $script:PendingScanNetwork.PS.Dispose() } catch {}
            try { $script:PendingScanNetwork.Runspace.Dispose() } catch {}
        }
        $script:RescanPool.Close()
        $script:RescanPool.Dispose()
    }
}

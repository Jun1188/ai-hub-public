param(
    [switch]$Dispatch,
    [switch]$Recover,
    [switch]$RequireExitConsent,
    [Parameter(Mandatory=$true)][string]$HubRoot,
    [Parameter(Mandatory=$true)][string]$AppExe,
    [Parameter(Mandatory=$true)][int]$GuiPid,
    [Parameter(Mandatory=$true)][string]$SettingsPath,
    [Parameter(Mandatory=$true)][string]$PointerPath,
    [Parameter(Mandatory=$true)][guid]$RequestId,
    [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedProfileFingerprint,
    [switch]$RequireGui,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{40,64}$')][string]$Commit,
    [ValidateRange(0,65535)][int]$Port = 0,
    [switch]$Packaged,
    [switch]$Lite
)
$ErrorActionPreference = 'Stop'
$stateDir = Split-Path -Parent $SettingsPath
$receipt = Join-Path $stateDir 'repository-apply-result.json'
$lockPath = Join-Path $stateDir 'repository-apply.lock'
$exitConsentPath = Join-Path $stateDir ('repository-exit-' + $RequestId.ToString() + '.json')
$HubRoot = (Get-Item -LiteralPath $HubRoot).FullName
$AppExe = (Get-Item -LiteralPath $AppExe).FullName
if (-not $ExpectedProfileFingerprint) { throw 'Original Hub profile identity is required; no worker was started.' }
function Start-InheritedProcess([string]$exe, [string[]]$arguments, [switch]$Hidden) {
    # CreateProcess argv quoting. File paths cannot contain double quotes.
    $parts = foreach ($value in $arguments) {
        if ($value -match '["\x00\r\n]') { throw 'Invalid launch argument.' }
        '"' + [regex]::Replace($value, '(\\+)$', '$1$1') + '"'
    }
    # Direct CreateProcess retains the dispatcher's Windows package/filesystem view.
    # Process.Start on Windows PowerShell inherits execFile's stdout/stderr even
    # when its dispatcher exits. The caller would wait for the worker that waits
    # for that same caller to quit. CreateProcessW can explicitly omit handles.
    if (-not ('HubProfileProcess' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class HubProfileProcess {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Startup {
        public int cb;
        public string reserved, desktop, title;
        public int x, y, sx, sy, cols, rows, fill, flags;
        public short show, reserved2Size;
        public IntPtr reserved2, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Child { public IntPtr process, thread; public int pid, tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string exe, StringBuilder args, IntPtr processAttrs, IntPtr threadAttrs,
        bool inheritHandles, uint creationFlags, IntPtr environment, string directory, ref Startup startup, out Child child);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    public static int Start(string exe, string args, string directory, bool hidden) {
        var startup = new Startup { cb = Marshal.SizeOf(typeof(Startup)), flags = hidden ? 1 : 0 };
        Child child;
        if (!CreateProcessW(exe, new StringBuilder("\"" + exe + "\" " + args), IntPtr.Zero, IntPtr.Zero,
            false, 0x08000000, IntPtr.Zero, directory, ref startup, out child))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try { return child.pid; } finally { CloseHandle(child.thread); CloseHandle(child.process); }
    }
}
'@
    }
    return [HubProfileProcess]::Start($exe, ($parts -join ' '), $HubRoot, $Hidden.IsPresent)
}
function Read-Receipt {
    if ([IO.File]::Exists($receipt)) { [IO.File]::ReadAllText($receipt) | ConvertFrom-Json }
}
function Read-ExitConsent {
    if (-not [IO.File]::Exists($exitConsentPath)) { return $null }
    $consent = [IO.File]::ReadAllText($exitConsentPath) | ConvertFrom-Json
    if ($consent.schemaVersion -ne 1 -or $consent.id -ne $RequestId.ToString() -or
        $consent.commit -ne $Commit -or $consent.allowExit -isnot [bool]) { throw 'Invalid exit consent. No update applied.' }
    return $consent
}
function Wait-HubExit($appProcess) {
    $exitDeadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        if ($RequireExitConsent) {
            $consent = Read-ExitConsent
            if ($consent -and -not $consent.allowExit) { throw 'Hub exit was cancelled. No update applied.' }
        }
        if ($appProcess.WaitForExit(150)) {
            if ($RequireExitConsent) {
                $consent = Read-ExitConsent
                if (-not $consent -or -not $consent.allowExit) { throw 'Hub exit was not confirmed. No update applied.' }
            }
            return
        }
    } while ([DateTime]::UtcNow -lt $exitDeadline)
    throw 'Hub did not exit. No update applied.'
}
if ($Dispatch) {
    $workerArgs = @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',$PSCommandPath,
        '-HubRoot',$HubRoot,'-AppExe',$AppExe,'-GuiPid',"$GuiPid",'-SettingsPath',$SettingsPath,
        '-PointerPath',$PointerPath,'-RequestId',$RequestId.ToString(),'-Commit',$Commit,'-Port',"$Port",
        '-ExpectedProfileFingerprint',$ExpectedProfileFingerprint)
    if ($RequireGui) { $workerArgs += '-RequireGui' }
    if ($Recover) { $workerArgs += '-Recover' }
    if ($RequireExitConsent) { $workerArgs += '-RequireExitConsent' }
    if ($Packaged) { $workerArgs += '-Packaged' }
    if ($Lite) { $workerArgs += '-Lite' }
    $id = Start-InheritedProcess (Join-Path $PSHOME 'powershell.exe') $workerArgs -Hidden
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $s = Read-Receipt
        if ($s -and $s.id -eq $RequestId.ToString() -and $s.workerPid -eq $id) {
            if ($s.status -ne 'armed') { throw $s.message }
            $s | ConvertTo-Json -Compress
            return
        }
        if (-not (Get-Process -Id $id -ErrorAction SilentlyContinue)) { throw 'Update worker exited before accepting the request.' }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Update worker did not accept the request before the deadline.'
}

function Write-Status([string]$status, [string]$message) {
    $state.status = $status
    $state.message = $message
    $state.at = [DateTime]::UtcNow.ToString('o')
    $bytes = $state | ConvertTo-Json -Depth 6
    $historyDir = Join-Path $stateDir 'repository-apply-results'
    [void][IO.Directory]::CreateDirectory($historyDir)
    $history = Join-Path $historyDir ($RequestId.ToString() + '.json')
    $historyTmp = "$history.$PID.tmp"
    [IO.File]::WriteAllText($historyTmp, $bytes, (New-Object Text.UTF8Encoding($false)))
    # PowerShell converts an ordinary null string argument to an empty path.
    if ([IO.File]::Exists($history)) { [IO.File]::Replace($historyTmp, $history, [NullString]::Value) }
    else { [IO.File]::Move($historyTmp, $history) }
    $tmp = "$receipt.$PID.tmp"
    [IO.File]::WriteAllText($tmp, $bytes, (New-Object Text.UTF8Encoding($false)))
    if ([IO.File]::Exists($receipt)) { [IO.File]::Replace($tmp, $receipt, "$receipt.previous") }
    else { [IO.File]::Move($tmp, $receipt) }
}
function Get-LocalTcpOwner([Net.IPAddress]$address, [hashtable]$table) {
    # A held client socket identifies its server-side row even when Windows
    # omits LISTEN. An unrelated connection on the same port must never match.
    $client = [Net.Sockets.TcpClient]::new($address.AddressFamily)
    try {
        $pending = $client.BeginConnect($address, $Port, $null, $null)
        $wait = $pending.AsyncWaitHandle
        try {
            if (-not $wait.WaitOne(2500)) { throw "Port $Port local TCP connection timed out." }
            $client.EndConnect($pending)
        } catch [Net.Sockets.SocketException] {
            if ($_.Exception.GetBaseException().SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused) { return }
            throw
        } finally { $wait.Close() }

        $peer = $client.Client.LocalEndPoint
        $server = $client.Client.RemoteEndPoint
        $filter = "State=5 AND LocalPort=$($server.Port) AND RemotePort=$($peer.Port)"
        for ($attempt = 0; $attempt -lt 3; $attempt++) {
            # Normalize IPv4-mapped IPv6 and alternate textual IPv6 forms.
            $rows = @(Get-CimInstance @table -Filter $filter | Where-Object {
                ([Net.IPAddress]::Parse($_.LocalAddress)).MapToIPv6().Equals($server.Address.MapToIPv6()) -and
                ([Net.IPAddress]::Parse($_.RemoteAddress)).MapToIPv6().Equals($peer.Address.MapToIPv6())
            })
            if ($rows.Count -eq 1 -and $rows[0].OwningProcess -gt 0) { return $rows[0] }
            if ($attempt -lt 2) { Start-Sleep -Milliseconds 100 }
        }
        throw "Local port $Port accepted a connection, but its server PID could not be verified."
    } finally { $client.Close() }
}
function Get-Listeners([switch]$Waiting) {
    if (-not $Port) { return }
    try {
        $table = @{ Namespace = 'root/StandardCimv2'; ClassName = 'MSFT_NetTCPConnection'; OperationTimeoutSec = 2; ErrorAction = 'Stop' }
        $listeners = @(Get-CimInstance @table -Filter "State=2 AND LocalPort=$Port")
        if (@($listeners | Where-Object { $_.OwningProcess -le 0 }).Count) {
            throw "Windows reported a listener on port $Port without a valid owner."
        }
        $listeners
        $known = @($listeners | ForEach-Object { [Net.IPAddress]::Parse($_.LocalAddress) })
        $endpoints = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
            Where-Object Port -eq $Port)
        foreach ($endpoint in $endpoints) {
            $address = $endpoint.Address
            if ($known -contains $address) { continue }
            if ($address.Equals([Net.IPAddress]::Any)) { $address = [Net.IPAddress]::Loopback }
            if ($address.Equals([Net.IPAddress]::IPv6Any)) { $address = [Net.IPAddress]::IPv6Loopback }
            $owner = Get-LocalTcpOwner $address $table
            if (-not $owner) { throw "Windows reported a listener on port $Port but it refused the local connection." }
            $owner
        }
        # Both tables can be empty. Check the default/LAN wildcard and localhost
        # families before treating the port as free.
        if (-not $listeners.Count -and -not $endpoints.Count) {
            if ([Net.Sockets.Socket]::OSSupportsIPv4) { Get-LocalTcpOwner ([Net.IPAddress]::Loopback) $table }
            if ([Net.Sockets.Socket]::OSSupportsIPv6) { Get-LocalTcpOwner ([Net.IPAddress]::IPv6Loopback) $table }
        }
    } catch {
        if (-not $Waiting) { throw }
        # A waiting pass can retry. An unknown owner is neither free nor ours.
        [pscustomobject]@{ OwningProcess = 0; ProbeError = $_.Exception.Message }
    }
}
function Start-HubAgain {
    if (@(Get-Listeners).Count) { throw "Port $Port is occupied. Check its owner before reopening the Hub." }
    $launchArgs = @()
    if (-not $Packaged) { $launchArgs += $HubRoot }
    if ($Lite) { $launchArgs += '--lite' }
    $launchArgs += ('--hub-update-return=' + $RequestId.ToString())
    return Start-InheritedProcess $AppExe $launchArgs
}
function Test-HubProfile($pointer, [int]$expectedPid) {
    return $pointer -and $pointer.pid -eq $expectedPid -and $pointer.profileIdentity -and
        $pointer.profileIdentity.schemaVersion -eq 1 -and $pointer.profileIdentity.status -eq 'available' -and
        $ExpectedProfileFingerprint -match '^[0-9a-f]{64}$' -and
        $pointer.profileIdentity.fingerprint -eq $ExpectedProfileFingerprint
}
function Wait-HubReturn([int]$newPid, [string]$version, [DateTimeOffset]$startTime) {
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        $proc = Get-Process -Id $newPid -ErrorAction SilentlyContinue
        if (-not $proc) { throw 'The restarted Hub exited. Inspect the executable and startup log.' }
        $pointer = if ([IO.File]::Exists($PointerPath)) { [IO.File]::ReadAllText($PointerPath) | ConvertFrom-Json }
        $listeners = @(Get-Listeners -Waiting)
        $rootOk = $pointer -and $pointer.appRoot -eq $HubRoot -and $pointer.version -eq $version -and
            $pointer.packaged -eq $Packaged.IsPresent -and $pointer.recordedAt -and
            ([DateTimeOffset]$pointer.recordedAt -ge $startTime.AddMilliseconds(-1))
        $portOk = -not $Port -or ($listeners.Count -gt 0 -and @($listeners | Where-Object OwningProcess -ne $newPid).Count -eq 0)
        if ($rootOk -and $pointer.pid -eq $newPid -and -not (Test-HubProfile $pointer $newPid)) {
            throw 'The restarted Hub profile identity is missing or different. No automatic profile copy or recovery was attempted.'
        }
        $guiOk = -not $RequireGui -or $proc.MainWindowHandle -ne [IntPtr]::Zero
        if ($rootOk -and (Test-HubProfile $pointer $newPid) -and $portOk -and $guiOk -and $proc.MainModule.FileName -eq $AppExe) {
            return
        }
        Start-Sleep -Milliseconds 400
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($listeners.ProbeError) { throw ($listeners.ProbeError -join ' ') }
    throw 'Restart verification timed out. Check the app root, version and listener owner.'
}
# A single worker owns this device from the confirmed quit through relaunch validation.
$guard = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
$state = [ordered]@{id=$RequestId.ToString(); workerPid=$PID; guiPid=$GuiPid; appRoot=$HubRoot; commit=$Commit; port=$Port;
    expectedProfileFingerprint=$ExpectedProfileFingerprint; requireGui=$RequireGui.IsPresent; profileVerified=$false}
$guiExited = $false
$exitConfirmed = $false
$launched = $false
$safeToReopen = -not $Recover
if ($Recover) {
    try {
        $previous = Read-Receipt
        if (-not $previous -or $previous.appRoot -ne $HubRoot -or $previous.commit -ne $Commit -or
            $previous.expectedProfileFingerprint -ne $ExpectedProfileFingerprint -or
            [bool]$previous.requireGui -ne $RequireGui.IsPresent -or
            (-not $previous.needsRecovery -and $previous.status -ne 'applying')) { throw 'Interrupted update receipt does not match this request.' }
    } catch { $guard.Dispose(); throw }
    $state.needsRecovery = $true
}
$state.lite = $Lite.IsPresent
try {
    $appProcess = [Diagnostics.Process]::GetProcessById($GuiPid)
    if ($appProcess.MainModule.FileName -ne $AppExe) { throw 'The running Hub executable changed. Check the active Hub path.' }
    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    $prefix = @()
    if (-not $python -or $python.Source -like '*\WindowsApps\*') {
        $python = Get-Command py.exe -ErrorAction Stop
        $prefix = @('-3')
    }
    $updater = Join-Path $HubRoot 'scripts\Sync-HubRepository.py'
    if (-not [IO.File]::Exists($updater)) { throw 'The Hub updater is missing.' }
    $foreignListeners = @(Get-Listeners | Where-Object OwningProcess -ne $GuiPid)
    if ($foreignListeners.Count) {
        throw "Port $Port belongs to another process. No update was applied."
    }
    Write-Status 'armed' 'Waiting for Hub to exit.'
    Wait-HubExit $appProcess
    $guiExited = $true
    $exitConfirmed = $true
    $rootPattern = [regex]::Escape($HubRoot.TrimEnd('\')) + '(?=[\\/"]|\s|$)'
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $other = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='node.exe' OR Name='ai-hub.exe'" |
            Where-Object { $_.ExecutablePath -eq $AppExe -or $_.CommandLine -match $rootPattern })
        $listeners = @(Get-Listeners -Waiting)
        if (-not $other.Count -and -not $listeners.Count) { break }
        Start-Sleep -Milliseconds 400
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($listeners.ProbeError) { throw ($listeners.ProbeError -join ' ') }
    if ($other.Count -or $listeners.Count) { throw 'Close remaining Hub/MCP processes and check the listening port before retrying.' }
    Write-Status 'applying' 'Applying the verified update after shutdown.'
    $safeToReopen = $false
    $argsForSync = $prefix + @($updater, '--settings', $SettingsPath, '--hub', $HubRoot, '--expected-commit', $Commit)
    if ($Recover) { $argsForSync += '--recover' }
    if ($Lite) { $argsForSync += '--lite' }
    $env:PYTHONIOENCODING = 'utf-8'
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    $output = & ($python.Source) @argsForSync
    if ($LASTEXITCODE -ne 0) { throw 'Update worker failed. Inspect the updater result before retrying.' }
    $result = ($output -join [Environment]::NewLine) | ConvertFrom-Json
    $state.backup = $result.backup
    $safeToReopen = -not $Recover -and $result.safeToRelaunch -eq $true
    if ($result.status -notin @('applied','up-to-date') -or $result.commit -ne $Commit) { throw $result.message }
    $safeToReopen = $true
    $state.needsRecovery = $false
    $state.version = $result.version
    $state.pluginStatus = $result.plugin.status
    Write-Status 'relaunching' 'Restarting the Hub at its original path.'
    $startTime = [DateTimeOffset]::UtcNow
    $newPid = Start-HubAgain
    $launched = $true
    $state.launchedPid = $newPid
    Wait-HubReturn $newPid $result.version $startTime
    $state.profileVerified = $true
    Write-Status 'verified' 'Verified the restarted Hub executable, version, app root, profile identity and configured listener.'
} catch {
    $reason = $_.Exception.Message
    $state.needsRecovery = -not $safeToReopen
    if ($guiExited -and $safeToReopen -and -not $launched -and
        (-not $RequireExitConsent -or $exitConfirmed)) {
        Write-Status 'recovering' $reason
        try {
            $recoverTime = [DateTimeOffset]::UtcNow
            $state.launchedPid = Start-HubAgain
            $recoverVersion = ([IO.File]::ReadAllText((Join-Path $HubRoot 'package.json')) | ConvertFrom-Json).version
            Wait-HubReturn $state.launchedPid $recoverVersion $recoverTime
            $state.recoveredVersion = $recoverVersion
            $state.recoveryVerified = $true
        } catch { $reason += " Relaunch was not verified: $($_.Exception.Message)" }
    }
    Write-Status 'blocked' $reason
    exit 1
} finally { $guard.Dispose() }

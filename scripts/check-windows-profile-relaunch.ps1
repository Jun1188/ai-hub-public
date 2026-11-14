param(
    [Parameter(Mandatory=$true)][string]$ElectronExe
)
$ErrorActionPreference = 'Stop'
$taskRoot = Join-Path ([IO.Path]::GetTempPath()) ('hub-profile-relaunch-' + [guid]::NewGuid().ToString('N'))
$AppExe = (Get-Item -LiteralPath $ElectronExe).FullName
if ([IO.Path]::GetFileName($AppExe) -ne 'electron.exe') {throw 'Use the standalone Electron development executable.'}
$HubRoot = Join-Path $taskRoot 'fixture app'
$taskData = Join-Path $taskRoot 'data'
$PointerPath = Join-Path $taskRoot 'pointer.json'
$taskSignal = Join-Path $taskRoot 'quit'
$taskFixtureExe = $AppExe
$Packaged = [Management.Automation.SwitchParameter]$false
$Lite = $false
$RequireGui = $false
$RequestId = [guid]::NewGuid()
$Port = 0
$tokensFound = $null; $errorsFound = $null
$tree = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Apply-HubUpdate.ps1'),[ref]$tokensFound,[ref]$errorsFound)
if ($errorsFound.Count) {throw 'Worker parser errors.'}
$required = @('Start-InheritedProcess','Start-HubAgain','Get-Listeners','Get-LocalTcpOwner','Test-HubProfile','Wait-HubReturn')
foreach ($name in $required) {
    $definition = $tree.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
    if (-not $definition) {throw "Missing worker function: $name"}
    . ([ScriptBlock]::Create($definition.Extent.Text))
}
[void][IO.Directory]::CreateDirectory($HubRoot)
[void][IO.Directory]::CreateDirectory($taskData)
$taskFixtureJs = @'
const { app } = require('electron');
const path = require('path'), fs = require('fs'), net = require('net');
const p = require('./profile-identity');
const options = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
app.setPath('userData', options.browser);
app.setPath('sessionData', options.browser);
app.setPath('crashDumps', path.join(options.browser, 'crash'));
app.on('window-all-closed', () => {});
app.whenReady().then(() => {
  const server = net.createServer(socket => socket.end());
  server.listen(options.port, '127.0.0.1', () => {
    const value = {appRoot:__dirname, version:'fixture', packaged:false, pid:process.pid,
      recordedAt:new Date().toISOString(), port:server.address().port, electron:process.versions.electron,
      profileIdentity:p.capture({dataRoot:options.data, chromiumProfile:app.getPath('userData')})};
    const dest = options.pointer + '.tmp';
    fs.writeFileSync(dest, JSON.stringify(value));
    fs.renameSync(dest, options.pointer);
  });
  const timer = setInterval(() => {
    if (fs.existsSync(options.stop)) { clearInterval(timer); server.close(() => app.quit()); }
  }, 80);
  setTimeout(() => app.exit(2), 90000).unref();
}).catch(() => app.exit(1));
'@
function Write-FixtureOptions($profile) {
    [void][IO.Directory]::CreateDirectory($profile)
    [IO.File]::WriteAllText((Join-Path $HubRoot 'fixture.json'),
        (@{data=$taskData; browser=$profile; pointer=$PointerPath; stop=$taskSignal; port=$Port} | ConvertTo-Json))
}
function Stop-Fixture($procId) {
    [IO.File]::WriteAllText($taskSignal,'quit')
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($proc -and ($proc.MainModule.FileName -ne $taskFixtureExe -or -not $proc.WaitForExit(15000))) {
        throw 'Synthetic Electron did not exit normally.'
    }
    [IO.File]::Delete($taskSignal)
}
try {
    # A dispatcher opened by Node execFile must finish before the worker
    # finishes. Holding the original pipe would deadlock the quit handoff.
    $launcherScript = Join-Path $taskRoot 'dispatch.ps1'
    $definition = $tree.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Start-InheritedProcess'},$true).Extent.Text
    $fixtureLauncher = $definition + [Environment]::NewLine +
        '$HubRoot = $PSHOME' + [Environment]::NewLine +
        'Start-InheritedProcess (Join-Path $PSHOME ''powershell.exe'') @(''-NoProfile'',''-NonInteractive'',''-Command'',''Start-Sleep -Seconds 6'') -Hidden'
    [IO.File]::WriteAllText($launcherScript,$fixtureLauncher)
    $pipeCheck = @'
const {execFile}=require('child_process');
const args=process.argv.slice(2);
execFile('powershell.exe',['-NoProfile','-NonInteractive','-File',...args],{windowsHide:true,timeout:15000},
  (error,out)=>{ if(error) throw error; const id=Number(out.trim()); if(!(id>0)) throw Error('Missing fixture child');
    process.kill(id,0); });
'@
    $pipeCheckFile = Join-Path $taskRoot 'check-dispatch.cjs'
    [IO.File]::WriteAllText($pipeCheckFile,$pipeCheck)
    & node.exe $pipeCheckFile $launcherScript
    if ($LASTEXITCODE -ne 0) {throw 'Dispatch retained output handles or worker failed to start.'}
    [IO.File]::WriteAllText((Join-Path $HubRoot 'package.json'),'{"name":"hub-profile-fixture","version":"1.0.0","main":"main.js"}')
    [IO.File]::WriteAllText((Join-Path $HubRoot 'main.js'),$taskFixtureJs)
    [IO.File]::WriteAllText((Join-Path $taskData 'config.local.json'),'{}')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../src/core/profile-identity.js') -Destination $HubRoot
    $profile = Join-Path $taskRoot 'browser'
    Write-FixtureOptions $profile
    $first = Start-InheritedProcess $AppExe @($HubRoot) -Hidden
    $limit = [DateTime]::UtcNow.AddSeconds(30)
    while (-not [IO.File]::Exists($PointerPath) -and [DateTime]::UtcNow -lt $limit) {Start-Sleep -Milliseconds 120}
    $before = [IO.File]::ReadAllText($PointerPath) | ConvertFrom-Json
    if ($before.pid -ne $first -or $before.profileIdentity.status -ne 'available') {throw 'Missing first process identity.'}
    $Port = [int]$before.port
    $ExpectedProfileFingerprint = $before.profileIdentity.fingerprint
    Stop-Fixture $first
    Write-FixtureOptions $profile
    $started = [DateTimeOffset]::UtcNow
    $same = Start-HubAgain
    Wait-HubReturn $same 'fixture' $started
    Stop-Fixture $same
    Write-FixtureOptions (Join-Path $taskRoot 'alternative-browser')
    $started = [DateTimeOffset]::UtcNow
    $wrong = Start-HubAgain
    $blocked = $false
    try {Wait-HubReturn $wrong 'fixture' $started} catch {
        if ($_.Exception.Message -notlike '*profile identity is missing or different*') {throw}
        $blocked = $true
    }
    Stop-Fixture $wrong
    if (-not $blocked) {throw 'The wrong Electron profile was accepted.'}
    Write-Output ("Standalone Electron {0}: normal exit and restart accepted, same executable/port under a different profile rejected." -f $before.electron)
} finally {
    $resolved = [IO.Path]::GetFullPath($taskRoot)
    $parent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    $item = Get-Item -LiteralPath $resolved
    if ([IO.Path]::GetDirectoryName($resolved) -ne $parent -or -not $item.Name.StartsWith('hub-profile-relaunch-') -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw 'Unexpected temporary directory.'}
    # A failed fixture keeps its own 90 s exit timer. Preserve its files for diagnosis.
    if ($blocked) {Remove-Item -LiteralPath $resolved -Recurse -Force}
}

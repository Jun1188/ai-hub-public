param(
    [Parameter(Mandatory=$true)][string]$RuntimeRoot,
    [Parameter(Mandatory=$true)][string]$OutputRoot,
    [string]$SourceRoot = ''
)
$ErrorActionPreference = 'Stop'
if (-not $SourceRoot) { $SourceRoot = Split-Path -Parent $PSScriptRoot }
$taskSource = [IO.Path]::GetFullPath($SourceRoot)
$taskRuntime = [IO.Path]::GetFullPath($RuntimeRoot)
$taskOutput = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $taskOutput) { throw 'Output already exists. Choose a new output directory.' }
$taskRuntimeExe = @('ai-hub.exe', 'AI All-In-One Hub.exe') | Where-Object { Test-Path -LiteralPath (Join-Path $taskRuntime $_) } | Select-Object -First 1
if (-not $taskRuntimeExe) { throw 'Installed Electron runtime is missing.' }
& (Join-Path $PSScriptRoot 'Verify-ReleaseRuntimes.ps1') -RuntimeRoot $taskRuntime -SourceRoot $taskSource
$taskDependencies = Join-Path $taskSource 'node_modules'
if (-not (Test-Path -LiteralPath $taskDependencies)) { $taskDependencies = Join-Path $taskRuntime 'resources\app\node_modules' }
if (-not (Test-Path -LiteralPath $taskDependencies)) { throw 'Production dependencies are missing. No download was attempted.' }
if ($taskOutput.StartsWith($taskRuntime + '\', [StringComparison]::OrdinalIgnoreCase) -or $taskOutput.StartsWith($taskSource + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must be outside runtime and source.' }
New-Item -ItemType Directory -Path $taskOutput | Out-Null
# JavaScript has no compile step. Reuse the installed Electron runtime and production dependencies offline.
Get-ChildItem -LiteralPath $taskRuntime -File | Where-Object { $_.Name -notlike 'Uninstall*' } | ForEach-Object {
    if ($_.Name -eq $taskRuntimeExe) { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $taskOutput 'ai-hub.exe') } else { Copy-Item -LiteralPath $_.FullName -Destination $taskOutput }
}
Copy-Item -LiteralPath (Join-Path $taskRuntime 'locales') -Destination $taskOutput -Recurse
$taskResources = Join-Path $taskOutput 'resources'
New-Item -ItemType Directory -Path $taskResources | Out-Null
foreach ($taskEntry in (Get-ChildItem -LiteralPath (Join-Path $taskRuntime 'resources'))) {
    if ($taskEntry.Name -eq 'app' -or $taskEntry.Name -eq 'app.asar') { continue }
    Copy-Item -LiteralPath $taskEntry.FullName -Destination $taskResources -Recurse
}
$taskApp = Join-Path $taskResources 'app'
New-Item -ItemType Directory -Path $taskApp | Out-Null
foreach ($taskName in @('electron','src','ui','scripts','skills','docs','build','resources','package.json','package-lock.json')) {
    $taskPath = Join-Path $taskSource $taskName
    if (Test-Path -LiteralPath $taskPath) { Copy-Item -LiteralPath $taskPath -Destination $taskApp -Recurse }
}
Copy-Item -LiteralPath $taskDependencies -Destination $taskApp -Recurse
$taskMarkerDir = Join-Path $taskApp 'resources'
New-Item -ItemType Directory -Path $taskMarkerDir -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $taskMarkerDir 'lite-profile.txt'), 'lite', [Text.UTF8Encoding]::new($true))
$taskLauncher = Join-Path $taskOutput 'Launch-AI-Hub-Lite.vbs'
$taskVbs = 'Set shell = CreateObject("WScript.Shell")' + "`r`n" + 'Set fso = CreateObject("Scripting.FileSystemObject")' + "`r`n" + 'app = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "ai-hub.exe")' + "`r`n" + 'shell.Run Chr(34) & app & Chr(34), 1, False'
[IO.File]::WriteAllText($taskLauncher, $taskVbs, [Text.Encoding]::ASCII)
$taskHashes = @()
Get-ChildItem -LiteralPath (Join-Path $taskApp 'src'),(Join-Path $taskApp 'ui'),(Join-Path $taskApp 'electron') -File -Recurse | ForEach-Object {
    $taskHashes += [pscustomobject]@{path=$_.FullName.Substring($taskApp.Length + 1);sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$taskReceipt = [ordered]@{kind='offline-portable-lite-package';builtAt=(Get-Date -Format o);runtimeSource=$taskRuntime;source=$taskSource;output=$taskOutput;downloads=$false;testsRun=$false;appLaunched=$false;files=$taskHashes}
[IO.File]::WriteAllText((Join-Path $taskOutput 'BUILD-RECEIPT.json'), ($taskReceipt | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($true))
Write-Output ('Portable lite build created: ' + $taskOutput)
Write-Output 'No dependency download, app launch, or tests performed.'

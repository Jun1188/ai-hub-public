param(
  [Parameter(Mandatory=$true)][string]$Setup,
  [Parameter(Mandatory=$true)][string]$OutputRoot
)
$ErrorActionPreference='Stop'
$targetRoot=[IO.Path]::GetFullPath($OutputRoot)
if(Test-Path -LiteralPath $targetRoot){throw 'Choose a new empty validation directory.'}
New-Item -ItemType Directory -Path $targetRoot | Out-Null
$installRoot=Join-Path $targetRoot 'installed'
$before=[DateTime]::UtcNow.ToString('o')
$setupPath=(Resolve-Path -LiteralPath $Setup).Path
$installed=Start-Process -FilePath $setupPath -ArgumentList @('/S',('/D='+$installRoot)) -WindowStyle Hidden -Wait -PassThru
if($installed.ExitCode -ne 0){throw ('Setup exit '+$installed.ExitCode)}
$appExe=Join-Path $installRoot 'AI Hub Lite.exe'
if(!(Test-Path -LiteralPath $appExe)){throw 'Installed app executable is missing.'}
$spec=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'release-runtimes.json')|ConvertFrom-Json
if((Get-FileHash -LiteralPath (Join-Path $installRoot 'resources/runtime/node.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $spec.node.sha256){throw 'Installed Node hash mismatch.'}
$herdrRoot=Join-Path $installRoot 'resources/herdr'
$herdrManifest=Get-Content -Raw -LiteralPath (Join-Path $herdrRoot 'herdr-manifest.json')|ConvertFrom-Json
foreach($entry in $herdrManifest.files.PSObject.Properties){
  if((Get-FileHash -LiteralPath (Join-Path $herdrRoot $entry.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value){throw ('Installed HerdR file hash mismatch: '+$entry.Name)}
}
$vendorVersion=Join-Path $targetRoot 'herdr-version.txt'
$vendorProcess=Start-Process -FilePath (Join-Path $herdrRoot 'herdr.exe') -ArgumentList '--version' -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $vendorVersion
if($vendorProcess.ExitCode -ne 0 -or (Get-Content -Raw -LiteralPath $vendorVersion) -notmatch [regex]::Escape($spec.herdr.version)){throw 'Installed HerdR version command failed.'}
$report=Join-Path $targetRoot 'first-launch.json'
$previousAppData=$env:APPDATA
$env:APPDATA=Join-Path $targetRoot 'profile-roaming'
$env:AIHUB_PUBLIC_VALIDATION=$report
try {
  $appProcess=Start-Process -FilePath $appExe -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $targetRoot 'app-stdout.txt') -RedirectStandardError (Join-Path $targetRoot 'app-stderr.txt')
  if(!$appProcess.WaitForExit(90000)){throw 'First launch did not finish within 90 seconds; keep evidence and investigate the exact test process.'}
} finally {
  $env:APPDATA=$previousAppData
  Remove-Item Env:\AIHUB_PUBLIC_VALIDATION -ErrorAction SilentlyContinue
}
if(!(Test-Path -LiteralPath $report)){throw 'First-launch report is missing.'}
$first=Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
if(!$first.pass){throw 'First-launch report failed.'}
$uninstall=Join-Path $installRoot 'Uninstall AI Hub Lite.exe'
if(!(Test-Path -LiteralPath $uninstall)){throw 'Uninstaller is missing.'}
$removed=Start-Process -FilePath $uninstall -ArgumentList @('/S',('_?='+$installRoot)) -WindowStyle Hidden -Wait -PassThru
if($removed.ExitCode -ne 0){throw ('Uninstaller exit '+$removed.ExitCode)}
if(Test-Path -LiteralPath $appExe){throw 'Application executable remained after uninstall.'}
# _?= runs in place so the caller cleans only the known test uninstaller afterward.
if(Test-Path -LiteralPath $uninstall){Remove-Item -LiteralPath $uninstall -Force}
if(@(Get-ChildItem -LiteralPath $installRoot -Force -ErrorAction SilentlyContinue).Count){throw 'Application files remained after uninstall.'}
if(Test-Path -LiteralPath $installRoot){Remove-Item -LiteralPath $installRoot -Force}
$receipt=[ordered]@{startedAtUtc=$before;finishedAtUtc=[DateTime]::UtcNow.ToString('o');setupSha256=(Get-FileHash -LiteralPath $setupPath -Algorithm SHA256).Hash.ToLowerInvariant();setupExit=$installed.ExitCode;installedRuntimeHashesVerified=$true;herdrVersionCommand=([IO.File]::ReadAllText($vendorVersion)).Trim();firstLaunch=$first;uninstallExit=$removed.ExitCode;appRemoved=$true;installationDirectoryRemoved=$true;environment=$(if($env:GITHUB_ACTIONS -eq 'true'){'fresh-github-windows-runner'}else{'local-windows-isolated-profile'});limits='Installer and isolated-profile first-paint observation. Physical other-PC, real-provider, upgrade and full interactive acceptance remain separate.'}
[IO.File]::WriteAllText((Join-Path $targetRoot 'installation-result.json'),($receipt|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
$receipt|ConvertTo-Json -Depth 8

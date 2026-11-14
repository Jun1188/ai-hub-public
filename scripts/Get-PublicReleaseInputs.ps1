param([Parameter(Mandatory=$true)][string]$DownloadRoot)
$ErrorActionPreference='Stop'
$sourceRoot=Split-Path -Parent $PSScriptRoot
$spec=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'release-runtimes.json')|ConvertFrom-Json
$downloadPath=[IO.Path]::GetFullPath($DownloadRoot)
$null=New-Item -ItemType Directory -Force -Path $downloadPath
function Get-VerifiedFile([string]$Url,[string]$Destination,[string]$ExpectedHash) {
  if(!(Test-Path -LiteralPath $Destination)){Invoke-WebRequest -Uri $Url -OutFile $Destination}
  if((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedHash){throw ('Supplier SHA256 mismatch: '+[IO.Path]::GetFileName($Destination))}
}
$electron=Join-Path $downloadPath $spec.electron.zipName
Get-VerifiedFile ('https://github.com/electron/electron/releases/download/v'+$spec.electron.version+'/'+$spec.electron.zipName) $electron $spec.electron.zipSha256
$runtime=Join-Path $sourceRoot 'resources/runtime'
$null=New-Item -ItemType Directory -Force -Path $runtime
Get-VerifiedFile ('https://nodejs.org/dist/v'+$spec.node.version+'/win-x64/node.exe') (Join-Path $runtime 'node.exe') $spec.node.sha256
if((Get-FileHash -LiteralPath (Join-Path $runtime 'LICENSE-node.txt') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $spec.node.licenseSha256){throw 'Tracked Node license hash mismatch.'}
$herdrManifest=Get-Content -Raw -LiteralPath (Join-Path $sourceRoot 'resources/herdr/herdr-manifest.json')|ConvertFrom-Json
$herdr=Join-Path $downloadPath $herdrManifest.zipName
Get-VerifiedFile ('https://github.com/herdrdev/herdr/releases/download/v'+$herdrManifest.version+'/'+$herdrManifest.zipName) $herdr $herdrManifest.zipSha256
& (Join-Path $PSScriptRoot 'Stage-HerdrRuntime.ps1') -Archive $herdr -SourceRoot $sourceRoot
$env:AIHUB_ELECTRON_ZIP=$electron
if($env:GITHUB_ENV){Add-Content -LiteralPath $env:GITHUB_ENV -Value ('AIHUB_ELECTRON_ZIP='+$electron)}
Write-Output 'Verified the pinned Electron, Node and HerdR release inputs.'

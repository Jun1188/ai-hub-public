param([string]$Target,[string]$Pending,[string]$Backup,[string]$Expected,[string]$OwnerMarker)
$ErrorActionPreference='Stop'
$lock=$Target+'.writer'
$childMarker=Join-Path $lock ($PID.ToString()+'-'+[guid]::NewGuid().ToString())
try {
    if ([IO.Path]::GetFileName($Target) -ne 'config.local.json' -or $Expected -notmatch '^[a-f0-9]{64}$' -or
        $OwnerMarker -notmatch '^([0-9]+)-[a-f0-9-]{36}$' -or ($Pending -ne (Join-Path $lock ($OwnerMarker+'.tmp'))) -or
        [IO.Path]::GetDirectoryName($Target) -ne [IO.Path]::GetDirectoryName($Backup)) { exit 2 }
    [IO.File]::Open($childMarker,'CreateNew','Write','None').Dispose()
    if (!(Test-Path -LiteralPath (Join-Path $lock $OwnerMarker)) -or !(Get-Process -Id ([int]$OwnerMarker.Split('-')[0]) -ErrorAction SilentlyContinue)) {exit 3}
    $stream=[IO.File]::Open($Target,'Open','Read',([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $sha=[Security.Cryptography.SHA256]::Create()
    try { $hash=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally {$sha.Dispose();$stream.Dispose()}
    if ($hash -ne $Expected) { exit 4 }
    [IO.File]::Replace($Pending,$Target,$Backup,$false)
    'replaced'
} catch {
    $why=$_.Exception.GetBaseException().HResult -band 65535
    [Console]::WriteLine('win32:'+$why)
    exit 5
} finally {
    if ([IO.File]::Exists($childMarker)) {[IO.File]::Delete($childMarker)}
}

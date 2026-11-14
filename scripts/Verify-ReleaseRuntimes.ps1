param(
    [Parameter(Mandatory=$true)][string]$RuntimeRoot,
    [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$Archive = $env:AIHUB_ELECTRON_ZIP,
    [switch]$InputsOnly
)
$ErrorActionPreference = 'Stop'
$spec = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $SourceRoot 'scripts/release-runtimes.json') | ConvertFrom-Json
$package = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $SourceRoot 'package.json') | ConvertFrom-Json
if ($package.build.electronVersion -ne $spec.electron.version -or $package.devDependencies.electron -ne $spec.electron.version) { throw 'Electron dependency and delivery contract differ.' }
function Assert-FileHash($file, $expected) {
    $stream = [IO.File]::OpenRead($file)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','') }
    finally { $stream.Dispose(); $sha.Dispose() }
    if ($actual -ne $expected) { throw "Runtime hash mismatch: $file" }
}
$nodeRoot = Join-Path $RuntimeRoot 'resources/runtime'
$receipt = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $nodeRoot 'runtime-manifest.json') | ConvertFrom-Json
if ($receipt.sha256 -ne $spec.node.sha256 -or $receipt.version -ne "v$($spec.node.version)") { throw 'Bundled Node manifest differs from reviewed release.' }
Assert-FileHash (Join-Path $nodeRoot 'node.exe') $spec.node.sha256
Assert-FileHash (Join-Path $nodeRoot 'LICENSE-node.txt') $spec.node.licenseSha256
# Herdr ships as one directory (herdr.exe needs its app-local ConPTY files). Stage it with Stage-HerdrRuntime.ps1.
$herdrRoot = Join-Path $RuntimeRoot 'resources/herdr'
$herdr = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $herdrRoot 'herdr-manifest.json') | ConvertFrom-Json
if ($herdr.version -ne $spec.herdr.version -or $herdr.zipSha256 -ne $spec.herdr.zipSha256 -or $herdr.files.'herdr.exe' -ne $spec.herdr.exeSha256) { throw 'Bundled Herdr manifest differs from reviewed release.' }
foreach ($entry in $herdr.files.PSObject.Properties) {
    $file = Join-Path $herdrRoot $entry.Name
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Bundled Herdr file missing: $($entry.Name). Run scripts/Stage-HerdrRuntime.ps1 with the reviewed archive." }
    Assert-FileHash $file $entry.Value
}
if (-not $Archive) {
    $cache = Join-Path $env:LOCALAPPDATA 'electron/Cache'
    $match = Get-ChildItem -LiteralPath $cache -File -Recurse -Filter $spec.electron.zipName -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($match) { $Archive = $match.FullName }
}
if (-not $Archive -or -not (Test-Path -LiteralPath $Archive -PathType Leaf)) { throw "Supply the reviewed $($spec.electron.zipName) using AIHUB_ELECTRON_ZIP." }
Assert-FileHash $Archive $spec.electron.zipSha256
if ($InputsOnly) { return }
$null = [Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem')

# Packaging can change the icon, resources and Authenticode signature. Compare the executable code section to the pinned supplier ZIP.
function Get-CodeHash([string]$file) {
    $stream = [IO.File]::OpenRead($file)
    $reader = [IO.BinaryReader]::new($stream)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $stream.Position = 60
        $pe = $reader.ReadUInt32()
        $stream.Position = $pe
        if ($reader.ReadUInt32() -ne 0x4550) { throw "Invalid PE: $file" }
        $machine = $reader.ReadUInt16()
        $count = $reader.ReadUInt16()
        $stream.Position = $pe + 20
        $optional = $reader.ReadUInt16()
        for ($i=0; $i -lt $count; $i++) {
            $stream.Position = $pe + 24 + $optional + 40 * $i
            $name = [Text.Encoding]::ASCII.GetString($reader.ReadBytes(8)).TrimEnd([char]0)
            if ($name -ne '.text') { continue }
            $stream.Position += 8
            $length = $reader.ReadUInt32()
            $offset = $reader.ReadUInt32()
            if ($machine -ne 0x8664 -or $length -eq 0 -or [int64]$offset + $length -gt $stream.Length) { throw "Invalid x64 code section: $file" }
            $stream.Position = $offset
            $buffer = [byte[]]::new(1048576)
            while ($length -gt 0) {
                $n = $stream.Read($buffer, 0, [int][Math]::Min([int64]$length, [int64]$buffer.Length))
                if ($n -le 0) { throw "Truncated PE: $file" }
                $null = $sha.TransformBlock($buffer, 0, $n, $buffer, 0)
                $length -= $n
            }
            $null = $sha.TransformFinalBlock($buffer,0,0)
            return ([BitConverter]::ToString($sha.Hash)).Replace('-','')
        }
        throw "Missing PE code section: $file"
    } finally { $reader.Dispose(); $sha.Dispose() }
}
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
$temp = [IO.Path]::GetTempFileName()
$hasher = [Security.Cryptography.SHA256]::Create()
try {
    $exe = $zip.GetEntry('electron.exe')
    if (-not $exe) { throw 'No electron.exe in the reviewed archive.' }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($exe,$temp,$true)
    $branded = Join-Path $RuntimeRoot ($package.build.productName + '.exe')
    if ((Get-CodeHash $temp) -ne (Get-CodeHash $branded)) { throw 'Packaged Electron code differs from the supplier archive.' }
    $count = 0
    foreach ($entry in $zip.Entries) {
        if ($entry.FullName -notmatch '^([^/]+\.(?:dll|bin|dat|pak)|vk_swiftshader_icd\.json|locales/[^/]+\.pak)$') { continue }
        $data = $entry.Open()
        try { $expected = ([BitConverter]::ToString($hasher.ComputeHash($data))).Replace('-','') } finally { $data.Dispose() }
        Assert-FileHash (Join-Path $RuntimeRoot $entry.FullName) $expected
        $count++
    }
    if ($count -lt 5) { throw 'Runtime archive lacks expected data files.' }
    Write-Output "Verified Electron $($spec.electron.version) executable code and $count runtime files, Node $($spec.node.version) and its license."
} finally { $hasher.Dispose(); $zip.Dispose(); [IO.File]::Delete($temp) }

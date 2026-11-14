param(
    [Parameter(Mandatory=$true)][string]$Archive,
    [string]$SourceRoot,
    # Default: the source checkout, for packaging. An install updated without Setup passes its own resources/herdr.
    [string]$TargetDir
)
# Places the reviewed Herdr supplier ZIP into resources/herdr.
# Binaries stay out of Git; nothing is downloaded, installed for the user or added to PATH.
$ErrorActionPreference = 'Stop'
# $PSScriptRoot is empty in a param default when Windows PowerShell 5.1 starts the script with -File and a relative path.
if (-not $SourceRoot) { $SourceRoot = Split-Path -Parent (Split-Path -Parent (Resolve-Path -LiteralPath $MyInvocation.MyCommand.Path)) }
$tracked = Join-Path $SourceRoot 'resources/herdr'
$target = if ($TargetDir) { $TargetDir } else { $tracked }
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $tracked 'herdr-manifest.json') | ConvertFrom-Json
function Get-Sha256([string]$file) { (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower() }
if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) { throw "Herdr archive not found: $Archive" }
if ((Split-Path -Leaf $Archive) -ne $manifest.zipName) { throw "Expected $($manifest.zipName)." }
if ((Get-Sha256 $Archive) -ne $manifest.zipSha256) { throw 'Herdr archive hash differs from the reviewed release.' }
$temp = Join-Path ([IO.Path]::GetTempPath()) ('hub-herdr-' + [Guid]::NewGuid().ToString('N'))
try {
    Expand-Archive -LiteralPath $Archive -DestinationPath $temp
    foreach ($entry in $manifest.files.PSObject.Properties) {
        $from = Join-Path $temp $entry.Name
        # The supplier ZIP has no Apache license text; that file is tracked in Git next to the manifest.
        if (-not (Test-Path -LiteralPath $from -PathType Leaf)) { $from = Join-Path $tracked $entry.Name }
        if ((Get-Sha256 $from) -ne $entry.Value) { throw "Herdr file hash mismatch: $($entry.Name)" }
        $to = Join-Path $target $entry.Name
        if ($from -ne $to) {
            $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to)
            Copy-Item -LiteralPath $from -Destination $to -Force
        }
    }
    if ($target -ne $tracked) { Copy-Item -LiteralPath (Join-Path $tracked 'herdr-manifest.json') -Destination (Join-Path $target 'herdr-manifest.json') -Force }
    Write-Output "Staged Herdr $($manifest.version): $(@($manifest.files.PSObject.Properties).Count) verified files in $target."
} finally {
    if (Test-Path -LiteralPath $temp) {
        # Recursive delete only of the extraction folder created above: a real hub-herdr-<GUID> directory directly under the temp root.
        $item = Get-Item -LiteralPath $temp -Force
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
        if ($item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
            $item.Parent.FullName.TrimEnd('\') -eq $tempRoot -and $item.Name -match '^hub-herdr-[0-9a-f]{32}$') {
            Remove-Item -LiteralPath $item.FullName -Recurse -Force
        } else { Write-Warning "Left the extraction folder in place because it did not match the expected temp path: $temp" }
    }
}

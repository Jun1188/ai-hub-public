$ErrorActionPreference = 'Stop'
$taskSource = Join-Path $PSScriptRoot 'Apply-HubUpdate.ps1'
$taskTokens = $null
$taskErrors = $null
$taskAst = [Management.Automation.Language.Parser]::ParseFile($taskSource, [ref]$taskTokens, [ref]$taskErrors)
if ($taskErrors.Count) { throw 'Profile worker source has parser errors.' }
$taskFunctions = @($taskAst.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('Test-HubProfile','Wait-HubReturn')
}, $true))
if ($taskFunctions.Count -ne 2) { throw 'Expected exactly two profile/return functions.' }
foreach ($taskFunction in $taskFunctions) { . ([ScriptBlock]::Create($taskFunction.Extent.Text)) }
$taskFixture = Join-Path ([IO.Path]::GetTempPath()) ('hub-profile-guard-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($taskFixture)
$PointerPath = Join-Path $taskFixture 'pointer.json'
$HubRoot = Join-Path $taskFixture 'app'
$AppExe = Join-Path $HubRoot 'fixture.exe'
$Port = 8763
$Packaged = [Management.Automation.SwitchParameter]$true
$RequireGui = $false
$ExpectedProfileFingerprint = 'a' * 64
$taskStart = [DateTimeOffset]::UtcNow
$taskProcess = [pscustomobject]@{ MainModule = [pscustomobject]@{FileName=$AppExe}; MainWindowHandle = [IntPtr]1 }
function Get-Process { param($Id, $ErrorAction) return $taskProcess }
function Get-Listeners { param([switch]$Waiting) return [pscustomobject]@{OwningProcess=500} }
function Start-Sleep { param($Milliseconds) throw 'fixture_pending_instead_of_verified' }
function Set-TaskPointer($fingerprint, $processId = 500, $status = 'available') {
    $value = @{schemaVersion=2; appRoot=$HubRoot; version='1.32.59'; packaged=$true;
        pid=$processId; recordedAt=[DateTimeOffset]::UtcNow.ToString('o');
        profileIdentity=@{schemaVersion=1; status=$status; fingerprint=$fingerprint}}
    [IO.File]::WriteAllText($PointerPath, ($value | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    return ($value | ConvertTo-Json -Depth 4 | ConvertFrom-Json)
}
$taskPassed = 0
function Assert-Task($condition, $message) { if (-not $condition) { throw $message } }
function Assert-TaskThrows([scriptblock]$action, $message) {
    $failed = $false
    try { & $action } catch { $failed = $true }
    Assert-Task $failed $message
}
try {
    $taskPointer = Set-TaskPointer $ExpectedProfileFingerprint
    Assert-Task (Test-HubProfile $taskPointer 500) 'Matching original profile/PID should match.'
    $taskPassed++
    Assert-Task (-not (Test-HubProfile $taskPointer 501)) 'Old PID must not verify a new process.'
    $taskPassed++
    $taskPointer = Set-TaskPointer ('b' * 64)
    Assert-Task (-not (Test-HubProfile $taskPointer 500)) 'Same exe/version/port with a different profile must not match.'
    Assert-TaskThrows { Wait-HubReturn 500 '1.32.59' $taskStart } 'Wrong profile must block actual return verification.'
    $taskPassed++
    $taskPointer = Set-TaskPointer $ExpectedProfileFingerprint 500 'unavailable'
    Assert-TaskThrows { Wait-HubReturn 500 '1.32.59' $taskStart } 'Unavailable profile evidence must block verification.'
    $taskPassed++
    $taskPointer = Set-TaskPointer $ExpectedProfileFingerprint 501
    Assert-TaskThrows { Wait-HubReturn 500 '1.32.59' $taskStart } 'A pointer from another PID must remain unverified.'
    $taskPassed++
    $taskPointer = Set-TaskPointer $ExpectedProfileFingerprint
    Wait-HubReturn 500 '1.32.59' $taskStart
    $taskPassed++
    $taskPointer = Set-TaskPointer $ExpectedProfileFingerprint
    $taskPointer.recordedAt = $taskStart.AddSeconds(-3).ToString('o')
    [IO.File]::WriteAllText($PointerPath, ($taskPointer | ConvertTo-Json -Depth 4))
    Assert-TaskThrows { Wait-HubReturn 500 '1.32.59' $taskStart } 'Stale pointer must not verify.'
    $taskPassed++
    $taskPointer = Set-TaskPointer $ExpectedProfileFingerprint
    $RequireGui = $true
    $taskProcess.MainWindowHandle = [IntPtr]::Zero
    Assert-TaskThrows { Wait-HubReturn 500 '1.32.59' $taskStart } 'A required GUI must not verify a headless process.'
    $taskPassed++
    $taskProcess.MainWindowHandle = [IntPtr]1
    Wait-HubReturn 500 '1.32.59' $taskStart
    $taskPassed++
    $ExpectedProfileFingerprint = ''
    Assert-Task (-not (Test-HubProfile $taskPointer 500)) 'Missing original caller proof must never match.'
    $taskPassed++
    Write-Output ("profile-worker: {0} cases passed on PowerShell {1}; mocked processes/listeners only" -f $taskPassed, $PSVersionTable.PSVersion)
} finally {
    $taskResolved = [IO.Path]::GetFullPath($taskFixture)
    $taskTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $taskItem = Get-Item -LiteralPath $taskResolved
    if (-not $taskResolved.StartsWith($taskTemp, [StringComparison]::OrdinalIgnoreCase) -or
        -not $taskItem.Name.StartsWith('hub-profile-guard-') -or
        ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected fixture; preserve it.' }
    Remove-Item -LiteralPath $taskResolved -Recurse -Force
}

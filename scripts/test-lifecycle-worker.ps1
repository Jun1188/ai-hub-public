$ErrorActionPreference = 'Stop'
$taskSource = Join-Path $PSScriptRoot 'Apply-HubUpdate.ps1'
$taskTokens = $null
$taskErrors = $null
$taskAst = [Management.Automation.Language.Parser]::ParseFile($taskSource, [ref]$taskTokens, [ref]$taskErrors)
if ($taskErrors.Count) { throw 'Update worker has parser errors.' }
$taskNames = @('Read-ExitConsent', 'Wait-HubExit', 'Write-Status')
$taskFunctions = @($taskAst.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $taskNames
}, $true))
if ($taskFunctions.Count -ne 3) { throw 'Expected the three isolated worker functions.' }
foreach ($taskFunction in $taskFunctions) {
    . ([ScriptBlock]::Create($taskFunction.Extent.Text))
}

$taskFixture = Join-Path ([IO.Path]::GetTempPath()) ('ai-hub-worker-test-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($taskFixture)
$stateDir = $taskFixture
$receipt = Join-Path $taskFixture 'repository-apply-result.json'
$exitConsentPath = Join-Path $taskFixture 'consent.json'
$RequestId = [guid]'00000000-0000-4000-8000-000000000001'
$Commit = 'a' * 40
$RequireExitConsent = $true
$taskPassed = 0
function Assert-Task($condition, $message) {
    if (-not $condition) { throw $message }
}
function Assert-TaskThrows([scriptblock]$action, $message) {
    $failed = $false
    try { & $action } catch { $failed = $true }
    Assert-Task $failed $message
}
function Set-TaskConsent($allow, $commitValue = $Commit) {
    $record = @{schemaVersion=1; id=$RequestId.ToString(); commit=$commitValue; allowExit=$allow}
    [IO.File]::WriteAllText($exitConsentPath, ($record | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
}
function New-TaskProcess {
    $process = [pscustomobject]@{Calls=0}
    $process | Add-Member ScriptMethod WaitForExit { param($milliseconds) $this.Calls++; return $true }
    return $process
}
try {
    Assert-Task ($null -eq (Read-ExitConsent)) 'Missing consent must remain absent.'
    $taskPassed++
    [IO.File]::WriteAllText($exitConsentPath, 'null')
    Assert-TaskThrows { Read-ExitConsent } 'JSON null must be rejected.'
    $taskPassed++
    Set-TaskConsent $true
    $taskProcess = New-TaskProcess
    Wait-HubExit $taskProcess
    Assert-Task ($taskProcess.Calls -eq 1) 'Valid consent should permit the confirmed exit.'
    $taskPassed++
    Set-TaskConsent $false
    $taskProcess = New-TaskProcess
    Assert-TaskThrows { Wait-HubExit $taskProcess } 'Cancelled consent must reject exit.'
    Assert-Task ($taskProcess.Calls -eq 0) 'Cancellation must be checked before waiting.'
    $taskPassed++
    [IO.File]::Delete($exitConsentPath)
    $taskProcess = New-TaskProcess
    Assert-TaskThrows { Wait-HubExit $taskProcess } 'An observed process exit is insufficient without consent.'
    $taskPassed++
    Set-TaskConsent $true ('b' * 40)
    Assert-TaskThrows { Read-ExitConsent } 'A changed commit must reject consent.'
    $taskPassed++
    Set-TaskConsent 'true'
    Assert-TaskThrows { Read-ExitConsent } 'String consent must not count as Boolean consent.'
    $taskPassed++
    $RequireExitConsent = $false
    Wait-HubExit (New-TaskProcess)
    $taskPassed++
    $state = [ordered]@{id=$RequestId.ToString(); appRoot=$taskFixture; commit=$Commit}
    Write-Status 'armed' 'Synthetic worker A.'
    Write-Status 'verified' 'Synthetic worker A verified.'
    $taskHistoryA = Join-Path $taskFixture ('repository-apply-results/' + $RequestId.ToString() + '.json')
    $taskBytesA = [IO.File]::ReadAllBytes($taskHistoryA)
    $RequestId = [guid]'00000000-0000-4000-8000-000000000002'
    $state = [ordered]@{id=$RequestId.ToString(); appRoot=$taskFixture; commit=$Commit}
    Write-Status 'armed' 'Synthetic worker B.'
    $taskPrior = [IO.File]::ReadAllText($taskHistoryA) | ConvertFrom-Json
    $taskLatest = [IO.File]::ReadAllText($receipt) | ConvertFrom-Json
    Assert-Task ($taskPrior.status -eq 'verified' -and $taskLatest.id -eq $RequestId.ToString()) 'Worker history must survive a new global receipt.'
    Assert-Task ([Convert]::ToBase64String($taskBytesA) -eq [Convert]::ToBase64String([IO.File]::ReadAllBytes($taskHistoryA))) 'Later workers must preserve old receipt bytes.'
    $taskPassed++
    Write-Output ("worker-functions: {0} cases passed on PowerShell {1}; no app or WMI launch" -f $taskPassed, $PSVersionTable.PSVersion)
} finally {
    $taskResolved = [IO.Path]::GetFullPath($taskFixture)
    $taskTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $taskItem = Get-Item -LiteralPath $taskResolved
    if (-not $taskResolved.StartsWith($taskTemp, [StringComparison]::OrdinalIgnoreCase) -or
        -not $taskItem.Name.StartsWith('ai-hub-worker-test-') -or
        ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Preserve unexpected fixture path; refusing cleanup.'
    }
    Remove-Item -LiteralPath $taskResolved -Recurse -Force
}

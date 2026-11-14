$ErrorActionPreference = 'Stop'
$taskLogPath = $null
try {
    $taskUserProfile = [Environment]::GetFolderPath('UserProfile')
    $env:APPDATA = Join-Path $taskUserProfile 'AppData\Roaming'
    $env:LOCALAPPDATA = Join-Path $taskUserProfile 'AppData\Local'
    $taskLogRoot = Join-Path $env:LOCALAPPDATA 'ai-hub\startup'
    New-Item -ItemType Directory -Path $taskLogRoot -Force | Out-Null
    $taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $taskLogPath = Join-Path $taskLogRoot ('launch-' + $taskStamp + '.log')
    $taskStdoutPath = Join-Path $taskLogRoot ('stdout-' + $taskStamp + '.log')
    $taskStderrPath = Join-Path $taskLogRoot ('stderr-' + $taskStamp + '.log')
    ('started=' + (Get-Date -Format o)) | Out-File -LiteralPath $taskLogPath -Encoding utf8
    $taskAppRoot = Split-Path -Parent $PSScriptRoot
    $taskResourcesRoot = Split-Path -Parent $taskAppRoot
    $taskInstallRoot = Split-Path -Parent $taskResourcesRoot
    $taskExecutable = Join-Path $taskInstallRoot 'ai-hub.exe'
    $taskSettingsPath = Join-Path $env:APPDATA 'ai-hub\config.local.json'
    $taskSettings = Get-Content -LiteralPath $taskSettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    ('settingsPath=' + $taskSettingsPath) | Out-File -LiteralPath $taskLogPath -Append -Encoding utf8
    $taskProfileBefore = [ordered]@{ profile=$taskSettings.hub.profile; automaticPreparation=$taskSettings.localRuntimes.automaticPreparation; autoStart=$taskSettings.hub.autoStart }
    ('settingsBefore=' + ($taskProfileBefore | ConvertTo-Json -Compress)) | Out-File -LiteralPath $taskLogPath -Append -Encoding utf8
    if ($taskSettings.hub.profile -ne 'lite' -or $taskSettings.localRuntimes.automaticPreparation -ne $false -or $taskSettings.hub.autoStart -ne $false) {
        # 경량 전용 진입점이므로 해당 기기 설정 세 항목만 복구한다.
        # 인증 값과 그 밖의 설정은 그대로 유지하고, 원본은 기기 전용 경로에 둔다.
        $taskSettingsHash = (Get-FileHash -LiteralPath $taskSettingsPath -Algorithm SHA256).Hash
        $taskSettingsBackup = Join-Path $taskLogRoot ('config-before-lite-' + $taskStamp + '.json')
        Copy-Item -LiteralPath $taskSettingsPath -Destination $taskSettingsBackup
        foreach ($taskSection in @('hub', 'localRuntimes')) {
            if ($null -eq $taskSettings.$taskSection) {
                $taskSettings | Add-Member -MemberType NoteProperty -Name $taskSection -Value ([PSCustomObject]@{}) -Force
            } elseif ($taskSettings.$taskSection -isnot [PSCustomObject]) {
                throw ('설정 구조가 올바르지 않습니다: ' + $taskSection)
            }
        }
        $taskSettings.hub | Add-Member -MemberType NoteProperty -Name profile -Value 'lite' -Force
        $taskSettings.hub | Add-Member -MemberType NoteProperty -Name autoStart -Value $false -Force
        $taskSettings.localRuntimes | Add-Member -MemberType NoteProperty -Name automaticPreparation -Value $false -Force
        if ((Get-FileHash -LiteralPath $taskSettingsPath -Algorithm SHA256).Hash -ne $taskSettingsHash) { throw '설정이 다른 작업에서 변경됐습니다. 다시 실행하세요.' }
        $taskSettingsTemp = $taskSettingsPath + '.lite-' + $taskStamp + '.tmp'
        [IO.File]::WriteAllText($taskSettingsTemp, ($taskSettings | ConvertTo-Json -Depth 64), (New-Object Text.UTF8Encoding($true)))
        Move-Item -LiteralPath $taskSettingsTemp -Destination $taskSettingsPath -Force
        'liteSettingsRepaired=true' | Out-File -LiteralPath $taskLogPath -Append -Encoding utf8
    }
    if (-not (Test-Path -LiteralPath $taskExecutable)) { throw '설치된 Hub 실행 파일을 찾지 못했습니다.' }
    ('executable=' + $taskExecutable) | Out-File -LiteralPath $taskLogPath -Append -Encoding utf8
    ('electronRunAsNode=' + $env:ELECTRON_RUN_AS_NODE) | Out-File -LiteralPath $taskLogPath -Append -Encoding utf8
    # Inherited MCP Node mode must not turn a GUI launch into a Node process.
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    # 사용자가 바로가기를 누를 때만 대화형 Hub 창을 연다.
    $taskProcess = Start-Process -FilePath $taskExecutable -ArgumentList '--lite' -WorkingDirectory $taskInstallRoot -WindowStyle Normal -RedirectStandardOutput $taskStdoutPath -RedirectStandardError $taskStderrPath -PassThru
    $taskProcessHandle = $taskProcess.Handle # Keep the handle before a second instance can exit.
    ('pid=' + $taskProcess.Id) | Out-File -LiteralPath $taskLogPath -Append -Encoding utf8
    if ($taskProcess.WaitForExit(4000)) {
        $taskExitCode = $taskProcess.ExitCode
        $taskHandoff = $null -eq $taskExitCode -and @(Get-Process -Name 'ai-hub' -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $taskProcess.Id -and $_.Path -eq $taskExecutable }).Count -gt 0
        ('exitCode=' + $taskExitCode + ';existingInstanceHandoff=' + $taskHandoff) | Out-File -LiteralPath $taskLogPath -Append -Encoding utf8
        if (-not $taskHandoff -and ($null -eq $taskExitCode -or $taskExitCode -ne 0)) { throw ('Hub가 시작 직후 종료됐습니다. 종료 코드: ' + $taskExitCode + '. 오류 기록: ' + $taskStderrPath) }
    }
} catch {
    $taskFailure = $_.Exception.Message
    if ($taskLogPath) { ($_ | Out-String) | Out-File -LiteralPath $taskLogPath -Append -Encoding utf8 }
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(($taskFailure + [Environment]::NewLine + '실행 기록: ' + $taskLogPath), 'ai-hub (경량) 실행 오류', 'OK', 'Error') | Out-Null
    exit 1
}
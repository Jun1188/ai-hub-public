'use strict';
require('./stdio-lifecycle').guard();
require('./user-profile');
const { app, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const repositoryUpdate = require('../src/core/repository-update');
const gate = repositoryUpdate.startupGate();

async function begin() {
  const recover = gate === 'recovery';
  const receipt = recover ? repositoryUpdate.status().delivery : null;
  const stateDir = require('../src/core/paths').hubDataDir();
  const deviceConfig = require('../src/core/device-config-replace');
  if (deviceConfig.recoveryPending(path.join(stateDir, 'config.local.json'))) {
    await app.whenReady();
    await dialog.showMessageBox({ type: 'error', title: 'ai-hub 기기 설정 복구',
      message: deviceConfig.recoveryMessage, detail: '이 PC의 설정 폴더\n' + stateDir,
      buttons: ['닫기'], defaultId: 0, cancelId: 0 });
    app.quit();
    return;
  }
  let localProfile;
  try { localProfile = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.local.json'), 'utf8').replace(/^\uFEFF/, '')).hub?.profile; }
  catch { /* Device profile may not exist yet. */ }
  const lite = receipt?.lite === true || localProfile === 'lite' || process.argv.includes('--lite')
    || fs.existsSync(path.join(__dirname, '../resources/lite-profile.txt'));
  if (recover) {
    await app.whenReady();
    const choice = await dialog.showMessageBox({ type: 'warning', title: 'ai-hub 갱신 복구',
      message: '이전 갱신이 중단됐습니다. Hub를 닫고 이 기기에 보관한 승인 커밋에서 파일을 확인해 갱신을 마칠까요?',
      buttons: ['갱신 복구', '닫기'], defaultId: 1, cancelId: 1 });
    if (choice.response !== 0) { app.quit(); return; }
  }
  const result = recover || gate === 'returned' || repositoryUpdate.manualPolicy() !== 'standard'
    ? null : await repositoryUpdate.sync({ lite });
  if (recover || result?.status === 'pending') {
    let port = receipt?.port;
    let pointerPath = path.join(stateDir, 'app-root.json');
    if (!recover) {
      const config = require('../src/core/config').load();
      port = config.hub.enabled === false ? 0 : config.hub.httpPort;
      pointerPath = path.join(require('../src/core/paths').hubDataDir(), 'app-root.json');
    } else if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error('갱신 기록의 포트를 확인할 수 없습니다. 백업과 갱신 기록을 확인하세요.');
    }
    await repositoryUpdate.startAfterExit({ guiPid: process.pid, exe: process.execPath, packaged: app.isPackaged,
      lite, port, pointerPath, recover });
    app.quit();
    return;
  }
  if (result?.status === 'blocked' || result?.status === 'busy' || result?.plugin?.status === 'blocked') {
    await app.whenReady();
    await dialog.showMessageBox({ type: 'warning', title: 'ai-hub 자동 갱신 보류', message: result.message });
    if (result.status === 'busy') { app.quit(); return; }
  }
  require('./main');
}

if (gate === 'busy') {
  app.quit();
} else if (fs.existsSync(path.join(require('../src/core/paths').hubDataDir(), 'runtime-node-update.lock'))) {
  app.whenReady().then(() => dialog.showMessageBox({ type: 'warning', title: 'ai-hub 런타임 갱신',
    message: '런타임 업데이트가 진행 중이거나 중단됐습니다. 업데이트 작업의 종료와 잠금 복구를 확인한 뒤 다시 실행해 주세요.' })).finally(() => app.quit());
} else if (process.env.AIHUB_SELFTEST && gate !== 'recovery') {
  require('./main');
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  global.aihubStartupOwnsInstanceLock = true;
  begin().catch(async error => {
    await app.whenReady();
    await dialog.showMessageBox({ type: 'error', title: 'ai-hub 갱신', message: error.message });
    app.quit();
  });
}

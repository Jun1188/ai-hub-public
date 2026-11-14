'use strict';

const path = require('path');
const { execFile } = require('child_process');
const updater = require('../src/core/updater');
const repository = require('../src/core/repository-update');

function create({ app, shareRoot, packaged, busy, port, quit, onState, onCheck }) {
  const root = path.resolve(__dirname, '..');
  const { hubDataDir } = require('../src/core/paths');
  let checking;
  function check() {
    if (!checking) {
      checking = Promise.resolve().then(async () => {
        const result = await updater.checkForUpdate(await shareRoot(), app.getVersion(), { packaged: packaged() });
        const info = { ...result, manual: true, status: repository.approval().status };
        info.message = [info.overlay.known ? '공유 저장소 v' + info.overlay.version : info.overlay.error,
          info.error || '공유 설치본 v' + info.version].join(' · ');
        onCheck(info);
        return info;
      }).finally(() => { checking = null; });
    }
    return checking;
  }
  async function build() {
    const share = await shareRoot();
    if (!share) throw new Error('공유 설치본 폴더를 먼저 설정해 주세요.');
    const node = path.join(root, 'resources', 'runtime', 'node.exe');
    const spec = require('../scripts/release-runtimes.json').node;
    if (await updater.sha256File(node) !== spec.sha256)
      throw new Error('설치본 빌드용 Node 실행 파일의 해시를 확인해 주세요.');
    return new Promise((resolve, reject) => {
      execFile(node, [path.join(root, 'scripts', 'sync-installer.js'), '--share', share], {
        cwd: root, windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 1024 * 1024,
      }, (error, stdout) => {
        try {
          const result = JSON.parse(String(stdout).trim().split('\n').pop());
          if (error || !result.ok) throw new Error(result.message || '설치본 동기화에 실패했습니다.');
          resolve(result);
        } catch (failure) { reject(failure); }
      });
    });
  }
  const returnedId = process.argv.find(arg => arg.startsWith('--hub-update-return='))?.slice('--hub-update-return='.length);
  const sync = require('../src/core/native-sync').create({
    root: hubDataDir(), check, build, busy, packaged, returnedId, onState,
    arm: expectedCommit => repository.startAfterExit({
      guiPid: process.pid, exe: process.execPath, packaged: packaged(), lite: require('../src/core/device-profile').lite(),
      port: port(), pointerPath: path.join(hubDataDir(), 'app-root.json'), expectedCommit,
    }),
    preflight: expectedCommit => repository.manualPreflight({ expectedCommit, lite: require('../src/core/device-profile').lite() }),
    delivery: () => repository.status().delivery, wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
  });
  async function begin() {
    if (repository.manualPolicy() !== 'manual') throw new Error('이 PC에 수동 동기화가 설정되지 않았습니다.');
    const result = await sync.begin();
    if (result.phase === 'restart') {
      if (busy()) throw new Error('새 작업이 시작되어 종료를 보류합니다.');
      quit();
    }
    return result;
  }
  return { ...sync, check, begin };
}
module.exports = { create };

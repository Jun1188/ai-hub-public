'use strict';

const fs = require('fs');
const path = require('path');

function create({ root, check, preflight, arm, build, busy, packaged, returnedId, delivery, onState = () => {}, wait }) {
  const stateFile = path.join(root, 'manual-sync-state.local.json');
  let running = false;

  function read() {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      if (error.code === 'ENOENT') return { phase: 'idle' };
      return { phase: 'blocked', message: '이 PC의 이전 동기화 기록을 읽을 수 없습니다.' };
    }
  }
  function state(phase, message, extra = {}) {
    const value = { phase, message, at: Date.now(), ...extra };
    fs.mkdirSync(root, { recursive: true });
    const temp = stateFile + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(temp, stateFile);
    onState(value);
    return value;
  }
  function status() {
    const value = read();
    if (!running && ['checking', 'building', 'restart'].includes(value.phase)) {
      return { ...value, phase: 'blocked', message: '이전 동기화가 끝나지 않았습니다. 적용 기록을 확인한 뒤 다시 동기화해 주세요.' };
    }
    return value;
  }
  async function exclusive(fn) {
    if (running || busy()) throw new Error('진행 중인 작업이 끝난 뒤 동기화해 주세요.');
    running = true;
    try { return await fn(); }
    catch (error) { return state('blocked', error.message); }
    finally { running = false; }
  }
  async function finish() {
    if (busy()) throw new Error('다른 작업이 시작되어 설치본 빌드를 보류했습니다.');
    if (packaged()) return state('complete', '설치된 Hub의 소스와 패널을 확인했습니다.');
    state('building', '공유 설치본을 확인하고 필요한 경우 빌드·검증·게시합니다.');
    const result = await build();
    return state('complete', result.message, { version: result.version, sha256: result.sha256 });
  }
  async function begin() {
    return exclusive(async () => {
      state('checking', '공유 저장소의 커밋과 기존 앱 파일을 확인합니다.');
      const info = await check();
      const commit = info.overlay?.commit;
      if (!info.overlay?.known || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit || ''))
        throw new Error(info.overlay?.error || '공유 저장소 커밋을 확인할 수 없습니다.');
      const receipt = await preflight(commit);
      if (receipt.commit !== commit || !['up-to-date', 'pending'].includes(receipt.status) || receipt.plugin?.status === 'blocked')
        throw new Error(receipt.message || '검토한 커밋으로 업데이트할 수 없습니다.');
      if (receipt.status === 'up-to-date') return finish();
      if (busy()) throw new Error('다른 작업이 시작되어 업데이트를 보류했습니다.');
      const armed = await arm(commit);
      return state('restart', 'Hub가 정상 종료되면 확인한 커밋을 적용합니다.', {
        id: armed.id, commit, expires: Date.now() + 30 * 60 * 1000,
      });
    });
  }
  async function resume() {
    const request = read();
    if (request.phase !== 'restart' || !returnedId || request.id !== returnedId || !(request.expires > Date.now())) return status();
    return exclusive(async () => {
      // Verify the worker's exact receipt after it has observed the relaunched app and listener.
      const deadline = Date.now() + 65000;
      for (;;) {
        const result = delivery();
        if (result?.id !== returnedId || result.commit !== request.commit || result.pluginStatus === 'blocked')
          throw new Error('재시작한 앱의 커밋 또는 패널 적용 기록이 일치하지 않습니다.');
        if (result.status === 'verified') break;
        if (result.status !== 'relaunching' || Date.now() >= deadline)
          throw new Error(result.message || '업데이트 작업자가 재시작을 확인하지 못했습니다.');
        await wait(500);
      }
      return finish();
    });
  }
  return { begin, resume, status, busy: () => running };
}

module.exports = { create };

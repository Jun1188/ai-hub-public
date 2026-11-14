#!/usr/bin/env node
// 컴퓨터 간 공유 + 업데이트 배포 스모크 테스트.
//   node scripts/test-share.js
// 사용자 데이터와 공유 폴더는 임시 프로필에 격리한다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-share-profile-'));
process.env.APPDATA = path.join(profile, 'roaming');
process.env.LOCALAPPDATA = path.join(profile, 'local');
const appRoot = path.resolve(__dirname, '..');
const share = require(path.join(appRoot, 'src', 'core', 'share.js'));
const updater = require(path.join(appRoot, 'src', 'core', 'updater.js'));
const config = require(path.join(appRoot, 'src', 'core', 'config.js'));
const { hubDataDir } = require(path.join(appRoot, 'src', 'core', 'paths.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-share-test-'));
  process.env.AIHUB_SHARE_DIR = tmp;

  console.log('1) 설정 로드가 Drive를 건드리지 않고 즉시 끝나는가');
  const t0 = Date.now();
  const cfg = config.load();
  const loadMs = Date.now() - t0;
  check(`config.load() ${loadMs}ms (2초 미만)`, loadMs < 2000, `${loadMs}ms`);
  check('share 기본 설정 존재', Boolean(cfg.share) && typeof cfg.share.dir === 'string');
  check('update 기본 설정 존재', Boolean(cfg.update) && typeof cfg.update.autoCheck === 'boolean');
  check('공유 설정 파일이 %APPDATA%에 있음',
    path.dirname(config.SHARED_FILE) === hubDataDir(), config.SHARED_FILE);
  check('config.js가 SYNC_FILE(Drive 경로)을 더는 노출하지 않음', config.SYNC_FILE === undefined);

  console.log('2) 내 드라이브 자동 탐지');
  const stat = fs.promises.stat;
  const drive = 'G:\\';
  const mounted = new Set([drive, path.join(drive, '내 드라이브')]);
  fs.promises.stat = async (p) => {
    if (mounted.has(p)) return {};
    throw Object.assign(new Error('Fixture path is absent'), { code: 'ENOENT' });
  };
  try {
    check('내 드라이브 탐지', await share.autodetectRoot() === path.join(drive, '내 드라이브', share.SHARE_FOLDER_NAME));
    mounted.clear();
    check('마운트 없을 때 null', await share.autodetectRoot() === null);
  } finally {
    fs.promises.stat = stat;
  }

  console.log('3) 로컬 → 공유 폴더 미러링');
  // 로컬에 표식 파일 하나를 만들어 공유 폴더로 나가는지 본다.
  const markerRel = path.join('memory', '__sync_test__.json');
  const markerLocal = path.join(hubDataDir(), markerRel);
  fs.mkdirSync(path.dirname(markerLocal), { recursive: true });
  fs.writeFileSync(markerLocal, JSON.stringify({ from: 'local', at: Date.now() }), 'utf8');
  // A fresh (isolated) app-data folder has no shared config yet; write one so there is something to mirror.
  config.save(config.load());

  await share.syncNow(tmp);
  const markerRemote = path.join(tmp, markerRel);
  check('표식 파일이 공유 폴더로 복사됨', fs.existsSync(markerRemote), markerRemote);
  check('공유 설정도 함께 나감', fs.existsSync(path.join(tmp, 'config.cache.json')));

  console.log('4) 공유 폴더 → 로컬 미러링 (다른 컴퓨터가 바꾼 상황)');
  const remoteOnly = path.join(tmp, 'memory', '__from_other_pc__.json');
  fs.writeFileSync(remoteOnly, JSON.stringify({ from: 'other-pc' }), 'utf8');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(remoteOnly, future, future);
  await share.syncNow(tmp);
  const cameBack = path.join(hubDataDir(), 'memory', '__from_other_pc__.json');
  check('다른 컴퓨터 파일이 로컬로 들어옴', fs.existsSync(cameBack), cameBack);

  console.log('5) 삭제는 전파되지 않는다 (마운트 사고 대비)');
  fs.unlinkSync(markerRemote);
  await share.syncNow(tmp);
  check('공유 폴더에서 지워도 로컬 파일은 살아있음', fs.existsSync(markerLocal));

  console.log('6) 공유 폴더가 사라져도 앱은 죽지 않는다');
  const gone = path.join(tmp, 'no-such-dir-여기없음');
  share.resetRoot();
  const st = await share.syncNow(gone);
  check('없는 경로로도 throw 없이 상태 반환', typeof st === 'object');
  share.resetRoot();

  await failureCases();

  console.log('7) 릴리스 게시 + 업데이트 확인');
  const fakeSetup = path.join(tmp, 'ai-hub-Setup-9.9.9.exe');
  fs.writeFileSync(fakeSetup, Buffer.alloc(1024, 7));
  const published = await updater.publish({
    shareRoot: tmp, setupPath: fakeSetup, version: '9.9.9', notes: '테스트 릴리스',
  });
  check('latest.json 생성', fs.existsSync(path.join(tmp, 'release', 'latest.json')));
  check('sha256 기록됨', /^[0-9a-f]{64}$/.test(published.latest.sha256), published.latest.sha256);
  const launcher = path.join(tmp, 'release', updater.LAUNCHER_NAME);
  check('원클릭 설치 진입점 생성', fs.existsSync(launcher), updater.LAUNCHER_NAME);
  check('진입점이 latest.json을 읽음',
    fs.readFileSync(launcher, 'utf8').includes('latest.json'));

  check('update.checkIntervalMin 기본 60분', cfg.update.checkIntervalMin === 60);
  check('Setup 다운로드 API 제거', !updater.stageSetup && !updater.stagingDir);
  check('Setup 실행 API 제거', !updater.runInstaller);

  const offline = { overlay: async () => ({ known: false, error: 'offline fixture' }) };
  const older = await updater.checkForUpdate(tmp, '1.8.0', offline);
  check('구버전에서 새 버전 감지', older.available && older.version === '9.9.9');
  const newer = await updater.checkForUpdate(tmp, '10.0.0', offline);
  check('최신 버전에서는 업데이트 없음', newer.available === false);
  const none = await updater.checkForUpdate('', '1.8.0', offline);
  check('공유 폴더 없으면 오류 메시지만', none.available === false && Boolean(none.error));

  check('버전 비교 1.10.0 > 1.9.0', updater.compareVersions('1.10.0', '1.9.0') === 1);
  check('버전 비교 1.8.0 == 1.8.0', updater.compareVersions('1.8.0', '1.8.0') === 0);

  console.log('8) 정리');
  for (const p of [markerLocal, cameBack]) {
    try { fs.unlinkSync(p); } catch { /* 이미 없음 */ }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  check('임시 공유 폴더 삭제', !fs.existsSync(tmp));

  console.log('');
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
}

// 6-1) 공유 폴더가 멈추거나 일부를 못 읽을 때 (2026-10-18 Gemini Argon 실행에서 찾은 결함).
// fs.promises를 바꿔 끼워 시간 초과·권한 오류를 만든다. 별도 APPDATA·공유 폴더에서 돈다.
async function failureCases() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-share-fail-'));
  const saved = { APPDATA: process.env.APPDATA, AIHUB_SHARE_DIR: process.env.AIHUB_SHARE_DIR };
  const real = { ...fs.promises };
  process.env.APPDATA = path.join(sandbox, 'appdata');
  const remote = path.join(sandbox, 'drive');
  process.env.AIHUB_SHARE_DIR = remote;
  const local = hubDataDir();
  const L = (...p) => path.join(local, ...p);
  const R = (...p) => path.join(remote, ...p);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const write = (file, body, ageSec) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    const t = new Date(Date.now() - ageSec * 1000);
    fs.utimesSync(file, t, t);
  };
  const read = (file) => fs.readFileSync(file, 'utf8');
  const denied = (op, p) => Promise.reject(Object.assign(new Error(`EACCES: permission denied, ${op} '${p}'`), { code: 'EACCES' }));
  const hang = (ms, fn) => sleep(ms).then(fn);
  const fresh = () => { Object.assign(fs.promises, real); share.resetRoot(); };

  try {
    console.log('6-1) 공유 폴더가 멈추거나 일부를 못 읽을 때');

    fresh();
    write(L('config.cache.json'), 'LOCAL-OLD', 100);
    write(R('config.cache.json'), 'REMOTE-NEW', 0);
    write(L('projects.json'), 'P', 0);
    fs.promises.stat = (p, ...a) => (p === R('config.cache.json') ? denied('stat', p) : real.stat(p, ...a));
    let st = await share.syncNow();
    check('권한 오류로 못 읽은 원격 파일을 로컬 옛 사본으로 덮지 않음', read(R('config.cache.json')) === 'REMOTE-NEW');
    check('그 항목만 건너뛰고 나머지는 동기화', fs.existsSync(R('projects.json')));
    check('항목 하나의 권한 오류는 실패로 세지 않고 lastError에 남김',
      !st.paused && st.enabled && /EACCES/.test(st.lastError), st.lastError);

    fresh();
    write(L('memory', 'sub', 'a.json'), 'LOCAL-OLD', 100);
    write(R('memory', 'sub', 'a.json'), 'REMOTE-NEW', 0);
    write(L('memory', 'b.json'), 'B', 0);
    fs.promises.readdir = (p, ...a) => (p === R('memory', 'sub') ? denied('scandir', p) : real.readdir(p, ...a));
    await share.syncNow();
    check('못 읽은 원격 가지 안의 파일을 로컬 옛 사본으로 덮지 않음', read(R('memory', 'sub', 'a.json')) === 'REMOTE-NEW');
    check('다른 가지는 그대로 동기화', fs.existsSync(R('memory', 'b.json')));

    fresh();
    write(L('memory', 'c.json.tmp-999'), 'LEFTOVER', 0);
    write(L('memory', 'd.json'), 'D', 0);
    fs.promises.rename = (from, to) => (to === R('memory', 'd.json')
      ? Promise.reject(Object.assign(new Error('EPERM: rename'), { code: 'EPERM' })) : real.rename(from, to));
    await share.syncNow();
    check('남은 임시파일을 일반 파일로 미러하지 않음', !fs.existsSync(R('memory', 'c.json.tmp-999')));
    check('복사 실패 뒤 임시파일을 남기지 않음',
      !fs.existsSync(R('memory', 'd.json')) && !fs.readdirSync(R('memory')).some((n) => n.startsWith('d.json.tmp-')),
      fs.readdirSync(R('memory')).join(','));

    // 공유 폴더 확인(2초)이 멈춘다 → 회차 실패. 그 호출이 안 끝난 동안은 fs를 건드리지 않고 실패로 센다.
    fresh();
    let remoteCalls = 0;
    fs.promises.stat = (p, ...a) => {
      if (p.startsWith(remote)) remoteCalls++;
      return p === remote ? hang(2500, () => real.stat(p, ...a)) : real.stat(p, ...a);
    };
    st = await share.syncNow();
    check('공유 폴더 응답이 없으면 회차를 실패로 보고', /timeout:probe/.test(st.lastError) && !st.paused, st.lastError);
    remoteCalls = 0;
    st = await share.syncNow();
    check('시간 초과된 호출이 남아 있으면 fs를 더 건드리지 않음', remoteCalls === 0 && /아직 끝나지/.test(st.lastError),
      `${remoteCalls}회, ${st.lastError}`);
    st = await share.syncNow();
    check('연속 3회 실패하면 회로 차단 + 공유 폴더 다시 확인', st.paused && st.root === '', JSON.stringify(st));
    await sleep(700);

    // 파일 stat이 5초를 넘긴다 → 회차를 끝내고, 원격 파일을 "없음"으로 보고 덮지 않는다.
    fresh();
    write(L('config.cache.json'), 'LOCAL-OLD', 100);
    write(R('config.cache.json'), 'REMOTE-NEW', 0);
    fs.promises.stat = (p, ...a) => (p === R('config.cache.json') ? hang(5500, () => real.stat(p, ...a)) : real.stat(p, ...a));
    st = await share.syncNow();
    check('시간 초과된 원격 파일을 로컬 옛 사본으로 덮지 않음', read(R('config.cache.json')) === 'REMOTE-NEW');
    check('파일 시간 초과도 회차 실패로 셈', /timeout:stat/.test(st.lastError), st.lastError);
    await sleep(700);

    // rename 뒤 utimes가 시간 초과돼도 들어온 변경으로 센다(onChange = 설정 리로드).
    fresh();
    const before = share.status().copiedIn;
    fs.promises.utimes = (p, ...a) => (p === L('config.cache.json') ? hang(5500, () => real.utimes(p, ...a)) : real.utimes(p, ...a));
    st = await share.syncNow();
    check('utimes 시간 초과여도 들어온 변경을 셈', st.copiedIn === before + 1 && read(L('config.cache.json')) === 'REMOTE-NEW',
      `copiedIn ${before} → ${st.copiedIn}`);
    await sleep(700);
  } finally {
    Object.assign(fs.promises, real);
    share.resetRoot();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('테스트 중 예외:', err);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(profile, { recursive: true, force: true });
});

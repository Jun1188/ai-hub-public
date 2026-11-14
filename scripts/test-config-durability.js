#!/usr/bin/env node
// 설정이 사라지지 않는지 검증한다.
//
// 2026-07-26에 실제로 downstreamServers가 통째로 날아갔다. 앱을 연속으로 띄우자
// 한 프로세스가 config.cache.json을 쓰는 도중(파일이 잘린 상태) 다른 프로세스가
// 읽어 JSON 파싱에 실패했고, config.js가 그걸 "설정 없음"으로 보고 기본값으로
// 덮어썼다. 두 가지를 고쳤고 여기서 회귀를 막는다:
//   1) 쓰기는 임시 파일 + rename (원자적) — 읽는 쪽이 잘린 파일을 볼 수 없다
//   2) 읽기 실패는 "설정 없음"이 아니다 — 덮어쓰지 않고 격리해 둔다
//
// 진짜 %APPDATA%를 건드리지 않도록 자식 프로세스에 임시 APPDATA를 준다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const appRoot = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/** 격리된 APPDATA로 노드 코드를 돌린다. */
function runIsolated(code, appData) {
  return spawnSync(process.execPath, ['-e', code], {
    cwd: appRoot,
    encoding: 'utf8',
    env: { ...process.env, APPDATA: appData, AIHUB_SHARE_DIR: '' },
  });
}

function dataDir(appData) {
  return path.join(appData, 'ai-hub');
}

async function main() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-config-test-'));
  const dir = dataDir(sandbox);

  console.log('1) 기본 저장/로드');
  let r = runIsolated(`
    const c = require('./src/core/config');
    c.update({ downstreamServers: { unity: { type: 'cli', cli: 'unity', enabled: true } } });
    console.log(JSON.stringify(c.reload().downstreamServers));
  `, sandbox);
  check('설정 저장 후 다시 읽힘', r.stdout.includes('unity'), (r.stderr || r.stdout).slice(0, 200));

  console.log('2) 원자적 쓰기 (임시 파일이 남지 않는가)');
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
  check('임시 파일 잔재 없음', leftovers.length === 0, leftovers.join(', '));

  console.log('3) 손상된 설정 파일을 기본값으로 덮어쓰지 않는가');
  const sharedFile = path.join(dir, 'config.cache.json');
  const good = fs.readFileSync(sharedFile, 'utf8');
  fs.writeFileSync(sharedFile, good.slice(0, Math.floor(good.length / 2)), 'utf8'); // 잘린 JSON
  r = runIsolated(`
    const c = require('./src/core/config');
    const cfg = c.load();
    console.log('SERVERS=' + JSON.stringify(cfg.downstreamServers));
  `, sandbox);
  const quarantined = fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'));
  check('손상 파일을 격리해 보존', quarantined.length === 1, fs.readdirSync(dir).join(', '));
  const afterCorrupt = fs.existsSync(sharedFile) ? fs.readFileSync(sharedFile, 'utf8') : '';
  check('손상 파일 자리에 빈 설정을 쓰지 않음', !/"_updatedAt"/.test(afterCorrupt) || afterCorrupt.length > 100,
    `${afterCorrupt.length}바이트`);

  console.log('4) 동시 실행 — 설정이 살아남는가 (원래 버그 재현 조건)');
  const sandbox2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-config-race-'));
  runIsolated(`
    const c = require('./src/core/config');
    c.update({ downstreamServers: {
      unity: { type: 'cli', cli: 'unity', enabled: true },
      antigravity: { type: 'cli', cli: 'antigravity', enabled: true },
    } });
  `, sandbox2);

  // 여러 프로세스가 동시에 load/save를 반복하게 한다.
  const racers = [];
  for (let i = 0; i < 8; i++) {
    racers.push(new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', `
        const c = require('./src/core/config');
        for (let n = 0; n < 25; n++) { c.reload(); c.update({ ui: { devMode: n % 2 === 0 } }); }
      `], { cwd: appRoot, env: { ...process.env, APPDATA: sandbox2 }, stdio: 'ignore' });
      child.on('exit', resolve);
    }));
  }
  await Promise.all(racers);

  r = runIsolated(`
    const c = require('./src/core/config');
    console.log('SERVERS=' + Object.keys(c.load().downstreamServers || {}).join(','));
  `, sandbox2);
  const names = (r.stdout.match(/SERVERS=(.*)/) || [])[1] || '';
  check('동시 실행 후에도 downstreamServers 유지', names.includes('unity') && names.includes('antigravity'),
    `남은 항목: "${names}"`);
  const corruptAfterRace = fs.readdirSync(dataDir(sandbox2)).filter((n) => n.includes('.corrupt-'));
  check('경합 중 손상 파일이 생기지 않음', corruptAfterRace.length === 0, corruptAfterRace.join(', '));

  console.log('4-1) 다운스트림 시크릿(headers/env)이 공유 파일로 새지 않는가');
  const sandboxS = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-config-secret-'));
  r = runIsolated(`
    const c = require('./src/core/config');
    c.update({ downstreamServers: { s1: { type: 'http', url: 'http://10.0.0.9/mcp',
      headers: { Authorization: 'Bearer TEST-SECRET' }, enabled: true } } });
    console.log('HEADERS=' + c.reload().downstreamServers.s1.headers.Authorization);
  `, sandboxS);
  const sharedRaw = fs.readFileSync(path.join(dataDir(sandboxS), 'config.cache.json'), 'utf8');
  const localRaw = fs.readFileSync(path.join(dataDir(sandboxS), 'config.local.json'), 'utf8');
  check('공유 파일에 시크릿 없음', !sharedRaw.includes('TEST-SECRET') && sharedRaw.includes('s1'), sharedRaw.slice(0, 150));
  check('local 파일에 시크릿 보존 + effective에 복원', localRaw.includes('TEST-SECRET')
    && r.stdout.includes('HEADERS=Bearer TEST-SECRET'), (r.stdout + r.stderr).slice(0, 150));
  fs.rmSync(sandboxS, { recursive: true, force: true });

  console.log('5) 새 설치가 공유 설정을 덮어쓰지 않는가 (mtime 경쟁)');
  // 시나리오: 컴퓨터 A가 설정을 저장하고 공유 폴더에 동기화 → 컴퓨터 B에 새로
  // 설치(빈 APPDATA) 후 첫 동기화. 예전에는 B의 load()가 기본값 config.cache.json을
  // 만들었고, 그 mtime이 공유본보다 최신이라 share.js가 기본값을 밀어내 A의 설정을
  // 지웠다. 지금은 새 설치에서 공유 파일을 만들지 않으므로 A의 설정이 B로 들어온다.
  const sandboxA = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-config-pcA-'));
  const sandboxB = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-config-pcB-'));
  const drive = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-config-drive-'));
  runIsolated(`
    const c = require('./src/core/config');
    c.update({ delegation: { userGlobalPrompt: 'PC-A-SETTING' },
               downstreamServers: { unity: { type: 'cli', cli: 'unity', enabled: true } } });
    require('./src/core/share').syncNow(${JSON.stringify(drive)}).then(() => process.exit(0));
  `, sandboxA);
  await new Promise((res) => setTimeout(res, 1500)); // B의 파일이 확실히 더 최신 mtime을 갖는 조건
  r = runIsolated(`
    const c = require('./src/core/config');
    c.load(); // 새 설치 첫 실행
    require('./src/core/share').syncNow(${JSON.stringify(drive)}).then(() => {
      console.log('B_PROMPT=' + c.reload().delegation.userGlobalPrompt);
      process.exit(0);
    });
  `, sandboxB);
  const driveCfg = JSON.parse(fs.readFileSync(path.join(drive, 'config.cache.json'), 'utf8'));
  check('공유 폴더의 설정이 살아남음', driveCfg.delegation
    && driveCfg.delegation.userGlobalPrompt === 'PC-A-SETTING'
    && Boolean((driveCfg.downstreamServers || {}).unity), JSON.stringify(driveCfg).slice(0, 200));
  check('새 설치가 공유 설정을 받아옴', r.stdout.includes('B_PROMPT=PC-A-SETTING'),
    (r.stdout + r.stderr).slice(0, 200));

  // 1.29.0: 시드를 복사하던 위임 스킬·오케스트레이션 파이프라인이 없어져 시드 mtime 점검도 뺐다.
  console.log('6) 정리');
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(sandbox2, { recursive: true, force: true });
  fs.rmSync(sandboxA, { recursive: true, force: true });
  fs.rmSync(sandboxB, { recursive: true, force: true });
  fs.rmSync(drive, { recursive: true, force: true });
  check('임시 폴더 삭제', !fs.existsSync(sandbox) && !fs.existsSync(sandbox2) && !fs.existsSync(drive));

  console.log('');
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('테스트 예외:', e); process.exit(1); });

// 허브 인증 자가 점검 회귀 테스트 (LM Studio 불필요).
//
// 2026-07-28: 떠 있던 허브가 config.local.json의 정확한 토큰까지 401로 거부했다.
// 등록된 AI 도구 5개가 전부 못 붙었는데 대시보드는 "실행 중", /health는 {ok:true}라
// 아무 데도 안 보였다. 이 테스트는 그 상태를 (1) 밖에서 감지하고 (2) 캐시 갱신 →
// (3) 그래도 안 되면 재시작으로 복구하는 경로를 고정한다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// config.js는 로드 시점에 hubDataDir()로 경로를 굳힌다. 진짜 %APPDATA%의 토큰을
// 건드리면 등록된 AI 도구 5개가 전부 401이 된다 — require 전에 격리한다.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-authcheck-'));
process.env.APPDATA = SANDBOX;

const { startHttpHub } = require('../src/mcp/http-entry');
const authcheck = require('../src/mcp/authcheck');
const config = require('../src/core/config');

const PORT = 18764;

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function writeTokenToDisk(token) {
  const local = JSON.parse(fs.readFileSync(config.LOCAL_FILE, 'utf8').replace(/^\uFEFF/, ''));
  local.hub = { ...(local.hub || {}), authToken: token };
  fs.writeFileSync(config.LOCAL_FILE, JSON.stringify(local, null, 2), 'utf8');
}

/** 서버가 뜰 때까지 기다린다. */
function listen(server) {
  return new Promise((r) => server.on('listening', r));
}

(async () => {
  const realToken = config.load().hub.authToken;
  let server = startHttpHub({ port: PORT });
  await listen(server);

  console.log('1) 정상 상태');
  {
    const r = await authcheck.checkAuth({ port: PORT });
    check('인증이 통하면 ok', r.ok && !r.repaired, JSON.stringify(r));
    check('디스크 토큰을 그대로 읽어온다', authcheck.tokenOnDisk() === realToken);
  }

  console.log('2) 점검이 세션을 남기지 않는가 (남기면 상한 50을 채워 진짜 클라이언트가 429)');
  {
    // initialize를 보내면 세션이 쌓인다. 50번 점검해도 그다음 요청이 429가 아니어야 한다.
    for (let i = 0; i < 55; i++) await authcheck.checkAuth({ port: PORT });
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${config.load().hub.authToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    });
    check('55번 점검 뒤에도 새 세션을 맺을 수 있음', res.status === 200, `HTTP ${res.status}`);
  }

  console.log('3) 허브가 뜬 뒤 토큰이 바뀐 경우 — 허브 자신의 401 경로가 고친다');
  {
    // 이건 이미 동작하던 경로다(AGENTS.md 규칙 5): 허브가 401을 내기 직전에
    // config.local.json을 다시 읽는다. 점검은 그게 실제로 통하는지 확인만 하고
    // 아무것도 고치지 않는다(repaired=null) — 고칠 게 없기 때문이다.
    const rotated = 'rotated0123456789abcdef0123456789abcdef01';
    writeTokenToDisk(rotated);
    const r = await authcheck.checkAuth({ port: PORT });
    check('ok로 보고', r.ok, JSON.stringify(r));
    check('점검이 개입하지 않음(repaired=null)', r.repaired === null, String(r.repaired));
    check('캐시도 새 토큰을 본다', config.load().hub.authToken === rotated);
  }

  console.log('4) 갱신으로도 안 되는 상태 — 재시작으로 복구 (실제로 겪은 그 상태)');
  {
    // 실제 사고에서 refreshAuthToken()은 디스크 값을 돌려줬는데도 허브가 거부했다.
    // 원인을 재현할 수 없으니 "갱신이 소용없다"만 흉내 낸다: 갱신을 무력화하고,
    // 재시작 콜백에서만 서버가 새 설정으로 다시 서게 한다.
    const stuckToken = 'stuck456789abcdef0123456789abcdef01234567';
    const realRefresh = config.refreshAuthToken;
    config.refreshAuthToken = () => null; // 읽기 실패와 같은 취급 → 캐시 유지 + 거절
    writeTokenToDisk(stuckToken);

    let restarted = 0;
    const r = await authcheck.checkAuth({
      port: PORT,
      restart: async () => {
        restarted++;
        config.refreshAuthToken = realRefresh; // 재시작 = 새 프로세스처럼 설정을 다시 읽음
        await new Promise((res) => server.close(res));
        config.reload();
        server = startHttpHub({ port: PORT });
        await listen(server);
      },
    });
    config.refreshAuthToken = realRefresh;
    check('재시작이 한 번만 시도됨', restarted === 1, String(restarted));
    check('재시작 뒤 ok', r.ok, JSON.stringify(r));
    check('복구 수단이 restart로 보고됨', r.repaired === 'restart', String(r.repaired));
  }

  console.log('5) 고칠 수 없으면 조용히 성공하지 않는다');
  {
    const realRefresh = config.refreshAuthToken;
    config.refreshAuthToken = () => null;
    const cached = config.load().hub.authToken;
    writeTokenToDisk('never0000000000000000000000000000000000000');
    const r = await authcheck.checkAuth({ port: PORT }); // restart 콜백 없음 = 진단만
    config.refreshAuthToken = realRefresh;
    writeTokenToDisk(cached);
    config.reload();
    check('ok=false로 보고', r.ok === false, JSON.stringify(r));
    check('사유가 실려 있음', r.reason === 'token_mismatch', r.reason);
    check('사용자에게 보여 줄 안내가 있음', typeof r.message === 'string' && r.message.length > 10);
  }

  console.log('6) 허브가 죽어 있으면 인증 실패와 구별한다');
  {
    await new Promise((res) => server.close(res));
    const r = await authcheck.checkAuth({ port: PORT, timeoutMs: 1500 });
    check('ok=false', r.ok === false);
    check('사유가 unreachable', r.reason === 'unreachable', r.reason);
  }

  console.log('7) 정리');
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  check('임시 APPDATA 삭제', !fs.existsSync(SANDBOX));
  // 닫히는 중인 핸들을 두고 exit하면 Windows libuv가 abort한다(test-ue-queries.js 참고).
  await new Promise((r) => setTimeout(r, 150));

  console.log('');
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FAIL', e);
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 정리 실패는 무시 */ }
  process.exit(1);
});

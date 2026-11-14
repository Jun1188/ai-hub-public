// HTTP 허브 스모크 + 인증 회귀 테스트.
//
// 2026-07-27: 5개 AI 도구를 HTTP로 등록한 뒤 이미 떠 있던 허브에 붙으면
// config.local.json에 적힌 정확한 토큰까지 전부 401이었다. config.load()가 프로세스
// 캐시라 허브가 뜬 뒤 바뀐 토큰을 영영 못 봤기 때문. 허브를 재시작해야만 풀렸다.
// 아래 3)이 그 회귀를 막는다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// config.js는 모듈 로드 시점에 hubDataDir()로 파일 경로를 굳힌다. 이 테스트는
// config.local.json의 토큰을 바꿔 쓰므로, 진짜 %APPDATA%를 건드리면 등록된 AI 도구
// 5개가 전부 401이 된다. 허브를 require 하기 **전에** 격리된 APPDATA를 심는다
// (test-config-durability.js와 같은 방식).
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-http-test-'));
process.env.APPDATA = SANDBOX;

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { startHttpHub } = require('../src/mcp/http-entry');
const config = require('../src/core/config');

const PORT = 18763; // test port
const URL_MCP = `http://127.0.0.1:${PORT}/mcp`;

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/** 인증 거절을 확인하는 최소 요청. 401 본문의 reason과 원문을 돌려준다. */
async function rawInit(headers) {
  const res = await fetch(URL_MCP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
  });
  const body = await res.text();
  let reason = '';
  try { reason = (JSON.parse(body).error || {}).data.reason; } catch { /* 401이 아니거나 SSE 본문 */ }
  return { status: res.status, reason: reason || '', body };
}

/** 토큰으로 실제 MCP 세션을 맺고 도구 목록을 받아온다. */
async function connectWith(token) {
  const client = new Client({ name: 'http-smoke', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  const tools = await client.listTools();
  await client.close();
  return tools.tools.map((t) => t.name);
}

/** config.local.json의 토큰만 갈아끼운다(허브는 계속 떠 있다). */
function writeTokenToDisk(token) {
  // config.js는 기기 전용 파일에 BOM을 쓴다(PowerShell 설정 호환, fe0b3cd) — 앱의 읽기처럼 떼고 읽는다.
  const local = JSON.parse(fs.readFileSync(config.LOCAL_FILE, 'utf8').replace(/^\uFEFF/, ''));
  local.hub = { ...(local.hub || {}), authToken: token };
  fs.writeFileSync(config.LOCAL_FILE, '\uFEFF' + JSON.stringify(local, null, 2), 'utf8');
}

(async () => {
  const firstToken = config.load().hub.authToken;
  const server = startHttpHub({ port: PORT });
  await new Promise((r) => server.on('listening', r));

  console.log('1) 인증 실패 원인이 401에서 구별되는가');
  const noHeader = await rawInit({});
  check('헤더 없음 → 401 no_token', noHeader.status === 401 && noHeader.reason === 'no_token',
    `${noHeader.status} ${noHeader.reason}`);
  const badScheme = await rawInit({ Authorization: 'Basic abc' });
  check('Bearer가 아님 → 401 bad_format', badScheme.status === 401 && badScheme.reason === 'bad_format',
    `${badScheme.status} ${badScheme.reason}`);
  const wrongValue = await rawInit({ Authorization: 'Bearer deadbeef' });
  check('값 불일치 → 401 token_mismatch', wrongValue.status === 401 && wrongValue.reason === 'token_mismatch',
    `${wrongValue.status} ${wrongValue.reason}`);
  const leaks = [firstToken, String(firstToken.length)].filter((s) => wrongValue.body.includes(s));
  check('401 본문에 토큰 값/길이가 없음', leaks.length === 0, wrongValue.body.slice(0, 160));

  console.log('2) 정상 토큰으로 연결');
  const tools = await connectWith(firstToken);
  check('도구 목록을 받아옴', tools.length > 0, tools.slice(0, 5).join(', '));

  console.log('3) 허브가 뜬 뒤 토큰이 바뀌어도 새 토큰으로 붙는가 (재시작 없이)');
  const rotated = 'rotated0123456789abcdef0123456789abcdef01';
  writeTokenToDisk(rotated);
  let rotatedTools = [];
  let rotateErr = '';
  try { rotatedTools = await connectWith(rotated); } catch (e) { rotateErr = String(e && e.message || e); }
  check('새 토큰으로 연결됨', rotatedTools.length > 0, rotateErr);
  const stale = await rawInit({ Authorization: `Bearer ${firstToken}` });
  check('옛 토큰은 이제 거절', stale.status === 401 && stale.reason === 'token_mismatch',
    `${stale.status} ${stale.reason}`);
  check('캐시도 새 토큰으로 갱신됨(registrar/GUI가 같은 값을 본다)',
    config.load().hub.authToken === rotated);

  console.log('4) config.local.json을 읽지 못하면 캐시를 유지하는가 (규칙 6)');
  // 읽기 실패는 "토큰 없음"이 아니다 — 인증을 열어서도 안 되고, 이미 맞는 토큰을
  // 쓰던 클라이언트를 끊어서도 안 된다.
  const goodLocal = fs.readFileSync(config.LOCAL_FILE, 'utf8');
  fs.writeFileSync(config.LOCAL_FILE, goodLocal.slice(0, Math.floor(goodLocal.length / 2)), 'utf8');
  let survivedTools = [];
  let survivedErr = '';
  try { survivedTools = await connectWith(rotated); } catch (e) { survivedErr = String(e && e.message || e); }
  check('손상 상태에서도 캐시된 토큰은 계속 통함', survivedTools.length > 0, survivedErr);
  const stillWrong = await rawInit({ Authorization: 'Bearer deadbeef' });
  check('손상 상태에서 엉뚱한 토큰은 여전히 401', stillWrong.status === 401 && stillWrong.reason === 'token_mismatch',
    `${stillWrong.status} ${stillWrong.reason}`);
  fs.writeFileSync(config.LOCAL_FILE, goodLocal, 'utf8');

  console.log('5) 정리');
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  check('임시 APPDATA 삭제', !fs.existsSync(SANDBOX));
  // process.exit()로 즉시 끊으면 아직 닫히는 중인 핸들 때문에 Windows libuv가
  // "!(handle->flags & UV_HANDLE_CLOSING)" assert로 죽는다. 정리할 틈을 준다.
  await new Promise((resolve) => setTimeout(resolve, 100));

  console.log('');
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FAIL', e);
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 정리 실패는 무시 */ }
  process.exit(1);
});

// 허브가 **지금 디스크에 적힌 토큰으로 자기 자신에 붙는지** 확인하고, 어긋났으면 고친다.
//
// 왜 필요한가 (2026-07-28): 떠 있던 허브가 config.local.json의 정확한 토큰까지
// 401 token_mismatch로 거부했다. 등록된 AI 도구 5개가 전부 못 붙는 상태였는데
// 대시보드는 "실행 중"이었고 /health도 {ok:true}였다 — 아무 데도 안 보였다.
// 재시작하면 사라졌고 소스·회귀 테스트(test-mcp-http.js)는 멀쩡했다. 즉 원인을
// 못 잡아도 **상태가 어긋났다는 사실 자체는 밖에서 관측 가능**해야 한다.
//
// 검사 대상은 "서버가 들고 있는 값"이 아니라 **클라이언트가 실제로 쓰는 값**이다.
// registrar가 각 AI 도구 설정에 써 넣는 건 config.local.json의 토큰이므로, 캐시를
// 거치지 않고 그 파일을 직접 읽어서 진짜 HTTP 요청을 보낸다.
'use strict';

const fs = require('fs');
const config = require('../core/config');

// 2026-07-28 코어는 상태 없는 server/discover 요청으로 인증과 실제 MCP 응답을 함께 확인한다.
// 세션이나 initialize 상태를 만들지 않으므로 주기적 점검이 클라이언트 자원을 소비하지 않는다.
const PROBE_BODY = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'server/discover',
  params: { _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'ai-hub-authcheck', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  } },
});

/** config.local.json에 실제로 적힌 토큰. 캐시를 건드리지 않는다(읽기 전용). */
function tokenOnDisk() {
  try {
    // PowerShell 5.1이 쓴 파일은 BOM으로 시작한다.
    const obj = JSON.parse(fs.readFileSync(config.LOCAL_FILE, 'utf8').replace(/^\uFEFF/, ''));
    const t = obj && obj.hub && obj.hub.authToken;
    return typeof t === 'string' && t ? t : null;
  } catch {
    return null; // 읽기 실패는 "토큰 없음"이 아니다 — 호출자가 구별해서 다룬다(규칙 6)
  }
}

/**
 * 한 번 던져 본다. 전송 오류는 status 0으로 돌려준다.
 *
 * 재시도가 필요한 이유: 허브를 재시작한 직후 첫 요청은 fetch(undici)의 커넥션 풀에
 * 남은 **죽은 소켓**을 재사용해 ECONNRESET을 낸다(실측). 그대로 두면 방금 성공한
 * 자가 복구를 "연결 실패"로 오보한다. 두 번째 요청은 새 소켓을 잡아 정상이다.
 */
async function probeOnce(port, token, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'server/discover',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: PROBE_BODY,
    });
    let reason = '';
    if (res.status === 401) {
      try {
        reason = ((JSON.parse(await res.text()).error || {}).data || {}).reason || '';
      } catch { /* 본문이 JSON이 아니면 reason 없이 간다 */ }
    }
    return { status: res.status, reason };
  } catch (err) {
    return { status: 0, reason: err && err.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

async function probe(port, token, timeoutMs) {
  const first = await probeOnce(port, token, timeoutMs);
  if (first.status !== 0 || first.reason === 'timeout') return first;
  await new Promise((r) => setTimeout(r, 150));
  return probeOnce(port, token, timeoutMs);
}

/**
 * 인증이 실제로 통하는지 확인하고, 안 되면 고쳐 본다.
 *
 * 고치는 순서: (1) config.load()의 프로세스 캐시를 디스크 값으로 갱신 →
 * (2) 그래도 안 되면 호출자가 준 restart()로 HTTP 서버를 다시 세운다.
 * restart를 주지 않으면 진단만 한다.
 *
 * @param {{port:number, timeoutMs?:number, restart?:(()=>Promise<void>)|null}} p
 * @returns {Promise<{ok:boolean, reason:string, repaired:string|null, message:string}>}
 */
async function checkAuth(p) {
  const port = p.port;
  const timeoutMs = p.timeoutMs || 3000;
  let cfg;
  try {
    cfg = config.load();
  } catch (error) {
    if (error.code === 'HUB_DEVICE_CONFIG_READ' && error.reason === 'recovery_required') {
      return fail('device_config_recovery_required', null, error.message);
    }
    if (error.code === 'HUB_DEVICE_CONFIG_READ') return missingToken();
    if (error.code === 'HUB_DEVICE_CONFIG_WRITE') return fail('device_config_write_failed', null, error.message);
    throw error;
  }
  const authOn = Boolean(cfg.hub.requireAuth || cfg.hub.lanAccess);

  if (!authOn) {
    const r = await probe(port, null, timeoutMs);
    if (r.status === 0) return fail(r.reason, null, unreachableMessage(port, r.reason));
    return ok(null);
  }

  const token = tokenOnDisk();
  if (!token) return missingToken();

  let r = await probe(port, token, timeoutMs);
  if (r.status === 0) return fail(r.reason, null, unreachableMessage(port, r.reason));
  if (r.status !== 401) return ok(null);

  // 여기부터가 실제로 겪은 상태다: 디스크의 토큰인데 허브가 거부한다.
  // 캐시를 다시 읽어 보는 단계는 두지 않는다 — 허브는 401을 내기 직전에 이미
  // config.refreshAuthToken()으로 디스크를 다시 읽는다(AGENTS.md 규칙 5). 그러고도
  // 401이 왔다는 건 그 경로로는 안 고쳐진다는 뜻이고, 실제 사고가 정확히 그랬다.
  if (p.restart) {
    await p.restart();
    r = await probe(port, token, timeoutMs);
    if (r.status !== 401 && r.status !== 0) return ok('restart');
  }

  return fail(r.reason || 'token_mismatch', null,
    '허브가 config.local.json의 토큰을 거부합니다 — 등록된 AI 도구가 전부 붙지 못합니다. ' +
    '허브를 다시 시작해도 계속되면 MCP 연결 탭에서 도구를 다시 등록하세요.');
}

function ok(repaired) {
  return {
    ok: true,
    reason: '',
    repaired,
    message: repaired === 'restart' ? '허브 인증이 어긋나 HTTP 허브를 다시 시작했습니다.' : '',
  };
}

function missingToken() {
  return fail('no_token_on_disk', null,
    '기기 설정의 인증 토큰을 읽지 못했습니다. 파일 접근을 확인한 뒤 다시 점검하세요. 파일이 손상된 경우에는 이 PC의 정상 백업을 사용하세요.');
}

function fail(reason, repaired, message) {
  return { ok: false, reason, repaired, message };
}

function unreachableMessage(port, reason) {
  return reason === 'timeout'
    ? `허브(127.0.0.1:${port})가 응답하지 않습니다 — 멈춰 있는지 확인하세요.`
    : `허브(127.0.0.1:${port})에 연결하지 못했습니다.`;
}

module.exports = { checkAuth, tokenOnDisk };

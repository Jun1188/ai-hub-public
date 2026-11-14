// Streamable HTTP entry point: hosts the hub MCP server on 127.0.0.1:<port>/mcp
// so several AI tools can share one hub instance. Also used by the Electron GUI.
'use strict';

const http = require('http');
const crypto = require('crypto');
const { createMcpHandler } = require('@modelcontextprotocol/server');
const { toNodeHandler } = require('@modelcontextprotocol/node');
const { createHubServer } = require('./hub-server');
const config = require('../core/config');


// Authorization 헤더에서 토큰만 뽑는다. 스킴 이름은 대소문자 구분이 없다(RFC 7235).
const BEARER = /^Bearer\s+(.*)$/i;

/**
 * 401을 낼 때 원인을 함께 알려준다(reason). 값이 틀린 건지, 헤더 모양이 틀린 건지,
 * 아예 안 보낸 건지 구별이 안 돼서 클라이언트 쪽을 한참 팠던 적이 있다(2026-07-27).
 * 토큰 값도 길이도 넣지 않는다 — 원인만.
 */
function unauthorized(res, msg, reason) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32001, message: msg, data: reason ? { reason } : undefined },
    id: null,
  }));
}

/** 상수 시간 비교. 길이가 다르면 timingSafeEqual이 던지므로 먼저 거른다. */
function tokenMatches(presented, expected) {
  const a = Buffer.from(String(presented), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function checkSecurity(req, res) {
  const cfg = config.load();
  // Host header check (DNS-rebinding protection): only localhost hosts allowed.
  // With lanAccess the hub is intentionally reachable by other machines, so the
  // host whitelist is skipped — but bearer auth is then forced on below.
  let host = '';
  try {
    host = new URL(`http://${req.headers.host || ''}`).hostname.toLowerCase();
  } catch { /* malformed host header */ }
  if (!cfg.hub.lanAccess && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    unauthorized(res, 'Forbidden host', 'forbidden_host');
    return false;
  }
  // Origin check: browsers set Origin; native MCP clients usually don't.
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try {
      const oh = new URL(origin).hostname.toLowerCase();
      ok = ['127.0.0.1', 'localhost', '::1'].includes(oh);
    } catch { /* malformed origin */ }
    if (!ok) {
      unauthorized(res, 'Forbidden origin', 'forbidden_origin');
      return false;
    }
  }
  if (cfg.hub.requireAuth || cfg.hub.lanAccess) {
    const header = String(req.headers.authorization || '').trim();
    if (!header) {
      unauthorized(res, 'Missing Authorization header (expected "Authorization: Bearer <hub.authToken>")', 'no_token');
      return false;
    }
    const m = BEARER.exec(header);
    if (!m || !m[1]) {
      unauthorized(res, 'Malformed Authorization header (expected "Bearer <token>")', 'bad_format');
      return false;
    }
    if (!tokenMatches(m[1], cfg.hub.authToken)) {
      // 캐시된 토큰과 다르다 = 정말 틀렸거나, 허브가 뜬 뒤 토큰이 바뀐 것이다.
      // config.load()는 프로세스 캐시라 후자를 영영 못 본다 — 거절하기 직전에만
      // 디스크를 한 번 다시 읽는다. 정상 경로에는 추가 I/O가 없다.
      const cached = cfg.hub.authToken;
      const fresh = config.refreshAuthToken(); // 읽기 실패 시 null → 캐시 유지 + 거절
      if (fresh && fresh !== cached) {
        console.error('[ai-hub] hub.authToken changed on disk — reloaded from config.local.json');
      }
      if (!fresh || !tokenMatches(m[1], fresh)) {
        unauthorized(res, 'Bearer token does not match hub.authToken in config.local.json', 'token_mismatch');
        return false;
      }
    }
  }
  return true;
}

const modernHandler = createMcpHandler(
  () => createHubServer(),
  {
    legacy: 'stateless',
    responseMode: 'auto',
    onerror: (err) => console.error('[ai-hub] MCP protocol error:', err),
  }
);
const nodeMcpHandler = toNodeHandler(modernHandler, {
  onerror: (err) => console.error('[ai-hub] MCP HTTP adapter error:', err),
});

async function handleMcp(req, res) {
  if (!checkSecurity(req, res)) return;
  await nodeMcpHandler(req, res);
}

/** Start the HTTP hub. Returns the http.Server. */
function startHttpHub({ port, host } = {}) {
  const cfg = config.load();
  const bindHost = cfg.hub.lanAccess ? '0.0.0.0' : (host || cfg.hub.bindHost || '127.0.0.1');
  const bindPort = port || cfg.hub.httpPort || 8763;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname === '/mcp') {
      handleMcp(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(err.message || err) }, id: null }));
      });
      return;
    }
    if (url.pathname === '/health') {
      // minimal unauthenticated response — no name/session info to strangers
      // when the hub is exposed on the LAN
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end('Not found');
  });

  server.listen(bindPort, bindHost, () => {
    console.error(`[ai-hub] MCP HTTP server on http://${bindHost}:${bindPort}/mcp (auth: ${cfg.hub.requireAuth || cfg.hub.lanAccess ? 'bearer token' : 'OFF'})`);
  });
  return server;
}

if (require.main === module) {
  startHttpHub();
}

module.exports = { startHttpHub };

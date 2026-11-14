// MCP 2026-07-28 stateless core regression.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mcp-2026-'));
process.env.APPDATA = SANDBOX;
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { startHttpHub } = require('../src/mcp/http-entry');
const config = require('../src/core/config');
const PORT = 18766;
const ENDPOINT = `http://127.0.0.1:${PORT}/mcp`;
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
async function connect(versionNegotiation, headers = {}) {
  const token = config.load().hub.authToken;
  const client = new Client({ name: 'hub-modern-test', version: '1.0.0' }, { versionNegotiation });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } },
  });
  await client.connect(transport);
  return client;
}
async function rawDiscover() {
  const token = config.load().hub.authToken;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json',
      'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 7, method: 'server/discover',
      params: { _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'raw-test', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } },
    }),
  });
  return { res, body: JSON.parse(await res.text()) };
}
(async () => {
  const server = startHttpHub({ port: PORT });
  await new Promise((resolve) => server.on('listening', resolve));
  try {
    console.log('1) modern auto negotiation');
    const auto = await connect({ mode: 'auto' });
    check('2026 era negotiated', auto.getProtocolEra() === 'modern', String(auto.getProtocolEra()));
    const listed = await auto.listTools();
    check('tools/list works without initialize session', listed.tools.length > 0);
    check('discover result retained', Boolean(auto.getDiscoverResult()));
    await auto.close();
    console.log('2) modern pinned negotiation');
    const pinned = await connect({ mode: { pin: '2026-07-28' } });
    check('pin succeeds', pinned.getProtocolEra() === 'modern', String(pinned.getProtocolEra()));
    await pinned.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    console.log('3) raw stateless discover contract');
    const raw = await rawDiscover();
    const result = raw.body.result || {};
    check('HTTP 200', raw.res.status === 200, String(raw.res.status));
    check('no session header', !raw.res.headers.get('mcp-session-id'));
    check('complete result discriminator', result.resultType === 'complete', JSON.stringify(result));
    check('cache hints present', Number.isInteger(result.ttlMs) && ['public', 'private'].includes(result.cacheScope));
    console.log('4) tool calls are attributed to the calling client');
    const usage = require('../src/core/tool-usage');
    const unknownJob = { name: 'offload_wait', arguments: { id: '00000000-0000-4000-8000-000000000000', wait_s: 0 } };
    const modern = await connect({ mode: 'auto' });
    await modern.callTool(unknownJob).catch(() => {});
    await modern.close();
    check('modern: clientInfo from the request envelope', usage.snapshot().offload_wait?.clients['hub-modern-test'] === 1, JSON.stringify(usage.snapshot().offload_wait));
    // A 2025-era tools/call arrives on a fresh server that never saw initialize, so only the User-Agent identifies it.
    const legacy = await connect({ mode: 'legacy' }, { 'User-Agent': 'legacy-ua-test/1.0 (test)' });
    await legacy.callTool(unknownJob).catch(() => {});
    await legacy.close();
    check('legacy: User-Agent product', usage.snapshot().offload_wait?.clients['ua:legacy-ua-test'] === 1, JSON.stringify(usage.snapshot().offload_wait));
    console.log('5) agy root conversation id from tools/call _meta (attribution key only)');
    const KEY = 'antigravity.google/root_conversation_id';
    const convA = '8c436276-4408-4e30-9fa0-a93bfb454eb3', convB = '93D49530-BA7F-4A4C-B9E4-FF43DD1DC4C2'; // UUID 모양 더미
    const withMeta = (id) => ({ ...unknownJob, _meta: { [KEY]: id } });
    const agyModern = await connect({ mode: 'auto' });
    await agyModern.callTool(withMeta(convA)).catch(() => {});
    await agyModern.callTool(withMeta(convA)).catch(() => {});
    await agyModern.callTool(withMeta('not-a-uuid; rm')).catch(() => {}); // UUID 모양이 아니면 남기지 않는다
    await agyModern.close();
    const agyLegacy = await connect({ mode: 'legacy' }, { 'User-Agent': 'Go-http-client/1.1' }); // agy 1.4.7 실측 User-Agent
    await agyLegacy.callTool(withMeta(convB)).catch(() => {});
    await agyLegacy.close();
    await usage.flush();
    const calls = await require('../src/core/harness-usage').hubCalls({ days: 1 });
    const convs = Object.values(calls.harnesses).flatMap((h) => (h.conversations || []).map((c) => ({ ...c, harness: Object.keys(calls.harnesses).find((k) => calls.harnesses[k] === h) })));
    const a = convs.find((c) => c.id === convA), b = convs.find((c) => c.id === convB.toLowerCase());
    check('modern: calls counted per conversation with tool names', a && a.calls === 2 && a.top[0].tool === 'offload_wait' && a.harness === 'other', JSON.stringify(convs));
    check('legacy (User-Agent only): conversation attributed to antigravity', b && b.calls === 1 && b.harness === 'antigravity', JSON.stringify(convs));
    check('non-UUID values are not stored', convs.length === 2, JSON.stringify(convs.map((c) => c.id)));
    check('every harness row has top (harness_compat reads it)', Object.values(calls.harnesses).every((h) => Array.isArray(h.top)), JSON.stringify(Object.keys(calls.harnesses)));
    const day = new Date().toISOString().slice(0, 10);
    const stored = fs.readdirSync(path.join(SANDBOX, 'ai-hub', 'tool-usage.local', day)).map((f) => fs.readFileSync(path.join(SANDBOX, 'ai-hub', 'tool-usage.local', day, f), 'utf8')).join('');
    check('no arguments in the usage file', !stored.includes('00000000-0000-4000-8000-000000000000') && !stored.includes('not-a-uuid'), stored.slice(0, 200));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  }
  console.log(`\n통과 ${pass} / 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {} process.exit(1); });

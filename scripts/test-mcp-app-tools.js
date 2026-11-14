'use strict';
// 앱 전용 패널 도구(_meta.ui.visibility ['app'])는 MCP Apps 확장을 알린 클라이언트의 tools/list에만 실린다. 나머지 도구 이름은 그대로다.
const assert = require('assert');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createHubServer } = require('../src/mcp/hub-server');

async function list(capabilities) {
  const server = createHubServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'app-tools-test', version: '0' }, { capabilities });
  await client.connect(b);
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  return names;
}

(async () => {
  const plain = await list({});
  const apps = await list({ extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } });
  const hidden = apps.filter((n) => !plain.includes(n));
  assert(hidden.length >= 8 && hidden.every((n) => n.startsWith('harness_panel_')), hidden.join(','));
  assert(plain.includes('harness_panel'), 'the model-visible panel opener stays for every client');
  assert(plain.every((n) => apps.includes(n)), 'no tool is renamed or dropped for app hosts');
  console.log(`MCP 앱 전용 도구: 일반 ${plain.length}개 · MCP Apps ${apps.length}개 (숨김 ${hidden.length}) — 통과`);
  process.exit(0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

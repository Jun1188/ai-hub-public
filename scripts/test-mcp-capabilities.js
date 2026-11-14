'use strict';
// MCP 서버 지시문의 Hub 도구 지도(상태·진단 · 작업 · 지식·분석 · 개선): 네 묶음이 다 있고, 크기 상한 안이며, 서버를 두 번 만들어도
// 바이트가 같아야 한다(요청마다 다시 실리는 고정 앞부분이라 바뀌면 프롬프트 캐시가 깨진다). repo://hub/capabilities는 실제로
// 등록된 모든 도구를 묶음에 넣고, 지도에 적힌 이름은 모두 실제 도구를 가리켜야 한다.
const assert = require('assert/strict');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createHubServer } = require('../src/mcp/hub-server');
const capabilities = require('../src/mcp/hub-capabilities');

const CAP = 1200;

async function connect() {
  const server = createHubServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'capabilities-test', version: '0' }, { capabilities: {} });
  await client.connect(b);
  return client;
}

(async () => {
  const first = await connect(), second = await connect();
  const instructions = first.getInstructions();
  assert.equal(instructions, second.getInstructions(), 'instructions must be byte-stable across server constructions');
  assert(instructions.includes(require('../src/mcp/shared-todo-queue').INSTRUCTIONS), 'the shared TODO queue preamble stays');
  assert(instructions.endsWith(capabilities.INSTRUCTIONS));
  for (const [id, label] of [['monitor', '상태·진단'], ['work', '작업'], ['knowledge', '지식·분석'], ['improve', '개선']]) {
    assert(capabilities.INSTRUCTIONS.includes(`- ${id} (${label})`), `category ${id} missing`);
  }
  assert(capabilities.INSTRUCTIONS.length <= CAP, `category map is ${capabilities.INSTRUCTIONS.length} chars (cap ${CAP})`);
  assert(!instructions.includes(require('../package.json').version), 'no version in the fixed preamble');
  assert(!/\b20\d\d-\d\d-\d\d\b/.test(instructions), 'no dates in the fixed preamble');
  for (const rule of ['tool_route only when unsure', 'Deterministic tools', '~25 KB', '~100 KB']) assert(instructions.includes(rule), rule);

  const names = (await first.listTools()).tools.map((t) => t.name);
  const uncategorized = names.filter((n) => !capabilities.categoryOf(n));
  assert.deepEqual(uncategorized, [], 'every registered tool belongs to a group');
  for (const c of [...capabilities.CATEGORIES, capabilities.ROUTE]) {
    for (const pattern of c.tools) {
      const prefix = pattern.replace(/\*$/, '');
      assert(names.some((n) => (pattern.endsWith('*') ? n.startsWith(prefix) : n === pattern)), `${c.id}: ${pattern} matches no registered tool`);
    }
  }

  const resources = (await first.listResources()).resources.map((r) => r.uri);
  assert(resources.includes(capabilities.URI) && resources.includes('repo://shared/todo-queue'));
  const text = (await first.readResource({ uri: capabilities.URI })).contents[0].text;
  for (const n of names) assert(text.includes(`- ${n}`), `resource line for ${n}`);
  assert(!text.includes('## other'), 'no unmapped section');
  assert(text.includes('## knowledge (지식·분석)') && text.includes('- symbol_find — '), 'per-tool lines carry the tool title');
  await first.close();
  await second.close();
  console.log(`MCP 도구 지도: 네 묶음, ${capabilities.INSTRUCTIONS.length}자(상한 ${CAP}), 두 번 생성해도 같은 바이트, 도구 ${names.length}개 전부 분류 — 통과`);
  process.exit(0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

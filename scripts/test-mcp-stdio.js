// Smoke test: connect to the hub over stdio like a real MCP client would.
'use strict';
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

(async () => {
  const client = new Client({ name: 'smoke-test', version: '0.0.1' });
  // Optionally test a packaged build: node scripts/test-mcp-stdio.js <exe> <entry.js>
  const [, , cmd, entry] = process.argv;
  const transport = new StdioClientTransport({
    command: cmd || process.execPath,
    args: [entry || path.join(__dirname, '..', 'src', 'mcp', 'stdio-entry.js')],
    env: cmd ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : undefined,
  });
  await client.connect(transport);
  const tools = await client.listTools();
  console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '));
  const names = tools.tools.map((t) => t.name);
  for (const n of ['offload_run', 'offload_wait', 'offload_cancel']) if (!names.includes(n)) throw new Error('missing tool ' + n);
  const workers = tools.tools.find((t) => t.name === 'offload_run').inputSchema.properties.worker.enum;
  if (JSON.stringify(workers) !== JSON.stringify(['local', 'codex', 'agy'])) throw new Error('offload_run workers ' + workers);
  const tiers = tools.tools.find((t) => t.name === 'offload_run').inputSchema.properties.tier?.enum;
  if (JSON.stringify(tiers) !== JSON.stringify(['fast', 'reasoning', 'deep'])) throw new Error('offload_run agy tiers ' + tiers);
  // 1.29.0에서 뺀 위임 도구가 다시 노출되면 호출자가 옛 폴링 경로로 돌아간다.
  for (const n of ['delegate_task', 'delegate_batch', 'list_local_models', 'orchestrate_task', 'harness_create', 'harness_status',
    'delegation_classify', 'self_improve_propose', 'memory_save', 'hardware_advise']) if (names.includes(n)) throw new Error('removed tool listed ' + n);
  const st = await client.callTool({ name: 'hub_status', arguments: {} });
  console.log('STATUS:', st.content[0].text.slice(0, 300));
  // agy는 MCP offload_run 작업자라 MCP 쪽 상태에 실린다.
  const agy = JSON.parse(st.content[0].text).offloadWorkers?.agy;
  if (!agy || typeof agy.installed !== 'boolean' || !Number.isInteger(agy.succeeded)) throw new Error('hub_status lacks offloadWorkers.agy');
  await client.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });

#!/usr/bin/env node
// Delegation flow: MCP tool usage meter and its day files, caller attribution of records, live role map, offload pipeline
// step (validation, state budget, decline path), and Ghidra project input validation. No models or network.
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-flow-'));
process.env.APPDATA = path.join(tmp, 'Roaming');
process.env.LOCALAPPDATA = path.join(tmp, 'Local');

(async () => {
  // usage meter wraps handlers without changing results, counts errors and response bytes
  const usage = require('../src/core/tool-usage');
  const registered = {};
  usage.instrument({ registerTool: (name, _o, handler) => { registered[name] = handler; } });
  const server = { registerTool: (name, _o, handler) => { registered[name] = handler; } };
  usage.instrument(server);
  server.registerTool('symbol_find', {}, async () => ({ content: [{ type: 'text', text: 'x'.repeat(1000) }] }));
  server.registerTool('offload_run', {}, async () => { throw new Error('boom'); });
  assert.equal((await registered.symbol_find()).content[0].text.length, 1000);
  await assert.rejects(registered.offload_run(), /boom/);
  const snap = usage.snapshot();
  assert.equal(snap.symbol_find.calls, 1); assert(snap.symbol_find.bytes > 1000); assert.equal(snap.offload_run.errors, 1);

  // attribution: handlers run tagged with the MCP client — clientInfo, else the User-Agent product (legacy stateless HTTP)
  const caller = require('../src/core/caller');
  const fake = (info) => ({ registerTool: (name, _o, handler) => { registered[name] = handler; }, server: { getClientVersion: () => info } });
  const whoami = async () => ({ content: [{ type: 'text', text: JSON.stringify(caller.current()) }] });
  usage.instrument(fake({ name: 'codex-mcp-client', version: '1' })).registerTool('who_modern', {}, whoami);
  usage.instrument(fake(undefined)).registerTool('who_legacy', {}, whoami);
  const said = async (tool, ctx) => JSON.parse((await registered[tool](ctx)).content[0].text);
  assert.deepEqual(await said('who_modern', {}), { via: 'mcp', client: 'codex-mcp-client' });
  const req = { headers: new Headers({ 'user-agent': 'claude-code/2.1.0 (Windows NT 10.0)' }) };
  assert.deepEqual(await said('who_legacy', { http: { req } }), { via: 'mcp', client: 'ua:claude-code' });
  assert.deepEqual(await said('who_legacy', {}), { via: 'mcp' });
  assert.deepEqual(caller.current(), { via: 'script', script: 'test-delegation-flow.js' });
  assert.deepEqual(usage.snapshot().who_legacy.clients, { 'ua:claude-code': 1 });

  // role map groups tools by role
  const flow = require('../src/core/delegation-flow');
  assert.equal(flow.roleOf('ue_cvar_find'), 'deterministic'); assert.equal(flow.roleOf('offload_wait'), 'offload');
  assert.equal(flow.roleOf('resource_timeline'), 'resources'); assert.equal(flow.roleOf('something_new'), 'other');
  const map = flow.snapshot();
  assert.equal(map.roles.deterministic.calls, 1); assert.equal(map.roles.offload.errors, 1);
  assert(Array.isArray(map.pipelines) && Array.isArray(map.offload.active));

  // offload pipeline step: graph validation
  const graph = require('../src/core/pipeline-state-graph');
  const g = (step) => ({ version: 1, entry: 'o', nodes: [{ id: 'o', kind: 'step', step, next: 'end', onError: 'review' }, { id: 'review', kind: 'review', next: 'end' }, { id: 'end', kind: 'end' }] });
  graph.validate(g({ type: 'offload', name: 'x', task: 'extract', files: ['${project.path}/a.cpp'], schema: { type: 'object' } }));
  assert.throws(() => graph.validate(g({ type: 'offload', name: 'x' })), /task/);
  assert.throws(() => graph.validate(g({ type: 'offload', name: 'x', task: 't', worker: 'antigravity' })), /worker/);
  graph.validate(g({ type: 'offload', name: 'x', task: 't', worker: 'agy' }));
  graph.validate(g({ type: 'offload', name: 'x', task: 't', worker: 'agy', tier: 'reasoning' }));
  graph.validate(g({ type: 'offload', name: 'x', task: 't', worker: 'agy', tier: 'deep' }));
  assert.throws(() => graph.validate(g({ type: 'offload', name: 'x', task: 't', worker: 'agy', tier: 'max' })), /tier/);
  assert.throws(() => graph.validate(g({ type: 'offload', name: 'x', task: 't', tier: 'fast' })), /tier/);
  assert.throws(() => graph.validate(g({ type: 'offload', name: 'x', task: 't', files: 'a.cpp' })), /files/);

  // state budget: many results are cut to fit, with a flag
  const step = require('../src/core/pipeline-offload-step');
  const many = { state: 'succeeded', verification: { schemaValid: 500, schemaInvalid: 0 }, usage: {}, route: {},
    results: Array.from({ length: 500 }, (_, i) => ({ file: 'f' + i, value: { summary: 'y'.repeat(200) } })) };
  const c = step.compact(many);
  assert(c.truncated && c.results.length < 500 && Buffer.byteLength(JSON.stringify(c)) <= 48 * 1024);
  graph.clean(c);

  // execute: declined → exit 1 (graph routes to review); succeeded → 0 with data in graph state
  const offload = require('../src/core/offload');
  const real = { run: offload.run, wait: offload.wait, cancel: offload.cancel };
  const logs = [];
  const io = { substituteVars: (s) => s, appendLog: (_r, _i, text) => logs.push(text) };
  for (const [state, code] of [['declined', 1], ['succeeded', 0]]) {
    offload.run = () => 'job'; offload.wait = async () => ({ id: 'job', state, reason: state === 'declined' ? 'no_viable_local_model' : undefined,
      verification: { schemaValid: 1, schemaInvalid: 0 }, usage: { workerMs: 5 }, route: { worker: 'local' }, results: [{ value: { summary: 'ok' } }] });
    const run = { record: { runId: 'r' }, cancelled: false };
    assert.equal(await step.execute({ task: 't', files: [] }, 0, run, {}, io), code);
    assert.equal(run.graphStepData.state, state);
  }
  let sent;
  offload.run = (a) => { sent = a; return 'job'; };
  await step.execute({ task: 't', worker: 'agy', tier: 'reasoning' }, 0, { record: { runId: 'r' }, cancelled: false }, {}, io);
  assert.equal(sent.worker, 'agy'); assert.equal(sent.tier, 'reasoning');
  Object.assign(offload, real);
  assert(logs.some((l) => /declined \(no_viable_local_model\)/.test(l)));

  // Ghidra project: inputs are validated before any process starts
  const ghidra = require('../src/core/ghidra-project');
  await assert.rejects(ghidra.query({ binaryHash: 'a'.repeat(64), op: 'patch', target: 'x' }), /invalid_query_op/);
  await assert.rejects(ghidra.query({ binaryHash: 'a'.repeat(64), op: 'decompile', target: 'x; rm' }), /invalid_query_target/);
  await assert.rejects(ghidra.query({ binaryHash: 'a'.repeat(64), op: 'decompile', target: 'Foo' }), /binary_not_analyzed/);
  await assert.rejects(ghidra.annotate({ binaryHash: 'a'.repeat(64), edits: [{ op: 'rename', target: 'A', value: 'B' }] }), /binary_not_analyzed/);
  assert.equal(ghidra.heapFor(64 * 1024), 0.5);
  assert.equal(ghidra.heapFor(64 * 1024 + 1), 2);
  assert.equal(ghidra.heapFor(1e6), 2); assert.equal(ghidra.heapFor(40e6), 4); assert.equal(ghidra.heapFor(100e6), 8);

  // records name who asked (never the task, paths or tokens): offload jobs and delegation history
  const jobsFile = path.join(tmp, 'jobs.json');
  const jobs = offload.createOffload({ file: jobsFile, runAgy: async () => ({ model: 'm', response: 'ok', usage: {} }) });
  const jobId = caller.run({ via: 'mcp', client: 'claude-code' }, () => jobs.run({ task: 't', text: 'x', worker: 'agy' }));
  assert.equal((await jobs.wait(jobId, 5)).state, 'succeeded');
  assert.deepEqual(JSON.parse(fs.readFileSync(jobsFile, 'utf8')).records[0].caller, { via: 'mcp', client: 'claude-code' });
  const stats = require('../src/core/stats');
  caller.run({ via: 'gui' }, () => stats.record({ taskType: 'custom', model: 'm', ok: false }));
  stats.record({ taskType: 'custom', model: 'm', ok: false });
  assert.deepEqual(stats.history(2).map((r) => r.caller.via), ['script', 'gui']);

  // tool-usage: one day file per process, so a restarted (or second) Hub no longer overwrites the earlier counts
  const dayFiles = (d) => {
    const dir = path.join(process.env.APPDATA, 'ai-hub', 'tool-usage.local', d);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];
  };
  const other = require('child_process').spawnSync(process.execPath, ['-e',
    "const u = require(process.argv[1]); u.record('symbol_find', 1, 10, true, 'codex'); u.flush();", require.resolve('../src/core/tool-usage')], { env: process.env });
  assert.equal(other.status, 0, String(other.stderr));
  await usage.flush();
  const today = dayFiles(new Date().toISOString().slice(0, 10));
  assert.equal(today.length, 2);
  assert.equal(today.find((f) => f.pid === other.pid).tools.symbol_find.clients.codex, 1);
  assert.equal(today.find((f) => f.pid === process.pid).tools.symbol_find.calls, 1);

  // a Hub left running past midnight starts the next day at zero instead of carrying yesterday's counts
  const RealDate = Date;
  let now = RealDate.parse('2030-01-01T23:59:00Z');
  global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
  try { usage.record('hub_status', 1, 1, true); usage.record('hub_status', 1, 1, true); now += 120000; usage.record('hub_status', 1, 1, true); await usage.flush(); }
  finally { global.Date = RealDate; }
  for (let i = 0; i < 100 && !dayFiles('2030-01-01').length; i++) await new Promise((r) => setTimeout(r, 10)); // rollover flush is not awaited
  assert.deepEqual(['2030-01-01', '2030-01-02'].map((d) => dayFiles(d).map((f) => f.tools.hub_status.calls)), [[2], [1]]);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Passed: usage meter (results unchanged, errors, bytes, per-process day files, midnight rollover), caller attribution '
    + '(MCP client, User-Agent fallback, offload jobs, delegation history), role map, offload step validation/state budget/decline route, Ghidra input validation');
})().catch((e) => { console.error(e); process.exit(1); });

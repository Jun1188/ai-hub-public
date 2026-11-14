'use strict';
// 거버너(조절·공백 기록·평가), 도구 경로 표(동적 syscall), 멀티에이전트 사회. 자원 기록·모델은 가짜를 주입한다.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gov-'));
const deps = { dataDir: scratch };
let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); } }

const governor = require('../src/core/governor/governor');
const gaps = require('../src/core/governor/monitoring-gaps');
const geval = require('../src/core/governor/governor-eval');
const signals = require('../src/core/change-signals');
const routes = require('../src/core/toolroute/route-table');
const society = require('../src/core/multiagent/society');

(async () => {
  let unloads = 0;
  const fakeTel = (findings, sampler = { running: true, nvidia: true }) => ({ report: async () => ({ samples: 60, findings, machine: { cpuPercent: { peak: 90 }, vramPeakBytes: 1, sharedVramPeakBytes: 0 }, sampler }) });
  const gdeps = (findings, sampler) => ({ ...deps, telemetry: fakeTel(findings, sampler), gpufit: { unloadIdle: async () => { unloads++; return { unloaded: ['m1'] }; } },
    optimizer: { slotState: () => ({ active: 1, waiting: 1, maxConcurrent: 1 }) }, offload: { active: () => [{ worker: 'local', caller: null }] }, scheduler: { state: () => ({}) } });

  await check('decide: paging gates; idle models are unloaded only for an LM Studio culprit or queued local work', () => {
    assert.deepStrictEqual(governor.decide({ findings: [{ kind: 'paging' }], slot: {} }).map((x) => x.type), ['gate-local-inference']);
    assert.deepStrictEqual(governor.decide({ findings: [{ kind: 'paging', culprits: [{ app: 'lmstudio', name: 'LM Studio' }] }], slot: {} }).map((x) => x.type), ['gate-local-inference', 'unload-idle-models']);
    assert.deepStrictEqual(governor.decide({ findings: [{ kind: 'paging' }], slot: { waiting: 1 } }).map((x) => x.type), ['gate-local-inference', 'unload-idle-models']);
  });
  await check('decide: no second unload while the window still holds pre-unload samples', () => {
    const w = governor.POLICY.windowSeconds * 1000;
    assert.deepStrictEqual(governor.decide({ findings: [{ kind: 'vram_spill' }], slot: { waiting: 1 }, at: 10 * w, lastUnloadAt: 10 * w - 30000 }).map((x) => x.type), ['gate-local-inference']);
    assert.deepStrictEqual(governor.decide({ findings: [{ kind: 'vram_spill' }], slot: { waiting: 1 }, at: 10 * w, lastUnloadAt: 9 * w }).map((x) => x.type), ['gate-local-inference', 'unload-idle-models']);
  });
  await check('decide: calm window releases an existing gate, otherwise nothing', () => {
    assert.deepStrictEqual(governor.decide({ findings: [], gate: { until: 1 } }).map((x) => x.type), ['release-gate']);
    assert.deepStrictEqual(governor.decide({ findings: [] }), []);
  });
  const t1 = await governor.tick(gdeps([{ kind: 'paging', seconds: 20, culprits: [] }]));
  await check('tick: acts, gates the slot and writes the ledger', async () => {
    assert(t1.actions.every((a) => a.ok)); assert.strictEqual(unloads, 1);
    assert(signals.gate('local-inference'));
    const rows = await governor.decisions({}, deps);
    assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].before.machine.cpuPeak, 90);
  });
  await check('tick: the next tick on the same window gates but does not unload again', async () => {
    const t2 = await governor.tick(gdeps([{ kind: 'paging', seconds: 20, culprits: [] }]));
    assert.deepStrictEqual(t2.actions.map((a) => a.type), ['gate-local-inference']); assert.strictEqual(unloads, 1);
  });
  await check('gate: slot waiters wait only up to the cap', async () => {
    const waited = await signals.waitGate('local-inference', { maxWaitMs: 120, pollMs: 20 });
    assert(waited >= 100 && waited < 1000);
    signals.setGate('local-inference', 0);
  });
  await check('gaps: unattributed finding and caller-less job recorded', async () => {
    const list = await gaps.list(deps);
    assert(list.some((g) => g.key === 'unattributed-paging') && list.some((g) => g.key === 'job-without-caller'));
  });
  await check('gaps: sampler down and missing GPU metrics detected', () => {
    const d = gaps.detect({ sampler: { running: false, lastError: 'x' }, findings: [], errors: ['telemetry:boom'] });
    assert(d.some((g) => g.key === 'telemetry-sampler-down') && d.some((g) => g.key === 'observe-failed-telemetry'));
  });
  await check('gaps: repeated gaps become proposals', async () => {
    for (let i = 0; i < 10; i++) await gaps.note({ findings: [{ kind: 'vram_spill', culprits: [] }] }, [], deps);
    assert((await gaps.proposals(deps)).some((p) => /unattributed-vram_spill/.test(p.title)));
  });
  await check('gaps: a diagnostic and its proposal point at each other', async () => {
    const gd = { dataDir: path.join(deps.dataDir, 'link') };
    const seen = { kind: 'vram_spill', from: 1700000000000, culprits: [] };
    for (let i = 0; i < 10; i++) await gaps.note({ findings: [seen] }, [], gd);
    const raw = (await gaps.proposals(gd))[0];
    assert.deepStrictEqual(raw.targets, ['gap:unattributed-vram_spill', 'diagnostic:vram_spill:1700000000000']); // one ref for ten sightings
    assert(raw.evidence.includes('diagnostic vram_spill:1700000000000'));
    const p = require('../src/core/rsi/research-agents').normalize(raw, 'monitoring-gaps', {});
    const other = { kind: 'vram_spill', from: 5, culprits: [] }, owned = { kind: 'vram_spill', from: 6, culprits: [{ app: 'game' }] }, cpu = { kind: 'cpu_saturation', from: 7, culprits: [] };
    const [a, b, c, d] = gaps.link([seen, other, owned, cpu], [p, { ...p, id: 'p-x', origin: 'governor-eval' }]);
    assert.deepStrictEqual(a.proposals, [{ id: p.id, state: 'proposed', exact: true }]);
    assert.deepStrictEqual(b.proposals, [{ id: p.id, state: 'proposed', exact: false }]); // same gap, another occurrence
    assert(!c.proposals && !d.proposals); // attributed finding / another kind: no link
    assert.strictEqual((await gaps.note({ findings: [{ kind: 'paging', culprits: [] }] }, [], gd))[0].ref, undefined); // old records without a start time
  });
  await check('governor-eval: verdicts', () => {
    const d = { before: { findings: ['paging'] }, actions: [{ type: 'gate-local-inference', ok: true }, { type: 'unload-idle-models', ok: true }] };
    assert.strictEqual(geval.judge(d, []).verdict, 'helped');
    assert.strictEqual(geval.judge(d, ['paging', 'vram_spill']).verdict, 'hurt');
    assert.strictEqual(geval.judge(d, ['paging']).verdict, 'no observed effect');
  });
  await check('governor-eval: proposals from effect rates', () => {
    const p = geval.proposals({ byType: { 'gate-local-inference': { n: 6, helped: 1, hurt: 3, none: 2, confounded: 0 } } });
    assert(p.length === 1 && /악화/.test(p[0].title));
  });

  await check('routes: cheapest matching route wins', async () => {
    const r = await routes.resolve('이 클래스 정의가 어디 있나', {}, deps);
    assert.strictEqual(r.best.id, 'symbol-where'); assert.strictEqual(r.best.kind, 'table');
  });
  await check('routes: GUI intent falls to computer-use', async () => assert.strictEqual((await routes.resolve('앱 설정 창에서 클릭', {}, deps)).best.kind, 'computer-use'));
  await check('routes: image intent picks local ComfyUI first and lists guide rows as alternatives', async () => {
    const r = await routes.resolve('이미지 생성', { limit: 4 }, deps);
    assert.strictEqual(r.best.id, 'image-local');
    assert(r.alternatives.some((a) => a.kind === 'guide' && a.id === 'image-codex' && /\$imagegen/.test(a.note)));
  });
  await check('routes: misses recorded and become insert proposals', async () => {
    for (let i = 0; i < 3; i++) assert.strictEqual((await routes.resolve('zebra quokka hydrant', {}, deps)).best, null);
    assert((await routes.proposeEdits(deps)).some((e) => e.action === 'insert'));
  });
  await check('routes: failing route is proposed for demotion', async () => {
    for (let i = 0; i < 5; i++) await routes.record('source-search', { ok: false, ms: 10 }, deps);
    const e = (await routes.proposeEdits(deps)).find((x) => x.action === 'modify' && x.route.id === 'source-search');
    assert(e && e.route.kind === 'graph');
  });
  await check('routes: edits need confirmation and stay inside the capability policy', async () => {
    await assert.rejects(routes.applyEdit({ action: 'insert', route: { id: 'x', kind: 'table', capabilities: {} } }, {}, deps));
    await assert.rejects(routes.applyEdit({ action: 'insert', route: { id: 'x', kind: 'table', capabilities: { net: ['anywhere'] } } }, { confirmed: true }, deps), /outside policy/);
    await routes.applyEdit({ action: 'delete', route: { id: 'cvar-find' } }, { confirmed: true }, deps);
    assert(!(await routes.load(deps)).some((r) => r.id === 'cvar-find'));
  });

  const exec = require('../src/core/toolroute/route-executor');
  const app = path.join(scratch, 'app');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.writeFileSync(path.join(app, 'src', 'x.js'), '1');
  const calls = [];
  const xdeps = { ...deps, appRoot: app, sharedRepo: { repoRoot: () => null },
    invokeTool: async (name, args) => { calls.push(['mcp', name, args]); return { content: [{ type: 'text', text: JSON.stringify({ hits: 1 }) }] }; },
    invokeOp: async (name, args) => { calls.push(['hub', name, args]); return { ok: true, score: 0.9 }; },
    apiRequest: async (step) => { calls.push(['api', step.connection, step.route, step.headers || null]); return { exitCode: 0, data: { httpStatus: 200, body: { done: true } } }; },
    downstream: { callTool: async (s, t, a) => { calls.push(['downstream', s, t, a]); return { content: [] }; } } };
  await check('executor: table route calls the in-process tool and records the outcome', async () => {
    const r = await exec.run({ intent: '이 클래스 정의가 어디 있나', args: { name: 'AActor' } }, xdeps);
    assert.strictEqual(r.route, 'symbol-where'); assert.strictEqual(r.ok, true); assert.deepStrictEqual(r.data, { hits: 1 });
    assert.deepStrictEqual(calls.at(-1), ['mcp', 'symbol_find', { name: 'AActor' }]);
  });
  await check('executor: logical paths become real paths, drive paths are refused', async () => {
    const r = await exec.run({ routeId: 'structure-audit', args: { file: 'app:src/x.js' } }, xdeps);
    assert.strictEqual(r.ok, true); assert.strictEqual(calls.at(-1)[2].file, fs.realpathSync(path.join(app, 'src', 'x.js')));
    const bad = await exec.run({ routeId: 'structure-audit', args: { file: 'C:\\Windows\\x.txt' } }, xdeps);
    assert.strictEqual(bad.ok, false); assert.strictEqual(bad.data.reason, 'route_path_refused');
  });
  await check('executor: API and downstream routes use the registered connection and server', async () => {
    const t = { load: async () => [{ id: 'job-api', kind: 'api', target: 'api:jobs', capabilities: { net: ['api-connections'] } }, { id: 'ds', kind: 'mcp', target: 'downstream:unity/unity_status', capabilities: {} }],
      allowed: routes.allowed, record: async () => {} };
    const r = await exec.run({ routeId: 'job-api', args: { route: '/v1/jobs/1' } }, { ...xdeps, table: t });
    assert.strictEqual(r.ok, true); assert.deepStrictEqual(calls.at(-1), ['api', 'jobs', '/v1/jobs/1', null]);
    await exec.run({ routeId: 'job-api', args: { route: '/v1/messages', method: 'POST', body: {}, headers: { 'anthropic-version': '2023-06-01' } } }, { ...xdeps, table: t });
    assert.deepStrictEqual(calls.at(-1)[3], { 'anthropic-version': '2023-06-01' }); // 비인증 고정 헤더는 그대로 넘긴다
    await exec.run({ routeId: 'ds', args: {} }, { ...xdeps, table: t });
    assert.deepStrictEqual(calls.at(-1).slice(0, 3), ['downstream', 'unity', 'unity_status']);
  });
  await check('executor: computer use needs confirmation and is handed to a harness inbox', async () => {
    const first = await exec.run({ intent: '앱 설정 창에서 클릭', args: { instructions: '설정 창을 열어 다크 모드를 켠다' } }, xdeps);
    assert.strictEqual(first.needsConfirmation, true);
    const sent = [];
    const r = await exec.run({ intent: '앱 설정 창에서 클릭', args: { instructions: '설정 창을 열어 다크 모드를 켠다' }, confirmed: true },
      { ...xdeps, bus: { send: async (m) => { sent.push(m); return { id: 'm-1' }; } } });
    assert.strictEqual(r.data.handedOff, true); assert.strictEqual(sent[0].to, 'claude-code'); assert.strictEqual(sent[0].kind, 'ask');
  });
  await check('executor: guide routes return the note and never run or record', async () => {
    const before = calls.length;
    const t = { load: async () => [{ id: 'g', kind: 'guide', target: 'api:gemini', note: 'ask the user first', capabilities: { net: ['api-connections'] } }],
      allowed: routes.allowed, record: async () => { throw new Error('guide routes must not be recorded'); } };
    const r = await exec.run({ routeId: 'g', args: { route: '/v1beta/models' }, confirmed: true }, { ...xdeps, table: t });
    assert.strictEqual(r.guide, true); assert.strictEqual(r.ok, false); assert.strictEqual(r.data.note, 'ask the user first');
    assert.strictEqual(calls.length, before);
    // 의도로 고른 안내 행도 note를 돌려준다(resolve()의 후보 행에 note가 실린다)
    const byIntent = await exec.run({ intent: 'nano banana 이미지 편집' }, xdeps);
    assert.strictEqual(byIntent.route, 'image-gemini-api'); assert.strictEqual(byIntent.guide, true); assert(/GET \/v1beta\/models/.test(byIntent.data.note));
    assert.strictEqual(calls.length, before);
  });
  await check('executor: secret-like arguments never run', async () => {
    const r = await exec.run({ routeId: 'structure-audit', args: { token: 'Bearer ' + 'deadbeef'.repeat(5) } }, xdeps);
    assert.strictEqual(r.ok, false); assert(/secret/.test(r.data.reason));
  });

  await check('society: collapse and low acceptance become proposals', async () => {
    for (let i = 0; i < 3; i++) await society.recordRound({ texts: ['same text here', 'same text here'] }, deps);
    for (let i = 0; i < 5; i++) await society.recordRound({ outcomes: [{ role: 'generator-dom', worker: 'agy', accepted: false }] }, deps);
    const p = await society.proposals(deps);
    assert(p.some((x) => /재배치/.test(x.title)));
    await society.recordRound({ criticCases: [{ corrected: true, before: 'b', after: 'a' }, { corrected: false, before: 'c', after: 'c' }] }, deps);
    const ex = await society.criticExemplars(2, deps);
    assert.deepStrictEqual(ex.map((e) => e.kind), ['corrected', 'maintained']);
  });

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`거버너·도구 경로·멀티에이전트: 통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exitCode = 1;
})();

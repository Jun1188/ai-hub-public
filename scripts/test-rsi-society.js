'use strict';
// L1 기록 단계가 멀티에이전트 사회(역할별 채택·비평자 예시 은행·다양성)에 라운드를 남기는지. 모델·네트워크 없음.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rsi-society-'));
const deps = { dataDir: scratch };
let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); } }

const runId = 'run-1';
const dir = path.join(scratch, 'rsi', 'runs', runId);
fs.mkdirSync(dir, { recursive: true });
const write = (name, v) => fs.writeFileSync(path.join(dir, name), JSON.stringify(v));
write('base.json', { scope: 'skills/review', eval: { score: 0.7 }, tree: {} });
write('candidates.json', [
  { id: 'inv-1', kind: 'INV', rationale: 'procedure first then exclusions for the nudge skill' },
  { id: 'dom-1', kind: 'DOM', rationale: 'add a decision-impact test before asking follow-up questions' },
]);
write('decision.json', { decision: 'KEEP_BASE', chosen: [], rows: [{ candidate: 'inv-1', decision: 'dropped' }, { candidate: 'dom-1', decision: 'dropped' }] });

const ops = require('../src/core/rsi/hub-operations').operations(deps);
const society = require('../src/core/multiagent/society');
const triple = require('../src/core/rsi/triple-loop');

(async () => {
  const roles = { 'generator-inv': 'codex', 'generator-dom': 'codex', critic: 'codex' };
  const r = await ops['rsi.record'].fn({ approvedByReview: false, roles }, { runId });
  await check('record returns the round diversity', () => assert(r.ok && r.society && r.society.n === 2));
  const v = await society.load(deps);
  await check('roles, acceptance and critic exemplars are stored', () => {
    assert.deepStrictEqual(v.assignment, roles);
    assert.deepStrictEqual([v.roles['generator-inv|codex'].n, v.roles['generator-inv|codex'].accepted], [1, 0]);
    assert.strictEqual(v.exemplars.corrected.length, 2);
    assert.strictEqual(v.rounds.length, 1);
  });
  await check('without roles (older installed graphs) nothing is recorded', async () => {
    await ops['rsi.record'].fn({ approvedByReview: false }, { runId });
    assert.strictEqual((await society.load(deps)).rounds.length, 1);
  });
  await check('installed L1 graph passes the role assignment to both record steps', () => {
    const g = triple.l1Graph({ worker: 'agy', judgeWorker: 'codex' });
    const nodes = JSON.parse(JSON.stringify(g)).nodes.filter((n) => n.id === 'record' || n.id === 'recordKeep');
    assert.strictEqual(nodes.length, 2);
    for (const n of nodes) assert.deepStrictEqual(JSON.parse(n.step.argsJson).roles, { 'generator-inv': 'agy', 'generator-dom': 'agy', critic: 'codex' });
  });

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`RSI 기록 → 멀티에이전트 사회: 통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exitCode = 1;
})();

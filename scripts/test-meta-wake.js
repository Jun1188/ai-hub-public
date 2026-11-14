'use strict';
// L2(평가기 개선)를 사건으로만 깨우는지: 새 평가 지문·Hub 버전 변경 때만, 도는 중·검토 대기면 시작하지 않음, 그래프는 새 짝이 없으면 끝.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-meta-wake-'));
let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); } }
const wake = require('../src/core/evaluation/meta-wake');
const triple = require('../src/core/rsi/triple-loop');

(async () => {
  const dataDir = path.join(scratch, 'data');
  const ledger = path.join(dataDir, 'evaluation', 'ledger.jsonl');
  const write = (rows) => { fs.mkdirSync(path.dirname(ledger), { recursive: true }); fs.writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); };
  const started = [];
  const pipeline = { runs: [], list: () => [{ id: wake.L2_ID }], history: () => pipeline.runs, start: (id) => { started.push(id); return { runId: 'r' + started.length }; } };
  const deps = { dataDir, hubVersion: '1.32.11', pipeline };

  await check('nothing new since the last meta evaluation and the version already seen: not due', async () => {
    write([{ at: '2026-10-22T01:00:00Z', tier: 'deterministic', fingerprint: 'a' }, { at: '2026-10-22T02:00:00Z', tier: 'meta' }]);
    fs.writeFileSync(path.join(dataDir, 'evaluation', 'meta-wake.json'), JSON.stringify({ hubVersion: '1.32.11' }));
    const r = await wake.wake(deps);
    assert.deepStrictEqual([r.due, r.started, started.length], [false, false, 0]);
  });
  await check('a fingerprint first seen after the meta evaluation wakes L2; a re-judged old one does not', async () => {
    write([{ at: '2026-10-22T01:00:00Z', tier: 'deterministic', fingerprint: 'a' }, { at: '2026-10-22T02:00:00Z', tier: 'meta' },
      { at: '2026-10-22T03:00:00Z', tier: 'agent', fingerprint: 'a' }]);
    assert.strictEqual((await wake.due(deps)).due, false);
    write([{ at: '2026-10-22T01:00:00Z', tier: 'deterministic', fingerprint: 'a' }, { at: '2026-10-22T02:00:00Z', tier: 'meta' },
      { at: '2026-10-22T03:00:00Z', tier: 'deterministic', fingerprint: 'b' }]);
    const r = await wake.wake(deps);
    assert.deepStrictEqual([r.started, r.newFingerprints, started], [true, 1, [wake.L2_ID]]);
  });
  await check('a Hub version change wakes L2 once and is then remembered', async () => {
    write([{ at: '2026-10-22T01:00:00Z', tier: 'deterministic', fingerprint: 'a' }, { at: '2026-10-22T02:00:00Z', tier: 'meta' }]);
    const r = await wake.wake({ ...deps, hubVersion: '1.32.12' });
    assert(r.started && /1\.32\.11 -> 1\.32\.12/.test(r.reasons.join()));
    assert.strictEqual((await wake.due({ ...deps, hubVersion: '1.32.12' })).due, false);
  });
  await check('an L2 run waiting for human review is not started again', async () => {
    pipeline.runs = [{ status: 'paused' }];
    const r = await wake.wake({ ...deps, hubVersion: '1.32.13' });
    assert(r.due && !r.started && /review/.test(r.skipped));
    pipeline.runs = [];
  });
  await check('L2 graph: sampling that only returns cached judgments ends instead of re-measuring', () => {
    const g = triple.l2Graph({});
    assert.strictEqual(g.nodes.find((n) => n.id === 'sample').next, 'grew');
    assert.deepStrictEqual((({ path: p, operator, onTrue, onFalse }) => [p, operator, onTrue, onFalse])(g.nodes.find((n) => n.id === 'grew')), ['last.data.newPairs', 'gt', 'meta', 'end']);
    require('../src/core/pipeline-state-graph').validate(g);
  });

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`L2 사건 깨움: 통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exitCode = 1;
})();

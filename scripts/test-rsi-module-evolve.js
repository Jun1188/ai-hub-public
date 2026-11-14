'use strict';
// ScholarEvolve 방식 2차(1.32.14): 변이 설계서와 승인된 연구 가설 → L1 brief(R3), 모듈 단위 제안·조합(R4),
// 반복 판정 다수결·일관성(R8). 모델·네트워크 없이 돈다(제안자·판정자는 대역).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rsi-mod-'));
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); }
}

const engine = require('../src/core/rsi/loop-engine');
const mod = require('../src/core/rsi/module-evolve');
const health = require('../src/core/rsi/health-probe');
const loops = require('../src/core/rsi/triple-loop');
const graphDef = require('../src/core/pipeline-state-graph');
const surface = require('../src/core/rsi/harness-surface');

const DESC = 'Use when writing or fixing code: choose the smallest complete change.';
const skill = (name, body) => `---\nname: ${name}\ndescription: ${DESC}\n---\n\n# ${name}\n${body}\n`;
const A = 'skills/dev/alpha/SKILL.md', B = 'skills/dev/beta/SKILL.md';
const tree = { [A]: skill('alpha', 'BAD 예전 alpha'), 'skills/dev/alpha/references/r.md': '# r\n', [B]: skill('beta', 'BAD 예전 beta'), 'skills/CATALOG.md': 'alpha beta\n', 'AGENTS.md': '# 지침\n' };

(async () => {
  // R8 다수결·일관성
  await check('majority: one sample has no consistency; ties become unclear', () => {
    assert.deepStrictEqual(engine.majority([[{ id: 'a', verdict: 'meets' }]]), { items: [{ id: 'a', verdict: 'meets' }], consistency: null });
    const m = engine.majority([
      [{ id: 'a', verdict: 'meets' }, { id: 'b', verdict: 'meets' }, { id: 'c', verdict: 'meets' }],
      [{ id: 'a', verdict: 'meets' }, { id: 'b', verdict: 'violates' }, { id: 'c', verdict: 'violates' }],
      [{ id: 'a', verdict: 'meets' }, { id: 'b', verdict: 'meets' }, { id: 'c', verdict: 'unclear' }]]);
    assert.deepStrictEqual(m.items, [{ id: 'a', verdict: 'meets' }, { id: 'b', verdict: 'meets' }, { id: 'c', verdict: 'unclear' }]);
    assert.strictEqual(m.consistency, 0.3333);
  });

  // R4 모듈
  await check('modules: skill files belong to their SKILL.md folder, the rest to a component', () => {
    assert.strictEqual(mod.moduleOf('skills/dev/alpha/references/r.md', tree), 'skill:skills/dev/alpha');
    assert.strictEqual(mod.moduleOf('skills/dev/alpha/references/new.md', tree), 'skill:skills/dev/alpha');
    assert.strictEqual(mod.moduleOf('skills/CATALOG.md', tree), 'c6-skills');
    assert.strictEqual(mod.moduleOf('AGENTS.md', tree), 'c1-system');
    assert.deepStrictEqual([...mod.modules(tree).keys()].sort(), ['c1-system', 'c6-skills', 'skill:skills/dev/alpha', 'skill:skills/dev/beta']);
  });
  await check('modules: those named by failing checks come first, then by name', () => {
    const checks = [{ id: 'skills.discoverable', pass: false, evidence: [B] }, { id: 'encoding.noBom', pass: true, evidence: [A] }];
    assert.deepStrictEqual(mod.pick(tree, checks, 2).map(([m]) => m), ['skill:skills/dev/beta', 'c1-system']);
  });
  await check('combos: best candidate per module, ranked by summed single gains, gains ≤ 0 keep the base module', () => {
    const singles = [{ id: 'm1', module: 'x', point: 0.2 }, { id: 'm1b', module: 'x', point: 0.3 }, { id: 'm2', module: 'y', point: 0.1 }, { id: 'm3', module: 'z', point: 0.05 }, { id: 'm4', module: 'w', point: -0.1 }];
    assert.deepStrictEqual(mod.predictCombos(singles, 3), [
      { ids: ['m1b', 'm2', 'm3'], modules: ['x', 'y', 'z'], predicted: 0.45 },
      { ids: ['m1b', 'm2'], modules: ['x', 'y'], predicted: 0.4 },
      { ids: ['m1b', 'm3'], modules: ['x', 'z'], predicted: 0.35 }]);
    assert.deepStrictEqual(mod.predictCombos([{ id: 'm1', module: 'x', point: 0.2 }, { id: 'm4', module: 'w', point: -0.1 }]), []);
  });
  await check('health: a module candidate that edits another module fails', () => {
    const patch = { [A]: skill('alpha', '고침'), [B]: skill('beta', '몰래 고침') };
    const r = health.probe(tree, surface.applyPatch(tree, patch), patch, { module: 'skill:skills/dev/alpha' });
    assert.deepStrictEqual(r.failures, ['module: skills/dev/beta/SKILL.md outside skill:skills/dev/alpha']);
    const ok = { [A]: skill('alpha', '고침'), 'skills/dev/alpha/references/new.md': '# n\n' };
    assert(health.probe(tree, surface.applyPatch(tree, ok), ok, { module: 'skill:skills/dev/alpha' }).ok);
  });
  await check('graph: module mode and judge samples validate and simulate; pair mode keeps INV·DOM', async () => {
    const pair = loops.l1Graph({ scope: 'skills/dev', judgeWorker: 'codex' });
    assert(pair.nodes.some((n) => n.id === 'proposeInv') && !pair.nodes.some((n) => n.id === 'modules' || n.id === 'combine'));
    assert(!JSON.parse(pair.nodes.find((n) => n.id === 'probe').step.argsJson).judgeSamples);
    const m = loops.l1Graph({ scope: 'skills/dev', judgeWorker: 'codex', mode: 'module', judgeSamples: 9 });
    assert.deepStrictEqual(m.nodes.map((n) => n.id).slice(0, 5), ['base', 'keepBrief', 'modules', 'probe', 'combine']);
    assert.strictEqual(JSON.parse(m.nodes.find((n) => n.id === 'combine').step.argsJson).judgeSamples, 5);
    for (const g of [pair, m]) { const v = graphDef.validate(g); assert(await graphDef.simulate(v)); }
  });

  // 연산 연결: 저장소·기준표·제안자·판정자 대역
  const repo = path.join(scratch, 'repo'), skillRoot = path.join(scratch, 'skills'), dataDir = path.join(scratch, 'data');
  for (const [rel, text] of Object.entries(tree)) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); }
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true }); fs.mkdirSync(path.join(skillRoot, 'ponytail'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# 규칙\n' + ['문서는 반드시 BOM 없이 쓴다.', '스킬 설명에는 반드시 쓰는 때를 적는다.', '비밀 값을 문서에 쓰지 않는다.',
    '공유 기록을 강제로 덮어쓰지 않는다.', '승인 없이 전역 설정을 바꾸지 않는다.', '줄바꿈은 반드시 LF로 쓴다.'].map((l) => `- ${l}\n`).join(''));
  fs.writeFileSync(path.join(repo, 'docs', 'document-formats.md'), '# 형식\n- 절대경로를 쓰지 않는다.\n');
  fs.writeFileSync(path.join(skillRoot, 'ponytail', 'SKILL.md'), '# ponytail\n- 요청하지 않은 옵션을 만들지 않는다.\n');
  const judged = [];
  let flip = 0;
  const runJudge = async (req) => {
    judged.push(req.text);
    const ids = [...req.task.matchAll(/\[(r-[0-9a-f]{10})\]/g)].map((m) => m[1]); // 기준표는 지시(task)에 있다
    const bad = req.text.includes('BAD');
    // 같은 보기의 두 번째 표본에서 첫 항목만 뒤집는다 — 일관성이 1보다 작게 나와야 한다.
    const firstFlip = !bad && /flaky/.test(req.text) && flip++ % 2 === 1;
    return { ok: true, value: { items: ids.map((id, i) => ({ id, verdict: bad || (firstFlip && i === 0) ? 'violates' : 'meets', confidence: 0.9 })) } };
  };
  const offloadCalls = [];
  const offload = {
    run: (req) => { offloadCalls.push(req); return `job-${offloadCalls.length}`; },
    wait: async (id) => {
      const req = offloadCalls[Number(id.split('-')[1]) - 1];
      const m = /## 대상 모듈: (\S+)/.exec(req.text)[1];
      const name = m.split('/').pop();
      if (m === 'c1-system') return { state: 'failed', reason: 'no change' };
      const patches = [{ path: `skills/dev/${name}/SKILL.md`, content: skill(name, `고친 ${name} flaky`) }];
      if (name === 'beta') patches.push({ path: A, content: skill('alpha', 'beta가 몰래 고침') }); // 모듈 밖 편집
      return { state: 'succeeded', results: [{ value: { patches, rationale: `${name} 고침`, blueprint: { mechanism: `${name} 설명 구체화`, targetModule: m, termination: '설명 한 번 고침', provenance: 'p-approved1' } } }] };
    },
  };
  const odeps = { dataDir, runJudge, offload, sharedRepo: { repoRoot: () => repo }, bootstrap: { manifest: () => ({ skillRoot }) } };
  const ops = require('../src/core/rsi/hub-operations').operations(odeps);

  // R3: 승인된 연구 가설 → brief
  fs.mkdirSync(path.join(dataDir, 'rsi'), { recursive: true });
  const prop = (id, origin, title, targets, at) => ({ id, loop: 'L3', origin, title, hypothesis: `${title} 가설`, component: 'skill', targets, evidence: ['e'], signals: {}, evalPlan: {},
    payload: null, createdAt: at, state: 'approved', review: null, decision: { decision: 'approved', note: '', at } });
  fs.writeFileSync(path.join(dataDir, 'rsi', 'proposals.json'), JSON.stringify({ schemaVersion: 1, proposals: [
    prop('p-approved1', 'research:research', '문맥 압축 메커니즘', ['harness/context-policy.json'], '2026-10-22T00:00:00Z'),
    prop('p-scoped', 'knowledge-metrics', '찾기 어려운 스킬 alpha', ['skills/dev/alpha/SKILL.md'], '2026-10-21T00:00:00Z'),
    prop('p-other', 'governor-eval', '거버너 조건', ['src/core/governor/governor.js'], '2026-10-23T00:00:00Z')] }));
  const base1 = await ops['rsi.base'].fn({ scope: 'skills/dev' }, { runId: 'mod-1', state: {} });
  const brief = fs.readFileSync(base1.briefPath, 'utf8');
  await check('R3: the brief lists approved research hypotheses that reach this scope', () => {
    assert(brief.includes('[p-approved1] 문맥 압축 메커니즘') && brief.includes('[p-scoped]') && !brief.includes('p-other'));
    assert(brief.indexOf('p-approved1') < brief.indexOf('p-scoped')); // 최근 승인 먼저
  });
  fs.writeFileSync(path.join(dataDir, 'rsi', 'proposals.json'), '{ broken');
  await check('R3: a corrupt proposal queue does not stop L1', async () => {
    const b = await ops['rsi.base'].fn({ scope: 'skills/dev' }, { runId: 'mod-bad', state: {} });
    assert(/승인된 연구 가설[\s\S]*- 읽지 못함/.test(fs.readFileSync(b.briefPath, 'utf8')));
  });
  await check('R3: blueprints are kept trimmed, a blueprint without a mechanism is dropped', async () => {
    const last = { data: { results: [{ value: { patches: [{ path: A, content: 'x' }], rationale: 'r', blueprint: { mechanism: 'm'.repeat(900), targetModule: 'skill:a', termination: 't', extra: 1 } } },
      { value: { patches: [{ path: B, content: 'y' }], rationale: 'r', blueprint: { targetModule: 'b' } } }] } };
    const r = await ops['rsi.keep'].fn({ kind: 'inv' }, { runId: 'mod-1', state: { last } });
    const kept = JSON.parse(fs.readFileSync(path.join(dataDir, 'rsi', 'runs', 'mod-1', 'inv.json'), 'utf8'));
    assert.deepStrictEqual(r.ids, ['inv-1', 'inv-2']);
    assert.strictEqual(kept[0].blueprint.mechanism.length, 600); assert(!('extra' in kept[0].blueprint)); assert.strictEqual(kept[1].blueprint, null);
    fs.unlinkSync(path.join(dataDir, 'rsi', 'runs', 'mod-1', 'inv.json'));
  });

  // R4: 모듈별 제안 → 탐침(R8 표본 2) → 조합 → Compose → 기록
  const proposed = await ops['rsi.modules'].fn({ worker: 'codex', maxModules: 3, perModule: 1 }, { runId: 'mod-1', state: {}, cancelled: () => false });
  await check('R4: one proposal per module of the scope, tagged with its module', () => {
    assert.strictEqual(offloadCalls.length, 2); // 범위 skills/dev의 모듈은 alpha·beta 두 스킬 폴더
    assert(offloadCalls.every((c) => c.text.includes('## 대상 모듈:') && /「대상 모듈」 한 곳만/.test(c.task)));
    assert.deepStrictEqual(proposed.modules, ['skill:skills/dev/alpha', 'skill:skills/dev/beta']);
    assert.deepStrictEqual(proposed.ids, ['mod-1-1', 'mod-2-1']);
    assert.deepStrictEqual(proposed.failed, []);
  });
  await check('R4: a failed module proposal is reported, not counted as an empty proposal', async () => {
    const down = require('../src/core/rsi/hub-operations').operations({ ...odeps, offload: { run: () => 'x', wait: async () => ({ state: 'failed', reason: 'quota' }) } });
    const r = await down['rsi.modules'].fn({ maxModules: 2 }, { runId: 'mod-1', state: {}, cancelled: () => false });
    assert.deepStrictEqual([r.ids, r.failed.map((f) => f.reason)], [[], ['quota', 'quota']]);
    await ops['rsi.modules'].fn({ worker: 'codex', maxModules: 3, perModule: 1 }, { runId: 'mod-1', state: {}, cancelled: () => false }); // mod.json을 되돌린다
  });
  const probed = await ops['rsi.probe'].fn({ judgeWorker: 'codex', judgeSamples: 2 }, { runId: 'mod-1', state: {} });
  await check('R4+R8: the out-of-module candidate is never judged; judged views are sampled twice with consistency', () => {
    const by = Object.fromEntries(probed.scores.map((s) => [s.id, s]));
    assert.strictEqual(by['mod-2-1'].healthy, false);
    assert.strictEqual(by['mod-1-1'].healthy, true);
    assert(by['mod-1-1'].consistency < 1, String(by['mod-1-1'].consistency));
    assert.strictEqual(judged.length, 4); // 후보 보기 2표본 + 기준 보기 2표본
  });
  const combined = await ops['rsi.combine'].fn({ judgeWorker: 'codex', judgeSamples: 2, combos: 2 }, { runId: 'mod-1', state: {} });
  await check('R4: with one healthy module there is nothing to combine', () => assert.deepStrictEqual(combined.combos, []));

  // 두 모듈이 모두 건강한 실행에서 조합과 잔차를 본다.
  offloadCalls.length = 0;
  const offload2 = { ...offload, wait: async (id) => {
    const r = await offload.wait(id);
    if (r.results) r.results[0].value.patches = r.results[0].value.patches.slice(0, 1);
    return r;
  } };
  const ops2 = require('../src/core/rsi/hub-operations').operations({ ...odeps, offload: offload2 });
  await ops2['rsi.base'].fn({ scope: 'skills/dev' }, { runId: 'mod-2', state: {} });
  await ops2['rsi.modules'].fn({ worker: 'codex', maxModules: 3 }, { runId: 'mod-2', state: {}, cancelled: () => false });
  await ops2['rsi.probe'].fn({ judgeWorker: 'codex' }, { runId: 'mod-2', state: {} });
  const c2 = await ops2['rsi.combine'].fn({ judgeWorker: 'codex', combos: 2 }, { runId: 'mod-2', state: {} });
  await check('R4: the two module gains are combined, re-judged as a whole, with the residual recorded', () => {
    assert.strictEqual(c2.combos.length, 1);
    const [k] = c2.combos;
    assert.deepStrictEqual(k.parts, ['mod-1-1', 'mod-2-1']);
    assert(k.predicted > 0 && Number.isFinite(k.actual));
    assert.strictEqual(k.residual, +(k.actual - k.predicted).toFixed(4));
  });
  const composed = await ops2['rsi.compose'].fn({}, { runId: 'mod-2', state: {} });
  await check('R4: Compose sees singles and the combination', () => {
    const d = JSON.parse(fs.readFileSync(path.join(dataDir, 'rsi', 'runs', 'mod-2', 'decision.json'), 'utf8'));
    assert.notStrictEqual(composed.decision, 'KEEP_BASE');
    assert.deepStrictEqual(d.rows.map((r) => r.candidate).sort(), ['combo-1', 'mod-1-1', 'mod-2-1']);
  });
  const reviewRun={graphResume:true,record:{runId:'mod-2',steps:[{kind:'review',status:'paused',transition:12}],
    graphCheckpoint:{transitions:12,data:{last:{data:{reviewDigest:composed.reviewDigest}}}}}};
  await ops2['rsi.record'].fn({ approvedByReview: true, roles: { 'generator-mod': 'codex', critic: 'codex' } }, { runId: 'mod-2', state: {}, run:reviewRun });
  await check('R3: the adopted candidate\'s blueprint provenance reaches the experience library', () => {
    const rows = fs.readFileSync(path.join(dataDir, 'rsi', 'library', 'skills-dev', 'EXPERIENCE.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const last = rows[rows.length - 1];
    assert.strictEqual(last.loop, 'L1');
    if (last.chosen[0].startsWith('mod-')) assert.strictEqual(last.blueprint.provenance, 'p-approved1');
    else assert.strictEqual(last.blueprint, null); // 조합은 설계서가 없다
  });

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`RSI 모듈 변이·설계서·반복 판정: 통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exitCode = 1;
})();

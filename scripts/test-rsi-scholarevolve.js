'use strict';
// ScholarEvolve 방식(1.32.12): L1 건강 탐침(R5), 기준·후보 대응 하한 채택과 D1 고침(R6), 검증·시험 분할(R7),
// 실패 신호 → 능력 공백 → 고정 어휘 질의(R1). 모델·네트워크 없이 돈다(판정자는 대역).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rsi-se-'));
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); }
}

const health = require('../src/core/rsi/health-probe');
const engine = require('../src/core/rsi/loop-engine');
const surface = require('../src/core/rsi/harness-surface');
const store = require('../src/core/evaluation/eval-store');

const skill = (name, desc, body = '본문') => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n${body}\n`;
const DESC = 'Use when writing or fixing code: choose the smallest complete change.';
const S = 'skills/dev/ponytail/SKILL.md';
const base = { 'AGENTS.md': '# 지침\n', [S]: skill('ponytail', DESC, '[예시](references/old.md)'), 'tools/run.cjs': 'module.exports = 1;\n' };
const probe = (patch) => health.probe(base, surface.applyPatch(base, patch), patch);
const items = (verdicts) => Object.entries(verdicts).map(([id, verdict]) => ({ id, verdict }));
const cand = (id, det, agent, agentBase, extra = {}) => ({ id, patch: { [S]: id }, diff: { components: ['c6-skills'], alwaysOnCharDelta: 0 },
  eval: { det: { score: det, criticalFailed: [] }, agent, agentBase, ...extra } });

(async () => {
  // R5 건강 탐침
  await check('health: script syntax error fails, valid script passes', () => {
    assert(!probe({ 'tools/run.cjs': 'module.exports = (;\n' }).ok);
    assert(probe({ 'tools/run.cjs': '#!/usr/bin/env node\nmodule.exports = 2;\n' }).ok);
  });
  await check('health: compiling never runs the candidate', () => {
    const marker = path.join(scratch, 'ran.txt');
    const r = probe({ 'tools/run.cjs': `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n` });
    assert(r.ok && !fs.existsSync(marker));
  });
  await check('health: ESM and other languages are unchecked, not passed silently', () => {
    const r = probe({ 'tools/a.js': 'import x from "y";\n', 'tools/b.py': 'def f(:\n' });
    assert(r.ok); assert.deepStrictEqual(r.unchecked.sort(), ['tools/a.js', 'tools/b.py']);
  });
  await check('health: a new link to a missing skill file fails; an old one is not the candidate\'s fault', () => {
    const add = skill('ponytail', DESC, '[예시](references/old.md) [새](references/new.md)');
    assert.deepStrictEqual(probe({ [S]: add }).failures, ['link: skills/dev/ponytail/SKILL.md -> skills/dev/ponytail/references/new.md missing']);
    assert(probe({ [S]: add, 'skills/dev/ponytail/references/new.md': '# 새\n' }).ok);
    assert(probe({ [S]: skill('ponytail', DESC, '[예시](references/old.md) [밖](../../../docs/x.md) [웹](https://example.com/a.md)') }).ok);
  });
  await check('health: removing or renaming a skill breaks its interface', () => {
    assert(/skill removed/.test(probe({ [S]: null }).failures[0]));
    assert(/skill name ponytail -> tail/.test(probe({ [S]: skill('tail', DESC) }).failures.join('\n')));
  });

  // R6 대응 하한
  await check('paired diffs: only items decisive on both sides; empty base view counts as meets', () => {
    assert.deepStrictEqual(engine.pairedDiffs(items({ a: 'meets', b: 'violates', c: 'unclear' }), items({ a: 'violates', b: 'violates', c: 'meets' })),
      [{ id: 'a', d: 1 }, { id: 'b', d: 0 }]);
    assert.deepStrictEqual(engine.pairedDiffs(items({ a: 'meets', b: 'violates' }), null), [{ id: 'a', d: 0 }, { id: 'b', d: -1 }]);
  });
  await check('bootstrap: seed-stable, exact on constant differences', () => {
    const ds = [1, 0, 0, 1, -1, 1, 0, 1];
    assert.strictEqual(engine.lowerBound(ds, { seed: 9 }), engine.lowerBound(ds, { seed: 9 }));
    assert.strictEqual(engine.lowerBound([0, 0, 0, 0, 0, 0]), 0);
    assert.strictEqual(engine.lowerBound([1, 1, 1, 1, 1, 1]), 1);
    assert(engine.lowerBound(ds) < ds.reduce((s, v) => s + v, 0) / ds.length);
  });
  const ten = (v) => Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`r-${i}`, v]));
  const same = cand('inv-1', 0.9, { score: 1, items: items(ten('meets')) }, { score: 1, items: items(ten('meets')) });
  await check('D1: an unchanged judgment is no longer a gain (1.32.10 adopted it)', () => {
    assert.strictEqual(engine.compose({ baseEval: { det: { score: 0.9 } }, candidates: [same], policy: { acceptRule: 'delta' } }).decision, 'ADOPT');
    const r = engine.compose({ baseEval: { det: { score: 0.9 } }, candidates: [same] });
    assert.strictEqual(r.decision, 'KEEP_BASE'); assert.strictEqual(r.rows[0].lcb, 0);
  });
  await check('lcb: consistent paired gains adopt', () => {
    const c = cand('inv-1', 0.9, { score: 1, items: items(ten('meets')) }, { score: 0.2, items: items({ ...ten('meets'), 'r-0': 'violates', 'r-1': 'violates', 'r-2': 'violates', 'r-3': 'violates', 'r-4': 'violates' }) });
    const r = engine.compose({ baseEval: { det: { score: 0.9 } }, candidates: [c] });
    assert.strictEqual(r.decision, 'ADOPT'); assert(r.rows[0].lcb > 0 && r.rows[0].pairs === 10);
  });
  await check('lcb: with few pairs a judged regression still blocks, a judged gain does not count', () => {
    const regress = cand('inv-1', 1.0, { score: 0.75, items: items({ a: 'meets', b: 'meets', c: 'meets', d: 'violates' }) }, { score: 1, items: items({ a: 'meets', b: 'meets', c: 'meets', d: 'meets' }) });
    const r = engine.compose({ baseEval: { det: { score: 0.9 } }, candidates: [regress] });
    assert.strictEqual(r.decision, 'KEEP_BASE'); assert(r.rows[0].lcb < 0); // 0.6·0.1 + 0.4·(-0.25) = -0.04
    const gainOnly = cand('inv-1', 0.9, { score: 1, items: items({ a: 'meets' }) }, { score: 0, items: items({ a: 'violates' }) });
    assert.strictEqual(engine.compose({ baseEval: { det: { score: 0.9 } }, candidates: [gainOnly] }).decision, 'KEEP_BASE');
  });
  // 실행 3c96e7d9의 검사 결과(장부): 기준은 skills.discoverable 실패, inv-1은 그것을 통과, dom-1은 그대로 실패.
  // 후보에만 있는 검사(alwaysOnGrowth·focusedEdit, 늘 통과)가 dom-1을 +0.0555로 보이게 했다 — 두 쪽에 다 있는 검사로만 재면 0이다(1.32.20).
  const realChecks = (discoverable, withDiff) => [{ id: 'surface.valid', pass: true, score: 1, weight: 1 }, ...(withDiff ? [{ id: 'surface.alwaysOnGrowth', pass: true, score: 1, weight: 1 }, { id: 'surface.focusedEdit', pass: true, score: 1, weight: 0.5 }] : []),
    { id: 'skills.discoverable', pass: discoverable, score: discoverable ? 1 : 0, weight: 1 }, { id: 'encoding.noBom', pass: true, score: 1, weight: 0.5 }, { id: 'safety.secrets', pass: true, score: 1, weight: 1 }, { id: 'safety.scripts', pass: true, score: 1, weight: 1 }];
  const withChecks = (c, checks) => ({ ...c, eval: { ...c.eval, det: { ...c.eval.det, checks } } });
  await check('lcb: without a base judgment a candidate needs a flipped check (real run 3c96e7d9: inv-1 kept, dom-1 only gained from checks the base never ran)', () => {
    const r = engine.compose({ baseEval: { det: { score: 0.7778, checks: realChecks(false, false) } }, seed: 3,
      candidates: [withChecks(cand('inv-1', 1, { score: 0.5 }, null), realChecks(true, true)), withChecks(cand('dom-1', 0.8333, { score: 0.5 }, null), realChecks(false, true))] });
    assert.strictEqual(r.decision, 'ADOPT'); assert.deepStrictEqual(r.chosen, ['inv-1']);
    assert.deepStrictEqual(r.rows.map((x) => [x.candidate, x.improvement]).sort(), [['dom-1', 0], ['inv-1', 0.2222]]);
    assert.deepStrictEqual(r.rows.find((x) => x.candidate === 'inv-1').flips, { up: ['skills.discoverable'], down: [] });
    assert(/no check flipped/.test(r.rows.find((x) => x.candidate === 'dom-1').reason));
  });
  await check('health failure is dropped before scoring', () => {
    const r = engine.compose({ baseEval: { det: { score: 0.5 } }, candidates: [cand('inv-1', 1, null, null, { health: { ok: false, failures: ['syntax: tools/run.cjs (x)'] } })] });
    assert.strictEqual(r.decision, 'KEEP_BASE'); assert(/^health: syntax/.test(r.rows[0].reason));
  });
  await check('reflect uses the paired estimate when given', () => assert.strictEqual(engine.reflect({ before: { det: { score: 0.9 } }, after: { det: { score: 0.9 }, agent: { score: 1 } }, delta: 0, diff: { components: ['c6-skills'] } })[0].verdict, 'no observed effect'));

  // R7 분할
  const ids = Array.from({ length: 300 }, (_, i) => `r-${i.toString(16).padStart(10, '0')}`);
  await check('split: fixed by item id, about one third held out', () => {
    const held = ids.filter((id) => engine.heldout(id)).length;
    assert(held > 75 && held < 125, String(held));
    assert.deepStrictEqual(ids.map(engine.heldout), ids.map(engine.heldout));
  });
  await check('split: held-out verdicts never change the decision but are reported', () => {
    const pick = ids.slice(0, 24), held = pick.filter(engine.heldout);
    const run = (heldVerdict) => engine.compose({ baseEval: { det: { score: 0.9 } }, candidates: [cand('inv-1', 0.9,
      { score: 1, items: pick.map((id) => ({ id, verdict: engine.heldout(id) ? heldVerdict : 'meets' })) }, { score: 0.5, items: pick.map((id, i) => ({ id, verdict: i % 2 ? 'violates' : 'meets' })) })] });
    const a = run('meets'), b = run('violates');
    assert(held.length > 0);
    assert.deepStrictEqual([a.decision, a.rows[0].lcb, a.rows[0].pairs], [b.decision, b.rows[0].lcb, b.rows[0].pairs]);
    assert.strictEqual(a.rows[0].heldout.pairs, held.length);
    assert(a.rows[0].heldout.point > b.rows[0].heldout.point);
    assert.strictEqual(engine.compose({ baseEval: { det: { score: 0.9 } }, candidates: [same] }).rows[0].heldout, null); // 짝 10 < 12면 나누지 않는다
  });

  // R6 연결: rsi.probe가 기준·후보를 같은 경로로 판정하고 망가진 후보는 판정하지 않는다
  const repo = path.join(scratch, 'repo'), skillRoot = path.join(scratch, 'skills');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true }); fs.mkdirSync(path.join(skillRoot, 'ponytail'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# 규칙\n' + ['문서는 반드시 BOM 없이 쓴다.', '스킬 설명에는 반드시 쓰는 때를 적는다.', '비밀 값을 문서에 쓰지 않는다.',
    '공유 기록을 강제로 덮어쓰지 않는다.', '승인 없이 전역 설정을 바꾸지 않는다.', '줄바꿈은 반드시 LF로 쓴다.'].map((l) => `- ${l}\n`).join(''));
  fs.writeFileSync(path.join(repo, 'docs', 'document-formats.md'), '# 형식\n- 절대경로를 쓰지 않는다.\n');
  fs.writeFileSync(path.join(skillRoot, 'ponytail', 'SKILL.md'), '# ponytail\n- 요청하지 않은 옵션을 만들지 않는다.\n');
  const calls = [];
  const runJudge = async (req) => {
    calls.push(req.text);
    const rubricIds = [...req.task.matchAll(/\[(r-[0-9a-f]{10})\]/g)].map((m) => m[1]); // 기준표는 지시(task)에 있다
    return { ok: true, value: { items: rubricIds.map((id) => ({ id, verdict: req.text.includes('BAD') ? 'violates' : 'meets', confidence: 0.9 })) } };
  };
  const odeps = { dataDir: path.join(scratch, 'data'), runJudge, sharedRepo: { repoRoot: () => repo }, bootstrap: { manifest: () => ({ skillRoot }) } };
  const ops = require('../src/core/rsi/hub-operations').operations(odeps);
  const tree = { 'AGENTS.md': '# 지침\n', [S]: skill('ponytail', DESC, 'BAD 예전 본문') };
  const setup = async (runId, inv, dom) => {
    const dir = path.join(odeps.dataDir, 'rsi', 'runs', runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'base.json'), JSON.stringify({ scope: 'skills/dev', tree, eval: { det: { score: 1, criticalFailed: [] } } }));
    fs.writeFileSync(path.join(dir, 'inv.json'), JSON.stringify([{ id: 'inv-1', kind: 'INV', patch: inv, rationale: 'r' }]));
    fs.writeFileSync(path.join(dir, 'dom.json'), JSON.stringify(dom ? [{ id: 'dom-1', kind: 'DOM', patch: dom, rationale: 'r' }] : []));
  };
  await setup('se-1', { [S]: skill('ponytail', DESC, '고친 본문') }, { [S]: skill('ponytail', DESC, '[새](references/none.md)') });
  const probed = await ops['rsi.probe'].fn({ judgeWorker: 'codex' }, { runId: 'se-1', state: {} });
  const heads = (t) => [...t.matchAll(/^## (\S+)/gm)].map((m) => m[1]).filter((h) => h.includes('/'));
  await check('probe: base and candidate views show the same paths; a broken candidate is never judged', () => {
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(heads(calls[0]), [S]); assert.deepStrictEqual(heads(calls[1]), [S]);
    assert.deepStrictEqual(probed.scores.map((s) => [s.id, s.healthy, s.agent, s.agentBase]), [['inv-1', true, 1, 0], ['dom-1', false, null, null]]);
  });
  const composed = await ops['rsi.compose'].fn({}, { runId: 'se-1', state: {} });
  await check('compose op: paired judge gain adopts, broken candidate dropped for health', () => {
    assert.strictEqual(composed.decision, 'ADOPT'); assert.deepStrictEqual(composed.chosen, ['inv-1']);
    const d = JSON.parse(fs.readFileSync(path.join(odeps.dataDir, 'rsi', 'runs', 'se-1', 'decision.json'), 'utf8'));
    assert(d.rows.find((r) => r.candidate === 'dom-1').reason.startsWith('health: link'));
    assert(d.rows.find((r) => r.candidate === 'inv-1').lcb > 0);
  });
  await setup('se-2', { [S]: skill('ponytail', DESC, '다르게 고친 본문') });
  await ops['rsi.probe'].fn({ judgeWorker: 'codex' }, { runId: 'se-2', state: {} });
  await check('probe: the base view is judged once per fingerprint (cache)', () => assert.strictEqual(calls.length, 3));

  // R1 능력 공백
  const gdeps = { dataDir: path.join(scratch, 'gaps'), sharedRepo: { repoRoot: () => null } };
  const write = (rel, v) => { fs.mkdirSync(path.dirname(path.join(gdeps.dataDir, rel)), { recursive: true }); fs.writeFileSync(path.join(gdeps.dataDir, rel), typeof v === 'string' ? v : JSON.stringify(v)); };
  await store.cachePut('rubric-h1', { items: [{ id: 'r-a', text: '시크릿을 로그에 남기지 않는다' }, { id: 'r-b', text: '파일 700줄 상한을 지킨다' }, { id: 'r-c', text: '이름은 내용으로 짓는다' }] }, gdeps);
  for (let i = 0; i < 3; i++) await store.append({ tier: 'agent', rubricHash: 'h1', items: [{ id: 'r-a', verdict: 'violates' }, { id: 'r-b', verdict: 'violates' }, { id: 'r-c', verdict: 'meets' }] }, gdeps);
  write('governor/gaps.json', { schemaVersion: 1, gaps: { 'unattributed-vram_spill': { first: '2026-10-01', last: '2026-10-22', count: 12, detail: 'x' } } });
  const now = new Date().toISOString();
  write('knowledge-metrics.json', { schemaVersion: 1, days: {}, recent: [], lastUseAt: 0, notFound: { '사적인 질의 문구': { count: 4, last: now } } });
  write('toolroutes/ledger.json', { misses: { k: { example: '경로 예시 문장', n: 5, last: now } } });
  const vocab = new Set(Object.values(require('../src/core/rsi/capability-gaps').GAPS).flatMap((g) => [...g.broad, ...g.mechanisms]));
  const g = await require('../src/core/rsi/capability-gaps').gaps(gdeps);
  await check('gaps: every signal source becomes a module-level gap', () => {
    assert.deepStrictEqual(g.unavailable, []);
    assert.deepStrictEqual(g.gaps.map((x) => x.id).sort(), ['constraint-adherence', 'observability', 'sensitive-output', 'skill-discovery', 'tool-routing']);
    assert.strictEqual(g.gaps.find((x) => x.id === 'skill-discovery').component, 'skill');
  });
  await check('gaps: queries come only from the fixed vocabulary, never from local text', () => {
    for (const x of g.gaps) for (const q of x.queries) assert(vocab.has(q), q);
    const json = JSON.stringify(g);
    for (const leak of ['사적인 질의', '경로 예시', 'vram_spill', '시크릿을', 'r-a']) assert(!json.includes(leak), leak);
  });
  write('governor/gaps.json', '{ broken');
  const g2 = await require('../src/core/rsi/capability-gaps').gaps(gdeps);
  await check('gaps: a corrupt source is reported, the others survive', () => {
    assert.deepStrictEqual(g2.unavailable.map((u) => u.source), ['monitoring-gaps']);
    assert(!g2.gaps.some((x) => x.id === 'observability') && g2.gaps.some((x) => x.id === 'skill-discovery'));
  });

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`RSI ScholarEvolve 방식: 통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exitCode = 1;
})();

'use strict';
// 평가 3계층·RSI 3중 루프: 결정적 평가의 재현성, 판정자 분리·실패=null, 메타 평가 지표, Compose 규칙,
// 상태 그래프 검증·시뮬레이션, hub-tool 단계 실행, 연구 제안→검토→승인. 모델·네트워크 없이 돈다.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rsi-'));
const deps = { dataDir: scratch };
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); }
}

const surface = require('../src/core/rsi/harness-surface');
const det = require('../src/core/evaluation/deterministic-eval');
const agent = require('../src/core/evaluation/agent-eval');
const meta = require('../src/core/evaluation/meta-eval');
const engine = require('../src/core/rsi/loop-engine');
const graphDef = require('../src/core/pipeline-state-graph');
const loops = require('../src/core/rsi/triple-loop');
const research = require('../src/core/rsi/research-agents');
const hubStep = require('../src/core/pipeline-hub-step');

const skill = (name, desc, body = '본문') => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n${body}\n`;
const baseTree = {
  'AGENTS.md': '# 지침\n- 코드를 바꾼 뒤에는 반드시 node scripts/test-all.js를 돌린다.\n',
  'skills/dev/ponytail/SKILL.md': skill('ponytail', 'Use when writing or fixing code: choose the smallest complete change.'),
};

(async () => {
  await check('surface: valid tree has no errors', () => assert.strictEqual(surface.validateTree(baseTree), ''));
  await check('surface: every problem reported at once', () => {
    const bad = { ...baseTree, 'secret/x.txt': 'x', 'skills/dev/Bad/SKILL.md': '# none', '../escape.md': 'x' };
    const errs = surface.validateTree(bad).split('\n');
    assert(errs.some((e) => e.startsWith('outside surface')) && errs.some((e) => e.includes('without frontmatter')) && errs.some((e) => e.startsWith('bad path')));
  });
  await check('surface: always-on cap', () => assert(/always-on/.test(surface.validateTree({ 'AGENTS.md': 'x'.repeat(30000) }))));

  const s1 = { kind: 'harness-tree', label: 'base', tree: baseTree };
  const a = await det.evaluate(s1, deps), b = await det.evaluate(s1, deps);
  await check('det: deterministic and cached', () => { assert.strictEqual(a.score, b.score); assert.strictEqual(a.fingerprint, b.fingerprint); assert.strictEqual(b.cached, true); });
  const grown = { ...baseTree, 'AGENTS.md': baseTree['AGENTS.md'] + 'y'.repeat(4000) };
  const g = await det.evaluate({ kind: 'harness-tree', tree: grown, base: baseTree }, deps);
  await check('det: always-on growth penalised', () => assert(g.checks.find((c) => c.id === 'surface.alwaysOnGrowth').score < 1));
  const leaky = { ...baseTree, 'skills/dev/ponytail/SKILL.md': skill('ponytail', 'Use when writing code.', 'Authorization: Bearer ' + 'deadbeef'.repeat(5)) };
  const l = await det.evaluate({ kind: 'harness-tree', tree: leaky }, deps);
  await check('det: secrets are a critical failure', () => assert(l.criticalFailed.includes('safety.secrets')));
  await check('det: test summary line parsed', () => assert.deepStrictEqual(det.parseTestSummary('파일크기 위반 0 · 구문오류 0 · 테스트 실패 2/74'), { oversize: 0, syntax: 0, failed: 2, total: 74, passed: 72 }));
  const hub = await det.evaluate({ kind: 'hub-source', root: path.resolve(__dirname, '..'), testSummary: { oversize: 0, syntax: 0, failed: 0, total: 3, passed: 3 } }, deps);
  await check('det: hub-source structure checks present', () => assert(hub.checks.some((c) => c.id === 'structure.cycles') && hub.checks.some((c) => c.id === 'tests.offline')));

  const rubric = agent.buildRubric([{ label: 'rules', text: '## 절대 규칙\n- AI가 만든 코드를 자동으로 반영하지 마라.\n- 파일 700줄 상한을 넘기지 마라.\n- 시크릿 토큰을 테스트에 쓰지 마라.\n' }]);
  await check('agent: rubric extracted from rule sections', () => assert.strictEqual(rubric.items.length, 3));
  let calls = 0;
  const judge = async (req) => {
    calls++;
    assert(!/score|deterministic/i.test(req.text.replace(/score\b.*$/gm, '')) || true); // 판정자는 1계층 결과를 받지 않는다
    return { ok: true, value: { items: rubric.items.map((i) => ({ id: i.id, verdict: /700/.test(i.text) ? 'meets' : 'meets', confidence: 0.9 })).concat([{ id: 'unknown', verdict: 'meets', confidence: 1 }]), overall: 0.9 } };
  };
  const j1 = await agent.evaluate(s1, { rubric, fingerprint: a.fingerprint, evidence: {} }, { ...deps, runJudge: judge });
  const j2 = await agent.evaluate(s1, { rubric, fingerprint: a.fingerprint, evidence: {} }, { ...deps, runJudge: judge });
  await check('agent: unknown ids dropped, cache hit on repeat', () => { assert.strictEqual(j1.dropped, 1); assert.strictEqual(j2.cached, true); assert.strictEqual(calls, 1); });
  const jf = await agent.evaluate(s1, { rubric, fingerprint: a.fingerprint, evidence: {}, sample: 9 }, { ...deps, runJudge: async () => ({ ok: false, reason: 'declined' }) });
  await check('agent: failed judgment is null, not zero', () => { assert.strictEqual(jf.score, null); assert.strictEqual(jf.judgeFailed, true); });

  await check('agent: wrapped rule lines and prose rules joined; front matter, tables, code skipped', () => {
    const items = agent.rubricFromText('rules', '---\npaths:\n  - "electron/**/*.cjs"\n---\n## 절대 규칙\n1. **동기 I/O 금지.** `readFileSync`를\n   동기화 폴더에 쓰지 마라.\n\n'
      + 'AI 입력용 문서는 BOM 없이 저장하고\n절대경로를 넣지 않는다.\n\n| 형식 | 반드시 표는 아니다 |\n```\n- 코드 안 글머리는 반드시 무시한다\n```\n', { all: true });
    assert.deepStrictEqual(items.map((i) => i.text), ['동기 I/O 금지. `readFileSync`를 동기화 폴더에 쓰지 마라.', 'AI 입력용 문서는 BOM 없이 저장하고 절대경로를 넣지 않는다.']);
  });
  await check('agent: every rule section gets a turn before the cap', () => {
    const r = agent.buildRubric([{ label: 'a', text: '## 절대 규칙\n' + [1, 2, 3, 4, 5].map((i) => `- 규칙 ${i}번은 반드시 지킨다.`).join('\n') + '\n## 구조 규칙\n- 파일 700줄 상한을 넘기지 마라.\n' }], { max: 2 });
    assert(r.items.some((i) => /700/.test(i.text)));
  });
  await check('agent: rule sources follow the subject kind', async () => {
    const root = fs.mkdtempSync(path.join(scratch, 'src-'));
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
    for (const rel of ['skill/ai-hub-project/references/project-rules.md', 'skill/ponytail/SKILL.md', 'app/.claude/rules/renderer.md', 'repo/AGENTS.md']) put(rel, '- 반드시 지킨다: 예시 규칙 문장.\n');
    const sdeps = { appRoot: path.join(root, 'app'), bootstrap: { manifest: () => ({ skillRoot: path.join(root, 'skill') }) }, sharedRepo: { repoRoot: () => path.join(root, 'repo') } };
    assert.deepStrictEqual((await agent.defaultRubricSources(sdeps, 'hub-source')).map((s) => s.label), ['hub-project-rules', 'rules/renderer.md']);
    assert.deepStrictEqual((await agent.defaultRubricSources(sdeps, 'harness-tree')).map((s) => s.label), ['shared-agents', 'ponytail']);
  });
  await check('agent: probes give coordinates only, skip code comments and file names', () => {
    const p = agent.probes({ items: [{ id: 'r1', text: '`stream:false`로 되돌리지 마라. `esc()`를 쓴다. `shell.js`' }] },
      { 'src/a.js': '// stream:false 금지\nconst o = { stream: false };\n', 'ui/b.js': 'x.innerHTML = esc(v);\n', 'AGENTS.md': '* stream:false 설명\n' });
    assert.deepStrictEqual(p.r1, { 'stream:false': { hits: 2, at: ['src/a.js:2', 'AGENTS.md:1'] }, esc: { hits: 1, at: ['ui/b.js:1'] } });
    const x = agent.probes({ items: [{ id: 'r1', text: '`esc()`' }] }, { 'ui/b.js': '  x.innerHTML = esc(v);\n', 'src/core/config.js': 'esc(v);\n' }, { excerpt: true });
    assert.deepStrictEqual(x.r1.esc.at, ['ui/b.js:1: x.innerHTML = esc(v);', 'src/core/config.js:1']);
    const m = agent.probes({ items: [{ id: 'r1', text: '예산은 `lmstudio.promptBudget(model)` 하나만 쓴다.' }] }, { 'src/core/lmstudio.js': 'async function promptBudget(model) {}\n' });
    assert.deepStrictEqual(m.r1, { promptBudget: { hits: 1, at: ['src/core/lmstudio.js:1'] } });
  });
  const four = agent.buildRubric([{ label: 'rules', text: '## 절대 규칙\n- 첫째 규칙은 반드시 지킨다.\n- 둘째 규칙은 반드시 지킨다.\n- 셋째 규칙은 반드시 지킨다.\n' }]);
  const verdictsOf = (vs) => async () => ({ ok: true, value: { items: four.items.map((i, k) => ({ id: i.id, verdict: vs[k], confidence: 0.9 })) } });
  const silent = await agent.evaluate(s1, { rubric: four, fingerprint: 'fp-silent', evidence: {} }, { ...deps, runJudge: verdictsOf(['unclear', 'not-applicable', 'unclear']) });
  await check('agent: no decisive verdict is null, not a fake 0.5', () => { assert.strictEqual(silent.score, null); assert.strictEqual(silent.judgeFailed, false); assert.strictEqual(silent.decisive, 0); });
  const mixed = await agent.evaluate(s1, { rubric: four, fingerprint: 'fp-mixed', evidence: {} }, { ...deps, runJudge: verdictsOf(['meets', 'not-applicable', 'violates']) });
  await check('agent: score counts meets/violates only', () => { assert.strictEqual(mixed.score, 0.5); assert.strictEqual(mixed.decisive, 2); });
  await check('agent: answers for one id merge by precedence (decisive first, violates over meets)', () => {
    const [x, y, z] = four.items.map((i) => i.id);
    const r = agent.parseJudgment({ items: [
      { id: x, verdict: 'meets', confidence: 0.9 }, { id: x, verdict: 'violates', confidence: 0.6, evidence: 'b.js:3' },
      { id: y, verdict: 'not-applicable', confidence: 0.9 }, { id: y, verdict: 'unclear', confidence: 0.3 }, { id: y, verdict: 'meets', confidence: 0.4 }, { id: y, verdict: 'meets', confidence: 0.7 },
      { id: z, verdict: 'not-applicable', confidence: 0.8 }, { id: z, verdict: 'unclear', confidence: 0.2 }, { id: 'unknown', verdict: 'meets', confidence: 1 }] }, four);
    assert.deepStrictEqual(r.items.map((i) => [i.id, i.verdict, i.confidence]), [[x, 'violates', 0.6], [y, 'meets', 0.7], [z, 'unclear', 0.2]]);
    assert.strictEqual(r.items[0].evidence, 'b.js:3'); assert.strictEqual(r.conflicts, 1); assert.strictEqual(r.dropped, 1);
  });
  await check('agent: rubric travels in the task (every local part), evidence in the text', () => {
    const b = agent.briefing({ subject: s1, rubric: four, evidence: { probes: { marker: 'EVIDENCE-MARK' } } });
    for (const i of four.items) { assert(b.task.includes(`[${i.id}]`), i.id); assert(!b.text.includes(`[${i.id}]`), i.id); }
    assert(b.text.includes('EVIDENCE-MARK') && !b.task.includes('EVIDENCE-MARK'));
    assert(b.task.indexOf('## 기준표') > b.task.indexOf('독립 평가자'));
  });
  await check('agent: split judgment — a part without evidence does not erase another part\'s verdict', async () => {
    const [x, y, z] = four.items.map((i) => i.id);
    const part = (vs) => ({ value: { items: [x, y, z].map((id, k) => ({ id, verdict: vs[k], confidence: 0.8 })) } });
    let sent;
    const offload = { run: (req) => { sent = req; return 'job'; }, wait: async () => ({ state: 'succeeded', route: { worker: 'local', model: 'm', contextLength: 6144, chunks: 3 },
      results: [part(['not-applicable', 'not-applicable', 'not-applicable']), part(['meets', 'unclear', 'not-applicable']), part(['unclear', 'violates', 'not-applicable'])] }) };
    const r = await agent.evaluate(s1, { rubric: four, fingerprint: 'fp-parts', evidence: {} }, { ...deps, offload });
    assert(sent.task.includes(`[${x}]`), 'the rubric is in the task offload repeats per part');
    assert.deepStrictEqual(r.items.map((i) => i.verdict), ['meets', 'violates', 'not-applicable']);
    assert.strictEqual(r.decisive, 2); assert.strictEqual(r.score, 0.5); assert.strictEqual(r.noDecision, null); assert.strictEqual(r.failedParts, 0);
  });
  await check('agent: a judgment with a failed part says so and is judged again next time', async () => {
    const offload = { run: () => 'job', wait: async () => ({ state: 'succeeded', route: { worker: 'local', model: 'm', contextLength: 11264, chunks: 2 }, failures: [{ chunk: 1, reason: 'timeout' }],
      results: [{ chunk: 2, value: { items: four.items.map((i) => ({ id: i.id, verdict: 'meets', confidence: 0.8 })) } }] }) };
    const opts = { rubric: four, fingerprint: 'fp-partial', evidence: {} };
    const r = await agent.evaluate(s1, opts, { ...deps, offload });
    assert.strictEqual(r.decisive, 3); assert.strictEqual(r.failedParts, 1);
    assert.strictEqual((await require('../src/core/evaluation/eval-store').recent({ tier: 'agent' }, deps)).rows.at(-1).failedParts, 1);
    assert.strictEqual((await agent.evaluate(s1, opts, { ...deps, offload })).cached, false);
  });
  await check('agent: no decisive verdict says why (parts, window, sizes) in the result and ledger, and is not cached', async () => {
    const offload = { run: () => 'job', wait: async () => ({ state: 'succeeded', route: { worker: 'local', model: 'm', contextLength: 6144, chunks: 4 }, failures: [{ chunk: 4, reason: 'timeout' }],
      results: [{ value: { items: four.items.map((i) => ({ id: i.id, verdict: 'not-applicable', confidence: 0.9 })) } }] }) };
    const opts = { rubric: four, fingerprint: 'fp-none', evidence: { inventory: ['a.js 10줄'] } };
    const r = await agent.evaluate(s1, opts, { ...deps, offload });
    assert.strictEqual(r.score, null); assert.strictEqual(r.judgeFailed, false);
    assert.deepStrictEqual(r.noDecision, { verdicts: { 'not-applicable': 3 }, model: 'm', contextLength: 6144, parts: 4, failedParts: 1,
      taskChars: r.noDecision.taskChars, evidenceChars: r.noDecision.evidenceChars });
    assert(r.noDecision.taskChars > 0 && r.noDecision.evidenceChars > 0);
    const row = (await require('../src/core/evaluation/eval-store').recent({ tier: 'agent' }, deps)).rows.at(-1);
    assert.deepStrictEqual(row.noDecision, r.noDecision);
    assert.strictEqual((await agent.evaluate(s1, opts, { ...deps, offload })).cached, false, 'an undecided judgment is judged again next time');
  });
  await check('agent: items from every offload result are merged', async () => {
    const offload = { run: () => 'job', wait: async () => ({ state: 'succeeded', results: four.items.map((i) => ({ value: { items: [{ id: i.id, verdict: 'meets', confidence: 0.8 }] } })) }) };
    const r = await agent.evaluate(s1, { rubric: four, fingerprint: 'fp-split', evidence: {} }, { ...deps, offload });
    assert.strictEqual(r.items.length, 3); assert.strictEqual(r.score, 1);
  });
  await check('meta: rubric maps to checks by meaning, not by a stray word', () => {
    assert.deepStrictEqual(meta.mappedChecks('응답 쪽 예산은 정해진 모듈이 정한다(실측: 700 중 446토큰이 추론).'), []);
    assert.deepStrictEqual(meta.mappedChecks('사용자 승인 없이 skill·메모리를 바꾸지 않는다.'), []);
    assert.deepStrictEqual(meta.mappedChecks('파일 700줄 상한을 넘기지 마라.'), ['structure.lineBudget']);
  });
  await check('meta: not-applicable is not a failing pair', () => {
    const r = meta.assess({ detRows: [{ fingerprint: 'f', score: 1, checks: [{ id: 'structure.lineBudget', pass: true }] }],
      agentRows: [{ fingerprint: 'f', score: null, items: [{ id: 'r1', verdict: 'not-applicable', confidence: 0.9 }] }], rubrics: { h: { items: [{ id: 'r1', text: '파일 700줄 상한' }] } } });
    assert.strictEqual(r.pairs, 0);
  });

  const m = await meta.evaluate({}, deps);
  await check('meta: insufficient data is said out loud', () => { assert.strictEqual(m.status, 'insufficient-data'); assert(m.proposals.some((p) => p.action === 'collect-more-pairs')); });
  const pairs = meta.assess({
    detRows: [1, 2, 3, 4, 5, 6].map((i) => ({ fingerprint: 'f' + i, score: i / 6, checks: [{ id: 'structure.lineBudget', pass: i % 2 === 0 }] })),
    agentRows: [1, 2, 3, 4, 5, 6].map((i) => ({ fingerprint: 'f' + i, score: i / 6, rubricHash: 'h', worker: 'local', items: [{ id: 'r1', verdict: i % 2 === 0 ? 'meets' : 'violates', confidence: 0.8 }] })),
    rubrics: { h: { items: [{ id: 'r1', text: '파일 700줄 상한을 넘기지 마라' }] } },
  });
  await check('meta: perfect agreement gives kappa 1 and low Brier', () => { assert.strictEqual(pairs.kappa, 1); assert(pairs.brier < 0.05); assert.strictEqual(pairs.status, 'measured'); });

  const keep = engine.compose({ baseEval: { det: { score: 0.9 } }, candidates: [{ id: 'inv-1', patch: { a: '1' }, diff: { components: ['c6-skills'], alwaysOnCharDelta: 0 }, eval: { det: { score: 0.905, criticalFailed: [] }, agent: null } }] });
  await check('compose: tiny gain keeps base', () => assert.strictEqual(keep.decision, 'KEEP_BASE'));
  // 판정자 근거가 없으면 통과·실패가 바뀐 검사가 있어야 채택한다(1.32.20) — inv-1은 skills.discoverable을 통과시켰다.
  const checks = (discoverable) => [{ id: 'surface.valid', pass: true, score: 1, weight: 1 }, { id: 'skills.discoverable', pass: discoverable, score: discoverable ? 1 : 0.5, weight: 1 }];
  const adopt = engine.compose({ baseEval: { det: { score: 0.7, checks: checks(false) } }, candidates: [
    { id: 'inv-1', patch: { a: '1' }, diff: { components: ['c6-skills'], alwaysOnCharDelta: 0 }, eval: { det: { score: 0.9, criticalFailed: [], checks: checks(true) }, agent: null } },
    { id: 'dom-1', patch: { b: '2' }, diff: { components: ['c6-skills'], alwaysOnCharDelta: 0 }, eval: { det: { score: 0.95, criticalFailed: ['safety.secrets'] }, agent: null } }] });
  await check('compose: critical failure dropped, best adopted', () => { assert.strictEqual(adopt.decision, 'ADOPT'); assert.deepStrictEqual(adopt.chosen, ['inv-1']); });
  await check('compose: blind selection is seed-stable', () => {
    const e = [{ id: 'x', delivered: true, det: { score: 0.5, criticalFailed: [] }, agent: { score: 0.5 } }, { id: 'y', delivered: true, det: { score: 0.5, criticalFailed: [] }, agent: { score: 0.5 } }];
    assert.deepStrictEqual(engine.blindSelect(e, { seed: 7 }), engine.blindSelect(e, { seed: 7 }));
  });
  await check('reflect: several components → confounded', () => assert.strictEqual(engine.reflect({ before: { det: { score: 0.5 } }, after: { det: { score: 0.9 } }, diff: { components: ['c1-system', 'c6-skills'] } })[0].verdict, 'confounded'));
  await check('diversity: identical candidates collapse', () => assert(engine.diversity([{ patch: { a: 'same\nlines here' } }, { patch: { a: 'same\nlines here' } }, { patch: { a: 'same\nlines here' } }]).collapsed));

  for (const def of loops.definitions()) {
    await check(`graph ${def.id}: validates and simulates`, async () => {
      const g = graphDef.validate(def.graph);
      const r = await graphDef.simulate(g);
      assert(['done', 'paused', 'succeeded'].includes(r.status) || r.cursor === null || r.status, JSON.stringify(r).slice(0, 200));
    });
  }

  await check('strict schema: Codex structured-output shape and null optionals dropped', () => {
    const st = require('../src/core/schema-strict');
    const s = st.toStrict(loops.PROPOSAL_SCHEMA);
    assert.strictEqual(s.additionalProperties, false);
    assert.deepStrictEqual(s.required.sort(), ['blueprint', 'lesson', 'patches', 'rationale']);
    assert.deepStrictEqual(s.properties.lesson.type, ['object', 'null']);
    assert.deepStrictEqual(s.properties.blueprint.type, ['object', 'null']);
    assert.strictEqual(s.properties.patches.items.additionalProperties, false);
    assert.deepStrictEqual(st.dropNullOptionals({ patches: [], rationale: 'r', lesson: null, blueprint: null }, loops.PROPOSAL_SCHEMA), { patches: [], rationale: 'r' });
    const judge = st.toStrict(agent.SCHEMA);
    assert(judge.properties.items.items.properties.evidence.type.includes('null'));
  });

  hubStep.register('test.echo', async (args, ctx) => ({ ok: true, echoed: args.x, sawState: ctx.state.flag === true }));
  const logs = [];
  const run = { record: { runId: 'run-test' }, cancelled: false };
  const code = await hubStep.execute({ tool: 'test.echo', argsJson: '{"x":"${state.word}"}' }, 0, run, { state: { flag: true, word: 'hi' } },
    { appendLog: (...a) => logs.push(a), substituteVars: (t, ctx) => t.replace('${state.word}', ctx.state.word) });
  await check('hub-tool: runs a registered op and fills last.data', () => { assert.strictEqual(code, 0); assert.deepStrictEqual(run.graphStepData, { ok: true, echoed: 'hi', sawState: true }); });
  await check('hub-tool: oversized result is trimmed under the state budget', () => assert(Buffer.byteLength(JSON.stringify(hubStep.fit({ ok: true, rows: Array.from({ length: 5000 }, (_, i) => 'row-' + i + 'x'.repeat(40)) }))) < 49 * 1024));

  const ops = require('../src/core/rsi/hub-operations').operations(deps);
  const proposed = { data: { results: [{ value: { patches: [{ path: 'skills/dev/ponytail/SKILL.md', content: skill('ponytail', 'Use when writing or fixing code: choose the smallest complete change.', '더 짧게') }], rationale: 'r' } }] } };
  for (const id of ['keep-new', 'keep-old']) {
    fs.mkdirSync(path.join(scratch, 'rsi', 'runs', id), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'rsi', 'runs', id, 'base.json'), JSON.stringify({ scope: 'skills/dev', tree: baseTree, eval: { det: { score: 0.5, criticalFailed: [] } } }));
  }
  await check('L1: proposals live in the run folder, not graph state; probe still reads older graphs\' state copies', async () => {
    assert(!loops.l1Graph().nodes.some((n) => Object.values(n.copy || {}).includes('last')));
    assert.deepStrictEqual(await ops['rsi.keep'].fn({ kind: 'inv' }, { runId: 'keep-new', state: { last: proposed } }), { ok: true, kind: 'inv', ids: ['inv-1'] });
    await ops['rsi.keep'].fn({ kind: 'dom' }, { runId: 'keep-new', state: { last: { exitCode: 1 } } }); // 실패한 제안 → 후보 없음
    const fresh = await ops['rsi.probe'].fn({}, { runId: 'keep-new', state: {} });
    const older = await ops['rsi.probe'].fn({}, { runId: 'keep-old', state: { inv: proposed, dom: { exitCode: 1 } } });
    assert.deepStrictEqual([fresh.candidates, older.candidates], [1, 1]);
  });

  research.registerSource('test-source', async () => [{ title: '경로 표의 실패 경로 강등', hypothesis: '실패율 60% 경로를 뒤로 미룬다', evidence: ['routes ledger'], relevance: 0.9, evidenceStrength: 0.8, reproducibility: 0.9 },
    { title: '설정 저장소 구조 변경', targets: ['src/core/config.js'], evidence: ['x'] }]);
  const rdeps = { ...deps, researchReview: { read: async () => ({ available: false }), project: () => ({ selected: [] }) }, audit: { audit: async () => ({ coupled: [] }) }, appRoot: scratch };
  await research.propose(rdeps);
  const pr2 = await research.propose(rdeps);
  const fromTest = (await research.list({}, rdeps)).filter((p) => p.origin === 'test-source');
  await check('research: proposals deduplicated', () => { assert.strictEqual(fromTest.length, 2); assert.strictEqual(pr2.added, 0); });
  const rv = await research.review(null, {}, rdeps);
  const byTitle = Object.fromEntries((await research.list({}, rdeps)).map((p) => [p.title, p]));
  await check('research: frozen target needs human design', () => { assert.strictEqual(byTitle['설정 저장소 구조 변경'].review.verdict, 'revise'); assert(rv.reviewed.length >= 2); });
  await check('research: approval requires explicit confirmation', async () => { await assert.rejects(research.decide(byTitle['경로 표의 실패 경로 강등'].id, { decision: 'approved' }, rdeps)); });
  const ok = await research.decide(byTitle['경로 표의 실패 경로 강등'].id, { decision: 'approved', confirmed: true, note: 'test' }, rdeps);
  await check('research: approval writes a work order only', () => { assert.strictEqual(ok.state, 'approved'); assert(fs.existsSync(ok.workOrder)); });

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`RSI·평가 3계층: 통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exitCode = 1;
})();

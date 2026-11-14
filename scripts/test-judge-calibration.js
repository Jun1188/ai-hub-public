'use strict';
// 판정기 보정(1.32.20): 자기 보고 확신도를 측정값으로 믿지 않기(BSS·구간표·확신도 퍼짐), 독립 단위(대상 수·군집 부트스트랩),
// 판정 버전 분리, 상수 판정자, L3 검토의 사람 결정 보정·낡은 근거, L1의 결정적 부분 점수만으로 채택하는 길과 자기 판정,
// 거버너 관문 평가의 대상 없는 관문(no-target)과 표본 없는 뒤 창.
// 숫자는 2026-10-23 장부(짝 8·일치 0.75·Brier 0.25·확신도 전부 1.0, 검토 20개 중 19개 recommend, 거버너 대기 8개)를 본떴다. 모델·네트워크 없음.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-judges-'));
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); }
}

const meta = require('../src/core/evaluation/meta-eval');
const agent = require('../src/core/evaluation/agent-eval');
const store = require('../src/core/evaluation/eval-store');
const engine = require('../src/core/rsi/loop-engine');
const research = require('../src/core/rsi/research-agents');
const governor = require('../src/core/governor/governor');
const geval = require('../src/core/governor/governor-eval');

// 기준 문장 8개가 서로 다른 결정적 검사 8개에 하나씩 이어진다 — 한 대상(지문)이 짝을 여럿 낼 수 있게.
const CHECKS = [['encoding.noBom', 'AI 입력 문서는 BOM 없이 저장한다'], ['structure.lineBudget', '파일 700줄 상한을 넘기지 마라'], ['safety.secrets', '시크릿을 문서에 쓰지 마라'],
  ['structure.cycles', '순환 의존을 만들지 마라'], ['tests.offline', '바꾼 뒤 test-all을 돌린다'], ['surface.alwaysOnGrowth', '항상 로드되는 글을 늘리지 마라'],
  ['structure.layers', 'IPC 채널은 파일 경계를 따른다'], ['skills.discoverable', '스킬 description에 쓰는 때를 적는다']];
const RUBRIC = { h: { items: CHECKS.map(([, text], k) => ({ id: `r${k}`, text })) } };
// cases[i] = { det, verdict, confidence, fp }: 대상 fp(없으면 i)의 k번째 짝은 기준 r{k} ↔ 검사 CHECKS[k].
const rowsOf = (cases, { judge = agent.JUDGE_VERSION, prefix = 'f' } = {}) => {
  const by = new Map();
  cases.forEach((c, i) => { const fp = `${prefix}${c.fp ?? i}`; by.set(fp, [...(by.get(fp) || []), c]); });
  const fps = [...by.entries()];
  return {
    detRows: fps.map(([fp, cs]) => ({ fingerprint: fp, score: 1, checks: cs.map((c, k) => ({ id: CHECKS[k][0], pass: c.det })) })),
    agentRows: fps.map(([fp, cs]) => ({ fingerprint: fp, judge, score: 1, rubricHash: 'h', worker: 'local', items: cs.map((c, k) => ({ id: `r${k}`, verdict: c.verdict || 'meets', confidence: c.confidence ?? 1 })) })),
  };
};
// 2026-10-23의 짝 8: 판정자는 전부 meets·확신도 1.0, 결정적 통과 6/8.
const ledgerLike = Array.from({ length: 8 }, (_, i) => ({ det: i >= 2 }));

(async () => {
  // J1·J2 보정
  await check('J2: Brier 0.25 with a 0.75 base rate is worse than the base rate (BSS -0.33) and asks for recalibration', () => {
    const m = meta.assess({ ...rowsOf(ledgerLike), rubrics: RUBRIC });
    assert.deepStrictEqual([m.status, m.pairs, m.subjects, m.agreement, m.brier], ['measured', 8, 8, 0.75, 0.25]);
    assert.deepStrictEqual([m.calibration.baseRate, m.calibration.brierRef, m.calibration.bss], [0.75, 0.1875, -0.3333]);
    assert.deepStrictEqual(m.calibration.bins, [{ from: 0.8, to: 1, n: 8, meanP: 1, rate: 0.75 }]);
    assert.strictEqual(m.calibration.resolution, 0); // 한 칸에 몰리면 변별이 없다
    assert(m.proposals.some((p) => p.action === 'recalibrate-confidence' && /BSS -0.3333/.test(p.detail)));
  });
  await check('J2: a judge that always says the base rate is calibrated but has no skill (BSS 0)', () => {
    const cases = Array.from({ length: 8 }, (_, i) => ({ det: i >= 2, verdict: 'meets', confidence: 0.75 }));
    const m = meta.assess({ ...rowsOf(cases), rubrics: RUBRIC });
    assert.strictEqual(m.calibration.bss, 0); assert.strictEqual(m.calibration.reliability, 0);
    assert(m.proposals.some((p) => p.action === 'recalibrate-confidence'));
  });
  await check('J2: a judge whose confidence separates the cases has skill and no recalibration proposal', () => {
    const cases = Array.from({ length: 8 }, (_, i) => (i < 2 ? { det: false, verdict: 'violates', confidence: 0.9 } : { det: true, verdict: 'meets', confidence: 0.9 }));
    const m = meta.assess({ ...rowsOf(cases), rubrics: RUBRIC });
    assert(m.calibration.bss > 0.9 && m.calibration.resolution > 0);
    assert(!m.proposals.some((p) => p.action === 'recalibrate-confidence'));
  });
  await check('J1: confidences that never move carry no information; that alone is not a recalibration without wrong pairs (1.32.23)', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ fingerprint: `x${i}`, judge: agent.JUDGE_VERSION, items: Array.from({ length: 10 }, (_, k) => ({ id: `r${k}`, verdict: 'meets', confidence: 1 })) }));
    const m = meta.assess({ detRows: [], agentRows: rows, rubrics: {} });
    assert.deepStrictEqual(m.confidence, { n: 30, mean: 1, sd: 0, distinct: 1, informative: false });
    assert.strictEqual(m.status, 'insufficient-data');
    assert(!m.proposals.some((p) => p.action === 'recalibrate-confidence')); // 짝이 없으면 틀렸는지 모른다(1.32.20은 냈다)
    assert.strictEqual(meta.confidenceSpread(rows.slice(0, 1)).informative, null); // 10개로는 모른다
    // 판정이 모두 맞는 판정자의 늘 1.0은 바른 확신도다(PR #34 Codex 리뷰): 맞고 틀림을 번갈아 정확히 맞힌 24짝
    const right = meta.assess({ ...rowsOf(Array.from({ length: 24 }, (_, i) => ({ det: i % 2 === 0, verdict: i % 2 === 0 ? 'meets' : 'violates', confidence: 1 }))), rubrics: RUBRIC });
    assert.deepStrictEqual([right.status, right.agreement, right.calibration.bss, right.confidence.informative], ['measured', 1, 1, false]);
    assert(!right.proposals.some((p) => p.action === 'recalibrate-confidence'));
    // 틀린 짝이 있는데 확신도가 늘 1.0이면 낸다 — 대상이 3개뿐이라 measured가 아니어도(BSS 경로가 아닌 확신도 경로)
    const wrong = meta.assess({ ...rowsOf(Array.from({ length: 24 }, (_, i) => ({ det: i % 4 !== 0, fp: i % 3 }))), rubrics: RUBRIC });
    assert.deepStrictEqual([wrong.status, wrong.agreement, wrong.confidence.informative], ['insufficient-data', 0.75, false]);
    assert(wrong.proposals.some((p) => p.action === 'recalibrate-confidence' && /표준편차 0/.test(p.detail)));
  });
  await check('J1: the tier-2 score is no longer weighted by the judge\'s own confidence (judge-4)', () => {
    assert.strictEqual(agent.JUDGE_VERSION, 'judge-4');
    assert.strictEqual(agent.score([{ verdict: 'meets', confidence: 0.1 }, { verdict: 'violates', confidence: 1 }]), 0.5); // 가중이면 0.0909
    assert.strictEqual(agent.score([{ verdict: 'unclear', confidence: 1 }]), null);
  });

  // J3 독립 단위
  await check('J3: eight pairs from two subjects are not "measured"; the reason names the subject count', () => {
    const m = meta.assess({ ...rowsOf(ledgerLike.map((c, i) => ({ ...c, fp: i % 2 }))), rubrics: RUBRIC });
    assert.deepStrictEqual([m.pairs, m.subjects, m.status], [8, 2, 'insufficient-data']);
    assert(m.proposals.some((p) => p.action === 'collect-more-pairs' && /서로 다른 대상 2개\(최소 5\)/.test(p.detail)));
    assert(!m.proposals.some((p) => p.action === 'review-disagreement'));
  });
  await check('J3: agreement and kappa intervals resample whole subjects (seed-stable, contain the point)', () => {
    const cases = Array.from({ length: 12 }, (_, i) => ({ det: i % 3 !== 0, verdict: i % 4 === 0 ? 'violates' : 'meets', fp: Math.floor(i / 2) }));
    const a = meta.assess({ ...rowsOf(cases), rubrics: RUBRIC }), b = meta.assess({ ...rowsOf(cases), rubrics: RUBRIC });
    assert.deepStrictEqual(a.intervals, b.intervals); assert.strictEqual(a.intervals.subjects, 6);
    assert(a.intervals.agreement[0] <= a.agreement && a.agreement <= a.intervals.agreement[1]);
    assert(a.intervals.kappa[0] <= a.kappa && a.kappa <= a.intervals.kappa[1]);
    assert.strictEqual(meta.assess({ ...rowsOf([{ det: true }, { det: false }].map((c) => ({ ...c, fp: 0 }))), rubrics: RUBRIC }).intervals, null);
  });
  await check('J3: the item bootstrap of L1 is the one-item-per-cluster case of the shared bootstrap (same numbers as 1.32.19)', () => {
    const old = (ds, { alpha = 0.1, resamples = 2000, seed = 1 } = {}) => { // 1.32.19 loop-engine.lowerBound 그대로
      let t = (seed >>> 0) || 0x9e3779b9;
      const next = () => { t += 0x6d2b79f5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
      const means = new Float64Array(resamples);
      for (let r = 0; r < resamples; r++) { let s = 0; for (let k = 0; k < ds.length; k++) s += ds[Math.floor(next() * ds.length)]; means[r] = s / ds.length; }
      means.sort();
      return +means[Math.floor(alpha * resamples)].toFixed(4);
    };
    for (const [ds, seed] of [[[1, 0, 0, 1, -1, 1, 0, 1], 9], [[1, 1, 0, -1, 0, 0, 1, 1, 1, 0, -1, 1], 0x5eed], [[0.3, -0.2, 0.7], 1]]) assert.strictEqual(engine.lowerBound(ds, { seed }), old(ds, { seed }));
  });

  // J4 판정 버전
  const mixed = { detRows: [...rowsOf(ledgerLike.slice(0, 2), { judge: 'judge-2', prefix: 'a' }).detRows, ...rowsOf(ledgerLike, { prefix: 'b' }).detRows],
    agentRows: [...rowsOf(ledgerLike.slice(0, 2).map((c) => ({ ...c, verdict: 'violates' })), { judge: 'judge-2', prefix: 'a' }).agentRows, ...rowsOf(ledgerLike, { prefix: 'b' }).agentRows,
      { fingerprint: 'old', score: 1, items: [] }] };
  await check('J4: the current judge is assessed on its own rows; older versions are reported apart', () => {
    const m = meta.assessByJudge({ ...mixed, rubrics: RUBRIC });
    assert.strictEqual(m.judge, agent.JUDGE_VERSION); assert.strictEqual(m.pairs, 8); assert.strictEqual(m.agreement, 0.75);
    assert.deepStrictEqual(Object.keys(m.otherVersions).sort(), ['judge-2', 'none']);
    assert.deepStrictEqual([m.otherVersions['judge-2'].pairs, m.otherVersions['judge-2'].agreement], [2, 1]);
    assert.strictEqual(meta.assess({ ...mixed, rubrics: RUBRIC }).agreement, 0.8); // 섞으면 judge-2의 일치가 현재 판정자를 좋게 보였다
  });
  await check('J4: the trend compares meta rows of the same judge version only', async () => {
    const deps = { dataDir: path.join(scratch, 'trend') };
    for (const r of [{ judge: 'judge-3', kappa: 1, brier: 0 }, { judge: agent.JUDGE_VERSION, kappa: 0.2, brier: 0.2, bss: -0.1 }, { kappa: 0.9, brier: 0.01 }, { judge: agent.JUDGE_VERSION, kappa: 0.5, brier: 0.1, bss: 0.3 }]) {
      await store.append({ tier: 'meta', status: 'measured', ...r }, deps);
    }
    assert.deepStrictEqual(await meta.trend({}, deps), { status: 'measured', n: 2, judge: agent.JUDGE_VERSION, otherJudge: 2, kappaDelta: 0.3, brierDelta: -0.1, bssDelta: 0.4 });
  });
  await check('J4: the meta ledger row records judge, subjects and BSS', async () => {
    const deps = { dataDir: path.join(scratch, 'meta') };
    await store.append({ tier: 'deterministic', fingerprint: 'f', score: 1, checks: [{ id: 'encoding.noBom', pass: true }] }, deps);
    const r = await meta.evaluate({}, deps);
    const row = (await store.recent({ tier: 'meta' }, deps)).rows.at(-1);
    assert.deepStrictEqual([row.judge, row.version, row.subjects, row.bss], [agent.JUDGE_VERSION, meta.META_VERSION, 0, null]);
    assert.strictEqual(r.judge, agent.JUDGE_VERSION);
  });

  // J5 상수 판정자
  await check('J5: a judge that answers one way is named as the reason, not a per-check disagreement', () => {
    const m = meta.assess({ ...rowsOf(ledgerLike), rubrics: RUBRIC });
    assert.deepStrictEqual(m.judgeLean, { passRate: 1, detPassRate: 0.75, bias: 0.25, constant: 'meets' });
    assert.strictEqual(m.kappa, 0);
    assert(m.proposals.some((p) => p.action === 'judge-answers-one-way' && /모두 meets/.test(p.detail)));
    assert(!m.proposals.some((p) => p.action === 'review-disagreement'));
    const fewSubjects = meta.assess({ ...rowsOf(ledgerLike.map((c, i) => ({ ...c, fp: i % 3 }))), rubrics: RUBRIC });
    assert(fewSubjects.status === 'insufficient-data' && fewSubjects.proposals.some((p) => p.action === 'judge-answers-one-way')); // 답의 모양이라 대상 수를 기다리지 않는다
    const agreeing = meta.assess({ ...rowsOf(ledgerLike.map(() => ({ det: true }))), rubrics: RUBRIC });
    assert(!agreeing.proposals.some((p) => p.action === 'judge-answers-one-way'));
  });

  // J7 L1
  const cks = (ids) => ['surface.valid', 'skills.discoverable', 'encoding.noBom'].map((id) => ({ id, pass: !ids.includes(id), score: ids.includes(id) ? 0.4 : 1, weight: 1 }));
  const cand = (id, det, checks, agentEval = null, agentBase = null) => ({ id, patch: { [`skills/x/${id}.md`]: id }, diff: { components: ['c6-skills'], alwaysOnCharDelta: 0 },
    eval: { det: { score: det, criticalFailed: [], checks }, agent: agentEval, agentBase } });
  const base = { det: { score: 0.8, checks: cks(['skills.discoverable']) } };
  await check('J7: without judge evidence a partial deterministic gain is not adopted; a flipped check is', () => {
    const partial = cand('inv-1', 0.9, cks(['skills.discoverable']).map((c) => (c.id === 'skills.discoverable' ? { ...c, score: 0.8 } : c)));
    const r = engine.compose({ baseEval: base, candidates: [partial] });
    assert.strictEqual(r.decision, 'KEEP_BASE'); assert(r.rows[0].improvement > 0.1 && r.rows[0].lcb === 0);
    assert(/no check flipped fail → pass: partial deterministic score only/.test(r.rows[0].reason));
    assert.strictEqual(engine.compose({ baseEval: base, candidates: [cand('inv-1', 1, cks([]))] }).decision, 'ADOPT');
    const trade = cand('inv-1', 0.95, cks(['encoding.noBom']).map((c) => (c.id === 'encoding.noBom' ? { ...c, score: 0.9 } : c))); // 하나 고치고 하나 망가뜨림
    assert.strictEqual(engine.compose({ baseEval: base, candidates: [trade] }).decision, 'KEEP_BASE');
    assert.strictEqual(engine.compose({ baseEval: { det: { score: 0.8 } }, candidates: [cand('inv-1', 1, undefined)] }).rows[0].evidence, 'no-checks');
  });
  const ten = (v) => Array.from({ length: 10 }, (_, i) => ({ id: `r-${i}`, verdict: v }));
  const judged = cand('inv-1', 0.8, cks(['skills.discoverable']), { score: 1, items: ten('meets') }, { score: 0, items: ten('violates') });
  await check('J7: when proposer and judge are the same worker the judge only vetoes, and decision.json says so', () => {
    const other = engine.compose({ baseEval: base, candidates: [judged], workers: { proposer: 'codex', judgeWorker: 'local' } });
    assert.deepStrictEqual([other.decision, other.sameWorker], ['ADOPT', false]);
    const self = engine.compose({ baseEval: base, candidates: [judged], workers: { proposer: 'codex', judgeWorker: 'codex' } });
    assert.deepStrictEqual([self.decision, self.sameWorker, self.workers], ['KEEP_BASE', true, { proposer: 'codex', judgeWorker: 'codex' }]);
    assert(/judge = proposer, veto only/.test(self.rows[0].reason));
    const regress = cand('inv-1', 1, cks([]), { score: 0, items: ten('violates') }, { score: 1, items: ten('meets') });
    assert.strictEqual(engine.compose({ baseEval: base, candidates: [regress], workers: { proposer: 'codex', judgeWorker: 'codex' } }).decision, 'KEEP_BASE'); // 퇴행은 막는다
    assert.strictEqual(engine.compose({ baseEval: base, candidates: [judged] }).sameWorker, null); // 작업자를 모르면 모른다고
  });
  await check('J7: the L1 graph hands proposer and judge to Compose and the combine step', () => {
    const g = require('../src/core/rsi/triple-loop').l1Graph({ worker: 'codex', judgeWorker: 'codex', mode: 'module' });
    const args = (id) => JSON.parse(g.nodes.find((n) => n.id === id).step.argsJson);
    assert.deepStrictEqual(args('compose'), { proposer: 'codex', judgeWorker: 'codex' });
    assert.deepStrictEqual([args('combine').proposer, args('combine').judgeWorker], ['codex', 'codex']);
  });

  // J6 L3 검토와 거버너 근거 버전
  const odeps = { dataDir: path.join(scratch, 'l3'), hubVersion: '1.32.20' };
  fs.mkdirSync(path.join(odeps.dataDir, 'rsi'), { recursive: true });
  const prop = (id, origin, state, verdict, extra = {}) => ({ id, loop: 'L3', origin, title: `${origin} ${id}`, hypothesis: 'h', component: null, targets: [], evidence: ['e'],
    signals: { relevance: 0.8, evidence: 0.7, reproducibility: 0.5, novelty: 0.3, recent: 0.5, risk: 0.3, effort: 0.4 }, evalPlan: {}, payload: null, createdAt: '2026-10-22T00:00:00Z',
    state, review: verdict ? { verdict, score: 4.6, reasons: [], model: null } : null, decision: state === 'approved' || state === 'rejected' ? { decision: state, note: '', at: '2026-10-23T00:00:00Z' } : null, ...extra });
  const queue = [
    ...Array.from({ length: 6 }, (_, i) => prop(`p-meta${i}`, 'meta-eval', 'approved', 'recommend')),
    prop('p-gov-a', 'governor-eval', 'approved', 'recommend'), prop('p-gov-b', 'governor-eval', 'approved', 'recommend'),
    prop('p-sa-a', 'structure-audit', 'approved', 'recommend'), prop('p-sa-r', 'structure-audit', 'rejected', 'revise'),
    ...Array.from({ length: 8 }, (_, i) => prop(`p-gov-open${i}`, 'governor-eval', 'reviewed', 'recommend')), // 1.32.17 전 근거, 생산자 기록 없음
  ];
  fs.writeFileSync(path.join(odeps.dataDir, 'rsi', 'proposals.json'), JSON.stringify({ schemaVersion: 1, proposals: queue }));
  research.registerSource('governor-eval', async () => [{ title: '거버너 새 제안', evidence: ['x'], relevance: 0.8, evidenceStrength: 0.7 }], { producer: () => governor.RULES_VERSION });
  await check('J6: review verdicts are measured against human decisions; mostly-recommend reviews do not discriminate', async () => {
    const c = await research.calibration(odeps);
    assert.deepStrictEqual([c.decided, c.approved, c.rejected], [10, 9, 1]);
    assert.deepStrictEqual(c.reviewVsHuman, { n: 10, table: { 'recommend→approved': 9, 'revise→rejected': 1 }, agreement: 1, alwaysRecommend: 0.9 });
    assert.strictEqual(c.recommendShare, 0.9444); assert.strictEqual(c.discriminates, false);
    assert.deepStrictEqual(c.byOrigin['structure-audit'], { approved: 1, rejected: 1, open: 0, rate: 0.5 });
    assert.deepStrictEqual(c.byOrigin['governor-eval'], { approved: 2, rejected: 0, open: 8, rate: 0.75 });
    // 반려 1건뿐이면 원천별 사전이 전체 기준율보다 못할 수 있다 — 보이는 값이지 고정 규칙이 아니다.
    assert.deepStrictEqual(c.originPrior, { brierOrigin: 0.1234, brierGlobal: 0.1124, bss: -0.0975 });
    assert.strictEqual(c.staleOpen.length, 8); assert.deepStrictEqual([c.staleOpen[0].from, c.staleOpen[0].to], [null, governor.RULES_VERSION]);
  });
  await check('J6: open proposals on stale evidence go back to revise (stale-evidence) and stay for a human — never rejected', async () => {
    const r = await research.review(null, {}, odeps);
    assert.strictEqual(r.reviewed.length, 8);
    const after = await research.list({}, odeps);
    const open = after.filter((p) => p.id.startsWith('p-gov-open'));
    assert(open.every((p) => p.state === 'reviewed' && p.review.verdict === 'revise' && p.review.reasons[0].startsWith('stale-evidence')));
    assert(open.every((p) => p.review.prior.rate === 0.75));
    assert(!after.some((p) => p.state === 'rejected' && p.id !== 'p-sa-r'));
    assert.strictEqual((await research.review(null, {}, odeps)).reviewed.length, 0); // 한 번 표시하면 다시 보지 않는다
  });
  await check('J6: new proposals carry the evidence producer (Hub version, rules version) and are not stale', async () => {
    const rdeps = { ...odeps, researchReview: { read: async () => ({}), project: () => ({ selected: [] }) }, audit: { audit: async () => ({ coupled: [] }) } };
    await research.propose(rdeps);
    const p = (await research.list({ state: 'proposed' }, odeps)).find((x) => x.title === '거버너 새 제안');
    assert.deepStrictEqual(p.producer, { hub: '1.32.20', rules: governor.RULES_VERSION });
    await research.review(p.id, {}, odeps);
    const q = (await research.list({}, odeps)).find((x) => x.id === p.id);
    assert(!q.review.reasons.some((x) => x.startsWith('stale-evidence')));
  });
  await check('J6: a fresh finding from the current producer refreshes an open stale proposal; decided ones stay (1.32.23, PR #34 Codex review)', async () => {
    const rdeps = { dataDir: path.join(scratch, 'l3-refresh'), hubVersion: '1.32.23', researchReview: { read: async () => ({}), project: () => ({ selected: [] }) }, audit: { audit: async () => ({ coupled: [] }) } };
    fs.mkdirSync(path.join(rdeps.dataDir, 'rsi'), { recursive: true });
    const idOf = (title) => 'p-' + store.keyOf('jc-refresh', title).slice(0, 12);
    const old = (title, state) => ({ ...prop(idOf(title), 'jc-refresh', state, 'recommend'), title, producer: { hub: '1.32.20', rules: 'v1' }, evidence: ['old evidence'] });
    fs.writeFileSync(path.join(rdeps.dataDir, 'rsi', 'proposals.json'), JSON.stringify({ schemaVersion: 1, proposals: [old('열린 낡은 제안', 'reviewed'), old('승인된 제안', 'approved')] }));
    research.registerSource('jc-refresh', async () => ['열린 낡은 제안', '승인된 제안'].map((title) => ({ title, evidence: ['new evidence'], relevance: 0.8, evidenceStrength: 0.7 })), { producer: 'v2' });
    const r = await research.propose(rdeps);
    const list = await research.list({}, rdeps);
    const open = list.find((p) => p.title === '열린 낡은 제안'), done = list.find((p) => p.title === '승인된 제안');
    assert.deepStrictEqual([open.state, open.review, open.producer.rules, open.evidence], ['proposed', null, 'v2', ['new evidence']]); // 1.32.22는 버렸다
    assert.deepStrictEqual([done.state, done.producer.rules, done.evidence], ['approved', 'v1', ['old evidence']]);
    assert(r.ids.includes(open.id) && !r.ids.includes(done.id));
    assert(!(await research.propose(rdeps)).ids.includes(open.id)); // 갱신된 제안은 이제 낡지 않아 다시 갱신하지 않는다
  });
  await check('J6: a source humans reject more than they approve is not recommended', () => {
    const qs = [prop('a', 'tool-routes', 'rejected', 'recommend'), prop('b', 'tool-routes', 'rejected', 'recommend'), prop('c', 'tool-routes', 'approved', 'recommend')];
    assert.deepStrictEqual(research.approvalPrior(qs, 'tool-routes'), { family: 'tool-routes', approved: 1, rejected: 2, rate: 0.4 });
    assert.deepStrictEqual(research.approvalPrior(qs, 'research:upstream'), { family: 'research', approved: 0, rejected: 0, rate: 0.5 });
  });
  await check('J6: governor decisions carry the rules version; governor-eval judges only current-rule rows', async () => {
    const gdeps = { dataDir: path.join(scratch, 'gov') };
    const file = governor.ledgerFile(gdeps);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const row = (extra) => JSON.stringify({ at: old, actions: [{ type: 'release-gate', ok: true }], before: { findings: [] }, ...extra });
    fs.writeFileSync(file, [row({}), row({}), row({ rules: governor.RULES_VERSION })].join('\n') + '\n');
    const ev = await geval.evaluate({}, { ...gdeps, telemetry: { window: async () => [] } });
    assert.deepStrictEqual([ev.evaluated, ev.legacy, ev.producer], [1, 2, governor.RULES_VERSION]);
    const signals = require('../src/core/change-signals');
    signals.setGate('local-inference', Date.now() + 60000, 'test');
    await governor.tick({ ...gdeps, telemetry: { report: async () => ({ findings: [] }) }, optimizer: { slotState: () => ({ waiting: 0 }) }, gpufit: { lastRouted: () => null }, offload: { active: () => [] }, scheduler: { state: () => ({}) } });
    assert.strictEqual((await governor.decisions({}, gdeps)).at(-1).rules, governor.RULES_VERSION);
  });

  // 거버너 관문 평가: 막거나 풀어 줄 Hub 작업이 없던 관문은 효과를 판정하지 않는다(no-target), 표본 없는 뒤 창은 읽지 못한 창이다.
  await check('governor: a gate with no local work to hold is no-target, not helped; local slot or gate waiters are judged', () => {
    const gate = (before) => ({ before: { findings: ['vram_spill'], ...before }, actions: [{ type: 'gate-local-inference', ok: true }] });
    assert.deepStrictEqual(geval.judge(gate({ busy: [] }), []), { verdict: 'no-target', types: [], skipped: ['gate-local-inference'] });
    // 원격(codex·agy) offload도 busy를 올린다 — 관문은 로컬 슬롯 입장만 막으니 대상이 아니다(1.32.23, Codex 교차 리뷰)
    assert.strictEqual(geval.judge(gate({ busy: ['offload'], slotActive: 0, slotWaiting: 0, gateWaiting: 0 }), []).verdict, 'no-target');
    assert.strictEqual(geval.judge(gate({ busy: ['offload'] }), []).verdict, 'no-target'); // 1.32.22 행(slotWaiting만)
    for (const local of [{ slotActive: 1 }, { slotWaiting: 1 }, { gateWaiting: 2 }]) assert.strictEqual(geval.judge(gate({ busy: ['offload'], ...local }), []).verdict, 'helped', JSON.stringify(local));
    const release = (before) => ({ before: { findings: [], ...before }, actions: [{ type: 'release-gate', ok: true }] });
    assert.strictEqual(geval.judge(release({ busy: [] }), ['vram_spill']).verdict, 'no-target'); // 풀어 준 작업이 없는데 "악화"로 셌다
    assert.strictEqual(geval.judge(release({ busy: ['pipeline'] }), ['vram_spill']).verdict, 'no-target');
    assert.strictEqual(geval.judge(release({ busy: ['pipeline'], gateWaiting: 1 }), ['vram_spill']).verdict, 'hurt');
    const both = { before: { findings: ['paging'], busy: [] }, actions: [{ type: 'gate-local-inference', ok: true }, { type: 'unload-idle-models', ok: true, unloaded: ['m'] }] };
    assert.deepStrictEqual(geval.judge(both, []), { verdict: 'helped', types: ['unload-idle-models'] }); // 내리기는 작업과 무관하게 메모리를 비운다
  });
  await check('governor: callers waiting at the gate are counted, and decision rows record the local slot and gate waiters (1.32.23)', async () => {
    const signals = require('../src/core/change-signals');
    assert.strictEqual(await signals.waitGate('jc-gate', { maxWaitMs: 50 }), 0); // 열린 관문은 세지 않는다
    signals.setGate('jc-gate', Date.now() + 60000, 'test');
    const waiting = signals.waitGate('jc-gate', { maxWaitMs: 5000, pollMs: 20 });
    assert.strictEqual(signals.gateWaiting('jc-gate'), 1);
    signals.setGate('jc-gate', 0);
    await waiting;
    assert.strictEqual(signals.gateWaiting('jc-gate'), 0);
    const gdeps = { dataDir: path.join(scratch, 'gov3') };
    signals.setGate('local-inference', Date.now() + 60000, 'test');
    await governor.tick({ ...gdeps, telemetry: { report: async () => ({ findings: [] }) }, optimizer: { slotState: () => ({ active: 1, waiting: 2 }) }, gpufit: { lastRouted: () => null }, offload: { active: () => [] }, scheduler: { state: () => ({}) } });
    const row = (await governor.decisions({}, gdeps)).at(-1);
    assert.deepStrictEqual([row.before.slotActive, row.before.slotWaiting, row.before.gateWaiting], [1, 2, 0]);
  });
  await check('governor: no-target gates leave the effect rates; an empty after-window is unavailable, not helped', async () => {
    const gdeps = { dataDir: path.join(scratch, 'gov2') };
    const file = governor.ledgerFile(gdeps);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const at = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();
    const row = (m, before) => JSON.stringify({ at: at(m), rules: governor.RULES_VERSION, actions: [{ type: 'gate-local-inference', ok: true }], before: { findings: ['paging'], busy: [], ...before } });
    // 대상 없는 6행 중 3행은 원격 offload만 있었다(busy) — 그래도 no-target
    fs.writeFileSync(file, [...Array.from({ length: 6 }, (_, i) => row(30 + i, i % 2 ? { busy: ['offload'] } : {})), row(20, { busy: ['offload'], slotActive: 1 }), row(10, {})].join('\n') + '\n');
    const empty = Date.now() - 12 * 60 * 1000; // 이 시각 뒤 창에는 표본이 없다
    const telemetry = { window: async ({ since }) => (since > empty ? [] : [{ t: since }]) };
    const ev = await geval.evaluate({}, { ...gdeps, telemetry });
    assert.deepStrictEqual([ev.evaluated, ev.noTarget, ev.unavailable, ev.evalVersion], [8, 6, 1, geval.EVAL_VERSION]);
    assert.deepStrictEqual(ev.byType['gate-local-inference'], { n: 1, helped: 1, hurt: 0, none: 0, confounded: 0, noTarget: 6 });
    assert.deepStrictEqual(geval.proposals(ev), []); // n 1 < 5 — 대상 없는 관문 6개로 "개선" 제안을 내지 않는다
  });

  // L1 판정자 순서(1.32.22): 실행 단위로 쓸 수 있는 첫 판정자, 도중 거절이면 다음 판정자로 전부 다시, decision.json에 실제 판정자와 사유.
  const repo = path.join(scratch, 'jo-repo'), skillRoot = path.join(scratch, 'jo-skills');
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(path.join(skillRoot, 'ponytail'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# 규칙\n' + ['문서는 반드시 BOM 없이 쓴다.', '스킬 설명에는 반드시 쓰는 때를 적는다.', '비밀 값을 문서에 쓰지 않는다.',
    '공유 기록을 강제로 덮어쓰지 않는다.', '승인 없이 전역 설정을 바꾸지 않는다.', '줄바꿈은 반드시 LF로 쓴다.'].map((l) => `- ${l}\n`).join(''));
  fs.writeFileSync(path.join(skillRoot, 'ponytail', 'SKILL.md'), '# ponytail\n- 요청하지 않은 옵션을 만들지 않는다.\n');
  const SK = 'skills/dev/ponytail/SKILL.md', DESC = 'Use when writing or fixing code: choose the smallest complete change.';
  const skillText = (body) => `---\nname: ponytail\ndescription: ${DESC}\n---\n\n# ponytail\n${body}\n`;
  const judgeRun = async (refuse, { samples = 1, order = ['agy', 'local', 'codex'], dataDir = fs.mkdtempSync(path.join(scratch, 'jo-')), runId = 'jo' } = {}) => {
    const calls = [];
    const runJudge = async (req) => {
      const label = (/# 대상: 하네스 (\S+)/.exec(req.text) || [])[1];
      const nth = calls.filter((c) => c === `${req.worker}:${label}`).length; // 같은 판정자·같은 보기의 몇 번째 표본인지
      calls.push(`${req.worker}:${label}`);
      const why = refuse(req.worker, label, nth);
      if (why) return { ok: false, reason: why };
      const ids = [...req.task.matchAll(/\[(r-[0-9a-f]{10})\]/g)].map((m) => m[1]);
      return { ok: true, value: { items: ids.map((id) => ({ id, verdict: req.text.includes('BAD') ? 'violates' : 'meets', confidence: 0.9 })) } };
    };
    const jdeps = { dataDir, runJudge, sharedRepo: { repoRoot: () => repo }, bootstrap: { manifest: () => ({ skillRoot }) } };
    const dir = path.join(dataDir, 'rsi', 'runs', runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'base.json'), JSON.stringify({ scope: 'skills/dev', tree: { 'AGENTS.md': '# 지침\n', [SK]: skillText('BAD 예전 본문') }, eval: { det: { score: 1, criticalFailed: [] } } }));
    fs.writeFileSync(path.join(dir, 'inv.json'), JSON.stringify([{ id: 'inv-1', kind: 'INV', patch: { [SK]: skillText('고친 본문') }, rationale: 'r' }]));
    fs.writeFileSync(path.join(dir, 'dom.json'), JSON.stringify([{ id: 'dom-1', kind: 'DOM', patch: { [SK]: skillText('다르게 고친 본문') }, rationale: 'r' }]));
    const ops = require('../src/core/rsi/hub-operations').operations(jdeps);
    const probe = await ops['rsi.probe'].fn({ judgeOrder: order, ...(samples > 1 ? { judgeSamples: samples } : {}) }, { runId, state: {} });
    await ops['rsi.compose'].fn({ proposer: 'codex', judgeOrder: order }, { runId, state: {} });
    const decision = JSON.parse(fs.readFileSync(path.join(dir, 'decision.json'), 'utf8'));
    return { calls, probe, decision };
  };
  await check('L1 judge order: a quota refusal moves to the next judge; decision.json names the judge and the skipped reason', async () => {
    const r = await judgeRun((w) => (w === 'agy' ? 'agy_quota_exhausted' : null));
    assert.strictEqual(r.probe.judge, 'codex');
    assert.deepStrictEqual(r.decision.judge, { order: ['agy', 'codex', 'local'], used: 'codex', skipped: [{ worker: 'agy', reason: 'agy_quota_exhausted' }] });
    assert.deepStrictEqual([r.decision.sameWorker, r.decision.workers], [true, { proposer: 'codex', judgeWorker: 'codex' }]);
    // dom-1의 기준 보기는 inv-1과 같은 경로·내용이라 같은 판정자의 캐시로 돌아온다(판정자가 바뀌면 다시 잰다).
    assert.deepStrictEqual(r.calls, ['agy:cand:inv-1', 'codex:cand:inv-1', 'codex:base-view:inv-1', 'codex:cand:dom-1']);
  });
  await check('L1 judge order: a refusal mid-run re-judges every view with the next judge (never mixed); falling to the proposer means veto only', async () => {
    const r = await judgeRun((w, label) => w === 'agy' && label === 'cand:dom-1' ? 'agy_quota_exhausted' : null);
    assert.strictEqual(r.decision.judge.used, 'codex');
    assert.deepStrictEqual(r.decision.judge.skipped.map((s) => s.worker), ['agy']);
    const after = r.calls.slice(r.calls.indexOf('agy:cand:dom-1') + 1);
    assert.deepStrictEqual(after, ['codex:cand:inv-1', 'codex:base-view:inv-1', 'codex:cand:dom-1']);
    assert.strictEqual(r.decision.sameWorker, true);
    assert(r.decision.rows.every((x) => x.decision === 'dropped')); // 판정자 이득은 거부권뿐 — 바뀐 검사 없이 채택하지 않는다
  });
  await check('L1 judge order: a timeout is not "unavailable" (no switch); every judge refusing leaves the run unjudged', async () => {
    // 일시적 제한도 판정자를 바꾸지 않는다 — 사유 이름은 agent-workers(1.32.26)와 맞춘 것
    for (const why of ['timeout', 'agy_throttled', 'codex_throttled', 'http_429']) {
      const t = await judgeRun((w, label) => (w === 'agy' && label === 'cand:dom-1' ? why : null));
      assert.deepStrictEqual([why, t.decision.judge.used, t.decision.judge.skipped], [why, 'agy', []]);
    }
    for (const why of ['codex_quota_exhausted', 'codex_rate_limited', 'agy_tool_denied']) { // 소진·거부(codex_rate_limited는 1.32.22~25의 소진 이름)
      const s = await judgeRun((w) => (w === 'agy' ? why : null));
      assert.deepStrictEqual([why, s.decision.judge.used], [why, 'codex']);
    }
    const none = await judgeRun((w) => `${w === 'codex' ? 'codex_quota_exhausted' : w === 'local' ? 'local_not_viable: gpu-busy' : 'agy_tool_denied'}`);
    assert.deepStrictEqual([none.decision.judge.used, none.decision.judge.skipped.length, none.decision.sameWorker], [null, 3, null]);
    assert.strictEqual(none.decision.judge.skipped.at(-1).reason, 'cloud_quota_not_exhausted');
    assert(!none.calls.some(call => call.startsWith('local:')));
  });
  await check('L1 uses local on confirmed cloud exhaustion or an explicit local-only order', async () => {
    const exhausted = await judgeRun(w => w === 'local' ? null : w + '_quota_exhausted: limit');
    assert.strictEqual(exhausted.decision.judge.used, 'local');
    assert.deepStrictEqual(exhausted.decision.judge.skipped.map(s => s.worker), ['agy', 'codex']);
    const fixed = await judgeRun(() => null, { order: ['local'] });
    assert.strictEqual(fixed.decision.judge.used, 'local');
    assert(fixed.calls.every(call => call.startsWith('local:')));
    for (const reason of ['agy_auth', 'agy_not_installed', 'codex_quota_exhausted']) {
      const r = await judgeRun(w => w === 'agy' ? reason : 'codex_quota_exhausted');
      assert.strictEqual(r.decision.judge.used, null);
      assert(!r.calls.some(call => call.startsWith('local:')));
    }
  });
  await check('L1 retries clouds in a new run even after local fallback; a different cloud timing out cannot unlock local', async () => {
    const dataDir = fs.mkdtempSync(path.join(scratch, 'jo-reused-'));
    const first = await judgeRun(w => w === 'local' ? null : w + '_quota_exhausted', { dataDir, runId: 'both-exhausted' });
    assert.equal(first.decision.judge.used, 'local');
    const second = await judgeRun(w => w === 'agy' ? 'agy_quota_exhausted' : 'timeout', { dataDir, runId: 'codex-timeout' });
    assert.deepStrictEqual(second.decision.judge.skipped, [{ worker: 'agy', reason: 'agy_quota_exhausted' }]);
    assert(second.calls.some(c => c.startsWith('codex:')));
    assert(!second.calls.some(c => c.startsWith('local:')));
    const third = await judgeRun(() => null, { dataDir, runId: 'cloud-restored' });
    assert.equal(third.decision.judge.used, 'agy');
    assert.deepStrictEqual(third.decision.judge.skipped, []);
    assert(third.calls.length && third.calls.every(c => c.startsWith('agy:')));
  });
  await check('L1 judge order: with several judge samples one refused sample still moves the whole run to the next judge and is recorded (1.32.23)', async () => {
    // agy가 첫 보기의 첫 표본은 답하고 둘째 표본에서 할당량 거절 — 1.32.22는 성공한 표본 하나로 다수결을 내고 skipped에도 남기지 않았다
    const r = await judgeRun((w, label, nth) => (w === 'agy' && label === 'cand:inv-1' && nth === 1 ? 'agy_quota_exhausted' : null), { samples: 2 });
    assert.deepStrictEqual([r.decision.judge.used, r.decision.judge.skipped], ['codex', [{ worker: 'agy', reason: 'agy_quota_exhausted' }]]);
    assert.deepStrictEqual(r.calls.filter((c) => c.startsWith('agy:')), ['agy:cand:inv-1', 'agy:cand:inv-1']); // 거절 뒤 agy를 더 부르지 않는다
    assert(r.calls.filter((c) => c.startsWith('codex:')).length >= 4);
  });
  await check('L1 judge order: the graph passes the order to probe and compose; the saved option overrides judgeWorker', () => {
    const g = require('../src/core/rsi/triple-loop').l1Graph({ worker: 'codex', judgeWorker: 'codex', judgeOrder: ['agy', 'local', 'codex', 'agy'] });
    const args = (id) => JSON.parse(g.nodes.find((n) => n.id === id).step.argsJson);
    assert.deepStrictEqual(args('probe'), { judgeOrder: ['agy', 'codex', 'local'] });
    assert.deepStrictEqual(args('compose'), { proposer: 'codex', judgeOrder: ['agy', 'codex', 'local'] });
    const defaultProbe = require('../src/core/rsi/triple-loop').l1Graph().nodes.find(n => n.id === 'probe');
    assert.deepStrictEqual(JSON.parse(defaultProbe.step.argsJson), { judgeOrder: ['agy', 'codex', 'local'] });
    assert.deepStrictEqual(JSON.parse(require('../src/core/rsi/triple-loop').l1Graph({ worker: 'codex', judgeWorker: 'codex' }).nodes.find((n) => n.id === 'probe').step.argsJson), { judgeWorker: 'codex' });
  });

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`판정기 보정(J1~J7·거버너 관문): 통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exitCode = 1;
})();

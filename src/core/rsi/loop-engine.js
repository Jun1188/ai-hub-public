// RSI 루프의 결정 규칙(Harness² Propose–Probe–Compose를 이 Hub에 맞춘 것):
// - KEEP_BASE가 정당한 기본 답이다. 개선폭이 deltaFloor 미만이면 바꾸지 않는다.
// - 선택은 익명 별칭(A, B, …)과 시드 고정 셔플로 한다 — 제안자·작업자 이름이 선택에 새지 않게.
// - 항상 로드되는 글자가 늘면 벌점(정규화), 후보들이 서로 너무 닮으면(다양성 붕괴) 경보.
// - 반영 후 판정은 구성요소별 helped/hurt/no observed effect/confounded — 여러 개를 함께 바꿨으면 confounded.
// - 채택(acceptRule 'lcb', ScholarEvolve 식 4): 기준과 후보를 같은 판정자·같은 경로로 재서 기준표 항목끼리 짝짓고,
//   대응 부트스트랩 하한 > 0일 때만 자격. 'delta'는 1.32.10까지의 규칙(되돌리기용)이다.
// - 항목의 1/3은 시험 몫으로 봉인한다(R7): 결정에는 쓰지 않고 decision.json의 heldout으로 사람 검토에만 보인다.
// - 판정자 근거(기준 판정과 짝 minPairs 이상)가 없으면 결정적 부분 점수만으로는 채택하지 않는다: 통과·실패가 실제로 바뀐 검사가 있어야 한다.
// - 제안자와 판정자가 같은 작업자면 판정자 이득은 거부권으로만 쓴다(자기 선호 편향) — decision.json의 sameWorker.
'use strict';
const crypto = require('crypto');
const bootstrap = require('../evaluation/bootstrap');

const DEFAULT_POLICY = { deltaFloor: 0.01, detWeight: 0.6, agentWeight: 0.4, alwaysOnPenaltyPerChar: 0.00002, collapseJaccard: 0.85,
  acceptRule: 'lcb', alpha: 0.1, resamples: 2000, minPairs: 6, minSplitPairs: 12, sameWorkerVeto: true };
const DECISIVE = { meets: 1, violates: 0 };
const HELDOUT_SALT = 'rsi-heldout-1';

function lines(text) {
  return new Set(String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 2));
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 후보 패치들의 줄 단위 Jaccard 평균과 서로 다른 후보 수. */
function diversity(candidates, { collapseJaccard = DEFAULT_POLICY.collapseJaccard } = {}) {
  const sets = candidates.map((c) => lines(Object.entries(c.patch || {}).map(([k, v]) => `${k}\n${v ?? '<deleted>'}`).join('\n')));
  const sims = [];
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) sims.push(jaccard(sets[i], sets[j]));
  const keys = new Set(sets.map((s) => [...s].sort().join('\n')));
  const mean = sims.length ? sims.reduce((s, v) => s + v, 0) / sims.length : 0;
  return { n: candidates.length, nDistinct: keys.size, meanJaccard: +mean.toFixed(4),
    collapsed: candidates.length > 1 && (mean >= collapseJaccard || keys.size < Math.ceil(candidates.length / 2)) };
}

function seededShuffle(items, seed) {
  const a = items.slice();
  const next = bootstrap.rng(seed);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function combined(ev, policy = DEFAULT_POLICY) {
  if (!ev || !ev.det) return null;
  const d = ev.det.score;
  if (!Number.isFinite(ev.agent?.score)) return d; // 판정 실패는 결정적 점수만으로 — 0으로 끌어내리지 않는다
  return policy.detWeight * d + policy.agentWeight * ev.agent.score;
}

/** 두 판정에서 모두 결정적인 항목의 차이(-1|0|1). base가 null이면 기준 보기가 비었다(새 파일만) — 어길 글이 없었으니 meets로 본다. */
function pairedDiffs(candItems, baseItems) {
  const b = baseItems ? new Map(baseItems.filter((i) => i.verdict in DECISIVE).map((i) => [i.id, DECISIVE[i.verdict]])) : null;
  const out = [];
  for (const i of candItems || []) {
    if (!(i.verdict in DECISIVE)) continue;
    const v = b ? b.get(i.id) : 1;
    if (v !== undefined) out.push({ id: i.id, d: DECISIVE[i.verdict] - v });
  }
  return out;
}

/**
 * 같은 보기를 k번 판정한 결과(R8) → 항목별 다수결과 일관성(모든 표본에 나온 항목 중 판정이 전부 같은 비율).
 * 동률은 unclear — 결정적이지 않은 판정은 짝에서 빠진다.
 */
function majority(samples) {
  if (samples.length < 2) return { items: samples[0] || [], consistency: null };
  const by = new Map();
  for (const s of samples) for (const i of s) { if (!by.has(i.id)) by.set(i.id, []); by.get(i.id).push(i.verdict); }
  let same = 0, n = 0;
  const items = [];
  for (const [id, vs] of by) {
    if (vs.length === samples.length) { n++; if (vs.every((v) => v === vs[0])) same++; }
    const counts = {};
    for (const v of vs) counts[v] = (counts[v] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    items.push({ id, verdict: top.length > 1 && top[0][1] === top[1][1] ? 'unclear' : top[0][0] });
  }
  return { items, consistency: n ? +(same / n).toFixed(4) : null };
}

const heldout = (id) => crypto.createHash('sha256').update(HELDOUT_SALT + id).digest()[0] % 3 === 0;

/** 항목 재표본 부트스트랩의 평균 차이 하한(단측 1-alpha). 항목 하나가 군집 하나인 군집 부트스트랩이다. */
function lowerBound(ds, { alpha = 0.1, resamples = 2000, seed = 1 } = {}) {
  if (!ds.length) return 0;
  return bootstrap.clusterBootstrap(ds.map((d) => [d]), bootstrap.mean, { alpha, resamples, seed }).lo;
}

/**
 * 결정적 차이를 두 쪽 모두에 있는 검사로만 잰다. 기준은 diff 없이 재서 후보에만 있는 검사(surface.alwaysOnGrowth·focusedEdit,
 * 늘 통과)가 후보 점수를 올렸다 — 실행 3c96e7d9의 dom-1은 바뀐 검사 없이 +0.0555였다. 검사 목록이 없는 옛 기록은 점수 차와 flips null.
 */
function detDelta(cand, base) {
  const d = (cand?.score ?? NaN) - (base?.score ?? NaN);
  if (!Number.isFinite(d)) return null;
  if (!Array.isArray(cand.checks) || !Array.isArray(base.checks)) return { d, flips: null };
  const b = new Map(base.checks.map((c) => [c.id, c]));
  const common = cand.checks.filter((c) => b.has(c.id));
  const w = common.reduce((s, c) => s + (c.weight ?? 1), 0);
  if (!w) return { d: 0, flips: { up: [], down: [] } };
  const weighted = (side) => common.reduce((s, c) => s + (side(c).score ?? (side(c).pass ? 1 : 0)) * (c.weight ?? 1), 0) / w;
  return { d: weighted((c) => c) - weighted((c) => b.get(c.id)),
    flips: { up: common.filter((c) => c.pass && !b.get(c.id).pass).map((c) => c.id), down: common.filter((c) => !c.pass && b.get(c.id).pass).map((c) => c.id) } };
}

/** 짝이 minPairs 미만이면 판정자의 이득은 믿지 않고 퇴행만 센다. */
function agentBound(pairs, policy, seed) {
  const ds = pairs.map((p) => p.d);
  const mean = ds.length ? +(ds.reduce((s, v) => s + v, 0) / ds.length).toFixed(4) : 0;
  return { n: ds.length, mean, lcb: ds.length < policy.minPairs ? Math.min(0, mean) : lowerBound(ds, { ...policy, seed }) };
}

/**
 * 후보 하나의 개선 점추정·하한. 판정자 몫은 기준 판정이 있을 때만 — 없으면 양쪽 다 결정적 점수(D1: 1.32.10은 후보만 판정을 섞었다).
 * veto(제안자 = 판정자): 판정자 몫은 0 이하만 센다 — 판정이 퇴행을 보이면 막고, 이득은 근거로 쓰지 않는다.
 * 판정자 근거가 없으면(기준 판정 없음·짝 < minPairs·veto) 하한은 통과·실패가 바뀐 검사(올라간 것 ≥ 1, 내려간 것 0)가 있을 때만 0을 넘는다 —
 * 그 전에는 결정적 차이를 확실한 값(하한 = 점추정)으로 써서 부분 점수만 오른 후보가 채택될 수 있었다.
 */
function gain(c, baseEval, policy, seed, { veto = false } = {}) {
  const penalty = Math.max(0, c.diff?.alwaysOnCharDelta || 0) * policy.alwaysOnPenaltyPerChar;
  const det = detDelta(c.eval?.det, baseEval?.det);
  if (!det) return null;
  const dDet = det.d;
  const flips = det.flips;
  const flipped = !!flips && flips.up.length > 0 && flips.down.length === 0;
  const gate = (g, judged) => (judged || flipped ? g : { ...g, lcb: Math.min(0, g.lcb), evidence: flips ? 'no-flip' : 'no-checks' });
  const ag = c.eval.agent, ab = c.eval.agentBase;
  if (!ag?.items || !ab) return gate({ point: +(dDet - penalty).toFixed(4), lcb: +(dDet - penalty).toFixed(4), pairs: 0, heldout: null, flips }, false);
  const all = pairedDiffs(ag.items, ab.empty ? null : ab.items);
  const split = all.length >= policy.minSplitPairs;
  const val = split ? all.filter((p) => !heldout(p.id)) : all;
  const cap = (b) => (veto ? { ...b, mean: Math.min(0, b.mean), lcb: Math.min(0, b.lcb) } : b);
  const v = cap(agentBound(val, policy, seed));
  const t = split ? cap(agentBound(all.filter((p) => heldout(p.id)), policy, seed)) : null;
  const mix = (a) => +(policy.detWeight * dDet + policy.agentWeight * a - penalty).toFixed(4);
  return gate({ point: mix(v.mean), lcb: mix(v.lcb), pairs: v.n, heldout: t ? { pairs: t.n, point: mix(t.mean), lcb: mix(t.lcb) } : null, flips }, v.n >= policy.minPairs && !veto);
}

/**
 * 익명 선택. entries: [{ id, delivered, det:{score, criticalFailed[]}, agent:{score|null} }]
 * 순서: 산출물 있음 → 결정적 필수 검사 통과 → 에이전트 판정 → 결정적 점수 → 별칭.
 */
function blindSelect(entries, { seed = 1 } = {}) {
  const shuffled = seededShuffle(entries, seed).map((e, i) => ({ alias: String.fromCharCode(65 + (i % 26)) + (i >= 26 ? i : ''), entry: e }));
  const key = (x) => [x.entry.delivered ? 1 : 0, (x.entry.det?.criticalFailed || []).length === 0 ? 1 : 0,
    Number.isFinite(x.entry.agent?.score) ? x.entry.agent.score : -1, x.entry.det?.score ?? -1];
  const ranked = shuffled.slice().sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return a.alias.localeCompare(b.alias);
  });
  const top = ranked[0];
  const ok = top && top.entry.delivered && (top.entry.det?.criticalFailed || []).length === 0;
  return { order: ranked.map((r) => ({ alias: r.alias, id: r.entry.id })), winner: ok ? top.entry.id : null, reason: ok ? 'ranked' : 'no-conforming-candidate' };
}

/**
 * Compose. base/candidates의 평가(det·agent)와 diff 요약을 받아 KEEP_BASE | ADOPT | MERGE를 정한다.
 * candidates: [{ id, patch, diff:{components, alwaysOnCharDelta}, eval:{det, agent} }]
 */
function compose({ baseEval, candidates, policy: p = {}, seed = 1, workers = null }) {
  const policy = { ...DEFAULT_POLICY, ...p };
  // 작업자를 모르면(1.32.19까지 저장된 그래프) null — 같은지 모른다고 남긴다.
  const sameWorker = workers?.proposer && workers?.judgeWorker ? workers.proposer === workers.judgeWorker : null;
  const veto = sameWorker === true && policy.sameWorkerVeto;
  const tag = { sameWorker, ...(workers ? { workers } : {}) };
  const baseScore = combined(baseEval, policy);
  const rows = [];
  const scored = [];
  for (const c of candidates) {
    const critical = c.eval?.det?.criticalFailed || [];
    if (critical.length) { rows.push({ candidate: c.id, decision: 'dropped', reason: `critical: ${critical.join(', ')}`, improvement: null }); continue; }
    if (c.eval?.health && !c.eval.health.ok) { rows.push({ candidate: c.id, decision: 'dropped', reason: `health: ${c.eval.health.failures.slice(0, 3).join('; ')}`, improvement: null }); continue; }
    if (policy.acceptRule === 'delta') {
      const s = combined(c.eval, policy);
      const penalty = Math.max(0, c.diff?.alwaysOnCharDelta || 0) * policy.alwaysOnPenaltyPerChar;
      const improvement = s == null || baseScore == null ? null : +(s - penalty - baseScore).toFixed(4);
      if (improvement == null || improvement < policy.deltaFloor) { rows.push({ candidate: c.id, decision: 'dropped', reason: `improvement ${improvement} < ${policy.deltaFloor}`, improvement }); continue; }
      scored.push({ ...c, improvement });
      continue;
    }
    const g = gain(c, baseEval, policy, seed, { veto });
    const cons = [c.eval?.agent?.consistency, c.eval?.agentBase?.consistency].filter(Number.isFinite); // R8: 둘 중 낮은 쪽
    const extra = g ? { lcb: g.lcb, pairs: g.pairs, heldout: g.heldout, flips: g.flips, ...(g.evidence ? { evidence: g.evidence } : {}), ...(cons.length ? { consistency: Math.min(...cons) } : {}) } : {};
    // 하한 > 0(식 4)에 더해 점추정도 deltaFloor 이상이어야 한다 — KEEP_BASE가 기본 답이라는 기존 규칙은 그대로.
    if (!g || g.lcb <= 0 || g.point < policy.deltaFloor) {
      const why = g?.evidence ? `; no judge evidence (${veto ? 'judge = proposer, veto only' : `pairs ${g.pairs} < ${policy.minPairs}`}) and ${g.evidence === 'no-flip' ? 'no check flipped fail → pass' : 'no check results'}: partial deterministic score only` : '';
      rows.push({ candidate: c.id, decision: 'dropped', reason: g ? `lcb ${g.lcb} (point ${g.point}, pairs ${g.pairs}) needs lcb > 0 and point ≥ ${policy.deltaFloor}${why}` : 'no score', improvement: g ? g.point : null, ...extra });
      continue;
    }
    scored.push({ ...c, improvement: g.point, ...extra });
  }
  const div = diversity(candidates, policy);
  if (!scored.length) return { decision: 'KEEP_BASE', chosen: null, baseScore, rows, diversity: div, ...tag };
  const pick = blindSelect(scored.map((c) => ({ id: c.id, delivered: true, det: c.eval.det, agent: { score: c.improvement } })), { seed });
  const best = scored.find((c) => c.id === pick.winner) || scored[0];
  const others = scored.filter((c) => c.id !== best.id);
  // 서로 다른 구성요소를 고친 두 후보가 모두 개선이면 합칠 수 있다 — 단, 합친 결과는 다시 재야 한다.
  const partner = others.find((o) => !(o.diff?.components || []).some((x) => (best.diff?.components || []).includes(x)));
  for (const c of scored) rows.push({ candidate: c.id, decision: c.id === best.id || (partner && c.id === partner.id) ? 'kept' : 'dropped', reason: c.id === best.id ? 'best' : partner && c.id === partner.id ? 'merge-partner' : 'lower', improvement: c.improvement, lcb: c.lcb, pairs: c.pairs, heldout: c.heldout, flips: c.flips, consistency: c.consistency });
  if (partner) return { decision: 'MERGE', chosen: [best.id, partner.id], patch: { ...partner.patch, ...best.patch }, needsProbe: true, baseScore, rows, diversity: div, selection: pick, ...tag };
  return { decision: 'ADOPT', chosen: [best.id], patch: best.patch, needsProbe: false, baseScore, rows, diversity: div, selection: pick, ...tag };
}

/**
 * 반영 전·후 평가로 구성요소별 판정. 채택됐다는 사실은 도움이 됐다는 증거가 아니다.
 * delta를 주면(Compose의 대응 점추정) 그것을 쓴다 — before·after를 섞어 재면 판정자 몫이 한쪽에만 들어간다(D1).
 */
function reflect({ before, after, diff, delta: given, noise = 0.005 }) {
  const comps = diff?.components || [];
  const delta = Number.isFinite(given) ? given : (combined(after) ?? 0) - (combined(before) ?? 0);
  const verdict = comps.length > 1 ? 'confounded' : Math.abs(delta) <= noise ? 'no observed effect' : delta > 0 ? 'helped' : 'hurt';
  return comps.map((component) => ({ component, verdict, delta: +delta.toFixed(4) }));
}

/** 예산 장부: 실제 소비가 계획(R 롤아웃, P 제안 세션)과 맞지 않으면 실행 기록이 틀린 것이다. */
function assertBudget(ledger, { rollouts, proposals }) {
  const errors = [];
  if (rollouts != null && ledger.rollouts !== rollouts) errors.push(`rollouts ${ledger.rollouts} != planned ${rollouts}`);
  if (proposals != null && ledger.proposals !== proposals) errors.push(`proposals ${ledger.proposals} != planned ${proposals}`);
  if (errors.length) throw new Error('budget identity: ' + errors.join('; '));
  return true;
}

module.exports = { DEFAULT_POLICY, diversity, jaccard, seededShuffle, blindSelect, compose, reflect, combined, assertBudget, pairedDiffs, lowerBound, heldout, majority, gain, detDelta };

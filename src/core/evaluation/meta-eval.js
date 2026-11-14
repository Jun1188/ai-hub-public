// 평가 3계층: 두 평가 체계(1 결정적, 2 에이전트)를 평가한다. 같은 대상 지문에 대한 두 판정을 맞대어
// 일치도(kappa)·보정(Brier)·반복 안정성·판정 실패율·기준 포괄률·정보 없는 검사를 재고,
// 평가기 개선 제안을 낸다(RSI 2번 루프의 입력). 표본이 적으면 스스로 "판단 불가"라고 말한다.
// 판정자가 적은 확신도는 측정값이 아니라 판정자가 쓴 글이다 — 결정적 결과를 라벨로 기준율 대비 기술(BSS)·구간표(신뢰도·변별)를
// 재고, 확신도가 흩어지지 않으면(실측 judge-3: 결정 답 43개 전부 1.0) "정보 없음"이라고 말한다. 보정은 집합의 성질이다.
// 현재 판정 버전의 행만 현재 판정자를 평가한다(다른 버전은 따로 보고) — 버전을 섞으면 judge-2의 일치가 judge-3의 불일치를 가렸다.
'use strict';
const store = require('./eval-store');
const { clusterBootstrap } = require('./bootstrap');

const META_VERSION = 'meta-3'; // 지표·제안 조건을 바꾸면 올린다 — 이 판단에서 나온 L3 제안의 근거 생산자 버전. meta-3: 확신도 정보 없음은 틀린 짝이 있을 때만 재보정
const MIN_PAIRS = 5;
// 독립 단위는 대상(지문)이다. 짝 8개가 대상 4개(그중 하나가 4짝)에서 나온 것을 "measured"라고 했다(2026-10-23).
const MIN_SUBJECTS = 5;
// 확신도가 정보를 담는지: 결정 답이 이만큼 있을 때 표준편차가 구간표 한 칸(0.2)의 1/4보다 작으면 거의 다 한 칸에 몰린다.
const MIN_CONFIDENCES = 20, CONFIDENCE_SD_FLOOR = 0.05, BINS = 5;
// 기준 문장 ↔ 결정적 검사 연결. 연결이 없는 기준은 결정적 검사로 옮길 후보다.
// 낱말 하나로 잇지 않는다 — "토큰 예산"이 시크릿 검사에, "700 중 446토큰"이 700줄 검사에, "skill"이 든 모든 문장이
// description 검사에 붙어 뜻이 다른 짝이 kappa를 흔들었다(2026-10-23).
const HINTS = [
  { check: 'structure.lineBudget', re: /700줄|줄 상한|line budget/i },
  { check: 'structure.cycles', re: /순환|cycle|circular/i },
  { check: 'structure.duplication', re: /코드 중복|중복 코드|duplicat|재사용|reuse/i },
  { check: 'structure.layers', re: /IPC 채널|계층|layer|파일 경계|모듈 경계/i },
  { check: 'safety.secrets', re: /시크릿|secret|자격증명|credential|API 키|authToken|마스킹|mask/i },
  { check: 'safety.scripts', re: /자동(으로)? 반영|auto.?apply|자동 적용/i },
  { check: 'encoding.noBom', re: /BOM/i },
  { check: 'surface.alwaysOnGrowth', re: /항상 로드|always-on|컨텍스트 예산|context budget/i },
  { check: 'skills.discoverable', re: /description|트리거|trigger|discoverab/i },
  { check: 'tests.offline', re: /test-all|오프라인 테스트|테스트 실패/i },
];

function mappedChecks(text) { return HINTS.filter((h) => h.re.test(text)).map((h) => h.check); }

function latestBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) m.set(keyFn(r), r);
  return m;
}

function kappa(pairs) {
  if (!pairs.length) return null;
  const n = pairs.length;
  const po = pairs.filter((p) => p.det === p.agent).length / n;
  const pd = pairs.filter((p) => p.det).length / n, pa = pairs.filter((p) => p.agent).length / n;
  const pe = pd * pa + (1 - pd) * (1 - pa);
  return pe >= 1 ? (po === 1 ? 1 : 0) : +((po - pe) / (1 - pe)).toFixed(4);
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx && syy ? +(sxy / Math.sqrt(sxx * syy)).toFixed(4) : null;
}

const r4 = (v) => (Number.isFinite(v) ? +v.toFixed(4) : null);
const avg = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

/**
 * 결정적 통과를 라벨로 한 판정자 확률(p = meets면 확신도, violates면 1-확신도)의 보정·변별.
 * 기준 Brier = 늘 기준율을 말하는 판정자의 Brier(기준율·(1-기준율)) — 이보다 못하면 BSS ≤ 0, 확신도를 믿을 이유가 없다.
 * 구간표의 신뢰도(작을수록 좋음)·변별(클수록 좋음)·불확실성은 Murphy 분해다(구간 안 p가 같으면 Brier = 신뢰도 - 변별 + 불확실성).
 */
function calibration(pairs) {
  if (!pairs.length) return null;
  const n = pairs.length, y = (p) => (p.det ? 1 : 0);
  const base = avg(pairs.map(y)), ref = base * (1 - base);
  const brier = avg(pairs.map((p) => (p.p - y(p)) ** 2));
  const bins = [];
  for (const p of pairs) { const k = Math.min(BINS - 1, Math.floor(p.p * BINS)); (bins[k] = bins[k] || []).push(p); }
  const table = bins.map((b, k) => b && { from: k / BINS, to: (k + 1) / BINS, n: b.length, meanP: avg(b.map((x) => x.p)), rate: avg(b.map(y)) }).filter(Boolean);
  return { baseRate: r4(base), brierRef: r4(ref), bss: ref > 0 ? r4(1 - brier / ref) : null,
    reliability: r4(table.reduce((s, b) => s + b.n * (b.meanP - b.rate) ** 2, 0) / n), resolution: r4(table.reduce((s, b) => s + b.n * (b.rate - base) ** 2, 0) / n),
    bins: table.map((b) => ({ ...b, meanP: r4(b.meanP), rate: r4(b.rate) })) };
}

/** 판정자가 적은 확신도의 퍼짐(결정 답 전부, 짝이 아니어도). n이 모자라면 informative는 null — 모른다. */
function confidenceSpread(agentRows) {
  const cs = agentRows.filter((a) => !a.judgeFailed).flatMap((a) => (a.items || []).filter((i) => i.verdict === 'meets' || i.verdict === 'violates').map((i) => i.confidence)).filter(Number.isFinite);
  if (!cs.length) return { n: 0, mean: null, sd: null, distinct: 0, informative: null };
  const m = avg(cs), sd = cs.length > 1 ? Math.sqrt(cs.reduce((s, v) => s + (v - m) ** 2, 0) / (cs.length - 1)) : 0;
  return { n: cs.length, mean: r4(m), sd: r4(sd), distinct: new Set(cs).size, informative: cs.length >= MIN_CONFIDENCES ? sd >= CONFIDENCE_SD_FLOOR : null };
}

/** 대응 짝에서 판정자가 기우는 쪽: 판정자 통과율 - 결정적 통과율(편향), 짝 2개 이상에서 한 가지만 답했으면 그 답(상수 판정자 → kappa 0). */
function judgeLean(pairs) {
  if (!pairs.length) return null;
  const pa = avg(pairs.map((p) => (p.agent ? 1 : 0))), pd = avg(pairs.map((p) => (p.det ? 1 : 0)));
  const answers = new Set(pairs.map((p) => p.agent));
  return { passRate: r4(pa), detPassRate: r4(pd), bias: r4(pa - pd), constant: pairs.length > 1 && answers.size === 1 ? (pairs[0].agent ? 'meets' : 'violates') : null };
}

/** 대상 단위 군집 부트스트랩 90% 구간. 대상이 하나면 구간이 없다. */
function intervals(pairs) {
  const by = new Map();
  for (const p of pairs) by.set(p.fp, [...(by.get(p.fp) || []), p]);
  if (by.size < 2) return null;
  const groups = [...by.values()], opts = { alpha: 0.05, resamples: 2000, seed: 1 };
  const agree = clusterBootstrap(groups, (ps) => ps.filter((p) => p.det === p.agent).length / ps.length, opts);
  const k = clusterBootstrap(groups, (ps) => kappa(ps), opts);
  return { subjects: by.size, agreement: [agree.lo, agree.hi], kappa: [k.lo, k.hi] };
}

/** 순수 계산 — 장부 행과 기준표만으로 결과가 정해진다(시험 가능). */
function assess({ detRows, agentRows, rubrics }) {
  const det = latestBy(detRows, (r) => r.fingerprint);
  const pairs = [];
  const overall = { det: [], agent: [] };
  const covered = new Set();
  const allItems = new Map();
  for (const rub of Object.values(rubrics)) for (const it of rub.items || []) allItems.set(it.id, it);
  for (const a of agentRows) {
    if (a.judgeFailed) continue;
    const d = det.get(a.fingerprint);
    if (!d) continue;
    if (Number.isFinite(a.score) && Number.isFinite(d.score)) { overall.det.push(d.score); overall.agent.push(a.score); }
    const checks = new Map((d.checks || []).map((c) => [c.id, c.pass]));
    for (const it of a.items || []) {
      const rub = allItems.get(it.id);
      if (!rub) continue;
      for (const cid of mappedChecks(rub.text)) {
        if (!checks.has(cid)) continue;
        covered.add(it.id);
        if (it.verdict !== 'meets' && it.verdict !== 'violates') continue; // unclear·not-applicable은 판정이 아니다
        const agentPass = it.verdict === 'meets';
        pairs.push({ item: it.id, check: cid, det: checks.get(cid), agent: agentPass, fp: a.fingerprint, p: agentPass ? it.confidence : 1 - it.confidence });
      }
    }
  }
  // 반복 안정성: 같은 지문·기준표를 여러 표본으로 판정했을 때 점수 표준편차.
  const groups = new Map();
  for (const a of agentRows) {
    if (!Number.isFinite(a.score)) continue;
    const k = `${a.fingerprint}|${a.rubricHash}|${a.worker}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a.score);
  }
  const sds = [...groups.values()].filter((g) => g.length > 1).map((g) => {
    const m = g.reduce((s, v) => s + v, 0) / g.length;
    return Math.sqrt(g.reduce((s, v) => s + (v - m) ** 2, 0) / (g.length - 1));
  });
  // 정보 없는 결정적 검사: 서로 다른 대상 5개 이상에서 결과가 한 번도 바뀌지 않았다.
  const outcomes = {};
  for (const d of det.values()) for (const c of d.checks || []) (outcomes[c.id] = outcomes[c.id] || []).push(c.pass);
  const lowInformation = Object.entries(outcomes).filter(([, v]) => v.length >= 5 && new Set(v).size === 1).map(([id, v]) => ({ id, always: v[0] ? 'pass' : 'fail', n: v.length }));
  const disagreements = {};
  for (const p of pairs) if (p.det !== p.agent) disagreements[p.check] = (disagreements[p.check] || 0) + 1;

  const agreement = pairs.length ? +(pairs.filter((p) => p.det === p.agent).length / pairs.length).toFixed(4) : null;
  const subjects = new Set(pairs.map((p) => p.fp)).size;
  const result = {
    pairs: pairs.length, subjects,
    status: pairs.length >= MIN_PAIRS && subjects >= MIN_SUBJECTS ? 'measured' : 'insufficient-data',
    agreement, kappa: kappa(pairs),
    brier: pairs.length ? r4(avg(pairs.map((p) => (p.p - (p.det ? 1 : 0)) ** 2))) : null,
    calibration: calibration(pairs), confidence: confidenceSpread(agentRows), judgeLean: judgeLean(pairs), intervals: intervals(pairs),
    scoreCorrelation: pearson(overall.det, overall.agent),
    stabilitySd: sds.length ? +(sds.reduce((s, v) => s + v, 0) / sds.length).toFixed(4) : null,
    judgeFailureRate: agentRows.length ? +(agentRows.filter((a) => a.judgeFailed).length / agentRows.length).toFixed(4) : null,
    rubricCoverage: allItems.size ? +(covered.size / allItems.size).toFixed(4) : null,
    uncoveredRubric: [...allItems.values()].filter((i) => !covered.has(i.id)).slice(0, 12).map((i) => ({ id: i.id, text: i.text.slice(0, 160) })),
    lowInformation, disagreements,
  };
  result.proposals = proposals(result);
  return result;
}

function proposals(m) {
  const out = [];
  if (m.status !== 'measured') out.push({ target: 'meta', action: 'collect-more-pairs', detail: `대응 판정 ${m.pairs}개(최소 ${MIN_PAIRS}) · 서로 다른 대상 ${m.subjects}개(최소 ${MIN_SUBJECTS}): 다른 대상을 두 계층으로 더 평가해야 결론을 낼 수 있다` });
  if (m.judgeFailureRate != null && m.judgeFailureRate > 0.2) out.push({ target: 'agent', action: 'change-worker-or-schema', detail: `판정 실패율 ${m.judgeFailureRate}` });
  const lean = m.judgeLean;
  // 판정자가 한 가지만 답하면 kappa 0은 "엇갈림"이 아니라 변별이 없다는 뜻이다 — 검사별 엇갈림을 보라는 제안은 원인을 놓친다.
  // 추정이 아니라 답의 모양이라 대상 수 하한을 기다리지 않는다(짝 수 하한과 틀린 짝 하나 이상만).
  if (lean?.constant && m.pairs >= MIN_PAIRS && m.agreement < 1) {
    out.push({ target: 'agent', action: 'judge-answers-one-way', detail: `대응 짝 ${m.pairs}개(대상 ${m.subjects})에서 판정자는 모두 ${lean.constant} · 결정적 통과율 ${lean.detPassRate} · 편향 ${lean.bias} — kappa ${m.kappa}의 원인은 판정자가 다른 답을 하지 않은 것이다` });
  } else if (m.kappa != null && m.status === 'measured' && m.kappa < 0.4) {
    const worst = Object.entries(m.disagreements).sort((a, b) => b[1] - a[1])[0];
    out.push({ target: worst ? 'agent' : 'deterministic', action: 'review-disagreement', detail: `kappa ${m.kappa}; 가장 많이 엇갈린 검사 ${worst ? worst[0] : '-'}` });
  }
  // brier > 0.25는 늘 0.5라고 말하는 판정자만 걸렀다 — 기준율 0.75에서 Brier 0.25(BSS -0.33)인 판정자가 통과했다(2026-10-23).
  const bss = m.calibration?.bss;
  // 확신도가 늘 같다는 것만으로는 재보정할 이유가 아니다 — 판정이 모두 맞으면 늘 1.0이 바른 확신도다(PR #34 Codex 리뷰).
  // 짝 수 하한을 채우고 실제 일치율이 판정자가 적은 평균 확신도보다 낮을 때(틀린 짝이 있는데 확신도가 그것을 말하지 않음)만 낸다.
  const flat = m.confidence?.informative === false && m.pairs >= MIN_PAIRS && m.agreement != null && m.agreement < (m.confidence.mean ?? 1);
  if ((m.status === 'measured' && bss != null && bss <= 0) || flat) {
    out.push({ target: 'agent', action: 'recalibrate-confidence', detail: `BSS ${bss ?? '-'} (Brier ${m.brier ?? '-'}, 기준율 Brier ${m.calibration?.brierRef ?? '-'}) · 확신도 표준편차 ${m.confidence?.sd ?? '-'} (결정 답 ${m.confidence?.n ?? 0}, 서로 다른 값 ${m.confidence?.distinct ?? 0})` });
  }
  if (m.stabilitySd != null && m.stabilitySd > 0.15) out.push({ target: 'agent', action: 'increase-samples-or-lower-temperature', detail: `반복 표준편차 ${m.stabilitySd}` });
  for (const c of m.lowInformation) out.push({ target: 'deterministic', action: 'tighten-or-retire-check', detail: `${c.id}: ${c.n}개 대상에서 항상 ${c.always}` });
  for (const r of m.uncoveredRubric.slice(0, 3)) out.push({ target: 'deterministic', action: 'add-check-for-rubric', detail: `${r.id}: ${r.text}` });
  return out;
}

const currentJudge = () => require('./agent-eval').JUDGE_VERSION;

/** 현재 판정 버전의 행으로 현재 판정자를 평가하고, 다른 버전(판정 버전 없는 옛 행은 'none')은 요약만 따로 낸다. */
function assessByJudge({ detRows, agentRows, rubrics, judge = currentJudge() }) {
  const by = new Map();
  for (const a of agentRows) { const v = a.judge || 'none'; by.set(v, [...(by.get(v) || []), a]); }
  const otherVersions = {};
  for (const [v, rows] of by) {
    if (v === judge) continue;
    const m = assess({ detRows, agentRows: rows, rubrics });
    otherVersions[v] = { rows: rows.length, pairs: m.pairs, subjects: m.subjects, status: m.status, agreement: m.agreement, kappa: m.kappa, brier: m.brier, bss: m.calibration?.bss ?? null };
  }
  return { judge, ...assess({ detRows, agentRows: by.get(judge) || [], rubrics }), otherVersions };
}

async function evaluate({ limit = 1000 } = {}, deps = {}) {
  const det = await store.recent({ limit, tier: 'deterministic' }, deps);
  const agent = await store.recent({ limit, tier: 'agent' }, deps);
  const rubrics = {};
  for (const h of new Set(agent.rows.map((r) => r.rubricHash).filter(Boolean))) {
    const r = await store.cacheGet('rubric-' + h, deps);
    if (r) rubrics[h] = r;
  }
  const result = { tier: 'meta', version: META_VERSION, ...assessByJudge({ detRows: det.rows, agentRows: agent.rows, rubrics }), corruptRows: det.corrupt + agent.corrupt };
  await store.append({ tier: 'meta', version: META_VERSION, judge: result.judge, status: result.status, pairs: result.pairs, subjects: result.subjects, kappa: result.kappa, brier: result.brier,
    bss: result.calibration?.bss ?? null, confidenceSd: result.confidence.sd, judgeFailureRate: result.judgeFailureRate, proposals: result.proposals.length }, deps);
  await store.cachePut('meta-latest', result, deps); // 3번 루프 제안자가 평가기 개선안을 읽는 곳
  return result;
}

/**
 * 메타 평가의 추세: 최근 meta 행으로 kappa·Brier가 좋아지는지 본다(2번 루프의 수렴 판정).
 * 같은 판정 버전의 행끼리만 비교한다 — 판정자를 바꾼 것을 판정자가 나아진 것으로 읽지 않게. 판정 버전 없는 옛 행은 비교하지 않는다.
 */
async function trend({ limit = 20 } = {}, deps = {}) {
  const { rows } = await store.recent({ limit, tier: 'meta' }, deps);
  const judge = currentJudge();
  const all = rows.filter((r) => r.status === 'measured');
  const measured = all.filter((r) => r.judge === judge);
  const otherJudge = all.length - measured.length;
  if (measured.length < 2) return { status: 'insufficient-data', n: measured.length, judge, otherJudge };
  const first = measured[0], last = measured[measured.length - 1];
  const delta = (k) => (Number.isFinite(first[k]) && Number.isFinite(last[k]) ? +(last[k] - first[k]).toFixed(4) : null);
  return { status: 'measured', n: measured.length, judge, otherJudge, kappaDelta: +((last.kappa ?? 0) - (first.kappa ?? 0)).toFixed(4), brierDelta: +((last.brier ?? 0) - (first.brier ?? 0)).toFixed(4), bssDelta: delta('bss') };
}

/** 이 메타 판단에서 나온 L3 제안의 근거 생산자: 판정 버전과 메타 지표 버전. */
const producer = () => `${currentJudge()}/${META_VERSION}`;

module.exports = { evaluate, assess, assessByJudge, trend, kappa, pearson, mappedChecks, calibration, confidenceSpread, judgeLean, producer, HINTS, MIN_PAIRS, MIN_SUBJECTS, META_VERSION };

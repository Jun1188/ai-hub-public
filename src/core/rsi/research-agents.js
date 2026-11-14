// RSI 3번 루프(메타 자가개선): 제안 에이전트 → 검토 에이전트 → 사람 승인.
// 제안 원천: 연구 검토 큐(정기 수집된 논문·자료·오픈소스의 선택 가설), 메타 평가의 평가기 개선안,
// 구조 감사, 그리고 다른 모듈이 등록한 원천(도구 경로 표·거버너 평가 등).
// 승인은 작업 지시서(Markdown)를 남길 뿐 코드를 바꾸지 않는다(프로젝트 규칙 10 — 자동 반영 금지).
// 검토는 사람 결정(승인·반려)을 라벨로 잰다: 원천별 승인 기준율(베타(1,1) 사전)을 쓰고, 검토 결론과 사람 결정의 일치를 보인다.
// 검토 점수(우선순위)는 원천 기본값으로 만든 수라 확률이 아니다 — 검토 20개 중 19개가 recommend였다(2026-10-23).
// 제안에는 근거 생산자 버전(Hub·탐지 규칙)을 남기고, 생산자가 바뀐 뒤의 열린 제안은 revise(stale-evidence)로 돌린다 — 반려는 사람이 한다.
'use strict';
const path = require('path');
const store = require('../evaluation/eval-store');
const { writeAtomic, readJson } = require('../atomic-file');

const MAX_PROPOSALS = 300;
const STATES = ['proposed', 'reviewed', 'approved', 'rejected'];
// 사람이 설계해야 하는 곳: 수명주기·보안·공유 저장 경계. 제안은 받되 "revise"로 돌려 사람이 설계하게 한다.
const FROZEN = [/^package(-lock)?\.json$/, /^electron\/(main\.js|preload\.cjs)$/, /^ui\/index\.html$/, /^src\/core\/(config|share|credential-[\w-]+|secret-scrub|prompt-safety)\.js$/];
const sources = new Map();

function fileOf(deps = {}) { return path.join(deps.dataDir || require('../paths').hubDataDir(), 'rsi', 'proposals.json'); }

async function load(deps) {
  const v = await readJson(fileOf(deps), { schemaVersion: 1, proposals: [] }); // 읽기 실패는 던진다(규칙 6)
  if (v.schemaVersion !== 1 || !Array.isArray(v.proposals)) throw new Error('proposals.json 형식이 다릅니다');
  return v;
}

async function save(v, deps) {
  const open = v.proposals.filter((p) => p.state === 'proposed' || p.state === 'reviewed');
  const closed = v.proposals.filter((p) => !open.includes(p)).slice(-Math.max(0, MAX_PROPOSALS - open.length));
  await writeAtomic(fileOf(deps), JSON.stringify({ schemaVersion: 1, proposals: [...closed, ...open] }, null, 1));
}

/**
 * 다른 모듈이 제안 원천을 등록한다: async () => [{ origin, title, hypothesis, component, evidence, ... }].
 * producer: 그 원천이 근거를 만드는 규칙의 현재 버전(문자열 또는 그것을 돌려주는 함수). 주면 제안에 찍히고, 바뀌면 열린 제안이 낡은 근거가 된다.
 */
function registerSource(name, fn, { producer = null } = {}) { sources.set(name, { fn, producer }); }

const familyOf = (origin) => String(origin || '').split(':')[0];
const hubVersion = (deps = {}) => deps.hubVersion || require('../../../package.json').version;

/** 이 원천의 현재 근거 생산자 버전. 선언하지 않은 원천은 null — 낡았는지 판단하지 않는다. */
function producerOf(origin) {
  if (origin === 'meta-eval') return require('../evaluation/meta-eval').producer();
  const p = sources.get(origin)?.producer;
  return typeof p === 'function' ? p() : p || null;
}

/** 열린 제안의 근거가 지금 생산자와 다른 규칙으로 만들어졌으면 { from, to }. 생산자 기록이 없는 옛 제안은 from null(확인할 수 없음). */
function staleness(p) {
  const to = producerOf(p.origin);
  return to && p.producer?.rules !== to ? { from: p.producer?.rules || null, to } : null;
}

function normalize(raw, origin, deps = {}) {
  const title = String(raw.title || '').trim().slice(0, 200);
  if (!title) return null;
  const id = 'p-' + store.keyOf(origin, title).slice(0, 12);
  return {
    id, loop: raw.loop || 'L3', origin, title, hypothesis: String(raw.hypothesis || '').slice(0, 1200), component: raw.component || null,
    producer: { hub: hubVersion(deps), ...(raw.producer ? { rules: String(raw.producer).slice(0, 80) } : {}) },
    targets: (raw.targets || []).slice(0, 20), evidence: (raw.evidence || []).slice(0, 10).map((e) => String(e).slice(0, 300)),
    signals: { relevance: raw.relevance ?? 0.5, evidence: raw.evidenceStrength ?? (raw.evidence?.length ? 0.6 : 0.1), reproducibility: raw.reproducibility ?? 0.5,
      novelty: raw.novelty ?? 0.3, recent: raw.recent ?? 0.5, risk: raw.risk ?? 0.3, effort: raw.effort ?? 0.4 },
    evalPlan: raw.evalPlan || { deterministic: ['structure.*', 'tests.offline'], agent: 'project-rules' },
    // 승인 때 적용할 설정 편집(코드 아님 — 예: 도구 경로 표). 4 KiB 넘으면 버린다.
    payload: raw.payload && Buffer.byteLength(JSON.stringify(raw.payload)) <= 4096 ? raw.payload : null,
    createdAt: new Date().toISOString(), state: 'proposed', review: null, decision: null,
  };
}

async function builtinSources(deps) {
  const out = [];
  try {
    const rr = deps.researchReview || require('../research-review');
    const brief = rr.project(await rr.read(deps.researchDeps || {}));
    for (const s of brief.selected || []) out.push({ origin: `research:${s.origin || 'research'}`, title: s.title, component: s.component,
      hypothesis: `연구 검토 큐에서 선택된 가설 ${s.hypothesisId || ''} (${s.kind || ''}, ${s.status || 'unmeasured'})`,
      evidence: [s.hypothesisId ? `hypothesis ${s.hypothesisId}` : 'research-review'], recent: 0.8, novelty: 0.6, reproducibility: s.measured ? 0.8 : 0.3 });
  } catch (e) { out.push({ origin: 'research:unavailable', title: null, error: String(e.message || e) }); }
  const meta = await store.cacheGet('meta-latest', deps);
  // 생산자는 그 메타 결과를 만든 판정·지표 버전이다(지금 버전이 아니다) — 옛 meta-latest에서 나온 제안은 바로 낡은 근거로 보인다.
  const metaProducer = meta?.judge && meta?.version ? `${meta.judge}/${meta.version}` : null;
  for (const p of meta?.proposals || []) out.push({ origin: 'meta-eval', loop: 'L2', title: `[평가기·${p.target}] ${p.action}`, hypothesis: p.detail, producer: metaProducer,
    component: 'evaluation', evidence: [`meta-eval kappa ${meta.kappa} brier ${meta.brier} bss ${meta.calibration?.bss ?? '-'} pairs ${meta.pairs} subjects ${meta.subjects ?? '-'}`], relevance: 0.7, evidenceStrength: meta.status === 'measured' ? 0.7 : 0.2 });
  try {
    const audit = deps.audit || require('../architecture/structure-audit');
    const rep = await audit.audit(deps.appRoot || require('../paths').appRoot());
    for (const c of rep.coupled.filter((x) => x.crossDomain)) out.push({ origin: 'structure-audit', loop: 'L1', title: `도메인을 가로지르는 결합 해소: ${c.domains.join(' · ')}`,
      hypothesis: `${c.files.length}개 파일이 서로 require한다. 위 계층 호출을 신호판(change-signals)이나 주입으로 뒤집는다.`, component: 'client_tool', targets: c.files, evidence: c.files, relevance: 0.6, evidenceStrength: 0.9, reproducibility: 0.9 });
  } catch { /* 앱 루트를 못 읽으면 이 원천만 빠진다 */ }
  return out;
}

/** 제안 에이전트: 모든 원천을 모아 새 제안만 더한다(같은 원천·제목은 중복). */
async function propose(deps = {}) {
  const raws = await builtinSources(deps);
  for (const [name, { fn }] of sources) {
    try { for (const r of (await fn()) || []) raws.push({ origin: name, producer: producerOf(name), ...r }); } catch (e) { raws.push({ origin: name, title: null, error: String(e.message || e) }); }
  }
  const added = await add(raws, deps);
  return { added: added.length, ids: added, unavailable: raws.filter((r) => !r.title && r.error).map((r) => ({ origin: r.origin, error: r.error.slice(0, 160) })) };
}

/** 원천 하나를 거치지 않고 제안을 더한다(사람이 쓴 개선 방향, 지표를 읽은 AI 제안). 같은 원천·제목은 중복 — 단 열린 낡은 제안은 새 근거로 갱신. 더하거나 갱신한 ID를 돌려준다. */
async function add(raws, deps = {}) {
  const v = await load(deps);
  const known = new Set(v.proposals.map((p) => p.id));
  const added = [];
  for (const r of raws) {
    const p = r.title ? normalize(r, r.origin, deps) : null;
    if (!p) continue;
    try { require('../prompt-safety').assertNoSecrets(JSON.stringify(p)); } catch { continue; }
    if (known.has(p.id)) {
      // 같은 원천·제목이 이미 있으면 버렸다 — 생산자가 바뀐 뒤 같은 문제를 다시 찾아도 옛 제안이 stale-evidence로 남아 다시 검토될 수 없었다(PR #34 Codex 리뷰).
      // 열린 제안이 낡은 근거이고 새 근거가 지금 생산자면 그 제안을 새 근거로 갱신해 검토 대기로 돌린다. 사람이 결정한 제안은 그대로 둔다(이력).
      const old = v.proposals.find((x) => x.id === p.id);
      if (old && (old.state === 'proposed' || old.state === 'reviewed') && staleness(old) && !staleness(p)) {
        Object.assign(old, { hypothesis: p.hypothesis, component: p.component, targets: p.targets, evidence: p.evidence, signals: p.signals, evalPlan: p.evalPlan,
          payload: p.payload, producer: p.producer, state: 'proposed', review: null, refreshedAt: p.createdAt });
        added.push(p.id);
      }
      continue;
    }
    v.proposals.push(p); known.add(p.id); added.push(p.id);
  }
  if (added.length) await save(v, deps);
  return added;
}

/** harness/lib/research-review.js의 assess와 같은 식 — 두 곳의 우선순위가 엇갈리지 않게. */
function priority(s) {
  return +(3 * s.relevance + 2 * s.evidence + 2 * s.reproducibility + s.novelty + s.recent - 2 * s.risk - s.effort).toFixed(3);
}

function screen(p) {
  const reasons = [];
  if (!p.evidence.length) reasons.push('근거 없음');
  const frozen = p.targets.filter((t) => FROZEN.some((re) => re.test(t)));
  if (frozen.length) reasons.push(`사람 설계 필요(고정 영역): ${frozen.join(', ')}`);
  if (p.signals.risk >= 0.8) reasons.push('위험도 높음');
  return reasons;
}

/** 사람 결정으로 만든 원천별 승인 기준율: 베타(1,1) 사전의 사후 평균(라플라스). 결정이 없으면 0.5. */
function approvalPrior(proposals, origin) {
  const f = familyOf(origin);
  let approved = 0, rejected = 0;
  for (const p of proposals) if (familyOf(p.origin) === f) { if (p.state === 'approved') approved++; else if (p.state === 'rejected') rejected++; }
  return { family: f, approved, rejected, rate: +((approved + 1) / (approved + rejected + 2)).toFixed(4) };
}

const STALE = 'stale-evidence';

/** 검토 에이전트: 결정적 선별 + (선택) 모델 검토. 더 보수적인 결론을 쓴다. */
async function review(id, options = {}, deps = {}) {
  const v = await load(deps);
  // 이미 검토된 열린 제안도 근거 생산자가 바뀌었으면 다시 본다 — 그 전 검토의 recommend가 낡은 근거 위에 남지 않게.
  const restale = (p) => p.state === 'reviewed' && staleness(p) && !(p.review?.reasons || []).some((r) => r.startsWith(STALE));
  const targets = id ? v.proposals.filter((p) => p.id === id) : v.proposals.filter((p) => p.state === 'proposed' || restale(p));
  const reviewed = [];
  for (const p of targets) {
    if (p.state === 'approved' || p.state === 'rejected') continue;
    const reasons = screen(p);
    const stale = staleness(p);
    if (stale) reasons.push(`${STALE}: 근거 생산자 ${stale.from || '기록 없음'} → 지금 ${stale.to}`);
    // 사람이 이 원천의 제안을 승인보다 많이 반려했으면 추천하지 않는다 — 우선순위 점수가 높아도.
    const prior = approvalPrior(v.proposals, p.origin);
    if (prior.rate < 0.5) reasons.push(`승인 기준율 ${prior.rate} (${prior.family}: 승인 ${prior.approved} · 반려 ${prior.rejected})`);
    const score = priority(p.signals);
    let verdict = reasons.length ? 'revise' : score >= 3 ? 'recommend' : score < 1 ? 'reject' : 'revise';
    let model = null;
    if (options.judge) {
      try {
        model = await options.judge(p);
        const rank = { recommend: 2, revise: 1, reject: 0 };
        if (model && rank[model.verdict] !== undefined && rank[model.verdict] < rank[verdict]) verdict = model.verdict;
      } catch (e) { model = { error: String(e.message || e).slice(0, 160) }; }
    }
    p.review = { verdict, score, reasons, model, prior: { approved: prior.approved, rejected: prior.rejected, rate: prior.rate }, at: new Date().toISOString() };
    p.state = 'reviewed';
    reviewed.push({ id: p.id, verdict, score });
  }
  if (reviewed.length) await save(v, deps);
  return { reviewed };
}

/**
 * 검토를 사람 결정으로 잰다(순수). 검토 결론 × 결정 표와 일치율(늘 recommend라고 했을 때의 일치율이 기준),
 * recommend 비율(0.8 이상이면 변별 없음), 원천별 기준율이 전체 기준율보다 결정을 잘 맞히는지(하나 빼기 Brier·BSS), 낡은 근거의 열린 제안.
 */
function calibrate(proposals) {
  const decided = proposals.filter((p) => p.state === 'approved' || p.state === 'rejected');
  const y = (p) => (p.state === 'approved' ? 1 : 0);
  const byOrigin = {};
  for (const p of proposals) {
    const o = byOrigin[familyOf(p.origin)] = byOrigin[familyOf(p.origin)] || { approved: 0, rejected: 0, open: 0 };
    if (p.state === 'approved') o.approved++; else if (p.state === 'rejected') o.rejected++; else o.open++;
  }
  for (const o of Object.values(byOrigin)) o.rate = +((o.approved + 1) / (o.approved + o.rejected + 2)).toFixed(4);
  const table = {};
  let n = 0, agree = 0, approvedJudged = 0;
  for (const p of decided) {
    if (!p.review) continue;
    n++; approvedJudged += y(p);
    table[`${p.review.verdict}→${p.state}`] = (table[`${p.review.verdict}→${p.state}`] || 0) + 1;
    if ((p.review.verdict === 'recommend') === (p.state === 'approved')) agree++;
  }
  const reviews = proposals.filter((p) => p.review);
  const recommendShare = reviews.length ? +(reviews.filter((p) => p.review.verdict === 'recommend').length / reviews.length).toFixed(4) : null;
  // 하나 빼기: 그 제안의 결정을 빼고 만든 사전으로 그 결정을 맞힌다(자기 라벨로 자기를 맞히지 않게).
  const A = decided.reduce((s, p) => s + y(p), 0), N = decided.length;
  let bo = 0, bg = 0;
  for (const p of decided) {
    const o = byOrigin[familyOf(p.origin)];
    const po = (o.approved - y(p) + 1) / (o.approved + o.rejected - 1 + 2), pg = (A - y(p) + 1) / (N - 1 + 2);
    bo += (po - y(p)) ** 2; bg += (pg - y(p)) ** 2;
  }
  const r4 = (x) => +x.toFixed(4);
  return {
    decided: N, approved: A, rejected: N - A, byOrigin,
    reviewVsHuman: { n, table, agreement: n ? r4(agree / n) : null, alwaysRecommend: n ? r4(approvedJudged / n) : null },
    recommendShare, discriminates: reviews.length >= 5 ? recommendShare < 0.8 : null,
    originPrior: N ? { brierOrigin: r4(bo / N), brierGlobal: r4(bg / N), bss: bg ? r4(1 - bo / bg) : null } : null,
    staleOpen: proposals.filter((p) => (p.state === 'proposed' || p.state === 'reviewed') && staleness(p)).map((p) => ({ id: p.id, origin: p.origin, title: p.title.slice(0, 80), ...staleness(p) })),
  };
}

async function calibration(deps = {}) { return calibrate((await load(deps)).proposals); }

/** 사람 승인. 승인하면 작업 지시서를 남긴다 — 실제 반영은 사람이 기존 절차(overlay·커밋)로 한다. */
async function decide(id, { decision, note = '', confirmed } = {}, deps = {}) {
  if (confirmed !== true) throw new Error('승인·반려는 사람이 확인해야 합니다(confirmed: true)');
  if (!['approved', 'rejected'].includes(decision)) throw new Error('decision은 approved 또는 rejected');
  const v = await load(deps);
  const p = v.proposals.find((x) => x.id === id);
  if (!p) throw new Error('제안을 찾지 못했습니다: ' + id);
  p.state = decision;
  p.decision = { decision, note: String(note).slice(0, 1000), at: new Date().toISOString() };
  await save(v, deps);
  let workOrder = null, applied = null;
  // 설정 편집만 승인과 함께 적용한다(기기 전용 표, 정책 밖 능력은 거부). 코드 변경은 작업 지시서로만 남긴다.
  if (decision === 'approved' && p.payload && p.payload.kind === 'route-edit') {
    applied = await require('../toolroute/route-table').applyEdit(p.payload.edit, { confirmed: true }, deps);
  }
  if (decision === 'approved') {
    workOrder = path.join(path.dirname(fileOf(deps)), 'approved', `${p.id}.md`);
    await writeAtomic(workOrder, [`---\ntype: rsi-work-order\nid: ${p.id}\nloop: ${p.loop}\norigin: ${p.origin}\napprovedAt: ${p.decision.at}\n---`,
      `# ${p.title}`, '', p.hypothesis, '', '## 근거', ...p.evidence.map((e) => `- ${e}`), '', '## 평가 계획',
      `- 결정적: ${(p.evalPlan.deterministic || []).join(', ')}`, `- 에이전트: ${p.evalPlan.agent}`, '',
      `검토: ${p.review ? `${p.review.verdict} (우선순위 ${p.review.score}) ${p.review.reasons.join('; ')}` : '없음'}`, `메모: ${p.decision.note || '-'}`, ''].join('\n'));
  }
  return { id, state: p.state, workOrder, applied };
}

async function list({ state } = {}, deps = {}) {
  const v = await load(deps);
  const rows = state ? v.proposals.filter((p) => p.state === state) : v.proposals;
  return rows.slice().sort((a, b) => (b.review?.score ?? priority(b.signals)) - (a.review?.score ?? priority(a.signals)));
}

module.exports = { propose, add, review, decide, list, registerSource, priority, screen, normalize, approvalPrior, calibrate, calibration, staleness, producerOf, STATES, FROZEN };

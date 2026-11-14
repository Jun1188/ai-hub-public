// 자가개선 탭·MCP 요약: 평가 3계층, RSI 루프 설치 상태, 제안 큐, 캐시 적중률, 하네스 호환성, 거버너, 구조 감사, Obsidian, 능력 공백.
// 각 칸은 따로 실패한다 — 한 원천이 죽어도 나머지는 보인다.
'use strict';

async function part(fn) {
  try { return await fn(); } catch (e) { return { error: String(e.message || e).slice(0, 160) }; }
}

async function overview(deps = {}) {
  const store = require('../evaluation/eval-store');
  const [det, agent, meta] = await Promise.all(['deterministic', 'agent', 'meta'].map((tier) => part(async () => (await store.recent({ limit: 30, tier }, deps)).rows.slice(-5))));
  // 2계층 기준표 항목별 위반·불명확 비율과 3계층 kappa·Brier 변화 — 평가기가 무엇을 자주 걸고 나아지는지 보는 두 수치.
  const agentItems = await part(async () => { const a = await require('../evaluation/agent-eval').analyze({}, deps); return { ...a, items: a.items.slice(0, 8) }; });
  const metaTrend = await part(() => require('../evaluation/meta-eval').trend({}, deps));
  const loops = await part(() => {
    const ids = new Set((deps.pipeline || require('../pipeline')).list().map((p) => p.id));
    return require('./triple-loop').LOOPS.map((l) => ({ id: l.id, name: l.name, installed: ids.has(l.id) }));
  });
  const proposals = await part(async () => (await require('./research-agents').list({}, deps)).slice(0, 40).map((p) => ({ id: p.id, loop: p.loop, origin: p.origin, title: p.title,
    hypothesis: p.hypothesis.slice(0, 400), targets: p.targets.slice(0, 5), state: p.state, review: p.review ? { verdict: p.review.verdict, score: p.review.score, reasons: p.review.reasons, prior: p.review.prior || null } : null,
    producer: p.producer || null, applicable: !!p.payload })));
  // L3 검토를 사람 결정으로 잰 것: 검토 결론 × 결정, recommend 비율(변별), 원천별 승인 기준율, 낡은 근거의 열린 제안.
  const proposalReview = await part(() => require('./research-agents').calibration(deps));
  const cache = await part(() => require('../cache/locality-cache').instance().metrics());
  const harnesses = await part(async () => Object.values((await require('../harness-bridge/harness-registry').readCompat(deps)).harnesses || {}));
  const bus = await part(() => require('../harness-bridge/harness-bus').stats(deps));
  const governor = await part(async () => ({ ...require('../governor/governor').status(), gaps: (await require('../governor/monitoring-gaps').list(deps)).slice(0, 8) }));
  const structure = await part(async () => {
    const a = require('../architecture/structure-audit');
    const r = await a.audit(deps.appRoot || require('../paths').appRoot());
    return { ...r.totals, score: a.structureScore(r).score, hotspots: r.hotspots.slice(0, 5), coupled: r.coupled.filter((c) => c.crossDomain) };
  });
  const obsidian = await part(() => require('../obsidian/obsidian-link').detect(deps));
  const library = await part(() => require('./experience-library').domains(deps));
  const capabilityGaps = await part(() => require('./capability-gaps').gaps(deps)); // 연구 예약이 읽는 검색 질의(고정 어휘)
  return { evaluation: { deterministic: det, agent, meta, agentItems, metaTrend }, loops, proposals, proposalReview, cache, harnesses, bus, governor, structure, obsidian, library, capabilityGaps };
}

module.exports = { overview };

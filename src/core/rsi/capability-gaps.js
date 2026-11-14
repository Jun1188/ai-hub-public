// RSI 3번 루프의 연구 질의(ScholarEvolve의 실패 진단 → 능력 공백 → 모듈별 검색 질의).
// 이 PC의 실패 신호를 능력 공백으로 묶고 질의는 고정 어휘에서만 고른다 — 사용자 질의 원문·스킬 이름·경로·도구 이름이
// 외부 논문 검색으로 새지 않게(원문이 벤치마크·도구 이름을 질의에서 빼는 것과 같은 목적). Hub는 검색하지 않고,
// 연구 예약(Codex)이 rsi_overview의 capabilityGaps를 읽는다. 원천마다 따로 실패하며 읽기 실패는 "공백 없음"이 아니다(규칙 6).
'use strict';

// component는 공유 연구 선별기(harness/lib/research-review.js)의 COMPONENTS — 연구 후보 칸과 그대로 맞물린다.
const GAPS = {
  'skill-discovery': { component: 'skill', capability: '자연어 요청에서 맞는 절차 문서(스킬)를 찾는 능력',
    broad: ['skill discovery', 'tool retrieval for llm agents'], mechanisms: ['cross-lingual dense retrieval', 'query rewriting', 'tool description generation'] },
  'tool-routing': { component: 'client_tool', capability: '의도에 맞는 도구 경로를 고르는 능력',
    broad: ['tool selection', 'tool routing'], mechanisms: ['api retrieval', 'tool documentation compression'] },
  observability: { component: 'client_tool', capability: '자원 문제를 관측하고 원인 프로세스에 귀속하는 능력',
    broad: ['agent observability', 'llm system monitoring'], mechanisms: ['runtime resource attribution', 'root cause attribution'] },
  'sensitive-output': { component: 'output_plumbing', capability: '출력·전송 전에 민감한 값을 걸러 내는 능력',
    broad: ['sensitive data leakage prevention'], mechanisms: ['secret detection', 'redaction'] },
  'constraint-adherence': { component: 'control_flow', capability: '끝내기 전에 지켜야 할 제약을 스스로 검증하는 능력',
    broad: ['constraint following', 'self-verification'], mechanisms: ['verifier-guided refinement', 'checklist self-critique'] },
};
const SENSITIVE = /시크릿|secret|토큰|token|마스킹|mask|자격 ?증명|credential|API 키/i;
const MIN_JUDGED = 3, MIN_VIOLATION = 0.3, MIN_ROUTE_MISSES = 3;

/** 평가 2계층에서 반복해서 어긴 기준 항목 → 민감 출력 또는 제약 준수 공백. */
async function ruleSignals(deps) {
  const store = require('../evaluation/eval-store');
  const { rows } = await store.recent({ limit: 500, tier: 'agent' }, deps);
  const text = new Map();
  for (const h of new Set(rows.map((r) => r.rubricHash).filter(Boolean))) {
    for (const it of (await store.cacheGet('rubric-' + h, deps))?.items || []) text.set(it.id, it.text);
  }
  const out = {};
  for (const it of (await require('../evaluation/agent-eval').analyze({ limit: 500 }, deps)).items) {
    if (it.n < MIN_JUDGED || it.violationRate < MIN_VIOLATION) continue;
    const key = SENSITIVE.test(text.get(it.id) || '') ? 'sensitive-output' : 'constraint-adherence';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

const SOURCES = {
  'agent-eval': ruleSignals,
  'monitoring-gaps': async (deps) => {
    const n = (await require('../governor/monitoring-gaps').proposals(deps)).length;
    return n ? { observability: n } : {};
  },
  'knowledge-metrics': async (deps) => {
    const snap = await require('../knowledge-metrics').snapshot({ days: 30 }, deps);
    const skills = (await require('./metric-proposals').proposals(snap, deps)).length;
    const routes = (snap.routes?.top || []).filter((r) => r.count >= MIN_ROUTE_MISSES).length;
    return { ...(skills ? { 'skill-discovery': skills } : {}), ...(routes ? { 'tool-routing': routes } : {}) };
  },
};

const interleave = (a, b) => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => [a[i], b[i]]).flat().filter(Boolean);

/** { gaps: [{ id, component, capability, queries, evidence:[{source, count}] }], unavailable } — 근거는 개수뿐이다. */
async function gaps(deps = {}) {
  const found = {}, unavailable = [];
  for (const [source, fn] of Object.entries(SOURCES)) {
    try {
      for (const [id, count] of Object.entries(await fn(deps))) (found[id] = found[id] || []).push({ source, count });
    } catch (e) { unavailable.push({ source, error: String(e.message || e).slice(0, 160) }); }
  }
  const total = (id) => found[id].reduce((s, e) => s + e.count, 0);
  return {
    gaps: Object.keys(found).sort((a, b) => total(b) - total(a)).map((id) => ({ id, component: GAPS[id].component, capability: GAPS[id].capability,
      queries: interleave(GAPS[id].broad, GAPS[id].mechanisms), evidence: found[id] })),
    unavailable,
  };
}

module.exports = { gaps, GAPS };

// 거버너(3/3): 거버너 결정을 평가해 개선하는 평가자. 결정 뒤 몇 분의 자원 기록을 결정 직전과 비교해
// helped / hurt / no observed effect / confounded로 판정하고(행동이 둘 이상이면 confounded, 대상 없는 관문은 no-target으로 빼고),
// 행동 종류별 효과율이 기준을 벗어나면 임계값 조정을 제안한다(자동 조정 없음 — RSI 3번 루프 승인).
'use strict';

const AFTER_MS = 4 * 60 * 1000;
// 판정 규칙의 버전 — 이 평가에서 나온 L3 제안의 근거 생산자(결정 규칙 governor.RULES_VERSION과 함께). 판정을 바꾸면 올린다.
const EVAL_VERSION = 'geval-3';
// 관문 닫기·열기는 Hub의 새 로컬 추론 입장(hardware-optimizer.reserveLocalSlot)만 움직인다. 그때 로컬 슬롯을 쓰거나 기다리거나 관문 앞에서 기다리는
// 작업이 없었으면 막거나 풀어 준 것이 없다 — 그 뒤 압박이 줄거나 늘어도 이 행동의 효과가 아니다(다른 앱의 넘침).
// busy는 대상이 아니다: offload의 busy는 codex·agy 원격 작업도 올려(offload.js의 registerBusy) 원격 작업만 있어도 helped가 됐다(1.32.22, Codex 교차 리뷰).
// slotActive·gateWaiting이 없는 1.32.22 행은 slotWaiting만 본다.
const GATE_ACTIONS = new Set(['gate-local-inference', 'release-gate']);
const hasTarget = (decision) => { const b = decision.before || {}; return (b.slotActive || 0) + (b.slotWaiting || 0) + (b.gateWaiting || 0) > 0; };

/** 순수: 결정 행과 그 뒤 창의 진단 종류로 판정. 대상 없는 관문만이면 no-target(판정하지 않고 기록만, skipped에 그 행동). */
function judge(decision, afterFindings) {
  const before = new Set(decision.before?.findings || []);
  const after = new Set(afterFindings || []);
  // 아무것도 못 내린 내리기(노는 모델 없음)는 지렛대를 당긴 게 아니다 — 세면 효과율이 원인과 무관하게 깎인다.
  const pulled = (a) => a.ok !== false && !(a.type === 'unload-idle-models' && Array.isArray(a.unloaded) && !a.unloaded.length);
  const pulledTypes = [...new Set((decision.actions || []).filter(pulled).map((a) => a.type))];
  if (!pulledTypes.length) return { verdict: 'no observed effect', types: pulledTypes };
  const targeted = hasTarget(decision);
  const types = pulledTypes.filter((t) => targeted || !GATE_ACTIONS.has(t));
  if (!types.length) return { verdict: 'no-target', types, skipped: pulledTypes };
  if (types.length > 1 && !types.every((t) => t === 'gate-local-inference' || t === 'unload-idle-models')) return { verdict: 'confounded', types };
  const pressure = ['paging', 'vram_spill', 'gpu_throttle', 'cpu_saturation'];
  const was = pressure.filter((k) => before.has(k)), now = pressure.filter((k) => after.has(k));
  if (types.includes('release-gate')) return { verdict: now.length ? 'hurt' : 'helped', types };
  if (!was.length) return { verdict: 'no observed effect', types };
  if (now.length < was.length) return { verdict: 'helped', types };
  if (now.length > was.length) return { verdict: 'hurt', types };
  return { verdict: 'no observed effect', types };
}

/**
 * 장부의 판정 가능한 결정(4분 이상 지난 것)을 평가한다. 지난 창을 다시 읽으므로 비싸지 않은 주기로 돈다.
 * 지금 규칙 버전(governor.RULES_VERSION)으로 낸 결정만 판정한다. 버전이 없는(1.32.20 전) 행이나 다른 버전 행은 legacy로 세기만 한다 —
 * 그 결정의 before 진단이 지금 규칙과 다르게 만들어졌을 수 있다(1.32.17 전 거짓 넘침).
 */
async function evaluate({ limit = 50 } = {}, deps = {}) {
  const governor = require('./governor');
  const tel = deps.telemetry || require('../telemetry');
  const ripe = (await governor.decisions({ limit }, deps)).filter((d) => Date.now() - Date.parse(d.at) >= AFTER_MS);
  const rows = ripe.filter((d) => d.rules === governor.RULES_VERSION);
  const results = [];
  for (const d of rows) {
    let after = null;
    try {
      const since = Date.parse(d.at) + 30000;
      const samples = await tel.window({ since, until: since + AFTER_MS });
      // 표본 없는 창은 "압박 없음"이 아니라 읽지 못한 창이다(규칙 6) — 보존 2일이 지났거나 샘플러가 꺼진 창을 helped로 셌다.
      if (samples.length) after = require('../telemetry-analysis').findings(samples, {}).map((f) => f.kind);
    } catch { /* 창을 못 읽으면 판정하지 않는다 */ }
    results.push(after ? { at: d.at, ...judge(d, after) } : { at: d.at, verdict: null, reason: 'after-window-unavailable' });
  }
  const byType = {};
  const stat = (t) => (byType[t] = byType[t] || { n: 0, helped: 0, hurt: 0, none: 0, confounded: 0, noTarget: 0 });
  for (const r of results) {
    for (const t of r.types || []) { const s = stat(t); s.n++; s[r.verdict === 'helped' ? 'helped' : r.verdict === 'hurt' ? 'hurt' : r.verdict === 'confounded' ? 'confounded' : 'none']++; }
    for (const t of r.skipped || []) stat(t).noTarget++; // 판정에서 뺀 관문(n에 넣지 않는다)
  }
  return { evaluated: results.length, legacy: ripe.length - rows.length, producer: governor.RULES_VERSION, evalVersion: EVAL_VERSION,
    noTarget: results.filter((r) => r.verdict === 'no-target').length, unavailable: results.filter((r) => r.verdict === null).length, byType, results: results.slice(-20) };
}

function proposals(summary) {
  const out = [];
  for (const [t, s] of Object.entries(summary.byType || {})) {
    if (s.n < 5) continue;
    if (s.hurt / s.n >= 0.3) out.push({ title: `거버너 행동 ${t}가 ${Math.round(100 * s.hurt / s.n)}% 악화 — 조건 강화 또는 비활성`, evidence: [JSON.stringify(s)], relevance: 0.8, evidenceStrength: 0.7 });
    else if (s.helped / s.n >= 0.7) out.push({ title: `거버너 행동 ${t}가 ${Math.round(100 * s.helped / s.n)}% 개선 — 더 이른 시점에 발동 검토`, evidence: [JSON.stringify(s)], relevance: 0.5, evidenceStrength: 0.6 });
    else if (s.none / s.n >= 0.8) out.push({ title: `거버너 행동 ${t}가 거의 효과 없음 — 지렛대 재검토`, evidence: [JSON.stringify(s)], relevance: 0.5, evidenceStrength: 0.6 });
  }
  return out;
}

module.exports = { judge, evaluate, proposals, hasTarget, AFTER_MS, EVAL_VERSION };

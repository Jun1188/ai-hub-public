// 도구 경로 표를 상태 그래프 연산으로 노출한다. 제안 원천 등록은 조립 루트(rsi/hub-operations)가 한다.
'use strict';

/** 경로 편집 제안을 RSI 제안 큐 형식으로(승인 시 적용할 편집을 payload로 싣는다). */
async function proposals(deps = {}) {
  return (await require('./route-table').proposeEdits(deps)).map((e) => ({
    loop: 'L3', title: e.title, hypothesis: `도구 경로 표 ${e.action}: ${JSON.stringify(e.route).slice(0, 400)}`, component: 'client_tool',
    evidence: e.evidence, relevance: 0.6, evidenceStrength: 0.7, reproducibility: 0.8, risk: e.action === 'delete' ? 0.4 : 0.2, effort: 0.1,
    payload: { kind: 'route-edit', edit: { action: e.action, route: e.route } } }));
}

function operations(deps = {}) {
  const table = () => require('./route-table');
  return {
    'routes.resolve': { description: '의도 → 도구 경로', fn: async (a) => ({ ok: true, ...(await table().resolve(a.intent || '', {}, deps)) }) },
    'routes.propose': { description: '경로 표 자가개선 제안', fn: async () => ({ ok: true, edits: await table().proposeEdits(deps) }) },
  };
}

module.exports = { operations, proposals };

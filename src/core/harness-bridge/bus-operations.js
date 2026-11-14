// 하네스 버스 연산을 상태 그래프 hub-tool에 노출한다(예: RSI L1의 제안을 다른 하네스에 물어보는 단계).
'use strict';

function operations(deps = {}) {
  const bus = () => require('./harness-bus');
  return {
    'harness.probe': { description: '하네스 설치·버전·계약·MCP 등록 탐침', fn: async () => {
      const rows = await require('./harness-registry').probeAll(deps);
      return { ok: true, harnesses: rows.map((r) => ({ id: r.id, installed: r.installed, version: r.version, contractOk: r.contractOk, dispatch: r.dispatch, mcp: r.mcp, drift: r.drift })) };
    } },
    'bus.ask': { description: '다른 하네스에 묻고(선택) 바로 전달', fn: async (a) => {
      const sent = await bus().send({ from: a.from || 'ai-hub', to: a.to, kind: 'ask', topic: a.topic, body: a.body, refs: a.refs || [] }, deps);
      if (!a.dispatch) return { ok: true, ...sent };
      const r = await bus().dispatch(sent.id, { timeoutSec: a.timeoutSec || 600 }, deps);
      return { ok: r.status === 'answered', ...r };
    } },
    'bus.stats': { description: '버스 전달 통계', fn: async () => ({ ok: true, ...(await bus().stats(deps)) }) },
  };
}

module.exports = { operations };

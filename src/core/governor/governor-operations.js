// 거버너 3역(조절·공백 기록·평가)을 상태 그래프 연산으로 노출한다. 제안 원천 등록은 조립 루트(rsi/hub-operations)가 한다.
'use strict';

function operations(deps = {}) {
  return {
    'governor.tick': { description: '거버너 한 주기(관측→판단→실행)', fn: async () => ({ ok: true, ...(await require('./governor').tick(deps)) }) },
    'governor.evaluate': { description: '거버너 결정 효과 평가', fn: async () => {
      const r = await require('./governor-eval').evaluate({}, deps);
      return { ok: true, evaluated: r.evaluated, byType: r.byType };
    } },
    'governor.gaps': { description: '모니터링·디버깅 공백 목록', fn: async () => ({ ok: true, gaps: (await require('./monitoring-gaps').list(deps)).slice(0, 30) }) },
  };
}

module.exports = { operations };

#!/usr/bin/env node
// 추론 오버헤드 기반 라우팅 회귀 테스트 (LM Studio 불필요 — 모델 목록·통계를 스텁).
//
// 왜 (2026-07-30 실측): gemma-4-12b-qat은 본문 710토큰을 내는 데 완료 3057토큰을 썼다
// (2347 = 77%가 히든 추론). 같은 근거 기반 분석이 247초 걸렸고 전역 상한 300초와
// 경계에서 만나 renderpipe/progress 테스트가 동전 던지기가 됐다.
//
// 지키는 것:
//   · 오버헤드는 **긴 답을 요구할 때만** 따진다. 비용이 출력 길이에 비례하므로.
//   · 그때는 loaded보다 **앞선다**. 콜드 로드 수십 초는 한 번, 오버헤드는 계속이다.
//   · 관측 전에는 순위를 바꾸지 않는다. 모델 이름으로 추론형인지 맞히려 들지 않는다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-overhead-'));
process.env.APPDATA = SANDBOX;

const delegator = require('../src/core/delegator');
const stats = require('../src/core/stats');
const lmstudio = require('../src/core/lmstudio');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const REASONER = 'vendor/reasoner-12b';   // 떠 있지만 오버헤드가 크다
const PLAIN = 'vendor/plain-12b';         // 안 떠 있지만 오버헤드가 없다

const realList = lmstudio.listModelsDetailed;
const realRatio = stats.reasoningRatioOf;

function stub(models, ratios) {
  lmstudio.listModelsDetailed = async () => models;
  stats.reasoningRatioOf = (id) => (id in ratios ? ratios[id] : null);
}

(async () => {
  const MODELS = [
    { id: REASONER, state: 'loaded', type: 'llm', contextLength: 8192 },
    { id: PLAIN, state: 'not-loaded', type: 'llm', contextLength: 8192 },
  ];

  console.log('1) 긴 답에서는 오버헤드가 loaded를 이긴다');
  {
    stub(MODELS, { [REASONER]: 0.77, [PLAIN]: 0.0 });
    const long = await delegator.routeModel('custom', undefined, 1600);
    check('오버헤드 낮은 쪽을 고른다(콜드 로드를 감수)', long === PLAIN, long);
  }

  console.log('2) 짧은 답에서는 loaded가 이긴다 (콜드 로드가 손해)');
  {
    stub(MODELS, { [REASONER]: 0.77, [PLAIN]: 0.0 });
    const short = await delegator.routeModel('custom', undefined, 300);
    check('이미 떠 있는 쪽을 고른다', short === REASONER, short);
    const none = await delegator.routeModel('custom', undefined);
    check('길이를 모르면 기존 순서대로', none === REASONER, none);
  }

  console.log('3) 경계값');
  {
    stub(MODELS, { [REASONER]: 0.77, [PLAIN]: 0.0 });
    const at = await delegator.routeModel('custom', undefined, delegator.LONG_REPLY_TOKENS);
    check('기준값 이상이면 적용', at === PLAIN, at);
    const below = await delegator.routeModel('custom', undefined, delegator.LONG_REPLY_TOKENS - 1);
    check('기준값 미만이면 미적용', below === REASONER, below);
  }

  console.log('4) 관측 전에는 순위를 바꾸지 않는다');
  {
    // 둘 다 미관측: 이름만 보고 추론형이라 넘겨짚으면 안 된다.
    stub(MODELS, {});
    const r = await delegator.routeModel('custom', undefined, 1600);
    check('미관측이면 loaded가 유지된다', r === REASONER, r);
    // 한쪽만 관측됐고 그게 낮으면, 미관측(중립)보다 앞선다.
    stub(MODELS, { [PLAIN]: 0.1 });
    const r2 = await delegator.routeModel('custom', undefined, 1600);
    check('관측된 저오버헤드가 미관측을 이긴다', r2 === PLAIN, r2);
  }

  console.log('5) 오버헤드가 낮으면 굳이 바꾸지 않는다');
  {
    stub(MODELS, { [REASONER]: 0.2, [PLAIN]: 0.0 });
    const r = await delegator.routeModel('custom', undefined, 1600);
    check('둘 다 기준 미만이면 loaded 유지', r === REASONER, r);
  }

  console.log('6) 명시 지정과 기본 모델은 그대로 존중된다');
  {
    stub(MODELS, { [REASONER]: 0.77 });
    const r = await delegator.routeModel('custom', REASONER, 1600);
    check('호출자가 지정하면 바꾸지 않는다', r === REASONER, r);
  }

  console.log('7) 상수');
  {
    check('기준 비율이 0~1', delegator.HIGH_OVERHEAD_RATIO > 0 && delegator.HIGH_OVERHEAD_RATIO < 1);
    check('긴 답 기준이 양수', delegator.LONG_REPLY_TOKENS > 0);
  }

  lmstudio.listModelsDetailed = realList;
  stats.reasoningRatioOf = realRatio;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log('');
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();

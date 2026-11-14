#!/usr/bin/env node
// 응답 토큰 예산 + 잘림 재시도 회귀 테스트 (LM Studio 불필요).
//
// 2026-07-28 실측: gemma-4-12b-qat에 max_tokens=700으로 위임했더니 446토큰(64%)이
// 히든 추론으로 나가고 본문이 문장 중간에서 잘렸다. content만 봐서는 잘린 걸 알 수
// 없었고(finish_reason만 아는 사실), 호출자는 잘린 답을 정상 답으로 받았다.
// 아래가 그 회귀를 막는다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// config/stats는 모듈 로드 시점에 hubDataDir()로 경로를 굳힌다. 진짜 %APPDATA%의
// stats.json(실사용 통계)을 오염시키지 않도록 require 전에 격리한다.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-replybudget-'));
process.env.APPDATA = SANDBOX;

const replyBudget = require('../src/core/reply-budget');
const stats = require('../src/core/stats');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('1) planReplyTokens — 추론 비율만큼 부풀린다');
{
  const none = replyBudget.planReplyTokens({ requested: 700, reasoningRatio: 0 });
  check('비율 0이면 요청 그대로', none.tokens === 700 && none.reason === 'requested', JSON.stringify(none));

  const unknown = replyBudget.planReplyTokens({ requested: 700, reasoningRatio: null });
  check('관측 전(null)도 요청 그대로', unknown.tokens === 700, JSON.stringify(unknown));

  // 실측 사례: 64%가 추론으로 나갔다 → 본문 700을 받으려면 약 1945가 필요하다.
  const observed = replyBudget.planReplyTokens({ requested: 700, reasoningRatio: 0.64 });
  check('비율 0.64면 700 → 1945로 부풀림', observed.tokens === 1945 && observed.reason === 'reasoning-inflated',
    JSON.stringify(observed));

  const capped = replyBudget.planReplyTokens({ requested: 700, reasoningRatio: 0.99 });
  check('비율은 0.8에서 잘려 발산하지 않음', capped.tokens === 3500, String(capped.tokens));
}

console.log('2) planReplyTokens — 컨텍스트 창을 넘지 않는다');
{
  // 4096 창에 프롬프트가 3000토큰 들어갔다 → 남은 건 4096-3000-64 = 1032.
  const r = replyBudget.planReplyTokens({
    requested: 700, reasoningRatio: 0.64, contextLength: 4096, promptTokens: 3000,
  });
  check('부풀린 값이 창을 넘으면 남은 만큼으로 깎임', r.tokens === 1032 && r.reason === 'context-capped',
    JSON.stringify(r));

  const roomy = replyBudget.planReplyTokens({
    requested: 700, reasoningRatio: 0.64, contextLength: 16384, promptTokens: 500,
  });
  check('창이 넉넉하면 부풀린 값 유지', roomy.tokens === 1945, JSON.stringify(roomy));

  const starved = replyBudget.planReplyTokens({
    requested: 700, reasoningRatio: 0, contextLength: 4096, promptTokens: 4090,
  });
  check('남은 창이 음수여도 최소치는 요청', starved.tokens === replyBudget.MIN_REPLY_TOKENS, JSON.stringify(starved));

  const noCtx = replyBudget.planReplyTokens({ requested: 700, reasoningRatio: 0, contextLength: null, promptTokens: 9999 });
  check('창 크기를 모르면 제한하지 않음', noCtx.tokens === 700, JSON.stringify(noCtx));
}

console.log('3) exceedsContext — 실패할 걸 아는 호출은 아예 하지 않는다');
{
  // 4096 창에 프롬프트 4000토큰 → 남은 32토큰으로는 쓸모 있는 답이 안 나온다.
  check('답변 자리가 없으면 true', replyBudget.exceedsContext({ contextLength: 4096, promptTokens: 4000 }));
  check('최소치가 남으면 false', replyBudget.exceedsContext({ contextLength: 4096, promptTokens: 3000 }) === false);
  // 경계: 남은 자리가 정확히 MIN이면 통과시켜야 한다.
  const exact = 4096 - replyBudget.MIN_REPLY_TOKENS - replyBudget.SAFETY_TOKENS;
  check('남은 자리가 정확히 최소치면 false', replyBudget.exceedsContext({ contextLength: 4096, promptTokens: exact }) === false);
  check('창 크기를 모르면 거부하지 않음', replyBudget.exceedsContext({ contextLength: null, promptTokens: 99999 }) === false);
}

console.log('4) retryReplyTokens — 늘릴 여지가 있을 때만 0이 아니다');
{
  check('창 여유가 충분하면 두 배', replyBudget.retryReplyTokens({ used: 700, contextLength: 16384, promptTokens: 500 }) === 1400);
  // 4096 창, 프롬프트 2000 → 남은 2032. 두 배(1400)는 들어가므로 1400.
  check('두 배가 창에 들어가면 두 배', replyBudget.retryReplyTokens({ used: 700, contextLength: 4096, promptTokens: 2000 }) === 1400);
  // 남은 게 1.5배(1050)에 못 미치면 재시도해도 또 잘린다 → 0.
  check('1.5배도 확보 못 하면 0(재시도 안 함)',
    replyBudget.retryReplyTokens({ used: 700, contextLength: 4096, promptTokens: 3100 }) === 0);
  check('창 크기를 모르면 두 배로 재시도', replyBudget.retryReplyTokens({ used: 700 }) === 1400);
}

console.log('5) observedReasoningRatio — 관측 불가와 0을 구별한다');
{
  check('reasoning 446 / completion 700 = 0.637',
    Math.abs(replyBudget.observedReasoningRatio({ completion_tokens: 700 }, 446) - 0.637) < 0.001);
  check('추론 안 쓰는 모델은 0', replyBudget.observedReasoningRatio({ completion_tokens: 300 }, 0) === 0);
  check('usage가 없으면 null(통계 오염 금지)', replyBudget.observedReasoningRatio({}, 0) === null);
  check('usage 자체가 undefined여도 null', replyBudget.observedReasoningRatio(undefined, 0) === null);

  // 잘린 응답은 관측이 아니다 — 이걸 기록하면 비율이 1로 폭주해 예산이 상한까지
  // 부풀고, 창에 막혀 또 잘린다(실측: 파인튜닝 생성 3건 중 2건 실패).
  check('잘린 응답(length)은 관측으로 치지 않음',
    replyBudget.observedReasoningRatio({ completion_tokens: 2232 }, 2230, 'length') === null);
  check('정상 종료(stop)는 관측으로 인정',
    replyBudget.observedReasoningRatio({ completion_tokens: 700 }, 446, 'stop') !== null);
}

console.log('6) stats — 모델별 추론 비율이 EMA로 쌓이고 예산에 되먹임된다');
{
  const model = 'test/reasoning-model';
  check('관측 전에는 null', stats.reasoningRatioOf(model) === null);
  stats.record({ taskType: 'programming', model, elapsedMs: 100, ok: true, tokens: 10, reasoningRatio: 0.64 });
  check('첫 관측이 그대로 들어감', stats.reasoningRatioOf(model) === 0.64, String(stats.reasoningRatioOf(model)));
  stats.record({ taskType: 'programming', model, elapsedMs: 100, ok: true, tokens: 10, reasoningRatio: 0.34 });
  const ema = stats.reasoningRatioOf(model);
  check('두 번째 관측은 EMA로 섞임(0.64→0.55)', Math.abs(ema - 0.55) < 0.001, String(ema));

  // 실패한 호출은 통계를 오염시키지 않는다(ok=false는 기존에도 집계 제외).
  stats.record({ taskType: 'programming', model, elapsedMs: 100, ok: false, reasoningRatio: 0.99 });
  check('실패 호출은 비율에 반영되지 않음', stats.reasoningRatioOf(model) === ema, String(stats.reasoningRatioOf(model)));

  const plan = replyBudget.planReplyTokens({ requested: 700, reasoningRatio: stats.reasoningRatioOf(model) });
  check('쌓인 비율이 다음 호출 예산을 키움', plan.tokens > 700 && plan.reason === 'reasoning-inflated', JSON.stringify(plan));

  const plain = 'test/plain-model';
  stats.record({ taskType: 'reasoning', model: plain, elapsedMs: 100, ok: true, tokens: 10, reasoningRatio: 0 });
  check('추론 안 쓰는 모델은 예산이 그대로', replyBudget.planReplyTokens({
    requested: 700, reasoningRatio: stats.reasoningRatioOf(plain),
  }).tokens === 700);
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log('');
console.log(`통과 ${pass} / 실패 ${fail}`);
process.exit(fail === 0 ? 0 : 1);

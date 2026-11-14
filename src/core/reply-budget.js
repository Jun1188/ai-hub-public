// 위임 호출 하나가 쓸 수 있는 **응답(completion) 토큰 예산**을 정한다.
//
// 왜 별도 계산이 필요한가: 추론형 로컬 모델(gemma-4-12b-qat 등)은 max_tokens를
// 히든 추론에 먼저 쓴다. 실측에서 700토큰 예산 중 446토큰(64%)이 reasoning으로 나가고
// 본문이 문장 중간에서 잘렸다. 호출자는 "700토큰짜리 답"을 기대했는데 실제로 받은 건
// 254토큰이었고, content만 봐서는 잘렸는지 알 수 없다(finish_reason이 유일한 신호).
//
// 그래서 모델별로 **측정된** 추론 비율(stats.reasoningRatioOf)만큼 예산을 부풀린다.
// 비율은 관측이지 추측이 아니다 — 모델 이름으로 추론형인지 맞히려 들지 않는다.
// 새 모델은 비율 0에서 시작해 첫 호출이 잘리면 그때 측정되고, 다음 호출부터 반영된다.
//
// 부풀린 예산이 컨텍스트 창을 넘으면 안 된다(.claude/rules/local-model-prompts.md):
// n_ctx를 넘으면 LM Studio가 400을 내거나 컨텍스트를 조용히 재처리해서 10초짜리
// 호출이 수 분이 된다.
'use strict';

// 추론에 예산의 80% 넘게 쓴다고 보면 부풀림이 발산한다(1/(1-0.9)=10배). 상한을 둔다.
const MAX_REASONING_SHARE = 0.8;
// 창이 좁아도 이보다 적게 주면 어차피 쓸모 있는 답이 안 나온다.
const MIN_REPLY_TOKENS = 256;
// 토큰 추정은 문자수 기반 근사(±)라 창 끝에 여유를 남긴다.
const SAFETY_TOKENS = 64;

function headroomFor(contextLength, promptTokens) {
  const ctx = Number(contextLength) || 0;
  if (!ctx) return null; // 창 크기를 모르면 제한하지 않는다
  return ctx - Math.max(0, Math.floor(Number(promptTokens) || 0)) - SAFETY_TOKENS;
}

/**
 * 이번 호출에 넘길 max_tokens.
 * @param {{requested:number, reasoningRatio?:number|null, contextLength?:number|null, promptTokens?:number}} p
 * @returns {{tokens:number, reason:'requested'|'reasoning-inflated'|'context-capped'}}
 */
function planReplyTokens(p) {
  const requested = Math.max(1, Math.floor(Number(p.requested) || 0));
  const ratio = Math.min(Math.max(Number(p.reasoningRatio) || 0, 0), MAX_REASONING_SHARE);
  // 1-ratio는 부동소수 오차를 남긴다(1-0.8 = 0.19999…). 그대로 ceil하면 예산이
  // 1토큰씩 튀어 같은 입력이 다른 값을 낸다 — 오차만 흡수하고 올림한다.
  let tokens = ratio > 0 ? Math.ceil(requested / (1 - ratio) - 1e-6) : requested;
  let reason = tokens > requested ? 'reasoning-inflated' : 'requested';

  const headroom = headroomFor(p.contextLength, p.promptTokens);
  if (headroom !== null && headroom < tokens) {
    // 프롬프트가 이미 창을 먹었다. 여기서 요청량을 그대로 밀면 재처리에 빠지므로
    // 남은 만큼만 준다. headroom이 음수여도 MIN까지는 요청한다 — 그보다 적게 주면
    // 어차피 답이 안 나오고, 넘치는 것 자체는 auto-compact가 막을 일이다.
    tokens = Math.max(MIN_REPLY_TOKENS, headroom);
    reason = 'context-capped';
  }
  return { tokens: Math.max(1, tokens), reason };
}

/**
 * 이 프롬프트로는 쓸모 있는 답이 나올 수 없는가 — 창이 이미 다 찼는가.
 *
 * 여기서 true면 **호출하지 말아야 한다.** 넘겨 봐야 LM Studio는 400을 내거나
 * 컨텍스트를 조용히 재처리해서 타임아웃까지 간다(실측: 300초를 태우고 실패).
 * 실패할 걸 알면서 부르는 건 시간만 버리는 것이므로, 상위 AI에 돌려주는 게 맞다.
 * 창 크기를 모르면(null) 판단하지 않는다 — 모른다고 거부하지는 않는다.
 * @param {{contextLength?:number|null, promptTokens?:number}} p
 */
function exceedsContext(p) {
  const headroom = headroomFor(p.contextLength, p.promptTokens);
  return headroom !== null && headroom < MIN_REPLY_TOKENS;
}

/**
 * 잘린 응답을 한 번 더 시도할 때 쓸 예산. 늘릴 여지가 없으면 0(재시도하지 말 것).
 * 잘렸다는 건 실제 필요량이 used보다 크다는 뜻이므로 두 배를 노리되, 창을 넘기지
 * 않는다. 1.5배도 확보 못 하면 다시 불러 봐야 또 잘린다 — 시간만 두 배로 쓴다.
 * @param {{used:number, contextLength?:number|null, promptTokens?:number}} p
 * @returns {number}
 */
function retryReplyTokens(p) {
  const used = Math.max(1, Math.floor(Number(p.used) || 0));
  const want = used * 2;
  const headroom = headroomFor(p.contextLength, p.promptTokens);
  const tokens = headroom === null ? want : Math.min(want, headroom);
  return tokens >= Math.ceil(used * 1.5) ? tokens : 0;
}

/**
 * 이번 응답에서 관측된 추론 비율. 측정할 수 없으면 null(통계를 오염시키지 않는다).
 *
 * **잘린 응답(finish_reason=length)은 관측이 아니다.** 생각하다 끊긴 것이라
 * reasoning/completion이 1에 가까워지는데, 이건 그 모델의 성향이 아니라 예산이
 * 모자랐다는 사실일 뿐이다. 그대로 EMA에 넣으면 "이 모델은 예산의 100%를 추론에
 * 쓴다"고 학습해 다음 예산이 상한까지 부풀고, 창에 막혀 또 잘린다 — 악순환이다.
 * (실측: 0.63 → 0.66 → 0.70 → 0.85 → 0.999로 폭주하며 파인튜닝 생성이 연속 실패)
 *
 * @param {{completion_tokens?:number}} usage
 * @param {number} reasoningTokens
 * @param {string} [finishReason]
 * @returns {number|null}
 */
function observedReasoningRatio(usage, reasoningTokens, finishReason) {
  if (finishReason === 'length') return null;
  const completion = Number((usage || {}).completion_tokens) || 0;
  if (completion <= 0) return null;
  return Math.min(1, Math.max(0, Number(reasoningTokens) || 0) / completion);
}

module.exports = {
  planReplyTokens, retryReplyTokens, observedReasoningRatio, exceedsContext,
  MAX_REASONING_SHARE, MIN_REPLY_TOKENS, SAFETY_TOKENS,
};

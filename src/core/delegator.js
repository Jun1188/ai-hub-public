// 로컬 모델 호출 엔진: 소스 Q&A·렌더 파이프라인·심층 분석·파인튜닝 생성·파이프라인 ai 단계가
// 각자 만든 컨텍스트로 LM Studio(또는 실행 중인 llama.cpp) 모델을 한 번 부른다.
// 1.29.0에서 메모리 회상·세션·자동 압축·스킬 프리앰블·실익 게이트를 뺐다 — 호출자가 컨텍스트를
// 이미 고르므로 여기서 덧붙이면 창만 넘친다(.claude/rules/local-model-prompts.md).
'use strict';

const config = require('./config');
const lmstudio = require('./lmstudio');
const gpufit = require('./gpufit');
const stats = require('./stats');
const replyBudget = require('./reply-budget');

const TASK_TYPES = ['gamedev', 'programming', 'reasoning', 'custom'];

/**
 * 시간 예산을 **호출자가 정한다.** 여기에 기본값을 두지 않는다.
 *
 * 작은 모델이 오래 끄는 건 "곧 좋은 답이 나온다"가 아니라 "이 태스크는 이 모델의 것이
 * 아니다"라는 뜻이다(실측 2026-07-30: 12B가 리뷰 하나에 171초를 쓰고 본문 0자).
 * 그런데 `taskType`에 예산을 걸면 안 된다 — 영역 분류일 뿐이라 같은 `custom`에 300토큰
 * 추출과 UE 렌더러 전체 분석이 같이 들어간다(renderpipe 분석이 통째로 잘린 적 있다).
 * 기본값은 `config.lmstudio.timeoutMs`(전역 상한)이고 짧아야 마땅한 호출만 `timeoutMs`를 준다.
 */

// Which task types each capability tier is trusted with.
const TIER_ALLOWS = {
  high: ['gamedev', 'programming', 'reasoning', 'custom'],
  medium: ['programming', 'reasoning', 'custom'],
  low: ['reasoning', 'custom'],
};

/** Heuristic tier for models the user hasn't classified in the GUI. */
function guessTier(modelId) {
  const id = modelId.toLowerCase();
  if (/embed|rerank|whisper|tts|ocr/.test(id)) return 'none';
  const size = (() => {
    const m = id.match(/(\d+)\s*b\b/);
    return m ? parseInt(m[1], 10) : 0;
  })();
  const coder = /coder|codestral|deepseek-?coder|starcoder|codellama|devstral/.test(id);
  if (size >= 27 || (coder && size >= 13)) return 'high';
  if (size >= 12 || coder) return 'medium';
  return 'low';
}

function tierOf(modelId) {
  const cfg = config.load();
  return cfg.delegation.modelTiers[modelId] || guessTier(modelId);
}

/**
 * 이 컴퓨터에 그 모델이 있는가. 컴퓨터마다 LM Studio에 설치된 모델이 다르므로,
 * 공유된 설정이나 파이프라인에 박힌 모델 이름을 그대로 믿을 수 없다.
 * listModelsDetailed는 4초 캐시라 위임 경로에 추가 HTTP가 생기지 않는다.
 */
async function hasModel(modelId) {
  try {
    return (await lmstudio.listModelsDetailed()).some((m) => m.id === modelId);
  } catch {
    // LM Studio가 응답하지 않으면 확인할 수 없다. 후퇴시키면 routeModel이 실제 원인을 낸다.
    return false;
  }
}

const CODER_RE = /coder|codestral|deepseek-?coder|starcoder|codellama|devstral|qwen.*coder/;

/** 1 if the model family fits the task type, 0 otherwise. */
function affinity(modelId, taskType) {
  const coder = CODER_RE.test(modelId.toLowerCase());
  if (taskType === 'reasoning') return coder ? 0 : 1; // prefer general models for text/analysis
  if (taskType === 'gamedev' || taskType === 'programming') return coder ? 1 : 0;
  return 0; // custom: neutral
}

/**
 * GPU에 들어가는 모델인가를 순위에 쓸 수 있는 형태로. **측정 전이면 0(중립)** —
 * 모르는 걸 근거로 순위를 바꾸면 안 된다. 캐시만 읽으므로 I/O가 없다.
 */
function fitScore(modelId) {
  const fits = gpufit.fitsCached(modelId);
  return fits === null ? 0 : (fits ? 1 : -1);
}

// 히든 추론에 완료 토큰의 이만큼 넘게 쓰는 모델은 같은 길이의 답에 몇 배의 시간을 쓴다
// (실측 2026-07-30: gemma-4-12b-qat 완료 3057토큰 중 2347=77%가 추론, 247초).
const HIGH_OVERHEAD_RATIO = 0.5;
// 오버헤드 비용은 출력 길이에 비례하므로 긴 답을 요구할 때만 따진다.
const LONG_REPLY_TOKENS = 800;

/** 이 모델이 히든 추론에 시간을 과하게 쓰는가. **관측 전이면 0(중립)** — 이름으로 맞히지 않는다. */
function overheadScore(modelId) {
  const ratio = stats.reasoningRatioOf(modelId);
  if (ratio === null) return 0;
  return ratio >= HIGH_OVERHEAD_RATIO ? -1 : 1;
}

/**
 * Pick the best available model allowed to run the given task type.
 * Sort order: already-loaded first (avoids multi-minute cold loads and client
 * timeouts), then GPU fit, then capability tier, then task affinity, then speed.
 *
 * fit이 loaded 다음인 이유: VRAM을 넘긴 모델은 일부가 CPU에서 돌아 5~15배 느리지만
 * (gpufit.js), 안 떠 있는 모델을 대신 고르면 콜드 로드가 수십 초다. 그러니 **이미 떠
 * 있는 것들 사이에서만** 들어가는 쪽을 고른다. 긴 답에서만 추론 오버헤드가 loaded보다
 * 앞선다 — 콜드 로드는 한 번이지만 오버헤드는 출력 길이에 비례해 계속 붙는다.
 *
 * @param {number} [replyTokens] 이 호출이 요구할 응답 토큰 수(모르면 생략)
 */
async function routeModel(taskType, requestedModel, replyTokens) {
  const detailed = (await lmstudio.listModelsDetailed().catch(()=>require('./model-control').catalog('lmstudio'))).filter((m) => m.type !== 'embeddings');
  const ids = detailed.map((m) => m.id);
  if (requestedModel) {
    if (!ids.includes(requestedModel)) {
      throw new Error(`Model "${requestedModel}" is not available in LM Studio. Available: ${ids.join(', ')}`);
    }
    return requestedModel;
  }
  const cfg = config.load();
  if (cfg.delegation.defaultModel && ids.includes(cfg.delegation.defaultModel)) {
    const t = tierOf(cfg.delegation.defaultModel);
    if ((TIER_ALLOWS[t] || []).includes(taskType)) return cfg.delegation.defaultModel;
  }
  const ranked = { high: 3, medium: 2, low: 1, none: 0 };
  const candidates = detailed
    .map((m) => ({
      id: m.id,
      tier: tierOf(m.id),
      loaded: m.state === 'loaded' ? 1 : 0,
      fit: fitScore(m.id),
      overhead: overheadScore(m.id),
      aff: affinity(m.id, taskType),
      ema: stats.latencyOf(m.id),
    }))
    .filter((x) => (TIER_ALLOWS[x.tier] || []).includes(taskType));
  const longReply = Number(replyTokens) >= LONG_REPLY_TOKENS;
  candidates.sort((a, b) =>
    (longReply ? b.overhead - a.overhead : 0) ||
    b.loaded - a.loaded ||
    b.fit - a.fit ||
    ranked[b.tier] - ranked[a.tier] ||
    b.aff - a.aff ||
    (a.ema ?? Infinity) - (b.ema ?? Infinity)
  );
  if (!candidates.length) {
    throw new Error(
      `No local model is capable enough for task type "${taskType}". ` +
      `Load a larger model in LM Studio or lower the task type.`
    );
  }
  return candidates[0].id;
}

/**
 * Delegate one self-contained task to a local model.
 * @param {{prompt:string, taskType?:string, model?:string, modelFallback?:boolean, backend?:string,
 *          systemPrompt?:string, context?:string, temperature?:number, maxTokens?:number,
 *          timeoutMs?:number, source?:string, signal?:AbortSignal}} p
 */
async function delegate(p) {
  const taskType = TASK_TYPES.includes(p.taskType) ? p.taskType : 'reasoning';
  const cfg = config.load();
  // 저장된 설정·파이프라인에 박힌 모델은 이 컴퓨터에 없을 수 있다. `modelFallback`을
  // 켠 호출(파이프라인)만 예외 대신 자동 라우팅으로 후퇴한다 — 호출자가 방금 지정한
  // 모델은 조용히 바꾸지 않고 오류로 알려야 한다.
  const backend = p.backend === 'llamacpp' ? 'llamacpp' : 'lmstudio';
  const inference = backend === 'llamacpp' ? require('./local-runtime') : lmstudio;
  let requested = p.model;
  let modelFallback = null;
  let model;
  if (backend === 'llamacpp') {
    const available = await inference.listModelsDetailed();
    model = requested ? available.find(m=>m.id===requested)?.id : (available[0] && available[0].id);
    if (!model) throw new Error('llama.cpp 서버에 로드된 모델이 없습니다.');
  } else {
    if (requested && p.modelFallback && !(await hasModel(requested))) {
      modelFallback = { requested };
      requested = undefined;
    }
    model = await routeModel(taskType, requested, p.maxTokens ?? cfg.delegation.defaultMaxTokens);
    if (modelFallback) modelFallback.used = model;
    gpufit.noteRouted(model);
  }

  // 작은 모델은 지시가 데이터 앞에 있으면 데이터를 되풀이하다 만다 — 지시는 데이터 뒤에 둔다.
  const systemParts = [];
  if (cfg.delegation.userGlobalPrompt) systemParts.push(`## Additional standing instructions from the user\n${cfg.delegation.userGlobalPrompt}`);
  if (p.systemPrompt) systemParts.push(`## Task-specific instructions from the caller\n${p.systemPrompt}`);
  const userContent = p.context ? `## Context\n${p.context}\n\n## Task\n${p.prompt}` : p.prompt;
  const messages = [];
  if (systemParts.length) messages.push({ role: 'system', content: systemParts.join('\n\n---\n\n') });
  messages.push({ role: 'user', content: userContent });

  // ---- 응답 토큰 예산 --------------------------------------------------------
  // 추론형 모델은 max_tokens를 히든 추론에 먼저 쓰고 본문을 자른다. 모델별로 관측된 비율만큼
  // 미리 부풀려 잡는다(reply-budget.js).
  let ctxLen = null;
  try {
    const info = (await inference.listModelsDetailed()).find((m) => m.id === model);
    ctxLen = (info && info.contextLength) || null;
  } catch { /* 창 크기를 모르면 제한 없이 진행 (LM Studio 구버전·응답 없음) */ }
  const requestedReply = p.maxTokens ?? cfg.delegation.defaultMaxTokens;
  const reasoningRatio = stats.reasoningRatioOf(model);

  const started = Date.now();
  // 로컬 GPU는 프로세스 전역 슬롯으로 직렬화한다(hardware-optimizer.withLocalSlot). 슬롯 대기는
  // 추론 지연이 아니므로 EMA와 시간 예산 계산에서 뺀다.
  let queuedMs = 0;
  const chat = (args) => {
    const waitFrom = Date.now();
    if(backend==='llamacpp')return inference.chat(args);
    return require('./hardware-optimizer').withLocalSlot(async()=>{
      queuedMs+=Date.now()-waitFrom;
      const ready=await require('./model-control').ensure({provider:'lmstudio',model:args.model,signal:p.signal});
      return inference.chat({...args,model:ready.model});
    },{signal:p.signal});
  };
  const promptPreview = p.prompt.slice(0, 120);
  // 누가 맡겼는지(파이프라인·소스 Q&A 등)를 이력에 남긴다. 통합 활동 기록이 구분해 보여 준다.
  const sourceTag = p.source ? { source: String(p.source).slice(0, 40) } : {};
  const escalate = (reason, skipped, extra = {}) => {
    const out = {
      content: `NEEDS_ESCALATION: ${reason}`, model, taskType, tier: tierOf(model),
      escalationRequested: true, elapsedMs: Date.now() - started - queuedMs, usage: {}, skipped,
      ...(modelFallback ? { modelFallback } : {}), ...extra,
    };
    stats.record({ taskType, model, promptPreview, elapsedMs: out.elapsedMs, ok: true, escalationRequested: true, tokens: 0, skipped, ...sourceTag });
    return out;
  };
  try {
    const promptTokens = inference.estimateTokens(messages.reduce((n, m) => n + m.content.length, 0));
    // 답변이 들어갈 자리가 없으면 부르지 않는다 — LM Studio가 400을 내거나 컨텍스트를
    // 재처리하며 타임아웃까지 간다(실측 300초 소모 후 실패). 상위 AI가 처리하게 돌려준다.
    if (replyBudget.exceedsContext({ contextLength: ctxLen, promptTokens })) {
      return escalate(`프롬프트 약 ${promptTokens}토큰이 ${model}의 컨텍스트 ${ctxLen}토큰을 채워 답변 공간이 없습니다`, 'context');
    }

    const plan = replyBudget.planReplyTokens({
      requested: requestedReply, reasoningRatio, contextLength: ctxLen, promptTokens,
    });
    const temperature = p.temperature ?? cfg.delegation.defaultTemperature;
    // 호출자가 안 주면 전역 상한. taskType으로 추측하지 않는다(위 주석 참고).
    const timeoutMs = p.timeoutMs || cfg.lmstudio.timeoutMs;
    let result = await chat({ model, messages, temperature, maxTokens: plan.tokens, timeoutMs });

    // 잘렸으면 한 번만 더 — 늘릴 여지가 있을 때만(없으면 시간만 두 배로 쓴다).
    let retriedReply = null;
    if (result.finishReason === 'length' && cfg.delegation.retryOnTruncation !== false) {
      const bigger = replyBudget.retryReplyTokens({
        used: plan.tokens, contextLength: ctxLen, promptTokens,
      });
      if (bigger) {
        retriedReply = { from: plan.tokens, to: bigger };
        // 재시도에는 **남은 예산만** 준다. 통째로 다시 주면 한 번의 위임이 상한의 두 배를 쓴다.
        const left = timeoutMs - (Date.now() - started - queuedMs);
        if (left > 5000) {
          result = await chat({ model, messages, temperature, maxTokens: bigger, timeoutMs: left });
        }
      }
    }

    const observedRatio = replyBudget.observedReasoningRatio(result.usage, result.reasoningTokens, result.finishReason);
    const out = {
      content: result.content,
      model,
      backend,
      taskType,
      tier: tierOf(model),
      escalationRequested: /^NEEDS_ESCALATION:/m.test(result.content),
      elapsedMs: Date.now() - started - queuedMs,
      usage: result.usage,
      // 예산에 걸려 아직도 잘렸다면 호출자가 알아야 한다 — content만 보면 모른다.
      ...(result.finishReason === 'length' ? { truncated: true } : {}),
      ...(retriedReply ? { retriedReply } : {}),
      ...(modelFallback ? { modelFallback } : {}),
    };
    stats.record({
      taskType,
      model,
      promptPreview,
      elapsedMs: out.elapsedMs,
      ok: true,
      escalationRequested: out.escalationRequested,
      tokens: (result.usage && result.usage.total_tokens) || 0,
      ...(observedRatio === null ? {} : { reasoningRatio: observedRatio }),
      ...(out.truncated ? { truncated: true } : {}),
      ...sourceTag,
    });
    return out;
  } catch (err) {
    // 시간 예산 초과는 **고장이 아니다.** 이 모델에 안 맞는 태스크였다는 관측이므로
    // 컨텍스트 초과와 똑같이 NEEDS_ESCALATION으로 돌려준다.
    const elapsedMs = Date.now() - started - queuedMs;
    if (/안에 없습니다|토큰을 내보내다 멈췄습니다/.test(String((err && err.message) || ''))) {
      return escalate(`${model}이 ${Math.round(elapsedMs / 1000)}초 안에 끝내지 못했습니다 (${taskType} 예산 초과)`, 'time');
    }
    stats.record({
      taskType,
      model,
      promptPreview,
      elapsedMs,
      ok: false,
      error: String(err.message || err).slice(0, 300),
      ...sourceTag,
    });
    throw err;
  }
}

module.exports = {
  delegate, routeModel, tierOf, guessTier, hasModel, TASK_TYPES, TIER_ALLOWS,
  HIGH_OVERHEAD_RATIO, LONG_REPLY_TOKENS,
};

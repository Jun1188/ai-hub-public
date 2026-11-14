// Minimal LM Studio client over its OpenAI-compatible REST API.
'use strict';

const config = require('./config');
const baseUrl = require('./local-endpoints').lmstudioBaseUrl;

/** undici의 headers/body 타임아웃인가. 이름은 undici 내부값이라 문자열로 본다. */
function isFetchTimeout(err) {
  const cause = err && err.cause;
  if (!cause) return false;
  return /HeadersTimeout|BodyTimeout|UND_ERR_(HEADERS|BODY)_TIMEOUT/i.test(
    `${cause.name || ''} ${cause.code || ''}`
  );
}

async function request(pathname, options = {}) {
  const cfg = config.load();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.lmstudio.timeoutMs);
  try {
    const broker=require('./credential-broker'),action=pathname==='/v1/models'?'models':pathname==='/api/v0/models'?'legacyModels':null;
    if(!action)throw new Error('Unsupported LM Studio metadata operation');
    const res=await broker.requestResponse({credentialRef:'credential:lmstudio',operationId:'lmstudio.'+action,jobId:broker.jobId('lm-metadata'),payload:{}},{signal:controller.signal,timeoutMs:Math.max(100,Math.min(cfg.lmstudio.timeoutMs,1800000))});
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LM Studio ${pathname} -> HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
    return await res.json();
  } catch (err) {
    // fetch가 내는 'fetch failed'만 보면 원인을 알 수 없다. 컴퓨터마다 LM Studio
    // 포트가 다를 수 있으니 실제로 어디에 걸었는지 붙여서 다시 던진다.
    if (err && (err.name === 'AbortError' || controller.signal.aborted)) {
      throw new Error(`LM Studio 응답이 ${cfg.lmstudio.timeoutMs}ms 안에 없습니다 (${baseUrl()}${pathname}). 큰 모델의 콜드 로딩이면 설정에서 타임아웃을 늘리세요.`);
    }
    // fetch(undici)는 자체 headers/body 타임아웃(기본 300초)을 갖고 있고, 그게 걸리면
    // AbortError가 아니라 **TypeError('fetch failed')**로 온다. 이걸 연결 실패로 뭉뚱그리면
    // "LM Studio가 실행 중인지 확인하세요"라는 정반대 안내가 나간다 — LM Studio는 멀쩡히
    // 돌고 있고 그냥 느린 것뿐인데. cause를 봐서 갈라놓는다.
    if (err?.timedOut || (err instanceof TypeError && isFetchTimeout(err))) {
      throw new Error(`LM Studio가 응답을 시작하지 않아 시간이 초과됐습니다 (${baseUrl()}${pathname}). 모델이 콜드 로딩 중이거나 프롬프트가 컨텍스트를 넘겨 재처리 중일 수 있습니다.`);
    }
    if (err instanceof TypeError || err?.code === 'BROKER_OUTCOME_UNKNOWN') {
      throw new Error(`LM Studio에 연결할 수 없습니다: ${baseUrl()} — LM Studio가 실행 중인지, 설정의 주소·포트가 이 컴퓨터와 맞는지 확인하세요.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** @returns {Promise<string[]>} model ids currently available in LM Studio */
async function listModels() {
  const data = await request('/v1/models');
  return (data.data || []).map((m) => m.id);
}

/**
 * Detailed model list via LM Studio's native REST API, including load state.
 * Falls back to the OpenAI-compatible list (state: 'unknown') on older versions.
 * @returns {Promise<Array<{id:string, state:'loaded'|'not-loaded'|'unknown', type:string}>>}
 */
// Short-lived cache: one delegation consults the model list twice (routing +
// context budgeting) and batch flows (finetune-gen) call in
// rapid succession — without this every call was
// an extra HTTP round-trip to LM Studio.
let detailedCache = null; // { at, data }
const DETAILED_TTL_MS = 4000;

async function listModelsDetailed() {
  if (detailedCache && Date.now() - detailedCache.at < DETAILED_TTL_MS) return detailedCache.data;
  let out;
  try {
    const data = await request('/api/v0/models');
    out = (data.data || []).map((m) => ({
      id: m.id,
      state: m.state || 'unknown',
      type: m.type || 'llm',
      // actual usable context: loaded value when available, else model max
      contextLength: m.loaded_context_length || m.max_context_length || null,
    }));
  } catch {
    const ids = await listModels();
    out = ids.map((id) => ({ id, state: 'unknown', type: 'llm' }));
  }
  detailedCache = { at: Date.now(), data: out };
  return out;
}

async function isAlive() {
  try {
    await listModels();
    return true;
  } catch {
    return false;
  }
}

/**
 * 모델이 아직 안 떠서 나는 **일시적** 실패인가.
 *
 * LM Studio는 요청이 오면 모델을 그때 로드(JIT)하는데, 같은 모델을 두 요청이 동시에
 * 부르면 한쪽 로드를 취소하고 400을 낸다. 실측(2026-07-29): 학습 Q&A 두 번이 연달아
 * "Failed to load model ... Operation canceled"로 죽었는데, 그 사이 로드는 끝나 있어서
 * 잠시 뒤엔 1초 만에 응답했다. 이건 고장이 아니라 타이밍이므로 실패로 올리면 안 된다.
 */
function isTransientLoadError(message) {
  return /Failed to load model[\s\S]*Operation canceled|Model unloaded/i.test(String(message || ''));
}

/** 그 모델이 로드될 때까지 기다린다(캐시를 거치지 않고 직접 조회). 못 기다리면 false. */
async function waitForModel(model, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const data = await request('/api/v0/models');
      const info = (data.data || []).find((m) => m.id === model);
      if (info && info.state === 'loaded') return true;
    } catch { /* 조회 실패는 무시하고 다시 시도 */ }
  }
  return false;
}

/**
 * Run a chat completion on a local model.
 * @param {{model:string, messages:Array<{role:string,content:string}>, temperature?:number, maxTokens?:number}} p
 * @returns {Promise<{content:string, model:string, usage:object}>}
 */
async function chat(p) {
  try {
    return await chatOnce(p);
  } catch (err) {
    if (!isTransientLoadError(err && err.message)) throw err;
    // 로드가 끝나기를 기다렸다가 **한 번만** 다시 시도한다. 무작정 자는 대신
    // 실제 상태를 보고 기다린다 — 14B 콜드 로드는 30초를 넘기도 한다.
    detailedCache = null; // 방금 실패했으니 캐시된 상태는 못 믿는다
    await waitForModel(p.model);
    return chatOnce(p);
  }
}

/**
 * 채팅 한 번. **스트리밍으로 받는다.**
 *
 * 왜 stream:false가 아닌가 (2026-07-30 실측): fetch(undici)에는 설정과 무관한
 * headersTimeout(기본 300초)이 있다. stream:false면 LM Studio는 생성이 **다 끝난 뒤에야**
 * 첫 바이트를 보내므로, 5분 넘게 걸리는 호출은 헤더 타임아웃에 걸려 죽는다 —
 * `lmstudio.timeoutMs`를 아무리 올려도 소용이 없고, 에러는 TypeError('fetch failed')로
 * 와서 "LM Studio가 실행 중인지 확인하세요"라는 엉뚱한 안내가 나갔다.
 * 스트리밍이면 헤더가 즉시 오므로 AbortController(=설정값)가 진짜 타임아웃이 된다.
 *
 * 반환 형태는 stream:false 때와 **같아야 한다** — 호출자(delegator·reply-budget)는
 * finish_reason과 reasoning_tokens로 예산을 학습한다. LM Studio는 include_usage로
 * 마지막 청크에 usage를 실어 주고 거기에 reasoning_tokens도 들어온다(확인함).
 */
async function chatOnce(p) {
  const cfg = config.load();
  // 호출자가 더 짧은 예산을 줄 수 있다. 작은 모델이 오래 끄는 건 "곧 좋은 답이 나온다"가
  // 아니라 "이 태스크는 이 모델의 것이 아니다"라는 신호다(delegator의 TIME_BUDGET_MS).
  // 전역 설정값을 넘길 수는 없다 — 그건 사용자가 정한 상한이다.
  const timeoutMs = Math.min(p.timeoutMs || cfg.lmstudio.timeoutMs, cfg.lmstudio.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // 내려간 모델을 JIT(LM Studio 기본값 = GPU 최대)로 올리지 않고 입장 판정으로 먼저 올린다. 일시 실패 뒤 재시도도 이 길로 온다.
    try { await require('./model-control').ready({ model: p.model, signal: controller.signal }); }
    catch (err) { throw controller.signal.aborted ? describeTransportError(err, timeoutMs, true) : err; }
    // 전송 오류만 이 try 안에서 잡는다. 스트림을 읽다 난 오류까지 여기서 뭉뚱그리면
    // 코드 버그가 "LM Studio가 실행 중인지 확인하세요"로 둔갑한다 — 바로 위 request()에서
    // 고친 것과 같은 실수다.
    let res;
    try {
      const broker=require('./credential-broker');
      res=await broker.requestResponse({credentialRef:'credential:lmstudio',operationId:'lmstudio.chat',jobId:broker.jobId('lm-chat'),payload:{body:{
        model:p.model,messages:p.messages,temperature:p.temperature??0.2,max_tokens:p.maxTokens??4096,stream:true,stream_options:{include_usage:true}
      }}},{signal:controller.signal,timeoutMs:Math.max(100,Math.min(timeoutMs,1800000))});
    } catch (err) {
      throw describeTransportError(err, timeoutMs, controller.signal.aborted);
    }
    if (!res.ok) {
      // 오류는 스트림이 아니라 본문 하나로 온다(JIT 로드 취소의 400 포함).
      const body = await res.text().catch(() => '');
      throw new Error(`LM Studio /v1/chat/completions -> HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
    try {
      return await readChatStream(res, p.model);
    } catch (err) {
      if (err && err.name === 'AbortError') throw describeTransportError(err, timeoutMs);
      if (err?.timedOut || (err instanceof TypeError && isFetchTimeout(err))) {
        throw new Error(`LM Studio가 토큰을 내보내다 멈췄습니다 (${baseUrl()}). 컨텍스트 재처리에 빠졌을 수 있습니다.`);
      }
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 전송 단계(fetch 자체)의 실패를 사람이 읽을 수 있는 오류로. */
function describeTransportError(err, timeoutMs, aborted = false) {
  if (err && (err.name === 'AbortError' || aborted)) {
    return new Error(`LM Studio 응답이 ${timeoutMs}ms 안에 없습니다 (${baseUrl()}). 큰 모델의 콜드 로딩이면 설정에서 타임아웃을 늘리세요.`);
  }
  if (err?.timedOut || (err instanceof TypeError && isFetchTimeout(err))) {
    return new Error(`LM Studio가 응답을 시작하지 않아 시간이 초과됐습니다 (${baseUrl()}).`);
  }
  if (err instanceof TypeError || err?.code === 'BROKER_OUTCOME_UNKNOWN') {
    return new Error(`LM Studio에 연결할 수 없습니다: ${baseUrl()} — LM Studio가 실행 중인지, 설정의 주소·포트가 이 컴퓨터와 맞는지 확인하세요.`);
  }
  return err;
}

/** SSE 본문을 모아 stream:false와 같은 모양으로 되돌린다. */
async function readChatStream(res, fallbackModel) {
  const decoder = new TextDecoder();
  let pending = '';
  let content = '';
  let model = fallbackModel;
  let finishReason = '';
  let usage = {};
  let streamError = null;

  for await (const part of res.body) {
    pending += decoder.decode(part, { stream: true });
    const lines = pending.split('\n');
    // 마지막 조각은 잘렸을 수 있으니 다음 청크와 이어 붙인다.
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue; // 깨진 청크 하나 때문에 응답 전체를 잃지 않는다
      }
      // 생성 도중 모델이 내려가면 LM Studio는 `event: error`와 {"error":{"message":"terminated"}}로 끝낸다.
      // 무시하면 빈 답이 성공처럼 돌아간다(2026-10-22 실측: 렌더링 분석이 빈 답으로 "성공").
      if (chunk.error) { streamError = String(chunk.error.message || chunk.message || 'unknown'); continue; }
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const choice = (chunk.choices || [])[0];
      if (!choice) continue;
      if (choice.delta && typeof choice.delta.content === 'string') content += choice.delta.content;
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }
  if (streamError) throw new Error(`LM Studio 응답이 오류로 끝났습니다: ${streamError} (생성 중 모델이 내려갔거나 취소됨)`);

  return {
    content,
    model,
    usage,
    // 예산에 걸려 잘렸는지는 content만 봐서는 알 수 없다 — 문장 중간에서 끊겨도
    // 그럴듯해 보인다. finish_reason='length'가 유일한 신호다(reply-budget.js).
    finishReason,
    // 추론형 모델이 히든 추론에 쓴 몫. 모델별 예산 부풀림의 관측 근거가 된다.
    reasoningTokens: (usage.completion_tokens_details || {}).reasoning_tokens || 0,
  };
}

// ~2.2 chars/token — 코드·한국어는 산문보다 토큰화가 나쁘므로 보수적으로 잡는다.
// promptBudget과 delegator의 자동 압축이 같은 계수를 써야 판단이 일관된다.
const CHARS_PER_TOKEN = 2.2;

/** 문자 수 → 추정 토큰 수 (보수적). */
function estimateTokens(chars) {
  return Math.ceil(Number(chars) / CHARS_PER_TOKEN);
}

/**
 * Prompt budget for callers that assemble their own context (source Q&A,
 * render-pipeline analysis). Exceeding the loaded n_ctx is not a clean error
 * in LM Studio — it either 400s or silently re-processes the context, turning
 * a 10 s call into minutes — so this stays deliberately conservative:
 * CHARS_PER_TOKEN chars/token, 30% of the window for injected data,
 * ~22% for the answer, the rest slack.
 * @returns {Promise<{chars:number, maxTokens:number, contextLength:number|null}>}
 */
async function promptBudget(model) {
  let contextLength = null;
  try {
    const detailed = await listModelsDetailed();
    const info = model ? detailed.find((m) => m.id === model) : detailed.find((m) => m.state === 'loaded');
    if (info && info.contextLength) contextLength = info.contextLength;
  } catch { /* LM Studio down — use defaults */ }
  if (!contextLength) return { chars: 4000, maxTokens: 900, contextLength: null };
  return {
    chars: Math.max(1000, Math.min(24000, Math.floor(contextLength * CHARS_PER_TOKEN * 0.3))),
    maxTokens: Math.max(350, Math.min(1600, Math.floor(contextLength * 0.22))),
    contextLength,
  };
}

module.exports = {
  listModels, listModelsDetailed, isAlive, chat, baseUrl, promptBudget,
  estimateTokens, CHARS_PER_TOKEN, isTransientLoadError,
};

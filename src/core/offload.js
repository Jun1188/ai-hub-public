// offload — 큰 입력은 작업자가 직접 읽고, 작고 검증 가능한 결과만 한 번 돌려주는 위임 경로.
//
// 왜: 1.28까지의 위임은 호출자가 harness_status를 폴링할 때마다 세션 전체(프롬프트·출력 최대
// 64K자)를 받아 위임 한 번에 요청 7~20회를 썼고, 로컬 7~14B는 추론·리뷰에서 실패했다(실측
// 2026-10). 이 PC의 로컬 모델이 해내는 건 스키마로 묶인 추출·분류·형식 변환뿐이다. 그래서
//  - 파일은 작업자가 읽고, 결과는 압축 형태로만 돌려준다. 작업 지시·파일 내용·프롬프트는 되돌리지 않는다.
//  - 기다림은 서버 쪽 long-poll(최대 50초)이다 — 호출자가 sleep·폴링 루프를 돌지 않게.
//  - 로컬이 못 받으면 클라우드로 몰래 돌리지 않고 declined를 돌려준다. 호출자가 직접 한다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const replyBudget = require('./reply-budget');
const { normalize } = require('./offload-request'); // 요청 계약(작업자·tier·묶음·상한)

const MAX_RECORDS = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CHUNKS = 64;
// 로컬 브로커가 요청 본문을 64 KiB로 묶는다(credential-broker.js). 한글 3바이트·JSON 이스케이프 여유.
const MAX_CHUNK_CHARS = 12000;
const CHARS_PER_TOKEN = 2.2; // lmstudio.js와 같은 보수적 근사
const CHAT_TIMEOUT_MS = 300000;
// 큰 답에는 그 답을 낼 시간을 준다. 300초 고정이면 부분 오프로드(gemma-4-12b 0.53, 7.07 tok/s)에서 2048토큰 답이
// 끝나기 전에 끊겼다(2026-10-23 2계층 part 1). 1024토큰 이하(기본 offload)는 예전 300초 그대로다.
const MIN_TOKENS_PER_SEC = 5;
const replyTimeoutMs = (maxTokens) => Math.min(1800000, Math.max(CHAT_TIMEOUT_MS, 60000 + Math.ceil(maxTokens / MIN_TOKENS_PER_SEC) * 1000));
const CODEX_TIMEOUT_SEC = 1200;
const AGY_TIMEOUT_SEC = 600;

/** JSON Schema의 작은 부분집합(type·required·properties·items·enum)만 본다. 위반이 없으면 null. */
function validate(value, schema, at = '$') {
  if (!schema || typeof schema !== 'object') return null;
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) return at + ': enum';
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const types = schema.type === undefined ? [] : [].concat(schema.type);
  if (types.length && !types.some((t) => t === kind || (t === 'integer' && Number.isInteger(value)))) return at + ': type';
  if (kind === 'object') {
    for (const key of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, key)) return `${at}.${key}: required`;
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      const error = Object.prototype.hasOwnProperty.call(value, key) ? validate(value[key], sub, `${at}.${key}`) : null;
      if (error) return error;
    }
    if (schema.additionalProperties === false && Object.keys(value).some((k) => !(schema.properties || {})[k])) return at + ': additional';
  }
  if (kind === 'array' && schema.items) {
    for (let i = 0; i < value.length; i++) { const error = validate(value[i], schema.items, `${at}[${i}]`); if (error) return error; }
  }
  return null;
}

const parseJson = (text) => JSON.parse(String(text).trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1'));
const coded = (reason) => Object.assign(new Error(reason), { offloadReason: reason });
const declined = (reason) => Object.assign(new Error(reason), { declined: reason });

/** 실패 사유는 정해진 짧은 코드로만 돌려준다 — 백엔드 오류 본문에 입력이 섞여 있을 수 있다. */
function reasonOf(e) {
  const m = String((e && e.message) || '');
  if (e && e.offloadReason) return e.offloadReason;
  if (e && e.status) return 'http_' + e.status;
  if (/credential/i.test(m)) return 'blocked_secret_like_text';
  if (/exceeds 64 KiB/.test(m)) return 'chunk_too_large';
  if (/Codex CLI not found/.test(m)) return 'codex_cli_not_found';
  if (/^Codex exit (-?\d+)/.test(m)) return 'codex_exit_' + m.match(/^Codex exit (-?\d+)/)[1];
  if (/timed out|timeout/i.test(m)) return 'timeout';
  if (/outcome unknown|transport|connect/i.test(m)) return 'backend_unreachable';
  return 'worker_failed';
}

async function readInput(file) {
  const read = (async () => {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw coded('not_a_file');
    if (stat.size > MAX_FILE_BYTES) throw coded('file_too_large');
    const data = await fs.promises.readFile(file);
    if (data.includes(0)) throw coded('binary_file');
    return data.toString('utf8').replace(/^\uFEFF/, '');
  })();
  // 공유 드라이브 경로가 멈춰도 작업 전체가 매달리지 않게(규칙 1·9).
  return require('./promise-timeout').withTimeout(read, 15000, () => coded('read_timeout'));
}

function split(text, size) {
  const out = [];
  for (let i = 0; i < text.length;) {
    let end = Math.min(text.length, i + size);
    const newline = end < text.length ? text.lastIndexOf('\n', end) : -1;
    if (newline > i + size / 2) end = newline + 1;
    out.push(text.slice(i, end)); i = end;
  }
  return out.length ? out : [''];
}

function createStore(file) {
  let records = null;
  function load() {
    if (records) return records;
    let text;
    // 없으면 빈 기록. EBUSY 같은 읽기 오류는 던지고 다음 호출에서 다시 읽는다 — 멀쩡한 파일을 깨진 것으로 치우지 않게(규칙 6).
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; return (records = []); }
    try {
      const value = JSON.parse(text);
      if (!Array.isArray(value.records)) throw new Error('invalid offload record file');
      records = value.records.map((r) => (r.state === 'running' ? { ...r, state: 'failed', reason: 'interrupted_by_restart' } : r));
    } catch {
      // 깨진 기록은 지우지 않고 옆으로 치운다. 치우지 못하면 다음 쓰기가 덮으므로 던진다.
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      records = [];
    }
    return records;
  }
  function put(record) {
    const list = load();
    const i = list.findIndex((r) => r.id === record.id);
    if (i >= 0) list[i] = record; else list.push(record);
    while (list.length > MAX_RECORDS) list.shift();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schema: 'offload-jobs/1', records: list }), 'utf8');
    fs.renameSync(tmp, file);
  }
  return { load, put, get: (id) => load().find((r) => r.id === id) };
}

function createOffload(deps = {}) {
  const events = new EventEmitter();
  const hardware = () => deps.hardware || require('./hardware-optimizer');
  const prepare = deps.prepare || ((p) => require('./model-control').ensure(p));
  const selectLocal = deps.selectLocal || ((p) => require('./local-model-select').choose(p));
  const runCodex = deps.runCodex || ((p) => require('./agent-workers').runCodex(p));
  const runAgy = deps.runAgy || ((p) => require('./agent-workers').runAgy(p));
  const store = createStore(deps.file || path.join(require('./paths').hubDataDir(), 'offload.local', 'jobs.json'));
  const live = new Map();

  // 저장 기록에는 작업 지시·파일 경로·내용·결과 값을 넣지 않는다. caller는 진입 경로와 MCP 클라이언트 이름(agy면 대화 id까지)뿐이다(caller.js).
  // 로컬은 쓴 창과 조각 수도 남긴다 — 큰 입력이 작은 창에서 여러 조각으로 갈린 것을 결과만 보고 알 수 있게.
  const windowOf = (j) => ({ ...(j.contextLength ? { contextLength: j.contextLength } : {}), ...(j.chunks ? { chunks: j.chunks } : {}) });
  const record = (j) => ({ id: j.id, state: j.state, caller: j.caller, worker: j.worker, model: j.model, placement: j.placement, ...windowOf(j), ...(j.tier ? { tier: j.tier } : {}),
    ...(j.tasks ? { tasks: j.tasks } : {}), ...(j.expert ? { expert: j.expert } : {}), createdAt: j.createdAt,
    finishedAt: j.finishedAt ? new Date(j.finishedAt).toISOString() : null, inputs: j.inputs, resultCount: j.results.length,
    failureCount: j.failures.length, verification: { ...j.verification }, usage: { ...j.usage }, ...(j.reason ? { reason: j.reason } : {}),
    ...(j.hardware ? { hardware: j.hardware } : {}) });
  function view(j) {
    const out = { id: j.id, state: j.state };
    if (j.state === 'succeeded' || (j.state !== 'running' && j.results.length)) out.results = j.results; // 성공한 0건은 results: []
    if (j.state !== 'running' && j.failures.length) out.failures = j.failures;
    if (j.reason) out.reason = j.reason;
    out.verification = { ...j.verification };
    out.usage = { ...j.usage, workerMs: j.usage.workerMs ?? Date.now() - j.startedAt };
    out.route = { worker: j.worker, model: j.model, placement: j.placement, ...windowOf(j), ...(j.tier ? { tier: j.tier } : {}) };
    if (j.hardware) out.hardware = j.hardware;
    if (j.expert) out.expert = j.expert;
    return out;
  }
  // 재시작 전 작업은 결과 값을 저장하지 않았으므로 상태만 돌려준다.
  function stored(id) {
    const r = store.get(id);
    if (!r) throw new Error('Unknown offload job id');
    return { id: r.id, state: r.state, ...(r.reason ? { reason: r.reason } : {}), verification: r.verification,
      usage: r.usage, route: { worker: r.worker, model: r.model, placement: r.placement, ...(r.tier ? { tier: r.tier } : {}) }, resultsRetained: false };
  }

  function finish(j, state, reason) {
    if (j.state !== 'running') return;
    Object.assign(j, { state, finishedAt: Date.now(), pid: null }, reason ? { reason } : {});
    j.usage.workerMs = j.finishedAt - j.startedAt;
    j.usage.runMs = j.usage.workerMs - j.usage.waitMs;
    if (deps.onFinish) try { j.hardware = deps.onFinish(j) || null; } catch { /* 측정 실패는 결과를 막지 않는다 */ }
    try { store.put(record(j)); } catch { /* 기록 실패가 결과를 막지 않는다 */ }
    events.emit('finish', record(j));
    j.resolve();
  }

  function addUsage(j, usage) {
    const fields = { inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens,
      cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens };
    const inputTokens = typeof fields.inputTokens === 'string' && /^\d+$/.test(fields.inputTokens) ? Number(fields.inputTokens) : fields.inputTokens;
    for (const [key, raw] of Object.entries(fields)) {
      const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
      const impossibleCache = key === 'cachedInputTokens' && Number.isSafeInteger(inputTokens) && n > inputTokens;
      j.usage[key] = j.usage[key] === null || !Number.isSafeInteger(n) || n < 0 || impossibleCache ? null : j.usage[key] + n;
    }
  }

  /**
   * 가장 긴 입력 조각 하나가 지시·답과 함께 창에 들어가는 컨텍스트(1024 단위 올림, 32768 상한). 큰 지시(평가 기준표)를 조각마다 붙이면
   * 6144 창에서는 조각이 작게 쪼개져 근거가 흩어진다(2026-10-23 2계층: 4조각). 청하기만 한다 — 실제 창은 입장 판정이 정한다.
   */
  function wantedContext(units, instruction, maxOutputTokens) {
    const longest = Math.min(MAX_CHUNK_CHARS, Math.max(...units.map((u) => u.text.length)));
    const prompt = Math.ceil((longest + instruction.length + 64) / CHARS_PER_TOKEN);
    const reply = replyBudget.planReplyTokens({ requested: maxOutputTokens }).tokens;
    return Math.min(32768, Math.ceil((prompt + reply + replyBudget.SAFETY_TOKENS) / 1024) * 1024);
  }

  async function routeLocal(units, input, instruction) {
    const cfg = require('./config').load();
    if (cfg.localRuntimes && cfg.localRuntimes.llamaModelPath) {
      const llama = await require('./local-runtime').llamaStatus();
      const m = llama.running && llama.models.find((x) => x.state === 'loaded' && !x.failed);
      if (m) return { provider: 'llamacpp', model: m.id, placement: 'llamacpp-server', contextLength: m.contextLength || 4096 };
    }
    // 서버가 꺼져 있어도 지금 예산에 들어가는 잰 모델이 있으면 그것을 고른다. 기동·적재는 item()의 prepare(ensure)가
    // 같은 승인 기준으로 한다. 잰 모델이 없거나 안 들어가면 아래 어드바이저 경로(LM Studio)로 간다.
    const pick = await selectLocal({ contextLength: wantedContext(units, instruction, input.maxOutputTokens) }).catch(() => ({ picked: null }));
    if (pick.picked) {
      if (pick.picked.provider === 'lmstudio') require('./gpufit').noteRouted(pick.picked.model);
      return pick.picked;
    }
    const hw = hardware();
    await hw.refresh();
    const longest = Math.min(MAX_CHUNK_CHARS, Math.max(...units.map((u) => u.text.length)));
    const advice = hw.advise({ kind: 'extract', interactive: false, privacy: 'local-only',
      estInputTokens: Math.ceil((longest + instruction.length) / CHARS_PER_TOKEN), estOutputTokens: input.maxOutputTokens });
    if (advice.route !== 'local' || !advice.model) throw declined('local_not_viable: ' + (advice.reasons || []).slice(0, 4).join(', '));
    const info = (await require('./lmstudio').listModelsDetailed().catch(() => [])).find((m) => m.id === advice.model);
    const contextLength = info && info.state === 'loaded' && info.contextLength ? info.contextLength : advice.ctxTokens || 4096;
    require('./gpufit').noteRouted(advice.model);
    return { provider: 'lmstudio', model: advice.model, placement: advice.placement || null, contextLength };
  }

  function localChat({ provider, model, messages, maxTokens, schema, signal }) {
    const body = { model, messages, max_tokens: maxTokens, temperature: 0 };
    // offload는 추출·분류라 추론 토큰이 필요 없다. 켜 두면 gemma-4-12b가 답 예산 1024를 추론에 다 써서 빈 답(schema_invalid)
    // 이었고, 끄자 같은 8건이 7건 만점·스키마 위반 0이었다(2026-10-18). 추론형이 아닌 모델에서는 무시된다.
    if (provider === 'lmstudio') body.reasoning_effort = 'none';
    if (provider === 'llamacpp') body.chat_template_kwargs = { enable_thinking: false };
    if (schema && provider === 'lmstudio') body.response_format = { type: 'json_schema', json_schema: { name: 'offload_item', schema, strict: true } };
    if (schema && provider === 'llamacpp') body.json_schema = schema;
    const base = provider === 'lmstudio' ? require('./lmstudio').baseUrl() + '/v1' : require('./local-runtime').llamaClientConnection().apiBase;
    const broker = require('./credential-broker');
    const timeoutMs = replyTimeoutMs(maxTokens);
    return require('./local-chat-stream').chat({ url: base + '/chat/completions', body, signal, timeoutMs,
      fetchFn: (_url, options) => broker.requestResponse({ credentialRef: 'credential:' + provider, operationId: provider + '.chat',
        jobId: broker.jobId('offload'), payload: { body: JSON.parse(options.body) } }, { signal: options.signal, timeoutMs }) });
  }

  async function readUnits(j, input, signal) {
    const units = [];
    for (const file of input.files) {
      try { const text = await readInput(file); units.push({ file, text }); j.usage.filesRead++; j.usage.bytesRead += Buffer.byteLength(text); }
      catch (e) { if (signal.aborted) throw e; j.failures.push({ file, reason: e.offloadReason || 'read_failed' }); }
    }
    if (input.text) units.push({ text: input.text });
    if (!units.length) throw coded('no_readable_input');
    return units;
  }

  async function runLocal(j, input, signal) {
    const units = await readUnits(j, input, signal);
    // 지시는 데이터 뒤에 둔다(.claude/rules/local-model-prompts.md). 스키마도 프롬프트 예산에 넣는다.
    const instruction = `\n\n## Task\n${input.task}` + (input.schema
      ? `\nReply with only one JSON value that matches this JSON Schema:\n${JSON.stringify(input.schema)}` : '');
    // 전문가 재프롬프팅 접두부: 모든 조각이 같은 바이트로 시작해 로컬 서버가 앞부분 KV를 다시 쓸 수 있다. 예산에는 그대로 센다 —
    // 자리가 없으면 아래 size 검사가 거절한다(작업 본문은 자르지 않는다).
    const lead = input.expertLead || '';
    const route = await routeLocal(units, input, lead + instruction);
    Object.assign(j, { model: route.model, placement: route.placement, contextLength: route.contextLength });
    const reply = replyBudget.planReplyTokens({ requested: input.maxOutputTokens, contextLength: route.contextLength }).tokens;
    const room = route.contextLength - reply - Math.ceil((lead.length + instruction.length + 64) / CHARS_PER_TOKEN) - replyBudget.SAFETY_TOKENS;
    const size = Math.min(MAX_CHUNK_CHARS, Math.floor(room * CHARS_PER_TOKEN));
    if (size < 500) throw declined('task_or_schema_exceeds_model_context');
    const chunks = units.flatMap((u) => split(u.text, size).map((text, i, all) => ({ file: u.file, chunk: all.length > 1 ? i + 1 : undefined, of: all.length, text })));
    if (chunks.length > MAX_CHUNKS) throw declined(`input_exceeds_${MAX_CHUNKS}_chunks`);
    j.chunks = chunks.length;
    const ratio = require('./stats').reasoningRatioOf(route.model);
    for (const c of chunks) {
      signal.throwIfAborted();
      const where = { ...(c.file ? { file: c.file } : {}), ...(c.chunk ? { chunk: c.chunk } : {}) };
      const content = `${lead}## Input${c.of > 1 ? ` (part ${c.chunk}/${c.of})` : ''}\n${c.text}${instruction}`;
      const maxTokens = replyBudget.planReplyTokens({ requested: input.maxOutputTokens, reasoningRatio: ratio,
        contextLength: route.contextLength, promptTokens: Math.ceil(content.length / CHARS_PER_TOKEN) }).tokens;
      try { j.results.push({ ...where, value: await item(j, route, content, maxTokens, input.schema, signal) }); }
      catch (e) { if (e.declined || signal.aborted) throw e; j.failures.push({ ...where, reason: reasonOf(e) }); }
    }
  }

  /** 한 덩어리를 한 번 부르고, 형식이 틀리거나 잘렸으면 딱 한 번만 다시 부른다. */
  async function item(j, route, content, maxTokens, schema, signal) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const asked = Date.now();
      const out = await hardware().withLocalSlot(async () => {
        j.usage.waitMs += Date.now() - asked; // G-4: time queued for the GPU slot, apart from running
        let ready;
        try { ready = await prepare({ provider: route.provider, model: route.model, contextLength: route.contextLength, signal }); }
        catch (e) { if (signal.aborted) throw e; throw declined('model_not_admitted: ' + String(e.message || e).slice(0, 120)); }
        try {
          return await localChat({ ...route, model: ready.model, messages: [{ role: 'user', content }], maxTokens, schema, signal });
        } catch (err) { addUsage(j, null); throw err; }
      }, { signal });
      addUsage(j, out.usage);
      if (out.finishReason === 'length') continue;
      if (!schema) { if (out.content.trim()) return out.content.trim(); continue; }
      let value;
      try { value = parseJson(out.content); } catch { continue; }
      if (!validate(value, schema)) { j.verification.schemaValid++; return value; }
    }
    if (schema) j.verification.schemaInvalid++;
    throw coded(schema ? 'schema_invalid' : 'empty_or_truncated');
  }

  // 클라우드 작업자는 한 번에 여러 결과를 내므로 항목 스키마를 {items:[...]}로 감싼다.
  const wrapItems = (schema) => (schema ? { type: 'object', properties: { items: { type: 'array', items: schema } }, required: ['items'], additionalProperties: false } : null);
  function collectItems(j, items, schema, where = {}) {
    if (!Array.isArray(items)) { j.verification.schemaInvalid++; j.failures.push({ ...where, reason: 'schema_invalid' }); return; }
    // 스키마에 맞는 빈 items는 「0건」이라는 답이다(2026-10-18 사용자 결정). 전에는 no_result로 실패해 정답이 0건인 작업과 구별되지 않았다.
    if (!items.length) j.answeredEmpty = true;
    for (const value of items) {
      if (validate(value, schema)) { j.verification.schemaInvalid++; j.failures.push({ ...where, reason: 'schema_invalid' }); }
      else { j.verification.schemaValid++; j.results.push({ ...where, value }); }
    }
  }

  async function runRemote(j, input, signal) {
    const wrapped = wrapItems(input.schema);
    const prompt = [input.task,
      input.files.length ? 'Read these files yourself (read-only):\n' + input.files.map((f) => '- ' + f).join('\n') : '',
      input.text ? '## Input\n' + input.text : '',
      wrapped ? 'Reply with only JSON that matches this schema, one entry in "items" per result:\n' + JSON.stringify(wrapped) : 'Reply with only the final answer.',
    ].filter(Boolean).join('\n\n');
    require('./prompt-safety').assertNoSecrets(prompt);
    j.model = 'codex-cli-default';
    j.placement = 'cloud';
    const cwd = input.files.length ? path.dirname(input.files[0]) : os.tmpdir();
    const strict = require('./schema-strict');
    const { output } = await runCodex({ prompt, cwd, schema: wrapped && strict.toStrict(wrapped), timeoutSec: CODEX_TIMEOUT_SEC, signal, onSpawn: (pid) => { j.pid = pid; trackWorker(j, pid); } });
    if (!wrapped) { j.results.push({ value: output.trim() }); return; }
    let items;
    try { const value = parseJson(output); items = Array.isArray(value) ? value : value.items; } catch { /* 아래에서 형식 오류로 센다 */ }
    collectItems(j, Array.isArray(items) ? items.map((v) => strict.dropNullOptionals(v, input.schema)) : items, input.schema);
  }

  // agy 한 번. verification은 schemaValid·schemaInvalid처럼 결과를 낸 시도만 말한다(2026-10-18 사용자 결정). usage는 모든 시도의 합이다.
  async function agyAttempt(j, params) {
    const before = { inputTokens: j.usage.inputTokens, outputTokens: j.usage.outputTokens };
    delete j.verification.toolDenied;
    let out;
    try {
      out = await runAgy({ ...params, timeoutSec: AGY_TIMEOUT_SEC,
        onSpawn: (pid, model) => {
          j.pid = pid; j.model = model; trackWorker(j, pid);
          // 모델을 부른 뒤로는 agy가 usage를 줄 때까지 쓴 양을 모른다. 실패·취소로 끝나면 0이 아니라 null로 남는다.
          j.usage.inputTokens = j.usage.outputTokens = null;
        } });
    } catch (e) { if (e.toolDenied) j.verification.toolDenied = true; throw e; }
    Object.assign(j.usage, before);
    j.model = out.model;
    const u = out.usage || {};
    addUsage(j, { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens });
    if (out.toolDenied) j.verification.toolDenied = true;
    return out;
  }

  // agy: Hub가 읽은 입력을 agent-workers.runAgy가 마스킹해 임시 폴더에 둔다. 형식이 틀리면 한 번만 다시 돌린다.
  async function runAgyJob(j, input, signal) {
    const units = await readUnits(j, input, signal);
    const wrapped = wrapItems(input.schema);
    const prompt = input.task + (wrapped ? '\n\nPut one entry in "items" per result.' : '\n\nReply with only the final answer.');
    const inputs = units.map((u) => ({ name: u.file ? path.basename(u.file) : 'input.txt', text: u.text }));
    j.placement = 'cloud';
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await agyAttempt(j, { prompt, inputs, schema: wrapped, model: input.model, tier: input.tier, signal });
      if (!wrapped) { const text = String(out.response || '').trim(); if (text) { j.results.push({ value: text }); return; } continue; }
      const items = out.structured && out.structured.items;
      if (attempt === 0 && (!Array.isArray(items) || items.some((v) => validate(v, input.schema)))) continue;
      collectItems(j, items, input.schema);
      return;
    }
    throw coded('empty_or_truncated');
  }

  // 작은 작업 여러 개를 agy 한 번(차례 하나)에 묶는다. 2026-10-18 실측(작업 10개, 입력 163 KB, 정확도는 셋 다 같음): 작업마다
  // 실행 244초·입력 239k토큰, 묶음 49초·84k. 한 세션에서 작업마다 차례를 이어 가면 335초·캐시 읽기 1.25M이라 채택하지 않았다.
  // 작업은 1부터 센 번호(task)로 결과·실패에 붙는다. 형식이 틀린 작업만 모아 한 번 더 묶어 돌린다.
  async function runAgyBatch(j, input, signal) {
    const texts = new Map(), unread = new Map();
    for (const file of input.files) {
      try { const text = await readInput(file); texts.set(file, text); j.usage.filesRead++; j.usage.bytesRead += Buffer.byteLength(text); }
      catch (e) { if (signal.aborted) throw e; unread.set(file, e.offloadReason || 'read_failed'); }
    }
    let pending = [];
    input.tasks.forEach((t, i) => {
      // 입력을 다 읽지 못한 작업은 보내지 않는다 — 그 작업의 빈 답을 「0건」으로 믿을 수 없다.
      const missing = t.files.find((f) => unread.has(f));
      if (missing) j.failures.push({ task: i + 1, file: missing, reason: unread.get(missing) }); else pending.push({ ...t, n: i + 1 });
    });
    j.placement = 'cloud';
    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      const files = [...new Set(pending.flatMap((t) => t.files))];
      const withText = pending.filter((t) => t.text);
      const inputs = [...files.map((f) => ({ name: path.basename(f), text: texts.get(f) })), ...withText.map((t) => ({ name: `task-${t.n}.txt`, text: t.text }))];
      // runAgy가 입력 파일 이름 앞에 1부터 번호를 붙인다. 작업은 그 번호로 자기 입력을 가리킨다.
      const numbers = (t) => [...t.files.map((f) => files.indexOf(f) + 1), ...(t.text ? [files.length + withText.indexOf(t) + 1] : [])];
      const key = (t) => `task_${t.n}`;
      const schema = { type: 'object', properties: Object.fromEntries(pending.map((t) => [key(t), wrapItems(t.schema)])),
        required: pending.map(key), additionalProperties: false };
      const prompt = 'Do each task below. Each task uses only its own inputs; answer every task.\n\n'
        + pending.map((t) => `Task ${t.n} (inputs ${numbers(t).join(', ')}): ${t.task}`).join('\n\n')
        + '\n\nInput N is the listed file whose name starts with "N-". Put each task\'s answer under "task_<task number>", '
        + 'with one entry in "items" per result.';
      let out;
      try { out = await agyAttempt(j, { prompt, inputs, schema, model: input.model, tier: input.tier, signal }); }
      catch (e) {
        // 다시 돌린 묶음이 실패·거절돼도 첫 묶음에서 받은 결과는 버리지 않는다. 사유는 다시 돌린 작업에 붙는다.
        if (attempt === 0 || signal.aborted) throw e;
        for (const t of pending) j.failures.push({ task: t.n, reason: e.declined || reasonOf(e) });
        return;
      }
      const answers = out.structured && typeof out.structured === 'object' ? out.structured : {};
      const retry = [];
      for (const t of pending) {
        const items = answers[key(t)] && answers[key(t)].items;
        if (attempt === 0 && (!Array.isArray(items) || items.some((v) => validate(v, t.schema)))) retry.push(t);
        else collectItems(j, items, t.schema, { task: t.n });
      }
      pending = retry;
    }
  }

  async function execute(j, input) {
    const signal = j.controller.signal;
    try {
      await (input.tasks ? runAgyBatch : { codex: runRemote, agy: runAgyJob }[input.worker] || runLocal)(j, input, signal);
      // 읽지 못한 입력이 있으면 빈 답을 「0건」으로 믿지 않는다.
      const ok = j.results.length || (j.answeredEmpty && !j.failures.length);
      finish(j, ok ? 'succeeded' : 'failed', ok ? undefined : (j.failures[0] && j.failures[0].reason) || 'no_result');
    } catch (e) {
      if (signal.aborted) finish(j, 'cancelled');
      else if (e.declined) finish(j, 'declined', e.declined);
      else finish(j, 'failed', reasonOf(e));
    }
  }

  function run(raw) {
    const input = normalize(raw);
    const counted = input.worker !== 'codex'; // local·agy는 Hub가 파일을 읽으므로 사용량을 센다
    let resolve;
    const j = { id: crypto.randomUUID(), state: 'running', caller: require('./caller').current(), worker: input.worker, tier: input.tier, model: null, placement: null, pid: null,
      startedAt: Date.now(), createdAt: new Date().toISOString(), ...(input.tasks ? { tasks: input.tasks.length } : {}), ...(input.expert ? { expert: input.expert } : {}),
      inputs: input.files.length + (input.tasks ? input.tasks.filter((t) => t.text).length : input.text ? 1 : 0),
      results: [], failures: [], verification: { schemaValid: 0, schemaInvalid: 0 },
      usage: { workerMs: null, waitMs: 0, runMs: null, inputTokens: counted ? 0 : null, cachedInputTokens: input.worker === 'local' ? 0 : null, outputTokens: counted ? 0 : null, filesRead: counted ? 0 : null, bytesRead: counted ? 0 : null },
      controller: new AbortController(), done: new Promise((r) => { resolve = r; }) };
    j.resolve = resolve;
    live.set(j.id, j);
    for (const [id, old] of live) { if (live.size <= MAX_RECORDS) break; if (old.state !== 'running') live.delete(id); }
    try { store.put(record(j)); } catch { /* 기록 실패가 작업을 막지 않는다 */ }
    if (deps.onStart) try { deps.onStart(j); } catch { /* 측정 실패는 작업을 막지 않는다 */ }
    events.emit('start', record(j));
    execute(j, input);
    return j.id;
  }

  async function wait(id, waitS = 45) {
    const j = live.get(id);
    if (!j) return stored(id);
    const ms = Math.max(0, Math.min(50, Number(waitS) || 0)) * 1000;
    if (j.state === 'running' && ms > 0) {
      let timer;
      await Promise.race([j.done, new Promise((r) => { timer = setTimeout(r, ms); })]);
      clearTimeout(timer);
    }
    return view(j);
  }

  function cancel(id) {
    const j = live.get(id);
    if (!j) return stored(id);
    if (j.state === 'running') { j.controller.abort(new Error('Cancelled')); finish(j, 'cancelled'); }
    return view(j);
  }

  return {
    run, wait, cancel, events,
    runAndWait: async (raw, waitS) => wait(run(raw), waitS),
    active: () => [...live.values()].filter((j) => j.state === 'running')
      .map((j) => ({ id: j.id, worker: j.worker, model: j.model, startedAt: j.createdAt, pid: j.pid, caller: j.caller || null })),
    list: () => store.load().map((r) => ({ ...r })),
  };
}

// codex·agy 작업자는 우리 자식 프로세스다. 띄운 PID를 작업에 묶지 않으면 자원 기록의 작업이 "프로세스 0개"로 남는다.
function trackWorker(j, pid) {
  require('./telemetry').trackProcess(pid, { jobId: `offload-${j.id}`, kind: 'offload', label: `offload ${j.worker}` });
}

// The local model runs in LM Studio/llama-server, not as our child, so the job's hardware cost is the
// machine-level GPU power/energy while it ran (telemetry job span), reported with the result.
const telemetryHooks = () => {
  const telemetry = require('./telemetry');
  return {
    onStart: (j) => telemetry.beginJob(`offload-${j.id}`, { kind: 'offload', label: `offload ${j.worker}` }),
    onFinish: (j) => {
      const u = telemetry.endJob(`offload-${j.id}`, j.state), board = u && u.gpuBoard;
      return board ? { scope: 'machine-while-running', energyWh: board.energyWh, powerAvgW: board.powerAvgW, throttleReasons: board.throttleReasons } : null;
    },
  };
};
let singleton;
const instance = () => singleton || (singleton = require('./work-table').watchOffload(createOffload(telemetryHooks())));
require('./change-signals').registerBusy('offload', () => (singleton ? singleton.active().length > 0 : false));

module.exports = {
  createOffload, validate, replyTimeoutMs, MAX_RECORDS,
  run: (...a) => instance().run(...a), runAndWait: (...a) => instance().runAndWait(...a),
  wait: (...a) => instance().wait(...a), cancel: (...a) => instance().cancel(...a),
  active: () => (singleton ? singleton.active() : []), list: () => instance().list(),
  get events() { return instance().events; },
};

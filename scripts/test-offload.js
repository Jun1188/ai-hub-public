'use strict';
// offload 회귀 테스트: 루프백 HTTP 서버를 가짜 LM Studio로 띄워 실제 브로커·스트리밍 경로를 탄다.
// 확인: 압축 결과에 작업 지시·파일 내용이 없다, 스키마 검증과 1회 재시도, declined, long-poll 조기 반환,
// 취소, 기록 영속성·상한·손상 격리, codex 작업자 결과 형식. 실제 모델·Codex는 부르지 않는다.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-offload-test-'));
process.env.APPDATA = SANDBOX;
const config = require('../src/core/config');
const offload = require('../src/core/offload');

const TASK = 'TASK-TEXT-XYZ classify the input';
const SECRET = 'SECRET-FILE-CONTENT-123';
const schema = { type: 'object', properties: { label: { type: 'string', enum: ['ok', 'retry'] }, count: { type: 'integer' } },
  required: ['label'], additionalProperties: false };
const calls = [];
let slowMs = 0;

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (req.url === '/api/v0/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'fixture-model', state: 'loaded', type: 'llm', loaded_context_length: 4096 }] }));
    }
    const body = JSON.parse(raw);
    calls.push(body);
    const content = body.messages[0].content;
    const tries = calls.filter((c) => c.messages[0].content === content).length;
    let reply = JSON.stringify({ label: 'ok', count: 1 });
    if (/RETRY-CASE/.test(content) && tries === 1) reply = JSON.stringify({ label: 5 });
    if (/ALWAYS-BAD/.test(content)) reply = 'not json at all';
    const send = () => {
      try {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 3 } }) + '\n\ndata: [DONE]\n\n');
      } catch { /* client went away */ }
    };
    if (/SLOW/.test(content)) setTimeout(send, slowMs); else send();
  });
});

let advice = { route: 'local', model: 'fixture-model', placement: 'gpu-full', ctxTokens: 4096, reasons: [] };
const hardware = { refresh: async () => {}, advise: () => advice, withLocalSlot: (fn) => fn() };
const prepared = [];
const prepare = async (p) => { prepared.push(p); return { model: p.model, state: 'loaded' }; };
const file = path.join(SANDBOX, 'records', 'jobs.json');
// 잰 로컬 모델 자동 선택은 test-local-model-select.js가 본다. 여기서는 어드바이저 경로만 탄다.
let selected = { picked: null };
const make = (extra = {}) => offload.createOffload({ file, hardware, prepare, selectLocal: async () => selected, ...extra });

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  config.update({ lmstudio: { baseUrl: `http://127.0.0.1:${server.address().port}` } });
  const jobs = make();
  const events = [];
  jobs.events.on('start', (r) => events.push(['start', r.id]));
  jobs.events.on('finish', (r) => events.push(['finish', r.id, r.state]));

  // 1) 파일은 Hub가 읽고, 결과에는 작업 지시·파일 내용이 없다. 지시는 데이터 뒤에 둔다.
  const input = path.join(SANDBOX, 'input.txt');
  fs.writeFileSync(input, `line one ${SECRET}\nline two`, 'utf8');
  const one = await jobs.runAndWait({ task: TASK, files: [input], schema }, 10);
  assert.equal(one.state, 'succeeded');
  assert.deepEqual(one.results, [{ file: input, value: { label: 'ok', count: 1 } }]);
  assert.deepEqual(one.verification, { schemaValid: 1, schemaInvalid: 0 });
  assert.equal(calls.at(-1).reasoning_effort, 'none', 'extraction never spends the reply budget on reasoning tokens');
  assert.equal(one.usage.inputTokens, 10); assert.equal(one.usage.outputTokens, 3);
  assert.equal(one.usage.filesRead, 1); assert.equal(one.usage.bytesRead, Buffer.byteLength(fs.readFileSync(input, 'utf8')));
  assert.deepEqual(one.route, { worker: 'local', model: 'fixture-model', placement: 'gpu-full', contextLength: 4096, chunks: 1 });
  assert(!JSON.stringify(one).includes(SECRET) && !JSON.stringify(one).includes('TASK-TEXT'));
  const sent = calls[0];
  assert.deepEqual(sent.response_format, { type: 'json_schema', json_schema: { name: 'offload_item', schema, strict: true } });
  assert(sent.messages[0].content.indexOf(SECRET) < sent.messages[0].content.indexOf('TASK-TEXT'));
  assert.equal(prepared[0].contextLength, 4096);
  assert.deepEqual(events.slice(0, 2), [['start', one.id], ['finish', one.id, 'succeeded']]);

  // 2) 형식이 틀린 항목은 한 번만 다시 부른다
  calls.length = 0;
  const retried = await jobs.runAndWait({ task: TASK, text: 'RETRY-CASE', schema }, 10);
  assert.equal(retried.state, 'succeeded'); assert.equal(calls.length, 2);
  assert.deepEqual(retried.verification, { schemaValid: 1, schemaInvalid: 0 });
  assert.equal(retried.usage.inputTokens, 20);
  calls.length = 0;
  const bad = await jobs.runAndWait({ task: TASK, text: 'ALWAYS-BAD', schema }, 10);
  assert.equal(bad.state, 'failed'); assert.equal(calls.length, 2);
  assert.deepEqual(bad.failures, [{ reason: 'schema_invalid' }]); assert.equal(bad.reason, 'schema_invalid');
  assert.deepEqual(bad.verification, { schemaValid: 0, schemaInvalid: 1 });
  const missing = await jobs.runAndWait({ task: TASK, files: [path.join(SANDBOX, 'absent.txt'), input] }, 10);
  assert.equal(missing.state, 'succeeded');
  assert.deepEqual(missing.failures, [{ file: path.join(SANDBOX, 'absent.txt'), reason: 'read_failed' }]);
  assert.equal(missing.results[0].value, JSON.stringify({ label: 'ok', count: 1 }));

  // 3) 로컬이 못 받으면 클라우드로 돌리지 않고 declined
  calls.length = 0;
  advice = { route: 'defer', reasons: ['quality:low', 'no-local-capacity-within-gate', 'on-battery'] };
  const declined = await jobs.runAndWait({ task: TASK, text: 'anything' }, 10);
  assert.equal(declined.state, 'declined'); assert.match(declined.reason, /^local_not_viable: .*on-battery/);
  assert.equal(calls.length, 0); assert.deepEqual(declined.route, { worker: 'local', model: null, placement: null });
  // 3a) 서버가 꺼져 있어도 잰 모델이 예산에 들어가면 어드바이저(여기서는 거절)보다 먼저 그 모델을 준비해 쓴다
  selected = { picked: { provider: 'lmstudio', model: 'fixture-model', placement: 'gpu', contextLength: 6144, quality: 0.73 } };
  const viaSelect = await jobs.runAndWait({ task: TASK, text: 'anything' }, 10);
  assert.equal(viaSelect.state, 'succeeded', JSON.stringify(viaSelect)); assert.equal(viaSelect.route.placement, 'gpu');
  assert.deepEqual(prepared.at(-1), { provider: 'lmstudio', model: 'fixture-model', contextLength: 6144, signal: prepared.at(-1).signal });
  // 3b) 큰 지시(평가 기준표)는 조각마다 붙는다. 고르기에는 가장 긴 조각이 지시·답과 함께 들어가는 창을 청하고,
  //     그 창이 승인되면 남는 분할은 브로커 상한(12000자)뿐이다. 작은 창이면 조각이 늘 뿐 지시는 빠지지 않는다.
  const bigTask = 'RUBRIC-' + '규칙 문장을 반드시 지킨다. '.repeat(150) + ' TASK-END';
  const bigText = Array.from({ length: 900 }, (_, i) => `evidence line ${i} ${'x'.repeat(10)}`).join('\n'); // 약 25000자
  const asked = [];
  const withWindow = (contextLength) => make({ selectLocal: async (p) => { asked.push(p.contextLength); return { picked: { provider: 'lmstudio', model: 'fixture-model', placement: 'gpu', contextLength: contextLength || p.contextLength } }; } });
  calls.length = 0;
  const wide = await withWindow(null).runAndWait({ task: bigTask, text: bigText, schema }, 10);
  const wanted = asked.at(-1);
  assert.equal(wide.state, 'succeeded'); assert(wanted > 6144 && wanted <= 32768 && wanted % 1024 === 0, String(wanted));
  assert.deepEqual([wide.route.contextLength, wide.route.chunks], [wanted, Math.ceil(bigText.length / 12000)]);
  assert(calls.length === wide.route.chunks && calls.every((c) => c.messages[0].content.includes(bigTask)), 'the task rides on every part');
  calls.length = 0;
  const narrow = await withWindow(4096).runAndWait({ task: bigTask, text: bigText, schema }, 10);
  assert.equal(narrow.state, 'succeeded'); assert.equal(narrow.route.contextLength, 4096); assert(narrow.route.chunks > wide.route.chunks);
  assert(calls.every((c, i) => c.messages[0].content.includes(bigTask) && c.messages[0].content.startsWith(`## Input (part ${i + 1}/${narrow.route.chunks})`)));
  assert(calls.every((c) => Math.ceil(c.messages[0].content.length / 2.2) + c.max_tokens <= 4096), 'no part overflows the window it was cut for');
  await withWindow(null).runAndWait({ task: TASK, text: 'anything', schema }, 10);
  assert(asked.at(-1) <= 6144, 'small inputs do not ask for a wider window than before');
  // 3c) 큰 답에는 그 답을 낼 시간: 기본(1024토큰 이하)은 300초 그대로, 2048토큰은 470초, 상한 30분
  assert.deepEqual([1024, 1200, 2048, 40000].map(offload.replyTimeoutMs), [300000, 300000, 470000, 1800000]);
  selected = { picked: null };
  advice = { route: 'local', model: 'fixture-model', placement: 'gpu-full', ctxTokens: 4096, reasons: [] };
  const refused = make({ prepare: async () => { throw new Error('Model preparation deferred: ram_pressure'); } });
  const notAdmitted = await refused.runAndWait({ task: TASK, text: 'anything' }, 10);
  assert.equal(notAdmitted.state, 'declined'); assert.match(notAdmitted.reason, /^model_not_admitted: .*ram_pressure/);

  // 4) long-poll: 끝나는 즉시 돌아온다(대기 상한까지 붙잡지 않는다)
  slowMs = 400;
  const running = await jobs.runAndWait({ task: TASK, text: 'SLOW poll' }, 0);
  assert.equal(running.state, 'running'); assert(!('results' in running));
  const t0 = Date.now();
  const finished = await jobs.wait(running.id, 30);
  assert.equal(finished.state, 'succeeded'); assert(Date.now() - t0 < 5000, String(Date.now() - t0));
  assert.equal(jobs.active().length, 0);

  // 5) 취소: 실행 중인 작업을 멈추고 결과 형태는 같다
  slowMs = 3000;
  const toCancel = jobs.run({ task: TASK, text: 'SLOW cancel' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(jobs.active().length, 1); assert.equal(jobs.active()[0].id, toCancel);
  assert.equal(jobs.cancel(toCancel).state, 'cancelled');
  assert.equal((await jobs.wait(toCancel, 5)).state, 'cancelled');
  assert.equal(jobs.active().length, 0);
  assert.throws(() => jobs.cancel('00000000-0000-4000-8000-000000000000'), /Unknown offload job/);

  // 6) 입력 검증
  assert.throws(() => jobs.run({ task: TASK, files: ['relative.txt'] }), /absolute/);
  assert.throws(() => jobs.run({ task: TASK }), /files or text/);
  assert.throws(() => jobs.run({ task: '' , text: 'x' }), /task/);
  assert.throws(() => jobs.run({ task: TASK, text: 'x', worker: 'cloud' }), /worker/);

  // 7) codex 작업자: 파일은 Codex가 읽고, 항목마다 스키마를 검사한다
  let codexPrompt = '';
  const remote = make({ runCodex: async (p) => { codexPrompt = p.prompt; p.onSpawn(4321); return { output: JSON.stringify({ items: [{ label: 'ok' }, { label: 5 }] }) }; } });
  const viaCodex = await remote.runAndWait({ task: TASK, files: [input], schema, worker: 'codex' }, 10);
  assert.equal(viaCodex.state, 'succeeded'); assert.deepEqual(viaCodex.results, [{ value: { label: 'ok' } }]);
  assert.deepEqual(viaCodex.verification, { schemaValid: 1, schemaInvalid: 1 });
  assert(codexPrompt.includes(input) && !codexPrompt.includes(SECRET), 'Codex reads the files itself');
  assert.equal(viaCodex.usage.inputTokens, null); assert.equal(viaCodex.usage.filesRead, null);
  assert.equal(viaCodex.route.worker, 'codex');
  // 스키마에 맞는 빈 items는 「성공, 0건」이고, 재시작 뒤 기록에도 성공으로 남는다.
  const none = make({ runCodex: async () => ({ output: JSON.stringify({ items: [] }) }) });
  const zero = await none.runAndWait({ task: TASK, text: 'x', schema, worker: 'codex' }, 10);
  assert.equal(zero.state, 'succeeded'); assert.deepEqual(zero.results, []);
  assert.equal((await make().wait(zero.id, 0)).state, 'succeeded');

  // 7b) agy 작업자: Hub가 읽은 입력을 파일로 넘기고, 형식이 틀리면 한 번만 다시 돌리며, 사용량은 agy가 준 값만 쓴다
  const agyCalls = [];
  const agyReplies = [{ structured: { items: [{ label: 5 }] }, usage: { input_tokens: 7, output_tokens: 2 }, toolDenied: true, model: 'gemini-3.8-flash-low' },
    { structured: { items: [{ label: 'ok' }] }, usage: { input_tokens: 8, output_tokens: 3 }, model: 'gemini-3.8-flash-low' }];
  const viaAgy = make({ runAgy: async (p) => { agyCalls.push(p); p.onSpawn(99, 'gemini-3.8-flash-low'); return agyReplies.shift(); } });
  const agy = await viaAgy.runAndWait({ task: TASK, files: [input], schema, worker: 'agy' }, 10);
  assert.equal(agy.state, 'succeeded'); assert.deepEqual(agy.results, [{ value: { label: 'ok' } }]); assert.equal(agyCalls.length, 2);
  // verification은 결과를 낸 시도만 말한다: 버린 첫 시도의 거부는 남지 않는다. 사용량은 두 시도의 합이다
  assert.deepEqual(agy.verification, { schemaValid: 1, schemaInvalid: 0 });
  assert.equal(agy.usage.inputTokens, 15); assert.equal(agy.usage.outputTokens, 5); assert.equal(agy.usage.filesRead, 1);
  // 등급을 안 주면 fast(단순 작업). 등급은 결과 route와 저장 기록에 남는다
  assert.deepEqual(agy.route, { worker: 'agy', model: 'gemini-3.8-flash-low', placement: 'cloud', tier: 'fast' });
  assert(agyCalls.every((p) => p.tier === 'fast'));
  assert.equal(agyCalls[0].inputs[0].name, 'input.txt'); assert(agyCalls[0].inputs[0].text.includes(SECRET));
  assert(!agyCalls[0].prompt.includes(SECRET) && !agyCalls[0].prompt.includes(SANDBOX), 'inputs travel as files, not in the prompt');
  assert.deepEqual(agyCalls[0].schema.properties.items.items, schema);
  const agyDeclined = await make({ runAgy: async () => { throw Object.assign(new Error('agy_auth'), { declined: 'agy_auth' }); } })
    .runAndWait({ task: TASK, text: 'x', worker: 'agy' }, 10);
  assert.equal(agyDeclined.state, 'declined'); assert.equal(agyDeclined.reason, 'agy_auth');
  assert.equal(agyDeclined.usage.inputTokens, 0, 'declined before agy ran: nothing spent');
  // 마지막 시도가 agy를 띄운 뒤 실패하면 거부는 그 오류에서 남고, 앞 시도의 사용량이 있어도 합계는 모르니 null이다
  const firstTry = [{ structured: { items: [{ label: 5 }] }, usage: { input_tokens: 7, output_tokens: 2 }, model: 'm' }];
  const agyFailed = await make({ runAgy: async (p) => { p.onSpawn(98, 'm'); if (firstTry.length) return firstTry.shift();
    throw Object.assign(new Error('timeout'), { offloadReason: 'timeout', toolDenied: true }); } }).runAndWait({ task: TASK, text: 'x', schema, worker: 'agy' }, 10);
  assert.equal(`${agyFailed.state}:${agyFailed.reason}`, 'failed:timeout');
  assert.deepEqual(agyFailed.verification, { schemaValid: 0, schemaInvalid: 0, toolDenied: true });
  assert.deepEqual([agyFailed.usage.inputTokens, agyFailed.usage.outputTokens], [null, null]);
  let plainTier;
  const agyPlain = await make({ runAgy: async (p) => { plainTier = p.tier; return { response: ' plain ', usage: null, model: 'm' }; } })
    .runAndWait({ task: TASK, text: 'x', worker: 'agy', tier: 'reasoning' }, 10);
  assert.deepEqual(agyPlain.results, [{ value: 'plain' }]); assert.equal(agyPlain.usage.inputTokens, null);
  assert.equal(plainTier, 'reasoning'); assert.equal(agyPlain.route.tier, 'reasoning');
  assert.equal((await make().wait(agyPlain.id, 0)).route.tier, 'reasoning', 'tier survives a restart in the stored record');
  assert.throws(() => jobs.run({ task: TASK, worker: 'agy' }), /files or text/);
  assert.throws(() => jobs.run({ task: TASK, text: 'x', tier: 'reasoning' }), /only to worker agy/);
  const codexRoute = (await make({ runCodex: async () => ({ output: 'ok' }) }).runAndWait({ task: TASK, text: 'x', worker: 'codex' }, 10)).route;
  assert(!('tier' in codexRoute), 'tier is agy-only');

  // 8) 저장 기록: 지시·경로·내용·결과 값 없음, 재시작 뒤에도 상태 조회, 최대 200개, 손상 파일 격리
  const stored = fs.readFileSync(file, 'utf8');
  for (const secret of [SECRET, 'TASK-TEXT', SANDBOX.replace(/\\/g, '\\\\'), '"label"']) assert(!stored.includes(secret), secret);
  const reopened = make();
  const old = await reopened.wait(one.id, 0);
  assert.equal(old.state, 'succeeded'); assert.equal(old.resultsRetained, false); assert(!('results' in old));
  advice = { route: 'defer', reasons: ['on-battery'] };
  for (let i = 0; i < offload.MAX_RECORDS + 5; i++) await reopened.runAndWait({ task: TASK, text: 'x' }, 10);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).records.length, offload.MAX_RECORDS);
  const interrupted = JSON.parse(fs.readFileSync(file, 'utf8'));
  interrupted.records.push({ ...interrupted.records.at(-1), id: '11111111-1111-4111-8111-111111111111', state: 'running' });
  fs.writeFileSync(file, JSON.stringify(interrupted));
  assert.equal(make().list().at(-1).reason, 'interrupted_by_restart');
  fs.writeFileSync(file, 'broken');
  assert.deepEqual(make().list(), []);
  assert(fs.readdirSync(path.dirname(file)).some((f) => f.startsWith('jobs.json.corrupt-')));

  // 9) 작은 스키마 검사기
  const v = offload.validate;
  assert.equal(v({ a: [1, 2] }, { type: 'object', properties: { a: { type: 'array', items: { type: 'integer' } } } }), null);
  assert.match(v({ a: [1, 2.5] }, { type: 'object', properties: { a: { type: 'array', items: { type: 'integer' } } } }), /type/);
  assert.match(v({}, { type: 'object', required: ['a'] }), /required/);
  assert.match(v('x', { enum: ['y'] }), /enum/);
  assert.match(v({ a: 1, b: 2 }, { type: 'object', properties: { a: {} }, additionalProperties: false }), /additional/);
  assert.equal(v(null, { type: ['string', 'null'] }), null);

  console.log('Offload: compact output without task/file text, schema retry once, declined without cloud fallback, early long-poll, cancel, codex items, agy retry/usage/decline, private capped durable records passed');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  server.close();
  const target = path.resolve(SANDBOX);
  if (target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('hub-offload-test-')) fs.rmSync(target, { recursive: true, force: true });
});

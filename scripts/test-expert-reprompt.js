'use strict';
// 전문가 재프롬프팅(expert-reprompt.js) 회귀 테스트: 프레임워크 바이트 고정(캐시 계약), 결정적 적용/제외 판정,
// 제외면 접두부를 싣지 않음, offload 래퍼(local은 접두부 → 데이터 → 행동 지시, 원격은 접두부 → 요청 → 형식 레일).
// 실제 모델·Codex·agy는 부르지 않는다(가짜 LM Studio·작업자 대역).
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-expert-test-'));
process.env.APPDATA = SANDBOX;
const er = require('../src/core/expert-reprompt');
const { normalize } = require('../src/core/offload-request');

let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); } }

const INCLUDE = [
  'UE5 렌더링 파이프라인에서 Nanite와 Lumen의 데이터 흐름을 설계 관점에서 분석해줘',
  '우리 게임 프로젝트의 다음 분기 로드맵을 기획해줘',
  '이 보고서를 고도화해서 경영진용으로 다듬어줘',
  'Design a lock-free queue and analyze its consistency trade-offs',
  '서버가 가끔 멈추는데 근본 원인을 찾아줘',
  'ECS 아키텍처에서 SoA 레이아웃과 캐시 친화성의 절충을 정리해줘',
  '반도체 시장 동향과 투자 포트폴리오 비중을 분석해줘',
  'Profile the Electron main process and find the bottleneck',
  '이 영어 보고서를 한국어로 번역하면서 문장을 다듬고 구조를 고도화해줘',
];
const EXCLUDE = [
  ['안녕하세요', 'conversation'], ['thanks!', 'conversation'],
  ['오늘 서울 날씨 어때?', 'lookup'], ['what is the capital of France', 'lookup'],
  ['12*34+5는 얼마야?', 'arithmetic'], ['(3+4)*2', 'arithmetic'],
  ['이 문장을 영어로 번역해줘: 오늘은 좋은 날이다', 'translation'], ['translate "good morning" into Korean', 'translation'],
  ['스킬 목록 보여줘', 'settings'], ['다크 테마로 설정 바꿔줘', 'settings'],
  ['코드 고쳐줘', 'not-deep'], ['ok', 'trivial'],
];

(async () => {
  await check('framework bytes are pinned (changing them invalidates every prompt cache: bump VERSION and this hash)', () => {
    assert.equal(er.VERSION, 1);
    assert.equal(er.PREFIX_SHA256, '80e1b5a75383884809f188cd6163900687ec30fcdf52bb76cb7f1dcd30a9f041');
    assert.equal(er.PREAMBLE.bytes, 2426);
    assert(er.FRAMEWORK.includes('객관적 검증 수단 (External Verification)') && !/[ \t]$/m.test(er.FRAMEWORK));
  });

  await check('prefix is the same bytes for every request; the request only appears in the tail', () => {
    const a = er.wrap('첫 요청 A'), b = er.wrap('두 번째 요청 B, 2026-10-28 id=42');
    assert.equal(a.prefix, b.prefix);
    assert(a.prompt.startsWith(er.FRAMEWORK) && b.prompt.startsWith(er.FRAMEWORK));
    assert(!a.prefix.includes('요청 A') && a.prompt.endsWith('첫 요청 A'));
  });

  await check('local target puts the action instruction after the request (local-model-prompts rule)', () => {
    const w = er.wrap('렌더링 병목을 분석해줘', { target: 'local' });
    assert(w.prompt.startsWith(er.FRAMEWORK) && w.prompt.endsWith(er.LOCAL_TAIL));
    assert(w.prompt.indexOf('렌더링 병목을 분석해줘') > er.FRAMEWORK.length);
  });

  await check('include examples apply; exclude examples are skipped with their category', () => {
    for (const q of INCLUDE) assert.equal(er.classify(q).apply, true, q);
    for (const [q, cat] of EXCLUDE) {
      const v = er.classify(q);
      assert.equal(v.apply, false, q);
      assert.equal(v.category, cat, q);
    }
  });

  await check('verdicts are deterministic and force overrides an exclusion', () => {
    for (const q of [...INCLUDE, ...EXCLUDE.map((e) => e[0])]) assert.deepEqual(er.classify(q), er.classify(q));
    assert.equal(er.classify('안녕하세요', { force: true }).apply, true);
  });

  await check('excluded reprompt returns only the verdict (no prefix enters the caller context)', () => {
    const r = er.reprompt('오늘 서울 날씨 어때?');
    assert.equal(r.apply, false);
    assert.equal(r.next, 'answer_directly');
    assert(!('prompt' in r) && JSON.stringify(r).length < 600);
    const yes = er.reprompt(INCLUDE[0]);
    assert(yes.prompt.startsWith(er.FRAMEWORK) && yes.prefixSha256 === er.PREFIX_SHA256);
  });

  await check('offload normalize: expert gates, schema/batch refusals and the local layout', () => {
    assert.equal(normalize({ task: INCLUDE[0], text: 'x' }).expert, null);
    assert.throws(() => normalize({ task: INCLUDE[0], text: 'x', expert: 'yes' }), /expert must be a boolean/);
    assert.deepEqual(normalize({ task: INCLUDE[0], text: 'x', schema: { type: 'object' }, expert: true }).expert, { applied: false, reason: 'schema_output' });
    assert.equal(normalize({ task: '스킬 목록 보여줘', text: 'x', expert: true }).expert.reason, 'excluded_settings');
    const local = normalize({ task: INCLUDE[0], text: 'x', expert: true });
    assert.equal(local.expert.applied, true);
    assert.equal(local.expertLead, er.FRAMEWORK + '\n\n');
    assert(local.task.startsWith(INCLUDE[0]) && local.task.endsWith(er.LOCAL_TAIL));
    const remote = normalize({ task: INCLUDE[0], text: 'x', worker: 'agy', expert: true });
    assert(remote.task.startsWith(er.FRAMEWORK) && remote.task.endsWith(INCLUDE[0]) && !remote.expertLead);
    const batch = normalize({ worker: 'agy', expert: true, tasks: [{ task: 'a', text: 'x', schema: {} }, { task: 'b', text: 'y', schema: {} }] });
    assert.deepEqual(batch.expert, { applied: false, reason: 'batch_tasks' });
  });

  const offload = require('../src/core/offload');
  const config = require('../src/core/config');
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url === '/api/v0/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'fixture-model', state: 'loaded', type: 'llm', loaded_context_length: 8192 }] }));
      }
      seen.push(JSON.parse(raw).messages[0].content);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } })
        + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  config.update({ lmstudio: { baseUrl: `http://127.0.0.1:${server.address().port}` } });
  const hardware = { refresh: async () => {}, advise: () => ({ route: 'local', model: 'fixture-model', placement: 'gpu-full', ctxTokens: 8192, reasons: [] }), withLocalSlot: (fn) => fn() };
  let codexPrompt = null;
  const jobs = offload.createOffload({ file: path.join(SANDBOX, 'records', 'jobs.json'), hardware, prepare: async (p) => ({ model: p.model, state: 'loaded' }),
    selectLocal: async () => ({ picked: null }), runCodex: async (p) => { codexPrompt = p.prompt; return { output: 'ok' }; } });

  await check('local job: every chunk starts with the fixed prefix, data next, the action instruction last; record keeps no task text', async () => {
    const r = await jobs.runAndWait({ task: INCLUDE[1], text: 'INPUT-DATA-123', expert: true }, 10);
    assert.equal(r.state, 'succeeded');
    assert.equal(r.expert.applied, true);
    const content = seen[seen.length - 1];
    assert(content.startsWith(er.FRAMEWORK + '\n\n## Input'));
    assert(content.indexOf('INPUT-DATA-123') < content.indexOf(INCLUDE[1]) && content.endsWith(er.LOCAL_TAIL));
    const stored = fs.readFileSync(path.join(SANDBOX, 'records', 'jobs.json'), 'utf8');
    assert(!stored.includes(INCLUDE[1]) && !stored.includes('INPUT-DATA-123') && stored.includes('"prefixSha256"'));
  });

  await check('codex job: prefix first, request next, format rail last; unwrapped job unchanged', async () => {
    await jobs.runAndWait({ task: INCLUDE[3], text: 'in', worker: 'codex', expert: true }, 10);
    assert(codexPrompt.startsWith(er.FRAMEWORK) && codexPrompt.indexOf(INCLUDE[3]) < codexPrompt.indexOf('## Input'));
    assert(codexPrompt.endsWith('Reply with only the final answer.'));
    await jobs.runAndWait({ task: INCLUDE[3], text: 'in', worker: 'codex' }, 10);
    assert(codexPrompt.startsWith(INCLUDE[3]));
  });

  await new Promise((r) => server.close(r));
  console.log(`expert-reprompt: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  const target = path.resolve(SANDBOX);
  if (target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('hub-expert-test-')) fs.rmSync(target, { recursive: true, force: true });
});

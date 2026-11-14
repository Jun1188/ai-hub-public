'use strict';
// offload worker "agy" 회귀 테스트: 고정 JSON을 내는 가짜 agy(node 스크립트)로 offload → agent-workers.runAgy 전체를 탄다.
// 확인: 모델 등급(fast 기본·reasoning, 설정 파일의 slug만, 등급 간 대체 없음), 상태별 분기(사유 코드, AGY_ERROR 상태·종료 코드 2), 위험한 권한 규칙 거절,
// 마스킹한 사본만 든 임시 폴더와 정리, 출력 상한, 취소 시 kill,
// 비밀·사용자 경로가 남은 입력은 agy를 한 번도 띄우지 않음, 형식 오류 1회 재실행,
// 실패한 실행의 soft-deny, agy를 띄운 뒤 usage 없이 끝나면 사용량 null. 실제 agy·Gemini는 부르지 않는다.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-offload-agy-test-'));
const FAKE = path.join(SANDBOX, 'fake-agy.js');
const LOG = path.join(SANDBOX, 'agy-calls.jsonl');
const PID = path.join(SANDBOX, 'agy.pid');
const WORK = path.join(SANDBOX, 'agy-work');
process.env.FAKE_AGY_LOG = LOG;
process.env.FAKE_AGY_PID = PID;

fs.writeFileSync(FAKE, `'use strict';
const fs = require('fs');
const args = process.argv.slice(2), mode = process.env.FAKE_AGY_MODE || 'success';
fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ args,
  files: args.includes('-p') ? fs.readdirSync('.').map((n) => [n, fs.readFileSync(n, 'utf8')]) : null }) + '\\n');
const out = (v, code = 0) => { process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exitCode = code; };
if (args[0] === '--version') out('1.4.0\\n');
else if (args[0] === '--help') out(mode === 'outdated' ? '  --print  Run a single prompt\\n' : '  --output-format  text|json\\n  --json-schema  schema\\n');
else if (args[0] === 'models') {
  // 문구·형식은 agy 1.4.0 실제 출력(로그인 2026-10-16, 모델 목록 2026-10-18의 Gemini 줄)
  if (mode === 'auth') { process.stderr.write('error getting token source: You are not logged into Antigravity.'); process.exitCode = 1; }
  else { process.stderr.write('Fetching available models...\\n'); out(mode === 'nomodel' ? 'gemini-3.8-flash-medium\\tGemini 3.8 Flash (Medium)\\n'
    : 'gemini-4-argon-medium\\tGemini 4 Argon (Medium)\\ngemini-4-argon-high\\tGemini 4 Argon (High)\\ngemini-4-argon-low\\tGemini 4 Argon (Low)\\n'
    + 'gemini-4-hydrogen-low\\tGemini 4 Hydrogen (Low)\\ngemini-4-hydrogen-xhigh\\tGemini 4 Hydrogen (XHigh)\\n'
    + 'gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\ngemini-3.8-flash-medium\\tGemini 3.8 Flash (Medium)\\ngemini-3.8-flash-low\\tGemini 3.8 Flash (Low)\\n'); }
} else {
  const schema = args.includes('--json-schema');
  const ok = { status: 'SUCCESS', response: schema ? '' : 'plain answer', usage: { input_tokens: 11, output_tokens: 4 },
    ...(schema ? { structured_output: { items: mode === 'empty' ? [] : [{ label: mode === 'badschema' ? 5 : 'ok' }] } } : {}) };
  // agy 1.4.0 stderr 안내·오류 문구(변경 기록과 agy.exe 문자열)
  const deny = () => process.stderr.write('the run_command tool(s) required approval that headless mode cannot prompt for, so they were auto-denied.');
  switch (mode) {
    case 'hang': fs.writeFileSync(process.env.FAKE_AGY_PID, String(process.pid)); setInterval(() => {}, 1000); setTimeout(() => process.exit(9), 60000); break;
    case 'deny': deny(); out(ok); break;
    case 'denyrunning': deny(); out({ status: 'RUNNING' }, 1); break;
    case 'denyhuge': deny(); setTimeout(() => out('x'.repeat(2 * 1024 * 1024)), 300); break; // 거부 안내가 먼저 닿게
    case 'permlog': process.stderr.write('cleared project permissions; permission request-review'); out(ok); break;
    case 'quota': out({ status: 'ERROR', error: 'individual quota reached' }, 1); break;
    case 'quota-check': out({ status: 'ERROR', error: 'quota lookup failed' }, 1); break;
    case 'quota-minute': out({ status: 'ERROR', error: 'quota exceeded for requests per minute' }, 1); break;
    case 'mixed-quota': out({ status: 'ERROR', error: 'individual quota reached for requests per minute' }, 1); break;
    case 'split-quota':
      process.stderr.write('AGY_ERROR: ' + JSON.stringify({ short_error: 'individual quota reached', status: 'RESOURCE_EXHAUSTED', retryable: false }));
      out({ status: 'ERROR', error: 'requests per minute exceeded' }, 3); break;
    case 'credits': out({ status: 'ERROR', error: 'Your AI credits balance is too low to continue.' }, 1); break;
    case 'badmodel': process.stderr.write('Invalid model "gemini-4-argon-low" (available: gemini-3.8-flash-low)'); process.exitCode = 1; break;
    case 'error': out({ status: 'ERROR', error: 'internal failure' }, 1); break;
    case 'waiting': out({ status: 'WAITING' }, 1); break;
    case 'running': out({ status: 'RUNNING' }, 1); break;
    case 'runauth': process.stderr.write('You are not logged into Antigravity.'); process.exitCode = 1; break;
    case 'garbage': out('not json', 3); break;
    // agy 1.4.7 실측 모양(2026-10-25): 종료 코드 3, stdout JSON ERROR, stderr의 오류 줄 + AGY_ERROR 줄. apiodd는 모양이 어긋난 줄
    case 'apiunknown': case 'apiquota': case 'apiresource': case 'apiauth': case 'apideadline': case 'apiodd': {
      const status = { apiunknown: 'UNKNOWN', apiquota: 'RESOURCE_EXHAUSTED', apiresource: 'RESOURCE_EXHAUSTED', apiauth: 'UNAUTHENTICATED', apideadline: 'DEADLINE_EXCEEDED' }[mode];
      const message = mode === 'apiquota' ? 'individual quota reached' : 'request failed: Post https://example.invalid/v1';
      const line = status ? JSON.stringify({ short_error: message, status, error_code: 2, code_kind: 'grpc', retryable: false, error_id: 'e-1' }) : '{"short_error":';
      process.stderr.write('error: agent executor error: request failed\\r\\nAGY_ERROR: ' + line + '\\r\\n');
      out({ conversation_id: 'c-1', status: 'ERROR', response: '', error: 'agent executor error: request failed' }, 3); break;
    }
    case 'badargs': process.stderr.write('flags provided but not defined: -sandbox\\nUsage of agy.exe:\\n'); process.exitCode = 2; break;
    // 1.4.7 헤드리스 거부로 아무것도 못 낸 실행: 종료 0, 빈 response, denied_actions, stderr 안내(문구는 2026-10-25 실측)
    case 'denyempty':
      process.stderr.write('jetski: no output produced \\u2014 a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.\\n');
      out({ conversation_id: 'c-2', status: 'SUCCESS', response: '', usage: { input_tokens: 9, output_tokens: 1 }, denied_actions: [{ action: 'read_file', display_name: 'ViewFile' }] }); break;
    case 'throttled': // RESOURCE_EXHAUSTED인데 agy가 다시 해 볼 만하다고 한 것 = 일시적 제한
      process.stderr.write('AGY_ERROR: ' + JSON.stringify({ short_error: 'quota', status: 'RESOURCE_EXHAUSTED', error_code: 8, code_kind: 'grpc', retryable: true, error_id: 'e-2' }) + '\\n');
      out({ conversation_id: 'c-3', status: 'ERROR', response: '', error: 'agent executor error' }, 3); break;
    case 'denyjson': out({ ...ok, denied_actions: [{ action: 'mcp', display_name: 'CallMcpTool' }] }); break;
    case 'huge': out('x'.repeat(2 * 1024 * 1024)); break;
    default: out(ok);
  }
}
`, 'utf8');

const workers = require('../src/core/agent-workers');
const offload = require('../src/core/offload');

let bin = process.execPath;
let settings = path.join(SANDBOX, 'absent-settings.json');
let shared = path.join(SANDBOX, 'absent-config.json');
let tiers; // undefined면 실제 src/core/agy-model-tiers.json
const jobs = offload.createOffload({ file: path.join(SANDBOX, 'records', 'jobs.json'),
  runAgy: (p) => workers.runAgy({ ...p, bin, binArgs: [FAKE], settingsFile: settings, sharedConfigFile: shared, workRoot: WORK, ...(tiers ? { tiers } : {}) }) });
const schema = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false };
const run = (mode, extra = {}) => { process.env.FAKE_AGY_MODE = mode; return jobs.runAndWait({ task: 'Label each input', text: 'hello', worker: 'agy', ...extra }, 30); };
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const prints = () => calls().filter((c) => c.args.includes('-p'));
const leftovers = () => (fs.existsSync(WORK) ? fs.readdirSync(WORK) : []);
const until = async (ok, ms = 10000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return ok(); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

(async () => {
  // 1) 성공: 마스킹한 사본만 작업 폴더에 두고, 고정 옵션으로 한 번 실행하고, 폴더를 지운다. 등급을 안 주면 fast(Gemini 4 Argon Low)
  const token = 'ab'.repeat(20); // 실행 중에 만든 더미 — 저장소에 토큰 모양 리터럴을 두지 않는다(규칙 11)
  const userPath = ['C:', 'Users', 'dummy-user', 'proj', 'a.cpp'].join('\\');
  const input = path.join(SANDBOX, 'src file.cpp');
  fs.writeFileSync(input, `int x; // token=${token} at ${userPath}\n`, 'utf8');
  const ok = await run('success', { files: [input], text: undefined, schema });
  assert.equal(ok.state, 'succeeded', JSON.stringify(ok));
  assert.deepEqual(ok.results, [{ value: { label: 'ok' } }]);
  assert.deepEqual(ok.route, { worker: 'agy', model: 'gemini-4-argon-low', placement: 'cloud', tier: 'fast' });
  assert.equal(ok.usage.inputTokens, 11); assert.equal(ok.usage.outputTokens, 4); assert.equal(ok.usage.filesRead, 1);
  const [first] = prints();
  const flag = (name, call = first) => call.args[call.args.indexOf(name) + 1];
  assert.equal(flag('--output-format'), 'json'); assert.equal(flag('--model'), 'gemini-4-argon-low'); assert.equal(flag('--effort'), 'low');
  assert.equal(flag('--print-timeout'), '10m'); assert(first.args.includes('--sandbox') && first.args.includes('--json-schema'));
  assert(!first.args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(first.files, [['1-src_file.cpp', 'int x; // token=<redacted-token> at C:\\Users\\<user>\\proj\\a.cpp\n']]);
  assert(flag('-p').includes('Label each input') && flag('-p').includes('- 1-src_file.cpp') && !flag('-p').includes(SANDBOX));
  // 입력은 읽기 도구로 읽어야 하므로 도구 전체를 금지하지 않는다
  assert.match(flag('-p'), /only with your file-reading tool/); assert.doesNotMatch(flag('-p'), /call tools/);
  assert(!JSON.stringify(calls()).includes(token) && !JSON.stringify(calls()).includes('dummy-user'), 'secret-shaped text never reaches agy');
  assert.deepEqual(leftovers(), []);

  // 2) 스키마 없이: 응답 본문 하나, --json-schema 없음
  const plain = await run('success');
  assert.deepEqual(plain.results, [{ value: 'plain answer' }]); assert(!prints().at(-1).args.includes('--json-schema'));

  // 2-1) 명령줄 한도(32,767자)를 넘을 지시는 작업 폴더의 0-task.md로 — -p에는 그 파일을 가리키는 한 줄만(전에는 spawn ENAMETOOLONG → worker_failed).
  // offload 작업 하나는 8000자까지라 긴 지시는 버스 dispatch(본문 64 KiB)·묶음(작업 16개)에서 온다 — runAgy를 버스처럼 직접 부른다.
  process.env.FAKE_AGY_MODE = 'success';
  const longTask = 'Label each input. ' + 'context word '.repeat(2500);
  const long = await workers.runAgy({ prompt: longTask, inputs: [{ name: 'input.txt', text: 'hello' }], bin, binArgs: [FAKE], settingsFile: settings, sharedConfigFile: shared, workRoot: WORK });
  assert.equal(long.response, 'plain answer');
  const longCall = prints().at(-1), taskFile = longCall.files.find(([n]) => n === '0-task.md');
  assert(taskFile && taskFile[1].includes('Label each input.') && taskFile[1].includes('- 1-input.txt') && taskFile[1].length > 24000);
  assert(flag('-p', longCall).length < 200 && flag('-p', longCall).includes('0-task.md'));
  assert(!flag('-p').includes('0-task.md') && !first.files.some(([n]) => n === '0-task.md')); // 짧은 지시는 예전대로 -p에

  // 2a) 스키마에 맞는 빈 items는 「성공, 0건」이고 다시 돌리지 않는다(2026-10-18 사용자 결정, 전에는 failed no_result)
  const emptyRuns = prints().length;
  const empty = await run('empty', { schema });
  assert.equal(empty.state, 'succeeded', JSON.stringify(empty)); assert.deepEqual(empty.results, []);
  assert.equal(prints().length, emptyRuns + 1);
  const partial = await run('empty', { files: [input, path.join(SANDBOX, 'missing.cpp')], text: undefined, schema }); // 읽지 못한 입력이 있으면 0건으로 믿지 않는다
  assert.equal(`${partial.state}:${partial.reason}`, 'failed:read_failed', JSON.stringify(partial));

  // 2b) 등급: reasoning·deep은 Gemini 4 Argon의 노력 단계만 다르다. slug·노력 단계는 설정(agy-model-tiers.json)에서만 오고,
  // 목록에 없으면 다른 등급으로 바꾸지 않고 실행 0회로 거절한다. tier는 agy에만 있다.
  const reasoning = await run('success', { tier: 'reasoning' });
  assert.deepEqual(reasoning.route, { worker: 'agy', model: 'gemini-4-argon-low', placement: 'cloud', tier: 'reasoning' });
  assert.equal(flag('--model', prints().at(-1)), 'gemini-4-argon-low'); assert.equal(flag('--effort', prints().at(-1)), 'low');
  const deep = await run('success', { tier: 'deep' });
  assert.deepEqual(deep.route, { worker: 'agy', model: 'gemini-4-argon-high', placement: 'cloud', tier: 'deep' });
  assert.equal(flag('--effort', prints().at(-1)), 'high');
  tiers = { fast: { model: 'gemini-3.8-flash-medium', effort: 'medium' }, reasoning: { model: 'gemini-9-guess-low', effort: 'low' } };
  const remapped = await run('success');
  assert.equal(remapped.route.model, 'gemini-3.8-flash-medium'); assert.equal(flag('--effort', prints().at(-1)), 'medium');
  const tierRuns = prints().length;
  const guessed = await run('success', { tier: 'reasoning' }); // 설정의 slug가 agy 목록에 없다
  assert.equal(`${guessed.state}:${guessed.reason}`, 'declined:agy_model_unavailable');
  tiers = { fast: { model: 'gemini-3.8-flash-low' } }; // 노력 단계가 빠진 설정은 짐작하지 않는다
  assert.equal((await run('success')).reason, 'agy_model_unavailable');
  tiers = undefined;
  const noArgon = await run('nomodel', { tier: 'reasoning' }); // 목록에 Flash만 있어도 fast로 내리지 않는다
  assert.equal(`${noArgon.state}:${noArgon.reason}`, 'declined:agy_model_unavailable');
  assert.equal(prints().length, tierRuns);
  assert.throws(() => jobs.run({ task: 'x', text: 'y', worker: 'local', tier: 'fast' }), /only to worker agy/);
  assert.throws(() => jobs.run({ task: 'x', text: 'y', worker: 'agy', tier: 'max' }), /tier must be fast or reasoning/);

  // 모델을 명시하면 계정 목록의 정확한 ID와 접미부의 노력 단계로 실행하며, tier나 대체 모델을 붙이지 않는다.
  for (const effort of ['low', 'xhigh']) {
    const model = `gemini-4-hydrogen-${effort}`;
    const explicit = await run('success', { model, schema });
    assert.equal(explicit.state, 'succeeded', JSON.stringify(explicit));
    assert.deepEqual(explicit.route, { worker: 'agy', model, placement: 'cloud' });
    assert.equal(flag('--model', prints().at(-1)), model); assert.equal(flag('--effort', prints().at(-1)), effort);
    const stored = jobs.list().find((r) => r.id === explicit.id);
    assert.equal(stored.model, model); assert(!('tier' in stored));
  }
  const explicitRuns = prints().length;
  const unavailable = await run('success', { model: 'gemini-4-absent-low' });
  assert.equal(`${unavailable.state}:${unavailable.reason}`, 'declined:agy_model_unavailable');
  assert.equal(prints().length, explicitRuns, 'an unavailable explicit model never runs a fallback');
  for (const worker of ['local', 'codex']) {
    assert.throws(() => jobs.run({ task: 'x', text: 'y', worker, model: 'gemini-4-hydrogen-low' }), /model applies only to worker agy/);
  }
  for (const model of ['', null, 7, ' gemini-4-hydrogen-low', 'gemini-4-hydrogen', 'claude-opus-5-5-low', 'gemini-3.8-flash-low', 'gemini-4-' + 'x'.repeat(128) + '-low']) {
    assert.throws(() => jobs.run({ task: 'x', text: 'y', worker: 'agy', model }), /model must be an exact Gemini 4 model ID/);
  }
  assert.throws(() => jobs.run({ task: 'x', text: 'y', worker: 'agy', model: 'gemini-4-hydrogen-low', tier: 'fast' }), /either model or tier/);

  // 3) 비밀·가리지 못한 사용자 경로: agy를 한 번도 띄우지 않는다(사전 점검 호출도 0)
  const before = calls().length;
  for (const extra of [{ text: 'key sk-' + 'a'.repeat(24) }, { text: 'see C:/Users/dummy-user/x' }, { task: 'use Bearer ' + 'z'.repeat(24) }]) {
    const r = await run('success', extra);
    assert.equal(r.state, 'declined'); assert.equal(r.reason, 'blocked_secret_like_text');
  }
  assert.equal(calls().length, before);

  // 4) 위험한 권한 규칙(MCP·셸·쓰기 허용)과 읽을 수 없는 설정은 settings.json·공유 설정 어느 쪽이든 실행 전에 거절, 읽기 규칙만 있으면 통과
  const runs = prints().length;
  for (const text of [JSON.stringify({ permissions: { allow: ['read_file(docs/)', 'mcp(ai-hub/*)'] } }),
    '\uFEFF' + JSON.stringify({ permissions: { allow: ['command(git)'] } }), JSON.stringify({ permissions: { allow: ['write_file(src/)'] } }), '{ broken']) {
    settings = path.join(SANDBOX, 'settings.json'); fs.writeFileSync(settings, text, 'utf8');
    const r = await run('success', { model: 'gemini-4-hydrogen-low' });
    assert.equal(r.state, 'declined'); assert.equal(r.reason, 'agy_unsafe_permissions');
  }
  assert.equal(prints().length, runs);
  fs.writeFileSync(settings, JSON.stringify({ trustedWorkspaces: [], permissions: { allow: ['read_file(docs/)', 'read_url(google.com)'], deny: ['command(*)'] } }), 'utf8');
  assert.equal((await run('success')).state, 'succeeded');

  // MCP의 새 입력이 실행 계층까지 전달되는지 확인한다. 외부 모델을 부르지 않는다.
  const registered = new Map(), originalRun = offload.runAndWait;
  require('../src/mcp/offload-tools').register({ registerTool: (name, config, handler) => registered.set(name, { config, handler }) });
  const tool = registered.get('offload_run');
  assert(tool.config.inputSchema.model.safeParse('gemini-4-hydrogen-low').success);
  assert(!tool.config.inputSchema.model.safeParse('').success);
  let forwarded;
  offload.runAndWait = async (input, wait) => { forwarded = { input, wait }; return { state: 'succeeded' }; };
  try {
    await tool.handler({ worker: 'agy', model: 'gemini-4-hydrogen-low', task: 'Label', text: 'hello', wait_s: 0 });
    assert.equal(forwarded.input.model, 'gemini-4-hydrogen-low'); assert.equal(forwarded.wait, 0);
  } finally { offload.runAndWait = originalRun; }
  // 공유 설정(~/.gemini/config/config.json)의 userSettings.globalPermissionGrants도 같은 기준. 모양은 agy 1.4.0 protobuf 정의
  const grants = (allow) => JSON.stringify({ plugins: { 'dummy-plugin': { enabled: true } }, userSettings: { themeMode: 'THEME_MODE_DARK', globalPermissionGrants: { allow, deny: ['command(*)'], ask: [] } } });
  const sharedRuns = prints().length;
  for (const text of [grants(['read_file(docs/)', 'mcp(ai-hub/*)']), '﻿' + grants(['command(git)']), '{ broken']) {
    shared = path.join(SANDBOX, 'config.json'); fs.writeFileSync(shared, text, 'utf8');
    const r = await run('success', { model: 'gemini-4-hydrogen-low' });
    assert.equal(r.state, 'declined'); assert.equal(r.reason, 'agy_unsafe_permissions');
  }
  assert.equal(prints().length, sharedRuns);
  fs.writeFileSync(shared, grants(['read_file(docs/)', 'read_url(google.com)']), 'utf8');
  assert.equal((await run('success')).state, 'succeeded');

  // 5) 상태별 분기: 사전 점검 거절, agy 상태·오류, 출력 상한
  for (const [mode, state, reason] of [['outdated', 'declined', 'agy_outdated'], ['auth', 'declined', 'agy_auth'],
    ['nomodel', 'declined', 'agy_model_unavailable'], ['runauth', 'declined', 'agy_auth'], ['quota', 'declined', 'agy_quota_exhausted'],
    ['credits', 'declined', 'agy_quota_exhausted'], ['badmodel', 'declined', 'agy_model_unavailable'], ['error', 'failed', 'agy_error'], ['waiting', 'failed', 'agy_incomplete'],
    ['running', 'failed', 'timeout'], ['garbage', 'failed', 'agy_exit_3'], ['huge', 'failed', 'output_exceeded'],
    ['apiunknown', 'failed', 'agy_api_unknown'], ['apiquota', 'declined', 'agy_quota_exhausted'], ['apiauth', 'declined', 'agy_auth'],
    ['apiresource', 'failed', 'agy_api_resource_exhausted'], ['quota-check', 'failed', 'agy_error'],
    ['quota-minute', 'failed', 'agy_throttled'], ['mixed-quota', 'failed', 'agy_throttled'], ['split-quota', 'failed', 'agy_throttled'],
    ['apideadline', 'failed', 'timeout'], ['apiodd', 'failed', 'agy_api_error'], ['badargs', 'declined', 'agy_bad_arguments'],
    ['throttled', 'failed', 'agy_throttled']]) {
    const r = await run(mode);
    assert.equal(`${mode}:${r.state}:${r.reason}`, `${mode}:${state}:${reason}`);
    assert(!('results' in r) && !('toolDenied' in r.verification));
    // 사전 점검에서 멈추면 모델을 부르지 않았으니 0, agy를 띄운 뒤 usage 없이 끝나면 쓴 양을 모르니 null
    const spent = ['outdated', 'auth', 'nomodel'].includes(mode) ? 0 : null;
    assert.deepEqual([mode, r.usage.inputTokens, r.usage.outputTokens], [mode, spent, spent]);
  }
  bin = '';
  const missing = await run('success');
  assert.equal(missing.state, 'declined'); assert.equal(missing.reason, 'agy_not_installed');
  bin = process.execPath;
  const denied = await run('deny');
  assert.equal(denied.state, 'succeeded'); assert.equal(denied.verification.toolDenied, true);
  const deniedJson = await run('denyjson'); // stderr 안내 없이 stdout JSON의 denied_actions만
  assert.equal(deniedJson.state, 'succeeded'); assert.equal(deniedJson.verification.toolDenied, true);
  // 거부로 아무것도 못 낸 실행은 다시 돌리지 않고 거절한다(전에는 한 번 더 돌린 뒤 schema_invalid·empty_or_truncated)
  for (const extra of [{ schema }, {}]) {
    const before = prints().length;
    const r = await run('denyempty', extra);
    assert.equal(`${r.state}:${r.reason}:${r.verification.toolDenied}:${prints().length - before}`, 'declined:agy_tool_denied:true:1', JSON.stringify(r));
  }
  // 거부 뒤 헛돌다 실패로 끝난 실행에도 남는다(agy 자신의 시간 초과, Hub 출력 상한 — Hub 시간 초과와 같은 경로)
  for (const [mode, reason] of [['denyrunning', 'timeout'], ['denyhuge', 'output_exceeded']]) {
    const r = await run(mode);
    assert.equal(`${mode}:${r.state}:${r.reason}:${r.verification.toolDenied}:${r.usage.inputTokens}`, `${mode}:failed:${reason}:true:null`);
  }
  const noisy = await run('permlog'); // "permission" 낱말만으로는 soft-deny가 아니다
  assert.equal(noisy.state, 'succeeded'); assert(!('toolDenied' in noisy.verification));
  assert.deepEqual(leftovers(), []);

  // 6) 형식이 틀리면 한 번만 다시 돌리고 schema_invalid
  const runsBefore = prints().length;
  const bad = await run('badschema', { schema, model: 'gemini-4-hydrogen-low' });
  assert.equal(bad.state, 'failed'); assert.equal(bad.reason, 'schema_invalid'); assert.equal(prints().length - runsBefore, 2);
  assert(prints().slice(-2).every((c) => flag('--model', c) === 'gemini-4-hydrogen-low'));
  assert.deepEqual(bad.verification, { schemaValid: 0, schemaInvalid: 1 });

  // 7) 취소: agy 프로세스를 죽이고 임시 폴더를 지운다
  process.env.FAKE_AGY_MODE = 'hang';
  const id = jobs.run({ task: 'Label each input', text: 'hello', worker: 'agy' });
  assert(await until(() => fs.existsSync(PID)), 'fake agy started');
  const pid = Number(fs.readFileSync(PID, 'utf8'));
  assert.equal(jobs.active()[0].pid, pid);
  const cancelled = jobs.cancel(id);
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.usage.inputTokens, null, 'agy ran, so usage is unknown');
  assert(await until(() => !alive(pid)), 'agy killed on cancel');
  assert(await until(() => leftovers().length === 0), 'work folder removed after cancel');

  // 8) MCP 탭·hub_status 상태: CLI 버전과 agy 작업 기록만, 경로 없음
  const st = await workers.agyStatus({ bin, binArgs: [FAKE], list: () => [{ worker: 'codex', state: 'succeeded' },
    { worker: 'agy', state: 'declined', reason: 'agy_auth', createdAt: 't1' }, { worker: 'agy', state: 'succeeded', model: 'gemini-4-argon-low', finishedAt: 't2' }] });
  assert.deepEqual(st, { installed: true, version: '1.4.0', succeeded: 1, declined: 1, failed: 0,
    last: { state: 'succeeded', model: 'gemini-4-argon-low', reason: '', at: 't2' } });

  console.log('Offload agy: model option reaches MCP/worker, exact listed Gemini 4 ID/effort, no fallback, model/tier validation, original tier defaults, secrets/unsafe rules refused, schema retry keeps model, cancel/status passed');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  const target = path.resolve(SANDBOX);
  if (target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('hub-offload-agy-test-')) {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

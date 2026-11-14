'use strict';
// offload worker "agy" 묶음(tasks) 회귀 테스트: 가짜 agy(node 스크립트)가 지시의 "Task N (inputs …)"를 읽고 번호 붙은 입력 파일
// 내용으로 답한다. 확인: 실행 1회에 작업 전부, 작업↔입력 번호 대응, 같은 파일은 한 번만, 결과·실패의 task 번호,
// 빈 items는 그 작업의 「0건」, 형식이 틀린 작업만 한 번 더 묶어 실행, 다시 돌린 묶음이 실패·거절돼도 앞 결과 유지,
// 읽지 못한 입력의 작업은 보내지 않음, 비밀이 남은 입력은 묶음 전체 거절, 인자 검사. 실제 agy·Gemini는 부르지 않는다.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-offload-agy-batch-test-'));
const FAKE = path.join(SANDBOX, 'fake-agy.js');
const LOG = path.join(SANDBOX, 'agy-calls.jsonl');
const COUNT = path.join(SANDBOX, 'runs.txt');
const WORK = path.join(SANDBOX, 'agy-work');
Object.assign(process.env, { FAKE_AGY_LOG: LOG, FAKE_AGY_COUNT: COUNT });

fs.writeFileSync(FAKE, `'use strict';
const fs = require('fs');
const args = process.argv.slice(2), mode = process.env.FAKE_AGY_MODE || 'ok';
const out = (v, code = 0) => { process.stdout.write(JSON.stringify(v)); process.exitCode = code; };
if (args[0] === '--version') process.stdout.write('1.4.2\\n');
else if (args[0] === '--help') process.stdout.write('  --output-format  text|json\\n  --json-schema  schema\\n');
else if (args[0] === 'models') process.stdout.write('gemini-4-argon-low\\tGemini 4 Argon (Low)\\ngemini-4-argon-high\\tGemini 4 Argon (High)\\ngemini-4-hydrogen-low\\tGemini 4 Hydrogen (Low)\\n');
else {
  const promptArg = args[args.indexOf('-p') + 1];
  // 긴 지시는 runAgy가 0-task.md로 옮긴다 — 진짜 agy처럼 그 파일을 읽어 작업을 찾는다
  const prompt = fs.existsSync('0-task.md') ? fs.readFileSync('0-task.md', 'utf8') : promptArg;
  const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--json-schema') + 1], 'utf8'));
  const files = fs.readdirSync('.');
  const run = Number(fs.existsSync(process.env.FAKE_AGY_COUNT) ? fs.readFileSync(process.env.FAKE_AGY_COUNT, 'utf8') : 0) + 1;
  fs.writeFileSync(process.env.FAKE_AGY_COUNT, String(run));
  fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ run, prompt, promptArg, files, required: schema.required,
    model: args[args.indexOf('--model') + 1], effort: args[args.indexOf('--effort') + 1] }) + '\\n');
  if (mode === 'denyall') { // 1.4.7 헤드리스 거부로 아무것도 못 낸 실행(2026-10-25 실측 모양)
    process.stderr.write('jetski: no output produced \\u2014 a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.\\n');
    out({ status: 'SUCCESS', response: '', usage: { input_tokens: 10, output_tokens: 1 }, denied_actions: [{ action: 'read_file', display_name: 'ViewFile' }] });
    return;
  }
  const answers = {};
  for (const m of prompt.matchAll(/^Task (\\d+) \\(inputs ([\\d, ]+)\\):/gm)) {
    const label = m[2].split(', ').map((n) => fs.readFileSync(files.find((f) => f.startsWith(n + '-')), 'utf8').trim()).join('+');
    answers['task_' + m[1]] = { items: [{ label }] };
  }
  if (mode === 'empty2') answers.task_2.items = [];
  const bad2 = ['bad2', 'retryfail', 'retryquota'].includes(mode) && run === 1 || mode === 'bad2always';
  if (bad2 && answers.task_2) answers.task_2.items = [{ label: 5 }];
  if (mode === 'retryfail' && run === 2) out({ status: 'ERROR', error: 'internal failure' }, 1);
  else if (mode === 'retryquota' && run === 2) out({ status: 'ERROR', error: 'individual quota reached' }, 1);
  else out({ status: 'SUCCESS', response: '', structured_output: answers, usage: { input_tokens: 10, output_tokens: 2 } });
}
`, 'utf8');

const workers = require('../src/core/agent-workers');
const offload = require('../src/core/offload');
const absent = path.join(SANDBOX, 'absent.json');
const jobs = offload.createOffload({ file: path.join(SANDBOX, 'records', 'jobs.json'),
  runAgy: (p) => workers.runAgy({ ...p, bin: process.execPath, binArgs: [FAKE], settingsFile: absent, sharedConfigFile: absent, workRoot: WORK }) });
const schema = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false };
const write = (name, text) => { const f = path.join(SANDBOX, name); fs.writeFileSync(f, text, 'utf8'); return f; };
const A = write('a.js', 'alpha'), B = write('b.js', 'beta');
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const run = (mode, tasks, extra = {}) => {
  process.env.FAKE_AGY_MODE = mode; fs.rmSync(COUNT, { force: true });
  return jobs.runAndWait({ worker: 'agy', tasks, ...extra }, 30);
};
const byTask = (r) => Object.fromEntries((r.results || []).map((x) => [x.task, x.value.label]));
const three = () => [{ task: 'Label A', files: [A], schema }, { task: 'Label B', files: [B], schema },
  { task: 'Label both', files: [A, B], schema }, { task: 'Label text', text: 'gamma', schema }];

(async () => {
  // 1) 작업 4개 = 실행 1회. 같은 파일(a.js)은 한 번만 넣고, 작업은 runAgy가 붙인 입력 번호로 자기 입력을 가리킨다.
  const ok = await run('ok', three());
  assert.equal(ok.state, 'succeeded', JSON.stringify(ok));
  assert.deepEqual(byTask(ok), { 1: 'alpha', 2: 'beta', 3: 'alpha+beta', 4: 'gamma' });
  assert.deepEqual(ok.route, { worker: 'agy', model: 'gemini-4-argon-low', placement: 'cloud', tier: 'fast' });
  assert.deepEqual([ok.usage.inputTokens, ok.usage.outputTokens, ok.usage.filesRead], [10, 2, 2]);
  assert.deepEqual(ok.verification, { schemaValid: 4, schemaInvalid: 0 });
  const [first] = calls();
  assert.equal(calls().length, 1);
  assert.deepEqual(first.files.sort(), ['1-a.js', '2-b.js', '3-task-4.txt']);
  assert.deepEqual(first.required, ['task_1', 'task_2', 'task_3', 'task_4']);
  assert.match(first.prompt, /^Task 3 \(inputs 1, 2\): Label both$/m);
  assert.match(first.prompt, /Read only these input files/); // runAgy의 읽기 전용 꼬리말을 그대로 탄다
  const rec = jobs.list().find((r) => r.id === ok.id);
  assert.deepEqual([rec.tasks, rec.inputs, rec.resultCount], [4, 3, 4]);
  assert(!JSON.stringify(rec).includes('Label') && !JSON.stringify(rec).includes('alpha'), 'record holds no task text or values');

  const explicit = await run('ok', three(), { model: 'gemini-4-hydrogen-low' });
  assert.equal(explicit.state, 'succeeded', JSON.stringify(explicit));
  assert.deepEqual(byTask(explicit), byTask(ok));
  assert.deepEqual(explicit.route, { worker: 'agy', model: 'gemini-4-hydrogen-low', placement: 'cloud' });
  assert.deepEqual([calls().at(-1).model, calls().at(-1).effort], ['gemini-4-hydrogen-low', 'low']);

  // 2) 스키마에 맞는 빈 items는 그 작업의 「0건」: 결과도 실패도 없고 다시 돌리지 않는다
  const before = calls().length;
  const empty = await run('empty2', three().slice(0, 2));
  assert.equal(empty.state, 'succeeded'); assert.deepEqual(byTask(empty), { 1: 'alpha' }); assert(!empty.failures);
  assert.equal(calls().length, before + 1);

  // 3) 형식이 틀린 작업만 모아 한 번 더: 두 번째 실행에는 작업 2와 그 입력만 간다
  const bad = await run('bad2', three().slice(0, 3), { model: 'gemini-4-hydrogen-low' });
  assert.deepEqual(byTask(bad), { 1: 'alpha', 2: 'beta', 3: 'alpha+beta' });
  const retry = calls().at(-1);
  assert.equal(retry.run, 2); assert.deepEqual(retry.required, ['task_2']); assert.deepEqual(retry.files, ['1-b.js']);
  assert(calls().slice(-2).every((c) => c.model === 'gemini-4-hydrogen-low' && c.effort === 'low'));
  assert.match(retry.prompt, /^Task 2 \(inputs 1\): Label B$/m); assert.doesNotMatch(retry.prompt, /Task 1|Task 3/);
  assert.deepEqual(bad.verification, { schemaValid: 3, schemaInvalid: 0 });
  assert.deepEqual([bad.usage.inputTokens, bad.usage.outputTokens], [20, 4]);
  // 두 번째도 틀리면 그 작업만 schema_invalid, 나머지는 성공
  const worse = await run('bad2always', three().slice(0, 2));
  assert.equal(worse.state, 'succeeded'); assert.deepEqual(byTask(worse), { 1: 'alpha' });
  assert.deepEqual(worse.failures, [{ task: 2, reason: 'schema_invalid' }]);
  // 다시 돌린 묶음이 실패해도 첫 묶음 결과는 남는다
  const retryFail = await run('retryfail', three().slice(0, 2));
  assert.equal(retryFail.state, 'succeeded'); assert.deepEqual(byTask(retryFail), { 1: 'alpha' });
  assert.deepEqual(retryFail.failures, [{ task: 2, reason: 'agy_error' }]);
  const retryQuota = await run('retryquota', three().slice(0, 2)); // 다시 돌린 묶음의 거절 사유도 그 작업에 붙는다
  assert.equal(retryQuota.state, 'succeeded'); assert.deepEqual(byTask(retryQuota), { 1: 'alpha' });
  assert.deepEqual(retryQuota.failures, [{ task: 2, reason: 'agy_quota_exhausted' }]);

  // 4) 읽지 못한 입력이 있는 작업은 보내지 않고 그 작업만 실패
  const gone = path.join(SANDBOX, 'missing.js');
  const partial = await run('ok', [{ task: 'Label A', files: [A], schema }, { task: 'Label gone', files: [gone], schema }]);
  assert.equal(partial.state, 'succeeded'); assert.deepEqual(byTask(partial), { 1: 'alpha' });
  assert.deepEqual(partial.failures, [{ task: 2, file: gone, reason: 'read_failed' }]);
  assert.doesNotMatch(calls().at(-1).prompt, /Task 2/);

  // 5) 비밀 모양이 남은 입력은 runAgy가 묶음 전체를 띄우지 않고 거절한다
  const runs = calls().length;
  const secret = await run('ok', [{ task: 'Label A', files: [A], schema }, { task: 'Label key', text: 'key sk-' + 'a'.repeat(24), schema }]);
  assert.equal(`${secret.state}:${secret.reason}`, 'declined:blocked_secret_like_text'); assert.equal(calls().length, runs);
  assert.deepEqual(fs.existsSync(WORK) ? fs.readdirSync(WORK) : [], []);

  // 5-1) 긴 묶음(작업 4개 × 7000자 ≈ 명령줄 한도 근처): 지시는 0-task.md로, -p에는 그 파일을 가리키는 한 줄만. 결과는 예전과 같다
  const longPad = ' context'.repeat(860);
  const longTasks = [['Label A', A], ['Label B', B], ['Label A again', A], ['Label B again', B]].map(([t, f]) => ({ task: t + longPad, files: [f], schema }));
  const long = await run('ok', longTasks);
  assert.equal(long.state, 'succeeded', JSON.stringify(long));
  assert.deepEqual(byTask(long), { 1: 'alpha', 2: 'beta', 3: 'alpha', 4: 'beta' });
  const longCall = calls().at(-1);
  assert(longCall.files.includes('0-task.md') && longCall.promptArg.includes('0-task.md') && longCall.promptArg.length < 200);
  assert(!calls().at(-2).files.includes('0-task.md')); // 짧은 묶음은 예전대로 -p에

  // 5-2) 거부로 아무것도 못 낸 묶음은 다시 돌리지 않고 거절한다(전에는 두 번 돌린 뒤 작업마다 schema_invalid)
  const deniedRuns = calls().length;
  const denied = await run('denyall', three().slice(0, 2));
  assert.equal(`${denied.state}:${denied.reason}:${denied.verification.toolDenied}`, 'declined:agy_tool_denied:true', JSON.stringify(denied));
  assert.equal(calls().length, deniedRuns + 1);

  // 6) 인자: agy만, task와 함께 쓰지 않음, 2~16개, 작업마다 입력과 스키마
  const one = { task: 't', text: 'x', schema };
  for (const [args, error] of [[{ worker: 'local', tasks: [one, one] }, /only to worker agy/], [{ worker: 'agy', task: 't', tasks: [one, one] }, /either task or tasks/],
    [{ worker: 'agy', tasks: [one] }, /2-16 tasks/], [{ worker: 'agy', tasks: Array(17).fill(one) }, /2-16 tasks/],
    [{ worker: 'agy', tasks: [one, { task: 't', schema }] }, /tasks\[1\] needs files or text/], [{ worker: 'agy', tasks: [one, { task: 't', text: 'x' }] }, /tasks\[1\]\.schema is required/],
    [{ worker: 'agy', tasks: [one, { task: '', text: 'x', schema }] }, /tasks\[1\]\.task must be/], [{ worker: 'agy', tasks: [one, { ...one, files: ['rel.js'] }] }, /tasks\[1\]\.files/]]) {
    assert.throws(() => jobs.run(args), error);
  }

  console.log('Offload agy tasks: one run per bundle, inputs numbered and shared once, task-tagged results, empty items as zero, only invalid tasks re-run once, earlier results kept when the re-run fails, unreadable task skipped, secrets refuse the bundle, argument checks passed');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  const target = path.resolve(SANDBOX);
  if (target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('hub-offload-agy-batch-test-')) {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const cp = require('child_process');
const original = { spawn: cp.spawn, execFile: cp.execFile };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cli-test-'));
const fake = path.join(root, 'test.exe'); fs.writeFileSync(fake, 'fixture');
const envBefore = {};
for (const key of ['AIHUB_CODEX_BIN', 'AIDER_BIN', 'HF_BIN']) {
  envBefore[key] = process.env[key]; process.env[key] = fake;
}
const launches = [];
cp.execFile = (file, args, options, callback) => {
  if (file === 'git') return callback(new Error('not a git repository'), Buffer.alloc(0), Buffer.alloc(0));
  if (args[0] === 'exec' && args[1] === '--help') return callback(null, Buffer.from('  --output-schema <FILE>'), Buffer.alloc(0));
  callback(null, Buffer.from(args[0] === 'cache' ? '[]' : 'aider 0.86.2'), Buffer.alloc(0));
};
cp.spawn = (bin, args, options) => {
  const child = new EventEmitter(); child.pid = 123; child.exitCode = null;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const launch = { bin, args, options, stdin: '' }; launches.push(launch);
  child.stdin = { on() {}, end(value) { launch.stdin = value; } };
  setImmediate(() => {
    // Codex가 한도로 끝날 때: 마지막 메시지 없이 비정상 종료. 소진(실제 문구), 재시도 뒤 429, 진행 로그에 인용된 한도 문구
    const ending = { 'limit probe': "ERROR: You’ve hit your usage limit. Upgrade to Pro or try again at 3:05 AM.",
      'throttle probe': 'ERROR: stream error: exceeded retry limit, last status: 429 Too Many Requests',
      'quoted probe': 'codex: the docs say "rate limit" and HTTP 429 Too Many Requests mean wait\nERROR: unexpected status 500',
      'quoted quota then auth': 'A log from another task said "You’ve hit your usage limit".\nERROR: unauthorized',
      'quota then server': 'ERROR: You’ve hit your usage limit.\nERROR: unexpected status 500',
      'quota stdout only': 'ERROR: unauthorized' }[launch.stdin];
    if (launch.stdin === 'quota stdout only') child.stdout.emit('data', Buffer.from('ERROR: You’ve hit your usage limit.\n'));
    if (ending) {
      const bytes = Buffer.from(ending);
      const split = bytes.indexOf(Buffer.from('’')) + 1;
      child.stderr.emit('data', bytes.subarray(0, split));
      child.stderr.emit('data', bytes.subarray(split));
      child.exitCode = 1; child.emit('close', 1, null); return;
    }
    const last = args.indexOf('--output-last-message');
    if (last !== -1) fs.writeFileSync(args[last + 1], '{"decision":"fixture"}', 'utf8');
    child.stdout.emit('data', Buffer.from('fixture worker output'));
    child.exitCode = 0; child.emit('close', 0, null);
  });
  return child;
};
const runtime = require('../src/core/local-runtime');
const lm = require('../src/core/lmstudio');
const paths = require('../src/core/paths');
paths.hubDataDir = () => root;
// The Aider fixture cannot return real power/GPU samples from its fake process launcher.
const hw=require('../src/core/hardware-optimizer'),monitor=require('../src/core/resource-monitor'),models=require('../src/core/model-control');
const hardwareOriginal={refresh:hw.refresh,status:hw.status,snapshot:monitor.snapshot,peek:monitor.peek,ensure:models.ensure};
hw.refresh=async()=>{};hw.status=()=>({at:Date.now(),onAcPower:true,heavyApps:[],failures:0,retryAt:0});
monitor.snapshot=async()=>({sampledAt:Date.now(),cpu:{usagePercent:5,logicalCores:8},ram:{totalBytes:32*1024**3,usedBytes:4*1024**3},gpu:{available:false}});
monitor.peek=()=>null;models.ensure=async p=>({model:p.model,state:'loaded'});
runtime.status = async () => ({ llama: { running: true, ready: true, url: 'http://fixture.invalid', models: [{ id: 'local-fixture', state: 'loaded' }] } });
runtime.llamaClientConnection = () => ({ apiBase: 'http://fixture.invalid/v1', apiKey: 'dummy-local' });
lm.listModelsDetailed = async () => [{ id: 'local-fixture', type: 'llm', state: 'loaded' }];
lm.baseUrl = () => 'http://fixture.invalid';
(async () => {
  const workers = require('../src/core/agent-workers');
  const signal = new AbortController().signal;
  let pid = null;
  const out = await workers.runCodex({ prompt: 'bounded read', cwd: root, schema: { type: 'object' }, timeoutSec: 10, signal, onSpawn: (p) => { pid = p; } });
  const launch = launches.at(-1);
  assert.equal(pid, 123); assert.equal(out.schemaApplied, true); assert.equal(out.output, '{"decision":"fixture"}');
  assert.equal(launch.args[launch.args.indexOf('--sandbox') + 1], 'read-only');
  // --ignore-user-config drops the user's [windows] sandbox setting and breaks read-only exec on Windows.
  assert.ok(!launch.args.includes('--ignore-user-config'));
  assert.ok(launch.args.includes('--output-schema')); assert.equal(launch.stdin, 'bounded read');
  assert.equal(fs.existsSync(launch.args[launch.args.indexOf('--output-last-message') + 1]), false);
  assert.equal(launch.options.shell, false);
  // 한도는 정해진 사유 코드로 — 소진만 L1 판정자 순서가 다음 작업자로 넘어가는 근거다(출력 본문은 결과에 싣지 않는다).
  const limitOf = (prompt) => workers.runCodex({ prompt, cwd: root, timeoutSec: 10, signal }).then(() => 'resolved', (e) => `${e.offloadReason || ''}|${e.message}`);
  assert.equal(await limitOf('limit probe'), 'codex_quota_exhausted|Codex usage limit');
  assert.equal(await limitOf('throttle probe'), 'codex_throttled|Codex rate limited');
  for (const prompt of ['quoted quota then auth', 'quota then server', 'quota stdout only'])
    assert.equal(await limitOf(prompt), '|Codex produced no final message', prompt);
  assert.equal(await limitOf('quoted probe'), '|Codex produced no final message'); // 인용된 "rate limit"·429는 한도가 아니다(평범한 실패)

  const aider = require('../src/core/aider-studio');
  const input = { projectDir: root, prompt: 'make a txt file', provider: 'llamacpp', model: 'local-fixture', files: ['example.txt'] };
  const plan = await aider.commandPlan(input);
  assert.equal(plan.options.mode, 'code');
  assert.ok(plan.args.includes('whole')); assert.ok(!plan.args.includes('--architect'));
  for (const option of ['--no-git', '--no-gitignore', '--no-auto-test', '--no-auto-lint', '--no-show-model-warnings']) assert.ok(plan.args.includes(option));
  assert.ok(!plan.args.includes('--no-stream'));
  await assert.rejects(() => aider.commandPlan({ ...input, files: ['../escape.txt'] }), /프로젝트 밖/);
  const started = await aider.start(input); const result = await aider.wait(started.runId);
  assert.equal(result.ok, true); assert.match(result.output, /fixture worker/);
  assert.ok(fs.existsSync(path.join(aider.RUNS_DIR, started.runId + '.json')));
  delete require.cache[require.resolve('../src/core/aider-studio')];
  const restored = require('../src/core/aider-studio').result(started.runId);
  assert.equal(restored.output, result.output);
  assert.throws(() => aider.result('../escape'), /잘못된/);
  console.log('Passed: read-only Codex exec keeps user sandbox config, output schema and final message only, Aider edit mode, file scope, durable logs');
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => {
  hw.refresh=hardwareOriginal.refresh;hw.status=hardwareOriginal.status;monitor.snapshot=hardwareOriginal.snapshot;monitor.peek=hardwareOriginal.peek;models.ensure=hardwareOriginal.ensure;
  cp.spawn = original.spawn; cp.execFile = original.execFile;
  for (const [key, value] of Object.entries(envBefore)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(root, { recursive: true, force: true });
});

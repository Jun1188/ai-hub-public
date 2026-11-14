'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const done = require('../src/core/todo-done-view');

async function main() {
  const base = process.env.AIHUB_TEST_ROOT || path.join(os.tmpdir(), 'ai-hub-done-tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'read-only-'));
  for (const dir of ['tools', 'todo-queue/definitions', 'docs', 'reports']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of ['tools/todo_queue.py', 'tools/todo_done.py', 'docs/task.md', 'reports/result.json']) fs.writeFileSync(path.join(root, file), 'fixture');
  const fp = 'a'.repeat(64), activeFp = 'b'.repeat(64);
  const rows = [{ id: 'DONE-TASK', fingerprint: fp, state: 'completed', summary: '완료 <script>window.bad=1</script>',
    active: false, targets: ['PC-ONE', 'PC-TWO'], pendingPCs: [], detail: '[상세](docs/task.md)', sharedStatus: '대기',
    completedPCs: { 'PC-ONE': { completedAt: 1794000000, note: 'api_key=private-value C:\\Users\\name\\private.txt', evidence: 'reports/result.json' } } },
    { id: 'ACTIVE-TASK', fingerprint: activeFp, state: 'held', active: true, held: true, summary: '보류',
      targets: ['PC-ONE'], pendingPCs: ['PC-ONE'], completedPCs: {}, detail: 'https://example.com/' }];
  const argsSeen = [];
  const invoke = async (_command, args, cwd) => {
    assert.equal(cwd, root); assert(args.includes('-B')); argsSeen.push(args);
    if (args.includes('reopen-plan')) return { stdout: JSON.stringify({ planOnly: true, created: false,
      original: { id: 'DONE-TASK', fingerprint: fp, state: 'completed' }, newId: 'NEXT-TASK', targets: ['PC-ONE', 'PC-TWO'], summary: '후속', reason: '추가 확인' }) };
    return { stdout: JSON.stringify({ scope: 'done', readOnly: true, tasks: rows, warnings: [] }) };
  };
  const deps = { root, invoke };
  const before = fs.readFileSync(path.join(root, 'docs/task.md'));
  const first = await done.view({}, deps);
  assert.equal(first.tasks.length, 2); assert.equal(first.readOnly, true);
  assert.equal(first.tasks[0].fingerprint, fp); assert.equal(first.tasks[1].detail, null);
  assert(!JSON.stringify(first).includes('private-value')); assert(!JSON.stringify(first).includes('C:\\Users\\name'));
  assert.equal(first.tasks[0].completedPCs['PC-ONE'].evidence, 'reports/result.json');
  const identity = { snapshotId: first.snapshotId, id: 'DONE-TASK', fingerprint: fp };
  await assert.rejects(done.plan({ ...identity, newId: 'DONE-TASK', reason: 'again' }, deps), /새 작업 ID/);
  await assert.rejects(done.plan({ ...identity, newId: 'NEXT-TASK', reason: '' }, deps), /재개 이유/);
  await assert.rejects(done.plan({ ...identity, id: 'ACTIVE-TASK', fingerprint: activeFp, newId: 'NEXT-TASK', reason: 'x' }, deps), /활성/);
  const plan = await done.plan({ ...identity, newId: 'NEXT-TASK', reason: '추가 확인' }, deps);
  assert.equal(plan.created, false); assert.equal(plan.planOnly, true);
  assert(argsSeen.some(args => args.includes('reopen-plan')));
  let opened;
  await done.open({ ...identity, reference: 'detail' }, { openPath: async file => { opened = file; return ''; } });
  assert.equal(opened, path.join(root, 'docs/task.md'));
  await done.open({ ...identity, reference: 'receipt', pc: 'PC-ONE' }, { openPath: async file => { opened = file; return ''; } });
  assert.equal(opened, path.join(root, 'reports/result.json'));
  await assert.rejects(done.open({ ...identity, reference: 'receipt', pc: 'FOREIGN' }, {}), /상대 근거/);
  for (const ref of ['../secret.txt', 'docs/../../secret.txt', 'C:/Users/name/key.txt', '\\\\server\\share\\key.txt', 'docs/run.exe', 'https://example.com/docs/a.md', 'docs/a.md#x']) assert.equal(done.reference(ref), null, ref);
  rows[0].summary = '새 revision';
  await done.view({}, deps);
  await assert.rejects(done.open({ ...identity, reference: 'detail' }, {}), /목록이 바뀌었/);
  await assert.rejects(done.view({}, { root, invoke: async () => ({ error: { code: 1 }, stdout: '' }) }), /공유 기록을 읽지 못/);
  await assert.rejects(done.view({}, { root, invoke: async () => ({ stdout: '{}' }) }), /읽기 전용 응답/);
  await assert.rejects(done.view({}, { root, invoke: async () => ({ stdout: 'not json' }) }), /응답 형식/);
  await assert.rejects(done.view({}, { root, timeoutMs: 10, invoke: async () => new Promise(() => {}) }), /시간이 초과/);
  let releaseOld;
  const delayed = done.view({}, { root, invoke: async () => new Promise(resolve => { releaseOld = resolve; }) });
  while (!releaseOld) await new Promise(resolve => setTimeout(resolve, 1));
  const newer = await done.view({}, deps);
  releaseOld({ stdout: JSON.stringify({ scope: 'done', readOnly: true, tasks: [{ ...rows[0], summary: 'older response' }, rows[1]], warnings: [] }) });
  await delayed;
  assert.equal((await done.plan({ snapshotId: newer.snapshotId, id: 'DONE-TASK', fingerprint: fp, newId: 'NEXT-TASK', reason: '추가 확인' }, deps)).created, false);
  const task = (id, reason) => ({ id, fingerprint: fp, targets: 'PC-ONE,PC-TWO', summary: id, detail: '[상세](docs/task.md)', reason });
  const followupData = { scope: 'pc', machine: os.hostname().toUpperCase(), ready: [task('READY-TASK', '')],
    running: [{ ...task('RUN-TASK', ''), owner: '/root/worker', heartbeatAt: 1794000000 }],
    blocked: [{ ...task('HELD-TASK', '사용자 명시 보류 유지'), checkpoint: { file: 'C:\\Users\\private\\state.txt', savedAt: 1794000000 } },
      { ...task('WAIT-TASK', 'H7 원자료 입력 대기'), checkpoint: { file: path.join(root, 'reports/result.json'), savedAt: 1794000000 } }] };
  const followup = await done.followups({}, { root, invoke: async (_command, args) => { assert(args.includes('show')); return { stdout: JSON.stringify(followupData) }; } });
  assert.equal(followup.tasks.length, 4);
  assert.deepEqual(followup.tasks.map(row => row.displayState), ['running', 'ready', 'held', 'blocked']);
  assert.equal(followup.tasks[0].owner, '/root/worker'); assert.equal(followup.tasks[2].checkpoint.reference, null);
  assert(!JSON.stringify(followup).includes('C:\\Users\\private'));
  assert.equal(followup.tasks[3].checkpoint.reference, 'reports/result.json');
  await done.open({ scope: 'followup', snapshotId: followup.snapshotId, id: 'WAIT-TASK', fingerprint: fp, reference: 'checkpoint' },
    { openPath: async file => { assert.equal(file, path.join(root, 'reports/result.json')); return ''; } });
  await assert.rejects(done.plan({ scope: 'followup', snapshotId: followup.snapshotId, id: 'WAIT-TASK', fingerprint: fp, newId: 'NEXT-TASK', reason: 'x' }, deps), /활성/);
  assert.equal((await done.plan({ snapshotId: newer.snapshotId, id: 'DONE-TASK', fingerprint: fp, newId: 'NEXT-TASK', reason: 'x' }, deps)).created, false);
  let openCalls = 0, junctionEscapeChecked = false;
  rows[0].detail = '[상세](docs/link/task.md)';
  const outside = fs.mkdtempSync(path.join(base, 'outside-')); fs.writeFileSync(path.join(outside, 'task.md'), 'outside');
  try {
    fs.symlinkSync(outside, path.join(root, 'docs/link'), process.platform === 'win32' ? 'junction' : 'dir');
    const linked = await done.view({}, deps);
    await assert.rejects(done.open({ snapshotId: linked.snapshotId, id: 'DONE-TASK', fingerprint: fp, reference: 'detail' },
      { openPath: async () => { openCalls++; return ''; } }), /저장소 범위 밖/);
    assert.equal(openCalls, 0);
    junctionEscapeChecked = true;
  } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; console.log('SKIP: symlink privilege unavailable'); }
  assert.deepEqual(fs.readFileSync(path.join(root, 'docs/task.md')), before);
  console.log(JSON.stringify({ ok: true, cases: ['read projection', 'secret/path masking', 'active and invalid resume refusal', 'non-mutating plan',
    'safe evidence opening', 'unsafe reference refusal', 'stale snapshot refusal', 'read/parse errors', 'overall read timeout',
    'out-of-order backend response', 'live followup state projection', 'separate Done/followup snapshots', 'checkpoint path boundary',
    'source unchanged'], junctionEscapeChecked, retainedFixtureRoot: root }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });

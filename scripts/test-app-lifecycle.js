'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create } = require('../src/core/app-lifecycle');

const COMMIT = 'a'.repeat(40);
const tests = [];
const test = (name, run) => tests.push({ name, run });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lifecycle-test-'));
  const controls = { authorized: true, busy: false };
  const snapshot = { version: '1.32.58', policy: 'standard', approval: 'approved',
    status: 'pending', commit: COMMIT, delivery: null };
  const calls = { check: 0, arm: 0, quit: 0, relaunch: 0, consents: [], scheduled: [] };
  const hooks = {};
  const workerId = crypto.randomUUID();
  const options = {
    root, instanceId: 'test-instance-a', authorized: () => controls.authorized,
    busy: () => controls.busy, snapshot: () => snapshot,
    check: async expectedCommit => { calls.check++; if (hooks.check) return hooks.check(expectedCommit); },
    arm: async commit => {
      calls.arm++;
      if (hooks.arm) return hooks.arm(commit);
      snapshot.delivery = { id: workerId, commit, status: 'armed', needsRecovery: false };
      return { id: workerId, status: 'armed' };
    },
    consent: async (id, commit, allowed) => {
      calls.consents.push({ id, commit, allowed });
      if (hooks.consent) return hooks.consent(id, commit, allowed);
      if (!allowed) snapshot.delivery = { ...snapshot.delivery, status: 'blocked' };
    },
    quit: () => { calls.quit++; }, relaunch: () => { calls.relaunch++; },
    schedule: fn => { calls.scheduled.push(fn); }
  };
  const service = create(options);
  const request = (action, id, extra = {}) => service.request({ action, request_id: id,
    confirmed: true, ...(action === 'apply' ? { expected_commit: COMMIT } : {}), ...extra });
  return { root, controls, snapshot, calls, hooks, workerId, options, service, request,
    receipt: id => path.join(root, 'lifecycle-requests', `${id}.json`) };
}

async function withFixture(run) {
  const context = fixture();
  try { await run(context); }
  finally {
    const target = path.resolve(context.root);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('hub-lifecycle-test-'));
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    fs.rmSync(target, { recursive: true, force: true });
  }
}

async function eventually(probe, accepts) {
  const deadline = Date.now() + 3000;
  let latest;
  do {
    const value = await probe();
    latest = value;
    if (accepts(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail('scheduled lifecycle continuation exceeded 3 seconds: ' + JSON.stringify(latest));
}

test('duplicate check returns its receipt without repeating the check or writing it', () => withFixture(async f => {
  const id = crypto.randomUUID();
  const first = await f.request('check', id);
  assert.equal(first.status, 'complete');
  assert.equal(first.summary.version, f.snapshot.version);
  const before = fs.readFileSync(f.receipt(id));
  const marker = fs.readFileSync(path.join(f.root, 'lifecycle-active.json'));
  const repeated = await f.request('check', id);
  assert.deepEqual(repeated, first);
  assert.deepEqual(fs.readFileSync(f.receipt(id)), before);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'lifecycle-active.json')), marker);
  assert.equal(f.calls.check, 1);
  assert.equal(f.calls.scheduled.length, 0);
  await assert.rejects(f.request('restart', id), { code: 'request_id_conflict' });
}));

test('an in-flight request blocks concurrent execution before its first await completes', () => withFixture(async f => {
  const first = f.request('check', crypto.randomUUID());
  await assert.rejects(f.request('check', crypto.randomUUID()), { code: 'request_pending' });
  await first;
  assert.equal(f.calls.check, 1);
}));

test('an interrupted prior-instance check releases the reservation without replaying its ID', () => withFixture(async f => {
  const id = crypto.randomUUID();
  await f.request('check', id);
  const record = JSON.parse(fs.readFileSync(f.receipt(id), 'utf8'));
  record.status = 'checking';
  fs.writeFileSync(f.receipt(id), JSON.stringify(record), 'utf8');
  const before = fs.readFileSync(f.receipt(id));
  const next = create({ ...f.options, instanceId: 'test-instance-b' });
  assert.equal((await next.result(id)).status, 'interrupted');
  assert.equal((await next.request({ action: 'check', request_id: id, confirmed: true })).status, 'interrupted');
  assert.equal(f.calls.check, 1);
  assert.equal((await next.status()).unresolved, false);
  const fresh = await next.request({ action: 'check', request_id: crypto.randomUUID(), confirmed: true });
  assert.equal(fresh.status, 'complete');
  assert.equal(f.calls.check, 2);
  assert.equal((await next.result(id)).status, 'interrupted');
  assert.deepEqual(fs.readFileSync(f.receipt(id)), before);
}));

test('scheduled apply is armed once and reserves the service until the worker resolves', () => withFixture(async f => {
  const id = crypto.randomUUID();
  const first = await f.request('apply', id);
  assert.equal(first.status, 'scheduled');
  const before = fs.readFileSync(f.receipt(id));
  assert.deepEqual(await f.request('apply', id), first);
  assert.deepEqual(fs.readFileSync(f.receipt(id)), before);
  assert.equal(f.calls.arm, 1);
  assert.equal(f.calls.scheduled.length, 1);
  assert.equal(f.calls.consents.length, 0);
  await assert.rejects(f.request('restart', crypto.randomUUID()), { code: 'request_pending' });
  assert.equal(f.calls.relaunch, 0);
}));

test('busy after arm cancels consent and never quits', () => withFixture(async f => {
  const id = crypto.randomUUID();
  await f.request('apply', id);
  f.controls.busy = true;
  f.calls.scheduled.shift()();
  await eventually(() => fs.promises.readFile(f.receipt(id), 'utf8').then(JSON.parse), record => record.status === 'blocked');
  assert.deepEqual(f.calls.consents, [{ id: f.workerId, commit: COMMIT, allowed: false }]);
  assert.equal(f.calls.quit, 0);
  assert.equal(f.calls.relaunch, 0);
}));

test('cancellation keeps the reservation while the external worker still reports armed', () => withFixture(async f => {
  const id = crypto.randomUUID();
  f.hooks.consent = async () => {};
  await f.request('apply', id);
  f.controls.busy = true;
  f.calls.scheduled.shift()();
  await eventually(() => fs.promises.readFile(f.receipt(id), 'utf8').then(JSON.parse), record => record.status === 'blocked');
  f.controls.busy = false;
  await assert.rejects(f.request('check', crypto.randomUUID()), { code: 'request_pending' });
  assert.equal(f.calls.quit, 0);
  f.snapshot.delivery.status = 'blocked';
  assert.equal((await f.request('check', crypto.randomUUID())).status, 'complete');
}));

test('authorization revoked after consent prevents quitting and cancels the worker', () => withFixture(async f => {
  const id = crypto.randomUUID();
  f.hooks.consent = async (worker, commit, allowed) => {
    if (allowed) f.controls.authorized = false;
    else f.snapshot.delivery = { id: worker, commit, status: 'blocked', needsRecovery: false };
  };
  await f.request('apply', id);
  f.calls.scheduled.shift()();
  await eventually(() => fs.promises.readFile(f.receipt(id), 'utf8').then(JSON.parse), record => record.status === 'blocked');
  assert.deepEqual(f.calls.consents.map(call => call.allowed), [true, false]);
  assert.equal(f.calls.quit, 0);
  await assert.rejects(f.service.result(id), { code: 'unauthorized' });
}));

test('worker verification requires the exact worker ID and commit and still needs acceptance', () => withFixture(async f => {
  const id = crypto.randomUUID();
  await f.request('apply', id);
  const next = create({ ...f.options, instanceId: 'test-instance-b' });
  f.snapshot.delivery = { id: crypto.randomUUID(), commit: COMMIT, status: 'verified', needsRecovery: false };
  assert.equal((await next.result(id)).status, 'unknown');
  f.snapshot.delivery = { id: f.workerId, commit: 'b'.repeat(40), status: 'verified', needsRecovery: false };
  assert.equal((await next.result(id)).status, 'unknown');
  f.snapshot.delivery.commit = COMMIT;
  const result = await next.result(id);
  assert.equal(result.status, 'worker-verified');
  assert.equal(result.needsAcceptance, true);
  assert.equal(f.calls.quit, 0);
}));

test('an ID-specific worker receipt preserves verified history after the global receipt changes', () => withFixture(async f => {
  const id = crypto.randomUUID();
  await f.request('apply', id);
  const before = fs.readFileSync(f.receipt(id));
  const history = new Map([[f.workerId, { ...f.snapshot.delivery, status: 'verified',
    appRoot: 'unreported-root', message: 'private worker detail' }]]);
  const lookups = [];
  const next = create({ ...f.options, instanceId: 'test-instance-b', delivery: worker => {
    lookups.push(worker);
    return history.get(worker) || null;
  } });
  const first = await next.result(id);
  assert.equal(first.status, 'worker-verified');
  assert.equal(first.needsAcceptance, true);
  f.snapshot.delivery = { id: crypto.randomUUID(), commit: 'b'.repeat(40), status: 'armed', needsRecovery: false };
  assert.deepEqual(await next.result(id), first);
  assert.ok(lookups.every(worker => worker === f.workerId));
  assert.equal(JSON.stringify(first).includes('private worker detail'), false);
  assert.equal(JSON.stringify(first).includes('unreported-root'), false);
  assert.deepEqual(fs.readFileSync(f.receipt(id)), before);
  assert.equal(f.calls.arm, 1);
  assert.equal(f.calls.quit, 0);
}));

test('a changed expected commit is rejected before arming', () => withFixture(async f => {
  const result = await f.request('apply', crypto.randomUUID(), { expected_commit: 'b'.repeat(40) });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'commit_changed');
  assert.equal(f.calls.arm, 0);
  assert.equal(f.calls.scheduled.length, 0);
}));

test('an invalid update policy cannot invoke the updater', () => withFixture(async f => {
  f.snapshot.policy = 'invalid';
  const result = await f.request('apply', crypto.randomUUID());
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'update_policy_invalid');
  assert.equal(f.calls.arm, 0);
  assert.equal(f.calls.scheduled.length, 0);
}));

test('manual policy performs a pinned preflight without an installer build', () => withFixture(async f => {
  f.snapshot.policy = 'manual';
  f.hooks.check = async expectedCommit => { assert.equal(expectedCommit, COMMIT); };
  const result = await f.request('apply', crypto.randomUUID());
  assert.equal(result.status, 'scheduled');
  assert.equal(f.calls.arm, 1);
  assert.equal(f.calls.quit, 0);
}));

test('an existing JSON null receipt is invalid and its bytes are preserved', () => withFixture(async f => {
  const id = crypto.randomUUID();
  const file = f.receipt(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'null\n', 'utf8');
  const before = fs.readFileSync(file);
  await assert.rejects(f.request('check', id), { code: 'receipt_invalid' });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(f.calls.check, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'lifecycle-active.json')), false);
}));

test('an existing JSON null active marker is preserved without starting another request', () => withFixture(async f => {
  const file = path.join(f.root, 'lifecycle-active.json');
  fs.writeFileSync(file, 'null\n', 'utf8');
  const before = fs.readFileSync(file);
  await assert.rejects(f.request('check', crypto.randomUUID()), { code: 'active_invalid' });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(f.calls.check, 0);
}));

test('a new instance observes restart without reporting product acceptance', () => withFixture(async f => {
  const id = crypto.randomUUID();
  await f.request('restart', id);
  f.calls.scheduled.shift()();
  await eventually(() => f.service.result(id), result => result.status === 'exiting' && f.calls.relaunch === 1);
  const restarted = create({ ...f.options, instanceId: 'test-instance-b' });
  const before = fs.readFileSync(f.receipt(id));
  const result = await restarted.result(id);
  assert.equal(result.status, 'restart-observed');
  assert.equal(result.needsAcceptance, true);
  assert.deepEqual(fs.readFileSync(f.receipt(id)), before);
  assert.equal(f.calls.relaunch, 1);
}));

test('an uncertain arm is never replayed and continues blocking a new request', () => withFixture(async f => {
  const id = crypto.randomUUID();
  f.hooks.arm = async commit => {
    f.snapshot.delivery = { id: f.workerId, commit, status: 'armed', needsRecovery: false };
    throw new Error('private diagnostic must stay local');
  };
  const first = await f.request('apply', id);
  assert.equal(first.status, 'blocked');
  assert.equal(first.needsRecovery, true);
  assert.equal(JSON.stringify(first).includes('private diagnostic'), false);
  assert.deepEqual(await f.request('apply', id), first);
  await assert.rejects(f.request('restart', crypto.randomUUID()), { code: 'request_pending' });
  const next = create({ ...f.options, instanceId: 'test-instance-b' });
  const result = await next.request({ action: 'apply', request_id: id, expected_commit: COMMIT, confirmed: true });
  assert.equal(result.status, 'unknown');
  assert.equal(result.needsRecovery, true);
  assert.equal(f.calls.arm, 1);
  assert.equal(f.calls.scheduled.length, 0);
}));

for (const action of ['restart', 'apply']) {
  test('prior instance releases an interrupted unarmed ' + action, () => withFixture(async f => {
    const id = crypto.randomUUID();
    let entered;
    const atPreflight = new Promise(resolve => { entered = resolve; });
    f.hooks.check = () => { entered(); return new Promise(() => {}); };
    const pending = f.request(action, id);
    if (action === 'restart') await pending;
    else await atPreflight;
    const next = create({ ...f.options, instanceId: 'test-instance-b' });
    assert.equal((await next.result(id)).status, 'interrupted');
    assert.equal((await next.status()).unresolved, false);
    const fresh = await next.request({ action: 'restart', confirmed: true, request_id: crypto.randomUUID() });
    assert.equal(fresh.status, 'scheduled');
    assert.equal((await next.result(id)).status, 'interrupted');
    assert.equal(f.calls.arm, 0);
    assert.equal(f.calls.relaunch, 0);
  }));
}

for (const transition of ['terminal', 'missing', 'different-commit', 'recovery']) {
  test('worker changed while granting exit consent: ' + transition, () => withFixture(async f => {
    const id = crypto.randomUUID();
    f.hooks.consent = async (_, __, allow) => {
      if (!allow) return;
      if (transition === 'terminal') f.snapshot.delivery.status = 'blocked';
      if (transition === 'missing') f.snapshot.delivery = null;
      if (transition === 'different-commit') f.snapshot.delivery.commit = 'b'.repeat(40);
      if (transition === 'recovery') f.snapshot.delivery.needsRecovery = true;
    };
    await f.request('apply', id);
    f.calls.scheduled.shift()();
    await eventually(() => fs.promises.readFile(f.receipt(id), 'utf8').then(JSON.parse),
      record => record.status === 'blocked');
    assert.equal(f.calls.quit, 0);
    assert.deepEqual(f.calls.consents.map(call => call.allowed), [true, false]);
  }));
}

(async () => {
  for (const { name, run } of tests) {
    await run();
    console.log(`ok - ${name}`);
  }
  console.log(`${tests.length} lifecycle tests passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });

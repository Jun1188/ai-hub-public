'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create } = require('../src/core/native-sync');
const commit = 'a'.repeat(40);
const workerId = 'd8ad832b-ef42-4359-9d30-8c47e96e5cd6';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-hub-sync-'));
let serial = 0;
function fixture(overrides = {}) {
  const calls = [];
  const options = {
    root: path.join(temp, String(++serial)), busy: () => false, packaged: () => false,
    check: async () => ({ overlay: { known: true, commit } }),
    preflight: async pin => { calls.push('check ' + pin); return { status: 'up-to-date', commit }; },
    arm: async pin => { calls.push('arm ' + pin); return { id: workerId }; },
    build: async () => { calls.push('build'); return { message: 'ok', version: '1.0.1', sha256: 'f'.repeat(64) }; },
    delivery: () => ({ id: workerId, commit, status: 'verified' }),
    wait: async () => {}, ...overrides,
  };
  return { calls, options, controller: create(options) };
}
const pending = async () => ({ status: 'pending', commit });
(async () => {
  process.env.APPDATA = path.join(temp, 'profiles');
  const profile = path.join(process.env.APPDATA, 'ai-hub');
  fs.mkdirSync(profile, { recursive: true });
  const repo = require('../src/core/repository-update');
  assert.equal(repo.manualPolicy(), 'standard');
  const policyFile = path.join(profile, 'manual-sync-policy.local.json');
  fs.writeFileSync(policyFile, '{');
  assert.equal(repo.manualPolicy(), 'invalid');
  fs.writeFileSync(policyFile, JSON.stringify({ mode: 'manual' }));
  assert.equal(repo.manualPolicy(), 'manual');
  fs.writeFileSync(path.join(profile, 'repository-update.local.json'), JSON.stringify({schemaVersion:1,enabled:true}));
  assert.deepEqual(await repo.sync(), { status: 'disabled', message: '이 PC의 저장소 자동 갱신이 꺼져 있습니다.' });
  const idle = fixture();
  assert.equal((await idle.controller.resume()).phase, 'idle');
  assert.deepEqual(idle.calls, []);
  assert(!fs.existsSync(idle.options.root));
  assert.equal((await idle.controller.begin()).phase, 'complete');
  assert.deepEqual(idle.calls, ['check ' + commit, 'build']);
  const f = fixture({ preflight: pending });
  assert.equal((await f.controller.begin()).phase, 'restart');
  assert.deepEqual(f.calls, ['arm ' + commit]);
  assert.equal((await create({ ...f.options, returnedId: 'other' }).resume()).phase, 'blocked');
  let reads = 0;
  const returned = create({ ...f.options, returnedId: workerId, delivery: () => ({
    id: workerId, commit, status: ++reads === 1 ? 'relaunching' : 'verified',
  }) });
  await returned.resume(); await returned.resume();
  assert.deepEqual(f.calls, ['arm ' + commit, 'build']);
  for (const change of [{ commit: 'b'.repeat(40) }, { status: 'blocked' }, { pluginStatus: 'blocked' }]) {
    const failed = fixture({ preflight: pending });
    await failed.controller.begin();
    const worker = create({ ...failed.options, returnedId: workerId, delivery: () => ({ id: workerId, commit, status: 'verified', ...change }) });
    assert.equal((await worker.resume()).phase, 'blocked');
    assert.deepEqual(failed.calls, ['arm ' + commit]);
  }
  const expired = fixture({ preflight: pending });
  await expired.controller.begin();
  const file = path.join(expired.options.root, 'manual-sync-state.local.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), expires: 1 }));
  await create({ ...expired.options, returnedId: workerId }).resume();
  assert.deepEqual(expired.calls, ['arm ' + commit]);
  for (const preflight of [async () => ({ status: 'up-to-date', commit: 'b'.repeat(40) }),
    async () => ({ status: 'up-to-date', commit, plugin: { status: 'blocked' } })]) {
    const f = fixture({ preflight });
    assert.equal((await f.controller.begin()).phase, 'blocked');
    assert.deepEqual(f.calls, []);
  }
  assert.equal((await fixture({ check: async () => ({ overlay: { known: false } }) }).controller.begin()).phase, 'blocked');
  await assert.rejects(fixture({ busy: () => true }).controller.begin(), /작업/);
  const installed = fixture({ packaged: () => true });
  assert.equal((await installed.controller.begin()).phase, 'complete');
  assert.deepEqual(installed.calls, ['check ' + commit]);
  let finish;
  const concurrent = fixture({ build: () => new Promise(resolve => { finish = resolve; }) });
  const started = concurrent.controller.begin();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(concurrent.controller.begin(), /작업/);
  finish({ message: 'done' }); await started;
  console.log('Manual sync verified: commit pin, explicit click, verified return, failed/expired receipt, concurrency and source/packaged scope.');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

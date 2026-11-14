'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const identity = require('../src/core/profile-identity');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-profile-guard-'));
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('ok - ' + name); };
const readModule = (name, overrides, processValue = process) => {
  const file = path.join(__dirname, '../src/core', name);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports,
    require: id => Object.hasOwn(overrides, id) ? overrides[id] : require(id),
    process: processValue, __dirname: path.dirname(file), Buffer, setTimeout, clearTimeout });
  return module.exports;
};

(async () => {
  const dataA = path.join(root, 'a'), dataB = path.join(root, 'b');
  const browserA = path.join(dataA, 'browser'), browserB = path.join(dataB, 'browser');
  for (const folder of [browserA, browserB]) fs.mkdirSync(folder, { recursive: true });
  for (const folder of [dataA, dataB]) fs.writeFileSync(path.join(folder, 'config.local.json'), '{"dummy":"never-read"}');
  const proofA = identity.capture({ dataRoot: dataA, chromiumProfile: browserA });
  check('stable metadata identity without reading config contents', () => {
    assert.equal(proofA.status, 'available');
    assert.deepEqual(identity.capture({ dataRoot: dataA, chromiumProfile: browserA }), proofA);
    assert.equal(JSON.stringify(proofA).includes(root), false);
    assert.equal(JSON.stringify(proofA).includes('never-read'), false);
  });
  check('another data view has another identity', () => {
    assert.notEqual(identity.capture({ dataRoot: dataB, chromiumProfile: browserB }).fingerprint, proofA.fingerprint);
  });
  const vault = path.join(dataA, 'credentials.local');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'key-table.v2.json'), '{}');
  check('a newly visible credential store changes proof without reading its contents', () => {
    assert.notEqual(identity.capture({ dataRoot:dataA, chromiumProfile:browserA }).fingerprint, proofA.fingerprint);
  });
  const beforeReplacement = identity.capture({ dataRoot:dataA, chromiumProfile:browserA });
  const table = path.join(vault, 'key-table.v2.json');
  fs.writeFileSync(table + '.next', '{}');
  fs.renameSync(table + '.next', table);
  check('same named credential table from a different file is refused', () => {
    assert.notEqual(identity.capture({ dataRoot:dataA, chromiumProfile:browserA }).fingerprint, beforeReplacement.fingerprint);
  });
  check('current profile uses Electron userData rather than a guessed browser path', () => {
    const module = readModule('profile-identity.js', { './paths': { hubDataDir: () => dataA },
      electron: { app: { getPath: name => { assert.equal(name, 'userData'); return browserB; } },
        BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, isVisible: () => true }] } } });
    const current = module.current();
    assert.equal(current.fingerprint, identity.capture({ dataRoot: dataA, chromiumProfile: browserB }).fingerprint);
    assert.equal(current.requireGui, true);
  });
  check('headless callers cannot invent an Electron profile baseline', () => {
    const module = readModule('profile-identity.js', { electron: {} });
    assert.equal(module.current().status, 'unavailable');
  });
  check('actual Chromium profile selection is part of identity', () => {
    assert.notEqual(identity.capture({ dataRoot: dataA, chromiumProfile: browserB }).fingerprint, proofA.fingerprint);
  });
  check('same path strings with redirected file IDs do not match', () => {
    const stat = (file, options) => {
      const value = fs.statSync(file, options);
      return { dev: value.dev, ino: value.ino + 1n, isDirectory: () => value.isDirectory(), isFile: () => value.isFile() };
    };
    assert.notEqual(identity.capture({ dataRoot: dataA, chromiumProfile: browserA, stat }).fingerprint, proofA.fingerprint);
  });
  check('unsupported metadata fails closed without private diagnostic text', () => {
    const unavailable = identity.capture({ dataRoot: dataA, chromiumProfile: browserA,
      stat: () => { throw new Error('private-path-or-key-must-not-appear'); } });
    assert.equal(unavailable.status, 'unavailable');
    assert.equal(JSON.stringify(unavailable).includes('private-path'), false);
  });
  check('config atomic replacement changes identity and requires a new acceptance baseline', () => {
    const initial = identity.capture({ dataRoot: dataA, chromiumProfile: browserA });
    const temporary = path.join(dataA, 'config-replacement.json');
    fs.writeFileSync(temporary, '{"dummy":"replacement"}');
    fs.renameSync(temporary, path.join(dataA, 'config.local.json'));
    assert.notEqual(identity.capture({ dataRoot: dataA, chromiumProfile: browserA }).fingerprint, initial.fingerprint);
  });
  check('pointer adds PID and a metadata-only profile proof', () => {
    const pointer = readModule('app-root-pointer.js', { './paths': { hubDataDir: () => dataB },
      './profile-identity': { current: () => proofA } }, { pid: 12345 });
    const result = pointer.record({ appRoot: path.join(root, 'app'), version: '1.32.59', packaged: true });
    assert.equal(result.pid, 12345);
    assert.equal(result.profileIdentity.fingerprint, proofA.fingerprint);
    assert.equal(result.profileIdentity.status, 'available');
    assert.equal(Object.hasOwn(result.profileIdentity, 'config'), false);
  });

  const roaming = path.join(root, 'roaming'), data = path.join(roaming, 'ai-hub');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'repository-update.local.json'), JSON.stringify({ schemaVersion: 1, enabled: true }));
  const workerId = '00000000-0000-4000-8000-000000000001', commit = 'a'.repeat(40);
  const receiptFile = path.join(data, 'repository-apply-result.json');
  const applicationRoot = path.resolve(__dirname, '..');
  let profile = { ...proofA, requireGui: true }, dispatches = 0, dispatchArgs;
  const repository = readModule('repository-update.js', {
    './profile-identity': { current: () => profile },
    crypto: { randomUUID: () => workerId },
    child_process: { execFile(command, args, options, callback) {
      if (command === 'python') callback(null, JSON.stringify({ status: 'pending', commit }));
      else {
        dispatches++; dispatchArgs = args;
        fs.writeFileSync(receiptFile, JSON.stringify({ appRoot: applicationRoot, id: workerId, status: 'armed', commit }));
        callback(null, '{}');
      }
    } }
  }, { env: { APPDATA: roaming, SystemRoot: path.join(root, 'windows') }, platform: 'win32' });
  await repository.sync();
  await repository.startAfterExit({ guiPid: 12345, exe: 'fixture.exe', packaged: true,
    lite: false, port: 8763, pointerPath: path.join(data, 'app-root.json'), expectedCommit: commit });
  check('original caller passes its current proof and visible GUI requirement to dispatch', () => {
    assert.equal(dispatchArgs[dispatchArgs.indexOf('-ExpectedProfileFingerprint') + 1], proofA.fingerprint);
    assert.ok(dispatchArgs.includes('-RequireGui'));
    assert.equal(dispatches, 1);
  });
  profile = { schemaVersion: 1, status: 'unavailable' };
  await assert.rejects(repository.startAfterExit({ guiPid: 12345, expectedCommit: commit }));
  check('unknown original profile cannot start any worker', () => assert.equal(dispatches, 1));
  fs.writeFileSync(receiptFile, JSON.stringify({ appRoot: applicationRoot, id: workerId, status: 'blocked',
    commit, needsRecovery: true, expectedProfileFingerprint: proofA.fingerprint }));
  profile = { schemaVersion: 1, status: 'available', fingerprint: 'b'.repeat(64) };
  await assert.rejects(repository.startAfterExit({ guiPid: 12345, recover: true }));
  check('recovery cannot silently adopt the current wrong profile as its new baseline', () => assert.equal(dispatches, 1));
  profile = { ...proofA, requireGui: true };
  await repository.startAfterExit({ guiPid: 12345, recover: true });
  check('recovery from the original profile reuses the interrupted request proof', () => {
    assert.equal(dispatches, 2);
    assert.ok(dispatchArgs.includes('-Recover'));
    assert.equal(dispatchArgs[dispatchArgs.indexOf('-ExpectedProfileFingerprint') + 1], proofA.fingerprint);
  });
  console.log(`${passed} profile JS cases passed; metadata and mocked dispatch only`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  const target = path.resolve(root);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('hub-profile-guard-'));
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
  fs.rmSync(target, { recursive: true, force: true });
});

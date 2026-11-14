'use strict';
// The real Chromium profile selector and queue resource run against disposable user homes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-queue-profile-'));
const repo = path.join(workspace, 'repository');
fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
fs.writeFileSync(path.join(repo, 'tools', 'todo_queue.py'), '# fixture');

let home;
let app;
let queueQueries = 0;
const load = Module._load;
Module._load = function (id, parent, main) {
  if (id === 'electron') return { app };
  if (id === 'os') return { ...os, homedir: () => home };
  if (id === './shared-agent-context') return { manifest: () => ({ sourceRepository: repo }) };
  if (id === 'child_process') return {
    execFile(command, args, options, callback) {
      assert.equal(command, 'python');
      assert.deepEqual(args, [path.join(repo, 'tools', 'todo_queue.py'), '--repo', repo, 'show', '--json', '--limit', '6']);
      queueQueries++;
      callback(null, '{"machine":"fixture"}');
    },
  };
  return load.call(this, id, parent, main);
};

async function exercise(location, storage, browser, oldChromium, expectOld) {
  home = path.join(workspace, location);
  const roaming = path.join(home, 'AppData', 'Roaming');
  const data = path.join(roaming, storage);
  const old = path.join(roaming, 'AI All-In-One Hub');
  fs.mkdirSync(data, { recursive: true });
  if (browser) fs.mkdirSync(path.join(data, 'browser'));
  if (oldChromium) fs.mkdirSync(old);
  const selected = expectOld ? old : path.join(data, 'browser');
  const dirs = { appData: roaming };
  let primary = true;
  app = {
    getPath: name => dirs[name], setPath: (name, value) => { dirs[name] = value; },
    getName: () => 'ai-hub', hasSingleInstanceLock: () => primary,
  };
  process.type = 'browser';
  process.env.APPDATA = roaming;
  process.env.COMPUTERNAME = os.hostname();
  delete process.env.AIHUB_SELFTEST;
  delete process.env.AGENT_WORK_DIR;
  for (const source of ['../src/core/paths', '../electron/user-profile', '../src/core/shared-todo-queue']) {
    delete require.cache[require.resolve(source)];
  }
  require('../electron/user-profile');
  const queue = require('../src/core/shared-todo-queue');
  assert.equal(dirs.userData, selected);
  assert.equal(dirs.sessionData, selected);
  if (expectOld) fs.mkdirSync(path.join(data, 'browser'));
  assert.equal(queue.deviceProfile(), true, location);
  assert.equal((await queue.read()).available, true, location);
  const allowedQueries = queueQueries;
  async function denied(label) {
    assert.equal(queue.deviceProfile(), false, label);
    assert.equal((await queue.read()).reason, 'isolated-profile', label);
    assert.equal(queueQueries, allowedQueries, label);
  }
  primary = false; await denied('secondary instance'); primary = true;
  dirs.userData = path.join(roaming, 'ai-hub'); await denied('config root is not a browser profile');
  dirs.userData = path.join(home,'other-profile'); await denied('foreign user data'); dirs.userData = selected;
  dirs.sessionData = path.dirname(selected); await denied('different session data'); dirs.sessionData = selected;
  process.env.APPDATA = home; await denied('redirected environment'); process.env.APPDATA = roaming;
  dirs.appData = home; await denied('redirected appData'); dirs.appData = roaming;
  process.env.COMPUTERNAME = 'DIFFERENT-' + os.hostname(); await denied('another host'); process.env.COMPUTERNAME = os.hostname();
  process.env.AGENT_WORK_DIR = workspace; await denied('agent workspace'); delete process.env.AGENT_WORK_DIR;
  process.env.AIHUB_SELFTEST = path.join(home, 'isolated-test'); await denied('Electron self-test');
  delete require.cache[require.resolve('../electron/user-profile')];
  require('../electron/user-profile');
  assert.notEqual(dirs.userData, selected);
  assert.equal(dirs.sessionData, dirs.userData);
  await denied('initialized isolated Electron profile');
}

(async () => {
  await exercise('fresh', 'ai-hub', false, false, false);
  await exercise('preserved', 'ai-hub', false, true, true);
  await exercise('canonical', 'ai-hub', true, true, false);
  await exercise('old-storage', 'ai-allinone-hub', true, false, false);
  assert.equal(queueQueries, 4);
  console.log('Queue profile: four production layouts accepted and isolated, secondary, redirected and mismatched profiles refused.');
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => {
    Module._load = load;
    fs.rmSync(workspace, { recursive: true, force: true });
  });

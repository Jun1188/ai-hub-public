#!/usr/bin/env node
// Run manually: node scripts/test-source-run-update.js. No Electron or real update is invoked.
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
const handlers = new Map();
const requests = [];
let lite = false;
let result = { status: 'pending', version: '2.0.0', message: 'next launch' };
const context = {
  require(name) {
    if (name.endsWith('/repository-update')) return { manualPolicy: () => 'standard', async sync(options) { requests.push(options); return result; } };
    if (name.endsWith('/device-profile')) return { lite: () => lite };
    throw new Error('Unexpected module: ' + name);
  },
  app: { getVersion: () => '1.0.0' },
  sendToWindow() {},
  handle: (name, fn) => handlers.set(name, fn),
};
const start = main.indexOf('async function checkAndMaybeUpdate');
assert(start >= 0);
vm.runInNewContext(main.slice(start, main.indexOf('// Every URL another AI', start)), context);
(async () => {
  const full = await handlers.get('update:check')();
  assert.equal(full.available, true);
  assert.equal(requests[0].lite, false);
  lite = true;
  // Older callers may send a Setup path. It must never be used.
  const light = await handlers.get('update:install')({ setup: 'untrusted-setup.exe' });
  assert.equal(light.available, true);
  assert.equal(requests[1].lite, true);
  assert.equal(requests[1].startup, undefined, 'live calls must only check');
  result = { status: 'blocked', message: 'runtime changed' };
  const blocked = await handlers.get('update:check')();
  assert.equal(blocked.available, false);
  assert.equal(blocked.error, 'runtime changed');
  assert.equal(handlers.get('update:defer')().onQuit, false);
  assert(!/updater\.(stageSetup|runInstaller)|stagedUpdate|scheduleAutoInstall/.test(main));
  console.log('Full/lite checks use the existing repository; Setup input is ignored; runtime block and defer retained.');
})().catch(error => { console.error(error); process.exitCode = 1; });

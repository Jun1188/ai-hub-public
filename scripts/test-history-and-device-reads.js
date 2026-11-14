// Isolated disk and IPC regressions; never load a Hub module before selecting a fake profile.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test, after } = require('node:test');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-read-regression-'));
process.env.USERPROFILE = process.env.HOME = sandbox;
process.env.LOCALAPPDATA = sandbox;
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function profile(name) {
  process.env.APPDATA = path.join(sandbox, name);
  for (const mod of ['../src/core/stats', '../src/core/config', '../src/mcp/authcheck']) {
    delete require.cache[require.resolve(mod)];
  }
  const stats = require('../src/core/stats');
  const config = require('../src/core/config');
  const auth = require('../src/mcp/authcheck');
  for (const file of [stats.HISTORY_FILE, stats.STATS_FILE, config.LOCAL_FILE]) {
    assert.equal(path.dirname(file), path.join(process.env.APPDATA, 'ai-hub'));
  }
  return { stats, config, auth };
}

function denyRead(file, code, fn) {
  const original = fs.readFileSync;
  fs.readFileSync = function (target, ...args) {
    if (target === file) throw Object.assign(new Error('fixture read error'), { code });
    return original.call(this, target, ...args);
  };
  try { return fn(); } finally { fs.readFileSync = original; }
}

const entry = { taskType: 'fixture', model: 'local-fixture', ok: true, elapsedMs: 10, tokens: 3 };

test('missing, genuine zero, real rows, partial JSONL and retry', () => {
  const { stats } = profile('history');
  assert.equal(stats.summary().totalDelegations, 0);
  assert.deepEqual(stats.models(), {});
  stats.record(entry);
  assert.equal(stats.summary().models[entry.model].totalTokens, 3);
  const original = fs.readFileSync(stats.HISTORY_FILE);
  denyRead(stats.HISTORY_FILE, 'EACCES', () => {
    assert.throws(() => stats.history(), /이력을 읽을 수/);
    assert.equal(stats.summary().totalDelegations, null);
    assert.equal(stats.summary().models[entry.model].count, 1);
  });
  assert.equal(stats.summary().totalDelegations, 1);
  fs.appendFileSync(stats.HISTORY_FILE, 'broken\n{}\n[]\nnull\n{"ts":"bad","ok":false}\n{"ts":"2026-07-30T04:12:32Z","ok":false}\n');
  assert.equal(stats.history().length, 2);
  assert.equal(stats.summary().totalDelegations, 2);
  assert.equal(stats.summary().skippedHistoryRows, 5);
  fs.writeFileSync(stats.HISTORY_FILE, '{truncated');
  assert.throws(() => stats.history(), /이력을 읽을 수/);
  assert.equal(stats.summary().totalDelegations, null);
  fs.writeFileSync(stats.HISTORY_FILE, original);
  assert.equal(stats.summary().skippedHistoryRows, 0);
  assert.equal(stats.history()[0].model, entry.model);
});

test('unreadable statistics never replace existing totals or break delegation', () => {
  const { stats } = profile('stats');
  stats.record(entry);
  const bytes = fs.readFileSync(stats.STATS_FILE);
  for (const code of ['EACCES', 'EBUSY', 'ENOENT']) {
    denyRead(stats.STATS_FILE, code, () => {
      assert.equal(stats.latencyOf(entry.model), null);
      assert.equal(stats.reasoningRatioOf(entry.model), null);
      assert.equal(stats.summary().models, null);
      stats.record(entry);
    });
    assert.deepEqual(fs.readFileSync(stats.STATS_FILE), bytes);
  }
  assert.equal(stats.history().length, 4);
  for (const damaged of ['null', '[]', '{', '{"models":[]}']) {
    fs.writeFileSync(stats.STATS_FILE, damaged);
    stats.record(entry);
    assert.equal(fs.readFileSync(stats.STATS_FILE, 'utf8'), damaged);
  }
  fs.writeFileSync(stats.STATS_FILE, bytes);
  stats.record(entry);
  assert.equal(stats.summary().models[entry.model].count, 2);
});

test('cold missing creates once, warm failures preserve bytes, cache and auth contract', async () => {
  const { config, auth } = profile('warm-config');
  const initial = config.load();
  const token = initial.hub.authToken;
  config.setLocalOnly('memory.dir', 'fixture-directory');
  const bytes = fs.readFileSync(config.LOCAL_FILE);
  for (const code of ['EACCES', 'EBUSY', 'ENOENT']) {
    denyRead(config.LOCAL_FILE, code, () => {
      assert.throws(() => config.save(initial), { code: 'HUB_DEVICE_CONFIG_READ' });
      assert.throws(() => config.setLocalOnly('memory.dir', 'replacement'), { code: 'HUB_DEVICE_CONFIG_READ' });
      assert.equal(config.refreshAuthToken(), null);
      assert.equal(initial.hub.authToken, token);
      assert.equal(initial.memory.dir, 'fixture-directory');
      assert.throws(() => config.reload(), { code: 'HUB_DEVICE_CONFIG_READ' });
    });
    assert.deepEqual(fs.readFileSync(config.LOCAL_FILE), bytes);
    assert.equal(config.load().hub.authToken, token);
  }
  for (const invalid of ['fixture-private-fragment{', 'null', '[]', 'false']) {
    fs.writeFileSync(config.LOCAL_FILE, invalid);
    assert.throws(() => config.reload(), err =>
      err.code === 'HUB_DEVICE_CONFIG_READ' && !err.message.includes('fixture-private') && !err.message.includes(sandbox));
    const diagnosis = await auth.checkAuth({ port: 0 });
    assert.equal(diagnosis.ok, false);
    assert.equal(diagnosis.reason, 'no_token_on_disk');
    assert.doesNotMatch(diagnosis.message, /\.corrupt-|fixture-private/);
    assert.ok(!diagnosis.message.includes(sandbox));
    assert.equal(config.refreshAuthToken(), null);
    assert.equal(fs.readFileSync(config.LOCAL_FILE, 'utf8'), invalid);
  }
  fs.writeFileSync(config.LOCAL_FILE, bytes);
  assert.equal(config.load().hub.authToken, token);
  assert.equal(config.setLocalOnly('memory.dir', 'recovered').memory.dir, 'recovered');
  assert.equal(config.refreshAuthToken(), token);
});

test('failed first read preserves the file and retries in the same process', () => {
  const { config } = profile('cold-read');
  const bytes = '{"hub":{"authToken":"synthetic-fixture"},"memory":{"dir":"keep"}}';
  fs.writeFileSync(config.LOCAL_FILE, bytes);
  denyRead(config.LOCAL_FILE, 'EBUSY', () => assert.throws(() => config.load(), { code: 'HUB_DEVICE_CONFIG_READ' }));
  assert.equal(fs.readFileSync(config.LOCAL_FILE, 'utf8'), bytes);
  assert.equal(config.load().memory.dir, 'keep');
});

test('unrelated writes keep external device changes; explicit rotation and whole-config callers still work', () => {
  const { config } = profile('rotation');
  const initial = config.load();
  const originalToken = initial.hub.authToken;
  const fresh = { hub: { authToken: 'fixture-rotated' }, memory: { dir: 'other-instance' } };
  const bytes = JSON.stringify(fresh, null, 4);
  fs.writeFileSync(config.LOCAL_FILE, bytes);
  config.update({ ui: { devMode: true } });
  assert.equal(fs.readFileSync(config.LOCAL_FILE, 'utf8'), bytes);
  assert.equal(config.load().hub.authToken, 'fixture-rotated');
  assert.equal(config.load().memory.dir, 'other-instance');
  initial.ui.devMode = false;
  config.save(initial); // An earlier full object can still be held by a downstream caller.
  assert.equal(config.refreshAuthToken(), 'fixture-rotated');
  assert.equal(config.update({ hub: { authToken: originalToken } }).hub.authToken, originalToken);
  const edit = config.load();
  edit.downstreamServers.fixture = { type: 'http', url: 'http://localhost', headers: { mode: 'fake' } };
  fresh.hub.authToken = 'fixture-second';
  fs.writeFileSync(config.LOCAL_FILE, JSON.stringify(fresh));
  config.save(edit);
  assert.equal(config.refreshAuthToken(), 'fixture-second');
  assert.equal(config.load().downstreamServers.fixture.headers.mode, 'fake');
  delete config.load().downstreamServers.fixture;
  config.save(config.load());
  assert.ok(!fs.readFileSync(config.LOCAL_FILE, 'utf8').includes('fake'));
  assert.equal(config.refreshAuthToken(), 'fixture-second');
});

test('shared rename failure hides OS details and an ordinary retry commits', () => {
  const { config } = profile('shared-write');
  const initial = config.load();
  const bytes = fs.readFileSync(config.LOCAL_FILE);
  const rename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (path.basename(to) === 'config.cache.json') {
      throw Object.assign(new Error('denied: ' + to), { code: 'EACCES' });
    }
    return rename.call(this, from, to);
  };
  try {
    assert.throws(() => config.update({ ui: { devMode: true } }), err =>
      err.code === 'HUB_SHARED_CONFIG_WRITE' && !err.message.includes(sandbox));
  } finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(config.LOCAL_FILE), bytes);
  assert.equal(config.load().ui.devMode, initial.ui.devMode);
  assert.equal(config.update({ ui: { devMode: true } }).ui.devMode, true);
  assert.equal(config.refreshAuthToken(), initial.hub.authToken);
});

test('damage inside a model preserves original bytes; optional legacy fields still accumulate', () => {
  const { stats } = profile('invalid-model-values');
  const fixture = { count: 1, emaMs: 10, totalTokens: 3 };
  for (const patch of [{ count: 'broken' }, { count: -1 }, { count: 1.5 }, { emaMs: '10' },
    { totalTokens: '3' }, { totalTokens: -1 }, { reasoningRatio: 2 }]) {
    const bytes = JSON.stringify({ models: { [entry.model]: { ...fixture, ...patch } } });
    fs.writeFileSync(stats.STATS_FILE, bytes);
    assert.equal(stats.summary().models, null);
    assert.equal(stats.latencyOf(entry.model), null);
    stats.record(entry);
    assert.equal(fs.readFileSync(stats.STATS_FILE, 'utf8'), bytes);
  }
  fs.writeFileSync(stats.STATS_FILE, JSON.stringify({ models: { [entry.model]: { count: 3 } } }));
  stats.record(entry);
  const updated = stats.summary().models[entry.model];
  assert.equal(updated.count, 4);
  assert.equal(updated.emaMs, entry.elapsedMs);
  assert.equal(updated.totalTokens, 3);
});

test('cold first writer cannot replace a concurrently published token', () => {
  const { config } = profile('race');
  const winner = '{"hub":{"authToken":"fixture-winner"},"memory":{"dir":"winner"}}';
  const link = fs.linkSync;
  fs.linkSync = function (from, to) {
    if (to === config.LOCAL_FILE) fs.writeFileSync(to, winner, { flag: 'wx' });
    return link.call(this, from, to);
  };
  try {
    assert.throws(() => config.load(), { code: 'HUB_DEVICE_CONFIG_WRITE' });
  } finally {
    fs.linkSync = link;
  }
  assert.equal(fs.readFileSync(config.LOCAL_FILE, 'utf8'), winner);
  assert.equal(config.load().memory.dir, 'winner');
  assert.equal(config.refreshAuthToken(), 'fixture-winner');
});

test('history renderer keeps independent results and ignores an older reply', async () => {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', innerHTML: '',
      get textContent() { return this.innerHTML.replace(/<[^>]*>/g, ''); },
      set textContent(text) { this.innerHTML = text; },
      addEventListener() {}, replaceChildren() { this.innerHTML = ''; },
    });
    return elements.get(id);
  }
  const act = { items: [], summary: { delegation: { count: 0, last: null } } };
  const sum = { totalDelegations: 0, okCount: 0, background: 0, escalations: 0, models: {} };
  const hub = { activityList: async () => act, historySummary: async () => sum };
  const context = vm.createContext({ window: { hub }, $: element, esc: String, call: (fn, ...args) => fn(...args) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/tabs/history.js'), 'utf8'), context);
  const refresh = () => vm.runInContext('refreshHistory()', context);
  await refresh();
  assert.match(element('hist-summary').innerHTML, /총 <b>0/);
  let finish;
  hub.historySummary = () => new Promise(resolve => { finish = resolve; });
  const slow = refresh();
  hub.historySummary = async () => ({ ...sum, totalDelegations: null });
  await refresh();
  finish(sum);
  await slow;
  assert.match(element('hist-summary').textContent, /이력을 읽지 못/);
  hub.historySummary = async () => ({ ...sum, skippedHistoryRows: 1, models: null });
  await refresh();
  assert.match(element('hist-summary').innerHTML, /읽지 못한 기록 1건/);
  assert.match(element('hist-models').innerHTML, /통계를 읽지 못/);
  hub.activityList = async () => { throw new Error('fake IPC failure'); };
  hub.historySummary = async () => sum;
  await refresh();
  assert.match(element('act-summary').innerHTML, /활동 이력을 읽지 못/);
  assert.match(element('hist-summary').innerHTML, /총 <b>0/);
});

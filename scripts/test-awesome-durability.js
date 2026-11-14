'use strict';

// The actual auto, publisher, and journal run together over virtual disk/Git/HTTP/kernel-lock fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const HOUR = 3600000, NOW = Date.parse('2026-11-13T00:00:00.000Z');
const MAIN = '1'.repeat(40), OLD = '2'.repeat(40);
const folder = path.join(path.parse(process.cwd()).root, 'awesome-durability-fixture', 'club-materials');
const scope = {guild: 'PRIVATE_GUILD', channel: 'PRIVATE_CHANNEL', forum: 'PRIVATE_FORUM',
  threads: ['PRIVATE_INFO', 'PRIVATE_NEWS'], news: 'PRIVATE_NEWS'};
const info = ['PRIVATE_INFO', 'PRIVATE_CHANNEL'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = () => hash(JSON.stringify({scope, info}));
const filename = name => path.join(folder, name);
const sources = Object.fromEntries(['awesome-auto.cjs', 'awesome-publish.cjs', 'awesome-journal.cjs'].map(name =>
  [name, fs.readFileSync(path.join(__dirname, '../src/core/club-materials', name), 'utf8')]));

function snapshot(at) {
  return {schemaVersion: 1, source: 'discord', status: 'snapshot', observedAt: new Date(at).toISOString(),
    periodStart: new Date(at - 30 * 86400000).toISOString(),
    categories: {news: {messageCount: 63, lastMessageAt: new Date(at - HOUR).toISOString()},
      info: {messageCount: 47, lastMessageAt: new Date(at - 2 * HOUR).toISOString()}}, items: []};
}

function world() {
  const w = {now: NOW, disk: new Map(), commits: 0, pushes: 0, dispatches: 0, collects: 0, gitCalls: 0,
    locked: false, errors: [], serial: 0, roots: new Map(), blobs: new Map(), history: new Map(),
    failState: 0, failClear: 0, journalFailure: null, dispatchFailure: false, collectionGate: null};
  const prior = snapshot(NOW - 7 * HOUR);
  w.remote = {commit: OLD, tree: hash(JSON.stringify(prior, null, 2) + '\n'), feed: prior};
  w.history.set(OLD, {...w.remote});
  w.disk.set(filename('awesome-site.local.json'), JSON.stringify({schemaVersion: 1, enabled: true,
    repository: 'your-org/your-site', intervalHours: 6, windowDays: 30, info, scope}));
  w.disk.set(filename('permission.json'), JSON.stringify(scope));
  return w;
}

function missing() { return Object.assign(Error('fixture missing'), {code: 'ENOENT'}); }

function boot(w) {
  const modules = new Map(), initial = [], intervals = [];
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [w.now])); }
    static now() { return w.now; }
  }
  const disk = {
    realpath: async file => file,
    readFile: async file => { if (!w.disk.has(file)) throw missing(); return w.disk.get(file); },
    mkdir: async () => {},
    mkdtemp: async () => { const root = 'fixture-bare-' + (++w.serial); w.roots.set(root, {}); return root; },
    rm: async root => { w.roots.delete(root); },
    open: async (file, mode) => {
      if (mode !== 'wx' || w.disk.has(file)) throw Error('fixture exclusive open failed');
      w.disk.set(file, '');
      return {writeFile: async text => w.disk.set(file, text), sync: async () => {}, close: async () => {}};
    },
    rename: async (from, to) => {
      if (!w.disk.has(from)) throw missing();
      const text = w.disk.get(from), failure = w.journalFailure;
      if (failure && JSON.parse(text).dispatch === failure.phase && failure.count > 0) {
        failure.count--;
        if (failure.after) { w.disk.set(to, text); w.disk.delete(from); }
        throw Error('fixture journal write failed');
      }
      w.disk.set(to, text); w.disk.delete(from);
    },
    unlink: async file => {
      if (file === filename('awesome-site-pending.json') && w.failClear > 0) {
        w.failClear--; throw Error('fixture cleanup failed');
      }
      if (!w.disk.delete(file)) throw missing();
    },
  };
  const net = {createServer: () => {
    const server = new EventEmitter();
    server.listen = (options, callback) => {
      if (process.platform === 'win32') assert.match(options.path, /ai-hub-awesome-[0-9a-f]{64}$/);
      else { assert.equal(options.host, '127.0.0.1'); assert.equal(options.port, 47632); }
      assert.equal(options.exclusive, true);
      if (w.locked) queueMicrotask(() => server.emit('error', {code: 'EADDRINUSE'}));
      else { w.locked = true; queueMicrotask(callback); }
    };
    server.unref = () => {};
    server.close = callback => { w.locked = false; queueMicrotask(callback); };
    return server;
  }};
  function git(args, input, root) {
    w.gitCalls++;
    const local = w.roots.get(root), command = args[0];
    if (command === 'ls-remote') return MAIN + '\trefs/heads/main\n' +
      (w.remote ? w.remote.commit + '\trefs/heads/automation/discord-awesome\n' : '');
    if (command === 'fetch') { local.parent = w.remote ? w.remote.commit : MAIN; return ''; }
    if (command === 'rev-parse') return args[1] === 'FETCH_HEAD' ? local.parent :
      (w.history.get(local.parent)?.tree || 'main-tree');
    if (command === 'ls-tree') return w.history.get(local.parent)?.links ? 'exhibition/discord/public-links.json' : '';
    if (command === 'show') return JSON.stringify(w.history.get(local.parent)[args[1].endsWith('public-links.json')?'links':'feed']);
    if (command === 'read-tree') {local.entries={};return '';}
    if (command === 'hash-object') { const id = hash(input); w.blobs.set(id, input); return id; }
    if (command === 'update-index') {const [,id,name]=args[3].split(',');local.entries[name]=w.blobs.get(id);return '';}
    if (command === 'write-tree') return hash(JSON.stringify(local.entries));
    if (command === 'commit-tree') {
      w.commits++;
      const commit = String(w.commits + 10).padStart(40, '0');
      w.history.set(commit, {commit, tree: args[1], feed: JSON.parse(local.entries['exhibition/discord/feed.json']),
        links:local.entries['exhibition/discord/public-links.json']&&JSON.parse(local.entries['exhibition/discord/public-links.json']), parent: local.parent});
      return commit;
    }
    if (command === 'push') {
      const commit = args[3].split(':')[0], next = w.history.get(commit);
      if (next.parent !== (w.remote ? w.remote.commit : MAIN)) throw Error('fixture conflicting push');
      w.remote = {...next}; w.pushes++; return '';
    }
    if (command === 'credential') return 'password=PRIVATE_FIXTURE_TOKEN\n';
    return '';
  }
  function spawn(executable, args, options) {
    assert.equal(executable, 'git');
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.kill = () => {};
    child.stdin.end = input => queueMicrotask(() => {
      if (w.gitFailure && args[6] === 'ls-remote') {
        const failure = w.gitFailure; w.gitFailure = null;
        if (failure === 'stdout-limit') child.stdout.emit('data', Buffer.alloc(1048577));
        if (failure === 'stderr-limit') child.stderr.emit('data', Buffer.alloc(1048577));
        child.emit('close', failure === 'exit' ? 1 : failure === 'null-close' ? null : 0,
          failure === 'signal' ? 'SIGTERM' : null);
        return;
      }
      try { child.stdout.emit('data', git(args.slice(6), input, options.cwd)); child.emit('close', 0); }
      catch { child.emit('close', 1); }
    });
    return child;
  }
  function load(name) {
    if (modules.has(name)) return modules.get(name).exports;
    const module = {exports: {}}; modules.set(name, module);
    const isAuto = name === 'awesome-auto.cjs';
    const sandbox = {
      module, exports: module.exports, Date: Clock, process: {platform: process.platform, env: {}}, AbortSignal, Buffer,
      console: {error: (...args) => w.errors.push(args)},
      setTimeout: callback => {
        if (isAuto) initial.push(callback);
        else if (w.gitFailure === 'timeout') { w.gitFailure = null; queueMicrotask(callback); }
        return {unref() {}};
      },
      setInterval: callback => { if (isAuto) intervals.push(callback); return {unref() {}}; },
      clearTimeout: () => {}, clearInterval: () => {},
      fetch: async (url, options) => {
        assert.equal(url, 'https://api.github.com/repos/your-org/your-site/actions/workflows/deploy-game-exhibition.yml/dispatches');
        assert.deepEqual(JSON.parse(options.body), {ref: 'main', inputs: {awesome_auto: true}});
        w.dispatches++;
        if (w.dispatchFailure) throw Error('fixture unknown HTTP outcome');
        return {status: 204, body: {cancel: async () => {}}};
      },
      require(request) {
        if (request === 'node:fs/promises') return disk;
        if (request === 'node:net') return net;
        if (request === 'node:child_process') return {spawn};
        if (request === './awesome-publish.cjs') return load('awesome-publish.cjs');
        if (request === './awesome-journal.cjs') return load('awesome-journal.cjs');
        if (request === './awesome-public-links.cjs') {
          const api=require('../src/core/club-materials/awesome-public-links.cjs');
          return {...api,candidates(){const links=api.candidates();
            return {observe:links.observe,verify:at=>links.verify(at,async()=>({type:'text/html',body:'<head><title>Fixture paper</title><meta name="description" content="Published fixture method."></head>'}))};}};
        }
        if (request === './hub-service.cjs') return {scope: value => value};
        if (request === './awesome-snapshot.cjs') return {collect: async ({observedAt,observeLink}) => {
          w.collects++;
          if (w.collectionGate) await w.collectionGate;
          const value = snapshot(Date.parse(observedAt));
          observeLink?.('news',Date.parse(observedAt)-HOUR,{content:'PRIVATE_MESSAGE https://arxiv.org/abs/2610.00001'});
          if(w.crossPosted)observeLink?.('info',Date.parse(observedAt)-2*HOUR,{content:'https://arxiv.org/abs/2610.00001'});
          if(w.frozen && w.remote)value.categories=w.remote.feed.categories;
          if (w.privateCollection) value.body = 'PRIVATE_BODY';
          return value;
        }};
        if (request === '../atomic-file') return {writeAtomic: async (file, text) => {
          if (file === filename('awesome-site-state.json') && w.failState > 0) {
            w.failState--; throw Error('fixture state write failed');
          }
          w.disk.set(file, text);
        }};
        return require(request);
      },
    };
    vm.runInNewContext(sources[name], sandbox, {filename: name});
    return module.exports;
  }
  const control = load('awesome-auto.cjs').start({dataDir: path.dirname(folder),
    connections: {get: () => ({origin: 'https://discord.com', auth: 'bot', maxCallsPerRun: 32})},
    broker: {request: async ({payload}) => {
      assert.equal(payload.route,'/api/v10/oauth2/applications/@me');
      return {flags:w.deniedIntent?0:1<<18};
    }}});
  assert.equal(initial.length, 1); assert.equal(intervals.length, 1);
  return {tick: initial[0], interval: intervals[0], busy: control.busy, stop: () => control.stop()};
}

function counts(w, collected, committed, dispatched) {
  assert.equal(w.collects, collected, 'collection count');
  assert.equal(w.commits, committed, 'commit count');
  assert.equal(w.pushes, committed, 'push count');
  assert.equal(w.dispatches, dispatched, 'dispatch count');
  assert.equal(w.locked, false, 'kernel lock released');
  for (const [file, text] of w.disk) {
    if (/awesome-site-(pending|state|attempt)\.json/.test(file)) assert.doesNotMatch(text, /PRIVATE_/);
  }
}
const state = w => JSON.parse(w.disk.get(filename('awesome-site-state.json')));
const pending = w => JSON.parse(w.disk.get(filename('awesome-site-pending.json')));

const cases = [
  ['cross-posts retain the original category ID and produce a distinct companion card',async()=>{
    const w=world(),app=boot(w);await app.tick();
    w.remote.links.items[0].id='previously-published-id'; w.history.set(w.remote.commit,{...w.remote});
    w.now+=6*HOUR;w.crossPosted=true;await app.interval();
    const cards=w.remote.links.items;assert.equal(cards.length,2);
    assert.equal(cards.find(r=>r.category==='news').id,'previously-published-id');
    assert.notEqual(cards[0].id,cards[1].id);
    assert.equal(cards[0].url,cards[1].url);
  }],
  ['a missing intent preserves an existing public feed and publishes aggregates; no empty initial companion',async()=>{
    const w=world(), app=boot(w);
    w.deniedIntent=true;await app.tick();counts(w,1,1,1);
    assert.equal(w.remote.links,undefined);
    assert.equal(state(w).publicLinks,'message_content_intent_required');
    w.deniedIntent=false;w.now+=6*HOUR;await app.interval();
    assert.ok(w.remote.links);
    w.deniedIntent=true;w.now+=6*HOUR;await app.interval();
    assert.deepEqual(w.remote.links.items.map(x=>x.title),['Fixture paper']);
    assert.equal(w.remote.links.observedAt,w.remote.feed.observedAt);
    assert.equal(state(w).publicLinks,'message_content_intent_required');
  }],
  ['unchanged categories and verified cards refresh a paired observation without a new dispatch', async()=>{
    const w=world(),app=boot(w);await app.tick();counts(w,1,1,1);
    assert.equal(w.remote.links.observedAt,w.remote.feed.observedAt);
    w.frozen=true;w.now+=6*HOUR;await app.interval();counts(w,2,2,1);
    assert.equal(w.remote.links.observedAt,w.remote.feed.observedAt);
    assert.equal(state(w).dispatch,'unchanged');
  }],
  ['publish success, state-save failure, restart at changed observation time', async () => {
    const w = world(); w.failState = 1;
    await boot(w).tick(); counts(w, 1, 1, 1);
    assert.equal(pending(w).dispatch, 'accepted');
    w.now += 2 * HOUR;
    await boot(w).tick(); counts(w, 1, 1, 1);
    assert.equal(state(w).observedAt, new Date(NOW).toISOString());
    assert.equal(state(w).dispatch, 'accepted');
  }],
  ['push success, pre-dispatch journal write failure, restart uses identical snapshot', async () => {
    const w = world(); w.journalFailure = {phase: 'attempted', after: false, count: 1};
    await boot(w).tick(); counts(w, 1, 1, 0);
    assert.equal(pending(w).commit, null);
    w.now += 2 * HOUR;
    await boot(w).tick(); counts(w, 1, 1, 1);
    assert.equal(state(w).observedAt, new Date(NOW).toISOString());
  }],
  ['durable dispatch claim followed by interruption before HTTP falls back to cron', async () => {
    const w = world(); w.journalFailure = {phase: 'attempted', after: true, count: 1};
    await boot(w).tick(); counts(w, 1, 1, 0);
    assert.equal(pending(w).dispatch, 'attempted');
    w.now += HOUR;
    await boot(w).tick(); counts(w, 1, 1, 0);
    assert.equal(state(w).dispatch, 'deferred');
  }],
  ['accepted HTTP followed by result-save failure is never dispatched again', async () => {
    const w = world(); w.journalFailure = {phase: 'accepted', after: false, count: 1};
    await boot(w).tick(); counts(w, 1, 1, 1);
    assert.equal(pending(w).dispatch, 'attempted');
    w.now += HOUR;
    await boot(w).tick(); counts(w, 1, 1, 1);
    assert.equal(state(w).dispatch, 'deferred');
  }],
  ['failed dispatch remains deferred across restart', async () => {
    const w = world(); w.dispatchFailure = true;
    await boot(w).tick(); counts(w, 1, 1, 1);
    assert.equal(state(w).dispatch, 'deferred');
    w.now += HOUR;
    await boot(w).tick(); counts(w, 1, 1, 1);
  }],
  ['state completion before pending cleanup does not replay publication', async () => {
    const w = world(); w.failClear = 1;
    await boot(w).tick(); counts(w, 1, 1, 1);
    assert.equal(state(w).dispatch, 'accepted');
    await boot(w).tick(); counts(w, 1, 1, 1);
    assert.equal(w.disk.has(filename('awesome-site-pending.json')), false);
  }],
  ['six-hour boundary starts one new legitimate cycle', async () => {
    const w = world(), app = boot(w);
    await app.tick();
    w.now += 6 * HOUR - 1; await app.interval(); counts(w, 1, 1, 1);
    w.now++; await app.interval(); counts(w, 2, 2, 2);
    await boot(w).tick(); counts(w, 2, 2, 2);
  }],
  ['overdue pending finishes before the next interval collects a new cycle', async () => {
    const w = world(); w.failState = 1;
    await boot(w).tick();
    w.now += 7 * HOUR;
    const app = boot(w); await app.tick(); counts(w, 1, 1, 1);
    w.now += 10 * 60000; await app.interval(); counts(w, 2, 2, 2);
  }],
  ['two independent auto instances cannot collect or dispatch concurrently', async () => {
    const w = world(); let proceed;
    w.collectionGate = new Promise(resolve => { proceed = resolve; });
    const first = boot(w), second = boot(w), firstTick = first.tick();
    for (let index = 0; index < 100 && !w.collects; index++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(w.collects, 1);
    assert.equal(first.busy(), true);
    await second.tick(); assert.equal(w.collects, 1); assert.equal(w.dispatches, 0);
    proceed(); await firstTick; counts(w, 1, 1, 1);
    assert.equal(first.busy(), false);
    await second.interval(); counts(w, 1, 1, 1);
  }],
  ['private collection fields are rejected before persistence or publication', async () => {
    const w = world(); w.privateCollection = true;
    await boot(w).tick(); counts(w, 1, 0, 0);
    assert.equal(w.disk.has(filename('awesome-site-pending.json')), false);
    assert.equal(w.gitCalls, 0);
  }],
  ['changed consent scope preserves pending work without publication', async () => {
    const w = world(); w.journalFailure = {phase: 'attempted', after: false, count: 1};
    await boot(w).tick();
    const original = w.disk.get(filename('awesome-site-pending.json'));
    const grant = JSON.parse(w.disk.get(filename('awesome-site.local.json')));
    grant.info = ['PRIVATE_CHANNEL'];
    w.disk.set(filename('awesome-site.local.json'), JSON.stringify(grant));
    await boot(w).tick(); counts(w, 1, 1, 0);
    assert.equal(w.disk.get(filename('awesome-site-pending.json')), original);
    assert.equal(JSON.parse(w.disk.get(filename('awesome-site-attempt.json'))).reason, 'snapshot_journal_scope_changed');
  }],
  ['pending recovery cannot overwrite a newer remote snapshot', async () => {
    const w = world(), value = snapshot(NOW - 2 * HOUR);
    w.remote.feed = snapshot(NOW - HOUR); w.history.set(OLD, {...w.remote});
    w.disk.set(filename('awesome-site-pending.json'), JSON.stringify({schemaVersion: 1,
      scopeDigest: digest(), snapshot: value, commit: null, dispatch: 'pending'}));
    await boot(w).tick(); counts(w, 0, 0, 0);
    assert.equal(w.remote.commit, OLD);
    assert.equal(JSON.parse(w.disk.get(filename('awesome-site-attempt.json'))).reason, 'snapshot_remote_newer');
    assert.equal(w.disk.has(filename('awesome-site-pending.json')), false);
    w.now += HOUR;
    await boot(w).tick(); counts(w, 1, 1, 1);
  }],
  ['persistent lock contention is visible and recovers after release', async () => {
    const w = world(); w.locked = true;
    const app = boot(w); await app.tick();
    assert.equal(w.disk.has(filename('awesome-site-attempt.json')), false);
    w.now += 600000; await app.interval();
    assert.equal(JSON.parse(w.disk.get(filename('awesome-site-attempt.json'))).reason, 'snapshot_lock_busy');
    assert.equal(app.busy(), false);
    w.locked = false; w.now += HOUR; await app.interval(); counts(w, 1, 1, 1);
  }],
  ['a newer successful state retires an old journal without replay', async () => {
    const w = world();
    w.disk.set(filename('awesome-site-pending.json'), JSON.stringify({schemaVersion: 1,
      scopeDigest: digest(), snapshot: snapshot(NOW - 2 * HOUR), commit: OLD, dispatch: 'accepted'}));
    w.disk.set(filename('awesome-site-state.json'), JSON.stringify({schemaVersion: 1,
      observedAt: new Date(NOW - HOUR).toISOString(), commit: OLD, dispatch: 'accepted'}));
    await boot(w).tick(); counts(w, 0, 0, 0);
    assert.equal(w.disk.has(filename('awesome-site-pending.json')), false);
    assert.equal(state(w).observedAt, new Date(NOW - HOUR).toISOString());
  }],
  ['an invalid existing journal is preserved and blocks publication', async () => {
    const w = world(), bytes = '{"private":"PRIVATE_BODY"}';
    w.disk.set(filename('awesome-site-pending.json'), bytes);
    await boot(w).tick();
    assert.equal(w.collects, 0); assert.equal(w.commits, 0); assert.equal(w.dispatches, 0);
    assert.equal(w.disk.get(filename('awesome-site-pending.json')), bytes);
    assert.equal(JSON.parse(w.disk.get(filename('awesome-site-attempt.json'))).reason, 'snapshot_journal_invalid');
  }],
];

for (const failure of ['exit', 'null-close', 'signal', 'stdout-limit', 'stderr-limit', 'timeout']) {
  cases.push(['Git ' + failure + ' cannot report successful publication', async () => {
    const w = world(); w.gitFailure = failure;
    await boot(w).tick(); counts(w, 1, 0, 0);
    assert.equal(w.disk.has(filename('awesome-site-state.json')), false);
    assert.equal(pending(w).commit, null);
    assert.equal(JSON.parse(w.disk.get(filename('awesome-site-attempt.json'))).reason, 'snapshot_git_failed');
  }]);
}

(async () => {
  for (const [name, run] of cases) { await run(); console.log('PASS ' + name); }
  console.log('awesome-durability: ' + cases.length + ' integrated fixture cases passed');
})().catch(error => {console.error(error); process.exitCode = 1;});

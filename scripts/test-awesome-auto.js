'use strict';

// Standalone regression cases; all state, timers, publishing, and collection are mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const NOW = Date.parse('2026-11-13T03:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const MISSING = Symbol('missing state');
const fixtureScope = {
  guild: 'fixture-guild',
  channel: 'fixture-channel',
  forum: 'fixture-forum',
  threads: [],
  news: 'fixture-news',
};

const modulePaths = {
  auto: require.resolve('../src/core/club-materials/awesome-auto.cjs'),
  snapshot: require.resolve('../src/core/club-materials/awesome-snapshot.cjs'),
  publish: require.resolve('../src/core/club-materials/awesome-publish.cjs'),
  service: require.resolve('../src/core/club-materials/hub-service.cjs'),
  atomic: require.resolve('../src/core/atomic-file.js'),
  journal: require.resolve('../src/core/club-materials/awesome-journal.cjs'),
};

async function runFixture(state) {
  const original = {
    readFile: fs.readFile,
    now: Date.now,
    setTimeout: global.setTimeout,
    setInterval: global.setInterval,
    clearTimeout: global.clearTimeout,
    clearInterval: global.clearInterval,
    consoleError: console.error,
  };
  const cached = new Map(Object.values(modulePaths).map(file => [file, require.cache[file]]));
  const writes = [];
  const errors = [];
  const timeouts = [];
  const intervals = [];
  const counts = { collect: 0, publish: 0, broker: 0 };
  let stop;

  function stub(file, exports) {
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  }

  function timer(list, callback, delay) {
    const handle = { callback, delay, unref() { return this; } };
    list.push(handle);
    return handle;
  }

  const grant = {
    schemaVersion: 1,
    enabled: true,
    repository: 'your-org/your-site',
    intervalHours: 6,
    windowDays: 30,
    info: ['fixture'],
    scope: fixtureScope,
  };

  try {
    Date.now = () => NOW;
    console.error = (...args) => errors.push(args);
    fs.readFile = async (file, options) => {
      let raw;
      switch (path.basename(String(file))) {
        case 'awesome-site.local.json':
          raw = JSON.stringify(grant);
          break;
        case 'permission.json':
          raw = JSON.stringify(fixtureScope);
          break;
        case 'awesome-site-state.json':
          if (state === MISSING) {
            const error = new Error('fixture state is absent');
            error.code = 'ENOENT';
            throw error;
          }
          raw = state;
          break;
        default:
          throw new Error(`Unexpected fixture read: ${file}`);
      }
      const encoding = typeof options === 'string' ? options : options && options.encoding;
      return encoding ? raw : Buffer.from(raw, 'utf8');
    };
    stub(modulePaths.snapshot, {
      collect: async () => {
        counts.collect += 1;
        return {
          schemaVersion: 1,
          observedAt: new Date(NOW).toISOString(),
          periodStart: new Date(NOW - 30 * 24 * HOUR).toISOString(),
          items: [],
        };
      },
    });
    stub(modulePaths.publish, {
      publish: async (snapshot, {claimDispatch}) => {
        counts.publish += 1;
        await claimDispatch('a'.repeat(40));
        return { commit: 'a'.repeat(40), dispatch: 'accepted' };
      },
    });
    // This fixture isolates grant and success-state guards. The durability tests exercise the real journal.
    stub(modulePaths.journal, { acquire: async () => () => {}, read: async () => null,
      snapshot: value => value, save: async () => {}, clear: async () => {} });
    stub(modulePaths.service, { scope: () => fixtureScope });
    stub(modulePaths.atomic, {
      writeAtomic: async (file, bytes) => {
        writes.push({ file: String(file), bytes: Buffer.from(bytes) });
      },
    });
    delete require.cache[modulePaths.auto];
    global.setTimeout = (callback, delay) => timer(timeouts, callback, delay);
    global.setInterval = (callback, delay) => timer(intervals, callback, delay);
    global.clearTimeout = () => {};
    global.clearInterval = () => {};

    const { start } = require(modulePaths.auto);
    const control = start({
      dataDir: path.join(path.parse(process.cwd()).root, 'awesome-auto-fixture'),
      connections: {
        get: name => {
          assert.equal(name, 'discord');
          return { origin: 'https://discord.com', auth: 'bot', maxCallsPerRun: 32 };
        },
      },
      broker: {
        request: async ({payload}) => {
          counts.broker += 1;
          assert.deepEqual(payload,{method:'GET',route:'/api/v10/oauth2/applications/@me'});
          return {flags:1<<18};
        },
      },
    });

    stop = () => control.stop();

    // Restore scheduling immediately: only the captured initial callback is fired.
    global.setTimeout = original.setTimeout;
    global.setInterval = original.setInterval;
    assert.equal(typeof control.stop, 'function');
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0].delay, 60_000);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].delay, 600_000);
    await timeouts[0].callback();
    assert.equal(counts.broker, counts.collect);
    return { counts, writes, errors };
  } finally {
    try {
      if (typeof stop === 'function') stop();
    } finally {
      fs.readFile = original.readFile;
      Date.now = original.now;
      global.setTimeout = original.setTimeout;
      global.setInterval = original.setInterval;
      global.clearTimeout = original.clearTimeout;
      global.clearInterval = original.clearInterval;
      console.error = original.consoleError;
      for (const [file, entry] of cached) {
        if (entry === undefined) delete require.cache[file];
        else require.cache[file] = entry;
      }
    }
  }
}

function namedWrites(result, filename) {
  return result.writes.filter(write => path.basename(write.file) === filename);
}

async function main() {
  for (const [name, state] of [
    ['first run with missing state', MISSING],
    ['due state', JSON.stringify({ schemaVersion: 1, observedAt: new Date(NOW - 7 * HOUR).toISOString() })],
  ]) {
    const result = await runFixture(state);
    assert.equal(result.counts.collect, 1, `${name}: collect`);
    assert.equal(result.counts.publish, 1, `${name}: publish`);
    const writes = namedWrites(result, 'awesome-site-state.json');
    assert.equal(writes.length, 1, `${name}: state write`);
    assert.equal(JSON.parse(writes[0].bytes.toString('utf8')).observedAt, new Date(NOW).toISOString(), name);
    assert.equal(result.errors.length, 0, `${name}: no error`);
  }

  const recent = await runFixture(JSON.stringify({
    schemaVersion: 1,
    observedAt: new Date(NOW - HOUR).toISOString(),
  }));
  assert.equal(recent.counts.collect, 0, 'recent state: no collect');
  assert.equal(recent.counts.publish, 0, 'recent state: no publish');
  assert.equal(namedWrites(recent, 'awesome-site-state.json').length, 0, 'recent state: no state write');
  assert.equal(recent.errors.length, 0, 'recent state: no error');

  const invalidStates = [
    ['null', 'null'],
    ['array', '[]'],
    ['string', '"fixture"'],
    ['wrong schema', JSON.stringify({ schemaVersion: 2, observedAt: new Date(NOW - 7 * HOUR).toISOString() })],
    ['invalid timestamp', JSON.stringify({ schemaVersion: 1, observedAt: 'invalid-fixture-date' })],
    ['numeric timestamp', JSON.stringify({ schemaVersion: 1, observedAt: NOW - 7 * HOUR })],
    ['future timestamp', JSON.stringify({ schemaVersion: 1, observedAt: new Date(NOW + HOUR).toISOString() })],
    ['malformed JSON', '{'],
  ];
  for (const [name, state] of invalidStates) {
    const result = await runFixture(state);
    assert.equal(result.counts.collect, 0, `${name}: no collect`);
    assert.equal(result.counts.publish, 0, `${name}: no publish`);
    assert.equal(namedWrites(result, 'awesome-site-state.json').length, 0, `${name}: preserve state`);
    const attempts = namedWrites(result, 'awesome-site-attempt.json');
    assert.equal(attempts.length, 1, `${name}: one failure attempt`);
    assert.equal(result.writes.length, 1, `${name}: only attempt is written`);
    const attempt = JSON.parse(attempts[0].bytes.toString('utf8'));
    assert.equal(attempt.schemaVersion, 1, name);
    assert.equal(attempt.phase, 'config', `${name}: configuration failure`);
    assert.equal(attempt.reason, name === 'malformed JSON' ? 'request_failed' : 'snapshot_state_invalid', name);
    assert.equal(result.errors.length, 1, `${name}: one captured error`);
  }

  console.log(`awesome-auto: ${3 + invalidStates.length} fixture cases passed`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

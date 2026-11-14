'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { hubDataDir } = require('./paths');

const directory = path.join(hubDataDir(), 'device-save-metrics');
const session = process.pid + '-' + randomUUID();
const filename = /^(\d+)-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.([01])\.json$/;
const pendingName = /^(\d+)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.pending$/;
const fields = ['requests','succeeded','failed','normalWrites','physicalWrites','renameRetries','requestRetries','nativeEntries'];
const zero = () => Object.fromEntries(fields.map(key => [key, 0]));
const counters = zero();
const requests = new AsyncLocalStorage();
const retention = 30 * 86400000;
const pruneLimit = 16;
let dirty = false, sequence = 0, pending = false, persistenceFailures = 0, lastPruned = 0;

function checkDirectory(create) {
  if (create) {
    try { fs.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('metrics_directory_unavailable');
}

function readRecord(file, id) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.nlink !== 1 || st.size > 2048) throw Error('invalid_snapshot');
  const value = JSON.parse(fs.readFileSync(file,'utf8'));
  const safe = n => Number.isSafeInteger(n) && n >= 0;
  if (value.schema !== 'hub-device-save/1' || value.session !== id || !safe(value.sequence)
      || !safe(value.persistenceFailures) || !fields.every(key => safe(value.counters?.[key]))) throw Error('invalid_snapshot');
  return value;
}

function prune(now) {
  if (now - lastPruned < 86400000) return;
  lastPruned = now;
  let removed = 0;
  for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
    const name = entry.name.match(filename) || entry.name.match(pendingName);
    if (!entry.isFile() || !name || entry.name.startsWith(session + '.')) continue;
    const file = path.join(directory, entry.name);
    try {
      if (now - fs.statSync(file).mtimeMs < retention) continue;
      try { process.kill(Number(name[1]), 0); continue; } catch (error) { if (error.code !== 'ESRCH') continue; }
      readRecord(file, entry.name.replace(/\.(?:[01]\.json|pending)$/, ''));
      fs.unlinkSync(file);
      if (++removed >= pruneLimit) return;
    } catch { /* A simultaneous prune or an unreadable file must not affect saves. */ }
  }
}

function flush() {
  pending = false;
  if (!dirty) return;
  try {
    checkDirectory(true);
    // A writer owns two slots. An interrupted overwrite leaves the last confirmed snapshot intact.
    const next = sequence + 1;
    const file = path.join(directory, session + '.' + (next % 2) + '.json');
    const temp = path.join(directory,session + '.pending');
    let opened = false;
    try {
      const fd = fs.openSync(temp,'wx',0o600);
      opened = true;
      try { fs.writeFileSync(fd,JSON.stringify({schema:'hub-device-save/1',session,sequence:next,counters,persistenceFailures})); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temp,file);
    } finally {
      if (opened) { try { fs.unlinkSync(temp); } catch { /* Best effort and limited to this session. */ } }
    }
    sequence = next;
    dirty = false;
    prune(Date.now());
  } catch { persistenceFailures++; }
}

function changed() {
  dirty = true;
  if (!pending) {
    pending = true;
    setImmediate(flush);
  }
}

function count(key) {
  const request = requests.getStore();
  if (request) request[key] = (request[key] || 0) + 1;
}

function finish(request, success) {
  counters.requests++;
  counters[success ? 'succeeded' : 'failed']++;
  if (success && request.physicalWrites && !request.nativeEntries && !request.requestRetries && !request.renameRetries) counters.normalWrites++;
  for (const key of ['physicalWrites','renameRetries','requestRetries','nativeEntries']) counters[key] += request[key] || 0;
  changed();
}

function track(fn) {
  return function tracked(...args) {
    if (requests.getStore()) return fn(...args);
    const request = {};
    return requests.run(request, () => {
      try {
        const result = fn(...args);
        if (result instanceof Promise) return result.then(value => { finish(request,true); return value; },
          error => { finish(request,false); throw error; });
        finish(request,true);
        return result;
      } catch (error) { finish(request,false); throw error; }
    });
  };
}

function summary() {
  const totals = zero(), retained = new Map();
  let unreadable = 0, persistenceLosses = 0;
  let entries;
  try { checkDirectory(false); entries = fs.readdirSync(directory, {withFileTypes:true}); }
  catch (error) { entries = []; if (error.code !== 'ENOENT') unreadable++; }
  for (const entry of entries) {
    const match = entry.name.match(filename);
    if (!entry.isFile() || !match) continue;
    const id = match[1] + '-' + match[2];
    try {
      const value = readRecord(path.join(directory,entry.name),id);
      if (!retained.has(id) || retained.get(id).sequence < value.sequence) retained.set(id,value);
    } catch { unreadable++; }
  }
  // A live process may have a later in-memory count or a failed disk write.
  if (counters.requests) retained.set(session, {counters,persistenceFailures});
  for (const record of retained.values()) {
    for (const key of fields) totals[key] += record.counters[key];
    persistenceLosses += record.persistenceFailures;
  }
  return {schema:1, retainedSessions:retained.size, totals, thisProcess:{...counters},
    coverage:'retained-best-effort', unreadableSlots:unreadable,
    observedPersistenceFailures:persistenceLosses, idleRetentionDays:30, maxPrunePerScan:pruneLimit};
}

process.once('exit', flush);
module.exports = {track,count,summary};

'use strict';

const fs = require('node:fs/promises'), path = require('node:path'), net = require('node:net');
const {createHash, randomUUID} = require('node:crypto');
const file = folder => path.join(folder, 'awesome-site-pending.json');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;

function snapshot(value) {
  if (!exact(value, ['schemaVersion', 'source', 'status', 'observedAt', 'periodStart', 'categories', 'items']) ||
      value.schemaVersion !== 1 || value.source !== 'discord' || value.status !== 'snapshot' ||
      !date(value.observedAt) || !date(value.periodStart) || Date.parse(value.observedAt) > Date.now() ||
      Date.parse(value.observedAt) - Date.parse(value.periodStart) !== 30 * 86400000 ||
      !exact(value.categories, ['news', 'info']) || !Array.isArray(value.items) || value.items.length) {
    throw Error('snapshot_journal_invalid');
  }
  for (const category of Object.values(value.categories)) {
    if (!exact(category, ['messageCount', 'lastMessageAt']) || !Number.isSafeInteger(category.messageCount) ||
        category.messageCount < 0 || (category.messageCount === 0) !== (category.lastMessageAt === null) ||
        category.lastMessageAt !== null && (!date(category.lastMessageAt) ||
          Date.parse(category.lastMessageAt) < Date.parse(value.periodStart) ||
          Date.parse(category.lastMessageAt) > Date.parse(value.observedAt))) throw Error('snapshot_journal_invalid');
  }
  return value;
}

function validate(value, scopeDigest) {
  const keys=['schemaVersion','scopeDigest','snapshot','commit','dispatch'];
  if(value && Object.hasOwn(value,'publicLinks'))keys.push('publicLinks');
  if(value && Object.hasOwn(value,'linkStatus')){
    keys.push('linkStatus');
    if(!['verified','message_content_intent_required','message_content_intent_unverified'].includes(value.linkStatus)||
      (value.linkStatus==='verified')!==Object.hasOwn(value,'publicLinks'))throw Error('snapshot_journal_invalid');
  }
  if (!exact(value, keys) || value.schemaVersion !== 1 ||
      !/^[a-f0-9]{64}$/.test(value.scopeDigest) || !['pending', 'attempted', 'accepted', 'deferred','unchanged'].includes(value.dispatch) ||
      value.commit === null && value.dispatch !== 'pending' || value.commit !== null &&
        (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.commit) || value.dispatch === 'pending')) {
    throw Error('snapshot_journal_invalid');
  }
  snapshot(value.snapshot);
  if(Object.hasOwn(value,'publicLinks'))require('./awesome-public-links.cjs').validate(value.publicLinks,value.snapshot.observedAt);
  if (value.scopeDigest !== scopeDigest) throw Error('snapshot_journal_scope_changed');
  return value;
}

async function read(folder, scopeDigest) {
  let text;
  try { text = await fs.readFile(file(folder), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let value;
  try { value = JSON.parse(text); } catch { throw Error('snapshot_journal_invalid'); }
  return validate(value, scopeDigest);
}

async function save(folder, value) {
  validate(value, value.scopeDigest);
  await fs.mkdir(folder, {recursive: true, mode: 0o700});
  const temporary = file(folder) + '.' + randomUUID() + '.tmp';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file(folder));
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function clear(folder) {
  await fs.unlink(file(folder)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

async function acquire(folder) {
  // Windows releases a named pipe on process exit. All aliases of the same data directory share it.
  const canonical = await fs.realpath(folder);
  const identity = createHash('sha256').update(canonical.toLowerCase()).digest('hex');
  const endpoint = process.platform === 'win32'
    ? {path: '\\\\.\\pipe\\ai-hub-awesome-' + identity, exclusive: true}
    : {host: '127.0.0.1', port: 47632, exclusive: true};
  const server = net.createServer(socket => socket.destroy());
  const acquired = await new Promise((resolve, reject) => {
    server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(Error('snapshot_lock_unavailable')));
    server.listen(endpoint, () => resolve(true));
  });
  if (!acquired) return null;
  server.unref();
  return () => new Promise(resolve => server.close(() => resolve()));
}

module.exports = {snapshot, read, save, clear, acquire};

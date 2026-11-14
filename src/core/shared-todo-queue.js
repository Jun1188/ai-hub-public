'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

let cached = null;
function invoke(command, args) {
  return new Promise(resolve => execFile(command, args, {
    windowsHide: true, timeout: 8000, maxBuffer: 256 * 1024,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  }, (error, stdout) => resolve({ error, stdout })));
}

/** The live checkout owns pending work; pinned skill releases are historical snapshots. */
async function read() {
  try {
    if (process.env.AIHUB_SELFTEST || process.env.AGENT_WORK_DIR || (process.type === 'browser' && !deviceProfile())) {
      return { available: false, source: 'TODO.md', reason: 'isolated-profile' };
    }
    const shared = require('./shared-agent-context').manifest();
    const root = shared?.sourceRepository || (await require('./repository-skills').repository()).root;
    const script = path.join(root, 'tools', 'todo_queue.py');
    const machine = (process.env.COMPUTERNAME || os.hostname()).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(machine)) throw new Error('Invalid machine id');
    const files = [path.join(root, 'TODO.md'), script, path.join(root, 'todo-queue', 'completed', machine + '.json')];
    const stamps = await Promise.all(files.map(async file => {
      try { const stat = await fs.promises.stat(file); return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`; }
      catch { return 'missing'; }
    }));
    if (stamps[1] === 'missing') return { available: false, source: 'TODO.md', reason: 'update_source_checkout_for_queue_manager' };
    // Completion invalidates immediately; local runtime accounting is refreshed at least every two seconds.
    const signature = `${root}:${stamps.join('|')}:${Math.floor(Date.now() / 2000)}`;
    if (cached?.signature === signature) return { ...cached.value };
    let result;
    for (const [command, prefix] of [['python', []], ['py', ['-3']]]) {
      result = await invoke(command, [...prefix, script, '--repo', root, 'show', '--json', '--limit', '6']);
      if (!result.error) break;
    }
    if (result.error) return { available: false, source: 'TODO.md', reason: 'queue_manager_or_python_unavailable' };
    const value = { available: true, details: 'docs/todo-queue.md', ...JSON.parse(String(result.stdout).replace(/^\uFEFF/, '')),
      scope: 'Per-PC active queue; completion is excluded, evidence is retained; no execution permission is granted.' };
    cached = { signature, value };
    return { ...value };
  } catch {
    return { available: false, source: 'TODO.md', reason: 'shared_repository_unavailable' };
  }
}
let workerStarted = false;
async function wake(trigger) {
  let weekly = false;
  try {
    const shared = require('./shared-agent-context').manifest();
    const root = shared?.sourceRepository || (await require('./repository-skills').repository()).root;
    const machine = (process.env.COMPUTERNAME || os.hostname()).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(machine)) return false;
    try {
      const policy = JSON.parse(fs.readFileSync(path.join(root, '.local', 'todo-queue', machine, 'worker', 'config.json'), 'utf8').trimStart());
      weekly = policy.mode === 'hub-weekly';
    } catch { /* Unconfigured PCs retain their existing startup/interval behavior. */ }
    if (weekly && trigger !== 'hub-start') return true;
    const script = path.join(root, 'tools', 'todo_worker.py');
    if (!fs.existsSync(script)) return;
    for (const [command, prefix] of [['python', []], ['py', ['-3']]]) {
      const result = await new Promise(resolve => execFile(command, [...prefix, script, '--repo', root, 'tick', '--trigger', trigger], {
        windowsHide: true, timeout: 70000, maxBuffer: 16384,
      }, error => resolve({ error })));
      if (!result.error) break;
    }
  } catch { /* Startup remains available; the next permitted Hub start retries. */ }
  return weekly;
}
function start() {
  if (workerStarted || !deviceProfile()) return;
  workerStarted = true;
  const initial = setTimeout(async () => {
    if (await wake('hub-start')) return;
    const interval = setInterval(() => wake('hub-timer'), 60000); interval.unref?.();
  }, 15000); initial.unref?.();
}
// Owner lifecycle of jobs the Hub runs itself (docs/todo-concurrency.md: start/resume -> owner-active, end -> owner-finished).
// The event is written straight into todo_worker's durable owner-events inbox, in the shape its own atomic_json writes, and
// only the drain is rate-limited: a slow, failing or missing Python delays an event but cannot lose it, and whatever is still
// there when the Hub exits is applied by the next scope query or tick (drain_events).
const OWNER_DRAIN_DELAY_MS = 2000, OWNER_DRAIN_BATCH = 64, OWNER_TRIP_AFTER = 3, OWNER_PAUSE_MS = 5 * 60 * 1000;
const startedOwners = new Map();
const ownerCounts = { written: 0, unavailable: 0, writeFailed: 0, drains: 0, drainFailed: 0 };
let ownerInbox = null, ownerUndrained = 0, ownerDrainTimer = null, ownerDrainFailures = 0, ownerPausedUntil = 0;
function deviceProfile() {
  if (process.type !== 'browser' || process.env.AIHUB_SELFTEST || process.env.AGENT_WORK_DIR) return false;
  try {
    if (process.env.COMPUTERNAME && process.env.COMPUTERNAME.toUpperCase() !== os.hostname().toUpperCase()) return false;
    const { app } = require('electron');
    if (!app.hasSingleInstanceLock()) return false;
    const roaming = app.getPath('appData');
    const same = (a, b) => path.relative(a, b) === '';
    if (!process.env.APPDATA || !same(roaming, path.join(os.homedir(), 'AppData', 'Roaming'))
      || !same(roaming, process.env.APPDATA)) return false;
    const selected = require('./paths').chromiumProfileDir();
    return same(app.getPath('userData'), selected) && same(app.getPath('sessionData'), selected);
  } catch { return false; }
}
function resolveOwnerInbox() {
  const config = require('./config').load();
  const localVolume = name => typeof name === 'string' && /^[A-Za-z]:[\\/]/.test(name)
    && path.parse(path.normalize(name)).root.toUpperCase() === path.parse(path.normalize(os.homedir())).root.toUpperCase();
  if (config.sharedContext?.bootstrapPath && !localVolume(config.sharedContext.bootstrapPath)) throw new Error('Nonlocal bootstrap');
  const shared = require('./shared-agent-context').manifest();
  const configured = shared?.sourceRepository || config.sharedContext?.repoPath;
  const machine = os.hostname().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(machine)) throw new Error('Invalid machine id');
  if (process.env.COMPUTERNAME && machine !== process.env.COMPUTERNAME.toUpperCase()) throw new Error('Device identity mismatch');
  const candidates = configured ? [configured] : ['Codex', 'GitHub'].map(dir =>
    path.join(os.homedir(), 'Documents', dir, 'codex-shared-context'));
  for (const root of candidates) {
    // The standalone Windows worker uses the local host only. Never traverse a network or redirected queue path.
    if (!localVolume(root)) continue;
    const worker = path.join(root, '.local', 'todo-queue', machine, 'worker');
    let current = path.parse(worker).root;
    let available = true;
    for (const segment of path.relative(current, worker).split(path.sep)) {
      current = path.join(current, segment);
      try {
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) { available = false; break; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; available = false; break; }
    }
    if (available) return { root, dir: path.join(worker, 'owner-events') };
  }
  throw Object.assign(new Error('No local worker'), { code: 'ENOENT' });
}
function scheduleOwnerDrain(root) {
  if (ownerDrainTimer) return;
  ownerDrainTimer = setTimeout(async () => {
    // A scope query is the protocol's own reprocessing path and changes nothing else; tick would also send a wakeup.
    const args = [path.join(root, 'tools', 'todo_worker.py'), '--repo', root, 'scope', 'status'];
    let result = await invoke('python', args);
    // Only a missing launcher falls back: a refusal by the script itself would be refused again by the other launcher.
    if (result.error && result.error.code === 'ENOENT') result = await invoke('py', ['-3', ...args]);
    ownerDrainTimer = null;
    if (result.error) {
      ownerCounts.drainFailed++;
      if (++ownerDrainFailures >= OWNER_TRIP_AFTER) { ownerDrainFailures = 0; ownerPausedUntil = Date.now() + OWNER_PAUSE_MS; }
    } else { ownerCounts.drains++; ownerDrainFailures = 0; ownerUndrained = Math.max(0, ownerUndrained - OWNER_DRAIN_BATCH); }
    // ownerUndrained is only a hint for asking again (other callers drain the same inbox); the files are the record.
    if (ownerUndrained) scheduleOwnerDrain(root);
  }, Math.max(OWNER_DRAIN_DELAY_MS, ownerPausedUntil - Date.now()));
  ownerDrainTimer.unref?.();
}
function recordOwnerEvent(inbox, event) {
  try {
    // Not recursive: worker/ is made by todo_worker after its migration check, so its absence means no queue state on this PC.
    try { fs.mkdirSync(inbox.dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const directory = fs.lstatSync(inbox.dir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Redirected owner event directory');
    const id = () => require('crypto').randomUUID().replace(/-/g, '');
    // Legacy readers use the JSON timestamp. Indexed readers also order simultaneous starts before finishes.
    const rank = event.command === 'owner-active' ? '0' : 'f';
    const file = path.join(inbox.dir, `${event.at}_${rank}${id().slice(1)}.json`);
    const temp = `${file}.${id()}.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(event) + '\n', 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    ownerCounts.written++; ownerUndrained++;
    scheduleOwnerDrain(inbox.root);
    return true;
  } catch (error) {
    ownerInbox = null;
    if (error.code === 'ENOENT') { ownerCounts.unavailable++; return false; }
    ownerCounts.writeFailed++;
    console.error(`[shared-todo-queue] ${event.command} of ${event.owner} was not recorded (${error.code || error.message})`);
    return false;
  }
}
function ownerEvent(command, owner, atMs) {
  // Only the real running Hub reports. Node test scripts are not 'browser'; an Electron self-test is, and it isolates APPDATA
  // only (electron/main.js), so the shared repository it resolves under the home folder is the user's real one.
  if (!deviceProfile() || typeof owner !== 'string' || !owner || owner.length > 100) return false;
  const active = startedOwners.get(owner);
  if (command === 'owner-finished' && !active) return false;
  const now = Date.now();
  const observed = (Number.isFinite(atMs) && atMs > 0 && atMs <= now ? atMs : now) / 1000;
  // A resumed logical job gets a different owner. A replay for its earlier attempt cannot release this attempt.
  if (command === 'owner-active' && active) return true;
  const attempt = active || { owner: owner + '-' + require('crypto').randomUUID(), at: observed };
  if (attempt.owner.length > 100) return false;
  const at = Math.max(observed, attempt.at);
  try {
    if (!ownerInbox) ownerInbox = resolveOwnerInbox();
    if (!recordOwnerEvent(ownerInbox, { command, owner: attempt.owner, at })) return false;
  } catch (error) {
    ownerCounts.unavailable++;
    return false;
  }
  if (command === 'owner-active') startedOwners.set(owner, attempt);
  else startedOwners.delete(owner);
  return true;
}
const ownerActive = (owner, atMs) => ownerEvent('owner-active', owner, atMs);
const ownerFinished = (owner, atMs) => ownerEvent('owner-finished', owner, atMs);
module.exports = { read, start, deviceProfile, ownerActive, ownerFinished,
  ownerCounts: () => ({ ...ownerCounts, undrained: ownerUndrained, pausedUntil: ownerPausedUntil }) };

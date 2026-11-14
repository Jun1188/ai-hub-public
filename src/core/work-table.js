// Hub side of the shared work table (codex-shared-context tools/work_table.py). The Hub only queues events: one file per
// event in ~/.agent-work/inbox.d, written then renamed so a reader never sees half a file; the Python tool folds
// them into the table that harness hooks inject. Local disk only (never the synced folder, rule 1). Rows carry kinds, worker
// names, counts and scrubbed short titles, never task text, file contents or session ids.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SHORT = { 'claude-code': 'claude', codex: 'codex', antigravity: 'agy', hub: 'hub' };
const LONG = { claude: 'claude-code', codex: 'codex', agy: 'antigravity', hub: 'hub' };
const ACTIVE_MS = 2 * 3600 * 1000; // the sweep only reports sessions whose log changed this recently
const HEAD_BYTES = 64 * 1024;

function dir() {
  if (process.env.AGENT_WORK_DIR) return process.env.AGENT_WORK_DIR;
  return path.join(os.homedir(), '.agent-work');
}

/** Same row key as work_table.key_of: 16 hex of sha256(<long harness name> NUL <session id>). */
const keyOf = (harness, sid) => crypto.createHash('sha256').update(`${LONG[harness] || harness}\u0000${sid}`).digest('hex').slice(0, 16);

/** work_table.logical: user folders become work:/app:/~/ so no absolute path reaches the table. */
function logical(p) {
  if (!p) return '';
  const norm = path.resolve(String(p)).replace(/\\/g, '/');
  const home = os.homedir().replace(/\\/g, '/');
  for (const [folder, tag] of [[`${home}/Documents/Codex`, 'work:'], [`${home}/Documents/ai-hub`, 'app:'], [home, '~/']]) {
    if (norm.toLowerCase() === folder.toLowerCase()) return tag === '~/' ? '~' : tag;
    if (norm.toLowerCase().startsWith(folder.toLowerCase() + '/')) return tag + norm.slice(folder.length + 1);
  }
  return require('./secret-scrub').scrub(norm);
}

const clean = (text, n = 60) => {
  const s = require('./secret-scrub').redactCredentials(require('./secret-scrub').scrub(String(text || ''))).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
};

// Only the running Hub (Electron main) writes unless AGENT_WORK_DIR names a folder: node test scripts exercise offload, bus and
// pipelines and must not add rows to the real table.
const enabled = () => Boolean(process.env.AGENT_WORK_DIR) || require('./shared-todo-queue').deviceProfile();

let seq = 0;
function emit(event) {
  if (!enabled()) return false;
  try {
    const q = path.join(dir(), 'inbox.d');
    fs.mkdirSync(q, { recursive: true });
    // Same name shape as the Python writer (19-digit epoch ns first), so the fold keeps arrival order across writers.
    const name = `${String(BigInt(Date.now()) * 1000000n + BigInt(seq++ % 1000000)).padStart(19, '0')}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    const tmp = path.join(q, `${name}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ t: Date.now() / 1000, ...event }), 'utf8');
    fs.renameSync(tmp, path.join(q, `${name}.json`));
    return true;
  } catch { return false; } // the table is advisory: Hub work never fails because of it
}

/** One row per Hub job. The attempt is the job id's hash, so a stale finish cannot close a newer attempt (Orca dispatchId). */
function job(kind, id, { worker, state, summary, ptr, at } = {}) {
  // Hash the whole id: bus ids are m-<time36>-<random>, and a prefix of two close messages is the same (review #48).
  const hash = crypto.createHash('sha256').update(String(id || '')).digest('hex');
  const head = hash.slice(0, 8);
  try {
    const queue = require('./shared-todo-queue');
    const owner = `hub-${kind}-${hash.slice(0, 32)}`;
    if (state === 'working') queue.ownerActive(owner, at);
    else if (state === 'done' || state === 'failed') queue.ownerFinished(owner, at);
  } catch { /* advisory, like the row itself */ }
  return emit({ ev: 'job', k: `hub-${kind}-${head}`, h: 'hub', w: worker ? `${kind}:${clean(worker, 16)}` : kind, s: state,
    sum: clean(summary), ...(ptr ? { ptr: logical(ptr) } : {}), att: head, src: 'hub' });
}
const ended = (ok) => (ok ? 'done' : 'failed');

/** Offload start/finish → rows. Returns the offload instance so the singleton line stays one expression. */
function watchOffload(offload) {
  offload.events.on('start', (r) => job('offload', r.id, { worker: r.worker, state: 'working', at: Date.parse(r.createdAt), summary: `offload ${r.worker} ${r.inputs} input(s)` }));
  offload.events.on('finish', (r) => job('offload', r.id, { worker: r.worker, state: ended(r.state === 'succeeded'), at: Date.parse(r.finishedAt),
    summary: `offload ${r.worker} ${r.state}${r.reason ? ' ' + r.reason : ''} ${r.resultCount} result(s), wait ${Math.round((r.usage && r.usage.waitMs || 0) / 1000)}s` }));
  return offload;
}

// Headless runs (`codex exec`, `claude -p`) are jobs started by a tool or by the Hub's own workers, not peer sessions:
// a bench run made a dozen rows in its first sweep (2026-10-26).
const HEADLESS = /"originator"\s*:\s*"codex_exec"|"entrypoint"\s*:\s*"sdk-/;

async function headMeta(file) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    const head = buf.toString('utf8', 0, bytesRead);
    const m = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(head);
    return { cwd: m ? JSON.parse(m[1]) : '', headless: HEADLESS.test(head) };
  } catch { return { cwd: '', headless: false }; } finally { if (fh) await fh.close(); }
}

/** The session id a hook would report for this log file, or null for subagent logs and other files. */
function sessionOf(harness, root, file) {
  const rel = path.relative(root, file).split(path.sep);
  if (harness === 'claude-code') return rel.length === 2 ? path.basename(file, '.jsonl') : null;
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file);
  return harness === 'codex' && m ? m[1] : null;
}

/**
 * Insurance for sessions without working hooks (not installed, untrusted, agy outside the Hub): a session whose log changed
 * recently and has no row gets one `unconfirmed` row with its logical folder only — no summary.
 * active: [{harness, root, file, mtimeMs}]. Returns how many rows were queued.
 */
async function sweep(active, now = Date.now()) {
  const recent = active.filter((a) => now - a.mtimeMs < ACTIVE_MS);
  if (!recent.length || !enabled()) return 0;
  let rows = {};
  try { rows = JSON.parse(await fs.promises.readFile(path.join(dir(), 'state.json'), 'utf8')).rows || {}; }
  catch (e) { if (e.code !== 'ENOENT') return 0; } // unreadable state: say nothing rather than duplicate rows
  let n = 0;
  for (const a of recent) {
    const sid = sessionOf(a.harness, a.root, a.file);
    if (!sid || rows[keyOf(a.harness, sid)]) continue;
    const meta = await headMeta(a.file);
    if (meta.headless) continue;
    const cwd = logical(meta.cwd);
    const worker = (cwd.split(/[:/]/).find((x) => x && !['work', 'hub', '~'].includes(x)) || '?').slice(0, 24);
    if (emit({ ev: 'sweep', k: keyOf(a.harness, sid), h: SHORT[a.harness] || a.harness, w: worker, cwd, ptr: cwd, src: 'sweep', t: a.mtimeMs / 1000 })) n++;
  }
  return n;
}

module.exports = { dir, keyOf, logical, emit, job, ended, watchOffload, sweep, sessionOf };

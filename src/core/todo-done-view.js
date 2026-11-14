'use strict';
// A GUI projection of the existing read-only queue CLI. No second completion store.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { redactCredentials } = require('./secret-scrub');
const STATES = new Set(['completed', 'partially-completed', 'finalization-pending', 'cancelled', 'superseded', 'needs-review', 'active', 'held']);
let snapshot, viewGeneration = 0, followupSnapshot, followupGeneration = 0;

async function bounded(work, deps = {}) {
  let timer;
  try { return await Promise.race([work(), new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Error('공유 기록 조회 시간이 초과됐습니다. 마지막 목록을 보존합니다. 연결과 저장소를 확인하세요.')),
      Math.max(5, Math.min(20000, Number(deps.timeoutMs) || 20000)));
  })]); } finally { clearTimeout(timer); }
}

function text(value, limit = 2000) {
  return redactCredentials(String(value ?? '')).replace(/\b[A-Za-z]:[\\/][^\s"'<>]+/g, '[local path]')
    .replace(/\\\\[^\s"'<>]+/g, '[network path]').replace(/\/(?:home|Users)\/[^\s"'<>]+/g, '[local path]').slice(0, limit);
}
function reference(value) {
  const plain = String(value || '').match(/^\[[^\]]+\]\(([^)]+)\)$/)?.[1] || String(value || '');
  if (!/^(?:docs|reports|todo-queue\/(?:evidence|archive|dispositions))\/[A-Za-z0-9_./\-\u0080-\uffff]+\.(?:md|json|txt|jsonl)$/.test(plain)
      || plain.includes('..') || plain.includes('\\')) return null;
  return plain;
}
async function root(deps = {}) {
  try {
    const publicLite = require('./public-profile').enabled;
    const configured = publicLite ? require('./config').load().sharedContext?.repoPath : null;
    if (publicLite && !deps.root && !configured) throw Error('공개판의 공유 큐는 연결하지 않았습니다. 메모리 탭에서 사용할 저장소를 직접 지정하세요.');
    const dir = deps.root || (publicLite ? configured : require('./shared-agent-context').manifest()?.sourceRepository || (await require('./repository-skills').repository()).root);
    const real = await fs.realpath(dir);
    for (const file of ['tools/todo_queue.py', 'tools/todo_done.py', 'todo-queue/definitions']) await fs.access(path.join(real, file));
    return real;
  } catch (error) { if (require('./public-profile').enabled) throw Error('공개판의 공유 큐는 연결하지 않았거나 도구가 없습니다. 메모리 탭에서 사용할 저장소를 직접 지정하세요.'); throw Error('공유 저장소의 Done 도구를 찾지 못했습니다. 메모리 탭의 저장소 설정과 수신 상태를 확인하세요.'); }
}
function invoke(command, args, cwd) {
  return new Promise(resolve => execFile(command, args, { cwd, windowsHide: true, timeout: 20000,
    maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } },
  (error, stdout) => resolve({ error, stdout })));
}
async function run(repo, args, deps) {
  const exec = deps.invoke || invoke;
  for (const [command, prefix] of [['python', []], ['py', ['-3']]]) {
    const result = await exec(command, [...prefix, '-B', path.join(repo, 'tools', 'todo_queue.py'), '--repo', repo, ...args], repo);
    if (result.error?.code === 'ENOENT') continue;
    if (result.error) throw Error('공유 기록을 읽지 못했습니다. 변경 중이면 새로고침하고 Python·저장소 권한을 확인하세요.');
    try { return JSON.parse(String(result.stdout).replace(/^\uFEFF/, '')); }
    catch { throw Error('공유 기록 응답 형식을 확인하세요. 기존 목록은 보존됩니다.'); }
  }
  throw Error('Done 큐에는 Python 3가 필요합니다. 공유 저장소 설정을 확인하세요.');
}
function rowProjection(row) {
  if (!row || !/^[A-Z0-9][A-Z0-9_.-]{2,79}$/.test(row.id) || !/^[a-f0-9]{64}$/.test(row.fingerprint) || !STATES.has(row.state)
      || !Array.isArray(row.targets) || !Array.isArray(row.pendingPCs) || !row.completedPCs || typeof row.completedPCs !== 'object' || Array.isArray(row.completedPCs))
    throw Error('완료 기록 형식이 올바르지 않습니다. 공유 원장을 확인하세요.');
  const completedPCs = Object.fromEntries(Object.entries(row.completedPCs || {}).map(([pc, receipt]) => [text(pc, 64), {
    completedAt: Number.isFinite(receipt.completedAt) ? receipt.completedAt : null,
    note: text(receipt.note), evidence: reference(receipt.evidence),
  }]));
  return { id: row.id, fingerprint: row.fingerprint, summary: text(row.summary), state: row.state,
    active: !!row.active, held: !!row.held, detail: reference(row.detail), sharedStatus: text(row.sharedStatus, 500),
    targets: (row.targets || []).map(pc => text(pc, 64)), pendingPCs: (row.pendingPCs || []).map(pc => text(pc, 64)), completedPCs,
    disposition: row.disposition ? { state: text(row.disposition.state, 30), reason: text(row.disposition.reason), evidence: reference(row.disposition.evidence) } : null };
}
async function view(_options = {}, deps = {}) {
  const request = ++viewGeneration;
  const { repo, data, tasks } = await bounded(async () => {
    const repo = await root(deps), data = await run(repo, ['done', '--include-active'], deps);
    if (data.scope !== 'done' || data.readOnly !== true || !Array.isArray(data.tasks) || data.tasks.length > 5000)
      throw Error('Done 큐의 읽기 전용 응답을 확인하세요.');
    return { repo, data, tasks: data.tasks.map(rowProjection) };
  }, deps);
  const at = Date.now(), id = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  if (request === viewGeneration) snapshot = { id, at, repo, tasks };
  return { snapshotId: id, observedAt: at, machine: os.hostname().toUpperCase(), readOnly: true, tasks,
    warnings: (data.warnings || []).map(w => ({ code: text(w.code, 100), id: text(w.id, 100), path: reference(w.path) || text(w.path, 200) })) };
}
function current(payload) { return payload?.scope === 'followup' ? followupSnapshot : snapshot; }
function selected(payload) {
  const latest = current(payload);
  if (!latest || payload?.snapshotId !== latest.id || Date.now() - latest.at > 5 * 60 * 1000)
    throw Error('목록이 바뀌었거나 오래됐습니다. 새로고침한 뒤 다시 선택하세요.');
  const row = latest.tasks.find(r => r.id === payload.id && r.fingerprint === payload.fingerprint);
  if (!row) throw Error('목록에서 작업을 다시 선택하세요.');
  return row;
}
async function plan(payload, deps = {}) {
  const row = selected(payload);
  if (row.active) throw Error('활성·보류 작업은 Done에서 재개하지 않습니다. 기존 활성 큐를 확인하세요.');
  if (!/^[A-Z0-9][A-Z0-9_.-]{2,79}$/.test(payload.newId || '') || payload.newId === row.id || !String(payload.reason || '').trim())
    throw Error('이전 기록과 다른 새 작업 ID와 재개 이유를 입력하세요.');
  const data = await run(current(payload).repo, ['reopen-plan', row.id, '--fingerprint', row.fingerprint, '--new-id', payload.newId,
    '--reason', text(payload.reason, 1000).trim()], deps);
  if (data.planOnly !== true || data.created !== false || data.original?.id !== row.id || data.original?.fingerprint !== row.fingerprint)
    throw Error('비파괴 재개 계획 응답이 아닙니다. 실행하지 않았습니다.');
  return { planOnly: true, created: false, original: { id: row.id, fingerprint: row.fingerprint, state: data.original.state },
    newId: data.newId, targets: data.targets.map(pc => text(pc, 64)), summary: text(data.summary), reason: text(data.reason) };
}
async function open(payload, deps = {}) {
  const row = selected(payload);
  const ref = payload.reference === 'detail' ? row.detail : payload.reference === 'checkpoint' ? row.checkpoint?.reference : payload.reference === 'disposition' ? row.disposition?.evidence
    : row.completedPCs[payload.pc]?.evidence;
  if (!ref) throw Error('안전한 저장소 상대 근거 경로가 없습니다.');
  const repo = current(payload).repo;
  const { file, relative } = await bounded(async () => {
    let file;
    try { file = await fs.realpath(path.join(repo, ref)); }
    catch { throw Error('근거 파일을 찾거나 읽을 수 없습니다. 공유 기록을 새로고침하세요.'); }
    const relative = path.relative(repo, file).split(path.sep).join('/');
    if (!reference(relative) || !(await fs.stat(file)).isFile()) throw Error('저장소 범위 밖의 근거는 열 수 없습니다.');
    return { file, relative };
  }, deps);
  deps.beforeOpen?.();
  const error = await (deps.openPath || require('electron').shell.openPath)(file);
  if (error) throw Error('근거 파일을 열지 못했습니다. 파일 연결을 확인하세요.');
  return { opened: true, relative };
}
async function followups(_options = {}, deps = {}) {
  const request = ++followupGeneration;
  const { repo, data, tasks } = await bounded(async () => {
    const repo = await root(deps), data = await run(repo, ['show', '--limit', '64'], deps);
    if (data.scope !== 'pc' || String(data.machine).toUpperCase() !== os.hostname().toUpperCase()
        || !['running', 'ready', 'blocked'].every(key => Array.isArray(data[key])))
      throw Error('이 PC의 활성 큐 응답을 확인하세요.');
    const tasks = ['running', 'ready', 'blocked'].flatMap(state => data[state].map(row => {
      const base = rowProjection({ ...row, state: 'active', active: true, targets: String(row.targets || '').split(','), completedPCs: {}, pendingPCs: [] });
      const file = row.checkpoint?.file;
      const checkpoint = file ? { label: text(path.win32.basename(file), 160), savedAt: Number(row.checkpoint.savedAt) || null,
        reference: reference(path.isAbsolute(file) ? path.relative(repo, file).split(path.sep).join('/') : file) } : null;
      const explicitlyHeld = !!row.held || /(?:사용자|명시)[^\n]*보류|보류[^\n]*유지/.test(String(row.reason || ''));
      return { ...base, state, displayState: state === 'blocked' && explicitlyHeld ? 'held' : state,
        reason: text(row.reason || ''), owner: row.owner ? text(row.owner, 100) : null, checkpoint,
        heartbeatAt: Number(row.heartbeatAt) || null, stale: row.stale === true,
        level: Number.isInteger(row.level) ? row.level : null };
    }));
    return { repo, data, tasks };
  }, deps);
  const at = Date.now(), id = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  if (request === followupGeneration) followupSnapshot = { id, at, repo, tasks };
  return { scope: 'followup', snapshotId: id, observedAt: at, machine: text(data.machine, 64), readOnly: true, tasks, truncated: data.truncated === true };
}
module.exports = { view, followups, plan, open, reference, text };

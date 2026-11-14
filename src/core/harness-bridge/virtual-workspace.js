// 샌드박스 가상화: 하네스 사이에 오가는 메시지는 실제 경로 대신 논리 경로(repo:·app:·rsi:)만 쓰고,
// 작업을 받는 하네스는 그 파일들의 "복사본"만 든 작업 폴더에서 읽기 전용으로 돈다.
// - 투명성: 어느 PC·어느 하네스에서든 같은 논리 이름이 같은 뜻이다(규칙 4 — 공유 값에 절대경로 금지).
// - 안정성: 원본을 건드릴 수 없고(복사), 마운트 밖·민감 파일·심볼릭 링크 탈출은 거부한다(기본 거부).
'use strict';
const fs = require('fs');
const path = require('path');

const LIMITS = { files: 40, fileBytes: 512 * 1024, totalBytes: 4 * 1024 * 1024 };
const SENSITIVE = /(^|\/)(\.env(\..*)?|config\.local\.json|auth\.json|\.credentials(\.json)?|credentials(\.local)?(\/|$)|id_[a-z0-9]+|.*\.(pem|key|pfx|p12))$/i;
const REF = /^([a-z][a-z0-9-]{1,15}):([^\0]*)$/;
const PRIVATE_DIRS = new Set(['.git', '.ssh', '.aws', '.azure', '.gnupg', '.kube']);

function isSensitivePath(value) {
  return String(value).split(/[\\/]/).some(part => {
    // Windows alternate streams and trailing dots/spaces refer to the same underlying name.
    const name = part.split(':')[0].replace(/[ .]+$/, '').toLowerCase();
    return PRIVATE_DIRS.has(name) || SENSITIVE.test(name);
  });
}

/** Read the opened file only after confirming its identity and mount against the approved real path. */
async function readCheckedFile(root, requested, expected, cap) {
  const denied = () => Object.assign(new Error('Linked, sensitive, or changed source file'), { code: 'EACCES' });
  const rel = path.relative(root, expected);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel) ||
      [root, requested, expected].some(isSensitivePath)) throw denied();
  const handle = await fs.promises.open(expected, 'r');
  try {
    const initial = await handle.stat({ bigint: true });
    const verify = async () => {
      const [observedRoot, observedFile, current] = await Promise.all([
        fs.promises.realpath(root), fs.promises.realpath(requested), fs.promises.stat(expected, { bigint: true })
      ]);
      if (path.relative(root, observedRoot) || path.relative(expected, observedFile) || isSensitivePath(observedFile) ||
          current.dev !== initial.dev || current.ino !== initial.ino || current.ctimeNs !== initial.ctimeNs || current.nlink !== 1n) throw denied();
    };
    if (!initial.isFile() || initial.nlink !== 1n || initial.size > cap) throw denied();
    await verify();
    const parts = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, end: cap, signal: AbortSignal.timeout(15000) })) {
      bytes += chunk.length;
      if (bytes > cap) throw denied();
      parts.push(chunk);
    }
    if (BigInt(bytes) !== initial.size) throw denied();
    await verify();
    return Buffer.concat(parts, bytes);
  } finally { await handle.close(); }
}

function mounts(deps = {}) {
  const hubData = deps.dataDir || require('../paths').hubDataDir();
  const out = { app: deps.appRoot || require('../paths').appRoot(), rsi: path.join(hubData, 'rsi') };
  try { const r = (deps.sharedRepo || require('../shared-repo-memory')).repoRoot(); if (r) out.repo = r; } catch { /* 저장소 없음 */ }
  return out;
}

/** 논리 경로 → 실제 경로. 마운트 밖·민감 파일·링크 탈출은 이유와 함께 거부한다. */
async function resolve(ref, deps = {}) {
  const m = REF.exec(String(ref || ''));
  if (!m) return { ok: false, reason: 'bad_ref' };
  const [, name, relRaw] = m;
  const root = mounts(deps)[name];
  if (!root) return { ok: false, reason: 'unknown_mount' };
  const rel = relRaw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.split('/').includes('..')) return { ok: false, reason: 'outside_mount' };
  if (isSensitivePath(root) || isSensitivePath(rel)) return { ok: false, reason: 'sensitive' };
  const full = path.join(root, ...rel.split('/'));
  const [realRoot, real] = await Promise.all([fs.promises.realpath(root).catch(() => null), fs.promises.realpath(full).catch(() => null)]);
  if (!realRoot || !real) return { ok: false, reason: 'not_found' };
  if (isSensitivePath(realRoot) || isSensitivePath(real)) return { ok: false, reason: 'sensitive' };
  const inside = path.relative(realRoot, real);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return { ok: false, reason: 'outside_mount' };
  const stat = await fs.promises.stat(real);
  if (stat.isFile() && stat.nlink !== 1) return { ok: false, reason: 'linked_file' };
  return { ok: true, mount: name, rel, path: real, realRoot };
}

/** 실제 경로를 논리 경로로(결과 글에서 기기 경로를 지울 때). 마운트 밖이면 null. */
function toLogical(abs, deps = {}) {
  for (const [name, root] of Object.entries(mounts(deps))) {
    const rel = path.relative(root, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return `${name}:${rel.split(path.sep).join('/')}`;
  }
  return null;
}

function workspaceRoot(deps = {}) { return path.join(deps.dataDir || require('../paths').hubDataDir(), 'harness-bus', 'workspaces'); }

/** 작업 폴더를 만든다: in/<mount>/<rel> 복사본 + TASK.md(논리 경로 ↔ 작업 폴더 경로 표). */
async function create(jobId, { task, refs = [] }, deps = {}) {
  if (!/^[\w-]{1,80}$/.test(jobId)) throw new Error('bad job id');
  const dir = path.join(workspaceRoot(deps), jobId);
  await fs.promises.mkdir(path.join(dir, 'in'), { recursive: true });
  const files = [], skipped = [];
  let total = 0;
  for (const ref of refs.slice(0, LIMITS.files * 2)) {
    if (files.length >= LIMITS.files) { skipped.push({ ref, reason: 'too_many_files' }); continue; }
    const r = await resolve(ref, deps);
    if (!r.ok) { skipped.push({ ref, reason: r.reason }); continue; }
    const st = await fs.promises.stat(r.path);
    if (!st.isFile()) { skipped.push({ ref, reason: 'not_a_file' }); continue; }
    if (st.size > LIMITS.fileBytes || total + st.size > LIMITS.totalBytes) { skipped.push({ ref, reason: 'too_large' }); continue; }
    const local = path.join('in', r.mount, ...r.rel.split('/'));
    await fs.promises.mkdir(path.dirname(path.join(dir, local)), { recursive: true });
    const requested = path.join(mounts(deps)[r.mount], r.rel);
    let bytes;
    try { bytes = await readCheckedFile(r.realRoot, requested, r.path, Math.min(LIMITS.fileBytes, LIMITS.totalBytes - total)); }
    catch (err) {
      if (err.code !== 'EACCES') throw err;
      skipped.push({ ref, reason: 'changed_or_linked' });
      continue;
    }
    const text = require('../secret-scrub').scrub(bytes.toString('utf8'));
    await fs.promises.writeFile(path.join(dir, local), text, 'utf8');
    total += bytes.length;
    files.push({ ref, local: local.split(path.sep).join('/'), bytes: bytes.length });
  }
  const table = files.length ? files.map((f) => `- \`${f.ref}\` → \`${f.local}\``).join('\n') : '- (첨부 없음)';
  await fs.promises.writeFile(path.join(dir, 'TASK.md'), `${task}\n\n## 첨부(논리 경로 → 이 폴더의 읽기 전용 복사본)\n${table}\n`, 'utf8');
  return { dir, files, skipped };
}

const prune = ({ olderThanDays = 7 } = {}, deps = {}) => require('../data-retention').pruneOlderThan(workspaceRoot(deps), olderThanDays);

module.exports = { resolve, toLogical, create, prune, mounts, workspaceRoot, LIMITS, SENSITIVE, isSensitivePath, readCheckedFile };

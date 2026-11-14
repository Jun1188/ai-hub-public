// 지역성 캐시 가비지 컬렉터 — 에이전트가 아니라 이 프로그램이 돈다(규칙이 단순해 모델 토큰을 쓸 이유가 없다).
//   node src/core/cache/cache-gc.js [--dry-run] [--ttl-days N] [--max-mb N] [--root <캐시 루트>]
// 규칙: 분류 디렉터리(<class>/<category>)의 마지막 참조 시각(.meta.json, 없으면 mtime)이 등급별 TTL보다 오래되면 지운다.
// 그래도 전체가 상한을 넘으면 가장 오래 안 쓴 디렉터리부터 지운다. 캐시 루트 밖은 절대 건드리지 않는다.
'use strict';
const fs = require('fs');
const path = require('path');

const DAY = 24 * 3600 * 1000;
const TTL_DAYS = { skills: 30, catalog: 30, memory: 21, logs: 14, default: 14 };

async function dirBytes(dir) {
  let n = 0;
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isFile()) n += (await fs.promises.stat(path.join(dir, e.name)).catch(() => ({ size: 0 }))).size;
  }
  return n;
}

async function lastAccess(dir) {
  try { const m = JSON.parse(await fs.promises.readFile(path.join(dir, '.meta.json'), 'utf8')); const t = Date.parse(m.lastAccess); if (Number.isFinite(t)) return t; } catch { /* mtime으로 */ }
  return (await fs.promises.stat(dir)).mtimeMs;
}

/** 캐시 루트 아래 <class>/<category> 디렉터리 목록. 심볼릭 링크는 따라가지 않는다. */
async function categories(root) {
  const out = [];
  for (const c of await fs.promises.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!c.isDirectory() || c.isSymbolicLink()) continue;
    for (const cat of await fs.promises.readdir(path.join(root, c.name), { withFileTypes: true }).catch(() => [])) {
      if (!cat.isDirectory() || cat.isSymbolicLink()) continue;
      const dir = path.join(root, c.name, cat.name);
      out.push({ cls: c.name, category: cat.name, dir, lastAccess: await lastAccess(dir), bytes: await dirBytes(dir) });
    }
  }
  return out;
}

async function collect({ root, dryRun = false, ttlDays = null, maxBytes = 256 * 1024 * 1024, now = Date.now() } = {}) {
  root = path.resolve(root || require('./locality-cache').rootOf());
  const real = await fs.promises.realpath(root).catch(() => null);
  if (!real) return { root, removed: [], kept: 0, bytesBefore: 0, bytesAfter: 0, dryRun, missing: true };
  const dirs = await categories(real);
  const removed = [];
  const remove = async (d, reason) => {
    const rel = path.relative(real, d.dir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('refusing to delete outside cache root: ' + d.dir);
    removed.push({ dir: rel.split(path.sep).join('/'), reason, idleDays: +((now - d.lastAccess) / DAY).toFixed(1), bytes: d.bytes });
    if (!dryRun) await fs.promises.rm(d.dir, { recursive: true, force: true });
  };
  const bytesBefore = dirs.reduce((s, d) => s + d.bytes, 0);
  const alive = [];
  for (const d of dirs) {
    const ttl = (ttlDays ?? TTL_DAYS[d.cls] ?? TTL_DAYS.default) * DAY;
    if (now - d.lastAccess > ttl) await remove(d, 'ttl'); else alive.push(d);
  }
  let total = alive.reduce((s, d) => s + d.bytes, 0);
  for (const d of alive.sort((a, b) => a.lastAccess - b.lastAccess)) {
    if (total <= maxBytes) break;
    await remove(d, 'size'); total -= d.bytes;
  }
  return { root: real, removed, kept: dirs.length - removed.length, bytesBefore, bytesAfter: total, dryRun };
}

module.exports = { collect, categories, TTL_DAYS };

if (require.main === module) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  collect({ root: arg('--root'), dryRun: process.argv.includes('--dry-run'), ttlDays: arg('--ttl-days') ? Number(arg('--ttl-days')) : null,
    maxBytes: arg('--max-mb') ? Number(arg('--max-mb')) * 1024 * 1024 : undefined })
    .then((r) => process.stdout.write(JSON.stringify(r, null, 2) + '\n'))
    .catch((e) => { console.error(e.message); process.exitCode = 1; });
}

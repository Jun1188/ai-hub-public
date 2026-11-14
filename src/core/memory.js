// Hub memory: embedded facts/preferences/notes (learning notes from source Q&A, render
// pipeline and deep analysis) with semantic + recency search. 1.29.0에서 위임 세션·회상 주입을
// 뺐다 — 기존 sessions/ 폴더는 지우지 않고 더 읽지 않는다.
// Everything lives in %APPDATA%/ai-hub/memory/, local only.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hubDataDir } = require('./paths');
const embedder = require('./embedder');

// Storage root is dynamic: config `memory.dir` (e.g. a folder inside a
// synced drive, shared by every computer) falls back to the local APPDATA
// dir. Resolved per call so a dir change applies without restart.
function memDir() {
  try {
    const custom = require('./config').load().memory?.dir;
    if (custom && String(custom).trim()) return String(custom).trim();
  } catch { /* config unavailable — default */ }
  return path.join(hubDataDir(), 'memory');
}
const memFile = () => path.join(memDir(), 'memories.jsonl');
const MEM_TYPES = ['fact', 'preference', 'project', 'note'];
const MAX_MEM_TEXT = 4000;
const MAX_MEMORIES = 5000;
const HALF_LIFE_DAYS = 30; // recency decay half-life for recall scoring

let cache = null; // [{id, ts, type, text, tags, source, vec:Float32Array}]
let cacheDir = null; // memory dir the cache was loaded from

function ensureDirs() {
  fs.mkdirSync(memDir(), { recursive: true });
}

function loadAll() {
  const dir = memDir();
  if (cache && cacheDir === dir) return cache;
  cacheDir = dir;
  ensureDirs();
  cache = [];
  try {
    for (const line of fs.readFileSync(memFile(), 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if (o.vecB64) {
          // Buffers from base64 may live in Node's shared pool at a nonzero
          // byteOffset — the view must use that offset, not the whole pool.
          const buf = Buffer.from(o.vecB64, 'base64');
          o.vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        } else {
          o.vec = null;
        }
        delete o.vecB64;
        cache.push(o);
      } catch { /* skip corrupt line */ }
    }
  } catch { /* no file yet */ }
  return cache;
}

function persistAll() {
  ensureDirs();
  const lines = cache.map((o) => {
    const { vec, ...rest } = o;
    return JSON.stringify({ ...rest, vecB64: vec ? Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64') : undefined });
  });
  fs.writeFileSync(memFile(), lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
}

/** Save a long-term memory. Deduplicates near-identical texts. */
async function save(text, { type = 'note', tags = [], source = 'unknown' } = {}) {
  text = String(text).trim().slice(0, MAX_MEM_TEXT);
  if (text.length < 3) throw new Error('Memory text too short.');
  if (!MEM_TYPES.includes(type)) type = 'note';
  const all = loadAll();
  const dup = all.find((m) => m.text === text);
  if (dup) return { id: dup.id, deduplicated: true };
  if (all.length >= MAX_MEMORIES) {
    // evict the oldest plain notes first
    const idx = all.findIndex((m) => m.type === 'note');
    all.splice(idx >= 0 ? idx : 0, 1);
  }
  let vec = null;
  try {
    [vec] = await embedder.embed([text]);
  } catch { /* embedding model unavailable — keyword-only recall still works */ }
  const entry = {
    id: crypto.randomBytes(6).toString('hex'),
    ts: new Date().toISOString(),
    type,
    tags: (Array.isArray(tags) ? tags : []).map((t) => String(t).slice(0, 40)).slice(0, 8),
    source: String(source).slice(0, 60),
    text,
    vec,
  };
  all.push(entry);
  persistAll();
  return { id: entry.id, deduplicated: false };
}

function remove(id) {
  const all = loadAll();
  const i = all.findIndex((m) => m.id === id);
  if (i < 0) throw new Error(`Memory not found: ${id}`);
  all.splice(i, 1);
  persistAll();
  return { removed: id };
}

function list({ type, limit = 50 } = {}) {
  const all = loadAll();
  return all
    .filter((m) => !type || m.type === type)
    .slice(-limit)
    .reverse()
    .map(({ vec, ...rest }) => rest);
}

/** Recall: semantic similarity (if embeddings available) + recency decay + tag/keyword bonus. */
async function search(query, topK = 6) {
  const all = loadAll();
  if (!all.length) return [];
  let qvec = null;
  try {
    [qvec] = await embedder.embed([String(query)]);
  } catch { /* keyword-only */ }
  const now = Date.now();
  const words = String(query).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const scored = all.map((m) => {
    let sim = 0;
    if (qvec && m.vec) sim = embedder.cosine(qvec, m.vec);
    const ageDays = (now - Date.parse(m.ts)) / 86400000;
    const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    const kw = words.length
      ? words.filter((w) => m.text.toLowerCase().includes(w) || m.tags.some((t) => t.toLowerCase().includes(w))).length / words.length
      : 0;
    return { m, score: sim * 0.7 + recency * 0.15 + kw * 0.15 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.min(topK, 20)).map(({ m, score }) => ({
    id: m.id, type: m.type, tags: m.tags, ts: m.ts, source: m.source, text: m.text,
    score: Math.round(score * 1000) / 1000,
  }));
}

/**
 * mem0-style consolidation: remove near-duplicate memories (cosine > 0.92),
 * keeping the newest entry and merging tags. Returns what was removed.
 */
function consolidate() {
  const all = loadAll();
  const removed = [];
  // pairwise comparison is O(n^2): bound the scan window so a full store
  // (5000 entries) cannot stall the process
  const START = Math.max(0, all.length - 1500);
  for (let i = all.length - 1; i >= START; i--) {
    const a = all[i];
    if (!a.vec) continue;
    for (let j = i - 1; j >= START; j--) {
      const b = all[j];
      if (!b.vec || b.type !== a.type) continue;
      if (embedder.cosine(a.vec, b.vec) > 0.92) {
        // a is newer (later in file); absorb b
        a.tags = [...new Set([...a.tags, ...b.tags])].slice(0, 8);
        removed.push({ id: b.id, text: b.text.slice(0, 80) });
        all.splice(j, 1);
        i--; // indices shifted
      }
    }
  }
  if (removed.length) persistAll();
  return { removedCount: removed.length, removed };
}

/** Export all memories (without vectors) to a JSON file for backup/migration. */
function exportAll(destFile) {
  const all = loadAll().map(({ vec, ...rest }) => rest);
  const payload = { format: 'ai-hub-memory', version: 1, exportedAt: new Date().toISOString(), memories: all };
  fs.writeFileSync(destFile, JSON.stringify(payload, null, 2), 'utf8');
  return { file: destFile, count: all.length };
}

/** Import memories from an export file; re-embeds and deduplicates. */
async function importFrom(srcFile) {
  const raw = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
  if (!['ai-hub-memory', 'ai-allinone-hub-memory'].includes(raw.format) || !Array.isArray(raw.memories)) {
    throw new Error('올바른 메모리 내보내기 파일이 아닙니다.');
  }
  let imported = 0;
  let skipped = 0;
  for (const m of raw.memories.slice(0, MAX_MEMORIES)) {
    if (!m || typeof m.text !== 'string') { skipped++; continue; }
    const r = await save(m.text, { type: m.type, tags: m.tags, source: m.source || 'import' });
    if (r.deduplicated) skipped++; else imported++;
  }
  return { imported, skipped };
}

function stats() {
  const all = loadAll();
  const byType = {};
  for (const m of all) byType[m.type] = (byType[m.type] || 0) + 1;
  const cfg = require('./config').load();
  return {
    total: all.length, byType,
    dir: memDir(),
    isShared: Boolean(cfg.memory && cfg.memory.dir && cfg.memory.dir.trim()),
    defaultDir: path.join(hubDataDir(), 'memory'),
    // 컴퓨터 간 메모리 공유는 이제 share.js가 담당합니다(기본 위치를 공유 폴더로
    // 미러링). memory.dir을 Google Drive 경로로 직접 지정하면 메모리 읽기/쓰기가
    // 동기 I/O로 Drive를 때리게 되어 앱이 멈출 수 있으니 권장하지 않습니다.
  };
}

/**
 * Switch the memory storage dir ('' = local default). If the target has no
 * memories.jsonl yet, existing memories are copied over so nothing is lost. Pointing this at a folder inside a synced drive (e.g. the app
 * folder on Google Drive) shares hub memory across computers.
 */
function setDir(dir) {
  dir = String(dir || '').trim();
  const config = require('./config');
  const from = memDir();
  const to = dir || path.join(hubDataDir(), 'memory');
  if (path.resolve(from) !== path.resolve(to)) {
    fs.mkdirSync(to, { recursive: true });
    const targetFile = path.join(to, 'memories.jsonl');
    if (!fs.existsSync(targetFile) && fs.existsSync(path.join(from, 'memories.jsonl'))) {
      fs.copyFileSync(path.join(from, 'memories.jsonl'), targetFile);
    }
  }
  config.update({ memory: { dir } });
  cache = null; // reload from the new location on next access
  cacheDir = null;
  return stats();
}

module.exports = { save, remove, list, search, consolidate, exportAll, importFrom, stats, setDir, MEM_TYPES };

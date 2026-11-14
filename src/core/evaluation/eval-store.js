// 평가 장부(append-only JSONL)와 결과 캐시. 같은 입력 지문이면 다시 판정하지 않는다 —
// 에이전트 판정은 비싸고, 메타 평가는 같은 지문의 반복 판정 분산을 재야 하므로 둘 다 이 저장소를 쓴다.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEDGER_MAX_BYTES = 8 * 1024 * 1024; // 넘으면 .1로 굴린다 — 메타 평가는 최근 창만 본다

function dirOf(deps = {}) {
  return deps.dataDir ? path.join(deps.dataDir, 'evaluation') : path.join(require('../paths').hubDataDir(), 'evaluation');
}

function keyOf(...parts) {
  return crypto.createHash('sha256').update(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('\u0000')).digest('hex');
}

const atomicWrite = require('../atomic-file').writeAtomic;

async function cacheGet(key, deps) {
  try { return JSON.parse(await fs.promises.readFile(path.join(dirOf(deps), 'cache', `${key.slice(0, 40)}.json`), 'utf8')); }
  catch { return null; } // 캐시 실패는 다시 계산하면 된다 — 원본 데이터가 아니다
}

async function cachePut(key, value, deps) {
  await atomicWrite(path.join(dirOf(deps), 'cache', `${key.slice(0, 40)}.json`), JSON.stringify(value));
}

async function append(entry, deps) {
  await require('../atomic-file').appendLine(path.join(dirOf(deps), 'ledger.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }), { maxBytes: LEDGER_MAX_BYTES });
}

/** 최근 기록. 깨진 줄은 건너뛰되 개수를 알려 준다(읽기 실패를 "없음"으로 감추지 않는다). */
async function recent({ limit = 500, tier } = {}, deps) {
  let text = '';
  try { text = await fs.promises.readFile(path.join(dirOf(deps), 'ledger.jsonl'), 'utf8'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const rows = [];
  let corrupt = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (!tier || r.tier === tier) rows.push(r); } catch { corrupt++; }
  }
  return { rows: rows.slice(-limit), corrupt };
}

module.exports = { keyOf, cacheGet, cachePut, append, recent, dirOf };

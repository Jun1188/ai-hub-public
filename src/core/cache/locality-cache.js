// 지역성 캐시: 스킬·메모리·카탈로그·로그 조회 결과를 세션을 넘어 재사용한다.
// - 키(입력 해시) → 항목 메모다. 메모리는 Map(항목 수 상한, 넘치면 가장 먼저 넣은 것부터 버린다), 디스크는 분류 트리 <class>/<category>/<hash>.json.
// - 예열(hot.json)·2Q·디렉터리 .meta.json은 1.32.39에서 뺐다: 7.5일·31세션 실측에서 예열 I/O 2,395 ms가 아낀 디스크 읽기 403 ms보다 컸고
//   (warm.verdict drop-candidate, 2026-10-29), 키 6개·축출 0회라 2Q가 지킬 핫 집합이 없었다(S5 3.5절). 실제 효과는 디스크의 임베딩 메모뿐이었다.
// - 오래된 디렉터리는 cache-gc.js(별도 프로그램)가 디렉터리 mtime(항목을 쓸 때 바뀐다)으로 지운다 — 지워져도 다시 적재할 뿐이다.
// - 적중·미스·적재 시간은 metrics.json(cache-metrics.js)에 누적돼 재시작 뒤에도 세션을 넘는 효과를 잴 수 있다.
// 캐시는 원본이 아니다: 읽기 실패·버전 불일치는 miss로 보고 원천(loader)에서 다시 읽는다.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function rootOf(deps = {}) { return path.join(deps.dataDir || require('../paths').hubDataDir(), 'locality-cache'); }
const hashKey = (key) => crypto.createHash('sha1').update(String(key)).digest('hex');
const segment = (s, fallback) => { const v = String(s || fallback).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 64); return SEGMENT.test(v) ? v : fallback; };

const { writeAtomic } = require('../atomic-file');
const { createMetrics } = require('./cache-metrics');

function createCache({ capacity = 256, dataDir, now = Date.now } = {}) {
  const deps = { dataDir };
  const memo = new Map();
  const stats = { hits: 0, diskHits: 0, misses: 0, stale: 0, loads: 0, evictions: 0, loadMs: 0, diskHitMs: 0, ioMs: 0, byClass: {} };
  // 경로는 한 번만 정한다 — hubDataDir()는 부를 때마다 폴더를 만들어, 지워진 데이터 폴더를 저장 직전에 되살린다.
  const metricsFile = path.join(rootOf(deps), 'metrics.json');
  const metrics = createMetrics({ file: () => metricsFile, now });
  // 세션 통계와 재시작을 넘는 누적 계수를 한 곳에서 올린다. 키는 디스크 분류 트리와 같은 <class>/<category>.
  const bump = (c, cat, field, n = 1) => {
    const sc = segment(c, 'misc');
    stats[field] += n;
    const b = (stats.byClass[sc] = stats.byClass[sc] || { hits: 0, diskHits: 0, misses: 0 });
    if (field in b) b[field] += n;
    metrics.add(`${sc}/${segment(cat, 'general')}`, field, n);
  };

  const fileOf = (c, cat, key) => path.join(rootOf(deps), segment(c, 'misc'), segment(cat, 'general'), hashKey(key) + '.json');

  function remember(id, entry) {
    memo.delete(id); memo.set(id, entry);
    while (memo.size > capacity) { const old = memo.keys().next().value; memo.delete(old); const [c, cat] = old.split('\u0000'); bump(c, cat, 'evictions'); }
  }

  /**
   * get(key, { cls, category, version, loader, ttlMs })
   * version이 다르면(원천 파일이 바뀌면) 낡은 값으로 보고 loader를 부른다. loader가 없으면 null.
   */
  async function get(key, { cls: c = 'misc', category = 'general', version = null, loader = null, ttlMs = 0 } = {}) {
    const id = `${c}\u0000${category}\u0000${key}`;
    const fresh = (e) => e && (version == null || e.version === version) && (!ttlMs || now() - e.storedAt <= ttlMs);
    const mem = memo.get(id);
    if (fresh(mem)) { bump(c, category, 'hits'); return mem.value; }
    let disk = null;
    const t0 = performance.now();
    try { disk = JSON.parse(await fs.promises.readFile(fileOf(c, category, key), 'utf8')); } catch { /* miss */ }
    if (fresh(disk)) { bump(c, category, 'diskHits'); bump(c, category, 'diskHitMs', performance.now() - t0); remember(id, disk); return disk.value; }
    bump(c, category, 'ioMs', performance.now() - t0);
    if (disk || mem) bump(c, category, 'stale');
    bump(c, category, 'misses');
    if (!loader) return null;
    const t1 = performance.now();
    const value = await loader();
    bump(c, category, 'loads'); bump(c, category, 'loadMs', performance.now() - t1); // 실패한 적재는 평균 적재 시간에 넣지 않는다
    await put(key, value, { cls: c, category, version });
    return value;
  }

  async function put(key, value, { cls: c = 'misc', category = 'general', version = null } = {}) {
    const t0 = performance.now();
    const entry = { key: String(key).slice(0, 300), version, storedAt: now(), value };
    remember(`${c}\u0000${category}\u0000${key}`, entry);
    await writeAtomic(fileOf(c, category, key), JSON.stringify(entry));
    bump(c, category, 'ioMs', performance.now() - t0);
  }

  function invalidate(prefixCls, category) {
    for (const id of [...memo.keys()]) {
      const [c, cat] = id.split('\u0000');
      if (c === prefixCls && (!category || cat === category)) memo.delete(id);
    }
  }

  function report() {
    const total = stats.hits + stats.diskHits + stats.misses;
    return { ...stats, loadMs: Math.round(stats.loadMs), diskHitMs: Math.round(stats.diskHitMs), ioMs: Math.round(stats.ioMs),
      hitRatio: total ? +((stats.hits + stats.diskHits) / total).toFixed(4) : null, size: memo.size, capacity };
  }

  /** 이번 세션(stats) + 재시작을 넘는 누적·최근 창(metrics.json). rsi_overview와 cache.stats가 쓴다. */
  async function measured() { return { session: report(), ...(await metrics.summary()) }; }

  return { get, put, invalidate, stats: report, metrics: measured, flush: () => metrics.flush(), root: () => rootOf(deps) };
}

let shared;
/** 프로세스 공용 캐시. */
function instance() {
  if (!shared) {
    shared = createCache({ capacity: 512 });
    // 짧게 도는 프로세스(CLI·측정)도 계수를 남긴다. Electron 종료는 background.stop()의 flush()가 맡는다.
    process.once('beforeExit', () => { shared.flush().catch(() => {}); });
  }
  return shared;
}

module.exports = { createCache, instance, rootOf, segment, hashKey };

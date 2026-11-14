// 지역성 캐시 누적 계수: 등급/분류별 메모리·디스크 적중, 미스, 적재, 축출과 원천 적재·디스크 시간을 재시작을 넘어 남긴다.
// 세션 통계는 메모리에만 있어 Hub를 다시 켜면 0이었다 — 캐시가 세션을 넘어 일을 줄이는지 아무도 알 수 없었다(2026-10-23 rsi_overview).
// 조회마다 쓰지 않는다: 변화를 모았다가 FLUSH_MS 뒤 한 번 파일에 더한다(원자적 쓰기). 크기는 일 버킷 KEEP_DAYS개 × 키 MAX_KEYS개로 묶인다.
// 절약 추정 = (메모리 적중 + 디스크 적중) × 그 분류의 평균 적재 시간 − 캐시가 쓴 디스크 시간(적중 읽기·실패 읽기·쓰기).
// diskSavedMs는 그중 디스크 적중 몫이다 — 세션을 넘는 효과는 이 값으로 본다.
// 1.32.39에서 예열(hot.json)을 뺐다: 1.32.11~38이 남긴 warmHits·warmed·warmMs·warmRuns(cache/warm 행)는 파일에 그대로 두되 새로 쓰지도 합치지도 않는다.
'use strict';
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('../atomic-file');

const FIELDS = ['hits', 'diskHits', 'misses', 'stale', 'loads', 'evictions', 'loadMs', 'diskHitMs', 'ioMs'];
const FLUSH_MS = 5000, KEEP_DAYS = 30, RECENT_DAYS = 7, MAX_KEYS = 64, NEVER_HIT_AFTER = 5;
const DAY = 24 * 3600 * 1000;
const KEY = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const dayOf = (t) => new Date(t).toISOString().slice(0, 10); // UTC 날짜 — 버킷 경계만 정하면 된다

function addInto(rows, from) {
  for (const [key, r] of Object.entries(from || {})) {
    if (!KEY.test(key)) continue;
    const k = (rows[key] || Object.keys(rows).length < MAX_KEYS) ? key : 'misc/overflow';
    const to = (rows[k] = rows[k] || {});
    for (const [f, n] of Object.entries(r || {})) if (FIELDS.includes(f) && Number.isFinite(n)) to[f] = +((to[f] || 0) + n).toFixed(1);
  }
  return rows;
}

/** 읽기 실패는 "기록 없음"이 아니다(규칙 6): 없으면 null, 깨졌으면 .corrupt-<시각>으로 격리하고 null, 그 밖의 오류는 던져 덮어쓰지 않는다. */
async function read(file) {
  let text;
  try { text = await fs.promises.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try { const v = JSON.parse(text); if (v && v.schemaVersion === 1) return v; } catch { /* 아래에서 격리 */ }
  await fs.promises.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
  return null;
}

// 같은 파일의 읽기-더하기-쓰기는 프로세스 안에서 한 줄로 세운다.
// shortcut: 프로세스 사이 잠금은 없다 — 두 프로세스가 같은 순간 쓰면 한쪽 5초치가 빠질 수 있다. 상시 다중 프로세스가 되면 프로세스별 파일로 나눈다.
const chains = new Map();

function createMetrics({ file, now = Date.now, flushMs = FLUSH_MS }) {
  let pending = {}, timer = null, joined = false;

  function add(key, field, n = 1) {
    if (!KEY.test(key) || !FIELDS.includes(field)) return;
    const day = dayOf(now());
    const rows = (pending[day] = pending[day] || {});
    const r = (rows[key] = rows[key] || {});
    r[field] = (r[field] || 0) + n;
    if (!timer) { timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, flushMs); timer.unref?.(); }
  }

  function flush() {
    const f = file();
    const run = async () => {
      if (!Object.keys(pending).length) return;
      const batch = pending; pending = {};
      // 데이터 폴더(캐시 루트의 부모)가 통째로 지워졌으면 되살리지 않는다 — 정리된 테스트 폴더를 종료 직전 저장이 다시 만들던 것(2026-10-23).
      if (!(await fs.promises.stat(path.dirname(path.dirname(f))).catch(() => null))) return;
      try {
        const data = (await read(f)) || { schemaVersion: 1, since: new Date(now()).toISOString(), sessions: 0, lifetime: {}, days: {} };
        for (const [day, rows] of Object.entries(batch)) { addInto(data.lifetime, rows); addInto((data.days[day] = data.days[day] || {}), rows); }
        const cutoff = dayOf(now() - (KEEP_DAYS - 1) * DAY);
        for (const day of Object.keys(data.days)) if (!/^\d{4}-\d\d-\d\d$/.test(day) || day < cutoff) delete data.days[day];
        if (!joined) { data.sessions = (data.sessions || 0) + 1; joined = true; } // 계수를 남긴 프로세스 수
        data.updatedAt = new Date(now()).toISOString();
        await writeAtomic(f, JSON.stringify(data));
      } catch (e) {
        for (const [day, rows] of Object.entries(batch)) addInto((pending[day] = pending[day] || {}), rows); // 못 쓴 변화는 다음 번에
        throw e;
      }
    };
    const p = (chains.get(f) || Promise.resolve()).then(run);
    chains.set(f, p.catch(() => {}));
    return p;
  }

  /** 누적·최근 RECENT_DAYS일 적중률과 분류별 절약 추정. 평균 적재 시간은 누적값을 쓴다(최근 창에 적재가 없어도 값이 있게). */
  async function summary() {
    await flush().catch(() => {});
    const data = (await read(file())) || { lifetime: {}, days: {} };
    const cutoff = dayOf(now() - (RECENT_DAYS - 1) * DAY);
    const recentRows = {};
    for (const [day, rows] of Object.entries(data.days || {})) if (day >= cutoff) addInto(recentRows, rows);
    const avg = (sum, n) => (n ? +(sum / n).toFixed(1) : null);
    const view = (r = {}, avgLoadMs) => {
      const g = (f) => r[f] || 0;
      const lookups = g('hits') + g('diskHits') + g('misses');
      return { lookups, hitRatio: lookups ? +((g('hits') + g('diskHits')) / lookups).toFixed(4) : null, hits: g('hits'), diskHits: g('diskHits'),
        misses: g('misses'), stale: g('stale'), loads: g('loads'), evictions: g('evictions'),
        savedMs: avgLoadMs == null ? null : Math.round((g('hits') + g('diskHits')) * avgLoadMs - g('diskHitMs') - g('ioMs')),
        // 그중 디스크 계층 몫(디스크 비용은 전부 이 계층 것) — 메모리만 있는 캐시로는 재시작 뒤에 못 얻는 절약
        diskSavedMs: avgLoadMs == null ? null : Math.round(g('diskHits') * avgLoadMs - g('diskHitMs') - g('ioMs')) };
    };
    // 최근 창은 비교에 쓰는 칸만 — rsi_overview는 MCP 응답이라 칸 하나하나가 토큰이다.
    const brief = ({ lookups, hitRatio, hits, diskHits, misses, savedMs, diskSavedMs }) => ({ lookups, hitRatio, hits, diskHits, misses, savedMs, diskSavedMs });
    const byKey = Object.entries(data.lifetime || {}).filter(([key]) => key !== 'cache/warm').map(([key, L]) => { // cache/warm은 1.32.38까지의 예열 세션 수 — 조회가 아니다
      const avgLoadMs = avg(L.loadMs || 0, L.loads || 0);
      return { key, avgLoadMs, avgDiskHitMs: avg(L.diskHitMs || 0, L.diskHits || 0), lifetime: view(L, avgLoadMs), recent: brief(view(recentRows[key], avgLoadMs)) };
    }).sort((a, b) => b.lifetime.lookups - a.lifetime.lookups);
    const total = (pick) => {
      const sum = {};
      for (const k of byKey) addInto(sum, { 'all/all': pick === 'lifetime' ? data.lifetime[k.key] : recentRows[k.key] });
      const sumOf = (f) => { const v = byKey.map((k) => k[pick][f]).filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) : null; };
      return { ...view(sum['all/all'], null), savedMs: sumOf('savedMs'), diskSavedMs: sumOf('diskSavedMs') };
    };
    return { since: data.since || null, updatedAt: data.updatedAt || null, sessions: data.sessions || 0, recentDays: RECENT_DAYS,
      lifetime: total('lifetime'), recent: brief(total('recent')), byKey,
      neverHit: byKey.filter((k) => k.lifetime.lookups >= NEVER_HIT_AFTER && !k.lifetime.hits && !k.lifetime.diskHits).map((k) => k.key) };
  }

  return { add, flush, summary };
}

module.exports = { createMetrics };

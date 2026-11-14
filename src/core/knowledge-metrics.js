// Skill lookup metrics over time — what the knowledge graph shows and what RSI proposals cite: skill_find calls,
// not-found queries, real uses (skill_use) and how many lookups missed before the skill an agent finally used.
// Device-only (Hub data folder) and bounded: 90 days of daily counters, the last 100 lookups, 50 not-found queries.
'use strict';
const path = require('path');
const { writeAtomic, readJson } = require('./atomic-file');

const DAYS_KEPT = 90, RECENT_KEPT = 100, NOT_FOUND_KEPT = 50, DAY_MS = 86400000;
// A use is attributed to the lookups of one search episode: the 30 minutes before it, after the previous use.
const EPISODE_MS = 30 * 60 * 1000;

const dataDir = (deps) => deps.dataDir || require('./paths').hubDataDir();
const fileOf = (deps = {}) => deps.file || path.join(dataDir(deps), 'knowledge-metrics.json');
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const blank = () => ({ schemaVersion: 1, days: {}, recent: [], notFound: {}, lastUseAt: 0, lastUse: {} });
const skillOf = (day, id) => day.skills[id] || (day.skills[id] = { uses: 0, shown: 0, misses: 0, found: 0 });
const dayEntry = (v, key) => v.days[key] || (v.days[key] = { finds: 0, notFound: 0, uses: 0, found: 0, misses: 0, skills: {} });
const add = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

// 사용 하나를 그날·그 스킬·그 하네스에 더한다. source: 'mcp'(skill_use) | 'log'(하네스 로그 수집). lastUse = 스킬별 마지막 참조.
function credit(v, day, id, harness, source, at) {
  const s = skillOf(day, id);
  day.uses++; s.uses++;
  add(day.sources || (day.sources = {}), source);
  if (harness) { add(day.byHarness || (day.byHarness = {}), harness); add(s.byHarness || (s.byHarness = {}), harness); }
  const last = (v.lastUse || (v.lastUse = {}))[id];
  if (!last || last.at < at) v.lastUse[id] = { at, harness: harness || null };
  return s;
}

// Read-modify-write like skill-usage.json: two processes writing in the same millisecond can lose one count.
async function update(deps, fn) {
  const v = await readJson(fileOf(deps), blank()); // a corrupt file throws instead of being reset (rule 6)
  if (v.schemaVersion !== 1) throw new Error('knowledge-metrics.json 형식이 다릅니다');
  const now = deps.now ? deps.now() : Date.now();
  const day = dayEntry(v, dayOf(now));
  const out = fn(v, day, now);
  v.days = Object.fromEntries(Object.keys(v.days).sort().slice(-DAYS_KEPT).map((d) => [d, v.days[d]]));
  await writeAtomic(fileOf(deps), JSON.stringify(v));
  return out;
}

/** skill_find 한 번: 상위 5개에 든 스킬은 노출로, 결과가 없으면 찾지 못한 질의로 센다(질의는 가려서 이 PC에만). */
function recordFind(query, verdict, deps = {}) {
  const ids = (verdict.results || []).slice(0, 5).map((r) => r.id).filter(Boolean);
  const q = require('./secret-scrub').scrub(String(query)).slice(0, 120);
  return update(deps, (v, day, now) => {
    day.finds++;
    for (const id of ids) skillOf(day, id).shown++;
    if (verdict.notFound) {
      day.notFound++;
      const n = v.notFound[q] || (v.notFound[q] = { count: 0, last: '' });
      n.count++; n.last = new Date(now).toISOString();
      // Keep the most recently missed queries: ranking by count would lock out every new query once 50 repeat.
      v.notFound = Object.fromEntries(Object.entries(v.notFound).sort((a, b) => b[1].last.localeCompare(a[1].last)).slice(0, NOT_FOUND_KEPT));
    }
    v.recent = [...v.recent, { at: now, ids }].slice(-RECENT_KEPT);
  });
}

/** skill_use 한 번: 같은 탐색에서 이 스킬을 내기 전까지 빗나간 검색 수를 "참조까지 miss"로 남긴다. */
function recordUse(id, deps = {}) {
  return update(deps, (v, day, now) => {
    const since = Math.max(now - EPISODE_MS, v.lastUseAt || 0);
    const episode = v.recent.filter((r) => r.at > since && r.at <= now);
    const hit = episode.findIndex((r) => r.ids.includes(id));
    // Lookups after the one that surfaced the skill are not misses; no lookup at all means the agent knew the skill.
    const misses = hit < 0 ? episode.length : hit;
    // Position of the skill in the lookup that surfaced it (search analytics' "click position"): 1 = top result.
    const rank = hit < 0 ? 0 : episode[hit].ids.indexOf(id) + 1;
    const s = credit(v, day, id, deps.harness, 'mcp', now);
    if (episode.length) { day.found++; day.misses += misses; s.found++; s.misses += misses; }
    if (rank) { day.rankSum = (day.rankSum || 0) + rank; day.ranked = (day.ranked || 0) + 1; s.rankSum = (s.rankSum || 0) + rank; s.ranked = (s.ranked || 0) + 1; }
    v.lastUseAt = now;
    return { misses, lookups: episode.length, rank: rank || null };
  });
}

/**
 * 하네스 로그에서 모은 사용(harness-skill-log): 행 { id, harness, at }을 그 시각의 날에 더한다. 검색을 거치지 않았으므로
 * 참조까지 miss·순위·탐색 경계(lastUseAt)는 건드리지 않는다. 보관 기간(90일) 밖의 행은 마지막 참조 시각만 남긴다.
 */
function recordHarnessUses(rows, deps = {}) {
  return update(deps, (v, _today, now) => {
    const oldest = dayOf(now - (DAYS_KEPT - 1) * DAY_MS), today = dayOf(now);
    let added = 0;
    for (const r of rows) {
      const at = Math.min(Number(r.at) || now, now), key = dayOf(at);
      if (key >= oldest && key <= today) { credit(v, dayEntry(v, key), r.id, r.harness, 'log', at); added++; }
      else if (!v.lastUse?.[r.id] || v.lastUse[r.id].at < at) (v.lastUse || (v.lastUse = {}))[r.id] = { at, harness: r.harness };
    }
    return added;
  });
}

// Other signals the graph shows next to lookups. Files are read directly: the route table and the cache sit in
// other domains, and a missing file only leaves its column empty.
async function cacheByDay(deps) {
  const m = await readJson(path.join(dataDir(deps), 'locality-cache', 'metrics.json'), { days: {} }).catch(() => ({ days: {} }));
  const out = {};
  for (const [day, rows] of Object.entries(m.days || {})) {
    let hits = 0, lookups = 0;
    for (const r of Object.values(rows || {})) { hits += (r.hits || 0) + (r.diskHits || 0); lookups += (r.hits || 0) + (r.diskHits || 0) + (r.misses || 0); }
    out[day] = { hits, lookups };
  }
  return out;
}
async function routeMisses(deps) {
  const l = await readJson(path.join(dataDir(deps), 'toolroutes', 'ledger.json'), { misses: {} }).catch(() => ({ misses: {} }));
  const rows = Object.values(l.misses || {}).map((m) => ({ example: String(m.example || ''), count: m.n || 0, last: m.last || '' }));
  return { total: rows.reduce((s, r) => s + r.count, 0), top: rows.sort((a, b) => b.count - a.count).slice(0, 10) };
}

/** 그래프·추이용 요약: 최근 days일의 일별 계수, 스킬별 합계와 일별 사용, 자주 못 찾은 질의, 캐시 적중률, 경로 표 miss. */
async function snapshot(options = {}, deps = {}) {
  const days = Math.max(1, Math.min(DAYS_KEPT, Number(options.days) || 30));
  const v = await readJson(fileOf(deps), blank());
  const now = deps.now ? deps.now() : Date.now();
  const labels = Array.from({ length: days }, (_, i) => dayOf(now - (days - 1 - i) * DAY_MS));
  const cache = await cacheByDay(deps);
  const series = labels.map((d) => {
    const x = v.days[d] || {}, c = cache[d];
    return { day: d, finds: x.finds || 0, notFound: x.notFound || 0, uses: x.uses || 0, found: x.found || 0, misses: x.misses || 0,
      rankSum: x.rankSum || 0, ranked: x.ranked || 0, logUses: (x.sources || {}).log || 0, byHarness: x.byHarness || {},
      cacheHitRatio: c && c.lookups ? +(c.hits / c.lookups).toFixed(3) : null };
  });
  const skills = {}, harness = {};
  labels.forEach((d, i) => {
    for (const [h, n] of Object.entries((v.days[d] || {}).byHarness || {})) add(harness, h, n);
    for (const [id, s] of Object.entries((v.days[d] || {}).skills || {})) {
      const t = skills[id] || (skills[id] = { uses: 0, shown: 0, misses: 0, found: 0, rankSum: 0, ranked: 0, byHarness: {}, daily: new Array(days).fill(0) });
      t.uses += s.uses; t.shown += s.shown; t.misses += s.misses; t.found += s.found || 0; t.rankSum += s.rankSum || 0; t.ranked += s.ranked || 0; t.daily[i] = s.uses;
      for (const [h, n] of Object.entries(s.byHarness || {})) add(t.byHarness, h, n);
    }
  });
  const notFound = Object.entries(v.notFound || {}).map(([q, n]) => ({ q, ...n })).sort((a, b) => b.count - a.count).slice(0, 15);
  const { $byHarness: lifetimeByHarness = {}, ...lifetime } = await require('./cache/skill-index').usageCounts(deps);
  return { days, series, skills, harness, lastUse: v.lastUse || {}, lifetime, lifetimeByHarness, notFound, routes: await routeMisses(deps),
    collector: await require('./harness-skill-log').status(deps).catch(() => null),
    hubCalls: await require('./harness-usage').hubCalls({ days }, deps).catch(() => null) };
}

module.exports = { recordFind, recordUse, recordHarnessUses, snapshot, EPISODE_MS };

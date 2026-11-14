// 여러 게임의 (Steam 사실·대표 리뷰·공개 통계 신호 ↔ 실제 게임 내용) 쌍을 모아 데이터셋 하나로 쓴다.
// 게임마다 실패해도 나머지는 계속하고 이유를 남긴다. 쓰기는 confirmed:true일 때만(writeDataset이 다시 확인).
// MCP 호출 시간(약 60초)을 넘기므로 작업으로 돌리고 상태를 따로 묻는다.
'use strict';
const crypto = require('crypto');

const MAX_GAMES = 40;
const MAX_JOBS = 20;
const jobs = new Map();

async function collectGame(appId, { language = 'koreana', max = 200 } = {}, deps = {}) {
  const steam = deps.steam || require('./steam-source');
  const { buildPairs } = require('./pair-builder');
  const details = await steam.appDetails(appId, {}, deps);
  const [rv, spy, players, histogram] = await Promise.all([
    steam.reviews(appId, { language, max }, deps), steam.steamSpy(appId, deps), steam.currentPlayers(appId, deps), steam.reviewHistogram(appId, deps)]);
  const external = steam.openSignals({ details, spy, players, histogram });
  const pairs = buildPairs({ details: { ...details, ...(spy && spy.owners ? { owners: spy.owners } : {}) }, summary: rv.summary, reviews: rv.reviews, external });
  return { pairs, signals: Object.keys(external), reviews: rv.reviews.length };
}

/** build({ appIds, name, language, maxPerGame, confirmed }) → { dir, counts, games:[{appId, ok, pairs|reason}] } */
async function build({ appIds, name, language = 'koreana', maxPerGame = 200, confirmed } = {}, deps = {}) {
  if (confirmed !== true) throw new Error('Dataset write requires confirmed: true');
  const ids = [...new Set((appIds || []).map(Number))].filter((n) => Number.isSafeInteger(n) && n > 0 && n <= 1e8);
  if (!ids.length || ids.length > MAX_GAMES) throw new TypeError(`appIds must hold 1..${MAX_GAMES} Steam app ids`);
  const games = [];
  const pairs = [];
  for (const appId of ids) {
    try {
      const g = await collectGame(appId, { language, max: Math.min(500, Math.max(20, maxPerGame)) }, deps);
      pairs.push(...g.pairs);
      games.push({ appId, ok: true, pairs: g.pairs.length, reviews: g.reviews, signals: g.signals });
    } catch (e) { games.push({ appId, ok: false, reason: String(e.message || e).slice(0, 160) }); }
  }
  if (!pairs.length) return { dir: null, counts: { total: 0 }, games };
  const written = await require('./pair-builder').writeDataset(name, pairs, { ...deps, confirmed: true });
  return { ...written, games };
}

/** 작업으로 시작한다. 같은 프로세스 안에서만 상태를 기억한다(끝난 결과는 데이터셋 폴더의 card.json에 남는다). */
function start(input, deps = {}) {
  if (input.confirmed !== true) throw new Error('Dataset write requires confirmed: true');
  const id = crypto.randomUUID();
  const job = { id, state: 'running', startedAt: new Date().toISOString(), result: null, error: null };
  // 끝난 작업은 최근 MAX_JOBS개만 기억한다 — 결과(게임별 쌍 수)는 card.json에 남으므로 오래 켜 둔 Hub에서 맵이 끝없이 자라지 않게.
  for (const [k, j] of jobs) if (jobs.size >= MAX_JOBS && j.state !== 'running') jobs.delete(k);
  jobs.set(id, job);
  build(input, deps).then((r) => { job.state = 'succeeded'; job.result = r; }, (e) => { job.state = 'failed'; job.error = String(e.message || e).slice(0, 300); });
  return { jobId: id, state: 'running' };
}

const status = (id) => jobs.get(id) || { id, state: 'unknown' };

module.exports = { build, start, status, collectGame, MAX_GAMES };

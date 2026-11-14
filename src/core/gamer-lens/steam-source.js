'use strict';

const fs = require('fs').promises;
const path = require('path');
const { createHash } = require('crypto');
const hostStates = new WeakMap();
const TTL = 24 * 60 * 60 * 1000;

function appIdOf(value) {
  if (!['number', 'string'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 1e8) {
    throw new TypeError('appId must be a positive integer <= 100000000');
  }
  return Number(value);
}

function context(deps = {}) {
  return {
    fetch: deps.fetch || globalThis.fetch,
    now: deps.now || Date.now,
    sleep: deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))),
    dataDir: deps.dataDir,
    fs: deps.fs || fs
  };
}

function stateFor(fetcher, host) {
  if (!hostStates.has(fetcher)) hostStates.set(fetcher, new Map());
  const hosts = hostStates.get(fetcher);
  if (!hosts.has(host)) hosts.set(host, { tail: Promise.resolve(), last: null, failures: 0, openUntil: 0 });
  return hosts.get(host);
}

async function request(url, reduce, deps) {
  const d = context(deps);
  const root = d.dataDir || require('../paths').hubDataDir();
  const file = path.join(root, 'gamer-lens', 'cache', createHash('sha1').update(url).digest('hex') + '.json');
  const state = stateFor(d.fetch, new URL(url).host);
  const run = async () => {
    let cached;
    try {
      cached = JSON.parse(await d.fs.readFile(file, 'utf8'));
      if (cached.schemaVersion !== 1 || !Number.isFinite(cached.cachedAt) || !('value' in cached)) {
        throw new Error('Invalid gamer-lens cache');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (cached && d.now() >= cached.cachedAt && d.now() - cached.cachedAt < TTL) return cached.value;
    if (state.openUntil > d.now()) throw new Error('Steam host circuit open');
    if (state.last !== null) await d.sleep(Math.max(0, 1100 - (d.now() - state.last)));
    if (state.openUntil > d.now()) throw new Error('Steam host circuit open');
    state.last = d.now();
    const controller = new AbortController();
    let value;
    try {
      value = await require('../promise-timeout').withTimeout((async () => {
        const response = await d.fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error('Steam HTTP ' + response.status);
        return reduce(await response.json());
      })(), 15000, () => { controller.abort(); return new Error('Steam request timed out'); });
      state.failures = 0;
      state.openUntil = 0;
    } catch (error) {
      state.failures++;
      if (state.failures >= 3) state.openUntil = d.now() + 10 * 60 * 1000;
      throw error;
    }
    await d.fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    await d.fs.writeFile(tmp, JSON.stringify({ schemaVersion: 1, cachedAt: d.now(), value }), 'utf8');
    await d.fs.rename(tmp, file);
    return value;
  };
  const result = state.tail.then(run, run);
  state.tail = result.catch(() => {});
  return result;
}

function plain(value, max) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value || '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, key) => {
      if (key[0] !== '#') return entities[key.toLowerCase()];
      const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const number = value => Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : 0;
const list = values => Array.isArray(values) ? values.map(v => String(v)).slice(0, 100) : [];

async function appDetails(appId, { lang = 'koreana', cc = 'kr' } = {}, deps) {
  const id = appIdOf(appId);
  const url = 'https://store.steampowered.com/api/appdetails?appids=' + id + '&l=' + encodeURIComponent(lang) + '&cc=' + encodeURIComponent(cc);
  return request(url, raw => {
    const item = raw && raw[id];
    if (!item || !item.success || !item.data) throw new Error('Steam app details unavailable');
    const a = item.data;
    return {
      appId: id, name: plain(a.name, 500), shortDescription: plain(a.short_description, 2000),
      about: plain(a.about_the_game, 4000), genres: list((a.genres || []).map(g => g.description)),
      categories: list((a.categories || []).map(c => c.description)), releaseDate: plain(a.release_date?.date, 100),
      developers: list(a.developers), publishers: list(a.publishers),
      price: a.price_overview ? { currency: String(a.price_overview.currency || ''), final: number(a.price_overview.final) } : null,
      metacritic: a.metacritic ? { score: number(a.metacritic.score), url: String(a.metacritic.url || '') } : null,
      recommendations: a.recommendations ? number(a.recommendations.total) : null
    };
  }, deps);
}

function reviewPage(raw) {
  if (!raw || raw.success !== 1 || !Array.isArray(raw.reviews)) throw new Error('Invalid Steam review page');
  const q = raw.query_summary || {};
  return {
    cursor: typeof raw.cursor === 'string' ? raw.cursor : '',
    summary: { totalPositive: number(q.total_positive), totalNegative: number(q.total_negative), totalReviews: number(q.total_reviews), scoreDesc: String(q.review_score_desc || '') },
    reviews: raw.reviews.map(r => {
      const seconds = number(r.timestamp_created);
      const date = new Date(seconds * 1000);
      return {
        id: String(r.recommendationid || ''), votedUp: r.voted_up === true,
        votesUp: number(r.votes_up), votesFunny: number(r.votes_funny), weightedScore: number(r.weighted_vote_score),
        playtimeHours: number(r.author?.playtime_forever) / 60,
        playtimeAtReviewHours: number(r.author?.playtime_at_review) / 60,
        language: String(r.language || ''), text: String(r.review || '').slice(0, 2000),
        createdAt: Number.isFinite(date.getTime()) ? date.toISOString() : null
      };
    })
  };
}

async function reviews(appId, { language = 'all', filter = 'all', max = 200 } = {}, deps) {
  const id = appIdOf(appId);
  if (!['all', 'recent', 'updated'].includes(filter)) throw new TypeError('Invalid review filter');
  if (!Number.isInteger(max) || max < 0 || max > 10000) throw new TypeError('max must be 0..10000');
  const output = { summary: { totalPositive: 0, totalNegative: 0, totalReviews: 0, scoreDesc: '' }, reviews: [] };
  const cursors = new Set();
  const ids = new Set();
  let cursor = '*';
  while (output.reviews.length < max && !cursors.has(cursor)) {
    cursors.add(cursor);
    const url = 'https://store.steampowered.com/appreviews/' + id + '?json=1&filter=' + filter + '&language=' + encodeURIComponent(language) + '&purchase_type=all&num_per_page=100&cursor=' + encodeURIComponent(cursor);
    let page;
    try { page = await request(url, reviewPage, deps); } catch (error) {
      if (output.reviews.length) break;
      throw error;
    }
    if (cursors.size === 1) output.summary = page.summary;
    for (const review of page.reviews) {
      if (review.id && !ids.has(review.id) && output.reviews.length < max) {
        ids.add(review.id);
        output.reviews.push(review);
      }
    }
    if (!page.reviews.length || !page.cursor) break;
    cursor = page.cursor;
  }
  return output;
}

async function steamSpy(appId, deps) {
  const id = appIdOf(appId);
  try {
    return await request('https://steamspy.com/api.php?request=appdetails&appid=' + id, raw => {
      if (!raw || Number(raw.appid) !== id || raw.error) throw new Error('SteamSpy unavailable');
      const tags = Object.create(null);
      for (const [name, votes] of Object.entries(raw.tags || {}).slice(0, 200)) {
        if (Number.isFinite(votes) && votes >= 0) tags[name.slice(0, 100)] = votes;
      }
      return { owners: String(raw.owners || ''), ccu: number(raw.ccu), averageForeverMinutes: number(raw.average_forever), tags };
    }, deps);
  } catch { return null; }
}

// 공개 통계 출처: Steam Web API(키 없는 현재 접속자)와 상점의 리뷰 추이 히스토그램.
// SteamDB·SteamCharts는 공개 API가 없고 수집을 약관으로 막아 쓰지 않는다.
async function currentPlayers(appId, deps) {
  const id = appIdOf(appId);
  try {
    return await request('https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=' + id, raw => {
      const r = raw && raw.response;
      if (!r || r.result !== 1 || !Number.isFinite(r.player_count)) throw new Error('player count unavailable');
      return r.player_count;
    }, deps);
  } catch { return null; }
}

async function reviewHistogram(appId, deps) {
  const id = appIdOf(appId);
  try {
    return await request('https://store.steampowered.com/appreviewhistogram/' + id + '?l=english&review_score_preference=0', raw => {
      const rollups = raw && raw.success === 1 && raw.results && Array.isArray(raw.results.rollups) ? raw.results.rollups : null;
      if (!rollups) throw new Error('histogram unavailable');
      const rows = rollups.slice(-24).map(r => ({ date: number(r.date), up: number(r.recommendations_up), down: number(r.recommendations_down) }));
      return { rollupType: String(raw.results.rollup_type || ''), rows };
    }, deps);
  } catch { return null; }
}

/** 공개 출처를 pair-builder.validateExternal 모양으로 모은다(추정치는 출처에 추정이라고 적는다). */
function openSignals({ details, spy, players, histogram }) {
  const external = {};
  const mc = details && details.metacritic;
  if (mc && mc.score > 0 && /^https?:\/\//.test(mc.url)) {
    external.critics = [{ outlet: 'Metacritic (Steam store data)', score: Math.min(100, mc.score), quote: '', url: mc.url.replace(/^http:/, 'https:') }];
  }
  const range = spy && /^([\d,]+)\s*\.\.\s*([\d,]+)$/.exec(spy.owners || '');
  if (range) {
    const [lo, hi] = [range[1], range[2]].map(s => Number(s.replace(/,/g, '')));
    external.sales = { source: 'SteamSpy owners range midpoint (estimate)', unitsEstimate: Math.round((lo + hi) / 2) };
  }
  const interest = { source: 'Steam Web API current players; SteamSpy peak CCU (yesterday); Steam review histogram (last rollup)' };
  if (spy && spy.ccu > 0) interest.ccuPeak = spy.ccu;
  if (Number.isFinite(players)) interest.currentPlayers = players;
  const last = histogram && histogram.rows.length ? histogram.rows[histogram.rows.length - 1] : null;
  if (last && last.up + last.down > 0) { interest.reviewsLastPeriod = last.up + last.down; interest.positiveRatioLastPeriod = +(last.up / (last.up + last.down)).toFixed(3); }
  if (Object.keys(interest).length > 1) external.interest = interest;
  return external;
}

/** 캐시 항목은 TTL(하루)이 지나면 다시 받으므로 7일 지난 파일은 쓸 일이 없다 — 받은 URL마다 파일이 하나씩 쌓였다. */
const prune = (deps = {}) => require('../data-retention').pruneOlderThan(path.join(deps.dataDir || require('../paths').hubDataDir(), 'gamer-lens', 'cache'), 7);

module.exports = { appDetails, reviews, steamSpy, currentPlayers, reviewHistogram, openSignals, prune };

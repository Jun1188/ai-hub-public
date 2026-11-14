'use strict';
// 지식 그래프 지표(knowledge-metrics)와 그 수치에서 나온 RSI 제안(rsi/metric-proposals). 모델을 부르지 않는다(AI 제안은 가짜 offload).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-kgm-'));
let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); } }
const metrics = require('../src/core/knowledge-metrics');
const proposalsOf = require('../src/core/rsi/metric-proposals');
const DAY = 86400000, T0 = Date.parse('2026-10-20T09:00:00Z');

(async () => {
  let now = T0;
  const deps = { dataDir: scratch, now: () => now };
  const find = (q, ids) => metrics.recordFind(q, { notFound: !ids.length, results: ids.map((id) => ({ id })) }, deps);

  await check('misses before hit count the lookups of one episode until the skill appeared', async () => {
    await find('review my plan', []);
    now += 60000; await find('assumption check', ['skill:ponytail']);
    now += 60000; await find('nudge questions', ['skill:other', 'skill:discernment-nudge']);
    now += 60000;
    const r = await metrics.recordUse('skill:discernment-nudge', deps);
    assert.deepStrictEqual(r, { misses: 2, lookups: 3, rank: 2 });
  });
  await check('the next use starts a new episode; a use with no lookup is not a miss', async () => {
    now += 60000;
    assert.deepStrictEqual(await metrics.recordUse('skill:ponytail', deps), { misses: 0, lookups: 0, rank: null });
    now += metrics.EPISODE_MS + 60000; await find('old', []); // outside the next use's window
    now += metrics.EPISODE_MS + 1;
    assert.strictEqual((await metrics.recordUse('skill:ponytail', deps)).lookups, 0);
  });
  await check('snapshot: daily series, per-skill totals, not-found queries, cache and route files', async () => {
    fs.mkdirSync(path.join(scratch, 'locality-cache'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'locality-cache', 'metrics.json'), JSON.stringify({ days: { '2026-10-20': { a: { hits: 3, diskHits: 1, misses: 4 } } } }));
    fs.mkdirSync(path.join(scratch, 'toolroutes'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'toolroutes', 'ledger.json'), JSON.stringify({ misses: { k: { n: 4, example: 'render the page', last: '2026-10-20' } } }));
    const s = await metrics.snapshot({ days: 7 }, deps);
    assert.strictEqual(s.series.length, 7);
    const d = s.series.find((x) => x.day === '2026-10-20');
    assert.deepStrictEqual([d.finds, d.notFound, d.uses, d.found, d.misses, d.cacheHitRatio], [4, 2, 3, 1, 2, 0.5]);
    assert.strictEqual(s.skills['skill:discernment-nudge'].misses, 2);
    assert.strictEqual(s.skills['skill:discernment-nudge'].rankSum, 2);
    assert.deepStrictEqual(s.notFound.map((n) => [n.q, n.count]), [['old', 1], ['review my plan', 1]]);
    assert.strictEqual(s.routes.total, 4);
  });
  await check('not-found queries are scrubbed before they are stored', async () => {
    await find('token ' + 'ab'.repeat(20), []);
    const s = await metrics.snapshot({ days: 7 }, deps);
    assert(s.notFound.some((n) => n.q.includes('<redacted-token>')) && !s.notFound.some((n) => /[0-9a-f]{40}/.test(n.q)));
  });
  await check('a corrupt metrics file is not reset by the next write', async () => {
    const other = fs.mkdtempSync(path.join(scratch, 'bad-'));
    fs.writeFileSync(path.join(other, 'knowledge-metrics.json'), '{broken');
    await assert.rejects(metrics.recordFind('x', { notFound: true, results: [] }, { dataDir: other }));
    assert.strictEqual(fs.readFileSync(path.join(other, 'knowledge-metrics.json'), 'utf8'), '{broken');
  });
  await check('deterministic proposals: hard-to-find skill, repeated not-found query, low hit rate', async () => {
    const snap = { days: 30, lifetime: {}, routes: { total: 0, top: [] },
      skills: { 'skill:a': { uses: 2, shown: 3, misses: 6, found: 2, daily: [] }, 'skill:b': { uses: 0, shown: 9, misses: 0, found: 0, daily: [] } },
      notFound: [{ q: 'gpu spill', count: 3, last: '2026-10-20' }],
      series: Array.from({ length: 7 }, () => ({ finds: 4, notFound: 2 })) };
    const out = await proposalsOf.proposals(snap, { ...deps, dataDir: path.join(scratch, 'no-repo') });
    const titles = out.map((p) => p.title).join('\n');
    assert(/찾기 어려운 스킬: a/.test(titles) && /노출되지만 쓰이지 않는 스킬: b/.test(titles) && /스킬 공백: "gpu spill"/.test(titles) && /찾지 못함 50%/.test(titles), titles);
    assert(out.every((p) => p.origin === 'knowledge-metrics' && p.evidence.length));
  });
  await check('a user-written direction and AI proposals both land in the queue and are reviewed', async () => {
    const qdeps = { ...deps, dataDir: path.join(scratch, 'queue') };
    const mine = await proposalsOf.submitUserProposal({ title: '설명 고치기', prompt: 'miss가 많다', targets: ['skills/x/SKILL.md'] }, qdeps);
    await assert.rejects(proposalsOf.submitUserProposal({ title: '설명 고치기', prompt: '다시' }, qdeps), /이미/);
    let runs = 0;
    const offload = { run: () => { runs++; return 'j1'; }, wait: async () => ({ state: 'succeeded', results: [{ value: { proposals: [{ title: 'AI 1', hypothesis: 'h', evidence: ['e'],
      targets: ['스킬 검색 색인', 'skills\\x\\SKILL.md', 'ponytail', 'unknown-skill', '../outside.md', 'C:/abs/x.md', '스킬 설명 전반'] }] } }, { value: { proposals: [{ title: 'AI 2', hypothesis: 'h', evidence: ['e'] }] } }] }) };
    const repo = fs.mkdtempSync(path.join(scratch, 'repo-'));
    fs.mkdirSync(path.join(repo, 'skills', 'development', 'ponytail'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'skills', 'development', 'ponytail', 'SKILL.md'), '---\nname: ponytail\ndescription: smallest change\n---\n# Ponytail\n');
    const adeps = { ...qdeps, offload, repoRoot: repo };
    const thin = await proposalsOf.aiPropose({ worker: 'codex' }, adeps);
    assert(thin.skipped && /skill_find 0회/.test(thin.skipped) && runs === 0, 'too few finds must not call the AI');
    for (let i = 0; i < proposalsOf.AI_MIN_FINDS; i++) await metrics.recordFind(`q${i}`, { notFound: false, results: [{ id: 'skill:a' }] }, qdeps);
    const ai = await proposalsOf.aiPropose({ worker: 'codex' }, adeps);
    assert.deepStrictEqual([ai.offered, ai.added, ai.droppedTargets, runs], [2, 2, 4, 1]);
    const list = await require('../src/core/rsi/research-agents').list({}, qdeps);
    assert.strictEqual(list.length, 3);
    assert(list.every((p) => p.state === 'reviewed'));
    assert.strictEqual(list.find((p) => p.id === mine.id).origin, 'user:knowledge-graph');
    assert(list.filter((p) => p.origin === 'knowledge-metrics:ai').length === 2);
    assert.deepStrictEqual(list.find((p) => p.title === 'AI 1').targets, ['src/core/cache/skill-index.js', 'skills/x/SKILL.md', 'skills/development/ponytail/SKILL.md']);
  });

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`지식 그래프 지표: 통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exitCode = 1;
})();

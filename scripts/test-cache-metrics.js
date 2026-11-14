'use strict';
// 지역성 캐시 누적 계수(cache-metrics): 재시작(새 인스턴스·실제 두 번째 프로세스)을 넘는 적중·적재 시간 누적, 지난 예열 기록 보존,
// 분류별 축출, 모아 쓰기(조회마다 쓰지 않음), 일 버킷 30일·키 상한, 깨진 파일 격리와 읽기 오류 시 덮어쓰지 않기. 네트워크·모델 없음.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cache-metrics-'));
let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); } }

const { createCache } = require('../src/core/cache/locality-cache');
const { createMetrics } = require('../src/core/cache/cache-metrics');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 3600 * 1000;

(async () => {
  const dataDir = path.join(scratch, 'restart');
  const metricsFile = path.join(dataDir, 'locality-cache', 'metrics.json');
  const slow = (v) => async () => { await sleep(40); return v; };

  await check('counters survive a restart and the next session sees disk hits', async () => {
    const first = createCache({ capacity: 8, dataDir });
    await first.get('index', { cls: 'catalog', category: 'skills', version: 'v1', loader: slow('I') });
    await first.get('index', { cls: 'catalog', category: 'skills', version: 'v1', loader: slow('x') });
    await first.flush();
    assert(fs.existsSync(metricsFile));
    const second = createCache({ capacity: 8, dataDir }); // 새 세션: 메모리는 비었다
    assert.strictEqual(second.stats().hits + second.stats().diskHits, 0);
    assert.strictEqual(await second.get('index', { cls: 'catalog', category: 'skills', version: 'v1' }), 'I');
    const m = await second.metrics();
    assert.strictEqual(m.session.diskHits, 1);
    assert.strictEqual(m.sessions, 2);
    assert.deepStrictEqual([m.lifetime.hits, m.lifetime.diskHits, m.lifetime.misses, m.lifetime.loads], [1, 1, 1, 1]);
    assert.strictEqual(m.lifetime.hitRatio, 0.6667);
    const k = m.byKey.find((r) => r.key === 'catalog/skills');
    assert(k.avgLoadMs >= 30, `avgLoadMs ${k.avgLoadMs}`);
    assert(k.avgDiskHitMs != null && k.lifetime.savedMs > 0 && k.lifetime.diskSavedMs > 0 && k.lifetime.diskSavedMs < k.lifetime.savedMs, JSON.stringify(k));
  });

  await check('a real second process flushes on exit and adds to the same file', () => {
    const child = path.join(scratch, 'child');
    const code = `const c = require(${JSON.stringify(require.resolve('../src/core/cache/locality-cache'))}).instance();
      c.get('q', { cls: 'memory', category: 'shared-repo', loader: async () => 1 }).then(() => c.get('q', { cls: 'memory', category: 'shared-repo' }));`;
    for (let i = 0; i < 2; i++) {
      const r = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, APPDATA: child }, encoding: 'utf8', timeout: 30000 });
      assert.strictEqual(r.status, 0, r.stderr);
    }
    const saved = JSON.parse(fs.readFileSync(path.join(child, 'ai-hub', 'locality-cache', 'metrics.json'), 'utf8'));
    const row = saved.lifetime['memory/shared-repo'];
    assert.strictEqual(saved.sessions, 2);
    assert.deepStrictEqual([row.loads, row.diskHits, row.hits], [1, 1, 2]); // 두 번째 프로세스의 첫 조회는 디스크 적중
  });

  await check('keys that themselves contain the \\u0000 separator (shared-memory keys) come back from the disk memo', async () => {
    const dir = path.join(scratch, 'sep');
    const a = createCache({ capacity: 8, dataDir: dir });
    const key = ['query text', 'memory,log', '5'].join('\u0000');
    await a.get(key, { cls: 'memory', category: 'shared-repo', loader: async () => ({ hits: 1 }) });
    const b = createCache({ capacity: 8, dataDir: dir });
    assert.deepStrictEqual(await b.get(key, { cls: 'memory', category: 'shared-repo' }), { hits: 1 });
    assert.strictEqual((await b.metrics()).session.diskHits, 1);
  });
  await check('the entry-count cap drops the oldest entries first and counts evictions per category', async () => {
    const dir = path.join(scratch, 'cap-entries');
    const a = createCache({ capacity: 8, dataDir: dir });
    await a.get('hot', { cls: 'skills', category: 'dev', loader: async () => 'H' });
    for (let i = 0; i < 12; i++) await a.get('scan' + i, { cls: 'logs', category: 'x', loader: async () => i });
    const m = await a.metrics();
    const dev = m.byKey.find((r) => r.key === 'skills/dev'), logs = m.byKey.find((r) => r.key === 'logs/x');
    assert.deepStrictEqual([m.session.size, dev.lifetime.evictions, logs.lifetime.evictions], [8, 1, 4]);
  });
  await check('warm-up records from 1.32.11-1.32.38 stay in the file but are neither summed nor written again', async () => {
    const dir = path.join(scratch, 'legacy');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'metrics.json');
    const t = Date.parse('2026-10-29T12:00:00Z');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, sessions: 3, lifetime: { 'skills/dev': { hits: 2, warmHits: 1, warmed: 4, warmMs: 9 }, 'cache/warm': { warmRuns: 3 } },
      days: { '2026-10-28': { 'skills/dev': { hits: 2, warmHits: 1, warmed: 4, warmMs: 9 }, 'cache/warm': { warmRuns: 3 } } } }));
    const m = createMetrics({ file: () => file, now: () => t });
    m.add('skills/dev', 'warmHits'); m.add('cache/warm', 'warmRuns'); m.add('skills/dev', 'hits');
    const s = await m.summary();
    assert.strictEqual(s.warm, undefined);
    assert.deepStrictEqual(s.byKey.map((k) => k.key), ['skills/dev']);
    assert.strictEqual(s.lifetime.hits, 3); assert.strictEqual(s.lifetime.warmHits, undefined);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(saved.lifetime['skills/dev'], { hits: 3, warmHits: 1, warmed: 4, warmMs: 9 });
    assert.deepStrictEqual(saved.lifetime['cache/warm'], { warmRuns: 3 });
    assert.strictEqual(saved.days['2026-10-29']['cache/warm'], undefined);
  });

  await check('lookups are batched, not written one by one', async () => {
    const file = path.join(scratch, 'batch', 'metrics.json');
    const m = createMetrics({ file: () => file, flushMs: 80 });
    for (let i = 0; i < 50; i++) m.add('catalog/skills', 'hits');
    assert(!fs.existsSync(file));
    await sleep(250);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).lifetime['catalog/skills'].hits, 50);
  });

  await check('day buckets roll off after 30 days; lifetime keeps them; recent window is 7 days', async () => {
    let t = Date.parse('2026-09-01T12:00:00Z');
    const file = path.join(scratch, 'roll', 'metrics.json');
    const m = createMetrics({ file: () => file, now: () => t });
    m.add('memory/shared-repo', 'misses', 6); await m.flush();
    t += 10 * DAY; m.add('memory/shared-repo', 'hits', 4); await m.flush();
    t += 30 * DAY; m.add('memory/shared-repo', 'hits', 1); await m.flush();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(Object.keys(saved.days), ['2026-10-11']);
    const s = await m.summary();
    assert.deepStrictEqual([s.lifetime.hits, s.lifetime.misses, s.recent.hits, s.recent.misses], [5, 6, 1, 0]);
  });

  await check('key count is capped and never-hit categories are reported', async () => {
    const file = path.join(scratch, 'cap', 'metrics.json');
    const m = createMetrics({ file: () => file });
    for (let i = 0; i < 80; i++) m.add(`logs/k${i}`, 'misses', 5);
    m.add('__proto__', 'hits'); // 키 형식이 아니면 버린다
    const s = await m.summary();
    assert(s.byKey.length <= 65 && s.byKey.some((k) => k.key === 'misc/overflow'), String(s.byKey.length));
    assert(s.neverHit.includes('logs/k0'));
    assert.strictEqual({}.hits, undefined);
  });

  await check('a corrupt file is quarantined, an unreadable one is not overwritten', async () => {
    const dir = path.join(scratch, 'bad');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'metrics.json');
    fs.writeFileSync(file, '{"schemaVersion":1,"lifetime":');
    const m = createMetrics({ file: () => file });
    m.add('catalog/skills', 'hits'); await m.flush();
    assert(fs.readdirSync(dir).some((n) => n.startsWith('metrics.json.corrupt-')));
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).lifetime['catalog/skills'].hits, 1);
    const blocked = path.join(dir, 'blocked.json');
    fs.mkdirSync(blocked); // 디렉터리 → EISDIR: "없음"이 아니라 읽기 실패
    const n = createMetrics({ file: () => blocked });
    n.add('catalog/skills', 'hits', 3);
    await assert.rejects(n.flush());
    fs.rmdirSync(blocked);
    await n.flush();
    assert.strictEqual(JSON.parse(fs.readFileSync(blocked, 'utf8')).lifetime['catalog/skills'].hits, 3); // 못 쓴 변화가 남아 있었다
  });

  await check('a late flush does not recreate a deleted data folder', async () => {
    const dir = path.join(scratch, 'gone');
    const c = createCache({ capacity: 8, dataDir: dir });
    await c.get('k', { cls: 'skills', category: 'dev', loader: async () => 1 });
    fs.rmSync(dir, { recursive: true, force: true }); // 테스트 정리·사용자 삭제
    await c.flush();
    assert(!fs.existsSync(dir));
  });

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`캐시 누적 계수: 통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exitCode = 1;
})();

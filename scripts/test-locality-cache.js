'use strict';
// 지역성 캐시(해시 메모)·GC 프로그램·스킬 색인: 세션을 넘는 재사용, 항목 수 상한, 버전 무효화, 디렉터리 TTL 삭제와 루트 밖 거부,
// 색인의 이분 탐색 접두사·하이브리드 검색·원천 변경 감지. 네트워크·모델 없음.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cache-'));
let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); } }

const { createCache } = require('../src/core/cache/locality-cache');
const gc = require('../src/core/cache/cache-gc');
const idx = require('../src/core/cache/skill-index');

(async () => {
  const t = Date.now();
  const now = () => t;
  const c1 = createCache({ capacity: 8, dataDir: scratch, now });
  let loads = 0;
  const loader = (v) => async () => { loads++; return v; };
  await check('miss loads then memory hit', async () => {
    assert.strictEqual(await c1.get('k1', { cls: 'skills', category: 'dev', loader: loader('v1') }), 'v1');
    assert.strictEqual(await c1.get('k1', { cls: 'skills', category: 'dev', loader: loader('x') }), 'v1');
    assert.strictEqual(loads, 1);
    assert.strictEqual(c1.stats().hits, 1);
  });
  await check('version change is a miss', async () => {
    assert.strictEqual(await c1.get('k1', { cls: 'skills', category: 'dev', version: 'b', loader: loader('v2') }), 'v2');
    assert.strictEqual(c1.stats().stale, 1);
  });
  await check('memory memo is capped by entry count; an evicted key comes back from disk, not the loader', async () => {
    for (let i = 0; i < 3; i++) await c1.get('hot', { cls: 'skills', category: 'dev', loader: loader('H') });
    for (let i = 0; i < 20; i++) await c1.get('scan' + i, { cls: 'logs', category: 'x', loader: loader(i) });
    assert.strictEqual(c1.stats().size, 8);
    assert(c1.stats().evictions >= 13);
    const before = loads, disk = c1.stats().diskHits;
    assert.strictEqual(await c1.get('hot', { cls: 'skills', category: 'dev', loader: loader('H2') }), 'H');
    assert.strictEqual(loads, before);
    assert.strictEqual(c1.stats().diskHits, disk + 1);
  });
  await check('a new process reads the disk memo; no hot.json, snapshot() or warm()', async () => {
    const c2 = createCache({ capacity: 8, dataDir: scratch, now });
    assert.strictEqual(c2.snapshot, undefined); assert.strictEqual(c2.warm, undefined);
    const before = loads;
    assert.strictEqual(await c2.get('hot', { cls: 'skills', category: 'dev', loader: loader('nope') }), 'H');
    assert.strictEqual(await c2.get('hot', { cls: 'skills', category: 'dev', loader: loader('nope') }), 'H');
    assert.strictEqual(loads, before);
    assert.deepStrictEqual([c2.stats().diskHits, c2.stats().hits], [1, 1]);
    assert(!fs.existsSync(path.join(scratch, 'locality-cache', 'hot.json')));
  });
  await check('disk tier serves a cold process without loader', async () => {
    const c3 = createCache({ capacity: 8, dataDir: scratch, now });
    assert.strictEqual(await c3.get('k1', { cls: 'skills', category: 'dev', version: 'b' }), 'v2');
    assert.strictEqual(c3.stats().diskHits, 1);
  });
  await check('category directories get no .meta.json (gc uses the directory mtime)', () => {
    assert(!fs.existsSync(path.join(scratch, 'locality-cache', 'skills', 'dev', '.meta.json')));
  });

  const root = path.join(scratch, 'locality-cache');
  const oldDir = path.join(root, 'logs', 'x');
  const old = new Date(Date.now() - 40 * 86400000);
  fs.utimesSync(oldDir, old, old);
  await check('gc dry run reports without deleting', async () => {
    const r = await gc.collect({ root, dryRun: true });
    assert(r.removed.some((d) => d.dir === 'logs/x'));
    assert(fs.existsSync(oldDir));
  });
  await check('gc removes idle category dirs only', async () => {
    const r = await gc.collect({ root });
    assert(r.removed.some((d) => d.dir === 'logs/x' && d.reason === 'ttl'));
    assert(!fs.existsSync(oldDir));
    assert(fs.existsSync(path.join(root, 'skills', 'dev')));
  });
  await check('gc size cap evicts least recently used', async () => {
    const r = await gc.collect({ root, maxBytes: 1, dryRun: true });
    assert(r.removed.length >= 1 && r.removed.every((d) => d.reason === 'size'));
  });
  await check('gc on a missing root is harmless', async () => assert.strictEqual((await gc.collect({ root: path.join(scratch, 'none') })).missing, true));

  const repo = path.join(scratch, 'repo');
  const mk = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  mk('skills/development/ponytail/SKILL.md', '---\nname: ponytail\ndescription: Use when writing or fixing code; smallest complete change, reuse first.\n---\n# Ponytail\n## Before you write\n');
  mk('skills/writing/log/SKILL.md', '---\nname: log\ndescription: 문제 해결 기록을 남기고 찾을 때 사용한다.\n---\n# 로그\n');
  mk('skills/writing/log/logs/ai-hub/telemetry/pc-log-2026-10-18-paging.md', '\uFEFF# 페이징 원인 프로세스 오판\n## 증상\n'); // 실제 로그처럼 BOM으로 시작
  mk('skills/web-design/kill-ai-slop/SKILL.md', '---\nname: kill-ai-slop\ndescription: Use when a web UI looks AI-generated; remove gradients and template tics.\n---\n# Kill\n');
  const cache = createCache({ capacity: 16, dataDir: path.join(scratch, 'idx') });
  // 가짜 임베딩: '기록·log' 계열은 한 방향, 나머지는 다른 방향 — 실제 LM Studio를 부르지 않는다.
  let embedCalls = 0;
  const embedder = { model: () => 'fake', embed: async (texts) => { embedCalls++; return texts.map((t) => Float32Array.from([/기록|record/i.test(t) ? 1 : 0, /code|코드|refactor/i.test(t) ? 1 : 0, /web|slop/i.test(t) ? 1 : 0])); } };
  const deps = { repoRoot: repo, cache, embedder, dataDir: path.join(scratch, 'data') };
  const first = await idx.load(deps);
  await check('index: skills and logs collected with categories', () => {
    assert.strictEqual(first.index.docs.filter((d) => d.kind === 'skill').length, 3);
    assert(first.index.docs.some((d) => d.kind === 'log' && d.category === 'ai-hub/telemetry' && d.description === '페이징 원인 프로세스 오판'));
  });
  await check('index: binary-search prefix range', () => assert.deepStrictEqual(idx.prefix(first.index, 'k').map((d) => d.name), ['kill-ai-slop']));
  await check('index: hybrid search ranks the relevant skill first', async () => {
    assert.strictEqual((await idx.find('fix code smallest change', {}, deps))[0].name, 'ponytail');
    assert.strictEqual((await idx.find('페이징 원인', { kind: 'log' }, deps))[0].kind, 'log');
  });
  await check('index: second load is a cache hit', async () => { const before = cache.stats().hits + cache.stats().diskHits; await idx.load(deps); assert(cache.stats().hits + cache.stats().diskHits > before); });
  await check('index: a changed SKILL.md rebuilds the index', async () => {
    mk('skills/development/ponytail/SKILL.md', '---\nname: ponytail\ndescription: Changed description about refactoring legacy modules carefully.\n---\n# P\n');
    fs.utimesSync(path.join(repo, 'skills/development/ponytail/SKILL.md'), new Date(), new Date(Date.now() + 5000));
    const again = await idx.load(deps);
    assert.notStrictEqual(again.version, first.version);
    assert(/refactoring/.test(again.index.docs.find((d) => d.name === 'ponytail').description));
  });
  await check('index: recorded use boosts ranking', async () => {
    await idx.recordUse('skill:kill-ai-slop', deps); await idx.recordUse('skill:kill-ai-slop', deps);
    const r = await idx.find('remove template', {}, deps);
    assert.strictEqual(r[0].name, 'kill-ai-slop');
  });

  await check('usage counts live in a data file (not the GC-able cache) and survive a corrupt read without being overwritten', async () => {
    const file = path.join(scratch, 'data', 'skill-usage.json');
    assert(fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8'))['skill:kill-ai-slop'] === 2);
    assert.strictEqual(await cache.get('usage', { cls: 'catalog', category: 'usage' }), null);
    fs.writeFileSync(file, '{broken');
    await assert.rejects(idx.recordUse('skill:x', deps));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{broken');
    assert.deepStrictEqual(await idx.usageCounts(deps), {});
    fs.writeFileSync(file, JSON.stringify({ 'skill:kill-ai-slop': 2 }));
  });
  await check('index: nonsense query is notFound, not a forced match', async () => {
    const v = await idx.findVerdict('zebra quokka hydrant', {}, deps);
    assert.strictEqual(v.notFound, true);
    assert.strictEqual((await idx.findVerdict('refactoring legacy modules', {}, deps)).notFound, false); // 위에서 바뀐 ponytail 설명과 어휘가 겹친다
  });
  await check('index: generated catalog.json avoids re-reading unchanged SKILL.md', async () => {
    const files = ['skills/development/ponytail/SKILL.md', 'skills/writing/log/SKILL.md', 'skills/web-design/kill-ai-slop/SKILL.md'];
    const skills = files.map((p) => ({ path: p, name: p.split('/').slice(-2)[0], category: p.split('/')[1], description: 'from catalog ' + p, headings: [], bytes: fs.statSync(path.join(repo, p)).size }));
    fs.writeFileSync(path.join(repo, 'skills', 'catalog.json'), JSON.stringify({ schemaVersion: 1, skills }));
    const known = await idx.knownFromCatalog(repo);
    const entries = await idx.scanRepository(repo, known);
    assert.strictEqual(entries.stats.reused, 3);
    assert.strictEqual(entries.stats.read, 1); // 로그 색인이 없으니 로그 하나만 머리를 읽는다
    fs.appendFileSync(path.join(repo, files[0]), '\n추가\n');
    const again = await idx.scanRepository(repo, known);
    assert.strictEqual(again.stats.read, 2); // 크기가 바뀐 SKILL.md는 다시 읽는다
    assert(!/from catalog/.test(again.find((e) => e.name === 'ponytail').description));
  });

  fs.rmSync(path.join(repo, 'skills', 'catalog.json'));
  await check('semantic layer: an English query reaches a Korean description; doc embeddings are cached', async () => {
    const xdeps = { ...deps, probe: [['기록', 'record', 'web']] }; // 가짜 임베딩은 이 번역 쌍을 잇는다 → cross-lingual
    const before = embedCalls;
    const v = await idx.findVerdict('record a problem', { kind: 'skill' }, xdeps);
    assert.strictEqual(v.results[0].name, 'log', JSON.stringify(v.results.map((r) => [r.name, r.score, r.lexical, r.semantic])));
    assert.strictEqual(v.semantic.mode, 'cross-lingual');
    const mid = embedCalls;
    await idx.findVerdict('record the fix', { kind: 'skill' }, xdeps);
    assert(mid - before <= 3 && embedCalls - mid === 1, `embed calls ${mid - before}, ${embedCalls - mid}`); // 두 번째 검색은 질의 임베딩 1번뿐(문서·탐침은 캐시)
    const off = await idx.findVerdict('record a problem', { kind: 'skill', semantic: false }, xdeps);
    assert.strictEqual(off.notFound, true); // 의미 계층 없이는 어휘가 안 겹쳐 찾지 못한다
  });
  await check('semantic layer: an embedder that only separates languages cannot admit matches on its own', async () => {
    // nomic-embed-text v1.5 실측과 같은 모양: 뜻과 무관하게 한글이면 한쪽, 아니면 다른 쪽.
    const langOnly = { model: () => 'lang-only', embed: async (texts) => texts.map((t) => Float32Array.from(/[가-힣]/.test(t) ? [1, 0] : [0, 1])) };
    const v = await idx.findVerdict('움짤 만들기', {}, { ...deps, embedder: langOnly });
    assert.strictEqual(v.semantic.mode, 'rerank-only');
    assert.strictEqual(v.notFound, true, JSON.stringify(v.results.map((r) => r.name)));
    assert.strictEqual((await idx.findVerdict('문제 해결 기록', { kind: 'skill' }, { ...deps, embedder: langOnly })).results[0].name, 'log'); // 어휘 후보는 그대로
  });
  await check('semantic layer: skill search uses index.skillEmbeddingModel without touching the global model', async () => {
    const seen = new Set();
    const multi = { model: () => 'global-model', embed: async (texts, opts = {}) => { seen.add(opts.model); return texts.map(() => Float32Array.from([1, 0])); } };
    await idx.findVerdict('record', {}, { ...deps, embedder: multi, config: { load: () => ({ index: { skillEmbeddingModel: 'multilingual-model' } }) } });
    assert.deepStrictEqual([...seen], ['multilingual-model']);
  });
  await check('semantic-only admission: margin over the median, or a clear top hit', () => {
    const synthetic = idx.buildFromEntries(Array.from({ length: 9 }, (_, i) => ({ kind: 'skill', name: `s${i}`, description: `topic ${i}`, category: 'c', path: `p${i}`, headings: [] })));
    const arr = (top, second) => Array.from({ length: 9 }, (_, i) => (i === 0 ? top : i === 1 ? second : 0.34));
    const names = (sem) => idx.search(synthetic, 'zebra quokka hydrant', { semantic: sem, semanticOnly: true }).map((r) => r.name);
    assert.strictEqual(names(arr(0.47, 0.40)).length, 1);  // +0.13 over the median
    assert.strictEqual(names(arr(0.45, 0.42)).length, 1);  // +0.11 but leads by 0.03
    assert.strictEqual(names(arr(0.45, 0.44)).length, 0);  // +0.11 and no clear lead
    assert.strictEqual(idx.search(synthetic, 'zebra quokka hydrant', { semantic: arr(0.9, 0.3), semanticOnly: false }).length, 0); // rerank-only
  });
  await check('semantic layer: unavailable embedder falls back to lexical search', async () => {
    const v = await idx.findVerdict('remove template gradients', {}, { ...deps, embedder: { model: () => 'down', embed: async () => { throw new Error('ECONNREFUSED'); } } });
    assert.strictEqual(v.results[0].name, 'kill-ai-slop');
  });

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`지역성 캐시·GC·스킬 색인: 통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exitCode = 1;
})();

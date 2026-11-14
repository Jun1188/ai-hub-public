// 스킬·로그 카탈로그 색인: 정렬 키 색인(이분 탐색·접두사 범위) + 역색인(BM25) + 부분 벡터 색인(헤더만).
// "부분"인 이유: 스킬 선택에 필요한 건 이름·설명·제목뿐이고 본문 임베딩은 비용만 크다(진행형 공개 원칙).
// 벡터는 해시 기능 TF-IDF(512차원, 모델 불필요·결정적)라 LM Studio가 꺼져 있어도 같다.
// shortcut: 정렬 배열 + 이분 탐색 — 항목 수가 수천 이하라 균형 트리보다 빠르다. 5만 개를 넘으면 B+트리로 바꾼다.
// 새 세션이 SKILL.md 머리를 다시 읽지 않게 하는 것은 저장소의 skills/catalog.json이다. 지역성 캐시(catalog 등급)는 원천 지문과 함께
// 색인(BM25·벡터, 약 15 ms 재구성)과 임베딩(LM Studio 호출 0.5–2.6 s)을 들고 있어, 실제로 세션 간에 아끼는 몫은 임베딩이다(2026-10-23 실측).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { tokens, hashVector, cosine } = require('../text-vectors');
const HEADER_BYTES = 2048;
// 어휘가 하나도 안 겹칠 때 임베딩만으로 후보가 되려면 그 질의의 문서 유사도 중앙값보다 이만큼 높아야 한다.
// 절대 코사인은 모델마다 눈금이 달라(nomic 기준 0.6이 bge-m3에서는 정답도 떨어뜨림) 중앙값 대비 간격을 쓴다.
// 실측(2026-10-22, bge-m3, 한국어 질의 → 영어 설명): 정답 +0.12~+0.28, 해당 스킬이 없는 질의의 1위 ≤ +0.09.
const SEMANTIC_MARGIN = 0.12;
// 짧은 질의는 간격이 눌린다 — 의미 1위가 2위보다 뚜렷이 앞서면(+0.02) 조금 낮은 간격(+0.10)도 받는다.
// 실측: 'fix code smallest change' → ponytail +0.113, 2위와 0.03 차. 해당 스킬이 없는 질의의 1위는 2위와 0.005~0.013 차.
const TOP_MARGIN = 0.10, TOP_LEAD = 0.02;
// 그 전에 임베딩 모델이 언어를 넘어 뜻을 잇는지 번역 쌍으로 잰다: (한국어, 같은 뜻 영어, 다른 뜻 영어)에서
// 같은 뜻 쪽이 평균 이만큼 더 가까워야 어휘 없는 후보를 받는다. 못 넘으면 임베딩은 어휘 후보의 순위만 돕는다.
// 실측(2026-10-22): nomic-embed-text v1.5는 0.058 — 뜻이 아니라 언어로 묶어, 어떤 한국어 질의에나 한국어 설명 스킬 셋을 냈다.
const CROSS_LINGUAL_GAP = 0.15;
const PROBE = [
  ['이미지 생성', 'image generation', 'tax accounting rules'],
  ['데이터베이스 백업', 'database backup', 'poetry writing style'],
  ['웹 페이지 디자인', 'web page design', 'kernel memory allocator'],
  ['게임 엔진 블루프린트', 'game engine blueprint', 'write a newsletter'],
];
const INDEX_VERSION = 'skill-index-1';

function frontmatter(text) { return require('../markdown-frontmatter').frontmatter(text) || {}; }

async function readHeader(file) {
  const fh = await fs.promises.open(file, 'r');
  // 로그·관리 문서는 BOM으로 시작한다 — 그대로 두면 첫 줄의 '# 제목'을 못 읽어 설명이 빈다(2026-10-22 실제 앱에서 발견).
  try { const buf = Buffer.alloc(HEADER_BYTES); const { bytesRead } = await fh.read(buf, 0, HEADER_BYTES, 0); return buf.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, ''); }
  finally { await fh.close(); }
}

/**
 * 저장소의 기계용 색인(skills/catalog.json · logs/INDEX.json, tools/skill_catalog.py 생성)을 path → 항목으로 읽는다.
 * 없거나 깨졌으면 빈 표 — 그때는 모든 파일의 머리를 읽는다.
 */
async function knownFromCatalog(repoRoot) {
  const known = new Map();
  const read = async (rel) => { try { return JSON.parse(await fs.promises.readFile(path.join(repoRoot, ...rel.split('/')), 'utf8')); } catch { return null; } };
  const catalog = await read('skills/catalog.json');
  if (catalog && catalog.schemaVersion === 1) for (const s of catalog.skills || []) {
    known.set(s.path, { bytes: s.bytes, entry: { kind: 'skill', name: s.name, description: s.description || '', category: s.category, path: s.path, headings: s.headings || [] } });
  }
  const logs = await read('skills/writing/log/logs/INDEX.json');
  if (logs && logs.schemaVersion === 1) for (const l of logs.logs || []) {
    known.set(l.path, { bytes: l.bytes, entry: { kind: 'log', name: l.id, description: l.title || '', category: [l.topic, l.subtopic].filter(Boolean).join('/'), path: l.path, headings: [] } });
  }
  return known;
}

/**
 * 저장소 skills/ 아래 SKILL.md와 log 스킬의 logs/<주제>/<세부>/*.md를 모은다. 디렉터리 목록은 매번 보지만(싸다),
 * 색인에 있고 크기가 같은 파일은 다시 열지 않는다 — 색인 재생성 전에 고친 파일과 새 파일만 머리를 읽는다.
 */
async function scanRepository(repoRoot, known = new Map()) {
  const entries = [];
  const stats = { reused: 0, read: 0 };
  const take = async (child, parse) => {
    const st = await fs.promises.stat(path.join(repoRoot, child)).catch(() => null);
    const k = known.get(child);
    if (st && k && k.bytes === st.size) { stats.reused++; entries.push(k.entry); return; }
    stats.read++;
    entries.push(parse(await readHeader(path.join(repoRoot, child)).catch(() => '')));
  };
  const walk = async (rel, depth) => {
    if (depth > 6) return;
    for (const e of await fs.promises.readdir(path.join(repoRoot, rel), { withFileTypes: true }).catch(() => [])) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== 'node_modules') await walk(child, depth + 1); continue; }
      const parts = child.split('/');
      if (e.name === 'SKILL.md') {
        await take(child, (head) => { const fm = frontmatter(head);
          return { kind: 'skill', name: fm.name || parts[parts.length - 2], description: fm.description || '', category: parts.length >= 4 ? parts[1] : 'uncategorized',
            path: child, headings: (head.match(/^#{1,3}\s+.+$/gm) || []).slice(0, 8).map((h) => h.replace(/^#+\s+/, '')) }; });
      } else if (/\/log\/logs\//.test(child) && e.name.endsWith('.md')) {
        const i = parts.indexOf('logs');
        await take(child, (head) => ({ kind: 'log', name: e.name.replace(/\.md$/, ''), description: ((head.match(/^#\s+(.+)$/m) || [])[1] || '').trim(),
          category: parts.slice(i + 1, -1).join('/') || 'general', path: child, headings: (head.match(/^#{2,3}\s+.+$/gm) || []).slice(0, 6).map((h) => h.replace(/^#+\s+/, '')) }));
      }
    }
  };
  await walk('skills', 0);
  entries.stats = stats;
  return entries;
}

/** 원천 지문: 파일 목록과 크기·수정 시각. 내용 해시보다 싸고, 바뀌면 반드시 달라진다. */
async function sourceFingerprint(repoRoot, entries) {
  const h = crypto.createHash('sha256').update(INDEX_VERSION);
  for (const e of entries) {
    const st = await fs.promises.stat(path.join(repoRoot, e.path)).catch(() => null);
    h.update(`${e.path}:${st ? st.size : 0}:${st ? Math.floor(st.mtimeMs) : 0};`);
  }
  return h.digest('hex').slice(0, 24);
}

function buildFromEntries(entries) {
  const docs = entries.map((e) => ({ ...e, id: `${e.kind}:${e.name}`, toks: tokens(`${e.name} ${e.name.replace(/-/g, ' ')} ${e.description} ${e.category} ${e.headings.join(' ')}`) }));
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.toks)) df.set(t, (df.get(t) || 0) + 1);
  const idf = new Map([...df].map(([t, n]) => [t, Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))]));
  const postings = {};
  for (const [i, d] of docs.entries()) {
    const tf = {};
    for (const t of d.toks) tf[t] = (tf[t] || 0) + 1;
    for (const [t, n] of Object.entries(tf)) (postings[t] = postings[t] || []).push([i, n]);
  }
  const avgLen = docs.reduce((s, d) => s + d.toks.length, 0) / Math.max(1, docs.length);
  const sorted = docs.map((d, i) => [d.name.toLowerCase(), i]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    version: INDEX_VERSION,
    docs: docs.map((d) => ({ id: d.id, kind: d.kind, name: d.name, description: d.description.slice(0, 400), category: d.category, path: d.path, len: d.toks.length, vec: hashVector(d.toks, idf) })),
    idf: Object.fromEntries(idf), postings, avgLen, sorted,
  };
}

/** 정렬 키 색인에서 접두사 범위(이분 탐색 두 번). */
function prefix(index, p) {
  const key = String(p || '').toLowerCase();
  const a = index.sorted;
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m][0] < key) lo = m + 1; else hi = m; }
  const out = [];
  for (let i = lo; i < a.length && a[i][0].startsWith(key); i++) out.push(index.docs[a[i][1]]);
  return out;
}

function search(index, q, { limit = 8, kind, usage = {}, semantic = null, semanticOnly = true } = {}) {
  const qt = tokens(q);
  if (!qt.length) return [];
  const idf = new Map(Object.entries(index.idf));
  const k1 = 1.2, b = 0.75;
  const bm = new Map();
  for (const t of new Set(qt)) {
    for (const [i, tf] of index.postings[t] || []) {
      const d = index.docs[i];
      const s = (idf.get(t) || 0) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * d.len / index.avgLen));
      bm.set(i, (bm.get(i) || 0) + s);
    }
  }
  const qv = hashVector(qt, idf);
  const maxBm = Math.max(1e-9, ...bm.values());
  const semMedian = semantic && semantic.length ? semantic.slice().sort((a, b) => a - b)[semantic.length >> 1] : null;
  const semSorted = semantic && semantic.length ? semantic.slice().sort((a, b) => b - a) : [];
  const semMax = semSorted.length ? semSorted[0] : null;
  const semLead = semSorted.length > 1 ? semSorted[0] - semSorted[1] : 0;
  const clearTop = (sem) => sem === semMax && sem - semMedian >= TOP_MARGIN && semLead >= TOP_LEAD;
  const rows = index.docs.map((d, i) => {
    if (kind && d.kind !== kind) return null;
    const lexical = (bm.get(i) || 0) / maxBm, vector = Math.max(0, cosine(qv, d.vec));
    const sem = semantic ? semantic[i] : null;
    // 해시 벡터는 같은 토큰에서만 겹친다 — 어휘 일치가 없으면 버킷 충돌일 뿐이다. 그때는 진짜 임베딩(sem)이 높을 때만 후보로 둔다.
    if (lexical === 0 && !(semanticOnly && sem != null && (sem - semMedian >= SEMANTIC_MARGIN || clearTop(sem)))) return null;
    let base;
    if (sem == null) base = 0.6 * lexical + 0.4 * vector;
    else if (semanticOnly) {
      // 언어를 넘어 뜻을 잇는 모델이면 의미를 더 믿는다: 이 질의 안에서 중앙값→최고 사이의 위치로 정규화(흔한 낱말 하나의 어휘 일치가 뜻을 이기지 않게).
      const semNorm = semMax > semMedian ? Math.max(0, (sem - semMedian) / (semMax - semMedian)) : 0;
      base = 0.35 * lexical + 0.1 * vector + 0.55 * semNorm;
    } else base = 0.45 * lexical + 0.15 * vector + 0.4 * sem;
    const used = usage[d.id] || 0;
    return { ...d, vec: undefined, score: +(base * (1 + 0.1 * Math.log2(1 + used))).toFixed(4), lexical: +lexical.toFixed(3), vector: +vector.toFixed(3), semantic: sem == null ? null : +sem.toFixed(3) };
  }).filter(Boolean);
  return rows.sort((x, y) => y.score - x.score).slice(0, limit);
}

/** 찾지 못함을 1급 결과로: 어휘 일치가 없고 벡터 유사도도 낮으면 억지 후보 대신 notFound(요즘IT「Knowledge Layer」의 근거 원칙). */
function verdict(rows) { return { notFound: !rows.length, results: rows }; }

/** 색인을 지역성 캐시에서 꺼내거나 만든다. 원천이 바뀌면 지문이 달라 자동으로 다시 만든다. */
async function load(deps = {}) {
  const repoRoot = deps.repoRoot || (deps.sharedRepo || require('../shared-repo-memory')).repoRoot();
  if (!repoRoot) throw new Error('공유 저장소 위치를 찾지 못했습니다');
  const cache = deps.cache || require('./locality-cache').instance();
  const entries = await scanRepository(repoRoot, await knownFromCatalog(repoRoot));
  const version = await sourceFingerprint(repoRoot, entries);
  const index = await cache.get('index', { cls: 'catalog', category: 'skills', version, loader: async () => buildFromEntries(entries) });
  return { index, version, repoRoot, headerReads: entries.stats };
}

// 사용 횟수는 원본 데이터다 — GC가 30일 미사용 분류를 지우는 캐시가 아니라 Hub 데이터 폴더의 파일에 둔다
// (2026-10-23 cache-metrics 실측: 캐시에 두면 skill_use 전까지 매 검색이 미스였고, 지워지면 순위·그래프 크기 근거가 사라진다).
const usageFile = (deps = {}) => deps.usageFile || path.join(deps.dataDir || require('../paths').hubDataDir(), 'skill-usage.json');
async function readUsage(deps) {
  let text;
  try { text = await fs.promises.readFile(usageFile(deps), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  return JSON.parse(text);
}
/** 검색·그래프용 읽기: 실패해도 빈 값(순위 가산만 빠진다). */
async function usageCounts(deps = {}) { try { return (await readUsage(deps)) || {}; } catch { return {}; } }

// 같은 프로세스의 쓰기(skill_use·하네스 로그 수집)를 한 줄로 세운다 — 읽고-고치고-쓰기가 겹쳐 한쪽 계수를 잃지 않게.
// 파일은 { "skill:x": 누적 } 그대로이고, 출처는 "$byHarness": { "skill:x": { 하네스: 수 } }에 둔다(id로만 읽는 쪽은 바뀌지 않는다).
let usageQueue = Promise.resolve();
function updateUsage(deps, fn) {
  const next = usageQueue.then(async () => {
    const usage = (await readUsage(deps)) || {}; // 손상된 파일은 throw — 빈 값으로 덮어쓰지 않는다
    const out = fn(usage, usage.$byHarness || (usage.$byHarness = {}));
    await require('../atomic-file').writeAtomic(usageFile(deps), JSON.stringify(usage));
    return out;
  });
  usageQueue = next.catch(() => {});
  return next;
}
function bump(usage, by, id, harness) {
  usage[id] = (usage[id] || 0) + 1;
  if (harness) { const h = by[id] || (by[id] = {}); h[harness] = (h[harness] || 0) + 1; }
}

/** 스킬 조회 기록: 실제 참조 빈도가 순위(1 + 0.1·log2(1+n))와 지식 그래프 노드 크기에 쓰인다. deps.harness = 부른 하네스. */
async function recordUse(id, deps = {}) {
  const n = await updateUsage(deps, (usage, by) => { bump(usage, by, id, deps.harness); return usage[id]; });
  // 시간별 추이·참조까지 miss는 부가 지표다 — 실패해도 사용 기록은 남는다.
  await require('../knowledge-metrics').recordUse(id, { ...deps, file: path.join(path.dirname(usageFile(deps)), 'knowledge-metrics.json') }).catch(() => {});
  return n;
}

/** 하네스 로그에서 모은 사용(harness-skill-log): 행 { id, harness } 하나가 사용 1. */
function addUses(rows, deps = {}) {
  return updateUsage(deps, (usage, by) => { for (const r of rows) bump(usage, by, r.id, r.harness); return rows.length; });
}

/**
 * 선택적 의미 계층: 설명(헤더)만 로컬 임베딩(LM Studio, embedder.js)으로 바꿔 지역성 캐시에 둔다 — 문서 집합이 같으면 다시 계산하지 않는다.
 * 한국어 질의 ↔ 영어 설명처럼 어휘가 안 겹치는 경우를 잇는다 — 모델이 번역 쌍 탐침(PROBE)을 통과할 때만(crossLingual).
 * 임베딩을 못 쓰면(서버 꺼짐·시간 초과) null로 어휘 검색만 한다.
 */
async function semanticScores(index, q, deps = {}) {
  const embedder = deps.embedder || require('../embedder');
  const cache = deps.cache || require('./locality-cache').instance();
  const within = (p, ms) => require('../promise-timeout').withTimeout(p, ms, () => new Error('embed timeout'));
  const cos = (a, b) => { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return na && nb ? s / Math.sqrt(na * nb) : 0; };
  const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
  // 스킬 검색만 다국어 모델(index.skillEmbeddingModel)을 쓸 수 있다 — 코드 색인·메모리는 기존 모델의 벡터를 유지한다.
  let model = embedder.model ? embedder.model() : 'default';
  try { const c = (deps.config || require('../config')).load(); if (c.index && c.index.skillEmbeddingModel) model = c.index.skillEmbeddingModel; } catch { /* 설정 없음 */ }
  const embed = (xs) => embedder.embed(xs, { model });
  const texts = index.docs.map((d) => `${d.name.replace(/-/g, ' ')}: ${d.description}`);
  const probe = deps.probe || PROBE;
  try {
    const docs = await cache.get(`emb:${model}:${sha1(texts.join('\n'))}`, { cls: 'catalog', category: 'embeddings', loader: async () => (await within(embed(texts), deps.embedTimeoutMs || 30000)).map((v) => Array.from(v, (x) => +x.toFixed(5))) });
    const { gap } = await cache.get(`probe:${model}:${sha1(JSON.stringify(probe))}`, { cls: 'catalog', category: 'embeddings', loader: async () => {
      const v = await within(embed(probe.flat()), deps.embedTimeoutMs || 30000);
      const sum = probe.reduce((s, _, i) => s + cos(v[i * 3], v[i * 3 + 1]) - cos(v[i * 3], v[i * 3 + 2]), 0);
      return { gap: +(sum / probe.length).toFixed(4) };
    } });
    const [qv] = await within(embed([q]), deps.queryTimeoutMs || 5000);
    return { scores: docs.map((v) => cos(Array.from(qv), v)), gap, crossLingual: gap >= CROSS_LINGUAL_GAP };
  } catch { return null; }
}

async function run(q, options, deps) {
  const { index } = await load(deps);
  const usage = await usageCounts(deps);
  const sem = options.semantic === false ? null : await semanticScores(index, q, deps);
  const rows = search(index, q, { ...options, usage, semantic: sem && sem.scores, semanticOnly: !!(sem && sem.crossLingual) });
  return { rows, semantic: sem && { gap: sem.gap, mode: sem.crossLingual ? 'cross-lingual' : 'rerank-only' } };
}

async function find(q, options = {}, deps = {}) { return (await run(q, options, deps)).rows; }

async function findVerdict(q, options = {}, deps = {}) { const r = await run(q, options, deps); return { ...verdict(r.rows), semantic: r.semantic }; }

function categories(index) {
  const out = {};
  for (const d of index.docs) { const k = `${d.kind}:${d.category}`; (out[k] = out[k] || []).push(d.name); }
  return out;
}

module.exports = { usageCounts, semanticScores, tokens, hashVector, buildFromEntries, scanRepository, knownFromCatalog, sourceFingerprint, prefix, search, verdict, load, find, findVerdict, recordUse, addUses, categories, INDEX_VERSION };

// 지식 그래프 노드의 역할과 용도: 카탈로그 · 스킬 · 하위 스킬(참조 문서) · 캐시 · 문제 로그 · 메모리 노트 · 데이터·DB · 설정 · 문서 · 스크립트.
// 경로 규칙으로 역할을 정하고 용도 한 줄을 붙인다(화면의 모양·범례·필터·상세가 이것을 쓴다). 스킬 그래프에는 캐시된 스킬 색인과
// 사용 기록(skill-usage.json)을 노드로 더해 "어느 스킬이 캐시되고 세어지는지"를 간선으로 보이고, Hub 데이터 폴더는 원본 'hub:data'로 보인다.
// 데이터 파일은 크기·시각·용도만 보이고 내용은 읽지 않는다. 비밀이 있을 수 있는 *.local.json·자격 증명은 목록에 넣지 않는다.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const io = fs.promises;
const computerId = os.hostname();
const id = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);

const ROLES = {
  catalog: { label: '카탈로그', purpose: '스킬 목차 — 에이전트가 필요한 스킬을 고르는 첫 문서' },
  skill: { label: '스킬', purpose: '스킬 본문(SKILL.md) — 읽고 적용하는 절차' },
  subskill: { label: '하위 스킬·참조', purpose: 'SKILL.md가 필요할 때만 여는 상세 문서' },
  cache: { label: '캐시', purpose: '원본에서 다시 만들 수 있는 사본 — 지우면 다시 계산한다' },
  log: { label: '문제 로그', purpose: '사건별 상황·원인·해결 기록' },
  memory: { label: '메모리 노트', purpose: '출처·승인 절차를 거치는 장기 기억' },
  data: { label: '데이터·DB', purpose: 'Hub가 쌓는 기기 전용 계수·장부 — 지우면 기록이 사라진다' },
  config: { label: '설정', purpose: '동작을 바꾸는 값' },
  doc: { label: '문서', purpose: '설명 문서' },
  script: { label: '스크립트', purpose: '스킬·도구가 실행하는 코드' },
  directory: { label: '폴더', purpose: '하위 파일을 묶는 폴더' },
  reference: { label: '미해결 링크', purpose: '링크 대상 파일을 이 PC에서 찾지 못함' },
  other: { label: '기타', purpose: '' },
};
const KNOWN = {
  'skills/CATALOG.md': '사람·에이전트가 읽는 스킬 목차(분류별 표)',
  'skills/catalog.json': '기계용 스킬 목록 — Hub skill_find가 SKILL.md 머리를 다시 읽지 않게 하는 색인(tools/skill_catalog.py build)',
  'skills/writing/log/logs/INDEX.json': '문제 로그 색인 — skill_find(kind=log)가 읽는다',
};
// Hub 데이터 폴더에서 보이는 것: [상대 경로, 역할, 용도, 폴더 여부]. 여기 없는 파일은 그래프에 넣지 않는다.
const DATA_FILES = [
  ['skill-usage.json', 'data', '스킬별 누적 사용 — skill_find 순위 가산과 그래프 점 크기. "$byHarness" = 하네스별 출처'],
  ['knowledge-metrics.json', 'data', '90일 일별 스킬 검색·찾지 못함·사용·참조까지 miss, 하네스별 사용, 스킬별 마지막 참조'],
  ['harness-skill-log.json', 'data', 'Claude Code·Codex 로그 수집기의 이어 읽기 위치(경로 해시)와 세션별로 이미 센 스킬'],
  ['tool-usage.local', 'data', 'MCP 도구별 일별 호출·오류·응답 크기·클라이언트 — 하네스별 Hub 사용', true],
  ['toolroutes/ledger.json', 'data', '도구 경로 성공·실패·시간·부른 하네스와 빗나간 의도 — tool_route 순서 학습'],
  ['rsi/proposals.json', 'data', 'RSI 제안 큐 — 검토 판정과 사람 승인 상태'],
  ['runs.json', 'data', '파이프라인 실행 기록'],
  ['harness-bus/compat.json', 'data', '하네스 탐침 결과 — 버전·헤드리스 계약 drift'],
  ['harness-bus/log.jsonl', 'data', '하네스 버스 전달 기록 — bus_stats가 센다'],
  ['locality-cache/metrics.json', 'data', '지역성 캐시 일별·누적 적중·miss 계수'],
  ['memory/memories.jsonl', 'memory', 'Hub 학습 메모리 노트(원본 「Hub 학습 메모리」)'],
  ['locality-cache/catalog/skills', 'cache', '캐시된 스킬·로그 색인(BM25·벡터) — SKILL.md·로그가 바뀌면 다시 만든다', true],
  ['locality-cache/catalog/embeddings', 'cache', '스킬 설명 임베딩 캐시 — LM Studio 호출(0.5–2.6 s)을 아낀다', true],
  ['knowledge-graph/collections', 'cache', '지식 그래프 수집 결과 — 원본에서 다시 수집할 수 있다', true],
  ['pipelines.json', 'config', '파이프라인 정의'],
  ['projects.json', 'config', '등록한 프로젝트 목록'],
];

const dataPurpose = (rel) => (DATA_FILES.find((d) => d[0] === rel) || [])[2] || '';

function roleOf(n) {
  if (n.role) return n.role;
  const p = String(n.path || '').replace(/\\/g, '/'), base = p.split('/').pop().toLowerCase();
  if (n.kind === 'directory') return 'directory';
  if (n.kind === 'skill' || base === 'skill.md') return 'skill';
  if (n.kind === 'reference') return 'reference';
  if (n.kind === 'note') return 'memory';
  if (n.kind !== 'file') return n.kind || 'other';
  if (/(^|\/)references\//i.test(p)) return 'subskill';
  if (base === 'catalog.md' || base === 'catalog.json') return 'catalog';
  if (/(^|\/)logs\//i.test(p)) return 'log';
  if (/(^|\/)memory-proposals\//i.test(p)) return 'memory';
  if (/(^|\/)(locality-)?cache\//i.test(p)) return 'cache';
  if (/(^|\/)config\//i.test(p) || /\.(ya?ml|toml|ini)$/.test(base) || /(config|settings|policy)[^/]*\.json$/.test(base)) return 'config';
  if (/\.(json|jsonl|db|sqlite3?|csv|parquet|npz)$/.test(base)) return 'data';
  if (/\.(md|markdown|txt)$/.test(base)) return 'doc';
  if (/\.(py|js|cjs|mjs|ps1|sh|ts)$/.test(base)) return 'script';
  return 'other';
}

function purposeOf(n, role) {
  const p = String(n.path || ''), base = p.split('/').pop().toLowerCase();
  if (KNOWN[p]) return KNOWN[p];
  if (role === 'skill' && n.description) return String(n.description).split(/(?<=[.!?。])\s|\n/)[0].slice(0, 200);
  if (role === 'subskill' && base === 'catalog.md') return '하위 카탈로그 — 이 스킬의 상세 문서를 고르는 표';
  if (role === 'log' && base === 'index.json') return '문제 로그 색인';
  return (ROLES[role] || ROLES.other).purpose;
}

/** 모든 노드에 role·purpose를 붙인다(이미 있으면 그대로). */
function annotate(g) {
  for (const n of g.nodes || []) { n.role = roleOf(n); if (!n.purpose) n.purpose = purposeOf(n, n.role); }
  return g;
}

async function statOf(abs, dir) {
  try {
    const st = await io.stat(abs);
    if (!dir) return st.isFile() ? { bytes: st.size, mtimeMs: st.mtimeMs } : null;
    let bytes = 0, files = 0, mtimeMs = 0;
    const walk = async (d, depth) => {
      for (const e of await io.readdir(d, { withFileTypes: true })) {
        if (files >= 5000) return;
        const p = path.join(d, e.name);
        if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
        else if (e.isFile() && !e.name.includes('.tmp')) { const s = await io.stat(p); bytes += s.size; files++; mtimeMs = Math.max(mtimeMs, s.mtimeMs); }
      }
    };
    await walk(abs, 0);
    return { bytes, files, mtimeMs };
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

const readJsonFile = async (file) => JSON.parse((await io.readFile(file, 'utf8')).replace(/^﻿/, ''));

/** 캐시된 스킬 색인(locality-cache/catalog/skills): 가장 최근 항목의 저장 시각·문서·마지막 참조(적중이 있던 날)·적중/miss. 없으면 null. */
async function skillCacheInfo(dataDir) {
  const dir = path.join(dataDir, 'locality-cache', 'catalog', 'skills');
  let files;
  try { files = (await io.readdir(dir)).filter((f) => /^[a-f0-9]+\.json$/.test(f)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  let best = null;
  for (const f of files) {
    try { const v = await readJsonFile(path.join(dir, f)); if (v.key === 'index' && (!best || v.storedAt > best.storedAt)) best = { ...v, bytes: (await io.stat(path.join(dir, f))).size }; } catch { /* 쓰는 중 */ }
  }
  if (!best) return null;
  const metrics = await readJsonFile(path.join(dataDir, 'locality-cache', 'metrics.json')).catch(() => ({}));
  const life = (metrics.lifetime || {})['catalog/skills'] || {};
  // 1.32.39부터 디렉터리 .meta.json을 쓰지 않는다 — 마지막 참조는 metrics.json 일 버킷에서 적중이 있던 마지막 날이다.
  const lastAccess = Object.entries(metrics.days || {}).filter(([, rows]) => { const r = rows['catalog/skills'] || {}; return r.hits || r.diskHits; }).map(([d]) => d).sort().pop() || null;
  const docs = ((best.value || {}).docs || []).map((d) => ({ kind: d.kind, name: d.name, path: d.path }));
  return { bytes: best.bytes, storedAt: best.storedAt, docs, lastAccess,
    stats: { hits: (life.hits || 0) + (life.diskHits || 0), misses: life.misses || 0, stale: life.stale || 0 } };
}

function base(key, extra) { return { evidence: 'EXTRACTED', computerId, scope: key, status: 'collected', observedAt: new Date().toISOString(), body: '', ...extra }; }
// Hub 데이터 노드 id는 원본(스킬 그래프·hub:data)이 달라도 같다 — 통합 그래프에서 한 노드로 합쳐진다.
function dataNode(key, rel, role, purpose, info, extra = {}) {
  return base(key, { id: id(`${computerId}:hub-data:${rel}`), kind: info.files != null ? 'directory' : 'file', role, purpose,
    path: 'hub-data/' + rel, label: extra.label || rel.split('/').pop(), bytes: info.bytes, mtimeMs: info.mtimeMs, files: info.files, ...extra });
}
function edge(key, a, b, relation) {
  return { source: a.id, target: b.id, relation, evidence: 'EXTRACTED', location: '', computerId, scope: key, targetComputerId: computerId, targetScope: key, status: 'collected', observedAt: b.observedAt };
}
const fresh = (ok, note) => ({ ok, note });

/**
 * 스킬 그래프에 더한다: SKILL.md마다 catalog.json과 같은지(최신 여부), 캐시된 스킬 색인 노드와 그 색인에 든 스킬로 가는 '캐시' 간선,
 * 사용 기록(skill-usage.json) → 세어진 스킬 '사용 기록'.
 */
async function enrichSkills(g, { repoRoot, dataDir }) {
  const key = g.key, byPath = new Map(g.nodes.map((n) => [n.path, n]));
  const known = await require('./cache/skill-index').knownFromCatalog(repoRoot);
  let stale = 0, newest = 0;
  for (const n of g.nodes) {
    if (n.kind !== 'skill') continue;
    newest = Math.max(newest, n.mtimeMs || 0);
    const k = known.get(n.path);
    n.freshness = !k ? fresh(false, 'catalog.json에 없음 — tools/skill_catalog.py build') : k.bytes === n.bytes ? fresh(true, 'catalog.json과 같음') : fresh(false, 'catalog.json과 크기가 다름 — tools/skill_catalog.py build');
    if (!n.freshness.ok) stale++;
  }
  const catalog = byPath.get('skills/catalog.json');
  if (catalog) catalog.freshness = stale ? fresh(false, `스킬 ${stale}개가 catalog.json과 다름 — tools/skill_catalog.py build`) : fresh(true, '모든 SKILL.md와 같음');
  const c = await skillCacheInfo(dataDir);
  if (c) {
    const cache = dataNode(key, 'locality-cache/catalog/skills', 'cache', dataPurpose('locality-cache/catalog/skills'), { bytes: c.bytes, mtimeMs: c.storedAt },
      { label: '캐시된 스킬 색인', lastAccess: c.lastAccess, cacheStats: c.stats, cachedDocs: c.docs.length });
    cache.freshness = c.storedAt >= newest ? fresh(true, '모든 SKILL.md보다 나중에 만듦') : fresh(false, 'SKILL.md가 캐시보다 새로움 — 다음 skill_find가 다시 만든다');
    g.nodes.push(cache);
    for (const d of c.docs) {
      const t = byPath.get(d.path);
      if (t) { t.cachedAt = c.storedAt; g.edges.push(edge(key, cache, t, 'caches')); }
    }
  }
  const usageInfo = await statOf(path.join(dataDir, 'skill-usage.json'));
  if (usageInfo) {
    const usage = await require('./cache/skill-index').usageCounts({ dataDir });
    const db = dataNode(key, 'skill-usage.json', 'data', dataPurpose('skill-usage.json'), usageInfo);
    g.nodes.push(db);
    for (const n of g.nodes) if (n.kind === 'skill' && usage[`skill:${n.label}`] > 0) g.edges.push(edge(key, db, n, 'counts'));
  }
  return g;
}

/** 원본 'hub:data': Hub 데이터 폴더의 데이터·캐시·설정 파일(크기·시각·용도). 내용은 읽지 않는다. */
async function hubDataGraph(key, dataDir) {
  const root = base(key, { id: id(`${computerId}:hub-data:.`), kind: 'directory', role: 'directory', path: 'hub-data', label: 'Hub 데이터 폴더', purpose: '이 PC 전용 — 공유 저장소로 보내지 않는다' });
  const nodes = [root], edges = [];
  const cache = await skillCacheInfo(dataDir).catch(() => null);
  for (const [rel, role, purpose, dir] of DATA_FILES) {
    const info = await statOf(path.join(dataDir, ...rel.split('/')), dir);
    if (!info) continue;
    const extra = rel === 'locality-cache/catalog/skills' && cache ? { lastAccess: cache.lastAccess, cacheStats: cache.stats, cachedDocs: cache.docs.length, label: '캐시된 스킬 색인' } : {};
    const n = dataNode(key, rel, role, purpose, info, extra);
    nodes.push(n); edges.push(edge(key, root, n, 'contains'));
  }
  return { version: 2, key, root: dataDir, label: 'Hub 데이터 · 지표·캐시·DB·설정', computerId, updatedAt: new Date().toISOString(), nodes, edges, warnings: [] };
}

module.exports = { ROLES, DATA_FILES, roleOf, purposeOf, annotate, enrichSkills, hubDataGraph, skillCacheInfo };

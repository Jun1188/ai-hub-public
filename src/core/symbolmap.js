// 엔진 전체 심볼 맵 — 임베딩 없이 정규식으로만 만드는 "어디에 무엇이 있나" 지도.
//
// 왜 임베딩이 아닌가 (실측, UE 5.8 전체 소스):
//   헤더 51,288개(492MB). 임베딩 색인은 약 3.4시간이 걸리고 청크 97만 개(벡터 약 3GB)라
//   maxChunks 상한(12만)에서 전체의 12%만 담고 잘린다.
//   같은 트리를 정규식으로 훑으면 **약 30초**다. "AActor가 어디 있나 / 부모가 뭔가"는
//   의미 검색이 필요 없는 질문이므로, 그 질문은 여기서 즉시 답하고 임베딩(codeindex)은
//   좁힌 영역의 "어떻게 동작하나"에만 쓴다.
//
// 두 번째 소스는 **해설 문서**다. 코드는 어디에 무엇이 있는지는 알려주지만 무엇이
// 중요한지는 알려주지 않는다. 사용자가 매핑한 마크다운 트리(UnrealEngineDeepDive,
// unreal_source_explained 같은)를 섹션 단위로 훑어 심볼 → 해설 위치를 잇는다.
//
// 전부 로컬·읽기 전용. 맵은 %APPDATA%/ai-hub/symbolmap/<name>.json 에만 쓴다.
'use strict';

const fs = require('fs');
const path = require('path');
const { hubDataDir } = require('./paths');

const MAP_DIR = path.join(hubDataDir(), 'symbolmap');
const CODE_EXTS = ['.h', '.hpp', '.inl'];
const NOTE_EXTS = ['.md', '.markdown'];
const EXCLUDES = ['Intermediate', 'Binaries', 'DerivedDataCache', '.git', 'node_modules', 'ThirdParty'];
// 엔진 전체가 헤더 5만여 개다. renderpipe(1.2만)보다 훨씬 높게 잡되 무한은 아니다.
const MAX_FILES = 80000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// UE 리플렉션 매크로. 바로 다음 몇 줄 안에 실제 선언이 온다.
const MACRO_RE = /^\s*(UCLASS|USTRUCT|UINTERFACE|UENUM)\s*\(([^)]*)\)/;
// class/struct 선언. MODULE_API 가 붙은 것은 모듈 밖으로 공개된 것이므로 매크로가
// 없어도 지도에 올릴 값어치가 있다.
//
// 이름 뒤를 반드시 검사한다(`\{|$`). C++는 반환 타입에도 class를 쓸 수 있어서
// `class UObject* GetResourceObject( ) const` 같은 줄이 나오는데, 이름까지만 보고
// 끊으면 이게 UObject의 선언으로 잡힌다. 실제로 UObject가 CoreUObject가 아니라
// SlateCore/SlateBrush.h로 잡혔다 — 계층 조회가 통째로 엉뚱한 좌표를 냈다.
const DECL_RE = /^\s*(?:class|struct)\s+(?:([A-Z][A-Z0-9_]*_API)\s+)?([A-Za-z_]\w*)\s*(?::\s*([^{;]+?))?\s*(\{|$)/;
// 해설 문서에서 UE 타입으로 보이는 토큰 (FSceneRenderer, UWorld, AActor, ITickable…).
const DOC_SYMBOL_RE = /\b([UAFIST][A-Z][A-Za-z0-9_]{2,})\b/g;
// 콘솔 변수(r.Shadow.., a.., p.. 등)도 튜닝에서 중요한 좌표다.
const DOC_CVAR_RE = /\b([a-z]{1,3}\.[A-Za-z][A-Za-z0-9_.]{2,})\b/g;

function mapFile(name) {
  if (!/^[\w-]{1,64}$/.test(name)) throw new Error('맵 이름은 영문/숫자/대시/밑줄만 가능합니다.');
  return path.join(MAP_DIR, `${name}.json`);
}

function collectFiles(root, exts, max = MAX_FILES) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < max) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= max) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!EXCLUDES.includes(e.name)) stack.push(full);
      } else if (exts.includes(path.extname(e.name).toLowerCase())) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * UE 모듈 이름. Runtime/Engine/... → Engine. 모듈이 곧 "어느 층인가"라서
 * 검색 필터로 가장 쓸모 있는 축이다.
 */
function moduleOf(rel) {
  const segs = rel.split('/');
  const i = segs.findIndex((s) => ['Runtime', 'Developer', 'Editor', 'Plugins', 'Programs'].includes(s));
  return i >= 0 && segs[i + 1] ? segs[i + 1] : '';
}

function parseParents(raw) {
  return (raw || '')
    .split(',')
    .map((s) => s.replace(/\b(public|private|protected|virtual)\b/g, '').trim())
    .map((s) => s.replace(/<.*>/, '').trim())
    .filter((s) => /^[A-Za-z_]\w*$/.test(s));
}

/** 헤더 한 개에서 타입 선언을 뽑는다. 전방 선언은 넣지 않는다. */
function symbolsInFile(rel, text) {
  const lines = text.split('\n');
  const out = [];
  const seen = new Set();
  const add = (s) => {
    const key = `${s.n}@${s.l}`;
    if (!seen.has(key)) { seen.add(key); out.push(s); }
  };
  const mod = moduleOf(rel);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MACRO_RE);
    if (m) {
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const d = lines[j].match(DECL_RE);
        if (d) {
          add({ n: d[2], k: m[1], p: parseParents(d[3]), f: rel, l: j + 1, m: mod });
          break;
        }
        // UENUM 뒤에는 class 대신 enum이 온다.
        const en = lines[j].match(/^\s*enum\s+(?:class\s+)?([A-Za-z_]\w*)/);
        if (en) { add({ n: en[1], k: m[1], p: [], f: rel, l: j + 1, m: mod }); break; }
      }
      continue;
    }
    const d = lines[i].match(DECL_RE);
    // Include compact class definitions while preserving the existing internal struct filter.
    if (d && (!lines[i].includes(';') || /^\s*class\s/.test(lines[i]))) {
      const exported = Boolean(d[1]);
      const opens = d[4] === '{' || (lines[i + 1] || '').trim().startsWith('{');
      if (exported || opens) {
        add({ n: d[2], k: 'class', p: parseParents(d[3]), f: rel, l: i + 1, m: mod });
      }
    }
  }
  return out;
}

/** 해설 문서 한 개를 섹션(제목 단위)으로 쪼개고 각 섹션이 언급한 심볼을 뽑는다. */
function sectionsInDoc(rel, text) {
  const lines = text.split('\n');
  const out = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const body = cur.body.join('\n');
    const syms = new Set();
    for (const m of body.matchAll(DOC_SYMBOL_RE)) syms.add(m[1]);
    for (const m of body.matchAll(DOC_CVAR_RE)) syms.add(m[1]);
    // 심볼을 하나도 언급하지 않는 섹션은 좌표로 쓸 수 없다.
    if (syms.size) out.push({ t: cur.title, f: rel, l: cur.line, s: [...syms].slice(0, 60) });
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,4})\s+(.+?)\s*$/);
    if (h) {
      flush();
      cur = { title: h[2].slice(0, 120), line: i + 1, body: [] };
    } else if (cur) {
      cur.body.push(lines[i]);
    }
  }
  flush();
  return out;
}

/**
 * 소스 트리 + (선택) 해설 문서 트리를 훑어 맵을 만든다. 순수 정규식 — 모델 불필요.
 * @param {{name:string, root:string, notesRoot?:string}} p
 * @param {(p:{phase:string, done:number, total:number})=>void} [onProgress]
 */
function scan(p, onProgress) {
  const root = path.resolve(String(p.root));
  if (!fs.existsSync(root)) throw new Error(`경로가 존재하지 않습니다: ${root}`);
  const file = mapFile(p.name);

  const codeFiles = collectFiles(root, CODE_EXTS);
  const symbols = [];
  let scanned = 0;
  for (const abs of codeFiles) {
    scanned++;
    if (onProgress && scanned % 2000 === 0) onProgress({ phase: 'code', done: scanned, total: codeFiles.length });
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.size > MAX_FILE_BYTES) continue;
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    for (const s of symbolsInFile(rel, text)) symbols.push(s);
  }

  // 해설은 여러 곳에 흩어져 있다(저장소마다 하나씩). 부모 폴더를 통째로 가리키면
  // 무관한 저장소 문서까지 딸려 들어오므로 경로를 목록으로 받는다.
  const notes = [];
  const notesRoots = (Array.isArray(p.notesRoots) ? p.notesRoots : [p.notesRoot])
    .filter(Boolean).map((d) => path.resolve(String(d)));
  for (const nr of notesRoots) {
    if (!fs.existsSync(nr)) throw new Error(`해설 문서 경로가 존재하지 않습니다: ${nr}`);
  }
  for (const nr of notesRoots) {
    const label = path.basename(nr);
    const noteFiles = collectFiles(nr, NOTE_EXTS);
    let n = 0;
    for (const abs of noteFiles) {
      n++;
      if (onProgress) onProgress({ phase: 'notes', done: n, total: noteFiles.length });
      let text;
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      // 출처를 앞에 붙여 둔다 — 어느 자료가 한 말인지가 신뢰도 판단에 필요하다.
      const rel = `${label}/${path.relative(nr, abs).replace(/\\/g, '/')}`;
      for (const s of sectionsInDoc(rel, text)) notes.push(s);
    }
  }

  // Engine trees also get console variables + BaseScalability levels: the coordinates tuning questions need.
  const engine = fs.existsSync(path.join(path.dirname(root), 'Config', 'BaseScalability.ini'))
    ? require('./cvarmap').scan(root, onProgress) : null;
  const doc = {
    name: p.name,
    root,
    notesRoots,
    scannedAt: new Date().toISOString(),
    fileCount: codeFiles.length,
    noteFileCount: notes.length ? new Set(notes.map((n) => n.f)).size : 0,
    counts: { symbols: symbols.length, noteSections: notes.length, ...(engine ? { cvars: engine.cvars.length } : {}) },
    symbols,
    notes,
    ...(engine ? { cvars: engine.cvars, scalability: engine.scalability } : {}),
  };
  fs.mkdirSync(MAP_DIR, { recursive: true });
  // 임시파일+rename — 스캔 도중 읽는 쪽이 반쪽 파일을 보지 않게(규칙 6).
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc), 'utf8');
  fs.renameSync(tmp, file);
  queryCache.delete(p.name);
  require('./change-signals').emitChanged('symbolmap');
  if (onProgress) onProgress({ phase: 'done', done: codeFiles.length, total: codeFiles.length });
  return summarize(doc);
}

function summarize(doc) {
  return {
    name: doc.name, root: doc.root, notesRoots: doc.notesRoots || [], scannedAt: doc.scannedAt,
    fileCount: doc.fileCount, noteFileCount: doc.noteFileCount, counts: doc.counts,
  };
}

function list() {
  try {
    return fs.readdirSync(MAP_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try { return summarize(JSON.parse(fs.readFileSync(path.join(MAP_DIR, f), 'utf8'))); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function load(name) {
  return JSON.parse(fs.readFileSync(mapFile(name), 'utf8'));
}

// 질의용 캐시. find·hierarchy·scopeFor가 호출마다 맵 전체(UE 5.8: 8.9 MB)를 다시 읽고 파싱했다(호출당 약 40 ms,
// 그 76%가 파싱). 파싱한 객체를 그대로 두지 않고 열(SoA)로 바꿔 둔다 — 상주 메모리가 작고, 결과 객체는
// 매번 새로 만들므로 호출자가 캐시를 고칠 길이 없다. 무효화는 파일 크기+mtime(스캔은 임시파일+rename이라
// 새 맵이면 반드시 바뀐다) — 다른 프로세스(stdio 허브·GUI)가 다시 스캔해도 다음 호출이 새 맵을 읽는다.
const QUERY_CACHE_MAX = 4;
const queryCache = new Map(); // name -> { stamp, ix }

function columns(doc) {
  const syms = doc.symbols || [];
  const n = syms.length;
  const table = () => {
    const ids = new Map();
    return { ids, id: (s) => { let i = ids.get(s); if (i === undefined) ids.set(s, i = ids.size); return i; } };
  };
  const kinds = table(), files = table(), modules = table(), parents = table();
  const name = new Array(n), lower = new Array(n);
  const kind = new Uint32Array(n), file = new Uint32Array(n), line = new Uint32Array(n), mod = new Uint32Array(n);
  const pStart = new Uint32Array(n + 1), pIds = [];
  const best = new Map(); // 같은 이름이면 리플렉션 선언(UCLASS…)이 엔진이 실제로 쓰는 그 타입이다
  for (let i = 0; i < n; i++) {
    const s = syms[i];
    name[i] = s.n; lower[i] = s.n.toLowerCase();
    kind[i] = kinds.id(s.k); file[i] = files.id(s.f); line[i] = s.l; mod[i] = modules.id(s.m);
    for (const p of s.p || []) pIds.push(parents.id(p));
    pStart[i + 1] = pIds.length;
    const cur = best.get(s.n);
    if (cur === undefined || (s.k !== 'class' && syms[cur].k === 'class')) best.set(s.n, i);
  }
  const list = (t) => [...t.ids.keys()];
  return {
    root: doc.root, n, name, lower, kind, file, line, mod, pStart, pIds: Uint32Array.from(pIds), best, parentId: parents.ids,
    kinds: list(kinds), files: list(files), modules: list(modules), parentNames: list(parents), notes: doc.notes || [],
  };
}

function queryIndex(name) {
  const file = mapFile(name);
  const st = fs.statSync(file); // %APPDATA% 로컬 디스크(규칙 1 대상 아님). 없으면 load()와 같은 ENOENT
  const stamp = `${st.size}:${st.mtimeMs}`;
  const hit = queryCache.get(name);
  if (hit && hit.stamp === stamp) return hit.ix;
  // stat 뒤에 파일이 바뀌어도 읽은 내용이 stamp보다 새것이라, 다음 호출은 다시 읽을 뿐 옛 맵을 내지 않는다.
  const ix = columns(load(name));
  queryCache.delete(name);
  queryCache.set(name, { stamp, ix });
  if (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value);
  return ix;
}

/** 결과용 새 객체 — 캐시 배열을 밖으로 내보내지 않는다. */
const parentsOf = (ix, i) => {
  const out = [];
  for (let j = ix.pStart[i]; j < ix.pStart[i + 1]; j++) out.push(ix.parentNames[ix.pIds[j]]);
  return out;
};
const symbolAt = (ix, i) => ({ name: ix.name[i], kind: ix.kinds[ix.kind[i]], file: ix.files[ix.file[i]], line: ix.line[i], module: ix.modules[ix.mod[i]] });

function remove(name) {
  try { fs.unlinkSync(mapFile(name)); } catch { /* 이미 없음 */ }
  queryCache.delete(name);
  return list();
}

/**
 * 심볼 검색. 정확 일치 → 접두 일치 → 부분 일치 순으로 정렬한다(사용자가 아는
 * 이름을 그대로 쳤을 때 그게 1등이어야 한다).
 * @param {string} name 맵 이름
 * @param {string} query
 * @param {{kind?:string, module?:string, limit?:number, withNotes?:boolean}} [opt]
 */
function find(name, query, opt = {}) {
  const ix = queryIndex(name);
  const q = String(query || '').toLowerCase();
  if (!q) return { query, matches: [], notes: [] };
  const limit = Math.max(1, Math.min(200, opt.limit || 30));

  // 없는 kind·module이면 -1이라 전부 걸러진다(예전 문자열 비교와 같다).
  const kindId = opt.kind ? ix.kinds.indexOf(opt.kind) : -1;
  const modId = opt.module ? ix.modules.indexOf(opt.module) : -1;
  const rank = new Int8Array(ix.n);
  const hits = [];
  for (let i = 0; i < ix.n; i++) {
    if (opt.kind && ix.kind[i] !== kindId) continue;
    if (opt.module && ix.mod[i] !== modId) continue;
    const low = ix.lower[i];
    const r = low === q ? 0 : low.startsWith(q) ? 1 : low.includes(q) ? 2 : -1;
    if (r < 0) continue;
    rank[i] = r;
    hits.push(i);
  }
  // 안정 정렬 + 원래 순서로 모은 hits → 객체 배열을 정렬하던 것과 같은 순서. 객체는 내보낼 limit개만 만든다.
  hits.sort((a, b) => rank[a] - rank[b] || ix.name[a].length - ix.name[b].length || ix.name[a].localeCompare(ix.name[b]));

  const notes = opt.withNotes === false ? [] : notesFor(ix, query).slice(0, 8);
  return {
    query,
    total: hits.length,
    matches: hits.slice(0, limit).map((i) => {
      const s = symbolAt(ix, i);
      return { name: s.name, kind: s.kind, parents: parentsOf(ix, i), file: s.file, line: s.line, module: s.module };
    }),
    notes,
  };
}

/** 이 이름을 언급하는 해설 섹션. "무엇이 중요한가"는 코드가 아니라 여기 있다. */
function notesFor(doc, symbol) {
  const s = String(symbol || '');
  if (!s) return [];
  const exact = [];
  const loose = [];
  for (const n of doc.notes || []) {
    if (n.s.includes(s)) exact.push({ title: n.t, file: n.f, line: n.l });
    else if (n.s.some((x) => x.toLowerCase().includes(s.toLowerCase()))) loose.push({ title: n.t, file: n.f, line: n.l });
  }
  return [...exact, ...loose];
}

/**
 * 1계층 → 2계층 다리: 이 질의에 걸린 심볼들이 **어느 디렉터리에 모여 있는지** 돌려준다.
 *
 * 임베딩 색인은 전체 트리에 걸면 3.4시간이 걸리고 상한에서 잘린다. 그런데 실제로
 * 알고 싶은 건 늘 일부다("Lumen이 어떻게 도나"). 심볼 맵이 이미 좌표를 알고 있으므로
 * 그 좌표가 모인 디렉터리만 뽑아 주면 2계층이 그 범위만 임베딩하면 된다.
 *
 * 디렉터리는 `depth` 단계까지 잘라 묶는다 — 파일 단위로 주면 목록이 수백 개가 되고,
 * 너무 얕게 자르면 Runtime/ 하나로 뭉쳐 좁히는 의미가 없다.
 *
 * @param {string} name 맵 이름
 * @param {string} query
 * @param {{kind?:string, module?:string, depth?:number, maxDirs?:number}} [opt]
 * @returns {{root:string, dirs:Array<{dir:string,symbols:number}>, symbolCount:number}}
 */
function scopeFor(name, query, opt = {}) {
  const ix = queryIndex(name);
  const depth = Math.max(1, Math.min(8, opt.depth || 4));
  const maxDirs = Math.max(1, Math.min(60, opt.maxDirs || 12));
  const hits = find(name, query, { kind: opt.kind, module: opt.module, limit: 200, withNotes: false }).matches;

  const byDir = new Map();
  for (const m of hits) {
    // 파일명을 먼저 떼고 자른다. 그냥 depth로 자르면 얕은 경로에서는 결과가 파일
    // 자체가 되는데(Runtime/Renderer/Private/ScenePrivate.h), 인덱싱 범위는
    // 디렉터리 단위라 그 항목이 통째로 무시돼 심볼을 놓친다.
    const dirParts = m.file.split('/').slice(0, -1);
    const dir = dirParts.slice(0, depth).join('/') || '.';
    byDir.set(dir, (byDir.get(dir) || 0) + 1);
  }
  // 디렉터리마다 실제 파일 수를 센다. 이게 없으면 심볼 2개 때문에
  // Runtime/Renderer/Private(렌더러 전체)를 통째로 임베딩하는 걸 알아채지 못한다 —
  // 임베딩은 비싸므로 무엇을 얼마나 색인할지 **내기 전에** 보여야 한다.
  const exts = (opt.exts && opt.exts.length ? opt.exts : ['.h']).map((e) => e.toLowerCase());
  const countFiles = (rel) => {
    let n = 0;
    const stack = [path.resolve(ix.root, rel)];
    while (stack.length) {
      let entries;
      try { entries = fs.readdirSync(stack.pop(), { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!EXCLUDES.includes(e.name)) stack.push(path.join(e.parentPath || e.path, e.name));
        } else if (exts.includes(path.extname(e.name).toLowerCase())) n++;
      }
    }
    return n;
  };
  const dirs = [...byDir.entries()]
    .map(([dir, symbols]) => ({ dir, symbols }))
    .sort((a, b) => b.symbols - a.symbols)
    .slice(0, maxDirs)
    .map((d) => ({ ...d, files: countFiles(d.dir) }));
  return { root: ix.root, dirs, symbolCount: hits.length, fileCount: dirs.reduce((n, d) => n + d.files, 0) };
}

/**
 * 상속 계층. 부모는 선언에서 바로 나오고, 자식은 전체를 훑어 역참조한다
 * (심볼 3만 개 기준 즉시).
 */
function hierarchy(name, symbol) {
  const ix = queryIndex(name);
  const target = String(symbol);
  // 같은 이름이 여러 곳에 있으면(플랫폼별 변형, 테스트용 더미) 리플렉션 선언을
  // 우선한다 — UCLASS가 붙은 쪽이 엔진이 실제로 쓰는 그 타입이다(ix.best, columns()).
  const selfI = ix.best.has(target) ? ix.best.get(target) : -1;
  const ancestors = [];
  let cur = selfI;
  const guard = new Set();
  while (cur >= 0 && ix.pStart[cur + 1] > ix.pStart[cur] && !guard.has(ix.name[cur])) {
    guard.add(ix.name[cur]);
    const parentName = ix.parentNames[ix.pIds[ix.pStart[cur]]]; // 첫 번째가 기반 클래스, 나머지는 인터페이스
    const parent = ix.best.has(parentName) ? ix.best.get(parentName) : -1;
    ancestors.push(parent >= 0 ? symbolAt(ix, parent) : { name: parentName, kind: '?', file: '', line: 0, module: '' });
    if (parent < 0) break;
    cur = parent;
  }

  const children = [];
  const tid = ix.parentId.get(target);
  if (tid !== undefined) {
    for (let i = 0; i < ix.n; i++) {
      for (let j = ix.pStart[i]; j < ix.pStart[i + 1]; j++) {
        if (ix.pIds[j] === tid) { children.push(symbolAt(ix, i)); break; }
      }
    }
  }
  const self = selfI >= 0 ? symbolAt(ix, selfI) : null;
  const selfParents = selfI >= 0 ? parentsOf(ix, selfI) : [];
  return {
    symbol: target,
    found: Boolean(self),
    self: self ? { name: self.name, kind: self.kind, parents: selfParents, file: self.file, line: self.line, module: self.module } : null,
    interfaces: selfParents.slice(1),
    ancestors,
    children: children.slice(0, 200),
    childCount: children.length,
    notes: notesFor(ix, target).slice(0, 8),
  };
}

/**
 * 이 컴퓨터에서 엔진 소스 루트로 쓸 만한 곳. 경로를 하드코딩하지 않는다(규칙 8) —
 * 소스 빌드(GitHub 클론)와 런처 설치본은 컴퓨터마다 위치가 다르다.
 */
function suggestRoots() {
  const os = require('os');
  const out = [];
  const add = (label, dir) => {
    if (fs.existsSync(dir) && !out.some((o) => path.resolve(o.path) === path.resolve(dir))) {
      out.push({ label, path: dir });
    }
  };
  const home = os.homedir();
  for (const base of [path.join(home, 'Documents', 'GitHub'), path.join(home, 'source'), 'C:\\']) {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !/unreal/i.test(e.name)) continue;
      add(`소스 빌드 — ${e.name}`, path.join(base, e.name, 'Engine', 'Source'));
    }
  }
  for (const drive of ['C:', 'D:', 'E:']) {
    const epic = path.join(drive + '\\', 'Program Files', 'Epic Games');
    let entries = [];
    try { entries = fs.readdirSync(epic, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory() && /^UE_/.test(e.name)) add(`설치본 — ${e.name}`, path.join(epic, e.name, 'Engine', 'Source'));
    }
  }
  return out.filter((o) => fs.existsSync(o.path));
}

/** Console-variable lookup on an engine map; `renderMap` (scan name) adds the knobs declared beside matching passes. */
function cvars(name, query, opt = {}) {
  const renderMap = opt.renderMap ? require('./renderpipe').load(opt.renderMap) : null;
  return require('./cvarmap').find(load(name), query, { ...opt, renderMap });
}

module.exports = {
  scan, list, load, find, hierarchy, scopeFor, remove, suggestRoots, summarize, cvars,
  symbolsInFile, sectionsInDoc, moduleOf, MAP_DIR, collectFiles,
};

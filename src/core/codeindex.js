// Local source-code index: scans a C++/UE source tree, chunks files, embeds
// them with a local model, and serves semantic search plus UE reflection-macro
// structure maps. Index data lives in %APPDATA%/ai-hub/index/<name>/.
// Read-only towards the source tree; never writes outside the hub data dir.
'use strict';

const fs = require('fs');
const path = require('path');
const { hubDataDir } = require('./paths');
const embedder = require('./embedder');

const INDEX_ROOT = path.join(hubDataDir(), 'index');
const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 8;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_EXCLUDES = ['ThirdParty', 'Intermediate', 'Binaries', '.git', 'node_modules'];

/**
 * 무엇을 인덱싱할지 고르는 프리셋. UE 소스는 전부 넣으면 파일이 수만 개라
 * 첫 인덱싱이 몇 시간 걸린다 — 목적에 맞는 최소 범위부터 권한다.
 * (한 번 만들어 두면 이후 재색인은 바뀐 파일만 다시 임베딩한다.)
 */
const EXT_PRESETS = [
  { id: 'headers', label: '헤더만 (.h) — 빠름, API·클래스 구조 파악', exts: ['.h'] },
  { id: 'impl', label: '헤더+구현 (.h .cpp) — 느림, 실제 동작 이해', exts: ['.h', '.cpp'] },
  { id: 'shaders', label: '셰이더 (.usf .ush) — 렌더링 분석', exts: ['.usf', '.ush'] },
  { id: 'build', label: '빌드 스크립트 (.cs) — 모듈 의존성', exts: ['.cs'] },
  { id: 'all', label: '전체 (.h .cpp .inl .usf .ush)', exts: ['.h', '.cpp', '.inl', '.usf', '.ush'] },
];

// in-memory state
const running = new Map(); // name -> {cancel, progress:{...}}
const vecCache = new Map(); // name -> {meta, vectors: Float32Array, norms: Float64Array, chunks: null|array, files: null|{lower, of}}

function indexDir(name) {
  if (!/^[\w-]{1,64}$/.test(name)) throw new Error('Index name must be alphanumeric/dash/underscore.');
  return path.join(INDEX_ROOT, name);
}

function listIndexes() {
  let names = [];
  try {
    names = fs.readdirSync(INDEX_ROOT).filter((n) => fs.existsSync(path.join(INDEX_ROOT, n, 'meta.json')));
  } catch { /* none yet */ }
  return names.map((n) => {
    const meta = JSON.parse(fs.readFileSync(path.join(INDEX_ROOT, n, 'meta.json'), 'utf8'));
    const prog = running.get(n);
    return {
      name: n,
      root: meta.root,
      chunkCount: meta.chunkCount,
      classCount: meta.classCount || 0,
      updatedAt: meta.updatedAt,
      indexing: Boolean(prog),
      progress: prog ? prog.progress : null,
    };
  });
}

/**
 * Walk the tree collecting source files matching extensions.
 *
 * `subdirs`(루트 상대 경로)를 주면 그 아래만 훑는다. 심볼 맵(1계층)이 좁혀 준 영역만
 * 임베딩하기 위한 것 — 엔진 전체를 임베딩하면 3.4시간이 걸리고 상한에서 잘리지만,
 * "Lumen 관련 디렉터리 6개"처럼 좁히면 수 분이면 끝난다. 경로는 반드시 루트 안이어야
 * 한다(`..`로 트리 밖을 가리키지 못하게).
 */
function collectFiles(root, exts, excludes, subdirs) {
  const out = [];
  const roots = [];
  for (const sub of subdirs || []) {
    const abs = path.resolve(root, sub);
    if (abs !== root && !abs.startsWith(root + path.sep)) continue; // 루트 밖은 무시
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    // 파일을 직접 지정할 수도 있다(심볼 하나만 좁혀 온 경우). 디렉터리 순회 대상이
    // 아니므로 확장자만 맞으면 바로 담는다 — 조용히 빠지면 그 심볼을 통째로 놓친다.
    if (st.isDirectory()) roots.push(abs);
    else if (exts.includes(path.extname(abs).toLowerCase())) out.push(abs);
  }
  const stack = roots.length || out.length ? roots : [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!excludes.some((x) => e.name.toLowerCase() === x.toLowerCase())) stack.push(p);
      } else if (exts.includes(path.extname(e.name).toLowerCase())) {
        out.push(p);
      }
    }
  }
  return out;
}

// ---- UE structure extraction ----------------------------------------------

const UE_MACRO_RE = /^\s*(UCLASS|USTRUCT|UENUM|UINTERFACE)\s*\(([^)]*)\)/;
const CLASS_DECL_RE = /^\s*(?:class|struct)\s+(?:[A-Z0-9_]+_API\s+)?([AUFSTIE]\w+)\s*(?:final\s*)?(?::\s*(.+?))?\s*(?:\{|$)/;

function parseParents(raw) {
  return (raw || '')
    .split(',')
    .map((s) => s.replace(/\b(public|private|protected|virtual)\b/g, '').trim())
    .filter(Boolean);
}

/**
 * Extract UE type info from one file's lines: reflection-macro types
 * (UCLASS/USTRUCT/...) plus plain exported classes/structs (e.g. FVector-like
 * Core types that have no reflection macros).
 */
function extractStructure(relFile, lines) {
  const found = [];
  const seen = new Set();
  const add = (entry) => {
    const key = `${entry.name}@${entry.line}`;
    if (!seen.has(key)) {
      seen.add(key);
      found.push(entry);
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(UE_MACRO_RE);
    if (m) {
      // reflection macro: the class/struct declaration follows within a few lines
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const c = lines[j].match(CLASS_DECL_RE);
        if (c) {
          add({ name: c[1], kind: m[1], specifiers: m[2].trim().slice(0, 200), parents: parseParents(c[2]), file: relFile, line: j + 1 });
          break;
        }
      }
      continue;
    }
    // non-reflected declaration: only count real definitions (exported or
    // followed by an opening brace), never forward declarations
    const c = lines[i].match(CLASS_DECL_RE);
    if (c && !lines[i].includes(';')) {
      const opensHere = lines[i].includes('{');
      const opensNext = (lines[i + 1] || '').trim().startsWith('{');
      const exported = /\b[A-Z0-9_]+_API\b/.test(lines[i]);
      if (opensHere || opensNext || exported) {
        add({ name: c[1], kind: 'class', specifiers: '', parents: parseParents(c[2]), file: relFile, line: i + 1 });
      }
    }
  }
  return found;
}

// ---- indexing ---------------------------------------------------------------

/**
 * 청크를 끊어도 되는 지점 — 함수 정의, 클래스/구조체, UE 매크로, 셰이더 진입점.
 *
 * 고정 60줄로 자르면 함수가 반토막 나서 검색 결과가 "본문 중간"만 걸리는 일이
 * 잦았다. 경계에서 끊으면 한 청크가 하나의 완결된 단위가 되어 근거로 쓰기 좋다.
 */
const CHUNK_BOUNDARY_RE = new RegExp([
  '^\\s{0,4}(?:class|struct|namespace|enum|template)\\b',           // 타입/템플릿 선언
  '^\\s{0,4}(?:U|A|F|S|I|T)[A-Za-z0-9_]*::[~A-Za-z_][\\w]*\\s*\\(', // Foo::Bar( 정의
  '^\\s{0,4}(?:UCLASS|USTRUCT|UENUM|UINTERFACE|UFUNCTION|UPROPERTY|GENERATED_BODY)\\s*\\(',
  '^\\s{0,4}(?:IMPLEMENT_|DECLARE_|BEGIN_|DEFINE_|IMPLEMENT_GLOBAL_SHADER|IMPLEMENT_SHADER_TYPE)',
  '^\\s{0,4}(?:RDG_EVENT_SCOPE|RDG_GPU_STAT_SCOPE|SCOPED_DRAW_EVENT|SCOPED_NAMED_EVENT)',
  '^\\s{0,4}(?:void|bool|int32|uint32|float|FVector|FMatrix|static|inline|virtual|const)\\s+[\\w:~]+\\s*\\(', // 일반 함수
  '^\\s{0,4}#(?:define|pragma\\s+once)',
  '^\\s{0,4}(?:\\[numthreads|technique|float4\\s+\\w+\\s*\\()',      // .usf/.ush 셰이더
].join('|'));

/** 최소 이만큼은 모아야 한 청크로 친다 (경계가 촘촘한 헤더에서 파편화 방지). */
const CHUNK_MIN_LINES = 12;

function chunkFile(relFile, content) {
  const lines = content.split('\n');
  const chunks = [];
  const push = (start, end) => {
    const text = lines.slice(start, end).join('\n').trim();
    if (text.length > 50) chunks.push({ file: relFile, startLine: start + 1, endLine: end, text });
  };

  // 끊을 수 있는 지점을 모은다.
  const boundaries = [];
  for (let i = 0; i < lines.length; i++) {
    if (CHUNK_BOUNDARY_RE.test(lines[i])) boundaries.push(i);
  }

  if (boundaries.length < 2) {
    // 경계가 거의 없는 파일(설정, 긴 데이터 등)은 예전처럼 고정 길이로 자른다.
    for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
      const end = Math.min(start + CHUNK_LINES, lines.length);
      push(start, end);
      if (end >= lines.length) break;
    }
    return { chunks, lines };
  }

  // 첫 경계 앞부분(include·주석 헤더)도 버리지 않는다 — 파일 성격을 알려준다.
  if (boundaries[0] > CHUNK_MIN_LINES) push(0, boundaries[0]);

  let start = boundaries[0];
  for (let b = 1; b <= boundaries.length; b++) {
    const next = b < boundaries.length ? boundaries[b] : lines.length;
    // 아직 너무 짧으면 다음 경계까지 더 모은다.
    if (next - start < CHUNK_MIN_LINES && b < boundaries.length) continue;
    if (next - start <= CHUNK_LINES) {
      push(start, next);
      start = next;
      continue;
    }
    // 한 단위가 너무 길면(거대한 함수) 그 안에서만 고정 길이로 쪼갠다.
    for (let s = start; s < next; s += CHUNK_LINES - CHUNK_OVERLAP) {
      const e = Math.min(s + CHUNK_LINES, next);
      push(s, e);
      if (e >= next) break;
    }
    start = next;
  }
  return { chunks, lines };
}

/**
 * 증분 재색인용으로 이전 인덱스를 연다. 재사용해도 안전한 조건일 때만 반환한다
 * (같은 루트·확장자·임베딩 모델). 하나라도 다르면 벡터를 섞을 수 없으므로 null.
 */
function loadPreviousIndex(dir, { root, exts, subdirs, model }) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    if (!meta.files || !meta.dims) return null;                       // 예전 포맷
    if (path.resolve(meta.root) !== path.resolve(root)) return null;
    if (meta.embeddingModel !== model) return null;
    if ((meta.exts || []).join(',').toLowerCase() !== exts.join(',').toLowerCase()) return null;
    // 범위가 달라졌으면 재사용하면 안 된다 — 넓힌 경우 새 디렉터리가 통째로 빠지고,
    // 좁힌 경우 사라진 파일의 청크가 남는다.
    if ((meta.subdirs || []).join('|') !== (subdirs || []).join('|')) return null;

    const chunks = fs.readFileSync(path.join(dir, 'chunks.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    if (chunks.length !== meta.chunkCount) return null;               // 파일이 어긋남

    const rowsByFile = new Map();
    chunks.forEach((c, i) => {
      if (!rowsByFile.has(c.file)) rowsByFile.set(c.file, []);
      rowsByFile.get(c.file).push(i);
    });

    const classesByFile = new Map();
    try {
      for (const c of JSON.parse(fs.readFileSync(path.join(dir, 'classes.json'), 'utf8'))) {
        if (!classesByFile.has(c.file)) classesByFile.set(c.file, []);
        classesByFile.get(c.file).push(c);
      }
    } catch { /* 구조 정보는 없어도 됨 */ }

    const rowBytes = meta.dims * 4;
    const fd = fs.openSync(path.join(dir, 'vectors.bin'), 'r');
    return {
      dims: meta.dims,
      files: meta.files,
      chunks,
      rowsByFile,
      classesByFile,
      vectorRow(i) {
        const buf = Buffer.allocUnsafe(rowBytes);
        fs.readSync(fd, buf, 0, rowBytes, i * rowBytes);
        return buf;
      },
      close() { try { fs.closeSync(fd); } catch { /* 이미 닫힘 */ } },
    };
  } catch {
    return null; // 이전 인덱스가 없거나 깨졌으면 전체 재색인
  }
}

/**
 * Build (or rebuild) an index. Long-running; reports via onProgress(p) and
 * checks a cancel flag. Only one build per index name at a time.
 */
async function buildIndex({ name, root, exts = ['.h'], excludes = DEFAULT_EXCLUDES, subdirs = [], maxChunks = 120000, incremental = true }, onProgress) {
  indexDir(name);
  if (running.has(name)) throw new Error(`Index "${name}" is already building.`);
  root = path.resolve(root);
  if (!fs.existsSync(root)) throw new Error(`Root not found: ${root}`);

  const state = {
    cancel: false,
    controller: new AbortController(),
    progress: { phase: 'scanning', files: 0, chunks: 0, embedded: 0, total: 0, reused: 0 },
  };
  running.set(name, state);
  const report = () => {
    if (onProgress) onProgress({ name, ...state.progress });
  };
  let prev = null;
  try {
    state.progress.phase = 'checking-server';
    report();
    await embedder.preflight({ signal: state.controller.signal });
    state.progress.phase = 'scanning';
    const dir = indexDir(name);
    fs.mkdirSync(dir, { recursive: true });

    // 증분 재색인: 바뀌지 않은 파일은 임베딩을 그대로 재사용한다.
    // UE Engine/Source를 .h+.cpp로 돌리면 파일이 수만 개라 전체 재임베딩은 몇 시간이
    // 걸린다. 한두 파일만 고친 뒤 다시 돌리는 게 실제 사용 패턴이므로 필수에 가깝다.
    prev = incremental ? loadPreviousIndex(dir, { root, exts, subdirs, model: embedder.model() }) : null;

    const files = collectFiles(root, exts.map((e) => e.toLowerCase()), excludes, subdirs);
    state.progress.files = files.length;
    report();

    // Pass 1: chunk + structure (변경되지 않은 파일은 옛 청크를 그대로 씀)
    state.progress.phase = 'chunking';
    const allChunks = [];
    const reuseRow = [];   // allChunks와 같은 길이. 재사용이면 옛 벡터의 행 번호, 아니면 -1
    const classes = [];
    const fileStamps = {};
    for (const f of files) {
      if (state.cancel) throw new Error('cancelled');
      let st;
      try {
        st = fs.statSync(f);
        if (st.size > MAX_FILE_BYTES) continue;
      } catch { continue; }
      const rel = path.relative(root, f).replace(/\\/g, '/');
      const stamp = { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
      const old = prev && prev.files[rel];

      if (old && old.size === stamp.size && old.mtimeMs === stamp.mtimeMs) {
        for (const r of prev.rowsByFile.get(rel) || []) {
          allChunks.push(prev.chunks[r]);
          reuseRow.push(r);
        }
        for (const c of prev.classesByFile.get(rel) || []) classes.push(c);
        state.progress.reused += (prev.rowsByFile.get(rel) || []).length;
      } else {
        let content;
        try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
        const { chunks, lines } = chunkFile(rel, content);
        for (const c of chunks) { allChunks.push(c); reuseRow.push(-1); }
        classes.push(...extractStructure(rel, lines));
      }
      fileStamps[rel] = stamp;
      if (allChunks.length >= maxChunks) break;
    }
    state.progress.chunks = allChunks.length;
    state.progress.total = allChunks.length;
    report();

    // Pass 2: embed in batches, streaming to disk
    state.progress.phase = 'embedding';
    const vecFile = path.join(dir, 'vectors.bin');
    const chunkFileOut = path.join(dir, 'chunks.jsonl');
    // 옛 벡터를 읽으면서 같은 파일에 쓰면 안 되므로 임시 파일에 쓰고 마지막에 바꾼다.
    const vecTmp = `${vecFile}.building`;
    const chunkTmp = `${chunkFileOut}.building`;
    const vecFd = fs.openSync(vecTmp, 'w');
    const chunkFd = fs.openSync(chunkTmp, 'w');
    let dims = prev ? prev.dims : 0;
    try {
      const B = 64;
      for (let i = 0; i < allChunks.length; i += B) {
        if (state.cancel) throw new Error('cancelled');
        const batch = allChunks.slice(i, i + B);
        const rows = reuseRow.slice(i, i + B);
        // 새로 임베딩할 것만 모아서 한 번에 요청한다.
        const fresh = [];
        for (let k = 0; k < batch.length; k++) if (rows[k] < 0) fresh.push(k);
        let vecs = [];
        if (fresh.length) {
          vecs = await embedder.embed(fresh.map((k) => `${batch[k].file}\n${batch[k].text}`), {
            signal: state.controller.signal,
            onAttempt: retry => onProgress && onProgress({ name, ...state.progress, retry }),
          });
        }
        let fi = 0;
        for (let k = 0; k < batch.length; k++) {
          let buf;
          if (rows[k] >= 0) {
            buf = prev.vectorRow(rows[k]);
          } else {
            const vec = vecs[fi++];
            if (dims && vec.length !== dims) throw require('./source-failures').failure('invalid_response', 'Embedding dimensions changed; rebuild with a separate index');
            dims = vec.length;
            buf = Buffer.from(vec.buffer);
          }
          fs.writeSync(vecFd, buf);
          fs.writeSync(chunkFd, JSON.stringify(batch[k]) + '\n');
        }
        state.progress.embedded = Math.min(i + B, allChunks.length);
        report();
      }
    } finally {
      fs.closeSync(vecFd);
      fs.closeSync(chunkFd);
    }
    if (prev) prev.close();
    fs.renameSync(vecTmp, vecFile);
    fs.renameSync(chunkTmp, chunkFileOut);

    // classes: build child map
    fs.writeFileSync(path.join(dir, 'classes.json'), JSON.stringify(classes), 'utf8');
    const meta = {
      name,
      root,
      exts,
      excludes,
      subdirs,
      dims,
      chunkCount: allChunks.length,
      classCount: classes.length,
      embeddingModel: embedder.model(),
      files: fileStamps,
      reusedChunks: state.progress.reused,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    require('./change-signals').emitChanged('codeindex');
    vecCache.delete(name);
    state.progress.phase = 'done';
    report();
    return meta;
  } finally {
    if (prev) prev.close();
    running.delete(name);
    // 실패·취소로 남은 작업 파일 정리 (성공 시에는 이미 rename 되어 없다).
    const d = indexDir(name);
    for (const f of ['vectors.bin.building', 'chunks.jsonl.building']) {
      try { fs.unlinkSync(path.join(d, f)); } catch { /* 없으면 그만 */ }
    }
  }
}

function cancelBuild(name) {
  const s = running.get(name);
  if (s) { s.cancel = true; s.controller.abort(); }
  return Boolean(s);
}

// ---- search -------------------------------------------------------------------

function loadVectors(name) {
  if (vecCache.has(name)) return vecCache.get(name);
  const dir = indexDir(name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const buf = fs.readFileSync(path.join(dir, 'vectors.bin'));
  const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const { dims, chunkCount: n } = meta;
  // Checked once here instead of per row: a short vectors.bin made every later row NaN and ranked garbage silently.
  if (vectors.length < n * dims) throw new Error(`Index "${name}" is inconsistent: ${vectors.length / dims} vectors for ${n} chunks. Rebuild it.`);
  // Row norms once per load (a column beside the vectors). search recomputed all of them on every query — half its
  // cosine work. Float64 and the same summation order as before, so every score is bit-identical.
  const norms = new Float64Array(n);
  for (let c = 0, off = 0; c < n; c++, off += dims) {
    let vn = 0;
    for (let i = 0; i < dims; i++) { const x = vectors[off + i]; vn += x * x; }
    norms[c] = Math.sqrt(vn) || 1;
  }
  const entry = { meta, vectors, norms, chunks: null, files: null };
  vecCache.set(name, entry);
  return entry;
}

function loadChunks(name) {
  const entry = loadVectors(name);
  if (!entry.chunks) {
    const chunks = fs
      .readFileSync(path.join(indexDir(name), 'chunks.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    if (chunks.length < entry.meta.chunkCount) throw new Error(`Index "${name}" is inconsistent: ${chunks.length} chunks for ${entry.meta.chunkCount} vectors. Rebuild it.`);
    // File table: about 9 chunks share each file, so path matches are tested once per file, not once per chunk.
    const ids = new Map();
    const of = Uint32Array.from(chunks, (ch) => { let id = ids.get(ch.file); if (id === undefined) ids.set(ch.file, id = ids.size); return id; });
    entry.files = { lower: [...ids.keys()].map((f) => f.toLowerCase()), of };
    entry.chunks = chunks;
  }
  return entry.chunks;
}

/**
 * 파일 경로에서 UE 모듈("Runtime/Renderer" 등)을 뽑는다. UnrealEngineDeepDive의
 * 계층 모델을 따라 답변·인용에 "어느 층의 코드인지"를 붙이기 위한 것 —
 * 같은 심볼이라도 HAL/Core 층인지 게임플레이 층인지에 따라 설명이 달라진다.
 * UE 트리가 아니면(첫 세그먼트가 Runtime/Developer/Editor/Plugins가 아니면) ''.
 */
function ueModuleOf(relFile) {
  const segs = String(relFile).split('/');
  const i = segs.findIndex((s) => ['Runtime', 'Developer', 'Editor', 'Plugins', 'Programs'].includes(s));
  if (i < 0 || !segs[i + 1]) return '';
  return `${segs[i]}/${segs[i + 1]}`;
}

/** 질의에서 검색어를 뽑는다 — 식별자 위주, 흔한 영어 불용어는 버린다. */
const QUERY_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'how', 'what', 'where', 'does', 'this', 'that', 'from',
  'into', 'when', 'which', 'code', 'function', 'class', 'unreal', 'engine',
]);

function queryTerms(query) {
  const raw = String(query).match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [];
  const terms = new Set();
  for (const t of raw) {
    if (QUERY_STOPWORDS.has(t.toLowerCase())) continue;
    terms.add(t);
    // FSceneRenderer -> FScene, Renderer 로 쪼개고, UE 타입 접두사(F/A/U/I/T/E/S)를
    // 떼어 Scene 으로도 걸리게 한다. 접두사는 규약일 뿐 의미가 없다.
    for (const part of t.split(/(?<=[a-z0-9])(?=[A-Z])|_/)) {
      const stripped = /^[FAUITES][A-Z]/.test(part) ? part.slice(1) : part;
      for (const p of new Set([part, stripped])) {
        if (p.length >= 3 && !QUERY_STOPWORDS.has(p.toLowerCase())) terms.add(p);
      }
    }
  }
  return [...terms];
}

/**
 * 하이브리드 검색 — 의미(임베딩) + 키워드/심볼 일치.
 *
 * 임베딩만 쓰면 `FSceneRenderer::Render` 같은 정확한 심볼을 물어봐도 "비슷한 느낌"의
 * 청크가 올라온다. UE 코드는 고유한 심볼 이름이 많아서 정확 일치에 가산점을 주면
 * 근거 품질이 확 올라간다. 파일 경로 일치도 신호로 쓴다.
 *
 * @param {number} maxPerFile 한 파일에서 최대 몇 청크까지 뽑을지(다양성 확보).
 */
async function search(name, query, topK = 8, { maxPerFile = 3, keywordWeight = 0.3 } = {}) {
  const entry = loadVectors(name);
  const { dims } = entry.meta;
  const [q] = await embedder.embed([query]);
  const n = entry.meta.chunkCount;
  const v = entry.vectors;

  let qn = 0;
  for (let i = 0; i < dims; i++) qn += q[i] * q[i];
  qn = Math.sqrt(qn) || 1;

  const { norms } = entry;
  const cos = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    let dot = 0;
    const off = c * dims;
    for (let i = 0; i < dims; i++) dot += q[i] * v[off + i];
    cos[c] = dot / (qn * norms[c]);
  }

  const chunks = loadChunks(name);
  const terms = queryTerms(query);
  const kw = new Float32Array(n);
  if (terms.length) {
    // 청크 텍스트를 한 번씩 훑는다. 청크 수가 많아도 문자열 검색이라 충분히 빠르고,
    // 미리 역색인을 만드는 것보다 인덱스 포맷을 건드리지 않아 안전하다.
    // (텍스트를 한 문자열로 이어 indexOf로 건너뛰는 안은 실측에서 더 느렸다 — T1 기록.)
    const lowered = terms.map((t) => t.toLowerCase());
    const { files } = entry;
    const fileHits = new Uint8Array(files.lower.length); // 경로 일치도 신호 — 파일마다 한 번
    for (let f = 0; f < fileHits.length; f++) {
      for (let t = 0; t < terms.length; t++) if (files.lower[f].includes(lowered[t])) fileHits[f]++;
    }
    for (let c = 0; c < n; c++) {
      const text = chunks[c].text;
      const lower = text.toLowerCase();
      let hit = fileHits[files.of[c]];
      // 검색어는 ASCII 식별자라 대소문자 일치는 소문자 일치를 함의한다 — 소문자로 없으면 정확 일치 검사를 건너뛴다.
      for (let t = 0; t < terms.length; t++) {
        if (lower.includes(lowered[t])) hit += text.includes(terms[t]) ? 2 : 1; // 대소문자까지 일치 = 심볼일 가능성
      }
      kw[c] = hit / (terms.length * 3); // 0..1로 정규화
    }
  }

  // 점수 열 + 색인 정렬: 청크마다 객체를 만들던 것과 같은 순서(동점은 앞 청크 먼저 = 안정 정렬).
  const score = new Float64Array(n);
  for (let c = 0; c < n; c++) score[c] = (1 - keywordWeight) * cos[c] + keywordWeight * kw[c];
  const ranked = new Uint32Array(n);
  for (let c = 0; c < n; c++) ranked[c] = c;
  ranked.sort((a, b) => score[b] - score[a] || a - b);

  // 같은 파일에서 연달아 뽑히면 프롬프트 예산만 먹고 시야는 좁아진다.
  const want = Math.min(topK, 30);
  const perFile = new Map();
  const picked = [];
  for (const c of ranked) {
    if (picked.length >= want) break;
    const f = chunks[c].file;
    const used = perFile.get(f) || 0;
    if (used >= maxPerFile) continue;
    perFile.set(f, used + 1);
    picked.push(c);
  }
  // 다양성 제한 탓에 개수가 모자라면 남은 것으로 채운다.
  if (picked.length < want) {
    const chosen = new Set(picked);
    for (const c of ranked) {
      if (picked.length >= want) break;
      if (!chosen.has(c)) picked.push(c);
    }
  }

  return picked.map((c) => ({
    score: Math.round(score[c] * 1000) / 1000,
    semantic: Math.round(cos[c] * 1000) / 1000,
    keyword: Math.round(kw[c] * 1000) / 1000,
    file: chunks[c].file,
    module: ueModuleOf(chunks[c].file),
    startLine: chunks[c].startLine,
    endLine: chunks[c].endLine,
    text: chunks[c].text,
  }));
}

/** Read a slice of an indexed source file (path restricted to the index root). */
function readSource(name, relFile, startLine = 1, endLine = 200) {
  const { meta } = loadVectors(name);
  const abs = path.resolve(meta.root, relFile);
  if (!abs.startsWith(path.resolve(meta.root) + path.sep)) throw new Error('Path outside index root.');
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const s = Math.max(1, startLine);
  const e = Math.min(lines.length, Math.min(endLine, s + 400));
  return { file: relFile, startLine: s, endLine: e, text: lines.slice(s - 1, e).join('\n') };
}

/** Look up UE class/struct info by name (exact or suffix match). */
function classInfo(name, className) {
  const dir = indexDir(name);
  const classes = JSON.parse(fs.readFileSync(path.join(dir, 'classes.json'), 'utf8'));
  const exact = classes.filter((c) => c.name === className);
  const fuzzy = exact.length ? exact : classes.filter((c) => c.name.toLowerCase().includes(className.toLowerCase())).slice(0, 10);
  const children = classes.filter((c) => c.parents.some((p) => p === className)).map((c) => c.name).slice(0, 50);
  return { matches: fuzzy.map((c) => ({ ...c, module: ueModuleOf(c.file) })), children };
}

function deleteIndex(name) {
  const dir = indexDir(name);
  vecCache.delete(name);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  return listIndexes();
}

/**
 * Detect Unreal Engine source roots on this machine.
 * 런처 설치 기록(LauncherInstalled.dat)과 레지스트리(소스 빌드)를 우선한다 —
 * 설치 드라이브가 컴퓨터마다 달라도 찾는다. 고정 경로 스캔은 보조 수단.
 */
async function detectUnrealRoots() {
  const found = [];
  const add = (label, src) => {
    if (fs.existsSync(src) && !found.some((f) => path.resolve(f.path) === path.resolve(src))) {
      found.push({ label, path: src });
    }
  };
  try {
    const projects = require('./projects'); // lazy: projects는 codeindex를 모른다
    for (const e of await projects.detectUnrealEngines()) {
      add(`UE_${e.version}`, path.join(e.installLocation, 'Engine', 'Source'));
    }
  } catch { /* 감지 실패 — 고정 경로 스캔으로 진행 */ }
  const bases = ['C:\\Program Files\\Epic Games', 'D:\\Epic Games', 'D:\\Program Files\\Epic Games', 'C:\\Epic Games'];
  for (const base of bases) {
    try {
      for (const d of fs.readdirSync(base)) {
        if (/^UE_/.test(d)) add(d, path.join(base, d, 'Engine', 'Source'));
      }
    } catch { /* base absent */ }
  }
  return found;
}

module.exports = {
  listIndexes, buildIndex, cancelBuild, search, readSource, classInfo, deleteIndex, detectUnrealRoots,
  INDEX_ROOT, EXT_PRESETS, chunkFile, queryTerms, ueModuleOf,
};

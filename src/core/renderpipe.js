// Rendering-pipeline analysis (UE-focused): statically scans a renderer
// source tree for the markers that define the frame pipeline —
//   RDG passes        GraphBuilder.AddPass / RDG_EVENT_NAME("...")
//   global shaders    IMPLEMENT_GLOBAL_SHADER / IMPLEMENT_SHADER_TYPE / ..._MATERIAL_...
//   GPU stats         DECLARE_GPU_STAT(_NAMED) / RDG_GPU_STAT_SCOPE
//   draw events       SCOPED_DRAW_EVENT(_F)
//   renderer entries  void F*SceneRenderer::Render*(...)
// The result is a "render map" (JSON, per scan name) that the GUI lists and
// the local model uses as grounded context to explain how a pass/feature
// flows through the pipeline. Plain C++ trees work too — UE macros just
// won't match. Everything is local; no model needed for the scan itself.
'use strict';

const fs = require('fs');
const path = require('path');
const { hubDataDir } = require('./paths');

const MAP_DIR = path.join(hubDataDir(), 'renderpipe');
const EXTS = ['.h', '.cpp', '.inl', '.usf', '.ush'];
const MAX_FILES = 12000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PER_CATEGORY = 4000;

const CATEGORIES = ['rdgPasses', 'shaders', 'gpuStats', 'drawEvents', 'rendererFuncs'];

const PATTERNS = {
  rdgPasses: [
    /RDG_EVENT_NAME\(\s*"([^"]{1,120})"/,
  ],
  shaders: [
    /IMPLEMENT_GLOBAL_SHADER\(\s*(\w+)/,
    /IMPLEMENT_SHADER_TYPE\([^,]*,\s*(\w+)/,
    /IMPLEMENT_MATERIAL_SHADER_TYPE\([^,]*,\s*(\w+)/,
  ],
  gpuStats: [
    // DRAWCALL/_EXTERN variants and DEFINE_* (the .cpp that owns the pass) carry names such as ShadowDepths.
    /DECLARE_GPU_\w*STAT\w*\(\s*(\w+)/,
    /DEFINE_GPU_\w*STAT\(\s*(\w+)/,
    /RDG_GPU_STAT_SCOPE\(\s*\w+\s*,\s*(\w+)/,
  ],
  drawEvents: [
    /SCOPED_DRAW_EVENTF?\(\s*\w+\s*,\s*(\w+)/,
  ],
  rendererFuncs: [
    /void\s+(F\w*Renderer)::(Render\w+)\s*\(/,
  ],
};

function mapFile(name) {
  if (!/^[\w-]{1,64}$/.test(name)) throw new Error('스캔 이름은 영문/숫자/대시/밑줄만 가능합니다.');
  return path.join(MAP_DIR, `${name}.json`);
}

// 트리 순회는 symbolmap과 같다(제외 폴더 동일) — 렌더 맵은 파일 상한만 작다.
const collectFiles = (root) => require('./symbolmap').collectFiles(root, EXTS, MAX_FILES);

/** Scan a source tree and build the render map. Pure regex — fast, no model. */
function scan(name, root) {
  root = path.resolve(String(root));
  if (!fs.existsSync(root)) throw new Error(`경로가 존재하지 않습니다: ${root}`);
  const files = collectFiles(root);
  if (!files.length) throw new Error('스캔할 소스 파일(.h/.cpp/.usf/.ush)이 없습니다.');

  const map = { rdgPasses: [], shaders: [], gpuStats: [], drawEvents: [], rendererFuncs: [] };
  const seen = { rdgPasses: new Set(), shaders: new Set(), gpuStats: new Set(), drawEvents: new Set(), rendererFuncs: new Set() };
  let shaderFileCount = 0;

  for (const f of files) {
    let text;
    try {
      if (fs.statSync(f).size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(f, 'utf8');
    } catch { continue; }
    const ext = path.extname(f).toLowerCase();
    if (ext === '.usf' || ext === '.ush') shaderFileCount++;
    const rel = path.relative(root, f).replace(/\\/g, '/');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 500) continue;
      for (const cat of CATEGORIES) {
        if (map[cat].length >= MAX_PER_CATEGORY) continue;
        for (const re of PATTERNS[cat]) {
          const m = line.match(re);
          if (!m) continue;
          const label = cat === 'rendererFuncs' ? `${m[1]}::${m[2]}` : m[1];
          const key = `${label}|${rel}`;
          if (seen[cat].has(key)) continue;
          seen[cat].add(key);
          map[cat].push({ name: label, file: rel, line: i + 1 });
          break;
        }
      }
    }
  }

  const doc = {
    name,
    root,
    scannedAt: new Date().toISOString(),
    fileCount: files.length,
    shaderFileCount,
    counts: Object.fromEntries(CATEGORIES.map((c) => [c, map[c].length])),
    ...map,
  };
  fs.mkdirSync(MAP_DIR, { recursive: true });
  fs.writeFileSync(mapFile(name), JSON.stringify(doc), 'utf8');
  require('./change-signals').emitChanged('renderpipe');
  return summarize(doc);
}

function summarize(doc) {
  return {
    name: doc.name, root: doc.root, scannedAt: doc.scannedAt,
    fileCount: doc.fileCount, shaderFileCount: doc.shaderFileCount, counts: doc.counts,
  };
}

function list() {
  try {
    return fs.readdirSync(MAP_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try { return summarize(JSON.parse(fs.readFileSync(path.join(MAP_DIR, f), 'utf8'))); } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
  } catch {
    return [];
  }
}

function load(name) {
  return JSON.parse(fs.readFileSync(mapFile(name), 'utf8'));
}

function removeMap(name) {
  try { fs.unlinkSync(mapFile(name)); } catch { /* absent */ }
  return list();
}

/** Filter map entries by keyword (case-insensitive), across categories. */
function query(name, filter, limitPerCat = 40) {
  const doc = load(name);
  const f = String(filter || '').toLowerCase();
  const out = {};
  for (const cat of CATEGORIES) {
    const items = f
      ? doc[cat].filter((x) => x.name.toLowerCase().includes(f) || x.file.toLowerCase().includes(f))
      : doc[cat];
    out[cat] = { total: items.length, items: items.slice(0, limitPerCat) };
  }
  return { name: doc.name, root: doc.root, filter: filter || '', categories: out };
}

/**
 * Explain how a pass/feature flows through the pipeline: grounded in the
 * render map (+ source index RAG when available), answered by a local model.
 */
async function analyze(name, topic, { index, save = false, model } = {}) {
  // Budget the prompt against the target model's real context window
  // (~3 chars/token; leave room for the answer). Small local models are
  // commonly loaded at 4k, so an unbudgeted map + excerpts would 400.
  const { chars: budgetChars, maxTokens } = await require('./lmstudio').promptBudget(model);
  const mapBudget = Math.floor(budgetChars * 0.4);
  const codeBudget = budgetChars - mapBudget;

  const perCat = budgetChars < 5000 ? 8 : 24;
  const q = query(name, topic, perCat);
  const parts = [];
  const catLabel = {
    rdgPasses: 'RDG 패스', shaders: '셰이더', gpuStats: 'GPU 스탯',
    drawEvents: '드로우 이벤트', rendererFuncs: '렌더러 함수',
  };
  let mapUsed = 0;
  for (const cat of CATEGORIES) {
    const c = q.categories[cat];
    if (!c.items.length) continue;
    const block = `### ${catLabel[cat]} (${c.total}건 중 ${c.items.length})\n` +
      c.items.map((x) => `- ${x.name} — ${x.file}:${x.line}`).join('\n');
    if (mapUsed + block.length > mapBudget) {
      const room = Math.max(0, mapBudget - mapUsed);
      if (room > 200) { parts.push(block.slice(0, room) + '\n...(생략)'); mapUsed = mapBudget; }
      break;
    }
    parts.push(block);
    mapUsed += block.length;
  }
  if (!parts.length) {
    return { answer: `렌더링 맵 "${name}"에서 "${topic}" 관련 항목을 찾지 못했습니다. 다른 키워드(예: BasePass, Shadow, Lumen, PostProcess)로 시도해 보세요.`, sources: [], mapHits: 0 };
  }

  // Ground the answer in real code: read source straight from the scanned
  // tree around the strongest hits (renderer entry functions first, then RDG
  // pass sites). No embedding index required.
  let codeBlock = '';
  const sources = [];
  const doc = load(name);
  const maxPicks = codeBudget < 3000 ? 1 : (codeBudget < 8000 ? 2 : 3);
  const perPick = Math.max(800, Math.floor(codeBudget / maxPicks) - 200);
  const picks = [
    ...q.categories.rendererFuncs.items.slice(0, 2),
    ...q.categories.rdgPasses.items.slice(0, 2),
  ].slice(0, maxPicks);
  for (const p of picks) {
    try {
      const abs = path.resolve(doc.root, p.file);
      if (!abs.startsWith(path.resolve(doc.root) + path.sep)) continue; // stay inside the scanned tree
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      const s = Math.max(0, p.line - 3);
      const e = Math.min(lines.length, p.line + 70);
      codeBlock += `\n\n### ${p.name} — ${p.file}:${p.line}\n\`\`\`cpp\n${lines.slice(s, e).join('\n').slice(0, perPick)}\n\`\`\``;
      sources.push({ file: p.file, startLine: s + 1, endLine: e });
    } catch { /* file unreadable — skip */ }
  }
  if (codeBlock) codeBlock = '\n\n## 실제 소스 발췌' + codeBlock;

  // Optional extra RAG from a semantic source index — only when the context
  // budget still has room after the direct source excerpts
  const roomLeft = codeBudget - codeBlock.length;
  if (roomLeft > 1500) {
    try {
      const codeindex = require('./codeindex');
      const indexes = codeindex.listIndexes();
      const idxName = index && indexes.some((i) => i.name === index) ? index : (indexes[0] && indexes[0].name);
      if (idxName) {
        const hits = (await codeindex.search(idxName, `rendering pipeline ${topic}`, 3)).filter((h) => h.score > 0.45);
        if (hits.length) {
          const per = Math.floor(roomLeft / hits.length) - 120;
          codeBlock += '\n\n## 인덱스 검색 발췌 (' + idxName + ')\n' +
            hits.map((h, i) => `[${i + 1}] ${h.file}:${h.startLine}-${h.endLine}\n\`\`\`cpp\n${h.text.slice(0, per)}\n\`\`\``).join('\n');
          sources.push(...hits.map((h) => ({ file: h.file, startLine: h.startLine, endLine: h.endLine, score: h.score })));
        }
      }
    } catch { /* index optional */ }
  }

  const delegator = require('./delegator'); // lazy: avoid startup cycles
  // taskType 'custom': the gamedev skill preamble tells models to escalate on
  // uncertainty, which is wrong for a tutoring/explanation task
  const r = await delegator.delegate({
    taskType: 'custom',
    model: model || undefined,
    maxTokens,
    temperature: 0.2,
    noMemory: true, // context is already curated below; see delegator
    systemPrompt:
      'You are an Unreal Engine rendering-pipeline tutor. Answer in Korean. ' +
      'Using the render-map entries (pass/shader/stat/event/function names with file:line) and any code excerpts, ' +
      'explain how the asked feature flows through the frame: which renderer functions drive it, which RDG passes ' +
      'and shaders it uses, and in what order. Cite file:line for every claim. ' +
      'If something is not in the provided data, say so instead of guessing.',
    // Instruction last: small local models otherwise echo the data block back
    // instead of answering.
    prompt:
      `## 렌더링 맵 발췌 (스캔: ${name})\n${parts.join('\n\n')}${codeBlock}\n\n` +
      `---\n위 자료만 근거로, Unreal Engine에서 **${topic}**이 한 프레임 동안 어떻게 처리되는지 한국어로 설명해줘.\n` +
      `순서: (1) 어떤 렌더러 함수가 시작점인지 (2) 어떤 RDG 패스와 셰이더를 거치는지 (3) 실행 순서와 역할.\n` +
      `모든 주장에 file:line을 붙이고, 자료에 없는 내용은 "자료에 없음"이라고 밝혀. 자료를 그대로 나열하지 말고 설명해줘.`,
  });

  const result = { answer: r.content, model: r.model, sources, mapHits: CATEGORIES.reduce((n, c) => n + q.categories[c].total, 0) };
  if (save) {
    try {
      const memory = require('./memory');
      const saved = await memory.save(
        `[렌더링 분석 ${name}] 주제: ${topic}\n${r.content.slice(0, 3200)}`,
        { type: 'note', tags: ['learning', 'rendering', name], source: 'render-analyze' }
      );
      result.savedMemoryId = saved.id;
    } catch { /* memory best-effort */ }
  }
  return result;
}

/**
 * Suggest scan roots from detected UE installs.
 * 런처 기록/레지스트리 기반 감지를 쓰므로 설치 드라이브가 컴퓨터마다 달라도 찾는다.
 * Renderer(C++ 패스·셰이더 등록)와 Shaders(.usf/.ush 본문)를 각각 제안한다 —
 * 한 스캔은 루트 하나만 받으므로 셰이더 분석은 별도 스캔이 필요하다.
 */
async function suggestRoots() {
  const out = [];
  const add = (verLabel, sub, subLabel, dir) => {
    if (!fs.existsSync(dir)) return;
    if (out.some((o) => path.resolve(o.path) === path.resolve(dir))) return;
    out.push({
      label: `${verLabel} ${subLabel}`,
      path: dir,
      name: `${verLabel.toLowerCase().replace(/[^\w-]/g, '-')}-${sub}`,
    });
  };
  const roots = [];
  try {
    const projects = require('./projects'); // lazy: projects는 renderpipe를 모른다
    for (const e of await projects.detectUnrealEngines()) roots.push({ label: `UE_${e.version}`, base: e.installLocation });
  } catch { /* 감지 실패 — 고정 경로 스캔으로 진행 */ }
  const bases = ['C:\\Program Files\\Epic Games', 'D:\\Epic Games', 'D:\\Program Files\\Epic Games', 'C:\\Epic Games'];
  for (const base of bases) {
    try {
      for (const d of fs.readdirSync(base)) {
        if (/^UE_/.test(d) && !roots.some((r) => r.label === d)) roots.push({ label: d, base: path.join(base, d) });
      }
    } catch { /* base absent */ }
  }
  for (const r of roots) {
    add(r.label, 'renderer', 'Renderer', path.join(r.base, 'Engine', 'Source', 'Runtime', 'Renderer'));
    add(r.label, 'shaders', 'Shaders (.usf/.ush)', path.join(r.base, 'Engine', 'Shaders'));
  }
  return out;
}

module.exports = { scan, list, load, query, analyze, removeMap, suggestRoots, CATEGORIES, MAP_DIR };

// Engine analysis on top of the structural graphs: the symbol/cvar/render maps choose the files for a topic,
// Graphify builds the call/reference graph, and every node gets engine coordinates (module, class, the cvars and
// GPU stats declared in its file). Binary graphs of engine DLLs (PDB symbols) are linked back to source the same way.
'use strict';
const fs = require('fs');
const path = require('path');
const symbolmap = require('./symbolmap');

const SKIP = new Set(['Intermediate', 'Binaries', 'ThirdParty', 'DerivedDataCache', '.git']);

function moduleRoot(rel) {
  const segs = rel.split('/'), i = segs.findIndex((s) => ['Runtime', 'Developer', 'Editor', 'Plugins', 'Programs'].includes(s));
  return i >= 0 ? segs.slice(0, i + 2).join('/') : segs.slice(0, 2).join('/');
}

// stem → relative .cpp paths, per module, read once per call.
function cppIndex(root, modules) {
  const index = new Map();
  for (const mod of modules) {
    const stack = [path.join(root, mod)];
    let seen = 0;
    while (stack.length && seen < 20000) {
      let entries;
      try { entries = fs.readdirSync(stack.pop(), { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(e.parentPath || e.path, e.name);
        if (e.isDirectory()) { if (!SKIP.has(e.name)) stack.push(full); continue; }
        if (!/\.cpp$/i.test(e.name)) continue;
        seen++;
        const stem = e.name.slice(0, -4).toLowerCase();
        (index.get(stem) || index.set(stem, []).get(stem)).push(path.relative(root, full).replace(/\\/g, '/'));
      }
    }
  }
  return index;
}

/** Files for an engine topic, highest evidence first, within the source-graph limits (200 files, 20 MiB). */
function scope(mapName, topic, { renderMap = null, maxFiles = 200, maxBytes = 20 * 1024 ** 2 } = {}) {
  // Compare without separators so "LumenReflection" meets r.Lumen.Reflections.* and "Lumen Reflections" passes.
  const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''), q = flat(topic);
  if (q.length < 3) throw new Error('topic_too_short');
  const doc = symbolmap.load(mapName), root = doc.root;
  const weight = new Map(), add = (rel, w) => weight.set(rel, (weight.get(rel) || 0) + w);
  for (const s of doc.symbols) if (flat(s.n).includes(q)) add(s.f, 3);
  for (const c of doc.cvars || []) if (flat(c.n).includes(q) && !c.f.startsWith('..')) add(c.f, 2);
  if (renderMap) {
    const rm = require('./renderpipe').load(renderMap), prefix = path.relative(root, rm.root).replace(/\\/g, '/');
    for (const cat of ['gpuStats', 'rdgPasses']) for (const e of rm[cat] || [])
      if (flat(e.name).includes(q)) add(prefix ? `${prefix}/${e.file}` : e.file, 2);
  }
  const headers = [...weight.keys()].filter((f) => /\.h$/i.test(f));
  const index = cppIndex(root, [...new Set(headers.map(moduleRoot))]);
  for (const h of headers) for (const cpp of index.get(path.basename(h, '.h').toLowerCase()) || []) add(cpp, 1);
  const picked = []; let bytes = 0;
  for (const [rel] of [...weight].sort((a, b) => b[1] - a[1])) {
    if (picked.length >= maxFiles) break;
    let size;
    try { size = fs.statSync(path.join(root, rel)).size; } catch { continue; }
    if (size > 1024 ** 2 || bytes + size > maxBytes) continue;
    bytes += size; picked.push(rel);
  }
  return { root, paths: picked, bytes, candidates: weight.size, truncated: picked.length < weight.size };
}

function fileFacts(mapName, renderMap) {
  const doc = symbolmap.load(mapName), byFile = new Map();
  const at = (rel) => byFile.get(rel) || byFile.set(rel, { cvars: [], gpuStats: [] }).get(rel);
  for (const c of doc.cvars || []) if (c.k !== 'command') at(c.f).cvars.push(c.n);
  if (renderMap) {
    const rm = require('./renderpipe').load(renderMap), prefix = path.relative(doc.root, rm.root).replace(/\\/g, '/');
    for (const e of rm.gpuStats || []) at(prefix ? `${prefix}/${e.file}` : e.file).gpuStats.push(e.name);
  }
  const classes = new Map();
  for (const s of doc.symbols) if (!classes.has(s.n) || s.k !== 'class') classes.set(s.n, s);
  return { doc, byFile, classes };
}

/** Adds `engine` coordinates to source-graph nodes (in place). */
function enrichSource(graphDoc, mapName, renderMap) {
  const { byFile, classes } = fileFacts(mapName, renderMap);
  let linked = 0;
  for (const n of graphDoc.nodes) {
    const rel = String(n.source_file || '').replace(/\\/g, '/');
    const facts = byFile.get(rel), owner = classes.get(String(n.label || '').split(/::|\.|\(/)[0]);
    if (!facts && !owner) continue;
    linked++;
    n.engine = { module: symbolmap.moduleOf(rel) || null, ...(facts ? { cvars: [...new Set(facts.cvars)].slice(0, 8), gpuStats: [...new Set(facts.gpuStats)].slice(0, 8) } : {}),
      ...(owner ? { class: { name: owner.n, kind: owner.k, parents: owner.p, at: `${owner.f}:${owner.l}` } } : {}) };
  }
  graphDoc.engineMap = { symbols: mapName, render: renderMap || null, linkedNodes: linked };
  return graphDoc;
}

/** Binary graphs of engine DLLs: PDB names (FClass::Method) → the declaring class and its module in source. */
function enrichBinary(graphDoc, mapName) {
  const { classes } = fileFacts(mapName, null);
  let linked = 0;
  for (const n of graphDoc.nodes) {
    if (n.type !== 'function') continue;
    const parts = String(n.label || '').split('::'), owner = parts.length > 1 ? classes.get(parts[parts.length - 2]) : null;
    if (!owner) continue;
    linked++;
    n.engine = { class: { name: owner.n, kind: owner.k, at: `${owner.f}:${owner.l}` }, module: owner.m };
  }
  graphDoc.engineMap = { symbols: mapName, linkedNodes: linked };
  return graphDoc;
}

/** Where `FClass::Method` is defined in source, scanning only the class's module (bounded). */
function findDefinition(mapName, qualified) {
  const parts = String(qualified).split('::');
  if (parts.length < 2) return null;
  const doc = symbolmap.load(mapName), owner = doc.symbols.find((s) => s.n === parts[parts.length - 2]);
  if (!owner) return null;
  const needle = new RegExp(`\\b${parts.slice(-2).join('::').replace(/[^\w:~]/g, '')}\\s*\\(`);
  const index = cppIndex(doc.root, [moduleRoot(owner.f)]);
  for (const list of index.values()) for (const rel of list) {
    let text;
    try { text = fs.readFileSync(path.join(doc.root, rel), 'utf8'); } catch { continue; }
    const m = needle.exec(text);
    if (m) return { file: rel, line: text.slice(0, m.index).split('\n').length, class: `${owner.f}:${owner.l}` };
  }
  // Inline members (common in UE headers) are compiled into every module that uses them: look in the class body.
  try {
    const lines = fs.readFileSync(path.join(doc.root, owner.f), 'utf8').split('\n');
    const member = new RegExp(`\\b${parts[parts.length - 1].replace(/[^\w~]/g, '')}\\s*\\(`);
    for (let i = owner.l - 1; i < lines.length; i++) if (member.test(lines[i])) return { file: owner.f, line: i + 1, inline: true, class: `${owner.f}:${owner.l}` };
  } catch { /* header moved: class location is still returned */ }
  return { file: null, class: `${owner.f}:${owner.l}` };
}

/** The engine install a binary belongs to, matched against symbol-map roots (<install>/Engine/Source). */
function mapForBinary(binaryPath) {
  const p = path.resolve(String(binaryPath)).toLowerCase();
  return symbolmap.list().find((m) => p.startsWith(path.resolve(m.root, '..').toLowerCase() + path.sep)) || null;
}

module.exports = { scope, enrichSource, enrichBinary, findDefinition, mapForBinary, moduleRoot };

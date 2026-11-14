// UE console variables as tuning coordinates: name, default, help, flags, file:line, scalability levels, project overrides.
// Measured on UE 5.8 Engine/Source: 30k files in ~11 s, 8.4k variables/commands, 97% of defaults resolved.
'use strict';

const fs = require('fs');
const path = require('path');

const EXCLUDES = new Set(['Intermediate', 'Binaries', 'DerivedDataCache', '.git', 'node_modules', 'ThirdParty']);
const CTOR_RE = /\b(TAutoConsoleVariable\s*<\s*([\w:]+)\s*>|FAutoConsoleVariableRef|FAutoConsoleVariable|FAutoConsoleCommand\w*|RegisterConsoleVariable(?:Ref)?)\s*(?:\w+\s*)?\(/g;
const LEVELS = ['0', '1', '2', '3', 'Cine'];

function sourceFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!EXCLUDES.has(e.name)) sourceFiles(full, out); }
    else if (/\.(cpp|h|inl)$/i.test(e.name)) out.push(full);
  }
  return out;
}

// Top-level comma split of one call's arguments; strings and comments may contain commas or parens.
function callArgs(text, open) {
  const out = []; let depth = 0, cur = '';
  for (let i = open; i < text.length && i - open < 20000; i++) {
    const c = text[i], n = text[i + 1];
    if (c === '/' && n === '/') { const e = text.indexOf('\n', i); i = e < 0 ? text.length : e; continue; }
    if (c === '/' && n === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 1; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1; while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      cur += text.slice(i, j + 1); i = j; continue;
    }
    if (c === '(') { if (depth++ > 0) cur += c; continue; }
    if (c === ')') { if (--depth === 0) { out.push(cur.trim()); return out; } cur += c; continue; }
    if (c === ',' && depth === 1) { out.push(cur.trim()); cur = ''; continue; }
    if (depth >= 1) cur += c;
  }
  return null;
}

const literal = (s) => [...String(s || '').matchAll(/TEXT\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)|"((?:[^"\\]|\\.)*)"/g)]
  .map((m) => m[1] ?? m[2]).join('').replace(/\\n/g, '\n').replace(/\\t/g, ' ').replace(/\\"/g, '"');

/** Variables and commands declared in one source file. */
function cvarsInFile(rel, text) {
  if (!/ConsoleVariable|ConsoleCommand/.test(text)) return [];
  const out = [];
  let lineStarts = null;
  const lineOf = (index) => {
    if (!lineStarts) { lineStarts = [0]; for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1); }
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= index) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  for (const m of text.matchAll(CTOR_RE)) {
    const args = callArgs(text, m.index + m[0].length - 1);
    if (!args || !args.length) continue;
    const name = literal(args[0]);
    if (!/^[A-Za-z][\w.]*\.[\w.]+$/.test(name)) continue; // names built at runtime are not coordinates
    const kind = /Command/.test(m[1]) ? 'command' : /Ref/.test(m[1]) ? 'ref' : 'var';
    let type = m[2] || null, def = kind === 'command' ? null : (args[1] || null);
    if (kind === 'ref' && def) {
      const v = def.replace(/^&/, '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const d = text.match(new RegExp(`(?:^|\\n)\\s*(?:static\\s+)?(?:const\\s+)?([\\w:<>]+)\\s+${v}\\s*=\\s*([^;]+);`));
      if (d) { type = d[1]; def = d[2].trim(); } else def = null;
    }
    out.push({ n: name, k: kind, ty: type, d: def && def.length > 80 ? `${def.slice(0, 80)}…` : def,
      h: literal(kind === 'command' ? args[1] : args[2]).slice(0, 400),
      fl: [...new Set(args.join(' ').match(/ECVF_\w+/g) || [])].map((f) => f.slice(5)), f: rel, l: lineOf(m.index) });
  }
  return out;
}

/** [Group@Level] sections of BaseScalability.ini → { cvarLower: { 'Group@Level': value } }. */
function parseScalability(text) {
  const out = {}; let section = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const s = raw.match(/^\[(\w+)@(\w+)\]/);
    if (s) { section = `${s[1]}@${s[2]}`; continue; }
    if (/^\[/.test(raw)) { section = null; continue; }
    const kv = raw.match(/^([A-Za-z][\w.]*)=(.*)$/);
    if (section && kv) (out[kv[1].toLowerCase()] ||= {})[section] = kv[2].trim();
  }
  return out;
}

/** cvar=value lines from a project's Config/*.ini (sections that apply cvars directly). */
function projectOverrides(projectFile) {
  const dir = path.join(path.dirname(String(projectFile)), 'Config'), out = {};
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.ini$/i.test(n)); } catch { return out; }
  for (const name of names) {
    let section = null, text = '';
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    text.split(/\r?\n/).forEach((raw, i) => {
      const s = raw.match(/^\[(.+)\]\s*$/);
      if (s) { section = s[1]; return; }
      const kv = raw.match(/^\+?([A-Za-z][\w]*\.[\w.]+)=(.*)$/);
      if (kv && section && /^(SystemSettings|ConsoleVariables|\/Script\/Engine\.RendererSettings|\w+@\w+)$/.test(section))
        (out[kv[1].toLowerCase()] ||= []).push({ value: kv[2].trim(), file: `Config/${name}`, line: i + 1, section });
    });
  }
  return out;
}

/** Scan an engine Source root (+ sibling Plugins and Config) — called from symbolmap.scan. */
function scan(sourceRoot, onProgress) {
  const engine = path.dirname(sourceRoot);
  const files = sourceFiles(sourceRoot);
  const plugins = path.join(engine, 'Plugins');
  if (fs.existsSync(plugins)) sourceFiles(plugins, files);
  const cvars = [];
  files.forEach((abs, i) => {
    if (onProgress && i % 5000 === 0) onProgress({ phase: 'cvars', done: i, total: files.length });
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { return; }
    const rel = path.relative(sourceRoot, abs).replace(/\\/g, '/');
    for (const c of cvarsInFile(rel, text)) cvars.push(c);
  });
  let scalability = {};
  try { scalability = parseScalability(fs.readFileSync(path.join(engine, 'Config', 'BaseScalability.ini'), 'utf8')); } catch { /* not an engine tree */ }
  return { cvars, scalability, cvarFileCount: files.length };
}

// "LumenReflections" / "r.Lumen.Reflections.Allow" → ['lumen','reflections'] / ['lumen','reflections','allow'].
const tokens = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);

function view(doc, c, overrides) {
  const key = c.n.toLowerCase(), levels = doc.scalability?.[key];
  return { name: c.n, kind: c.k, type: c.ty, default: c.d, help: c.h, flags: c.fl, file: c.f, line: c.l,
    scalability: levels ? Object.fromEntries(Object.entries(levels).sort(([a], [b]) => LEVELS.indexOf(a.split('@')[1]) - LEVELS.indexOf(b.split('@')[1]))) : null,
    project: overrides?.[key] || null };
}

/**
 * Find tuning knobs. Matches cvar names, then help text; with a render map, GPU stats / RDG passes / draw events
 * matching the query pull in the cvars declared in the same files (the pass's own knobs).
 */
function find(doc, query, { limit = 20, scalabilityOnly = false, renderMap = null, project = null } = {}) {
  if (!Array.isArray(doc.cvars)) return { error: 'map_has_no_cvars_rescan_required' };
  const q = String(query || '').toLowerCase().trim();
  const overrides = project ? projectOverrides(project) : null;
  const ok = (c) => c.k !== 'command' && (!scalabilityOnly || c.fl.includes('Scalability') || doc.scalability?.[c.n.toLowerCase()]);
  const words = q.split(/\s+/).filter((w) => w.length > 2);
  const scored = [];
  for (const c of doc.cvars) {
    if (!ok(c)) continue;
    const n = c.n.toLowerCase(), h = c.h.toLowerCase();
    const score = n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : words.length && words.every((w) => n.includes(w) || h.includes(w)) ? 3 : -1;
    if (score >= 0) scored.push({ score, c, via: score < 3 ? 'name' : 'help' });
  }
  const passes = [];
  if (renderMap && q) {
    const exact = [], loose = [];
    for (const cat of ['gpuStats', 'rdgPasses', 'drawEvents']) for (const e of renderMap[cat] || []) {
      const n = String(e.name).toLowerCase();
      if (n === q) exact.push({ category: cat, ...e }); else if (n.includes(q)) loose.push({ category: cat, ...e });
    }
    const hits = exact.length ? exact : loose;
    passes.push(...hits.map(({ category, name, file, line }) => ({ category, name, file, line })));
    const seen = new Set(scored.map((s) => s.c)), sameFile = (a, b) => a.endsWith(b) || b.endsWith(a);
    // Hub files (DeferredShadingRenderer.cpp) declare dozens of unrelated cvars: there, keep only names sharing a word with the pass.
    const words = String(query).match(/[A-Z][a-z0-9]+/g) || [];
    // Original case splits CamelCase; the acronym catches TemporalSuperResolution → r.TSR.*.
    const qt = [...tokens(query), ...(words.length > 1 ? [words.map((w) => w[0]).join('').toLowerCase()] : [])];
    for (const hit of hits) {
      const inFile = doc.cvars.filter((c) => ok(c) && !seen.has(c) && sameFile(c.f, hit.file));
      for (const c of inFile) {
        const overlap = tokens(c.n).some((t) => qt.includes(t));
        if (!overlap && inFile.length > 12) continue;
        seen.add(c); scored.push({ score: overlap ? 4 : 5, c, via: `same-file ${hit.category}:${hit.name}` });
      }
    }
  }
  scored.sort((a, b) => a.score - b.score || a.c.n.length - b.c.n.length);
  return { query, total: scored.length, passes: passes.slice(0, 12),
    cvars: scored.slice(0, Math.max(1, Math.min(100, limit))).map((s) => ({ ...view(doc, s.c, overrides), via: s.via })) };
}

module.exports = { scan, find, cvarsInFile, parseScalability, projectOverrides };

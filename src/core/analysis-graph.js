'use strict';
const fs = process.versions.electron ? require('original-fs') : require('fs');
const path = require('path');
const crypto = require('crypto');
const processRunner = require('./analysis-process');
const paths = require('./paths');
const SUPPORTED = new Set(['.c','.h','.cc','.cpp','.cxx','.hpp','.cs','.js','.jsx','.ts','.tsx','.py','.uplugin','.uproject','.asmdef']);
const sourceExclusions = new Set(['node_modules','.git','Library','Binaries','Intermediate','Saved','graphify-out',
  '.venv','venv','.tox','__pycache__','obj']);
const isExcludedSourceFolder = name => sourceExclusions.has(name);
const isSupportedSource = file => SUPPORTED.has(path.extname(file).toLowerCase()) ||
  (path.basename(file) === 'manifest.json' && path.basename(path.dirname(file)) === 'Packages');
const jobs = new Map();
let resourceGate = null;
const idFor = name => {
  if (typeof name !== 'string' || !/^[\p{L}\p{N}_. -]{1,80}$/u.test(name) || name === '.' || name === '..') throw new Error('invalid_graph_name');
  return crypto.createHash('sha256').update(name).digest('hex').slice(0,24);
};
const storage = () => path.join(paths.hubDataDir(), 'analysis-graphs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const script = name => path.join(paths.appRoot(), 'scripts', name);
const atomic = async (file, data) => {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + crypto.randomUUID();
  await fs.promises.writeFile(temporary, JSON.stringify(data, null, 2), 'utf8');
  await fs.promises.rename(temporary, file);
  require('./change-signals').emitChanged('analysis-graph');
};

// Binary analysis needs the JVM heap plus ~1 GiB for Ghidra's decompiler and native code.
const ramFor = (kind, heapGb = 2) => (kind === 'binary' ? heapGb + 1 : 0.5) * 1024 ** 3;
function assessResources(snapshot, kind = 'source', heapGb = 2) {
  const now = Date.now(), extraRamBytes = ramFor(kind, heapGb);
  const no = reason => ({ admitted: false, reason, expected: { ramBytes: extraRamBytes, cpuCores: 2, vramBytes: 0 } });
  if (!snapshot || !Number.isFinite(snapshot.sampledAt) || now - snapshot.sampledAt > 10000 || snapshot.sampledAt > now + 1000) return no('resource_sample_stale');
  const cpu = snapshot.cpu?.usagePercent, total = snapshot.ram?.totalBytes, used = snapshot.ram?.usedBytes;
  if (!Number.isFinite(cpu) || cpu < 0 || cpu > 100) return no('cpu_sample_unavailable');
  if (cpu > 85) return no('cpu_busy');
  if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0 || used < 0 || used > total) return no('ram_sample_unavailable');
  if (total - used < extraRamBytes + 3 * 1024 ** 3 || (used + extraRamBytes) / total > 0.9) return no('projected_ram_exceeds_budget');
  return { admitted: true, scenario: 'local_cpu', sampledAt: snapshot.sampledAt,
    expected: { ramBytes: extraRamBytes, cpuCores: 2, vramBytes: 0, verified: false } };
}
async function admission(kind, heapGb = 2) {
  // The office-laptop profile leaves JVM/decompiler work to the desktop; light source analysis still runs here.
  if (kind === 'binary' && require('./device-profile').lite()) return { admitted: false, reason: 'lite_profile_heavy_analysis_on_desktop' };
  if (resourceGate) return resourceGate({ kind: 'analysis-' + kind, cpuCores: 2, ramBytes: ramFor(kind, heapGb) });
  const diagnostics = require('./hardware-diagnostics').instance();
  try {
    return await diagnostics.capture({ id: kind + '-' + crypto.randomUUID(), agent: 'remote-static',
      resourceProfile: { cpuCores: 2, ramBytes: ramFor(kind, heapGb), vramBytes: 0 } }, { id: 'source-analysis' });
  } catch (error) {
    if (error.code !== 'HARDWARE_DEFERRED') throw error;
    return diagnostics.list().find(row => row.id === error.diagnosticId) || { admitted: false, reason: 'hardware_diagnostic_unavailable' };
  }
}
function finishAdmission(gate, outcome) {
  if (gate?.id && !resourceGate) require('./hardware-diagnostics').instance().finish(gate, outcome);
}
async function renewAdmission(gate, kind, heapGb) {
  if (resourceGate || (Number.isFinite(gate?.sampledAt) && Date.now() - gate.sampledAt <= 10000)) return gate;
  finishAdmission(gate, 'rediagnosed');
  return admission(kind, heapGb);
}

async function capabilities() {
  const [ast, java] = await Promise.all([
    processRunner.detectPython(script('analysis_ast.py')),
    processRunner.run('probe-java-' + crypto.randomUUID(), 'java', ['-version'], { timeoutMs: 10000, maxBytes: 65536 })
      .then(r => ({ available: true, version: (r.stderr || r.stdout).trim().split(/\r?\n/)[0] })).catch(() => ({ available: false })),
  ]);
  return { schema: 'source-analysis-graph/1', ast, ghidra: processRunner.detectGhidra(), java,
    limits: { files: 200, fileBytes: 1024 ** 2, sourceBytes: 20 * 1024 ** 2,
      binaryBytes: 512 * 1024 ** 2, sourceTimeoutMs: 120000, binaryTimeoutMs: 900000, cpuCores: 2, jvmMiB: 2048 },
    tiers: ['symbolmap coordinates', 'selected structural graph / scoped codeindex', 'deepdive briefing'],
    privacy: 'local deterministic extraction; no source sent to a model or external API' };
}

async function selection(root, entries) {
  const realRoot = await fs.promises.realpath(String(root));
  if (!Array.isArray(entries) || !entries.length) throw new Error('explicit_source_scope_required');
  const files = [], queue = [], seen = new Set();
  for (const entry of entries) {
    const full = await fs.promises.realpath(path.resolve(realRoot, String(entry)));
    const relative = path.relative(realRoot, full);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('source_scope_outside_root');
    queue.push(full);
  }
  let total = 0, visited = 0;
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const stat = await fs.promises.lstat(file);
    if (++visited > 4000) throw new Error('scope_too_large_narrow_selection');
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      const rows = await fs.promises.readdir(file, { withFileTypes: true });
      for (const row of rows) if (!isExcludedSourceFolder(row.name)) queue.push(path.join(file, row.name));
    } else if (stat.isFile() && isSupportedSource(file)) {
      if (stat.size > 1024 ** 2) throw new Error('source_file_too_large');
      total += stat.size;
      if (total > 20 * 1024 ** 2 || files.length >= 200) throw new Error('scope_too_large_narrow_selection');
      files.push(file);
    }
  }
  if (!files.length) throw new Error('no_supported_source_files');
  return { root: realRoot, files: [...new Set(files)].sort(), bytes: total };
}

async function manifest(files, root) {
  const result = [];
  for (const file of files) result.push({ file: path.relative(root, file).split(path.sep).join('/'), sha256: hash(await fs.promises.readFile(file)) });
  return result;
}
function normalize(raw, evidence = 'source') {
  const certainty = row => {
    const value = String(row.evidence || row.confidence_type || (typeof row.confidence === 'string' ? row.confidence : '') || 'EXTRACTED').toUpperCase();
    return ['EXTRACTED','INFERRED','AMBIGUOUS'].includes(value) ? value : 'AMBIGUOUS';
  };
  const location = row => row.source_file && /^L?\d+(?:(?:-|:)L?\d+)?$/.test(String(row.source_location || ''))
    ? row.source_file + ':' + String(row.source_location).replaceAll('L', '') : row.source_location;
  const nodes = new Map((raw.nodes || []).map(n => [String(n.id), { ...n, id: String(n.id),
    evidence: certainty(n), source_location: location(n), provenanceKind: evidence }]));
  const edges = (raw.edges || raw.links || []).filter(e => nodes.has(String(e.source)) && nodes.has(String(e.target))).map(e => ({ ...e,
    source: String(e.source), target: String(e.target), relation: String(e.relation || e.label || e.type || 'related'),
    evidence: certainty(e), source_location: location(e) }));
  return { ...raw, schema: 'source-analysis-graph/1', directed: true, nodes: [...nodes.values()], edges,
    warnings: [...(raw.warnings || []), raw.truncated && 'Binary export limits reached; graph is partial.',
      (raw.edges || raw.links || []).length !== edges.length && 'Dangling endpoints omitted; source graph is incomplete.',
      evidence === 'source' && 'Selected files only. Dynamic/virtual dispatch, macros and runtime loading may remain unresolved.',
      evidence === 'binary' && 'Indirect calls and decompiler reconstruction are incomplete; source correspondence is unverified.'].filter(Boolean) };
}
async function read(name) { return JSON.parse(await fs.promises.readFile(path.join(storage(), idFor(name), 'graph.json'), 'utf8')); }
async function list() {
  let dirs;
  try { dirs = await fs.promises.readdir(storage()); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const rows = [];
  for (const dir of dirs) {
    if (!/^[0-9a-f]{24}$/.test(dir)) continue;
    try { const data = JSON.parse(await fs.promises.readFile(path.join(storage(), dir, 'graph.json'), 'utf8'));
      rows.push({ name: data.name, kind: data.kind, createdAt: data.createdAt, nodes: data.nodes.length, edges: data.edges.length, warnings: data.warnings,
        ...(data.engineMap ? { engineMap: data.engineMap } : {}), ...(data.pdbLoaded != null ? { pdbLoaded: data.pdbLoaded } : {}) });
    } catch (_) { rows.push({ name: dir, kind: 'unreadable', error: 'graph_read_failed' }); }
  }
  for (const job of jobs.values()) rows.push({ name: job.name, kind: job.kind, state: 'running', phase: job.phase, startedAt: job.startedAt });
  return rows;
}

async function build(options, progress = () => {}) {
  const name = String(options?.name || ''), id = idFor(name);
  if (jobs.has(id)) throw new Error('analysis_job_active');
  const job = { name, kind: 'source', state: 'running', phase: 'diagnosis', cancelled: false, outcome: 'failed', startedAt: Date.now() };
  let gate;
  jobs.set(id, job);
  try {
    gate = await admission('source');
    if (!gate.admitted) { job.outcome = 'deferred'; return { deferred: true, admission: gate }; }
    // Engine topic: the symbol/cvar/render maps pick the files instead of a hand-made selection.
    const engine = options.engine ? require('./engine-graph').scope(options.engine.map, options.engine.topic, { renderMap: options.engine.renderMap }) : null;
    if (engine) Object.assign(options, { root: engine.root, paths: engine.paths });
    const scoped = await selection(options.root, options.paths);
    const before = await manifest(scoped.files, scoped.root), scopeHash = hash(JSON.stringify(before));
    const python = await processRunner.detectPython(script('analysis_ast.py'));
    if (!python.available) { job.outcome = 'unavailable'; return { unavailable: true, reason: python.reason }; }
    const extractorHash = hash(Buffer.concat([await fs.promises.readFile(script('analysis_ast.py')), Buffer.from(python.version)]));
    try { const prior = await read(name); if (prior.scopeHash === scopeHash && prior.extractorHash === extractorHash && prior.root === scoped.root && prior.kind === 'source') { job.outcome = 'reused'; return { ...prior, reused: true, admission: gate }; } } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (job.cancelled) throw new Error('analysis_cancelled');
    const dir = path.join(storage(), id);
    gate = await renewAdmission(gate, 'source');
    if (!gate.admitted) { job.outcome = 'deferred'; return { deferred: true, admission: gate }; }
    if (job.cancelled) throw new Error('analysis_cancelled');
    progress({ name, phase: 'extracting', files: scoped.files.length, admission: gate });
    job.phase = 'extracting';
    const result = await processRunner.run(id, python.executable, [script('analysis_ast.py')], {
      input: { root: scoped.root, files: scoped.files, cache: dir }, timeoutMs: 120000, onSpawn: pid => trackPid(gate, pid) });
    if (job.cancelled) throw new Error('analysis_cancelled');
    const graph = normalize(JSON.parse(result.stdout.trim()));
    if (!graph.nodes.length) throw new Error('empty_graph_preserved_previous');
    if (hash(JSON.stringify(await manifest(scoped.files, scoped.root))) !== scopeHash) throw new Error('source_changed_during_analysis');
    if (job.cancelled) throw new Error('analysis_cancelled');
    Object.assign(graph, { name, root: scoped.root, kind: 'source', createdAt: new Date().toISOString(),
      scopeHash, extractorHash, manifest: before, scope: options.paths.map(String), admission: gate });
    if (engine) {
      require('./engine-graph').enrichSource(graph, options.engine.map, options.engine.renderMap);
      graph.engineScope = { topic: options.engine.topic, candidates: engine.candidates, truncated: engine.truncated };
    }
    await atomic(path.join(dir, 'graph.json'), graph);
    job.outcome = 'succeeded';
    progress({ name, phase: 'done', nodes: graph.nodes.length, edges: graph.edges.length });
    return graph;
  } finally { jobs.delete(id); finishAdmission(gate, job.cancelled ? 'cancelled' : job.outcome); }
}

async function binaryLease() {
  const lock = path.join(storage(), 'binary-job.local.json'), leaseId = crypto.randomUUID();
  await fs.promises.mkdir(storage(), { recursive: true });
  let handle;
  try { handle = await fs.promises.open(lock, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('binary_analysis_lease_busy_or_unreconciled');
  }
  await handle.writeFile(JSON.stringify({ id: leaseId, pid: process.pid, startedAt: Date.now() }), 'utf8');
  return async () => {
    await handle.close();
    const current = JSON.parse(await fs.promises.readFile(lock, 'utf8'));
    if (current.id !== leaseId) throw new Error('binary_analysis_lease_changed');
    await fs.promises.unlink(lock);
  };
}

async function binary(options, progress = () => {}) {
  const name = String(options?.name || ''), id = idFor(name);
  if ([...jobs.values()].some(j => j.kind === 'binary')) throw new Error('binary_analysis_job_active');
  if (jobs.has(id)) throw new Error('analysis_job_active');
  const job = { name, kind: 'binary', state: 'running', phase: 'diagnosis', cancelled: false, outcome: 'failed', startedAt: Date.now() }; jobs.set(id, job);
  let release, gate;
  try {
    const file = await fs.promises.realpath(String(options.file));
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > 512 * 1024 ** 2) throw new Error('binary_file_size_limit');
    // Classify actual PE/CLR headers, including SYS/OCX/CPL and renamed application modules.
    if ((await require('./rea-target').imageInfo(file,{fingerprint:false})).format !== 'native') throw new Error('select_native_binary');
    const ghidra = require('./ghidra-project'), heapGb = ghidra.heapFor(stat.size);
    gate = await admission('binary', heapGb);
    if (!gate.admitted) { job.outcome = 'deferred'; return { deferred: true, admission: gate }; }
    const selected = Array.isArray(options.addresses) ? options.addresses.map(String) : [];
    if (selected.length > 5 || selected.some(x => !/^(?:[\w]+:)?[0-9a-fA-F]{1,16}$/.test(x))) throw new Error('invalid_selected_function_address');
    const runtime = processRunner.detectGhidra();
    if (!runtime.available) { job.outcome = 'unavailable'; return { unavailable: true, reason: runtime.reason }; }
    if (job.cancelled) throw new Error('analysis_cancelled');
    release = await binaryLease();
    const binaryHash = hash(await fs.promises.readFile(file));
    if (options.expectedSha256 && binaryHash !== options.expectedSha256) throw new Error('binary_changed_since_selection');
    const directory = path.join(storage(), id, 'job-' + crypto.randomUUID());
    await fs.promises.mkdir(directory, { recursive: true });
    const output = path.join(directory, 'binary.json');
    gate = await renewAdmission(gate, 'binary', heapGb);
    if (!gate.admitted) { job.outcome = 'deferred'; return { deferred: true, admission: gate }; }
    if (job.cancelled) throw new Error('analysis_cancelled');
    progress({ name, phase: 'static_binary_analysis', admission: gate });
    job.phase = 'static_binary_analysis';
    // Persistent project: the first run analyzes (minutes); rebuilds and later queries reuse it (seconds).
    const project = await ghidra.analyzeAndExport({ file, binaryHash, selected, output, onSpawn: pid => trackPid(gate, pid) });
    if (job.cancelled) throw new Error('analysis_cancelled');
    const graph = normalize(JSON.parse(await fs.promises.readFile(output, 'utf8')), 'binary');
    if (!graph.nodes.length) throw new Error('empty_graph_preserved_previous');
    if (hash(await fs.promises.readFile(file)) !== binaryHash) throw new Error('binary_changed_during_analysis');
    if (job.cancelled) throw new Error('analysis_cancelled');
    Object.assign(graph, { name, kind: 'binary', createdAt: new Date().toISOString(), binaryHash, binaryPath: file,
      binaryFile: path.basename(file), selectedFunctions: graph.selectedFunctions || [], admission: gate,
      exporterHash: hash(await fs.promises.readFile(script('ghidra/HubGraphExport.java'))), program: project.program, reusedAnalysis: project.reused,
      runtime: { name: 'Ghidra', version: path.basename(runtime.home), cpuCores: 2, jvmMiB: project.heapGb * 1024 } });
    graph.nodes.forEach(n => { n.binaryHash = binaryHash; });
    const engineMap = require('./engine-graph').mapForBinary(file);
    if (engineMap) require('./engine-graph').enrichBinary(graph, engineMap.name);
    await atomic(path.join(storage(), id, 'graph.json'), graph);
    job.outcome = 'succeeded';
    progress({ name, phase: 'done', nodes: graph.nodes.length, edges: graph.edges.length });
    return graph;
  } finally { jobs.delete(id); finishAdmission(gate, job.cancelled ? 'cancelled' : job.outcome); if (release) await release(); }
}

const trackPid = (gate, pid) => { if (gate?.id && !resourceGate) require('./hardware-diagnostics').instance().trackPid(gate, pid); };

/** A binary graph whose input file is unchanged (or unavailable to check); the analysis project must exist. */
async function currentBinary(name) {
  const g = await read(name);
  if (g.kind !== 'binary') throw new Error('not_a_binary_graph');
  try { if (hash(await fs.promises.readFile(g.binaryPath)) !== g.binaryHash) throw new Error('binary_changed_rebuild_graph'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return g;
}

/** decompile | xrefs | search | callgraph on the saved analysis; engine DLL functions also get their source definition. */
async function binaryQuery(name, op, target, depth) {
  const g = await currentBinary(name), release = await binaryLease();
  try {
    const out = await require('./ghidra-project').query({ binaryHash: g.binaryHash, op, target, depth });
    const fn = out.result?.function?.name;
    if (op === 'decompile' && fn && g.engineMap) out.source = require('./engine-graph').findDefinition(g.engineMap.symbols, fn);
    return out;
  } finally { await release(); }
}

/** Rename / comment in the analysis database, then refresh the graph labels from it. The binary is untouched. */
async function binaryAnnotate(name, edits) {
  const g = await currentBinary(name);
  let release = await binaryLease(), result;
  try { result = await require('./ghidra-project').annotate({ binaryHash: g.binaryHash, edits }); } finally { await release(); }
  await binary({ name, file: g.binaryPath, addresses: (g.selectedFunctions || []).map(f => f.address) });
  return result;
}

/** One JSON line per node with its typed neighbors: a grounded corpus for retrieval, review or fine-tuning sets. */
async function exportFacts(name, { includeSource = false } = {}) {
  const g = await read(name), byId = new Map(g.nodes.map(n => [n.id, n])), out = [];
  const adjacency = new Map();
  for (const e of g.edges) for (const [a, b, dir] of [[e.source, e.target, 'out'], [e.target, e.source, 'in']])
    (adjacency.get(a) || adjacency.set(a, []).get(a)).push({ relation: e.relation, direction: dir, node: byId.get(b)?.label || b });
  for (const n of g.nodes) {
    const row = { graph: name, kind: g.kind, id: n.id, label: n.label, type: n.type, location: n.source_location || n.binary_address || null,
      evidence: n.evidence, engine: n.engine || null, relations: (adjacency.get(n.id) || []).slice(0, 40) };
    if (includeSource && g.kind === 'source' && n.source_file && /^\d+/.test(String(n.source_location || '').split(':')[1] || '')) {
      const line = Number(String(n.source_location).split(':')[1]);
      try { row.excerpt = scrubText((await fs.promises.readFile(path.join(g.root, n.source_file), 'utf8')).split('\n').slice(Math.max(0, line - 1), line + 30).join('\n')); }
      catch { row.excerpt = null; }
    }
    out.push(JSON.stringify(row));
  }
  const file = path.join(storage(), idFor(name), 'facts.jsonl');
  await fs.promises.writeFile(file, out.join('\n') + '\n', 'utf8');
  return { file, rows: out.length, includeSource };
}
const scrubText = text => require('./secret-scrub').scrub(text);

function cancel(name) {
  const id = idFor(name), job = jobs.get(id);
  if (!job) return { requested: false };
  job.cancelled = true;
  return { requested: true, terminationRequested: processRunner.terminate(id), ended: false };
}
async function query(name, text, options = {}) {
  const graph = await read(name), q = String(text || '').toLocaleLowerCase();
  const found = graph.nodes.filter(n => [n.id,n.label,n.source_file,n.binary_address,n.type].some(v => String(v || '').toLocaleLowerCase().includes(q)));
  const cap = Math.max(1, Math.min(100, Number(options.limit) || 30)), seeds = found.slice(0,cap), ids = new Set(seeds.map(n => n.id));
  const edges = graph.edges.filter(e => options.direction === 'upstream' ? ids.has(e.target) : options.direction === 'downstream' ? ids.has(e.source) : ids.has(e.source) || ids.has(e.target)).slice(0,200);
  const related = new Set(edges.flatMap(e => [e.source,e.target]));
  return { name, matches: seeds, totalMatches: found.length, edges, neighbors: graph.nodes.filter(n => related.has(n.id) && !ids.has(n.id)),
    selectedFunctions: (graph.selectedFunctions || []).filter(row => seeds.some(n => n.binary_address === row.address)), warnings: graph.warnings };
}
async function shortestPath(name, source, target) {
  const graph = await read(name), ids = new Set(graph.nodes.map(n => n.id));
  if (!ids.has(source) || !ids.has(target)) throw new Error('path_requires_exact_node_ids');
  const adjacency = new Map();
  for (const edge of graph.edges) { if (!adjacency.has(edge.source)) adjacency.set(edge.source,[]); adjacency.get(edge.source).push(edge); }
  const queue = [source], previous = new Map([[source,null]]);
  for (let i = 0; i < queue.length && !previous.has(target); i++) {
    for (const edge of adjacency.get(queue[i]) || []) if (!previous.has(edge.target)) { previous.set(edge.target,edge); queue.push(edge.target); }
  }
  if (!previous.has(target)) return { found: false, directed: true, nodes: [], edges: [] };
  const edges = []; let cursor = target;
  while (previous.get(cursor)) { const edge = previous.get(cursor); edges.unshift(edge); cursor = edge.source; }
  const route = [source,...edges.map(e => e.target)];
  return { found: true, directed: true, nodes: route.map(id => graph.nodes.find(n => n.id === id)), edges };
}
async function architecture(name) {
  const source = path.join(storage(), idFor(name), 'graph.json');
  await read(name);
  const python = await processRunner.detectPython(script('analysis_ast.py'));
  if (!python.available) throw new Error(python.reason);
  const output = path.join(storage(), idFor(name), 'architecture.html');
  await processRunner.run('architecture-' + crypto.randomUUID(), python.executable,
    [script('analysis_architecture.py'), source, '--output', output], { timeoutMs: 30000, maxBytes: 65536 });
  return output;
}
module.exports = { capabilities, selection, isSupportedSource, sourceExclusions, isExcludedSourceFolder, assessResources, build, binary, list, read, query, shortestPath, cancel,
  architecture, admission, finishAdmission, binaryLease, binaryQuery, binaryAnnotate, exportFacts,
  setResourceGate: gate => { resourceGate = gate; }, graphPath: name => path.join(storage(), idFor(name), 'graph.json'),
  _normalize: normalize, _manifest: manifest };

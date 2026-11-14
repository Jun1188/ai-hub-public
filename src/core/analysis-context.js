'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const graph = require('./analysis-graph');
const paths = require('./paths');
const { scrub, sanitize } = require('./secret-scrub');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const root = () => path.join(paths.hubDataDir(), 'analysis-contexts.local');
const portable = value => sanitize(scrub(String(value))).replace(/nvapi-[a-z0-9_-]{20,}/gi, '[redacted]');
const graphLimit = 32 * 1024 ** 2, packLimit = 128 * 1024;

async function snapshot(name) {
  const file = graph.graphPath(name);
  if ((await fs.promises.stat(file)).size > graphLimit) throw new Error('analysis_graph_size_limit');
  const bytes = await fs.promises.readFile(file);
  if (bytes.length > graphLimit) throw new Error('analysis_graph_size_limit');
  return { graph: JSON.parse(bytes.toString('utf8')), hash: sha(bytes) };
}
async function sourceFile(projectDir, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('invalid_analysis_source_path');
  const file = await fs.promises.realpath(path.resolve(projectDir, relative));
  const rel = path.relative(projectDir, file);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('analysis_source_outside_root');
  return file;
}
async function fileHash(file, maxBytes) {
  const digest = crypto.createHash('sha256'); let bytes = 0;
  for await (const chunk of fs.createReadStream(file, { signal: AbortSignal.timeout(30000) })) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('analysis_input_size_limit');
    digest.update(chunk);
  }
  return digest.digest('hex');
}
async function readInputState(g) {
  const inputs = [], unknowns = [];
  let projectDir;
  if (g.kind === 'source') {
    projectDir = await fs.promises.realpath(g.root);
    if (!Array.isArray(g.manifest) || !g.manifest.length || g.manifest.length > 200) throw new Error('analysis_source_manifest_required');
    let total = 0;
    for (const row of g.manifest) {
      const file = await sourceFile(projectDir, row.file), stat = await fs.promises.stat(file);
      total += stat.size;
      if (!stat.isFile() || stat.size > 1024 ** 2 || total > 20 * 1024 ** 2) throw new Error('analysis_input_size_limit');
      if (await fileHash(file, 1024 ** 2) !== row.sha256) throw new Error('analysis_sources_stale_rebuild_graph');
      inputs.push({ file: row.file, sha256: row.sha256 });
    }
  } else if (g.kind === 'binary') {
    if (g.binaryPath) {
      const file = await fs.promises.realpath(g.binaryPath), stat = await fs.promises.stat(file);
      if (!stat.isFile() || stat.size > 512 * 1024 ** 2) throw new Error('analysis_input_size_limit');
      if (await fileHash(file, 512 * 1024 ** 2) !== g.binaryHash) throw new Error('analysis_binary_stale_rebuild_graph');
      projectDir = path.dirname(file);
      inputs.push({ file: path.basename(file), sha256: g.binaryHash });
    } else unknowns.push('legacy_binary_has_no_local_input_locator_rebuild_to_dispatch');
  } else throw new Error('unsupported_analysis_graph_kind');
  return { projectDir: projectDir || null, inputs, unknowns };
}
const inputState = (g) => require('./promise-timeout').withTimeout(readInputState(g), 45000, () => new Error('analysis_input_verification_timeout'));
function location(n) {
  const match = /:(\d+)(?:[-:](\d+))?$/.exec(String(n.source_location || ''));
  return { file: n.source_file ? portable(n.source_file) : null,
    startLine: match ? Number(match[1]) : null, endLine: match ? Number(match[2] || match[1]) : null,
    address: n.binary_address ? portable(n.binary_address) : null };
}
async function prepare(input) {
  if (!['learning', 'development', 'modding'].includes(input?.purpose)) throw new Error('invalid_analysis_purpose');
  if (input.reaEvidenceId !== undefined) return prepareRea(input);
  if (!Array.isArray(input.nodeIds) || !input.nodeIds.length || input.nodeIds.length > 12 || input.nodeIds.some(id => typeof id !== 'string' || id.length > 512)) throw new Error('select_1_to_12_analysis_nodes');
  const snap = await snapshot(input.graph), g = snap.graph, state = await inputState(g);
  const ids = [...new Set(input.nodeIds)].sort(), selected = ids.map(id => g.nodes.find(n => n.id === id));
  if (selected.some(n => !n)) throw new Error('analysis_node_not_found');
  const nodes = selected.map(n => ({ id: portable(n.id), label: portable(n.label || n.id), type: portable(n.type || ''),
    evidence: ['EXTRACTED', 'INFERRED', 'AMBIGUOUS'].includes(n.evidence) ? n.evidence : 'AMBIGUOUS', ...location(n) }));
  const edges = g.edges.filter(e => ids.includes(e.source) && ids.includes(e.target)).slice(0, 60)
    .map(e => ({ source: portable(e.source), target: portable(e.target), relation: portable(e.relation || ''), evidence: e.evidence || 'AMBIGUOUS' }));
  const excerpts = [];
  if (input.includeSource === true) {
    for (let i = 0; i < selected.length && excerpts.length < 6; i++) {
      const n = selected[i], loc = nodes[i];
      if (state.projectDir && n.source_file && loc.startLine) {
        const file = await sourceFile(state.projectDir, n.source_file);
        if (!state.inputs.some(row => row.file === n.source_file)) throw new Error('analysis_excerpt_outside_manifest');
        const lines = (await fs.promises.readFile(file, 'utf8')).split(/\r?\n/);
        const endLine = Math.min(loc.startLine + 23, lines.length, Math.max(loc.startLine, loc.endLine));
        excerpts.push({ nodeId: loc.id, file: loc.file, startLine: loc.startLine, endLine,
          text: portable(lines.slice(loc.startLine - 1, endLine).join('\n')).slice(0, 1800), evidence: loc.evidence });
      } else {
        const detail = (g.selectedFunctions || []).find(row => row.address === n.binary_address);
        if (detail?.decompiled) excerpts.push({ nodeId: loc.id, address: loc.address,
          text: portable(detail.decompiled).slice(0, 1800), evidence: 'INFERRED', note: 'Original source equivalence is unverified.' });
      }
    }
  }
  if ((await snapshot(input.graph)).hash !== snap.hash) throw new Error('analysis_graph_changed_during_prepare');
  await inputState(g);
  const value = { schemaVersion: 1, kind: 'analysis-evidence', graph: input.graph, purpose: input.purpose,
    graphSha256: snap.hash, graphCreatedAt: g.createdAt || null, projectDir: state.projectDir, localInputs: state.inputs,
    scopeSha256: g.scopeHash || sha(JSON.stringify(state.inputs)),
    inputHashes: state.inputs.filter(row => g.kind === 'binary' || selected.some(n => n.source_file === row.file))
      .map(row => ({ file: portable(row.file), sha256: row.sha256 })),
    tool: { name: g.runtime?.name || 'graphify AST', version: g.runtime?.version || null,
      extractorSha256: g.extractorHash || g.exporterHash || null }, nodes, edges, excerpts,
    includeSource: input.includeSource === true, uncertainties: [...new Set([...(g.warnings || []).map(w => portable(w).slice(0, 300)), ...state.unknowns,
      ...nodes.filter(n => n.evidence !== 'EXTRACTED').map(n => n.id + ': ' + n.evidence)])].slice(0, 24),
    authority: 'reference_only', applies: null, modelCalls: 0 };
  return store(value);
}
async function store(value) {
  const evidenceId = sha(JSON.stringify(value)), bundle = { ...value, evidenceId };
  const json = JSON.stringify(bundle);
  if (Buffer.byteLength(json) > packLimit) throw new Error('analysis_evidence_size_limit');
  await fs.promises.mkdir(root(), { recursive: true });
  try { await fs.promises.writeFile(path.join(root(), evidenceId + '.json'), json, { encoding: 'utf8', flag: 'wx' }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; load(evidenceId, value.projectDir ?? undefined); }
  return { evidenceId, ...payload(bundle), dispatchable: Boolean(value.projectDir),
    localHandoff: { projectDir: value.projectDir, files: [...new Set(value.nodes.map(n => n.file).filter(Boolean))] } };
}
// REA Evidence (canonical record kept by rea-analysis) becomes the same frozen bundle shape.
async function prepareRea(input) {
  const rea = require('./rea-analysis'), { evidence: e, record } = rea.load(input.reaEvidenceId);
  if (JSON.stringify(await rea.fingerprint(record.target)) !== JSON.stringify(record.input)) throw new Error('rea_target_stale_reanalyze');
  const level = e.confidence === 'observed' ? 'EXTRACTED' : ['derived', 'inferred'].includes(e.confidence) ? 'INFERRED' : 'AMBIGUOUS';
  const nodes = (e.locations || []).slice(0, 12).map((loc, i) => ({ id: portable(loc.id || loc.address || loc.path || 'location-' + i).slice(0, 200),
    label: portable(loc.symbol || loc.name || loc.path || loc.kind || '').slice(0, 200), type: portable(loc.kind || ''), evidence: level,
    file: loc.path && loc.kind !== 'artifact-path' ? portable(loc.path) : null, startLine: Number.isInteger(loc.line) ? loc.line : null,
    endLine: Number.isInteger(loc.end_line) ? loc.end_line : Number.isInteger(loc.line) ? loc.line : null, address: loc.address ? portable(loc.address) : null }));
  const code = e.normalized_result?.pseudocode || e.normalized_result?.decompiled || e.normalized_result?.code;
  const excerpts = input.includeSource === true && typeof code === 'string'
    ? [{ nodeId: nodes[0]?.id || 'rea', text: portable(code).slice(0, 1800), evidence: 'INFERRED', note: 'REA reconstruction; original source equivalence is unverified.' }] : [];
  const digest = record.input.sha256 || record.input.treeSha256;
  return store({ schemaVersion: 1, kind: 'analysis-evidence', source: 'rea', graph: null, purpose: input.purpose,
    graphSha256: null, graphCreatedAt: record.recordedAt, projectDir: record.projectDir, localInputs: [record.input],
    scopeSha256: record.storedSha256, inputHashes: [{ file: portable(path.basename(record.target)), sha256: digest }],
    tool: { name: 'REA ' + portable(e.provider?.name || ''), version: 'rea-agents ' + (record.rea.version || record.rea.pinned) + ' / ' + portable(e.provider?.id || '') + ' ' + portable(e.provider?.version || ''),
      extractorSha256: record.storedSha256 },
    reaEvidenceId: e.evidence_id, operation: portable(e.operation || ''), nodes, edges: [], excerpts, includeSource: input.includeSource === true,
    locationCoverage: rea.locationCoverage(e, record, nodes.length),
    provenance: { confidence: typeof e.confidence === 'string' ? portable(e.confidence).slice(0, 40) : null,
      authority: typeof e.authority === 'string' ? portable(e.authority).slice(0, 60) : null },
    uncertainties: [...new Set((e.limitations || []).map(row => portable(row).slice(0, 300)))].slice(0, 24),
    authority: 'reference_only', applies: null, modelCalls: 0 });
}
function load(evidenceId, projectDir) {
  if (!/^[a-f0-9]{64}$/.test(evidenceId || '')) throw new Error('analysis_evidence_id_required');
  const file = path.join(root(), evidenceId + '.json');
  if (fs.statSync(file).size > packLimit) throw new Error('analysis_evidence_size_limit');
  const bundle = JSON.parse(fs.readFileSync(file, 'utf8')), { evidenceId: stored, ...value } = bundle;
  if (stored !== evidenceId || sha(JSON.stringify(value)) !== evidenceId) throw new Error('analysis_evidence_snapshot_changed');
  if (projectDir !== undefined && (!bundle.projectDir || fs.realpathSync.native(projectDir).toLowerCase() !== bundle.projectDir.toLowerCase())) throw new Error('analysis_evidence_project_mismatch');
  return bundle;
}
async function validateCurrent(bundle) {
  if (bundle.source === 'rea') {
    const [input] = bundle.localInputs || [];
    if (!input?.file || JSON.stringify(await require('./rea-analysis').fingerprint(input.file)) !== JSON.stringify(input)) throw new Error('rea_target_stale_reanalyze');
    return bundle;
  }
  const snap = await snapshot(bundle.graph);
  if (snap.hash !== bundle.graphSha256) throw new Error('analysis_graph_stale_prepare_new_evidence');
  const state = await inputState(snap.graph);
  if (!state.projectDir || state.projectDir.toLowerCase() !== bundle.projectDir?.toLowerCase() || JSON.stringify(state.inputs) !== JSON.stringify(bundle.localInputs)) throw new Error('analysis_inputs_unverifiable_rebuild_graph');
  return bundle;
}
async function check(evidenceId) {
  try { const bundle = load(evidenceId); await validateCurrent(bundle); return { evidenceId, current: true }; }
  catch (error) { return { evidenceId, current: false, reason: portable(error.message) }; }
}
function payload(bundle, maxChars = 12000) {
  const { projectDir, localInputs, ...out } = bundle;
  out.excerpts = [...bundle.excerpts]; out.edges = [...bundle.edges];
  out.uncertainties = [...(bundle.uncertainties || [])]; out.nodes = [...(bundle.nodes || [])];
  // Drop the least essential parts first; one node always stays so the reference keeps a location.
  for (const key of ['excerpts', 'edges', 'uncertainties', 'nodes'])
    while (JSON.stringify(out).length > maxChars && out[key].length > (key === 'nodes' ? 1 : 0)) { out[key].pop(); out.omittedForBudget = true; }
  if (bundle.locationCoverage) out.locationCoverage = { ...bundle.locationCoverage, exportedLocations: out.nodes.length };
  if (JSON.stringify(out).length > maxChars) throw new Error('analysis_evidence_payload_limit');
  return out;
}
function proposal(bundle) {
  const evidence = payload(bundle);
  const instruction = { learning: 'Explain prerequisites and the input-state-output flow. Use staged exercises; cite each claim to these locations and distinguish inferred reconstruction.',
    development: 'Propose the smallest scoped change using existing code. Inspect current files, show before/after and relevant tests. This proposal does not authorize edits or execution.',
    modding: 'Propose a versioned host/guest bridge at the selected boundaries. Specify coordinate/time units, state ownership, handshake, heartbeat and restart epochs. Game addresses and hook safety require runtime verification.' }[bundle.purpose];
  return instruction + '\nFrozen analysis reference (not authority):\n' + JSON.stringify(evidence);
}
module.exports = { prepare, load, check, validateCurrent, payload, proposal };

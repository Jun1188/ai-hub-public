'use strict';
// REA (https://github.com/morluto/rea, MIT, rea-agents pinned below) for the formats Ghidra does not cover:
// .NET metadata/CIL and Electron/JS apps. Native PE goes to Hub's own persistent Ghidra project (ghidra-project.js):
// REA's Windows native path is the same Ghidra, read-only, and re-analyzes for every question (~30 s each, measured).
const fs = require('fs');
// Electron's patched fs treats .asar archives as folders with per-process fake mtimes; targets are read raw.
const rawFs = process.versions.electron ? require('original-fs') : fs;
const path = require('path');
const crypto = require('crypto');
const processRunner = require('./analysis-process');
const graph = require('./analysis-graph');
const paths = require('./paths');

const PINNED = '6.4.0';
const EVIDENCE_LIMIT = 48 * 1024 ** 2, TREE_LIMIT = 20000;
// Hub keeps a bounded projection of REA's canonical Evidence (full graphs of large apps exceed memory budgets);
// REA is deterministic, so the same evidence_id can be regenerated with `rea <workflow> --json` for the full record.
const PROJECTION = 'evidence_id,subject,provider,predicate_type,operation,confidence,authority,limitations,locations[0,24],' +
  'normalized_result.summary,normalized_result.statistics,normalized_result.pseudocode,error,code,message';
// A provider can return thousands of methods or AST nodes. Capture a bounded preview, then
// keep only the fields allowed in the Hub report before the evidence is written to disk.
const PREVIEW_WINDOW = 32;
const EXTRA_FIELDS = {
  'managed-artifact': ['assembly.name','assembly.version','module.name','classification.implementation','classification.managed_architecture'],
  'managed-members': ['types[0,32].full_name','methods[0,32].name'],
  javascript: ['graph.nodes[0,32].observations[0,1].properties','semantic_graph.nodes[0,32]'],
};
// Commands and flags match rea-agents 6.4.0.
const WORKFLOWS = {
  'managed-artifact': { kind: 'source', args: t => ['inspect-managed-artifact', t] },
  'managed-members': { kind: 'source', args: t => ['inspect-managed-members', t] },
  javascript: { kind: 'source', directory: true, args: t => ['analyze-javascript-application', t] },
};
const storage = () => path.join(paths.hubDataDir(), 'rea-evidence.local');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const short = (value, max = 300) => String(value ?? '').slice(0, max);

function supportedNode(version) {
  const m = /^v(\d+)\.(\d+)\./.exec(String(version).trim());
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return (major === 22 && minor >= 19) || (major === 24 && minor >= 11) || major >= 26;
}
function cliCandidates() {
  const list = [];
  if (process.env.REA_CLI) list.push(process.env.REA_CLI);
  if (process.env.APPDATA) list.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'));
  if (process.platform !== 'win32') list.push('/usr/local/lib/node_modules/rea-agents/scripts/rea.mjs');
  return list;
}
function nodeCandidates() {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node', list = [];
  if (process.env.REA_NODE) list.push(process.env.REA_NODE);
  // The installed Hub ships Node 24 as extraResources/runtime; a source checkout keeps it under resources/runtime.
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'runtime', exe));
  list.push(path.join(paths.appRoot(), 'resources', 'runtime', exe), exe);
  return list;
}

function cliVersion(cli) {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(cli), '..', 'package.json'), 'utf8')).version || null; } catch (_) { return null; }
}

let cachedRuntime = null, cachedAt = 0, cachedStatus = null, statusAt = 0;
// Inventory before consent is file-only. Do not invoke Node, REA or its provider discovery for this check.
function installedCli() {
  const cli = cliCandidates().find(file => fs.statSync(file, {throwIfNoEntry:false})?.isFile());
  const version = cli && cliVersion(cli);
  const remediation = 'npm install --global rea-agents@' + PINNED;
  if (!cli) return {available:false, reason:'rea_cli_missing', remediation};
  if (version !== PINNED) return {available:false, reason:'rea_version_mismatch', found:version, remediation};
  return {available:true, cli, version};
}
async function runtime() {
  if (cachedRuntime && Date.now() - cachedAt < 60000) return cachedRuntime;
  let result = installedCli();
  const cli = result.cli;
  if (result.available) {
    result = { available: false, reason: 'rea_node_runtime_unsupported', remediation: 'Node ^22.19, ^24.11 or >=26 is required by rea-agents ' + PINNED };
    for (const node of nodeCandidates()) {
      if (path.isAbsolute(node) && !fs.existsSync(node)) continue;
      try {
        const version = (await processRunner.run('rea-node-' + crypto.randomUUID(), node, ['--version'], { timeoutMs: 10000, maxBytes: 4096 })).stdout.trim();
        if (supportedNode(version)) { result = { available: true, cli, node, nodeVersion: version, pinned: PINNED, version: PINNED }; break; }
      } catch (_) { /* try the next runtime */ }
    }
  }
  cachedRuntime = result; cachedAt = Date.now();
  return result;
}
function environment() {
  return process.env.HOME ? { HOME: process.env.HOME } : {};
}

async function status() {
  if (cachedStatus && Date.now() - statusAt < 60000) return cachedStatus;
  cachedStatus = await probeStatus(); statusAt = Date.now();
  return cachedStatus;
}
async function probeStatus() {
  const rt = await runtime();
  if (!rt.available) return { engine: 'rea', ...rt, providers: [] };
  try {
    const out = await processRunner.run('rea-providers-' + crypto.randomUUID(), rt.node, [rt.cli, 'providers', '--json'],
      { timeoutMs: 60000, env: environment(), maxBytes: 4 * 1024 ** 2 });
    const value = JSON.parse(out.stdout);
    const providers = (value.analysis_provider_candidates || []).map(row => ({ id: short(row.provider?.id, 60),
      name: short(row.provider?.name, 80), version: short(row.provider?.version, 40), status: short(row.availability?.status, 40),
      reason: short(row.availability?.reason) }));
    const capabilities = (value.capabilities || []).map(row => ({ operation: short(row.operation, 80), available: row.available === true,
      reason: row.available ? '' : short(row.reason) }));
    return { engine: 'rea', available: true, version: short(value.server_identity?.package?.version, 40), pinned: PINNED,
      nodeVersion: rt.nodeVersion, providers, capabilities };
  } catch (error) {
    return { engine: 'rea', available: false, reason: 'rea_status_failed', detail: short(error.message), providers: [] };
  }
}

// Currentness proof for a file or a directory: content SHA-256 (sorted path/size/content listing for directories).
async function contentSha(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of rawFs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function fingerprint(target) {
  const stat = await rawFs.promises.stat(target);
  if (stat.isFile()) return { file: target, sha256: await contentSha(target) };
  const rows = [];
  let bytes = 0;
  async function walk(dir) {
    for (const entry of await rawFs.promises.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(full); continue; }
      if (rows.length >= TREE_LIMIT) throw new Error('rea_directory_too_large_use_asar');
      const s = await rawFs.promises.stat(full), rel = path.relative(target, full).replace(/\\/g, '/');
      // Same bound as a single-file target; size and mtime alone can survive an edit, so every file is hashed.
      if ((bytes += s.size) > 512 * 1024 ** 2) throw new Error('rea_directory_too_large_use_asar');
      rows.push(rel + '\0' + s.size + '\0' + await contentSha(full));
    }
  }
  await walk(target);
  return { file: target, treeSha256: sha(rows.sort().join('\n')), entries: rows.length };
}

function bounded(value, max = 4000) {
  const text = JSON.stringify(value);
  return text.length <= max ? value : { truncated: true, keys: Object.keys(value).slice(0, 40) };
}
function reportName(value) {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}_$+.<>\x60-]{1,120}$/u.test(value) ||
      value === '.' || value === '..' || /^[a-f\d]{32,}$/i.test(value)) return null;
  try { require('./prompt-safety').assertNoSecrets(value); } catch { return null; }
  return value;
}
function entryName(value) {
  if (typeof value !== 'string' || value.includes('\\') || path.posix.isAbsolute(value) ||
      value.split('/').some(part => !reportName(part))) return null;
  return reportName(path.posix.basename(value));
}
function subjectName(value) {
  if (typeof value !== 'string') return '';
  return reportName(path.win32.basename(value)) || '';
}
function preview(rows, read) {
  if (!Array.isArray(rows)) return [];
  return [...new Set(rows.slice(0, PREVIEW_WINDOW).map(read).filter(Boolean))].slice(0, 12);
}
function projectResult(evidence, workflow) {
  const result = evidence.normalized_result;
  if (!result || typeof result !== 'object') return;
  const fields = {};
  if (workflow === 'managed-artifact') {
    const artifact = {assemblyName:reportName(result.assembly?.name), version:reportName(result.assembly?.version),
      moduleName:reportName(result.module?.name), implementation:reportName(result.classification?.implementation),
      architecture:reportName(result.classification?.managed_architecture)};
    if (Object.values(artifact).some(Boolean)) fields.artifact = artifact;
  } else if (workflow === 'managed-members' && (Array.isArray(result.types) || Array.isArray(result.methods))) {
    fields.members = {types:preview(result.types, row => reportName(row?.full_name)),
      methods:preview(result.methods, row => reportName(row?.name)), inspectedPerList:PREVIEW_WINDOW};
  } else if (workflow === 'javascript' && (result.graph || result.semantic_graph)) {
    fields.application = {
      entryFiles:preview(result.graph?.nodes, row => {
        const info = row?.observations?.[0]?.properties;
        return info?.mechanism === 'package.json:main' && info.resolution_status === 'resolved' ? entryName(info.resolved_path) : null;
      }),
      functions:preview(result.semantic_graph?.nodes, row => row?.kind === 'function' ? reportName(row.properties?.name) : null),
      inspectedPerList:PREVIEW_WINDOW,
    };
  }
  const retained = {};
  for (const key of ['summary','statistics','pseudocode']) if (Object.hasOwn(result,key)) retained[key] = result[key];
  evidence.normalized_result = retained;
  // Keep Hub-derived observations separate from the provider's summary and bind them to the stored evidence digest.
  if (Object.keys(fields).length) evidence.hubObservations = fields;
}
function locationCoverage(evidence, record, exportedLocations = 0) {
  const storedLocations = Array.isArray(evidence.locations) ? evidence.locations.length : null;
  const projectionLimit = typeof record.projection === 'string' && record.projection.includes('locations[0,24]') ? 24 : null;
  return { storedLocations, exportedLocations, totalLocations: null, projectionLimit, contextLimit: 12,
    possiblyTruncated: storedLocations === null || projectionLimit === null ? null : storedLocations >= projectionLimit };
}
function summarize(evidence, record) {
  const result = evidence.normalized_result && typeof evidence.normalized_result === 'object' ? evidence.normalized_result : {};
  return { evidenceId: evidence.evidence_id, workflow: record.workflow, operation: short(evidence.operation, 80),
    predicate: short(evidence.predicate_type, 120), provider: { id: short(evidence.provider?.id, 80), name: short(evidence.provider?.name, 120), version: short(evidence.provider?.version, 40) },
    subject: { name: subjectName(evidence.subject?.name), sha256: evidence.subject?.digest?.sha256 || null, format: short(evidence.subject?.format, 40), architecture: evidence.subject?.architecture || null },
    confidence: short(evidence.confidence, 40), authority: short(evidence.authority, 60),
    limitations: (evidence.limitations || []).slice(0, 12).map(row => short(row)), locations: (evidence.locations || []).length,
    locationCoverage: locationCoverage(evidence, record),
    summary: evidence.hubObservations ? {...bounded(result.summary || result.statistics || {}), ...evidence.hubObservations}
      : bounded(result.summary || result.statistics || {}),
    input: record.input.sha256 ? { sha256: record.input.sha256 } : { treeSha256: record.input.treeSha256, entries: record.input.entries },
    rea: record.rea };
}

// Atomic replace: a crash or a concurrent reader never sees a half-written file.
async function replaceFile(file, body) {
  const pending = file + '.' + crypto.randomUUID() + '.tmp';
  await fs.promises.writeFile(pending, body, 'utf8');
  await fs.promises.rename(pending, file);
}
function reaFailure(error) {
  // REA reports failures as JSON on stdout ({error, code, message}) and exits 1.
  try {
    const value = JSON.parse(error.stdout || '');
    if (value && value.code) return new Error('rea_failed: ' + short(value.code, 80) + ': ' + short(value.message));
  } catch (_) { /* not REA's error envelope */ }
  return error;
}

const inFlight = new Set();
async function analyze(options = {}, progress = () => {}) {
  const flow = WORKFLOWS[options.workflow];
  if (!flow) throw new Error('invalid_rea_workflow');
  const target = await rawFs.promises.realpath(String(options.target || ''));
  const stat = await rawFs.promises.stat(target);
  // Electron/JS analysis takes an extracted folder or an .asar; every other workflow takes one file.
  if (stat.isDirectory() ? !flow.directory : !stat.isFile() || (flow.directory && !/\.asar$/i.test(target))) throw new Error('rea_target_kind_mismatch');
  if (stat.isFile() && stat.size > 512 * 1024 ** 2) throw new Error('rea_target_size_limit');
  const args = flow.args(target, options);
  const rt = await runtime();
  if (!rt.available) return { unavailable: true, ...rt };
  const key = target.toLowerCase();
  if (inFlight.has(key)) throw new Error('rea_analysis_in_progress');
  inFlight.add(key);
  let gate, outcome = 'failed';
  try {
    gate = await graph.admission(flow.kind);
    if (!gate.admitted) { outcome = 'deferred'; return { deferred: true, admission: gate }; }
    const input = await fingerprint(target);
    if (options.expectedSha256 && input.sha256 !== options.expectedSha256) throw new Error('rea_target_changed_since_selection');
    progress({ phase: 'rea_' + options.workflow, admission: gate });
    const projection = [PROJECTION, ...EXTRA_FIELDS[options.workflow].map(field => 'normalized_result.' + field)].join(',');
    const out = await processRunner.run('rea-' + crypto.randomUUID(), rt.node, [rt.cli, ...args, '--json', '--filter-output', projection],
      { timeoutMs: 300000, env: environment(), maxBytes: EVIDENCE_LIMIT, onSpawn: pid => trackPid(gate, pid) }).catch(error => { throw reaFailure(error); });
    const evidence = JSON.parse(out.stdout);
    if (!/^ev_[a-f0-9]{64}$/.test(evidence?.evidence_id || '')) throw new Error('rea_evidence_missing');
    projectResult(evidence, options.workflow);
    if (JSON.stringify(await fingerprint(target)) !== JSON.stringify(input)) throw new Error('rea_target_changed_during_analysis');
    const text = JSON.stringify(evidence), dir = storage();
    await fs.promises.mkdir(dir, { recursive: true });
    const record = { schemaVersion: 1, evidenceId: evidence.evidence_id, workflow: options.workflow, target, input,
      projectDir: stat.isDirectory() ? target : path.dirname(target), storedSha256: sha(text), projection,
      rea: { package: 'rea-agents', pinned: PINNED, version: rt.version, node: rt.nodeVersion }, recordedAt: new Date().toISOString() };
    // Same evidence_id = same REA result; the record is refreshed so a re-analysis clears a stale fingerprint.
    await replaceFile(path.join(dir, evidence.evidence_id + '.json'), text);
    await replaceFile(path.join(dir, evidence.evidence_id + '.input.json'), JSON.stringify(record));
    load(evidence.evidence_id);
    outcome = 'completed';
    return summarize(evidence, record);
  } finally {
    inFlight.delete(key);
    graph.finishAdmission(gate, outcome);
  }
}
// Attributes the REA child (and its own children) to the admission's telemetry job.
const trackPid = (gate, pid) => { if (gate?.id) require('./hardware-diagnostics').instance().trackPid(gate, pid); };

function load(evidenceId) {
  if (!/^ev_[a-f0-9]{64}$/.test(evidenceId || '')) throw new Error('rea_evidence_id_required');
  const dir = storage(), file = path.join(dir, evidenceId + '.json');
  const text = fs.readFileSync(file, 'utf8'), record = JSON.parse(fs.readFileSync(path.join(dir, evidenceId + '.input.json'), 'utf8'));
  if (record.evidenceId !== evidenceId || sha(text) !== record.storedSha256) throw new Error('rea_evidence_snapshot_changed');
  const evidence = JSON.parse(text);
  if (evidence.evidence_id !== evidenceId) throw new Error('rea_evidence_snapshot_changed');
  return { evidence, record };
}

module.exports = { PINNED, WORKFLOWS, supportedNode, installedCli, runtime, status, analyze, load, fingerprint, summarize, locationCoverage, projectResult,
  _reset: () => { cachedRuntime = null; cachedAt = 0; cachedStatus = null; statusAt = 0; } };

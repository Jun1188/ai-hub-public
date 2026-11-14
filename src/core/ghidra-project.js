// Persistent Ghidra analysis per binary (content SHA-256): analyze once, then query and annotate in seconds.
// Annotations live in the project database only; the analyzed binary is never written or executed.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const processRunner = require('./analysis-process');
const paths = require('./paths');

// Projects are large and machine-specific: local disk, never the roaming/shared data folder.
const root = () => path.join(require('./paths').hubStorageDir(process.env.LOCALAPPDATA || path.join(paths.HOME, 'AppData', 'Local')), 'ghidra-projects');
const dirFor = (binaryHash) => {
  if (!/^[a-f0-9]{64}$/.test(String(binaryHash))) throw new Error('binary_hash_required');
  return path.join(root(), binaryHash.slice(0, 24));
};
const scripts = () => path.join(paths.appRoot(), 'scripts', 'ghidra');
const marker = (dir) => path.join(dir, 'analyzed.json');

function readMarker(binaryHash) {
  try { return JSON.parse(fs.readFileSync(marker(dirFor(binaryHash)), 'utf8')); } catch { return null; }
}

// Big binaries (UE module DLLs with PDBs) need more heap than small tools; the caller's admission decides the budget.
function heapFor(fileBytes) {
  if (fileBytes > 0 && fileBytes <= 64 * 1024) return 0.5;
  return fileBytes > 64 * 1024 ** 2 ? 8 : fileBytes > 16 * 1024 ** 2 ? 4 : 2;
}

// Optional device-local JDK selection for the headless launcher. Leave system Java settings alone.
function javaEnv() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return {};
  const setting = path.join(paths.hubStorageDir(process.env.LOCALAPPDATA), 'tools', 'ghidra-java-home.txt');
  let home;
  try { home = fs.readFileSync(setting, 'utf8').trim(); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!path.isAbsolute(home) || /["%!&|<>^\r\n]/.test(home) ||
      !['java.exe', 'javac.exe'].every(name => fs.existsSync(path.join(home, 'bin', name)))) {
    throw new Error('ghidra_java_home_invalid');
  }
  return { JAVA_HOME: home, PATH: path.join(home, 'bin') + path.delimiter + (process.env.PATH || '') };
}

async function headless(args, { timeoutMs, heapGb, onSpawn }) {
  const runtime = processRunner.detectGhidra();
  if (!runtime.available) { const e = new Error(runtime.reason); e.code = 'GHIDRA_UNAVAILABLE'; throw e; }
  const command = processRunner.headlessCommand(runtime, args);
  const maxMemory = `${heapGb * 1024}M`;
  const out = await processRunner.run('ghidra-' + crypto.randomUUID(), command.executable, command.args, { timeoutMs, onSpawn,
    windowsVerbatimArguments: command.windowsVerbatimArguments,
    env: { ...javaEnv(), GHIDRA_HEADLESS_MAXMEM: maxMemory, GHIDRA_MAXMEM: maxMemory, JAVA_TOOL_OPTIONS: `-Xmx${maxMemory}` } });
  return { ...runtime, log: `${out.stdout}\n${out.stderr}` };
}

// Headless exits 0 even when a post-script fails to compile or throws; its ERROR lines are the only signal.
function scriptError(log) {
  const lines = String(log || '').split(/\r?\n/).filter((l) => /^ERROR|Exception:/.test(l.trim()));
  return lines.slice(0, 4).join(' | ').slice(0, 600) || 'ghidra_script_produced_no_output';
}

/** First call imports and auto-analyzes (minutes); later calls re-export from the saved analysis (seconds). */
async function analyzeAndExport({ file, binaryHash, selected = [], output, onSpawn }) {
  const dir = dirFor(binaryHash), program = path.basename(file), size = fs.statSync(file).size, prior = readMarker(binaryHash);
  await fs.promises.mkdir(dir, { recursive: true });
  const common = ['-scriptPath', scripts(), '-postScript', 'HubGraphExport.java', output, selected.join(',') || 'none'];
  const reuse = prior && prior.binaryHash === binaryHash;
  const args = reuse ? [dir, 'hub', '-process', prior.program, '-noanalysis', ...common]
    : [dir, 'hub', '-import', file, '-overwrite', '-analysisTimeoutPerFile', '1740', '-max-cpu', '2', ...common];
  const heapGb = heapFor(size);
  const runtime = await headless(args, { timeoutMs: reuse ? 300000 : 1800000, heapGb, onSpawn });
  if (!fs.existsSync(output)) throw new Error(`ghidra_script_failed: ${scriptError(runtime.log)}`);
  if (!reuse || prior.heapGb !== heapGb) {
    const next = reuse ? { ...prior, heapGb } : { binaryHash, program, analyzedAt: new Date().toISOString(),
      ghidra: path.basename(runtime.home), heapGb };
    const pending = marker(dir) + '.tmp-' + crypto.randomUUID();
    try {
      await fs.promises.writeFile(pending, JSON.stringify(next), 'utf8');
      await fs.promises.rename(pending, marker(dir));
    } finally { await fs.promises.unlink(pending).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  return { reused: Boolean(reuse), program: reuse ? prior.program : program, heapGb, projectDir: dir };
}

async function withOutput(fn) {
  const out = path.join(require('os').tmpdir(), `hub-ghidra-${crypto.randomUUID()}.json`);
  try {
    const run = await fn(out);
    try { return JSON.parse(await fs.promises.readFile(out, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') throw new Error(`ghidra_script_failed: ${scriptError(run?.log)}`); throw e; }
  } finally { fs.promises.unlink(out).catch(() => {}); }
}

/** decompile | xrefs | search | callgraph against the saved analysis (read-only). */
async function query({ binaryHash, op, target, depth = 2, onSpawn }) {
  if (!['decompile', 'xrefs', 'search', 'callgraph'].includes(op)) throw new Error('invalid_query_op');
  if (!/^[\w$@.:~<>,*&\[\] -]{1,200}$/.test(String(target || ''))) throw new Error('invalid_query_target');
  const m = readMarker(binaryHash);
  if (!m) throw new Error('binary_not_analyzed_build_graph_first');
  const started = Date.now();
  const result = await withOutput((out) => headless([dirFor(binaryHash), 'hub', '-process', m.program, '-noanalysis', '-readOnly',
    '-scriptPath', scripts(), '-postScript', 'HubQuery.java', out, op, String(target), String(depth)], { timeoutMs: 180000, heapGb: m.heapGb || 2, onSpawn }));
  return { ...result, ms: Date.now() - started };
}

/** Renames / plate comments in the analysis database, logged next to the project. */
async function annotate({ binaryHash, edits, onSpawn }) {
  const m = readMarker(binaryHash);
  if (!m) throw new Error('binary_not_analyzed_build_graph_first');
  if (!Array.isArray(edits) || !edits.length || edits.length > 50) throw new Error('edits_1_to_50_required');
  const lines = edits.map((e) => {
    if (!['rename', 'comment'].includes(e.op) || /[\t\r\n]/.test(String(e.target))) throw new Error('invalid_edit');
    return [e.op, String(e.target), String(e.value).replace(/\r?\n/g, '\\n').replace(/\t/g, ' ')].join('\t');
  });
  const input = path.join(require('os').tmpdir(), `hub-ghidra-edits-${crypto.randomUUID()}.tsv`);
  await fs.promises.writeFile(input, lines.join('\n'), 'utf8');
  try {
    const result = await withOutput((out) => headless([dirFor(binaryHash), 'hub', '-process', m.program, '-noanalysis',
      '-scriptPath', scripts(), '-postScript', 'HubAnnotate.java', out, input], { timeoutMs: 180000, heapGb: m.heapGb || 2, onSpawn }));
    await fs.promises.appendFile(path.join(dirFor(binaryHash), 'annotations.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), edits: result.edits })}\n`, 'utf8');
    return result;
  } finally { fs.promises.unlink(input).catch(() => {}); }
}

module.exports = { analyzeAndExport, query, annotate, readMarker, heapFor, root };

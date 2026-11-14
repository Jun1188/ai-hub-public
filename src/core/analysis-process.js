'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { decode } = require('./console-text');
const children = new Map();

function safeEnv(extra = {}) {
  const allowed = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'JAVA_HOME', 'PATHEXT', 'COMSPEC'];
  const env = {};
  for (const name of allowed) if (process.env[name]) env[name] = process.env[name];
  return { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', GRAPHIFY_MAX_WORKERS: '2', ...extra };
}

function run(id, executable, args, { input, timeoutMs = 120000, env = {}, maxBytes = 32 * 1024 ** 2, windowsVerbatimArguments = false, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    if (children.has(id)) return reject(new Error('analysis_process_active'));
    const child = spawn(executable, args, { windowsHide: true, windowsVerbatimArguments,
      env: safeEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    children.set(id, child);
    if (onSpawn && child.pid) onSpawn(child.pid);
    const out = [], err = [];
    let bytes = 0, failure = null, finished = false;
    const stop = message => { failure ||= new Error(message); terminate(id); };
    const timer = setTimeout(() => stop('analysis_timeout'), timeoutMs);
    const collect = target => data => { bytes += data.length; if (bytes > maxBytes) stop('analysis_output_limit'); else target.push(data); };
    child.stdout.on('data', collect(out)); child.stderr.on('data', collect(err));
    child.stdin.on('error', () => {});
    child.on('error', error => { failure = error; finish(); });
    child.on('close', code => {
      if (!failure && code !== 0) {
        failure = new Error('analysis_process_failed: ' + decode(Buffer.concat(err)).slice(-1600));
        failure.stdout = decode(Buffer.concat(out)).slice(0, 65536); // tools such as REA report their error JSON here
      }
      finish();
    });
    function finish() {
      if (finished) return;
      finished = true; clearTimeout(timer); children.delete(id);
      if (failure) reject(failure); else resolve({ stdout: decode(Buffer.concat(out)), stderr: decode(Buffer.concat(err)) });
    }
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

function terminate(id) {
  const child = children.get(id);
  if (!child) return false;
  child.cancelRequested = true;
  if (process.platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else child.kill('SIGTERM');
  return true;
}

function pythonCandidates() {
  const home = os.homedir(), roots = [];
  if (process.env.UV_TOOL_DIR) roots.push(process.env.UV_TOOL_DIR);
  roots.push(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'uv', 'tools'));
  roots.push(path.join(home, 'AppData', 'Roaming', 'uv', 'tools'));
  if (process.env.PIPX_HOME) roots.push(path.join(process.env.PIPX_HOME, 'venvs'));
  roots.push(path.join(home, 'pipx', 'venvs'), path.join(home, '.local', 'pipx', 'venvs'));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    roots.push(path.join(require('./paths').hubStorageDir(process.env.LOCALAPPDATA), 'tools'));
  }
  const names = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  return [...roots.map(root => path.join(root, 'graphifyy', ...names)).filter(p => fs.existsSync(p)),
    process.platform === 'win32' ? 'python' : 'python3'];
}

async function detectPython(script) {
  for (const executable of pythonCandidates()) {
    try {
      const r = await run('probe-python-' + require('crypto').randomUUID(), executable, [script, '--probe'], { timeoutMs: 15000, maxBytes: 65536 });
      return { ...JSON.parse(r.stdout.trim()), executable };
    } catch (_) { /* A skill file does not prove its runtime is present. */ }
  }
  return { available: false, reason: 'graphify_runtime_missing' };
}

function detectGhidra() {
  const root = path.join(require('./paths').hubStorageDir(process.env.LOCALAPPDATA || os.tmpdir()), 'tools');
  const candidates = process.env.GHIDRA_INSTALL_DIR ? [process.env.GHIDRA_INSTALL_DIR] : [];
  try { candidates.push(...fs.readdirSync(root).filter(x => /^ghidra_[\w.]+_PUBLIC$/.test(x))
    .sort((a,b) => b.localeCompare(a, undefined, { numeric: true })).map(x => path.join(root, x))); } catch (_) {}
  for (const home of candidates) {
    const launcher = path.join(home, 'support', process.platform === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless');
    if (fs.existsSync(launcher)) return { available: true, home, launcher };
  }
  return { available: false, reason: 'ghidra_runtime_missing' };
}

function headlessCommand(runtime, args) {
  if (process.platform !== 'win32') return { executable: runtime.launcher, args };
  // cmd expands %, ! and metacharacters even inside quotes. Reject these paths, never interpolate user code.
  const quoted = [runtime.launcher, ...args].map(arg => {
    const value = String(arg);
    if (/["%!&|<>^\r\n]/.test(value)) throw new Error('unsupported_headless_path_characters');
    return '"' + value + '"';
  });
  return { executable: process.env.COMSPEC || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/s', '/c', '"' + quoted.join(' ') + '"'], windowsVerbatimArguments: true };
}
module.exports = { run, terminate, detectPython, detectGhidra, headlessCommand, safeEnv };

// Runs scripts/process-probe.ps1 against one process: `threads` streams per-thread CPU, `files` snapshots mapped files.
// On demand only (debugging tab, MCP); the continuous sampler stays per-process so it can run every 2 s.
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const paths = require('../paths');

const MAX_RUNNING = 2; // one render monitor plus one inspection; more would only pile PowerShell compiles on a busy PC
const COMPILE_MS = 15000; // Add-Type compile and PowerShell start (measured ~1.5 s idle; far slower on a pegged CPU)
let running = 0;

/** @returns {Promise<object[]>} parsed JSON lines; rejects on busy, or when nothing was measured */
function run(mode, pid, { intervalMs = 1000, count = 1, onLine } = {}) {
  if (process.platform !== 'win32') return Promise.reject(new Error('windows_only'));
  if (!Number.isInteger(pid) || pid <= 0) return Promise.reject(new Error('bad_pid'));
  if (running >= MAX_RUNNING) return Promise.reject(new Error('probe_busy'));
  running++;
  const script = path.join(paths.appRoot(), 'scripts', 'process-probe.ps1');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode,
    '-TargetPid', String(pid), '-IntervalMs', String(intervalMs), '-Count', String(count)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const out = []; let rest = '', err = '';
    const timer = setTimeout(() => { child.kill(); finish(new Error('probe_timeout')); }, COMPILE_MS + intervalMs * count);
    let done = false;
    const finish = (e) => {
      if (done) return; done = true; clearTimeout(timer); running--;
      // A target that exits or a timeout mid-capture still returns what was measured.
      const good = out.filter((o) => !o.error), failed = out.find((o) => o.error);
      if (good.length) resolve(good); else reject(e || new Error(failed?.error || err.trim().slice(0, 300) || 'probe_no_output'));
    };
    child.stdout.setEncoding('utf8'); // the script sets UTF-8 output itself, as telemetry-sampler.ps1 does
    child.stdout.on('data', (chunk) => {
      rest += chunk; const parts = rest.split(/\r?\n/); rest = parts.pop();
      for (const line of parts) {
        if (!line.trim()) continue;
        try { const o = JSON.parse(line); out.push(o); onLine?.(o); } catch { /* partial or non-JSON line */ }
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(e));
    child.on('exit', () => finish());
  });
}

module.exports = { run };

// Debugging stage 2 frame times: Intel PresentMon (MIT, installed by the user: `winget install Intel.PresentMon.Console`)
// records one process's presents over ETW. A non-admin account may trace only in the Performance Log Users group; without
// that or without PresentMon the render monitor keeps its thread and GPU-engine verdict.
'use strict';

const fs = require('fs');
const path = require('path');
const proc = require('../analysis-process');
const { findOnPath } = require('../clitools');

// Our own name: --stop_existing_session then clears only a session we orphaned (a killed PresentMon leaves it running).
const SESSION = 'AIHub_PresentMon';
// Performance Log Users, or a high/system integrity token (an elevated Hub). SIDs, because group names are localized.
const TRACE_SIDS = ['S-1-5-32-559', 'S-1-16-12288', 'S-1-16-16384'];
const round = (v) => Math.round(v * 10) / 10;

/** PresentMon console on this PC: PRESENTMON_BIN, the winget alias, PATH, then the winget package folder. */
function detect() {
  const env = process.env.PRESENTMON_BIN;
  if (env && fs.existsSync(env)) return env;
  const winget = [path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WinGet')];
  for (const root of winget) {
    const link = path.join(root, 'Links', 'presentmon.exe');
    if (fs.existsSync(link)) return link;
  }
  const onPath = findOnPath(['presentmon.exe']);
  if (onPath) return onPath;
  for (const root of winget) {
    try {
      const pkg = fs.readdirSync(path.join(root, 'Packages')).find((d) => d.startsWith('Intel.PresentMon.Console_'));
      const exe = pkg && fs.readdirSync(path.join(root, 'Packages', pkg)).find((f) => /^PresentMon.*\.exe$/i.test(f));
      if (exe) return path.join(root, 'Packages', pkg, exe);
    } catch { /* no winget packages here */ }
  }
  return null;
}

/** Pure: `whoami /groups /fo csv` output → may this token start an ETW session. */
const permitted = (text) => TRACE_SIDS.some((sid) => String(text).includes(`"${sid}"`));

let traceCheck = null;
/** Group membership changes only at sign-in, so one answer per Hub run; a failed check is retried next time. */
function canTrace() {
  traceCheck ||= proc.run('whoami-groups', path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), ['/groups', '/fo', 'csv'],
    { timeoutMs: 5000, maxBytes: 1 << 20 }).then((r) => permitted(r.stdout), () => { traceCheck = null; return false; });
  return traceCheck;
}

// v2 metrics names first, then the v1 (`--v1_metrics`, PresentMon 1.x) names for the same value.
const COLUMNS = { pid: ['ProcessID'], swap: ['SwapChainAddress'], runtime: ['PresentRuntime'], sync: ['SyncInterval'], mode: ['PresentMode'],
  frameMs: ['FrameTime', 'MsBetweenPresents'], gpuBusyMs: ['GPUBusy', 'MsGPUBusy'], gpuTimeMs: ['GPUTime', 'MsGPUTime'],
  displayed: ['DisplayedTime', 'MsUntilDisplayed'] };
// GPUBusy is the time the GPU spent working on the frame; GPUTime is GPU start to completion (busy + wait). Both are ETW
// measurements in milliseconds, not the utilisation percentage of the engine counters.
const spread = (values) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const r2 = (x) => Math.round(x * 100) / 100, rank = (q) => r2(v[Math.max(0, Math.ceil(q * v.length) - 1)]);
  return { avg: r2(v.reduce((a, b) => a + b, 0) / v.length), p50: rank(0.5), p99: rank(0.99), max: r2(v[v.length - 1]), frames: v.length };
};
// No CPUBusy: PresentMon counts from the previous Present to this one, so a frame limiter's sleep reads as busy
// (measured: wallpaper64 at 10 fps showed 99.9%). Real CPU load comes from the thread probe.

/** Pure: PresentMon CSV → one row per present of `pid`. `displayed` is null when display tracking was off. */
function parse(text, pid) {
  const lines = String(text).split(/\r?\n/);
  const h = lines.findIndex((l) => l.startsWith('Application,'));
  if (h < 0) return [];
  const header = lines[h].split(',');
  const at = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1]));
  const num = (v) => (v === undefined || v === 'NA' || v === '' ? null : Number(v));
  // shortcut: plain comma split; an Application name with a comma shifts that row's columns (exe names have none in practice)
  return lines.slice(h + 1).filter(Boolean).map((l) => l.split(',')).filter((c) => num(c[at.pid]) === pid).map((c) => ({
    swap: c[at.swap], runtime: c[at.runtime], sync: num(c[at.sync]), mode: c[at.mode] || null,
    frameMs: num(c[at.frameMs]), gpuBusyMs: num(c[at.gpuBusyMs]), gpuTimeMs: num(c[at.gpuTimeMs]),
    displayed: at.displayed < 0 ? null : c[at.displayed] !== 'NA',
  }));
}

/** Pure: present rows → frame statistics of the swap chain presenting most (a second window would skew fps). */
function summarize(rows) {
  const per = new Map();
  for (const r of rows) per.set(r.swap, (per.get(r.swap) || 0) + 1);
  const main = [...per].sort((a, b) => b[1] - a[1])[0]?.[0];
  const f = rows.filter((r) => r.swap === main && r.frameMs > 0);
  if (f.length < 2) return null;
  const ms = f.map((r) => r.frameMs).sort((a, b) => a - b), total = ms.reduce((a, b) => a + b, 0);
  const rank = (q) => round(ms[Math.max(0, Math.ceil(q * ms.length) - 1)]);
  const gpu = f.filter((r) => Number.isFinite(r.gpuBusyMs)); // share of the frame interval the GPU worked, over frames that report it
  const common = (k) => { const c = new Map(); for (const r of f) c.set(r[k], (c.get(r[k]) || 0) + 1); return [...c].sort((a, b) => b[1] - a[1])[0][0] ?? null; };
  return { frames: f.length, swapChains: per.size, fps: round(1000 * f.length / total),
    frameMs: { avg: round(total / f.length), p50: rank(0.5), p99: rank(0.99), max: round(ms[ms.length - 1]) },
    gpuBusyPercent: gpu.length ? round(100 * gpu.reduce((a, r) => a + r.gpuBusyMs, 0) / gpu.reduce((a, r) => a + r.frameMs, 0)) : null,
    // Measured GPU milliseconds per frame; null when this PresentMon build or driver reports no GPU columns (never 0).
    gpuMs: gpu.length ? { busy: spread(gpu.map((r) => r.gpuBusyMs)), total: spread(f.map((r) => r.gpuTimeMs)), basis: 'presentmon-etw' } : null,
    notDisplayed: f[0].displayed === null ? null : f.filter((r) => !r.displayed).length,
    presentMode: common('mode'), syncInterval: common('sync'), runtime: common('runtime') };
}

/** Record `seconds` of presents from `pid`. Rejects with presentmon_not_found / etw_not_permitted / no_presents or a run error. */
async function capture(pid, seconds) {
  const exe = detect();
  if (!exe) throw new Error('presentmon_not_found');
  if (!(await canTrace())) throw new Error('etw_not_permitted');
  const r = await proc.run('presentmon', exe, ['--process_id', String(pid), '--output_stdout', '--no_console_stats', '--no_track_input',
    '--timed', String(seconds), '--terminate_after_timed', '--terminate_on_proc_exit', '--session_name', SESSION, '--stop_existing_session'],
  { timeoutMs: (seconds + 15) * 1000, maxBytes: 16 * 1024 ** 2 });
  const frames = summarize(parse(r.stdout, pid));
  if (!frames) throw new Error('no_presents');
  return frames;
}

module.exports = { capture, detect, canTrace, permitted, parse, summarize };

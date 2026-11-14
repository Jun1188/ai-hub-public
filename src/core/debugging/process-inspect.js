// Debugging stage 3: what one process holds right now — its hardware use, busiest threads, and the files it has mapped with
// how fast each is being paged into RAM. This names the file behind a paging culprit: mapped reads never reach IO counters.
'use strict';

const os = require('os');
const probe = require('./probe');
const threads = require('./threads');
const analysis = require('../telemetry-analysis');

const HOME = os.homedir();
const round = (v) => Math.round(v * 10) / 10;

/** The user profile becomes %USERPROFILE%: results also go to external AI callers over MCP (rule 10). */
function maskPath(p) {
  return HOME && String(p).toLowerCase().startsWith(HOME.toLowerCase()) ? `%USERPROFILE%${String(p).slice(HOME.length)}` : String(p);
}

/** Pure: two file snapshots → bytes/s each file gained in RAM, fastest first, then largest resident. */
function fileGrowth(before, after, top = 15) {
  const prev = new Map((before?.files || []).map((f) => [f.path, f.resident]));
  // The probe lists the top files by resident size; a file absent from a complete list had nothing resident.
  const complete = before && before.fileCount <= (before.files || []).length;
  const dt = before ? Math.max(0.001, (after.t - before.t) / 1000) : null;
  return (after.files || []).map((f) => {
    const was = prev.has(f.path) ? prev.get(f.path) : complete ? 0 : null;
    return { path: maskPath(f.path), image: f.image, mappedBytes: f.mapped, residentBytes: f.resident,
      growthBytesPerSec: was === null || dt === null ? null : Math.max(0, Math.round((f.resident - was) / dt)) };
  }).sort((a, b) => (b.growthBytesPerSec || 0) - (a.growthBytesPerSec || 0) || b.residentBytes - a.residentBytes).slice(0, top);
}

/** Pure: the process's rows in the continuous record → usage plus hard faults. */
function hardware(samples, pid) {
  const rows = samples.map((s) => (s.procs || []).find((p) => p.p === pid));
  const last = rows.filter(Boolean).at(-1);
  // An older record has no identity field. Keep that format readable without joining it to a known lifetime.
  const scoped = samples.map((s, i) => {
    const row = rows[i];
    const same = row && (last.started === null ? row === last : row.started === last.started);
    return { ...s, procs: same ? [row] : [] };
  });
  const processRows = scoped.flatMap((s) => s.procs);
  const hf = processRows.map((p) => p.hf).filter((v) => Number.isFinite(v) && v >= 0);
  const counter = processRows.filter(p => Number.isInteger(p.hfBefore) && Number.isInteger(p.hfCount) &&
    p.hfBefore >= 0 && p.hfCount >= p.hfBefore && Number.isFinite(p.hfIntervalMs) && p.hfIntervalMs > 0).at(-1);
  return { ...analysis.usage(scoped, new Set([pid])),
    hardFaultObservation: counter ? { pid, started: counter.started, previous: counter.hfBefore, current: counter.hfCount,
      delta: counter.hfCount - counter.hfBefore, intervalMs: counter.hfIntervalMs, source: 'SYSTEM_PROCESS_INFORMATION.HardFaultCount' } : null,
    hardFaultsPerSec: hf.length ? { avg: round(hf.reduce((a, v) => a + v, 0) / hf.length), peak: round(Math.max(...hf)) } : null };
}

async function files(pid) {
  try { return { snap: (await probe.run('files', pid))[0] }; } catch (e) { return { error: e.message }; }
}

/** Inspect one process for `seconds`: file snapshot, thread capture, file snapshot, and the record of the same window. */
async function inspect({ pid, seconds = 5, expectedStart = null } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { error: 'bad_pid' };
  const telemetry = require('../telemetry'), devtools = require('../devtools'); // lazy: tests use the pure parts only
  const ctx = telemetry.context();
  const since = Date.now();
  const before = await files(pid);
  if (expectedStart && before.snap?.started !== expectedStart) {
    return { error: before.snap?.started ? 'process_replaced' : 'process_start_unverified' };
  }
  let threadSamples = [], threadError = null;
  try { threadSamples = await probe.run('threads', pid, { count: Math.max(2, Math.min(30, Math.round(seconds))) }); } catch (e) { threadError = e.message; }
  const after = await files(pid);
  const samples = await telemetry.window({ since, until: Date.now() });
  const observed = [before.snap, ...threadSamples, after.snap, ...samples.flatMap((s) => (s.procs || []).filter((p) => p.p === pid))];
  const lifetimes = new Set(observed.map((p) => p?.started).filter(Boolean));
  if (lifetimes.size > 1) return { error: 'process_replaced' };
  if (expectedStart && (!after.snap || observed.some(p => p && p.started !== expectedStart))) return { error: 'process_start_unverified' };
  const row = [...samples].reverse().flatMap((s) => s.procs || []).find((p) => p.p === pid);
  if (!row && !threadSamples.length && !after.snap) return { error: threadError || after.error || 'process_not_found' };
  const r = row ? ctx.roleOf?.(row, ctx.parents) : null, o = analysis.owner(pid, ctx);
  const list = threads.aggregate(threadSamples, r?.app === 'unreal' || r?.app === 'unity');
  return {
    process: { pid, name: row?.n || null, app: r?.app || (o ? o.kind : analysis.classify(row?.n)), role: r?.role || null, job: o?.job || null },
    seconds: Math.round((Date.now() - since) / 1000), hardware: hardware(samples, pid),
    threads: list.slice(0, 10), roles: threads.byRole(list), ...(threadError ? { threadError } : {}),
    // open_failed: the process runs elevated or protected; the Hub never asks for admin to look inside it.
    files: after.snap ? fileGrowth(before.snap, after.snap) : null, fileCount: after.snap?.fileCount ?? null, ...(after.error ? { filesError: after.error } : {}),
  };
}

module.exports = { inspect, fileGrowth, hardware, maskPath };

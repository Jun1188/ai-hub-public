// Continuous per-process hardware record: one below-normal PDH sampler + one streaming nvidia-smi.
// Keeps 30 min at full rate in memory and 10-second buckets for 2 days under %LOCALAPPDATA% (device-only, never shared).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const paths = require('./paths');
const analysis = require('./telemetry-analysis');
const devtools = require('./devtools');

const INTERVAL_MS = 2000;
const RING_MS = 30 * 60 * 1000;
const BUCKET_MS = 10 * 1000;
const RETAIN_MS = 2 * 24 * 3600 * 1000;
const IDLE_STOP_MS = 2 * 60 * 1000; // non-Electron processes (stdio MCP) stop sampling when nobody asks
const NV_FIELDS = 'index,utilization.gpu,memory.used,memory.total,power.draw,enforced.power.limit,clocks.sm,clocks.max.sm,clocks.mem,pstate,temperature.gpu';

const events = new EventEmitter();
const ring = [];
const registry = new Map(); // pid -> { jobId, kind, label }
const jobs = new Map(); // jobId -> { jobId, kind, label, start, end, outcome }
const parents = new Map();
let sampler = null, nvidia = null, nvLatest = null, nvFields = `${NV_FIELDS},clocks_event_reasons.active,name`;
let keepAlive = false, lastUse = 0, failures = 0, blockedUntil = 0, idleTimer = null, bucket = [], lastError = null;

const dataDir = () => path.join(require('./paths').hubStorageDir(process.env.LOCALAPPDATA || path.join(paths.HOME, 'AppData', 'Local')), 'telemetry.local');
const ctx = () => ({ hubPid: process.pid, registry, parents, roleOf: devtools.roleOf });

// Samplers never keep a short-lived process (tests, CLI) alive; the desktop Hub and stdio server stay up on their own.
function detach(child) { child.unref(); for (const s of [child.stdout, child.stderr]) s?.unref?.(); }

function lines(stream, onLine) {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    rest += chunk;
    const parts = rest.split(/\r?\n/); rest = parts.pop();
    for (const line of parts) if (line.trim()) onLine(line);
  });
}

function startNvidia() {
  const gpufit = require('./gpufit');
  const child = spawn(gpufit._internals.commandFor('nvidia-smi'), [`--query-gpu=${nvFields}`, '--format=csv,noheader,nounits', `-lms`, String(INTERVAL_MS)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  nvidia = child; detach(child);
  let produced = false;
  const fields = nvFields.split(','), devices = new Map();
  lines(child.stdout, (line) => {
    const v = line.split(',').map((x) => x.trim()), num = (x) => (/^-?\d+(\.\d+)?$/.test(x) ? Number(x) : null);
    if (v.length < fields.length) return;
    const f = (name) => v[fields.indexOf(name)];
    produced = true;
    // The name is last and may itself contain commas.
    devices.set(f('index'), { index: num(f('index')), util: num(f('utilization.gpu')), memUsedMiB: num(f('memory.used')), memTotalMiB: num(f('memory.total')),
      powerW: num(f('power.draw')), powerLimitW: num(f('enforced.power.limit')), smMHz: num(f('clocks.sm')), smMaxMHz: num(f('clocks.max.sm')),
      memMHz: num(f('clocks.mem')), pstate: f('pstate'), tempC: num(f('temperature.gpu')),
      reasons: analysis.throttleReasons(f('clocks_event_reasons.active')), name: v.slice(fields.length - 1).join(',') });
    nvLatest = { t: Date.now(), devices: [...devices.values()] };
  });
  child.on('error', () => {});
  child.on('exit', () => {
    if (nvidia === child) nvidia = null;
    // Older drivers reject clocks_event_reasons: retry once without it; no GPU or no driver: stay off.
    if (!produced && nvFields.includes('clocks_event_reasons')) { nvFields = `${NV_FIELDS},name`; if (sampler) startNvidia(); }
  });
}

function onSample(line) {
  let s;
  try { s = JSON.parse(line); } catch { return; }
  if (s.error) { lastError = s.error; return; }
  if (s.editors) { devtools.updateEditors(s.editors); return; }
  failures = 0;
  if (nvLatest && Date.now() - nvLatest.t < 3 * INTERVAL_MS) s.nv = nvLatest.devices;
  for (const p of s.procs || []) if (p.pp) parents.set(p.p, p.pp);
  if (registry.size) for (const p of s.procs || []) {
    const o = analysis.owner(p.p, ctx());
    if (o?.job) { const job = jobs.get(o.job); if (job) (job.pids || (job.pids = new Set())).add(p.p); }
  }
  ring.push(s);
  while (ring.length && s.t - ring[0].t > RING_MS) ring.shift();
  bucket.push(s);
  if (s.t - bucket[0].t >= BUCKET_MS) flush();
  devtools.poll();
  events.emit('sample', s);
}

function flush() {
  const rows = bucket; bucket = [];
  if (!rows.length) return;
  // Keep the busiest moment of the bucket plus averages; full-rate detail stays in memory only.
  const peak = rows.reduce((a, b) => (busiestOf(b) >= busiestOf(a) ? b : a));
  const record = { ...peak, t: rows[0].t, t1: rows[rows.length - 1].t, cpuAvg: rows.reduce((a, r) => a + (r.cpu || 0), 0) / rows.length,
    procs: [...(peak.procs || [])].sort((a, b) => weight(b) - weight(a)).slice(0, 20) };
  const dir = dataDir(), file = path.join(dir, `${new Date(record.t).toISOString().slice(0, 13).replace(/[-T]/g, '')}.jsonl`);
  fs.promises.mkdir(dir, { recursive: true }).then(() => fs.promises.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')).catch(() => {});
}
const busiestOf = (s) => Math.max(s.cpu || 0, ...(s.adapters || []).flatMap((a) => Object.values(a.eng || {})));
// 100 hard faults/s weigh like 1% CPU, so a process paging a model in keeps its row in the bucket (measured ~3,000/s).
const weight = (p) => p.c + Math.max(0, ...Object.values(p.g || {})) + (p.vd + p.vs) / 2 ** 28 + (p.hf || 0) / 100;

function start() {
  if (sampler || process.platform !== 'win32' || Date.now() < blockedUntil) return;
  const script = path.join(paths.appRoot(), 'scripts', 'telemetry-sampler.ps1');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-IntervalMs', String(INTERVAL_MS), '-ParentPid', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  sampler = child; detach(child);
  lines(child.stdout, onSample);
  child.stderr.on('data', (d) => { lastError = String(d).slice(0, 300); });
  child.on('error', (e) => { lastError = e.message; });
  child.on('exit', (code) => {
    if (sampler !== child) return;
    sampler = null; flush();
    if (nvidia) { nvidia.kill(); nvidia = null; }
    // Circuit breaker (rule 9): three unexpected exits in a row pause sampling for 10 minutes.
    if (code !== 0 && ++failures >= 3) { blockedUntil = Date.now() + 10 * 60 * 1000; failures = 0; }
    if (keepAlive || Date.now() - lastUse < IDLE_STOP_MS) setTimeout(start, 3000).unref();
  });
  startNvidia();
}

function stop() {
  keepAlive = false;
  const child = sampler; sampler = null;
  if (child) child.kill();
  if (nvidia) { nvidia.kill(); nvidia = null; }
  flush();
}

/** Called by consumers; starts sampling on demand and stops it after idle unless the desktop Hub keeps it alive. */
function touch() {
  lastUse = Date.now(); start();
  if (keepAlive) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!keepAlive && Date.now() - lastUse >= IDLE_STOP_MS) stop(); }, IDLE_STOP_MS + 1000);
  idleTimer.unref();
}

function latest(maxAgeMs = 3 * INTERVAL_MS) {
  touch();
  const s = ring[ring.length - 1];
  return s && Date.now() - s.t <= maxAgeMs ? s : null;
}

/** Recent samples with the current Hub pid context, for admission rules. */
function recent(count) { touch(); return ring.slice(-count); }

function trackProcess(pid, meta = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  registry.set(pid, { jobId: meta.jobId || null, kind: meta.kind || 'hub-job', label: String(meta.label || meta.kind || '').slice(0, 80) });
}

function beginJob(jobId, meta = {}) {
  touch();
  const job = { jobId: String(jobId), kind: meta.kind || 'job', label: String(meta.label || meta.kind || jobId).slice(0, 80), start: Date.now(), end: null, outcome: null };
  jobs.set(job.jobId, job);
  if (Number.isInteger(meta.pid)) trackProcess(meta.pid, { ...job, jobId: job.jobId });
  events.emit('job', job);
  return job;
}

/** Ends a job and returns its process-tree usage (null when the sampler had no data for it). */
function endJob(jobId, outcome = 'finished') {
  const job = jobs.get(String(jobId));
  if (!job) return null;
  job.end = Date.now(); job.outcome = outcome;
  const inJob = ring.filter((s) => s.t >= job.start - INTERVAL_MS && s.t <= job.end + INTERVAL_MS);
  const result = inJob.length ? analysis.summarize(inJob, [job], ctxFor([job])).jobs[0] || null : null;
  for (const [pid, meta] of registry) if (meta.jobId === job.jobId) registry.delete(pid);
  while (jobs.size > 200) jobs.delete(jobs.keys().next().value);
  events.emit('job', job);
  return result;
}
// Finished jobs keep the pids they owned so later reports still attribute them (pid reuse within one window is ignored).
function ctxFor(list) {
  const map = new Map(registry);
  for (const job of list) for (const pid of job.pids || []) if (!map.has(pid)) map.set(pid, job);
  return { ...ctx(), registry: map };
}

async function persisted(since, until) {
  const out = [];
  let names = [];
  try { names = await fs.promises.readdir(dataDir()); } catch { return out; }
  const first = new Date(since).toISOString().slice(0, 13).replace(/[-T]/g, '');
  for (const name of names.filter((n) => /^\d{10}\.jsonl$/.test(n) && n.slice(0, 10) >= first).sort()) {
    const text = await fs.promises.readFile(path.join(dataDir(), name), 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { const r = JSON.parse(line); if (r.t >= since && r.t <= until) out.push(r); } catch { /* torn last line */ }
    }
  }
  return out;
}

/** Samples in [since, until]: full rate from memory, 10-second buckets from disk for older ranges. */
async function window({ since = Date.now() - 10 * 60 * 1000, until = Date.now() } = {}) {
  touch();
  const memStart = ring.length ? ring[0].t : Infinity;
  const older = since < memStart ? await persisted(since, Math.min(until, memStart - 1)) : [];
  return [...older, ...ring.filter((s) => s.t >= since && s.t <= until)];
}

async function report({ sinceSeconds = 600, jobId = null, top = 6 } = {}) {
  const job = jobId ? jobs.get(String(jobId)) : null;
  if (jobId && !job) return { error: 'unknown_job', jobs: [...jobs.values()].slice(-10).map(({ jobId: id, kind, label }) => ({ jobId: id, kind, label })) };
  const since = job ? job.start - INTERVAL_MS : Date.now() - sinceSeconds * 1000, until = job?.end ? job.end + INTERVAL_MS : Date.now();
  const samples = await window({ since, until });
  const overlapping = [...jobs.values()].filter((j) => j.start <= until && (j.end || Infinity) >= since);
  const dev = await devtools.summarize(samples, { since, until, parents });
  return { ...analysis.summarize(samples, overlapping, ctxFor(overlapping), { top }), ...(dev.length ? { dev } : {}), sampler: status() };
}

async function exportTrace({ sinceSeconds = 600 } = {}) {
  const since = Date.now() - sinceSeconds * 1000, samples = await window({ since });
  if (!samples.length) return { error: 'no_samples', sampler: status() };
  const dir = path.join(path.dirname(dataDir()), 'traces');
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `hub-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), tmp = `${file}.tmp`;
  const recentJobs = [...jobs.values()].filter((j) => (j.end || Infinity) >= since);
  const trace = analysis.trace(samples, recentJobs, ctxFor(recentJobs));
  trace.traceEvents.push(...devtools.traceEvents(since, Date.now()));
  await fs.promises.writeFile(tmp, JSON.stringify(trace), 'utf8');
  await fs.promises.rename(tmp, file);
  return { file, samples: samples.length, open: 'Drag the file into https://ui.perfetto.dev (parsed in the browser; nothing is uploaded).' };
}

async function prune() {
  const cutoff = new Date(Date.now() - RETAIN_MS).toISOString().slice(0, 13).replace(/[-T]/g, '');
  let names = [];
  try { names = await fs.promises.readdir(dataDir()); } catch { return; }
  await Promise.all(names.filter((n) => /^\d{10}\.jsonl$/.test(n) && n.slice(0, 10) < cutoff).map((n) => fs.promises.unlink(path.join(dataDir(), n)).catch(() => {})));
}

function status() {
  return { running: Boolean(sampler), intervalMs: INTERVAL_MS, samplesInMemory: ring.length, nvidia: Boolean(nvLatest && Date.now() - nvLatest.t < 3 * INTERVAL_MS),
    pausedUntil: blockedUntil > Date.now() ? blockedUntil : null, lastError, logicalCores: os.cpus().length };
}

/** Desktop Hub: sample continuously for the whole session. */
function keepRunning() {
  keepAlive = true; start();
  prune();
  setInterval(prune, 6 * 3600 * 1000).unref();
}

module.exports = { start, stop, keepRunning, latest, recent, trackProcess, beginJob, endJob, window, report, exportTrace, status, events, context: ctx,
  foregroundGpuPercent: (s) => analysis.foregroundGpuPercent(s, ctx()),
  _test: { onSample, flush, ring, jobs, registry, parents, dataDir, disableSampler: () => { blockedUntil = Infinity; } } };

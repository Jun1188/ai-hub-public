// Shared, read-only measurements for the desktop and authenticated MCP clients.
// Reads the continuous telemetry sampler; falls back to one nvidia-smi call while it is starting or unavailable.
'use strict';
const os = require('os');
const { execFile } = require('child_process');
const { decode } = require('./console-text');
const gpufit = require('./gpufit');
const telemetry = require('./telemetry');
const SAMPLE_MS = 5000;
const MIB = 1024 ** 2;
let previousCpu = null;
let cached = null;
let pending = null;
let failures = 0;
let retryAt = 0;

function cpuSample() {
  const cpus = os.cpus();
  const total = cpus.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0);
  const idle = cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);
  const delta = previousCpu && total - previousCpu.total;
  const usagePercent = delta > 0 ? Math.max(0, Math.min(100, 100 * (1 - (idle - previousCpu.idle) / delta))) : null;
  previousCpu = { total, idle };
  return { logicalCores: cpus.length, usagePercent };
}

function gpuSample() {
  if (Date.now() < retryAt) return Promise.resolve({ available: false, reason: 'probe_cooldown', retryAt });
  return new Promise(resolve => {
    execFile(gpufit._internals.commandFor('nvidia-smi'), [
      '--query-gpu=index,name,utilization.gpu,memory.total,memory.used,temperature.gpu',
      '--format=csv,noheader,nounits',
    ], { timeout: 3000, windowsHide: true, encoding: 'buffer', maxBuffer: 65536 }, (error, stdout) => {
      if (error) {
        if (++failures >= 3) retryAt = Date.now() + 60000;
        return resolve({ available: false, reason: 'nvidia_probe_unavailable' });
      }
      failures = 0;
      retryAt = 0;
      const numeric = value => /^\d+(\.\d+)?$/.test(value) ? Number(value) : null;
      const devices = decode(stdout).trim().split(/\r?\n/).filter(Boolean).map(line => {
        const [index, name, utilization, total, used, temperature] = line.split(',').map(x => x.trim());
        return { index: numeric(index), name, usagePercent: numeric(utilization),
          totalMiB: numeric(total), usedMiB: numeric(used), temperatureC: numeric(temperature) };
      });
      resolve({ available: devices.length > 0, devices });
    });
  });
}

// busyPercent excludes desktop background (wallpaper, dwm) and the Hub's own jobs: a single raw NVML
// sample read 15–57% on an idle desktop because of Wallpaper Engine, which blocked local models.
function gpuFromTelemetry(live) {
  const busy = telemetry.foregroundGpuPercent(live);
  const devices = live.nv.map(d => ({ index: d.index, name: d.name, usagePercent: d.util, busyPercent: busy,
    totalMiB: d.memTotalMiB, usedMiB: d.memUsedMiB, temperatureC: d.tempC, powerW: d.powerW, powerLimitW: d.powerLimitW,
    smMHz: d.smMHz, smMaxMHz: d.smMaxMHz, pstate: d.pstate, throttleReasons: d.reasons,
    sharedUsedMiB: Math.round((live.adapters || []).reduce((a, x) => a + x.sh, 0) / MIB) }));
  return { available: devices.length > 0, devices, source: 'telemetry' };
}

// PhysicalDisk instances look like "0 C:" or "1 D: E:"; admission looks drives up by letter.
function storageFromTelemetry(live) {
  const devices = [];
  for (const d of live.disks || []) for (const letter of String(d.n).match(/[A-Z]:/gi) || [])
    devices.push({ name: letter.toUpperCase(), usagePercent: d.busy, queueLength: d.q ?? 0, bytesPerSecond: d.r + d.w, latencyMs: d.latMs });
  if (devices.length) devices.push({ name: '_Total', usagePercent: Math.max(...devices.map(d => d.usagePercent)),
    queueLength: devices.reduce((a, d) => a + d.queueLength, 0), bytesPerSecond: (live.disks || []).reduce((a, d) => a + d.r + d.w, 0) });
  return { available: devices.length > 0, devices, source: 'telemetry' };
}

function topProcesses(live, limit = 8) {
  const { classify } = require('./telemetry-analysis');
  const score = p => Math.max(p.c, ...Object.values(p.g || {})) + (p.vd + p.vs) / (64 * MIB);
  return [...(live.procs || [])].sort((a, b) => score(b) - score(a)).slice(0, limit).map(p => ({ pid: p.p, name: p.n, app: classify(p.n),
    cpuPercent: p.c, privateMiB: Math.round(p.m / MIB), gpuPercent: p.g, vramMiB: Math.round(p.vd / MIB), sharedVramMiB: Math.round(p.vs / MIB) }));
}

async function snapshot({ force = false } = {}) {
  if (pending) return pending;
  if (!force && cached && Date.now() - cached.sampledAt < SAMPLE_MS) return cached;
  pending = (async () => {
    const cpu = cpuSample();
    const live = telemetry.latest();
    if (live && Number.isFinite(live.cpu)) cpu.usagePercent = Math.min(100, live.cpu);
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const gpu = live?.nv?.length ? gpuFromTelemetry(live) : await gpuSample();
    const storage = live ? storageFromTelemetry(live) : { available: false, reason: 'telemetry_starting' };
    cached = { sampledAt: Date.now(), sampleIntervalMs: SAMPLE_MS, cpu,
      ram: { totalBytes, usedBytes: totalBytes - freeBytes, usagePercent: 100 * (1 - freeBytes / totalBytes),
        commitBytes: live?.mem?.commit ?? null, commitLimitBytes: live?.mem?.limit ?? null,
        pagesInputPerSec: Number.isFinite(live?.mem?.pagesIn) && live.mem.pagesIn >= 0 ? live.mem.pagesIn : null,
        hardFaultsPerSec: null },
      hub: { rssBytes: process.memoryUsage().rss }, gpu, storage,
      processes: live ? topProcesses(live) : [],
      scope: 'system-wide; per-process rows and gpu.busyPercent come from Windows GPU/process counters',
      telemetry: telemetry.status(),
      modelFit: gpufit.lastAssessment(),
      modelOperations:require('./model-control').list().map(r=>({requestId:r.requestId,provider:r.provider,model:r.model,state:r.state,phase:r.phase,admission:r.admission||null,error:r.error||null})) };
    return cached;
  })();
  try { return await pending; } finally { pending = null; }
}

/** 마지막 측정값만 돌려준다(I/O 없음). 뜨거운 경로용. 아직 못 쟀으면 null. */
function peek() { return cached; }

/** Compact recent history from the telemetry ring (one row per sample). */
function history(limit = 120) {
  return telemetry.recent(limit).map(s => ({ sampledAt: s.t, cpu: s.cpu, ramAvailableBytes: s.mem?.avail ?? null,
    gpu: (s.nv || []).map(d => ({ index: d.index, usagePercent: d.util, usedMiB: d.memUsedMiB, powerW: d.powerW })),
    gpuBusyPercent: telemetry.foregroundGpuPercent(s) }));
}

module.exports = { snapshot, peek, history };

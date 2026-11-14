#!/usr/bin/env node
// Telemetry: attribution, job usage, findings, Perfetto trace and admission fixes on synthetic samples (no sampler process).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-telemetry-'));
process.env.LOCALAPPDATA = root;
const analysis = require('../src/core/telemetry-analysis');
const telemetry = require('../src/core/telemetry');
const { assess } = require('../src/core/model-admission');
telemetry._test.disableSampler();

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); } };
const MIB = 1024 ** 2;
const proc = (p, n, extra = {}) => ({ p, pp: 0, n, c: 0, m: 50 * MIB, r: 0, w: 0, vd: 0, vs: 0, g: {}, ...extra });
const sample = (t, procs, extra = {}) => ({ t, cpu: 10, mem: { avail: 8e9, commit: 1e10, limit: 3e10, pagesIn: 0 }, disks: [{ n: '0 C:', busy: 5, r: 0, w: 0, latMs: 1, q: 0 }],
  net: { rx: 0, tx: 0 }, adapters: [{ luid: 'a', ded: 2e9, sh: 1e8, eng: { '3D': 20 } }], procs, ...extra });

// classification and decoding
check('classify apps', analysis.classify('UnrealEditor') === 'unreal' && analysis.classify('ShaderCompileWorker.exe') === 'unreal'
  && analysis.classify('wallpaper64') === 'background' && analysis.classify('LM Studio') === 'lmstudio' && analysis.classify('notepad') === 'other');
check('throttle bits', analysis.throttleReasons('0x0000000000000004').join() === 'sw_power_cap' && analysis.throttleReasons('0x88').join() === 'hw_slowdown,hw_thermal');

// foreground GPU ignores wallpaper/dwm and Hub-owned processes
const ctx = { hubPid: 100, registry: new Map([[300, { jobId: 'j1', kind: 'offload', label: 'job one' }]]), parents: new Map([[200, 100], [301, 300]]) };
const busy = sample(0, [proc(10, 'wallpaper64', { g: { '3D': 19 } }), proc(11, 'dwm', { g: { '3D': 3 } }), proc(200, 'java', { g: { Compute_0: 50 } }),
  proc(301, 'llama-server', { g: { Compute: 40 } }), proc(400, 'UnrealEditor', { g: { '3D': 30 } })]);
check('foreground GPU excludes background and Hub jobs', analysis.foregroundGpuPercent(busy, ctx) === 30, String(analysis.foregroundGpuPercent(busy, ctx)));
check('owner walks parents to a job', analysis.owner(301, ctx)?.job === 'j1' && analysis.owner(200, ctx)?.kind === 'hub' && analysis.owner(400, ctx) === null);

// usage integrates over time and attributes only the process set
const run = [0, 2000, 4000, 6000].map((t) => sample(t, [proc(301, 'llama-server', { c: 8, r: 1e6, vd: 3e9, vs: t >= 4000 ? 600 * MIB : 0, g: { Compute: 60 } }),
  proc(400, 'UnrealEditor', { c: 20, g: { '3D': 40 } })]));
const u = analysis.usage(run, new Set([301]));
check('process-set usage', u.cpuPercent.avg === 8 && u.gpuPercent.Compute.avg === 60 && u.ioReadBytes === 8e6 && u.sharedVramPeakBytes === 600 * MIB,
  JSON.stringify(u));

// findings: spill, contention, throttle, paging; idle has none
const long = Array.from({ length: 8 }, (_, i) => sample(i * 2000, [proc(301, 'llama-server', { vs: 512 * MIB, g: { Compute: 70 } }), proc(400, 'UnrealEditor', { vs: 512 * MIB, g: { '3D': 45 } })],
  { nv: [{ util: 95, reasons: ['sw_power_cap'], powerW: 160, memUsedMiB: 7900, memTotalMiB: 8188 }], mem: { avail: 1e9, pagesIn: 900 } }));
const kinds = analysis.findings(long, ctx).map((f) => f.kind);
check('findings detect spill, contention, throttle, paging', ['vram_spill', 'gpu_contention', 'gpu_throttle', 'paging'].every((k) => kinds.includes(k)), kinds.join());
// paging: names the biggest reader, separates RAM pressure from file loading, a short dip does not split the span,
// and a short burst with RAM free (app start-up, scan) is not reported
const updating = Array.from({ length: 36 }, (_, i) => sample(i * 2000, [proc(20, 'ChatGPT', { r: 5e4 }), proc(21, 'SetupHost', { r: i === 3 ? 0 : 5e7 })],
  { mem: { avail: 11e9, pagesIn: i === 3 ? 100 : 8000 } }));
const paged = analysis.findings(updating, ctx).filter((f) => f.kind === 'paging');
check('paging with free RAM is one span; old records fall back to the reader', paged.length === 1 && paged[0].seconds === 70
  && paged[0].basis === 'io-read' && paged[0].culprits[0].name === 'SetupHost'
  && paged[0].availMinMiB === Math.round(11e9 / MIB) && /not memory pressure/.test(paged[0].note), JSON.stringify(paged));
// A memory-mapped model load has no IO Read on its process (measured): hard faults must win over a busy file reader.
const mapped = updating.map((s) => ({ ...s, procs: [proc(30, 'chrome', { r: 4e6 }), proc(31, 'llama-server', { hf: 3000 }), proc(32, 'MsMpEng', { hf: 30 })] }));
const byFaults = analysis.findings(mapped, ctx).find((f) => f.kind === 'paging');
check('paging names the hard-faulting process, not the reader', byFaults?.basis === 'hard-faults' && byFaults.culprits[0].name === 'llama-server'
  && byFaults.culprits[0].share === 0.99 && byFaults.culprits.length === 2, JSON.stringify(byFaults?.culprits));
for (const hf of [null, 0]) {
  const samples = updating.map((s) => ({ ...s, procs: [proc(30, 'busy-reader', { r: 4e6, hf })] }));
  const finding = analysis.findings(samples, ctx).find((f) => f.kind === 'paging');
  check('paging never substitutes unrelated IO for ' + (hf === null ? 'unmeasured faults' : 'measured zero'),
    finding?.basis === (hf === null ? 'hard-faults-unavailable' : 'hard-faults') && finding.culprits.length === 0);
}
const pegged = [0, 2000, 4000, 6000, 8000, 10000, 12000].map((t) => sample(t, [proc(40, 'ShaderCompileWorker', { c: 70 }), proc(41, 'chrome', { c: 25 })], { cpu: 97 }));
const cpuFinding = analysis.findings(pegged, { ...ctx, roleOf: (p) => (p.n === 'ShaderCompileWorker' ? { app: 'unreal', role: 'shader-compile' } : null) })
  .find((f) => f.kind === 'cpu_saturation');
check('cpu saturation ranks processes with their engine role', cpuFinding?.culprits[0].role === 'shader-compile' && cpuFinding.culprits[0].share === 0.74
  && /\[shader-compile\] 74%/.test(cpuFinding.culprits[0].label), JSON.stringify(cpuFinding?.culprits));
check('short paging burst with free RAM is not reported', !analysis.findings(updating.slice(0, 8), ctx).some((f) => f.kind === 'paging'));
check('paging with little free RAM says RAM is short', /RAM is short/.test(analysis.findings(long, ctx).find((f) => f.kind === 'paging').note));
const roomy = long.map((s) => ({ ...s, nv: [{ ...s.nv[0], memUsedMiB: 2000 }] }));
check('shared VRAM with free dedicated VRAM is not a spill', !analysis.findings(roomy, ctx).some((f) => f.kind === 'vram_spill'));
check('idle desktop has no findings', analysis.findings([0, 2000, 4000, 6000, 8000, 10000, 12000].map((t) => sample(t, [proc(10, 'wallpaper64', { g: { '3D': 19 } })])), ctx).length === 0);

// summary: jobs and top processes
const sum = analysis.summarize(long, [{ jobId: 'j1', kind: 'offload', label: 'job one', start: 0, end: 14000 }], ctx);
check('summary attributes the job to its process tree', sum.jobs[0].processes === 1 && sum.jobs[0].scope === 'process-tree' && sum.jobs[0].gpuBoard.energyWh > 0);
check('summary lists top processes with owner', sum.processes.some((p) => p.pid === 301 && p.job === 'j1') && sum.processes.some((p) => p.app === 'unreal'));

// Perfetto trace shape
const tr = analysis.trace(long, [{ jobId: 'j1', kind: 'offload', label: 'job one', start: 0, end: 14000 }], ctx);
const ph = new Set(tr.traceEvents.map((e) => e.ph));
check('trace has metadata, counters and job slice', ph.has('M') && ph.has('C') && ph.has('X') && tr.traceEvents.every((e) => Number.isInteger(e.pid)));
check('trace job duration in microseconds', tr.traceEvents.find((e) => e.ph === 'X').dur === 14000 * 1000);

// module: parsing, job lifecycle from the ring, bucket persistence
const now = Date.now();
telemetry._test.onSample('not json');
telemetry._test.onSample(JSON.stringify({ error: 'pdh_collect_failed' }));
const child = 5555;
telemetry.trackProcess(child, { jobId: 'job-x', kind: 'analysis', label: 'ghidra' });
telemetry._test.jobs.set('job-x', { jobId: 'job-x', kind: 'analysis', label: 'ghidra', start: now - 1000, end: null, outcome: null });
for (let i = 0; i < 6; i++) telemetry._test.onSample(JSON.stringify(sample(now + i * 2000, [proc(child, 'java', { c: 16, m: 900 * MIB }), proc(6000, 'decompile', { pp: child, c: 4 })])));
check('bad lines and sampler errors are ignored', telemetry._test.ring.length === 6);
const jobUsage = telemetry.endJob('job-x', 'succeeded');
check('endJob returns process-tree usage including children', jobUsage && jobUsage.processes === 2 && jobUsage.cpuPercent.peak === 20, JSON.stringify(jobUsage));
check('finished job releases its pids', !telemetry._test.registry.has(child));
telemetry._test.flush();
setTimeout(() => {
  const dir = telemetry._test.dataDir();
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  check('10-second bucket persisted under LOCALAPPDATA', files.length === 1 && /^\d{10}\.jsonl$/.test(files[0]), files.join());

  // admission fixes: AC key, cpu-only heavy apps, background-excluded GPU busy
  const snapshot = { sampledAt: Date.now(), cpu: { usagePercent: 5 }, ram: { totalBytes: 32 * 1024 ** 3, usedBytes: 8 * 1024 ** 3 },
    gpu: { devices: [{ totalMiB: 8188, usedMiB: 1300, usagePercent: 55, busyPercent: 3 }] } };
  const env = (extra = {}) => ({ at: Date.now(), failures: 0, retryAt: 0, heavyApps: [], onAcPower: true, ...extra });
  const target = { sizeBytes: 4 * 1024 ** 3 };
  check('GPU busy uses busyPercent (wallpaper excluded)', assess({ snapshot, environment: env(), policy: {}, target }).admitted === true);
  check('raw busy GPU still defers', assess({ snapshot: { ...snapshot, gpu: { devices: [{ totalMiB: 8188, usedMiB: 1300, usagePercent: 55, busyPercent: 60 }] } },
    environment: env(), policy: {}, target }).reason === 'gpu_busy');
  check('requireAcPowerForLocal=false is honored', assess({ snapshot, environment: env({ onAcPower: false }), policy: { admission: { requireAcPowerForLocal: false } }, target }).admitted === true);
  const cpuOnly = assess({ snapshot, environment: env({ heavyApps: ['UnrealEditor'] }), policy: { admission: { heavyAppPolicy: 'cpu-only' } }, target });
  check('heavy app with cpu-only places on CPU instead of deferring', cpuOnly.admitted === true && cpuOnly.expected.placement === 'cpu', JSON.stringify(cpuOnly));
  check('heavy app with defer still defers', assess({ snapshot, environment: env({ heavyApps: ['UnrealEditor'] }), policy: { admission: { heavyAppPolicy: 'defer' } }, target }).reason === 'heavy_application_active');

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}, 300);

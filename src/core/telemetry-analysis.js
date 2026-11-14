// Pure functions over telemetry samples: who used which hardware, when, how much; plus findings and a Perfetto trace.
// Samples come from scripts/telemetry-sampler.ps1 (per-process PDH) with nvidia-smi readings attached as `nv`.
'use strict';

const culprits = require('./debugging/culprits');

const APPS = [
  ['unreal', /^(unrealeditor|unrealeditor-cmd|shadercompileworker|unrealbuildtool|unrealinsights|unrealtraceserver|unrealpak|zenserver|unrealmultiuserserver)/],
  ['unity', /^(unity|unity hub|unityshadercompiler|unitycrashhandler64|bee_backend|unity\.licensing\.client)$/],
  ['lmstudio', /^(lm studio|lms|llmworker|lm-studio)/],
  ['llama.cpp', /^llama-(server|cli)/],
  ['codex', /^codex/], ['claude', /^claude/],
  ['streaming', /^(sunshine|sunshinesvc|moonlight|tailscaled|tailscale-ipn)$/], // NVENC load during Moonlight sessions
  ['browser', /^(chrome|msedge|firefox|brave|opera|msedgewebview2)$/],
  // Always-on desktop work; excluded when deciding whether the GPU is busy with real work.
  ['background', /^(dwm|csrss|explorer|wallpaper(32|64)?|nvidia overlay|nvcontainer|nvdisplay\.container|steamwebhelper|searchhost|textinputhost|startmenuexperiencehost|shellexperiencehost|system|registry|memory compression|audiodg|msmpeng|widgets|phoneexperiencehost)$/],
];
const REASONS = [[0x4, 'sw_power_cap'], [0x8, 'hw_slowdown'], [0x40, 'sw_thermal'], [0x80, 'hw_thermal'], [0x100, 'hw_power_brake']];

function classify(name) {
  const n = String(name || '').toLowerCase().replace(/\.exe$/, '');
  for (const [app, re] of APPS) if (re.test(n)) return app;
  return 'other';
}
const server = (p) => ['lmstudio', 'llama.cpp'].includes(classify(p.n)); // local model servers (LM Studio main hosts embeddings)

function throttleReasons(mask) {
  const value = Number.parseInt(String(mask || '0'), 16);
  return Number.isFinite(value) ? REASONS.filter(([bit]) => value & bit).map(([, name]) => name) : [];
}

/** Owner of a pid: a registered job, the Hub itself, or an app label. Walks parents (max 16 hops). */
function owner(pid, ctx) {
  let cur = pid;
  for (let hop = 0; hop < 16 && cur > 0; hop++) {
    const job = ctx.registry && ctx.registry.get(cur);
    if (job) return { job: job.jobId, kind: job.kind, label: job.label };
    if (cur === ctx.hubPid) return { job: null, kind: 'hub', label: 'ai-hub' };
    cur = ctx.parents ? ctx.parents.get(cur) || 0 : 0;
  }
  return null;
}

const busiest = (g) => Math.max(0, ...Object.values(g || {}));
const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** GPU work that is not desktop background or the Hub itself; used by admission instead of raw utilization. */
function foregroundGpuPercent(sample, ctx = {}) {
  let total = 0;
  for (const p of sample.procs || []) {
    if (classify(p.n) === 'background') continue;
    const o = owner(p.p, ctx);
    if (o && (o.kind === 'hub' || o.job)) continue;
    total += Math.max(p.g?.['3D'] || 0, p.g?.Compute || 0, ...Object.entries(p.g || {}).filter(([k]) => k.startsWith('Compute')).map(([, v]) => v));
  }
  return Math.min(100, total);
}

function dtSeconds(samples, i) {
  if (i > 0) return Math.max(0, (samples[i].t - samples[i - 1].t) / 1000);
  return samples.length > 1 ? Math.max(0, (samples[1].t - samples[0].t) / 1000) : 0;
}

// FILETIME is emitted as a decimal string: converting to Number would lose precision.
function processKey(p) {
  return String(p.p) + '/' + (p.started || '');
}

function observedProcesses(samples, jobs, ctx, keepRows = false) {
  const byKey = new Map(), byPid = new Map();
  for (const [index, sample] of samples.entries()) for (const p of sample.procs || []) {
    const key = processKey(p);
    let life = byKey.get(key);
    if (!life) {
      const siblings = byPid.get(p.p) || [];
      life = { key, pid: p.p, name: p.n, started: p.started || null, first: sample.t, last: sample.t, ordinal: siblings.length + 1 };
      if (keepRows) life.rows = [];
      siblings.push(life);
      byPid.set(p.p, siblings);
      byKey.set(key, life);
    }
    life.last = sample.t;
    if (keepRows) life.rows.push({ index, proc: p });
  }
  for (const [pid, siblings] of byPid) {
    const registered = owner(pid, ctx);
    if (siblings.length === 1) {
      siblings[0].owner = registered;
      continue;
    }
    // A PID-only registration cannot identify both lives. Attribute only a job
    // whose time window and registered process set identify one observed life.
    for (const life of siblings) { life.reused = true; life.owner = null; }
    for (const job of jobs) {
      if (registered?.job !== job.jobId && !job.pids?.has?.(pid)) continue;
      const matching = siblings.filter(life => life.last >= job.start && life.first <= (job.end ?? Infinity));
      if (matching.length === 1) {
        const life = matching[0];
        if (life.owner) life.ambiguous = true;
        if (!life.ambiguous) life.owner = { job: job.jobId, kind: job.kind, label: job.label };
        else life.owner = null;
      }
    }
    const latest = siblings.reduce((a, b) => a.last >= b.last ? a : b);
    for (const life of siblings) life.latest = life === latest;
  }
  return { byKey, byPid };
}

/** Usage of a process set (or the whole machine when pids is null) across samples. */
function usage(samples, pids, observedRows) {
  let selected = pids;
  const numericPids = pids && new Set([...pids].filter(Number.isInteger));
  if (numericPids?.size) {
    const latest = new Map();
    for (const sample of samples) for (const p of sample.procs || []) {
      if (numericPids.has(p.p)) latest.set(p.p, processKey(p));
    }
    selected = new Set([...pids].filter(key => !numericPids.has(key)));
    for (const key of latest.values()) selected.add(key);
  }
  const acc = { seconds: 0, cpu: { sum: 0, peak: 0 }, memPeak: 0, vramPeak: 0, sharedPeak: 0, ioRead: 0, ioWrite: 0, gpu: {} };
  (observedRows || samples).forEach((entry, position) => {
    const i = observedRows ? entry.index : position;
    const s = samples[i];
    const dt = dtSeconds(samples, i);
    // A numeric PID selects its last observed life in this window. Period reports
    // and role aggregates supply exact keys and may intentionally include several.
    const rows = observedRows ? [entry.proc] : (s.procs || []).filter((p) => !selected || selected.has(processKey(p)));
    if (pids && !rows.length) return;
    acc.seconds += dt;
    const cpu = pids ? rows.reduce((a, p) => a + p.c, 0) : s.cpu;
    acc.cpu.sum += cpu * dt; acc.cpu.peak = Math.max(acc.cpu.peak, cpu);
    acc.memPeak = Math.max(acc.memPeak, rows.reduce((a, p) => a + p.m, 0));
    acc.vramPeak = Math.max(acc.vramPeak, pids ? rows.reduce((a, p) => a + p.vd, 0) : (s.adapters || []).reduce((a, x) => a + x.ded, 0));
    acc.sharedPeak = Math.max(acc.sharedPeak, pids ? rows.reduce((a, p) => a + p.vs, 0) : (s.adapters || []).reduce((a, x) => a + x.sh, 0));
    acc.ioRead += rows.reduce((a, p) => a + p.r, 0) * dt; acc.ioWrite += rows.reduce((a, p) => a + p.w, 0) * dt;
    const engines = {};
    if (pids) for (const p of rows) for (const [k, v] of Object.entries(p.g || {})) engines[k] = Math.min(100, (engines[k] || 0) + v);
    else for (const a of s.adapters || []) for (const [k, v] of Object.entries(a.eng || {})) engines[k] = Math.max(engines[k] || 0, v);
    for (const [k, v] of Object.entries(engines)) {
      const e = acc.gpu[k] || (acc.gpu[k] = { sum: 0, peak: 0 });
      e.sum += v * dt; e.peak = Math.max(e.peak, v);
    }
  });
  const avg = (sum) => (acc.seconds ? sum / acc.seconds : 0);
  return {
    activeSeconds: round(acc.seconds, 0), cpuPercent: { avg: round(avg(acc.cpu.sum)), peak: round(acc.cpu.peak) },
    memPeakBytes: Math.round(acc.memPeak), vramPeakBytes: Math.round(acc.vramPeak), sharedVramPeakBytes: Math.round(acc.sharedPeak),
    ioReadBytes: Math.round(acc.ioRead), ioWriteBytes: Math.round(acc.ioWrite),
    gpuPercent: Object.fromEntries(Object.entries(acc.gpu).map(([k, e]) => [k, { avg: round(avg(e.sum)), peak: round(e.peak) }])),
  };
}

function nvidiaSummary(samples) {
  let seconds = 0, energy = 0, peak = 0, maxTemp = null; const reasons = new Set(), pstates = new Set();
  samples.forEach((s, i) => {
    const gpu = (s.nv || [])[0]; if (!gpu) return;
    const dt = dtSeconds(samples, i); seconds += dt;
    if (Number.isFinite(gpu.powerW)) { energy += gpu.powerW * dt; peak = Math.max(peak, gpu.powerW); }
    if (Number.isFinite(gpu.tempC)) maxTemp = Math.max(maxTemp ?? gpu.tempC, gpu.tempC);
    (gpu.reasons || []).forEach((r) => reasons.add(r)); if (gpu.pstate) pstates.add(gpu.pstate);
  });
  if (!seconds) return null;
  return { powerAvgW: round(energy / seconds), powerPeakW: round(peak), energyWh: round(energy / 3600, 2), maxTempC: maxTemp,
    throttleReasons: [...reasons], pstates: [...pstates] };
}

function processRows(samples, observed, top) {
  const rows = [...observed.byKey.values()].map(life => {
    const { pid, name, started, owner: o } = life;
    return { pid, name, ...(started ? { started } : {}),
      ...(life.reused ? { lifetimeOrdinal: life.ordinal, latestObserved: life.latest } : {}),
      app: o ? o.kind : classify(name), job: o?.job || null, ...usage(samples, new Set([life.key]), life.rows) };
  });
  const pick = (key) => [...rows].sort((a, b) => key(b) - key(a)).slice(0, top);
  const chosen = new Set();
  for (const list of [pick((r) => busiest(Object.fromEntries(Object.entries(r.gpuPercent).map(([k, v]) => [k, v.avg])))),
    pick((r) => r.vramPeakBytes + r.sharedVramPeakBytes), pick((r) => r.cpuPercent.avg)]) for (const r of list) chosen.add(r);
  return [...chosen];
}

function jobRows(jobs, samples, observed) {
  return jobs.filter((j) => samples.some((s) => s.t >= j.start && s.t <= (j.end || Infinity))).map((j) => {
    const inJob = samples.filter((s) => s.t >= j.start && s.t <= (j.end || Infinity));
    const pids = new Set();
    for (const s of inJob) for (const p of s.procs || []) {
      const key = processKey(p);
      if (observed.byKey.get(key).owner?.job === j.jobId) pids.add(key);
    }
    return { jobId: j.jobId, kind: j.kind, label: j.label, start: j.start, end: j.end || null, outcome: j.outcome || null,
      scope: 'process-tree', processes: pids.size, ...usage(inJob, pids), gpuBoard: nvidiaSummary(inJob) };
  });
}

/** Spans where a rule held for at least `minSeconds`; misses shorter than `bridgeMs` do not split a span. */
function spans(samples, test, minSeconds, bridgeMs = 0) {
  const out = []; let open = null;
  const close = () => { if (open && (open.to - open.from) / 1000 >= minSeconds) out.push(open); open = null; };
  for (const s of samples) {
    const hit = test(s);
    if (hit && !open) open = { from: s.t, to: s.t, hits: [hit] };
    else if (hit) { open.to = s.t; open.hits.push(hit); }
    else if (open && s.t - open.to > bridgeMs) close();
  }
  close();
  return out;
}

function findings(samples, ctx = {}) {
  const out = [];
  const describe = (p) => {
    const o = owner(p.p, ctx), r = ctx.roleOf?.(p, ctx.parents);
    return { app: r?.app || (o ? o.kind : classify(p.n)), role: r?.role, job: o?.job };
  };
  const add = (kind, list, explain) => list.forEach((s) => out.push({ kind, from: s.from, to: s.to, seconds: round((s.to - s.from) / 1000, 0), ...explain(s.hits) }));
  // Model servers keep the layers that do not fit on the card in pinned host memory, which WDDM counts as shared: gemma-4-12b's
  // llama-server held 1.6 / 2.2 / 3.5 GiB shared at offload max / 0.79 / 0.6 on an otherwise empty card (2026-10-23, board
  // 96 / 87 / 70%, dedicated + shared ~8.9 GiB each time), and every pid kept its amount from load to exit (11/11 on 2026-10-22).
  // That is the loader's split, not a spill: only shared memory such a process gains while losing dedicated memory counts.
  const settled = new Map();
  const moved = (p) => {
    if (!server(p)) return p.vs;
    const key = processKey(p);
    const m = settled.get(key) || { vs: p.vs, vd: p.vd };
    settled.set(key, { vs: Math.min(m.vs, p.vs), vd: Math.max(m.vd, p.vd) });
    return Math.max(0, Math.min(p.vs - m.vs, m.vd - p.vd));
  };
  add('vram_spill', spans(samples, (s) => {
    // Shared GPU memory alone is not a spill: WDDM also maps staging buffers there (measured: LM Studio embeddings held
    // 358 MB shared with 0.3 of 8 GB dedicated in use). When nvidia-smi reports it, dedicated VRAM must be nearly full.
    // Per-process vd/vs come from \GPU Process Memory(*): nvidia-smi --query-compute-apps gives N/A per process under WDDM.
    // 1 GiB+ moved to shared in one process is a spill whatever the board shows (allocations stay off the card after the
    // pressure is gone); no non-desktop, non-model process passed 612 MiB shared in two days of records (a game 361 MiB).
    // Such a shared-only spill must last 20 s, which keeps a load-time transient out.
    const gpu = (s.nv || [])[0];
    const roomy = Boolean(gpu?.memTotalMiB) && gpu.memUsedMiB / gpu.memTotalMiB < 0.9;
    const spill = (s.procs || []).filter((p) => moved(p) >= (roomy ? 1024 : 256) * 1024 ** 2 && classify(p.n) !== 'background').sort((a, b) => b.vs - a.vs)[0];
    if (spill) return { ...s, roomy, spill: { pid: spill.p, name: spill.n, shared: spill.vs } };
    if (roomy) return null;
    // No per-process GPU memory counters (older Windows or driver): the adapter still shows the spill, so report it without
    // a culprit and let the governor record the monitoring gap instead of staying blind.
    const blind = gpu?.memTotalMiB && !(s.procs || []).some((p) => p.vd || p.vs) && (s.adapters || []).some((a) => a.sh >= 256 * 1024 ** 2);
    return blind ? { ...s, spill: null } : null;
  }, 6).filter((sp) => sp.hits.some((h) => !h.roomy) || sp.to - sp.from >= 20000), (hits) => {
    const first = hits.find((h) => h.spill)?.spill;
    // Ranked by GPU memory held (dedicated + shared), not by who spilled: a spill is total demand over capacity, and the
    // process whose allocations WDDM moved out is not necessarily the one crowding the card. Desktop background is not actionable,
    // and a model server's host-resident layers do not crowd the card.
    const held = culprits.rank(hits, (p) => (classify(p.n) === 'background' ? 0 : server(p) ? p.vd : p.vd + p.vs), describe);
    const peakMiB = (pids, key) => Math.round(Math.max(...hits.map((s) => (s.procs || []).reduce((a, p) => a + (pids.includes(p.p) ? p[key] || 0 : 0), 0))) / 1048576);
    return { process: first?.name ?? null, pid: first?.pid ?? null, sharedVramPeakBytes: Math.max(0, ...hits.map((h) => h.spill?.shared || 0)),
      culprits: held.map((c) => ({ ...c, dedicatedPeakMiB: peakMiB(c.pids, 'vd'), sharedPeakMiB: peakMiB(c.pids, 'vs') })), basis: 'gpu-memory',
      note: 'GPU memory spilled to system RAM over PCIe; local models slow down several times and LM Studio may shrink context.' };
  });
  add('gpu_contention', spans(samples, (s) => {
    const busy = (s.procs || []).filter((p) => classify(p.n) !== 'background' && Math.max(p.g?.['3D'] || 0, p.g?.Compute || 0) >= 20);
    return busy.length >= 2 ? busy.map((p) => `${p.n}(${p.p})`).join(' + ') : null;
  }, 10), (hits) => ({ processes: [...new Set(hits)].slice(0, 3), note: 'Two workloads shared the GPU; frame time and tokens/s both drop.' }));
  add('gpu_throttle', spans(samples, (s) => {
    const gpu = (s.nv || [])[0];
    return gpu && gpu.util >= 80 && gpu.reasons?.length ? gpu.reasons.join(',') : null;
  }, 10), (hits) => ({ reasons: [...new Set(hits.join(',').split(','))], note: 'Clocks were held down by power or thermal limits while the GPU was busy.' }));
  // Paging is ranked by per-process hard faults; the lowest free RAM tells pressure from file loading (measured: a Windows
  // update read 17 GB with 10.6 GiB free and raised 22 split alerts that read like memory pressure). The reader ranking is
  // only a fallback for records older than the hard-fault field: process IO counters miss memory-mapped reads (measured:
  // a 2.3 GiB mmap read showed IO Read 0 for its process, and the ranking named an unrelated claude instead).
  // With RAM free, bursts under a minute are app start-ups, Defender scans and unpacking (measured: MsMpEng, 7za, claude,
  // 7-28 s), so only RAM pressure or a minute-long stream (a model paging from disk) is reported.
  const ramShort = (s) => Number.isFinite(s.mem?.avail) && s.mem.avail >= 0 && s.mem.avail < 1024 ** 3;
  add('paging', spans(samples, (s) => (s.mem?.pagesIn >= 500 ? s : null), 6, 10000)
    .filter((sp) => sp.to - sp.from >= 60000 || sp.hits.some(ramShort)), (hits) => {
    const rows = hits.flatMap((s) => s.procs || []);
    // Fall back to read bytes only if the entire record predates the hard-fault field.
    const legacy = rows.length > 0 && rows.every((p) => !Object.prototype.hasOwnProperty.call(p, 'hf'));
    const measured = rows.some((p) => Number.isFinite(p.hf) && p.hf >= 0);
    const basis = measured ? 'hard-faults' : legacy ? 'io-read' : 'hard-faults-unavailable';
    const avail = hits.map((s) => s.mem.avail).filter(v => Number.isFinite(v) && v >= 0);
    const availMin = avail.length ? Math.min(...avail) : null;
    return { pagesInPeak: round(Math.max(...hits.map((s) => s.mem.pagesIn)), 0),
      culprits: culprits.rank(hits, (p) => legacy ? p.r : p.hf, describe), basis,
      ...(availMin !== null ? { availMinMiB: Math.round(availMin / 1048576) } : {}),
      backingSource: 'unknown', pressureOwner: null,
      note: availMin === null ? 'Pages were read from storage. Available memory and the backing source were not measured.'
        : availMin < 1024 ** 3 ? 'RAM is short in this interval. Low available memory and paging coincide. The pressure source and backing file are unknown.'
          : 'Available RAM stayed above 1 GiB. These counts measure page-ins, not memory pressure. File loading is one possible cause. Backing files were not traced.' };
  });
  add('disk_saturation', spans(samples, (s) => {
    const d = (s.disks || []).find((x) => x.busy >= 90 && x.latMs >= 50); return d ? { ...s, disk: d.n } : null;
  }, 6), (hits) => ({ disks: [...new Set(hits.map((h) => h.disk))], culprits: culprits.rank(hits, (p) => p.r + p.w, describe),
    note: 'Disk was saturated with high latency.' }));
  add('cpu_saturation', spans(samples, (s) => (s.cpu >= 90 ? s : null), 10),
    (hits) => ({ culprits: culprits.rank(hits, (p) => p.c, describe), note: 'CPU was saturated.' }));
  return out.sort((a, b) => a.from - b.from);
}

function summarize(samples, jobs = [], ctx = {}, { top = 6 } = {}) {
  if (!samples.length) return { samples: 0 };
  const observed = observedProcesses(samples, jobs, ctx, true);
  return { from: samples[0].t, to: samples[samples.length - 1].t, samples: samples.length,
    machine: { ...usage(samples, null), gpuBoard: nvidiaSummary(samples) },
    processes: processRows(samples, observed, top), jobs: jobRows(jobs, samples, observed), findings: findings(samples, ctx) };
}

/** Chrome trace-event JSON (opens in ui.perfetto.dev; the file never leaves this PC unless the user uploads it). */
function trace(samples, jobs = [], ctx = {}) {
  const MACHINE = 0x7ffffff0, events = [{ ph: 'M', name: 'process_name', pid: MACHINE, args: { name: 'Machine' } }];
  const observed = observedProcesses(samples, jobs, ctx);
  // Preserve real PIDs for the first lifetime. Reserve the machine/editor tracks
  // as well as *all* real PIDs in this window before assigning a replacement.
  let nextTrack = MACHINE - 1;
  for (const life of observed.byKey.values()) {
    if (life.ordinal === 1 && (life.pid < MACHINE || life.pid > MACHINE + 2)) life.track = life.pid;
    else {
      while (observed.byPid.has(nextTrack)) nextTrack--;
      life.track = nextTrack--;
    }
  }
  const named = new Set();
  for (const s of samples) {
    const ts = s.t * 1000, gpu = (s.nv || [])[0];
    events.push({ ph: 'C', name: 'CPU %', pid: MACHINE, ts, args: { total: round(s.cpu) } });
    for (const a of s.adapters || []) {
      if (!a.ded && !Object.keys(a.eng || {}).length) continue;
      events.push({ ph: 'C', name: 'GPU engines %', pid: MACHINE, ts, args: a.eng });
      events.push({ ph: 'C', name: 'GPU memory MiB', pid: MACHINE, ts, args: { dedicated: round(a.ded / 1048576, 0), shared: round(a.sh / 1048576, 0) } });
    }
    if (gpu) events.push({ ph: 'C', name: 'GPU board', pid: MACHINE, ts, args: { powerW: gpu.powerW, smMHz: gpu.smMHz, tempC: gpu.tempC } });
    events.push({ ph: 'C', name: 'Memory', pid: MACHINE, ts, args: { availableMiB: round(s.mem?.avail / 1048576, 0), pagesInPerSec: round(s.mem?.pagesIn, 0) } });
    for (const p of s.procs || []) {
      const life = observed.byKey.get(processKey(p)), track = life.track, o = life.owner;
      if (!named.has(track)) {
        named.add(track);
        const suffix = life.reused ? ` · PID ${p.p}, ${life.started ? 'lifetime ' + life.ordinal : 'start unknown'}` : '';
        events.push({ ph: 'M', name: 'process_name', pid: track, args: { name: `${p.n} [${o?.job ? `job ${o.label || o.job}` : o ? o.label : classify(p.n)}]${suffix}`,
          ...(life.reused || track !== p.p ? { originalPid: p.p, started: life.started } : {}) } });
      }
      events.push({ ph: 'C', name: 'CPU % of machine', pid: track, ts, args: { cpu: round(p.c) } });
      if (Object.keys(p.g || {}).length) events.push({ ph: 'C', name: 'GPU engines %', pid: track, ts, args: p.g });
      if (p.vd || p.vs) events.push({ ph: 'C', name: 'GPU memory MiB', pid: track, ts, args: { dedicated: round(p.vd / 1048576, 0), shared: round(p.vs / 1048576, 0) } });
      events.push({ ph: 'C', name: 'Private memory MiB', pid: track, ts, args: { private: round(p.m / 1048576, 0) } });
    }
  }
  for (const j of jobs) {
    const end = j.end || samples[samples.length - 1]?.t || j.start;
    events.push({ ph: 'X', name: j.label || j.kind, cat: j.kind, pid: MACHINE, tid: 1, ts: j.start * 1000, dur: Math.max(1, (end - j.start) * 1000),
      args: { jobId: j.jobId, outcome: j.outcome || 'running' } });
  }
  return { traceEvents: events, displayTimeUnit: 'ms' };
}

module.exports = { classify, owner, processKey, throttleReasons, foregroundGpuPercent, usage, findings, summarize, trace };

// MCP: UE tuning without a model — console variables with scalability levels, CSV profiles mapped to the knobs of
// their costly GPU passes, and the engine maps those answers come from.
'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const { z } = require('zod');
const symbolmap = require('../core/symbolmap');

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const mapName = z.string().regex(/^[\w-]{1,64}$/);
const scans = new Map(); // name -> { kind, state, startedAt, result?, error? }

function startScan(kind, name, root) {
  const prior = scans.get(name);
  if (prior?.state === 'running') return prior;
  const job = { kind, state: 'running', startedAt: Date.now() };
  scans.set(name, job);
  job.done = new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, '..', 'core', 'source-scan-worker.js'), { workerData: { kind, name, root } });
    worker.once('message', (m) => { Object.assign(job, m.ok ? { state: 'done', result: m.result } : { state: 'failed', error: m.error }); resolve(); });
    worker.once('error', (e) => { Object.assign(job, { state: 'failed', error: e.message }); resolve(); });
  });
  return job;
}
const view = ({ done, ...job }) => job; // eslint-disable-line no-unused-vars

function register(server) {
  server.registerTool('ue_cvar_find', {
    title: 'Find UE console variables (tuning knobs)',
    description: 'Search console variables of a scanned engine by name or help text: default, flags, file:line, BaseScalability.ini level values (sg.*@0..Cine) and, with `project` (.uproject path), the project Config overrides. With `render_map`, a GPU stat / RDG pass name also returns the cvars declared beside that pass. No model call.',
    inputSchema: { map: mapName, query: z.string().min(2).max(200), render_map: mapName.optional(), project: z.string().max(400).optional(),
      scalability_only: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() },
  }, async (a) => text(symbolmap.cvars(a.map, a.query, { renderMap: a.render_map, project: a.project, scalabilityOnly: a.scalability_only, limit: a.limit })));

  server.registerTool('ue_profile_summary', {
    title: 'Summarize a UE CSV profile and map costly passes to knobs',
    description: 'Read a CSV profiler capture (-csvCaptureFrames=N -csvGpuStats): fps, game/render/RHI/GPU thread times (avg/p50/p95), and `pipeline`: the stage that fills the frame (or `waits` when the frame length comes from vsync/t.MaxFPS/sync fences), with the render thread\'s wait for the previous GPU frame\'s occlusion results taken out, input latency, swap-chain waits, and the latency-vs-hitch-resiliency knobs (r.GTSyncType, r.OneFrameThreadLag, …; per Epic\'s "A Frame\'s Life"). Also the costliest GPU passes. With `map`+`render_map`, each pass and pipeline knob gets its source (DECLARE/DEFINE_GPU_STAT, cvar definition) and pass knobs come with scalability levels. `compare_csv` adds a per-pass before/after delta. The first quarter of frames is skipped unless skip_frames is given. No model call.',
    inputSchema: { csv: z.string().max(400), compare_csv: z.string().max(400).optional(), map: mapName.optional(), render_map: mapName.optional(),
      project: z.string().max(400).optional(), skip_frames: z.number().int().min(0).optional(), top: z.number().int().min(1).max(40).optional() },
  }, async (a) => {
    const profile = require('../core/ue-profile');
    const before = profile.withKnobs(profile.summarize(a.csv, { skipFrames: a.skip_frames, top: a.top }),
      { map: a.map, renderMap: a.render_map, cvars: symbolmap.cvars, project: a.project });
    if (!a.compare_csv) return text(before);
    const after = profile.summarize(a.compare_csv, { skipFrames: a.skip_frames, top: a.top });
    return text({ before, after: { fps: after.fps, threads: after.threads, bound: after.bound }, delta: profile.compare(before, after) });
  });

  server.registerTool('ue_source_scan', {
    title: 'Build an engine symbol/cvar map or render map',
    description: 'Build (in a background thread) the symbol map with console variables + scalability levels (kind=symbols, root=<install>/Engine/Source, ~45 s for UE 5.8) or the render map of RDG passes/GPU stats (kind=render, root=<install>/Engine/Source/Runtime/Renderer, <1 s). Read-only on the engine; writes only Hub data. Waits up to wait_s, then call again with the same name to poll. Omit root to list suggested engine roots.',
    inputSchema: { kind: z.enum(['symbols', 'render']), name: mapName, root: z.string().max(400).optional(), wait_s: z.number().int().min(0).max(50).optional() },
  }, async (a) => {
    if (!a.root && !scans.has(a.name)) return text({ suggestedRoots: symbolmap.suggestRoots() });
    const job = a.root ? startScan(a.kind, a.name, a.root) : scans.get(a.name);
    await Promise.race([job.done, new Promise((r) => setTimeout(r, (a.wait_s ?? 45) * 1000))]);
    return text({ name: a.name, ...view(job) });
  });
}

module.exports = { register };

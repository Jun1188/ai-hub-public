// UE CSV profiler captures (-csvCaptureFrames=N -csvGpuStats) → which pipeline stage bounds the frame, costly GPU passes
// and the knobs beside them.
// Deterministic: no model. Knobs come from the engine symbol map (cvarmap) and the render map (renderpipe).
'use strict';

const fs = require('fs');

// Stats that first appear mid-capture add columns: early rows are shorter and the complete header is repeated
// at the end ([HasHeaderRowAtEnd]). Rows keep their positions; missing trailing columns read as NaN.
function parse(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  const isHeader = (cells) => cells.length > 1 && cells[1] !== '' && !Number.isFinite(Number(cells[1]));
  let header = (lines[0] || '').split(',').map((h) => h.trim());
  const rows = [], metadata = {};
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells[0].startsWith('[')) { // trailing metadata: [key],value,[key],value…
      for (let j = 0; j + 1 < cells.length; j += 2) metadata[cells[j].replace(/[[\]]/g, '')] = cells[j + 1];
      continue;
    }
    if (isHeader(cells)) { if (cells.length >= header.length) header = cells.map((h) => h.trim()); continue; }
    rows.push(cells.map(Number));
  }
  return { header, rows, metadata };
}

function stats(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const at = (q) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
  return { avg: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3), p50: +at(0.5).toFixed(3), p95: +at(0.95).toFixed(3), max: +v[v.length - 1].toFixed(3) };
}

// Frame pipeline per Epic's "A Frame's Life" (UE 5.7/5.8): FrameTime is the wall clock between game-thread frames;
// Game/Render/RHI times exclude their waits and GPUTime excludes GPU bubbles. A stage bounds the frame only when its
// busy time fills it; otherwise the frame length comes from waits (vsync, t.MaxFPS, pipeline fences).
const PIPELINE_KNOBS = [
  { name: 'r.GTSyncType', trade: '0 (default): game thread waits on the previous render-thread start, most hitch resiliency, most latency. 1: waits on the previous RHI frame, less latency and parallelism. 2: fixed throttling, consoles only.' },
  { name: 'r.OneFrameThreadLag', trade: '1 (default) lets the render thread trail the game thread by a frame; 0 removes that overlap: less latency, less parallelism.' },
  { name: 'r.VSync', trade: 'Off lowers latency but tears and drops hitch resiliency.' },
  { name: 't.MaxFPS', trade: 'Slightly below the refresh rate drains the pipeline (lower latency) at the cost of a dropped frame or two per second.' },
  { name: 'r.D3D12.NumViewportBuffers', trade: 'Back buffers on PC (triple buffering by default); fewer buffers mean less latency and less resiliency.' },
  { name: 'r.AllowOcclusionQueries', trade: 'Hardware occlusion for non-Nanite meshes; the render thread waits for the previous GPU frame\'s results. Profile before turning off.' },
  { name: 'r.VsyncInformationInsights', trade: 'Diagnostics: vsync bookmarks in Unreal Insights, marking missed vsyncs (dropped frames).' },
];

function framePipeline(threads, waits) {
  const frame = threads.frame?.avg;
  if (!frame) return null;
  // RenderThreadTime still contains the wait for the previous GPU frame's occlusion results (a task wait, not idle),
  // so a GPU-bound capture shows the render thread at ~100% of the frame. Its own work is the remainder.
  const hoq = waits.renderVisibilityWait?.avg || 0;
  const stages = ['game', 'render', 'rhi', 'gpu'].filter((k) => threads[k]).map((k) => {
    const ms = +(threads[k].avg - (k === 'render' ? Math.min(hoq, threads[k].avg) : 0)).toFixed(3);
    return { stage: k, ms, share: +(ms / frame).toFixed(2), ...(k === 'render' && hoq ? { includedWaitMs: hoq } : {}) };
  }).sort((a, b) => b.ms - a.ms);
  const bound = stages[0] && stages[0].share >= 0.9 ? stages[0].stage : 'waits';
  const notes = [{
    game: 'Game thread fills the frame: gameplay, animation or physics (Insights GameThread track).',
    render: 'Render thread fills the frame: scene setup, culling and draw-command building.',
    rhi: 'RHI thread fills the frame: translating and submitting graphics API commands.',
    gpu: 'GPU is busy for the whole frame: reduce the costly GPU passes listed below.',
    waits: 'No stage fills the frame, so its length comes from waits: vsync or t.MaxFPS, or the pipeline fences (r.GTSyncType, r.OneFrameThreadLag).',
  }[bound]];
  if (hoq >= 0.5) notes.push(`RenderThreadTime includes ${hoq} ms waiting for the previous GPU frame's occlusion results (WaitForVisibilityTasks); that is waiting, not occlusion cost, and it grows when the GPU frame runs long. The render stage above excludes it.`);
  if (waits.renderIdleSwapBuffer?.avg >= 0.5) notes.push(`Render thread idles ${waits.renderIdleSwapBuffer.avg} ms on the swap chain: Present() is blocked because no back buffer is free (GPU behind, or vsync).`);
  notes.push('UE\'s FPS counts game-thread frames, not displayed vsyncs; for displayed frames use PresentMon\'s FPS-Display or a vsync counter.');
  return { bound, stages, waits: Object.fromEntries(Object.entries(waits).filter(([, v]) => v)), notes, knobs: PIPELINE_KNOBS.map((k) => ({ ...k })) };
}

/** Summary of a capture; the first `skipFrames` (loading, shader compiles) are dropped. */
function summarize(file, { skipFrames = null, top = 12 } = {}) {
  const { header, rows, metadata } = parse(fs.readFileSync(file, 'utf8'));
  if (!rows.length) return { error: 'no_frames', columns: header.length };
  const skip = skipFrames == null ? Math.floor(rows.length / 4) : Math.min(skipFrames, rows.length - 1);
  const frames = rows.slice(skip);
  const col = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const series = (i) => frames.map((r) => r[i]);
  const pick = (...names) => { for (const n of names) { const i = col(n); if (i >= 0) return stats(series(i)); } return null; };
  const threads = { frame: pick('FrameTime'), game: pick('GameThreadTime'), render: pick('RenderThreadTime'),
    rhi: pick('RHIThreadTime'), gpu: pick('GPUTime', 'GPU/Total') };
  const waits = { inputLatency: pick('InputLatencyTime'), gameEventWait: pick('Exclusive/GameThread/EventWait'),
    renderVisibilityWait: pick('Exclusive/RenderThread/EventWait/Visibility'), renderIdleSwapBuffer: pick('RenderThreadIdle/SwapBuffer'),
    renderIdleGpuQuery: pick('RenderThreadIdle/GPUQuery') };
  const pipe = framePipeline(threads, waits);
  const bound = pipe ? pipe.bound : null;
  const gpuPasses = header.map((h, i) => [h, i]).filter(([h]) => /^GPU\d*\//i.test(h) && !/\/Total$/i.test(h))
    .map(([h, i]) => ({ stat: h.replace(/^GPU\d*\//i, ''), ms: stats(series(i)) })).filter((p) => p.ms && p.ms.avg > 0)
    .sort((a, b) => b.ms.avg - a.ms.avg).slice(0, top);
  return { file, frames: rows.length, analyzedFrames: frames.length, skippedFrames: skip,
    fps: threads.frame ? +(1000 / threads.frame.avg).toFixed(1) : null, threads, bound, pipeline: pipe, gpuPasses,
    metadata: Object.fromEntries(Object.entries(metadata).filter(([k]) => /^(platform|config|buildversion|commandline|run|rhi|gpu|cpu)/i.test(k))) };
}

/** GPU stat names are DECLARE_GPU_STAT identifiers; strip common prefixes so they meet render-map names. */
const statKey = (s) => String(s).replace(/^(Stat_GPU_|STAT_GPU_)/, '');

/** Attach, per costly GPU pass, the console variables declared in the same source files. */
// Knobs that change cost first: scalability-mapped, then Scalability-flagged, then help text about cost.
const COST = /sample|count|resolution|quality|step|downsample|budget|max|distance|cost|scale/i;
const rank = (c) => (c.scalability ? 0 : 4) + (c.flags.includes('Scalability') ? 0 : 2) + (COST.test(c.name + ' ' + c.help) ? 0 : 1);

function withKnobs(summary, { map, renderMap, cvars, project = null }) {
  if (summary.error || !map || !renderMap) return summary;
  // Pipeline knobs: default and the engine source line where each is defined (the entry point for reading that mechanism).
  for (const knob of summary.pipeline?.knobs || []) {
    const c = (cvars(map, knob.name, { limit: 5, project }).cvars || []).find((x) => x.name.toLowerCase() === knob.name.toLowerCase());
    if (c) Object.assign(knob, { default: c.default, project: c.project, at: `${c.file}:${c.line}` });
  }
  for (const pass of summary.gpuPasses) {
    const found = cvars(map, statKey(pass.stat), { renderMap, limit: 40, project });
    pass.sources = (found.passes || []).filter((p) => p.category === 'gpuStats').slice(0, 3).map((p) => `${p.file}:${p.line}`);
    pass.knobs = (found.cvars || []).filter((c) => c.via.startsWith('same-file') || c.via === 'name')
      .sort((a, b) => rank(a) - rank(b)).slice(0, 6)
      .map((c) => ({ name: c.name, default: c.default, scalability: c.scalability, project: c.project, at: `${c.file}:${c.line}` }));
  }
  return summary;
}

/** A vs B comparison of two captures (e.g. before/after a cvar change). */
function compare(a, b) {
  const delta = (x, y) => (x && y ? +(y.avg - x.avg).toFixed(3) : null);
  const passes = new Map(a.gpuPasses.map((p) => [p.stat, p]));
  return { fps: { before: a.fps, after: b.fps }, frameMs: delta(a.threads.frame, b.threads.frame), gpuMs: delta(a.threads.gpu, b.threads.gpu),
    passes: b.gpuPasses.map((p) => ({ stat: p.stat, beforeMs: passes.get(p.stat)?.ms.avg ?? null, afterMs: p.ms.avg, deltaMs: delta(passes.get(p.stat)?.ms, p.ms) })) };
}

module.exports = { parse, summarize, withKnobs, compare };

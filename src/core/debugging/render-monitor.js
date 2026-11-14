// Debugging stage 2: which stage bounds one process's rendering right now — the GPU, the render/RHI thread or the game
// thread. Live and without admin: per-thread CPU from process-probe.ps1, the process's GPU engines and the board from the
// continuous record, and Unreal/Unity log events from devtools. Frame times come from PresentMon (presentmon.js) when it is
// installed and this account may trace ETW; otherwise `frames` is null and the verdict rests on threads and GPU engines.
'use strict';

const probe = require('./probe');
const presentmon = require('./presentmon');
const threads = require('./threads');
const analysis = require('../telemetry-analysis');

const SATURATED = 85; // % of the GPU engine, or of one core for a pipeline thread
const RENDER_EVENTS = new Set(['pso-hitches', 'shader-compile-stats', 'shader-workers', 'load-map', 'pie-start', 'scene-open', 'unload-assets']);
const ADVICE = {
  gpu: 'GPU-bound: lower resolution or screen percentage, or find the costly passes (Unreal: stat gpu / ProfileGPU; Unity: Frame Debugger, GPU profiler; or capture one frame with RenderDoc and run frame_capture_analyze).',
  'render-thread': 'Render thread pegged: draw-call and visibility cost (Unreal: stat scenerendering, stat initviews; Unity: batching, SRP Batcher, GPU instancing; a RenderDoc capture through frame_capture_analyze counts draws per pass).',
  'rhi-thread': 'RHI thread pegged: driver submission and PSO creation (draw-call count; PSO precaching in Unreal).',
  'game-thread': 'Game thread pegged: gameplay, ticks, Blueprint or script cost (Unreal: stat game, Insights; Unity: Profiler CPU timeline).',
  none: 'No stage is saturated: the frame is capped (vsync or a frame limit), waiting on something else, or idle.',
};

/** Process drawing the most on the GPU, ignoring desktop background and Hub-owned work. */
function pickTarget(sample, ctx = {}) {
  const gpuOf = (p) => Math.max(p.g?.['3D'] || 0, ...Object.entries(p.g || {}).filter(([k]) => k.startsWith('Compute')).map(([, v]) => v));
  return (sample?.procs || []).filter((p) => analysis.classify(p.n) !== 'background' && !analysis.owner(p.p, ctx) && gpuOf(p) >= 1)
    .sort((a, b) => gpuOf(b) - gpuOf(a))[0] || null;
}

/** One line of frame evidence for the note: what the fps was and which side was working through each frame. */
function frameNote(f) {
  return ` ${f.fps} fps (p50 ${f.frameMs.p50} ms, p99 ${f.frameMs.p99} ms${f.notDisplayed ? `, ${f.notDisplayed} not displayed` : ''}${f.syncInterval > 0 ? ', vsync on' : ''})`
    + (f.gpuBusyPercent !== null ? `; the GPU was busy ${f.gpuBusyPercent}% of each frame.` : '.');
}

/** Pure: thread probe lines + telemetry samples (+ PresentMon frame statistics, or null) of the same window → verdict. */
function analyze({ threadSamples, samples, pid, ctx = {}, frames = null, expectedStart = null }) {
  const selected = samples.flatMap((s) => s.procs || []).filter(p => p.p === pid);
  const lives = new Set(selected.map(analysis.processKey));
  for (const sample of threadSamples) lives.add(analysis.processKey({ p: pid, started: sample.started }));
  if (lives.size > 1 || (expectedStart && !lives.has(analysis.processKey({ p: pid, started: expectedStart })))) return { error: 'process_lifetime_changed',
    note: '이 구간의 PID가 한 프로세스 생애에 속하는지 확인할 수 없습니다. 현재 PID로 다시 측정하세요.' };
  const row = selected[selected.length - 1];
  const name = row?.n || null, app = row ? (ctx.roleOf?.(row, ctx.parents)?.app || analysis.classify(name)) : 'other';
  const list = threads.aggregate(threadSamples, app === 'unreal' || app === 'unity');
  const roles = threads.byRole(list);
  const use = analysis.usage(samples, new Set([pid]));
  const engines = Object.entries(use.gpuPercent).filter(([k]) => k === '3D' || k.startsWith('Compute'));
  const gpuBusy = Math.max(0, ...engines.map(([, v]) => v.avg));
  const boards = samples.map((s) => (s.nv || [])[0]).filter(Boolean);
  const boardUtil = boards.length ? Math.round(boards.reduce((a, g) => a + (g.util || 0), 0) / boards.length) : null;
  const throttle = [...new Set(boards.flatMap((g) => g.reasons || []))];
  let bound = 'none';
  // A GPU busy through nearly every frame interval is the frame's limiter, whatever share of the engine counter that shows.
  if (gpuBusy >= SATURATED || frames?.gpuBusyPercent >= SATURATED || (boardUtil >= 90 && gpuBusy >= 60)) bound = 'gpu';
  else {
    const stage = ['game', 'render', 'rhi'].map((r) => [r, roles[r]?.busiest || 0]).sort((a, b) => b[1] - a[1])[0];
    if (stage[1] >= SATURATED) bound = `${stage[0]}-thread`;
  }
  const primed = threadSamples.filter((s) => s.primed !== false).length;
  return { target: { pid, name, app }, seconds: primed, bound,
    note: ADVICE[bound] + (bound === 'gpu' && throttle.length ? ` Clocks were also held down (${throttle.join(', ')}).` : '') + (frames ? frameNote(frames) : ''),
    frames,
    gpu: { engines: use.gpuPercent, boardUtilAvg: boardUtil, throttle, vramPeakBytes: use.vramPeakBytes,
      sharedVramPeakBytes: use.sharedVramPeakBytes },
    cpu: { processPercentOfMachine: use.cpuPercent, threadCount: threadSamples[threadSamples.length - 1]?.total ?? null },
    roles, threads: list.slice(0, 12) };
}

/** Capture `seconds` of one process (or the busiest GPU process) and explain what bounds its rendering. */
async function monitor({ pid = null, seconds = 15, expectedStart = null } = {}) {
  const telemetry = require('../telemetry'), devtools = require('../devtools'); // lazy: tests use analyze() without a sampler
  const ctx = telemetry.context();
  const target = pid || pickTarget(telemetry.latest(), ctx)?.p;
  if (!target) return { error: 'no_target', note: 'No process is drawing on the GPU right now; pass a pid.' };
  const since = Date.now(), count = Math.max(3, Math.min(60, Math.round(seconds)));
  const [threadSamples, presents] = await Promise.all([probe.run('threads', target, { count }),
    presentmon.capture(target, count).then((frames) => ({ frames }), (e) => ({ error: e.message.slice(0, 300) }))]);
  const until = Date.now();
  const samples = await telemetry.window({ since, until });
  const result = analyze({ threadSamples, samples, pid: target, ctx, frames: presents.frames || null, expectedStart });
  if (result.error) return result;
  if (presents.error) result.framesError = presents.error;
  if (result.target.app === 'unreal' || result.target.app === 'unity') {
    const dev = (await devtools.summarize(samples, { since, until, parents: ctx.parents })).find((d) => d.app === result.target.app);
    if (dev) result.engine = { events: dev.events.filter((e) => RENDER_EVENTS.has(e.kind)), findings: dev.findings };
  }
  return result;
}

module.exports = { monitor, analyze, pickTarget, SATURATED };

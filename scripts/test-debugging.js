#!/usr/bin/env node
// Debugging: culprit ranking over synthetic samples (no sampler process).
'use strict';
const { rank } = require('../src/core/debugging/culprits');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); } };
const at = (t, procs) => ({ t, procs });
const none = () => null;

// same-name processes are one culprit; shares integrate over time, not per sample
const chrome = [at(0, [{ p: 1, n: 'chrome', hf: 100 }, { p: 2, n: 'chrome', hf: 100 }, { p: 3, n: 'llama-server', hf: 0 }]),
  at(2000, [{ p: 1, n: 'chrome', hf: 0 }, { p: 3, n: 'llama-server', hf: 600 }])];
const r = rank(chrome, (p) => p.hf, none);
check('groups same-name processes', r[0].name === 'llama-server' && r[1].name === 'chrome' && r[1].pids.length === 2 && r[1].label.startsWith('chrome×2'), JSON.stringify(r));
check('shares add up', Math.abs(r.reduce((a, c) => a + c.share, 0) - 1) < 0.02 && r[0].share === 0.75, JSON.stringify(r.map((c) => c.share)));

// a long gap (bridged span, 10-s buckets) cannot make one sample dominate
const gapped = [at(0, [{ p: 1, n: 'a', c: 50 }]), at(600000, [{ p: 2, n: 'b', c: 50 }])];
const g = rank(gapped, (p) => p.c, none);
check('gap between samples is capped', g.length === 2 && g.every((c) => c.share === 0.5), JSON.stringify(g));

// describe() supplies app, role and Hub job; zero, missing and NaN rates are ignored
const d = rank([at(0, [{ p: 9, n: 'UnrealEditor', c: 40 }, { p: 8, n: 'idle', c: 0 }, { p: 7, n: 'broken' }])], (p) => p.c,
  (p) => (p.p === 9 ? { app: 'unreal', role: 'editor', job: 'j1' } : null));
check('describe and ignored rates', d.length === 1 && d[0].app === 'unreal' && d[0].role === 'editor' && d[0].job === 'j1'
  && d[0].label === 'UnrealEditor(9) [editor] 100%', JSON.stringify(d));
check('nothing measured gives no culprits', rank([at(0, [{ p: 1, n: 'x' }])], (p) => p.hf, none).length === 0);
check('top limits the list', rank([at(0, [1, 2, 3, 4, 5].map((p) => ({ p, n: `p${p}`, c: p })))], (p) => p.c, none, { top: 2 }).length === 2);

// ---- stage 2: render monitor -------------------------------------------------------------------------------------
const threads = require('../src/core/debugging/threads');
const render = require('../src/core/debugging/render-monitor');
const probeLine = (list, primed = true) => ({ t: 0, pid: 50, total: 80, primed, threads: list });
const ue = [probeLine([{ id: 1, n: 'GameThread', c: 99, main: true }], false),
  ...[0, 1, 2].map(() => probeLine([{ id: 1, n: 'GameThread', c: 95, main: true }, { id: 2, n: 'RenderThread 0', c: 40 }, { id: 3, n: 'RHIThread', c: 20 },
    { id: 4, n: 'Foreground Worker #1', c: 30 }, { id: 5, n: 'Foreground Worker #2', c: 30 }]))];
const agg = threads.aggregate(ue, true);
check('threads: unprimed sample ignored, roles by name', agg[0].name === 'GameThread' && agg[0].avg === 95 && agg[0].role === 'game'
  && agg.find((t) => t.id === 2).role === 'render' && agg.find((t) => t.id === 3).role === 'rhi', JSON.stringify(agg));
const roles = threads.byRole(agg);
check('threads: workers summed, busiest kept', roles.workers.threads === 2 && roles.workers.total === 60 && roles.workers.busiest === 30, JSON.stringify(roles));
check('threads: unnamed main is game only in an engine', threads.role('', true, true) === 'game' && threads.role('', true, false) === 'main' && threads.role('x', false, false) === null);

const rec = (g, util = 50) => [0, 2000, 4000, 6000].map((t) => ({ t, procs: [{ p: 50, n: 'UnrealEditor', c: 20, m: 1, r: 0, w: 0, vd: 3e9, vs: 0, g }], nv: [{ util, reasons: [] }] }));
const ueCtx = { roleOf: (p) => (p.n === 'UnrealEditor' ? { app: 'unreal', role: 'editor' } : null) };
const gameBound = render.analyze({ threadSamples: ue, samples: rec({ '3D': 40 }), pid: 50, ctx: ueCtx });
check('render: pegged game thread with idle GPU is game-thread bound', gameBound.bound === 'game-thread' && gameBound.target.app === 'unreal'
  && gameBound.seconds === 3 && /Game thread/.test(gameBound.note), JSON.stringify({ b: gameBound.bound, t: gameBound.target }));
const gpuBound = render.analyze({ threadSamples: ue, samples: rec({ '3D': 97 }, 99), pid: 50, ctx: ueCtx });
check('render: busy 3D engine wins over a busy thread', gpuBound.bound === 'gpu' && gpuBound.gpu.engines['3D'].avg === 97 && gpuBound.gpu.boardUtilAvg === 99);
const capped = render.analyze({ threadSamples: [probeLine([]), probeLine([{ id: 1, n: 'GameThread', c: 30, main: true }])], samples: rec({ '3D': 30 }), pid: 50, ctx: ueCtx });
check('render: nothing saturated is none', capped.bound === 'none' && /capped/.test(capped.note));
check('render: without frames the verdict and note stay thread/engine only', capped.frames === null && !/fps/.test(capped.note));

// ---- stage 2 frames: PresentMon CSV (v2 and v1 column names), ETW permission by SID, the frame verdict -----------------
const pm = require('../src/core/debugging/presentmon');
const v2 = ['Application,ProcessID,SwapChainAddress,PresentRuntime,SyncInterval,PresentFlags,AllowsTearing,PresentMode,CPUStartTime,FrameTime,CPUBusy,CPUWait,GPULatency,GPUTime,GPUBusy,GPUWait,DisplayLatency,DisplayedTime',
  ...[10, 10, 10, 30].map((ms, i) => `wallpaper64.exe,50,0xA,DXGI,1,0,0,Hardware: Independent Flip,${i * 10},${ms},2,${ms - 2},1,8,${ms * 0.9},1,${i === 3 ? 'NA' : 5},${i === 3 ? 'NA' : ms}`),
  'wallpaper64.exe,50,0xB,DXGI,1,0,0,Composed: Flip,0,16,1,15,1,1,1,1,NA,NA', 'other.exe,51,0xA,DXGI,0,0,0,Composed: Flip,0,5,1,4,1,1,1,1,1,5', ''].join('\r\n');
const s2 = pm.summarize(pm.parse(v2, 50));
check('presentmon v2: busiest swap chain, fps and percentiles', s2.frames === 4 && s2.swapChains === 2 && s2.fps === 66.7
  && s2.frameMs.avg === 15 && s2.frameMs.p50 === 10 && s2.frameMs.p99 === 30 && s2.frameMs.max === 30, JSON.stringify(s2));
check('presentmon v2: GPU share of each frame, NA is not displayed', s2.gpuBusyPercent === 90 && s2.notDisplayed === 1 && !('cpuBusyPercent' in s2)
  && s2.presentMode === 'Hardware: Independent Flip' && s2.syncInterval === 1 && s2.runtime === 'DXGI', JSON.stringify(s2));
// PresentMon 2.6.0's default output (v1 names), two real wallpaper64 rows; the second marked not displayed
const v1 = ['Application,ProcessID,SwapChainAddress,PresentRuntime,SyncInterval,PresentFlags,AllowsTearing,PresentMode,TimeInMs,MsBetweenSimulationStart,MsBetweenPresents,MsBetweenDisplayChange,MsInPresentAPI,MsRenderPresentLatency,MsUntilDisplayed,CPUStartTimeInMs,MsBetweenAppStart,MsCPUBusy,MsCPUWait,MsGPULatency,MsGPUTime,MsGPUBusy,MsGPUWait,MsAnimationError,AnimationTime,MsFlipDelay',
  'wallpaper64.exe,16608,0x19A5BE3EBA0,DXGI,0,512,1,Hardware: Independent Flip,143.4752,NA,100.3769000000001,115.9634000000001,0.0584000000000,6.9011000000000,20.2493,43.1555,100.3781,100.3197,0.0584,4.6056,102.6152,6.7604,95.8548,NA,43.1555,NA',
  'wallpaper64.exe,16608,0x19A5BE3EBA0,DXGI,0,512,1,Hardware: Independent Flip,244.4312,NA,100.9560000000000,100.0307000000001,0.0565000000000,8.5048000000000,NA,143.5336,100.9541,100.8976,0.0565,6.8427,102.5597,8.3342,94.2255,0.3474,143.5336,NA'].join('\r\n');
const s1 = pm.summarize(pm.parse(v1, 16608));
check('presentmon 2.6 default (v1 names)', s1.fps === 9.9 && s1.gpuBusyPercent === 7.5 && s1.notDisplayed === 1 && s1.syncInterval === 0 && s1.frameMs.max === 101, JSON.stringify(s1));
// Measured GPU milliseconds, kept apart from the busy share: work time (GPUBusy) and start-to-completion (GPUTime, includes waiting).
check('presentmon: GPU time per frame in ms from ETW, v2 and v1 names', s2.gpuMs.basis === 'presentmon-etw' && s2.gpuMs.busy.avg === 13.5 && s2.gpuMs.busy.p50 === 9
  && s2.gpuMs.busy.p99 === 27 && s2.gpuMs.busy.frames === 4 && s2.gpuMs.total.avg === 8 && s1.gpuMs.busy.avg === 7.55 && s1.gpuMs.busy.max === 8.33
  && s1.gpuMs.total.avg === 102.59, JSON.stringify([s2.gpuMs, s1.gpuMs]));
const noGpuColumns = pm.summarize(pm.parse(['Application,ProcessID,SwapChainAddress,PresentRuntime,SyncInterval,PresentMode,FrameTime', 'a.exe,9,0xA,DXGI,0,Composed: Flip,10', 'a.exe,9,0xA,DXGI,0,Composed: Flip,12'].join('\n'), 9));
check('presentmon: no GPU columns is unmeasured, not zero', noGpuColumns.frames === 2 && noGpuColumns.gpuMs === null && noGpuColumns.gpuBusyPercent === null, JSON.stringify(noGpuColumns));
check('presentmon: no header or one frame gives nothing', pm.parse('error: access denied', 7).length === 0 && pm.summarize(pm.parse(v1.split('\r\n').slice(0, 2).join('\n'), 16608)) === null);
check('presentmon: ETW permission by SID, not by localized name', pm.permitted('"BUILTIN\\Performance Log Users","별칭","S-1-5-32-559","필수 그룹"')
  && pm.permitted('"Mandatory Label\\High Mandatory Level","레이블","S-1-16-12288",""') && !pm.permitted('"BUILTIN\\Users","별칭","S-1-5-32-545",""\r\n"Mandatory Label\\Medium Mandatory Level","레이블","S-1-16-8192",""'));
const frameBound = render.analyze({ threadSamples: [probeLine([]), probeLine([{ id: 1, n: 'GameThread', c: 30, main: true }])], samples: rec({ '3D': 30 }), pid: 50, ctx: ueCtx, frames: s2 });
check('render: GPU busy through each frame is gpu-bound even at a low engine share', frameBound.bound === 'gpu' && frameBound.frames === s2
  && /66\.7 fps \(p50 10 ms, p99 30 ms, 1 not displayed, vsync on\); the GPU was busy 90% of each frame\./.test(frameBound.note), frameBound.note);
const pick = render.pickTarget({ procs: [{ p: 1, n: 'dwm', g: { '3D': 60 } }, { p: 2, n: 'wallpaper64', g: { '3D': 19 } }, { p: 3, n: 'Game', g: { '3D': 40 } },
  { p: 4, n: 'llama-server', g: { Compute: 50 } }] }, { hubPid: 100, registry: new Map([[4, { jobId: 'j' }]]), parents: new Map() });
check('render: target skips background and Hub jobs', pick?.p === 3, JSON.stringify(pick));

// ---- stage 3: process inspection ---------------------------------------------------------------------------------
const inspect = require('../src/core/debugging/process-inspect');
const os = require('os'), path = require('path');
const model = path.join(os.homedir(), '.cache', 'm.gguf');
const before = { t: 0, fileCount: 2, files: [{ path: model, image: false, mapped: 4e9, resident: 1e8 }, { path: 'C:\\Windows\\x.dll', image: true, mapped: 1e7, resident: 5e6 }] };
const after = { t: 2000, fileCount: 3, files: [{ path: model, image: false, mapped: 4e9, resident: 3e8 }, { path: 'C:\\Windows\\x.dll', image: true, mapped: 1e7, resident: 4e6 },
  { path: 'D:\\new.pak', image: false, mapped: 1e9, resident: 2e7 }] };
const grown = inspect.fileGrowth(before, after);
check('inspect: fastest-growing file first, profile masked', grown[0].path === '%USERPROFILE%\\.cache\\m.gguf' && grown[0].growthBytesPerSec === 1e8, JSON.stringify(grown[0]));
check('inspect: file absent from a complete list grew from zero; trimmed file is 0', grown.find((f) => f.path === 'D:\\new.pak').growthBytesPerSec === 1e7
  && grown.find((f) => f.image).growthBytesPerSec === 0, JSON.stringify(grown));
check('inspect: unknown before a truncated list', inspect.fileGrowth({ ...before, fileCount: 90 }, after).find((f) => f.path === 'D:\\new.pak').growthBytesPerSec === null);
const hw = inspect.hardware([{ t: 0, procs: [{ p: 7, n: 'x', c: 10, m: 1, r: 0, w: 0, vd: 0, vs: 0, g: {}, hf: 100 }] }, { t: 2000, procs: [{ p: 7, n: 'x', c: 10, m: 1, r: 0, w: 0, vd: 0, vs: 0, g: {}, hf: 300 }] }], 7);
check('inspect: hard faults avg and peak', hw.hardFaultsPerSec.avg === 200 && hw.hardFaultsPerSec.peak === 300 && hw.cpuPercent.avg === 10, JSON.stringify(hw.hardFaultsPerSec));
const oldStart = '134000000000000001', newStart = '134000000000000002';
function faultSample(t, started, hf, cpu = 0) {
  return { t, procs: [{ p: 7, n: 'same', c: cpu, m: 1, r: 0, w: 0, vd: 0, vs: 0, g: {}, started, hf }] };
}
const reused = [faultSample(0, oldStart, 900, 95), faultSample(2000, newStart, null, 4), faultSample(4000, newStart, 0, 6), faultSample(6000, newStart, 10, 5)];
const fresh = inspect.hardware(reused, 7);
check('inspect: identical PID and name after restart get only new lifetime and measured samples',
  fresh.hardFaultsPerSec.avg === 5 && fresh.hardFaultsPerSec.peak === 10 && fresh.cpuPercent.peak === 6);
check('inspect: failed reading and warming up are unknown, a measured zero remains zero',
  inspect.hardware([faultSample(0, null, null)], 7).hardFaultsPerSec === null &&
  inspect.hardware([faultSample(0, newStart, null)], 7).hardFaultsPerSec === null &&
  inspect.hardware([faultSample(0, newStart, 0)], 7).hardFaultsPerSec?.avg === 0);

// ---- stage 4: frame capture (rdc JSON shapes from rdc-cli 0.6.3's info/stats/draws/counter_fetch handlers) ------------
const fc = require('../src/core/debugging/frame-capture');
const capInfo = { Capture: path.join(os.homedir(), 'UE', 'Saved', 'f.rdc'), API: 'D3D12', Events: 900, 'Draw Calls': '120 (100 indexed, 20 non-indexed, 5 dispatches)' };
const capStats = { per_pass: [{ name: 'ShadowDepths', draws: 80, dispatches: 0, triangles: 9e5, rt_w: 2048, rt_h: 2048, attachments: 1 },
  { name: 'BasePass', draws: 30, dispatches: 0, triangles: 3e5, rt_w: 1920, rt_h: 1080, attachments: 4 },
  { name: 'PostProcessing', draws: 10, dispatches: 5, triangles: 20, rt_w: '-', rt_h: '-', attachments: 0 }],
largest_resources: [{ id: 1, name: 'SceneColor', type: 'Texture', size: 33177600, format: 'R16G16B16A16_FLOAT' }] };
const capDraws = [{ eid: 10, type: 'DrawIndexed', triangles: 5e5, instances: 1, pass: 'ShadowDepths', marker: 'CSM' },
  { eid: 20, type: 'DrawIndexed', triangles: 1e5, instances: 2, pass: 'BasePass', marker: 'SM_Rock' },
  { eid: 30, type: 'Draw', triangles: 1, instances: 1, pass: 'PostProcessing', marker: 'Tonemap' }];
const capCounters = { rows: [{ eid: 10, counter: 'GPU Duration', value: 0.001, unit: 'Seconds' }, { eid: 20, counter: 'GPU Duration', value: 0.003, unit: 'Seconds' },
  { eid: 30, counter: 'GPU Duration', value: 0.0005, unit: 'Seconds' }, { eid: 20, counter: 'Samples Passed', value: 9, unit: 'Absolute' }] };
const cs = fc.summarize({ info: capInfo, stats: capStats, draws: capDraws, counters: capCounters, top: 2,
  doc: { rdgPasses: [{ name: 'BasePass', file: 'Private/BasePassRendering.cpp', line: 7 }] } });
check('capture: API passes by replay GPU time and share, other counters ignored', cs.passBasis === 'api' && cs.passes.map((p) => p.name).join() === 'BasePass,ShadowDepths,PostProcessing'
  && cs.passes[0].gpuMs === 3 && cs.passes[0].gpuShare === 0.667 && cs.gpu.totalMs === 4.5 && cs.gpu.timedEvents === 3 && cs.gpu.basis === 'replay', JSON.stringify(cs.passes));
check('capture: top draws, render target, source, masked path', cs.topDraws.length === 2 && cs.topDraws[0].eid === 20 && cs.passes[1].target === '2048x2048'
  && cs.passes[2].target === null && cs.passes[0].source[0].line === 7 && cs.capture.startsWith('%USERPROFILE%') && cs.largestResources[0].bytes === 33177600, JSON.stringify(cs).slice(0, 400));
const noCounters = fc.summarize({ info: capInfo, stats: capStats, draws: capDraws, counters: null });
check('capture: without GPU Duration ranks by triangles', noCounters.gpu === null && noCounters.passes[0].name === 'ShadowDepths' && noCounters.topDraws[0].eid === 10
  && noCounters.passes[0].gpuMs === null && /triangles/.test(noCounters.note));
const map = { rdgPasses: [{ name: 'BasePass', file: 'a.cpp', line: 1 }, { name: 'TSR %dx%d', file: 't.cpp', line: 2 }, { name: 'FX', file: 'x.cpp', line: 3 }],
  gpuStats: [{ name: 'ShadowDepths', file: 's.cpp', line: 4 }], drawEvents: [] };
const known = fc.matcher(map);
check('capture: render-map match by name stem, two-letter stems skipped', known('BasePass')[0].file === 'a.cpp' && known('TSR 1920x1080')[0].line === 2
  && known('ShadowDepths')[0].kind === 'gpuStats' && !known('FX 2') && !known('Translucency'));
// D3D12: rdc's passes are command lists, so passes come from the marker path (rows as MARKER_SCRIPT returns them)
const marked = [[10, 5e5, 0, ['Frame 1', 'Scene', 'ShadowDepths', 'CSM']], [20, 1e5, 0, ['Frame 1', 'Scene', 'BasePass', 'MI_Rock']],
  [30, 1, 0, ['Frame 1', 'Scene', 'PostProcessing', 'Tonemap']], [40, 0, 1, ['Frame 1', 'Scene', 'Lumen', 'Lumen Reflections']]];
const ms = fc.summarize({ info: capInfo, stats: capStats, draws: capDraws, counters: capCounters, markers: marked, doc: map });
check('capture: marker passes — deepest known marker, else the nearest; shared root dropped', ms.passBasis === 'markers' && ms.markerRoot === 'Frame 1 > Scene'
  && ms.passes.map((p) => p.name).join() === 'BasePass,ShadowDepths,Tonemap,Lumen Reflections' && ms.passes[0].source[0].file === 'a.cpp' && ms.passes[0].path === null
  && ms.passes[2].path === 'PostProcessing' && ms.passes[3].dispatches === 1 && ms.passes[3].draws === 0 && ms.topDraws[0].pass === 'BasePass', JSON.stringify(ms.passes));

// ---- hard-fault trace text (xperf dumper): synthetic lines in the dumper's header-then-events layout --------------------
{
  const hf = require('../src/core/debugging/hardfault-trace');
  const dump = [
    '               P-Start,  TimeStamp,     Process Name ( PID),  ParentPID,  SessionID,  UniqueKey',
    '             P-DCStart,  TimeStamp,     Process Name ( PID),  ParentPID,  SessionID,  UniqueKey',
    '             HardFault,  TimeStamp,     Process Name ( PID),   ThreadID,             VirtAddr,           ByteOffset,     IOSize, ElapsedTime,         FileObject, FileName',
    '             P-DCStart,          0,          game.exe (4100),       900,          1, 0xffffa1',
    '               P-Start,     120000,        loader.exe (5200),      4100,          1, 0xffffb2',
    '             HardFault,     200000,          game.exe (4100),       7001,   0x00007ff600001000,   0x0000000000400000, 0x00010000,        2500, 0xffffc10000000001, C:\\pagefile.sys',
    '             HardFault,     210000,          game.exe (4100),       7001,   0x00007ff600002000,   0x0000000000410000, 0x00008000,        1500, 0xffffc10000000001, C:\\pagefile.sys',
    '             HardFault,     220000,          game.exe (4100),       7002,   0x00007ff600003000,   0x0000000000001000, 0x00001000,         400, 0xffffc10000000002, C:\\Games\\Demo\\engine.dll',
    '             HardFault,     230000,        loader.exe (5200),       7100,   0x0000020000001000,   0x0000000000002000, 0x00004000,         900, 0xffffc10000000003, C:\\Games\\Demo\\Data, v2\\world.pak',
    '             HardFault,     240000,         ghost.exe (6300),       7200,   0x0000020000002000,   0x0000000000000000, 0x00001000,         100, 0x0000000000000000, ',
    'DiskRead, 250000, game.exe (4100), 7001, 0, 0x1000',
  ].join('\r\n');
  const r = hf.analyze(dump);
  const game = r.processes[0], loader = r.processes.find((p) => p.pid === 5200), ghost = r.processes.find((p) => p.pid === 6300);
  check('hardfault: sources split per process with bytes', r.total.faults === 5 && game.pid === 4100 && game.dominant === 'pagefile'
    && game.sources.pagefile.faults === 2 && game.sources.pagefile.bytes === 0x18000 && game.sources.image.faults === 1 && game.ioMs === 4.4, JSON.stringify(game));
  check('hardfault: mapped file with a comma in its path, unknown when no file', loader.dominant === 'mapped' && loader.topFiles[0].file === 'C:\\Games\\Demo\\Data, v2\\world.pak'
    && ghost.dominant === 'unknown' && r.total.sources.unknown === 1, JSON.stringify([loader, ghost]));
  check('hardfault: process identity says how the pid was confirmed', game.identity === 'running-before-trace' && loader.identity === 'started-in-trace' && loader.startUs === 120000 && ghost.identity === 'pid-only');
  check('hardfault: classification by file name', hf.sourceOf('D:\\swapfile.sys') === 'pagefile' && hf.sourceOf('C:\\a\\b.NODE') === 'image' && hf.sourceOf('C:\\pagefile.sys.bak') === 'mapped' && hf.sourceOf('') === 'unknown');
  const reordered = hf.analyze(['HardFault, TimeStamp, FileName', 'HardFault, 5, C:\\x.dll'].join('\n')); // a build without size or process columns
  check('hardfault: missing columns are named, sizes and I/O time are null rather than 0', reordered.missing.join() === 'Process Name ( PID),IOSize,ElapsedTime'
    && reordered.total.bytes === null && reordered.processes[0].bytes === null && reordered.processes[0].ioMs === null, JSON.stringify(reordered));
  // pid 800 is one process when the trace starts, exits, and the pid is given to another program; the end rundown repeats the survivor
  const reuse = hf.analyze(['P-Start, TimeStamp, Process Name ( PID)', 'P-DCStart, TimeStamp, Process Name ( PID)', 'HardFault, TimeStamp, Process Name ( PID), IOSize, ElapsedTime, FileName',
    'HardFault, 5, early.exe (700), 0x1000, 10, C:\\a.dll', 'P-DCStart, 0, old.exe (800)', 'HardFault, 10, old.exe (800), 0x2000, 10, C:\\pagefile.sys',
    'P-Start, 50, new.exe (800)', 'HardFault, 60, new.exe (800), 0x1000, 10, C:\\new.dll', 'HardFault, 70, new.exe (800), 0x1000, 10, C:\\new.dll', 'P-DCStart, 90, new.exe (800)'].join('\n'));
  const [oldP, newP] = ['old.exe', 'new.exe'].map((n) => reuse.processes.find((p) => p.name === n)), early = reuse.processes.find((p) => p.pid === 700);
  check('hardfault: a reused pid is two process instances, not one total', reuse.processes.length === 3 && oldP.faults === 1 && oldP.identity === 'running-before-trace' && oldP.dominant === 'pagefile'
    && newP.faults === 2 && newP.identity === 'started-in-trace' && newP.startUs === 50 && oldP.pidReused && newP.pidReused && !early.pidReused && early.identity === 'pid-only', JSON.stringify(reuse.processes));
  check('hardfault: a text without hard-fault events says so', hf.analyze('DiskRead, 1, a.exe (1)').missing.join() === 'HardFault' && hf.analyze('').processes.length === 0);
}

// ---- live probe on this node process (Windows): the C# compiles, threads and files both answer ------------------------
(async () => {
  const refused = (p, code) => fc.capturePath(p).then(() => false, (e) => e.message === code);
  check('capture: option-like and non-.rdc paths refused', await refused('-o.rdc', 'not_rdc') && await refused('notes.txt', 'not_rdc') && await refused('', 'not_rdc'));
  const missing = path.join(os.tmpdir(), 'aihub-missing-capture.rdc');
  check('capture: missing file refused', await refused(missing, 'capture_not_found'));
  const whyCap = await fc.analyze({ path: missing }).then(() => 'opened', (e) => e.message); // rdc present or not, nothing is opened
  check('capture: analyze stops before opening anything', ['rdc_not_found', 'capture_not_found'].includes(whyCap), whyCap);
  if (process.platform === 'win32') {
    const probe = require('../src/core/debugging/probe');
    try {
      const [snap] = await probe.run('files', process.pid);
      check('probe files: node.exe image is mapped and resident', snap.files.some((f) => /node\.exe$/i.test(f.path) && f.image && f.resident > 0), JSON.stringify(snap.files.slice(0, 3)));
      const lines = await probe.run('threads', process.pid, { intervalMs: 300, count: 2 });
      check('probe threads: primed lines with a main thread', lines.length === 2 && lines.every((l) => l.primed && l.total > 0) && lines.some((l) => l.threads.some((t) => t.main)),
        JSON.stringify(lines[0]).slice(0, 300));
      const busy = await Promise.allSettled([probe.run('files', process.pid), probe.run('files', process.pid), probe.run('files', process.pid)]);
      check('probe: a third concurrent run is refused', busy.filter((r) => r.status === 'rejected' && r.reason.message === 'probe_busy').length === 1);
    } catch (e) { check('probe runs', false, e.message); }
    check('probe: bad pid refused', await probe.run('files', -1).then(() => false, (e) => e.message === 'bad_pid'));
    // the real path (detect, whoami, PresentMon if installed): node presents nothing, so any outcome is a named fallback
    check('presentmon: whoami answers', typeof await pm.canTrace() === 'boolean');
    const why = await pm.capture(process.pid, 1).then(() => 'frames', (e) => e.message);
    check('presentmon: capture on a non-presenting process falls back', ['presentmon_not_found', 'etw_not_permitted', 'no_presents'].includes(why), why);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

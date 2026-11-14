#!/usr/bin/env node
// UE tuning without a model: cvar extraction, scalability levels, pass→knob matching, CSV profiles, engine-topic graph scope.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ue-tuning-'));
process.env.APPDATA = path.join(tmp, 'Roaming');
const cvarmap = require('../src/core/cvarmap');
const profile = require('../src/core/ue-profile');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); } };
const write = (rel, text) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };

// --- cvar extraction
const cpp = `
static TAutoConsoleVariable<int32> CVarDown(
	TEXT("r.Lumen.Reflections.DownsampleFactor"),
	1,
	TEXT("Downsample factor, in pixels (a, b).\\n")
	TEXT("Larger is cheaper."),
	ECVF_Scalability | ECVF_RenderThreadSafe);
int32 GLumenProbeSize = 16;
static FAutoConsoleVariableRef CVarProbe(TEXT("r.Lumen.ScreenProbeGather.DownsampleFactor"), GLumenProbeSize, TEXT("Probe tile size"), ECVF_Scalability);
// static TAutoConsoleVariable<int32> CVarComment(TEXT("r.Commented.Out"), 0, TEXT("x"), ECVF_Default);
static FAutoConsoleCommand CmdDump(TEXT("r.Lumen.DumpStats"), TEXT("Dumps stats"), FConsoleCommandDelegate::CreateStatic(&Dump));
static TAutoConsoleVariable<float> CVarRuntimeName(*FString::Printf(TEXT("r.Built.%d"), 1), 0.f, TEXT("runtime"));
`;
const found = cvarmap.cvarsInFile('Runtime/Renderer/Private/Lumen/LumenReflections.cpp', cpp);
const byName = Object.fromEntries(found.map((c) => [c.n, c]));
check('TAutoConsoleVariable: default, joined help, flags, line', byName['r.Lumen.Reflections.DownsampleFactor']?.d === '1'
  && byName['r.Lumen.Reflections.DownsampleFactor'].h.includes('Larger is cheaper') && byName['r.Lumen.Reflections.DownsampleFactor'].fl.join() === 'Scalability,RenderThreadSafe'
  && byName['r.Lumen.Reflections.DownsampleFactor'].l === 2, JSON.stringify(byName['r.Lumen.Reflections.DownsampleFactor']));
check('Ref variable resolves the global initializer', byName['r.Lumen.ScreenProbeGather.DownsampleFactor']?.d === '16' && byName['r.Lumen.ScreenProbeGather.DownsampleFactor'].ty === 'int32');
check('commands kept as commands, runtime-built names skipped', byName['r.Lumen.DumpStats']?.k === 'command' && !found.some((c) => /Built/.test(c.n)));

// --- scalability + engine tree fixture
const engine = path.join(tmp, 'UE', 'Engine');
write('UE/Engine/Config/BaseScalability.ini', '[ReflectionQuality@2]\nr.Lumen.Reflections.DownsampleFactor=2\n[ReflectionQuality@3]\nr.Lumen.Reflections.DownsampleFactor=1\n[AntiAliasingQuality@3]\nr.TSR.History.ScreenPercentage=200\n');
check('BaseScalability levels by lowercase name', cvarmap.parseScalability(fs.readFileSync(path.join(engine, 'Config', 'BaseScalability.ini'), 'utf8'))['r.lumen.reflections.downsamplefactor']['ReflectionQuality@2'] === '2');
write('UE/Engine/Source/Runtime/Renderer/Private/Lumen/LumenReflections.cpp', `${cpp}\nDEFINE_GPU_STAT(LumenReflections);\nvoid FDeferredShadingSceneRenderer::RenderLumenReflections() {}\n`);
write('UE/Engine/Source/Runtime/Renderer/Public/LumenReflectionTypes.h', 'class RENDERER_API FLumenReflectionState\n{\n  int32 Frames() const { return 1; }\n};\n');
write('UE/Engine/Source/Runtime/Renderer/Private/LumenReflectionTypes.cpp', 'int32 FLumenReflectionState::Tick(int32 X) { return X; }\n');
write('UE/Engine/Source/Runtime/Renderer/Private/PostProcess/TemporalSuperResolution.cpp', `DEFINE_GPU_STAT(TemporalSuperResolution);\n${
  Array.from({ length: 14 }, (_, i) => `static TAutoConsoleVariable<int32> CVarX${i}(TEXT("r.Unrelated.Knob${i}"), ${i}, TEXT("noise"), ECVF_Default);`).join('\n')}
static TAutoConsoleVariable<float> CVarTSR(TEXT("r.TSR.History.ScreenPercentage"), 100.0f, TEXT("History resolution"), ECVF_Scalability);\n`);
const symbolmap = require('../src/core/symbolmap');
const renderpipe = require('../src/core/renderpipe');
symbolmap.scan({ name: 'fx', root: path.join(engine, 'Source') });
renderpipe.scan('fx-render', path.join(engine, 'Source', 'Runtime', 'Renderer'));
const tsr = symbolmap.cvars('fx', 'TemporalSuperResolution', { renderMap: 'fx-render' });
check('pass name → same-file knob via acronym, unrelated knobs of a hub file dropped',
  tsr.cvars.length === 1 && tsr.cvars[0].name === 'r.TSR.History.ScreenPercentage' && tsr.cvars[0].scalability['AntiAliasingQuality@3'] === '200', JSON.stringify(tsr.cvars.map((c) => c.name)));
const proj = write('Proj/Proj.uproject', '{}');
write('Proj/Config/DefaultEngine.ini', '[SystemSettings]\nr.Lumen.Reflections.DownsampleFactor=3\n[/Script/Engine.RendererSettings]\nr.Other=1\n');
const refl = symbolmap.cvars('fx', 'r.lumen.reflections', { project: proj });
check('name match carries scalability and project override', refl.cvars[0].name === 'r.Lumen.Reflections.DownsampleFactor' && refl.cvars[0].project[0].value === '3'
  && refl.cvars[0].project[0].file === 'Config/DefaultEngine.ini', JSON.stringify(refl.cvars[0]));
check('help-text search', symbolmap.cvars('fx', 'probe tile').cvars[0]?.name === 'r.Lumen.ScreenProbeGather.DownsampleFactor');

// --- engine-topic scope, enrichment and definitions
const eg = require('../src/core/engine-graph');
const sc = eg.scope('fx', 'LumenReflection', { renderMap: 'fx-render' });
check('engine topic picks header, paired cpp and pass file', ['Runtime/Renderer/Public/LumenReflectionTypes.h', 'Runtime/Renderer/Private/LumenReflectionTypes.cpp',
  'Runtime/Renderer/Private/Lumen/LumenReflections.cpp'].every((f) => sc.paths.includes(f)), JSON.stringify(sc.paths));
const doc = { nodes: [{ id: 'a', label: 'RenderLumenReflections()', source_file: 'Runtime/Renderer/Private/Lumen/LumenReflections.cpp' },
  { id: 'b', label: 'FLumenReflectionState', source_file: 'Runtime/Renderer/Public/LumenReflectionTypes.h' }] };
eg.enrichSource(doc, 'fx', 'fx-render');
check('source nodes get module, cvars, gpu stats and class', doc.nodes[0].engine.gpuStats.includes('LumenReflections') && doc.nodes[0].engine.cvars.includes('r.Lumen.Reflections.DownsampleFactor')
  && doc.nodes[1].engine.class.kind === 'class' && doc.nodes[0].engine.module === 'Renderer', JSON.stringify(doc.nodes.map((n) => n.engine)));
const def = eg.findDefinition('fx', 'FLumenReflectionState::Tick'), inline = eg.findDefinition('fx', 'FLumenReflectionState::Frames');
check('definition in cpp, inline member in header', def.file === 'Runtime/Renderer/Private/LumenReflectionTypes.cpp' && def.line === 1 && inline.inline === true && inline.line === 3, JSON.stringify([def, inline]));
const bin = { nodes: [{ id: 'x', type: 'function', label: 'FLumenReflectionState::Tick' }, { id: 'y', type: 'function', label: 'FUN_180001000' }] };
eg.enrichBinary(bin, 'fx');
check('binary PDB names link to engine classes', bin.nodes[0].engine?.class.name === 'FLumenReflectionState' && !bin.nodes[1].engine && bin.engineMap.linkedNodes === 1);

// --- CSV profile: header repeated at the end, columns added mid-capture, metadata
const header0 = 'EVENTS,FrameTime,GameThreadTime,RenderThreadTime,RHIThreadTime,GPUTime,GPU/LumenReflections';
const rows = [];
for (let i = 0; i < 8; i++) rows.push(`,${10 + (i % 2)},3,9,2,8,1.5`);
for (let i = 0; i < 8; i++) rows.push(`,${10 + (i % 2)},3,9,2,8,1.5,0.5`);
const csvA = write('a.csv', [header0, ...rows, `${header0},GPU/TemporalSuperResolution`, '[HasHeaderRowAtEnd],1,[platform],Windows,[run],a'].join('\n'));
const a = profile.summarize(csvA, { skipFrames: 0 });
check('CSV: all frames kept, late column read, metadata', a.frames === 16 && a.gpuPasses.some((p) => p.stat === 'TemporalSuperResolution' && p.ms.avg === 0.5)
  && a.metadata.platform === 'Windows' && a.bound === 'waits', JSON.stringify({ frames: a.frames, bound: a.bound, passes: a.gpuPasses }));
// Real capture shape (UE 5.8 ThirdPerson, Epic): the render thread equals the frame only because it waits ~4 ms on the
// previous GPU frame's occlusion results; the GPU is the stage that fills the frame.
const csvHoq = write('hoq.csv', ['EVENTS,FrameTime,GameThreadTime,RenderThreadTime,RHIThreadTime,GPUTime,Exclusive/RenderThread/EventWait/Visibility,InputLatencyTime',
  ...Array.from({ length: 8 }, () => ',8.6,2.3,8.6,2.0,8.1,3.95,23.4')].join('\n'));
const hoq = profile.summarize(csvHoq, { skipFrames: 0 });
check('frame pipeline: occlusion wait is not render cost', hoq.bound === 'gpu' && hoq.pipeline.stages.find((s) => s.stage === 'render').ms === 4.65
  && hoq.pipeline.waits.inputLatency.avg === 23.4 && hoq.pipeline.knobs.some((k) => k.name === 'r.GTSyncType'), JSON.stringify(hoq.pipeline.stages));
const csvB = write('b.csv', [header0, ...rows.map((r) => r.replace(',1.5', ',1.0'))].join('\n'));
const cmp = profile.compare(a, profile.summarize(csvB, { skipFrames: 0 }));
check('before/after delta per pass', cmp.passes.find((p) => p.stat === 'LumenReflections').deltaMs === -0.5, JSON.stringify(cmp.passes));
const knobs = profile.withKnobs(profile.summarize(csvA, { skipFrames: 0 }), { map: 'fx', renderMap: 'fx-render', cvars: symbolmap.cvars });
check('costly pass → source and scalability knob first', knobs.gpuPasses.find((p) => p.stat === 'LumenReflections').knobs[0].name === 'r.Lumen.Reflections.DownsampleFactor'
  && knobs.gpuPasses.find((p) => p.stat === 'LumenReflections').sources[0].includes('LumenReflections.cpp'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);

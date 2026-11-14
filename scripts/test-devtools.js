// Unreal/Unity monitor: process roles, editor-log events (lines copied from real UE 5.8 / Unity 6000.3 logs), findings.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const devtools = require('../src/core/devtools');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); } };
const proc = (p, n, extra = {}) => ({ p, pp: 0, n, c: 0, m: 50e6, r: 0, w: 0, vd: 0, vs: 0, g: {}, ...extra });

(async () => {
  devtools._test.reset();
  // command lines → roles; nothing but project/log/worker survives
  const worker = devtools.describeEditor({ p: 11, n: 'Unity.exe', cmd: 'Unity.exe -adb2 -batchMode -noUpm -name AssetImportWorker0 -projectPath "C:/Proj A" -logFile "C:/Proj A/Logs/AssetImportWorker0.log" -accessToken=SECRET123' });
  const unity = devtools.describeEditor({ p: 10, n: 'Unity.exe', cmd: 'Unity.exe -projectpath "C:/Proj A" -useHub -hubIPC -cloudEnvironment production -hubSessionId abc' });
  const ue = devtools.describeEditor({ p: 20, n: 'UnrealEditor.exe', exe: 'C:/UE/Engine/Binaries/Win64/UnrealEditor.exe', cmd: '"C:/UE/Engine/Binaries/Win64/UnrealEditor.exe" "C:/Users/U/Unreal Projects/Game/Game.uproject" -skipcompile' });
  const game = devtools.describeEditor({ p: 21, n: 'UnrealEditor.exe', cmd: 'UnrealEditor.exe C:/b/TPBench.uproject -game -abslog=C:/runs/x.log' });
  check('Unity worker is an asset-import role', worker.role === 'asset-import' && worker.worker === 'AssetImportWorker0' && worker.project === 'C:/Proj A');
  check('command-line secrets are not kept', !JSON.stringify([worker, unity]).includes('SECRET123') && !JSON.stringify(unity).includes('abc'));
  check('Unity editor logs to Editor.log by default', unity.role === 'editor' && /Unity[\\/]Editor[\\/]Editor\.log$/.test(unity.log));
  check('UE editor log follows the project', ue.role === 'editor' && ue.log.replace(/\\/g, '/') === 'C:/Users/U/Unreal Projects/Game/Saved/Logs/Game.log');
  check('UE -game run with -abslog', game.role === 'game' && game.log === 'C:/runs/x.log');

  devtools.updateEditors([{ p: 20, n: 'UnrealEditor.exe', exe: 'C:/UE/x/UnrealEditor.exe', cmd: '"C:/G/Game.uproject"' }, { p: 10, n: 'Unity.exe', cmd: 'Unity.exe -projectPath C:/P' }]);
  const parents = new Map([[300, 20], [301, 300], [400, 10]]);
  check('roles by name and by ancestor', devtools.roleOf(proc(5, 'ShaderCompileWorker'), parents).role === 'shader-compile'
    && devtools.roleOf(proc(301, 'cl'), parents)?.role === 'build' && devtools.roleOf(proc(400, 'csc'), parents)?.app === 'unity'
    && devtools.roleOf(proc(9, 'cl'), parents) === null && devtools.roleOf(proc(10, 'Unity'), parents).role === 'editor');

  // Unreal log lines (UE 5.8, UTC timestamps)
  const st = {};
  const parse = (app, line) => devtools.parseLine(app, line, app === 'unreal' ? st : ust, 1_700_000_000_000);
  const ust = {};
  const w = parse('unreal', '[2026.05.14-12.15.59:911][  0]LogShaderCompilers: Display: Using 9 local workers for shader compilation');
  check('UE event time from the log stamp', w.kind === 'shader-workers' && w.workers === 9 && w.t === Date.UTC(2026, 4, 14, 12, 15, 59, 911));
  const load = parse('unreal', '[2026.10.13-16.13.40:100][  1]LogLoad: Took 0.702477 seconds to LoadMap(/Game/ThirdPerson/Lvl_ThirdPerson)');
  check('LoadMap duration', load.kind === 'load-map' && load.ms === 702 && load.map === '/Game/ThirdPerson/Lvl_ThirdPerson');
  parse('unreal', '[2026.10.13-16.13.41:000][  2]LogPSOHitching: Encountered 8 PSO creation hitches so far (2 graphics, 6 compute). 0 of them were precached.');
  parse('unreal', '[2026.10.13-16.13.50:000][ 90]LogPSOHitching: Encountered 50 PSO creation hitches so far (8 graphics, 42 compute). 0 of them were precached.');
  parse('unreal', '[2026.10.13-16.13.42:000][  3]LogMaterial: Display: Missing cached shadermap for WorldGridMaterial in PCD3D_SM6, Default, SM6, Editor (DDC key hash: efd0)');
  const stats = parse('unreal', '[2026.10.13-16.13.45:000][  9]LogShaderCompilers: Display: Jobs assigned 1,203, completed 1,203 (100%)');
  parse('unreal', '[2026.10.13-16.13.45:000][  9]LogShaderCompilers: Display: Average processing rate: 22.06 jobs/sec');
  parse('unreal', '[2026.10.13-16.13.45:000][  9]LogShaderCompilers: Display: Effective parallelization: 6.81 (times faster than compiling all shaders on one thread). Compare with number of workers: 8 - 0.850796');
  check('shader compile summary block', stats.assigned === 1203 && stats.jobsPerSec === 22.06 && stats.parallelization === 6.81);
  const lc = parse('unreal', '[2026.10.13-16.14.00:000][100]LogLiveCoding: Display: Compile error:');
  check('Live Coding failure', lc.kind === 'live-coding' && lc.failed && lc.stage === 'compile error');

  // Unity log lines (6000.3 Editor.log)
  parse('unity', '[Worker1] Start importing Assets/Art/Rock.prefab using Guid(8fd42c15ddc11d508705acb334c4ffe5) (PrefabImporter)');
  const imp = parse('unity', "[Worker1]  -> (artifact id: '8fd42c15ddc11d508705acb334c4ffe5') in 2.5 seconds");
  parse('unity', "[Worker2]  -> (artifact id: '1b8f8382c3b04fc34f11ea6f1b60b782') in 0.0978414 seconds");
  check('slow import becomes an event, fast ones only count', imp.kind === 'import' && imp.asset === 'Assets/Art/Rock.prefab' && imp.ms === 2500 && imp.worker === 1);
  const reload = parse('unity', 'Domain Reload Profiling: 10195ms');
  for (const l of ['\tBeginReloadAssembly (8191ms)', '\t\tLoadAssemblies (8162ms)', '\tAnalyzeDomain (803ms)', '\tRebuildCommonClasses (470ms)', '\tExecutionOrderSort (0ms)', '\tinitialDomainReloadingComplete (259ms)']) parse('unity', l);
  parse('unity', 'Asset Pipeline Refresh (id=fbc6fb96d0e65024884fef92c6139716): Total: 0.042 seconds - Initiated by StopAssetImportingV2(NoUpdateAssetOptions)');
  check('domain reload keeps Unity\'s own top phases', reload.ms === 10195 && reload.phases.length === 4 && reload.phases[0].phase === 'BeginReloadAssembly');
  const tundra = parse('unity', '*** Tundra build failed (13.15 seconds), 61 items updated, 61 evaluated');
  parse('unity', 'Compiling shader "Hidden/CoreSRP/CoreCopy" pass "" (fp)');
  check('script build result', tundra.kind === 'script-build' && tundra.failed && tundra.ms === 13150);
  check('missing license (seen live on this PC: batch exit 198)', parse('unity', 'No valid Unity Editor license found. Please activate your license.').kind === 'license-error');

  // window summary: roles, counters, findings
  const t0 = 1_700_000_000_000;
  const samples = Array.from({ length: 8 }, (_, i) => ({ t: t0 - 14000 + i * 2000, cpu: 80, procs: [
    proc(20, 'UnrealEditor', { c: 6, vd: 2e9, g: { '3D': 30 } }), proc(31, 'ShaderCompileWorker', { c: 22 }), proc(32, 'ShaderCompileWorker', { c: 21 }),
    proc(33, 'ShaderCompileWorker', { c: 20 }), proc(10, 'Unity', { c: 3 })] }));
  const dev = await devtools.summarize(samples, { since: t0 - 20000, until: t0 + 1000, parents });
  const un = dev.find((d) => d.app === 'unreal'), un2 = dev.find((d) => d.app === 'unity');
  const sc = un.roles.find((r) => r.role === 'shader-compile');
  check('shader-compile role aggregates three workers', sc.processesPeak === 3 && sc.cpuPercent.avg === 63, JSON.stringify(sc.cpuPercent));
  check('shader compile load finding', un.findings.some((f) => f.kind === 'shader_compile_load' && f.workersPeak === 3));
  check('Unity findings: slow reload, slow import, failed build', ['slow_domain_reload', 'slow_import', 'build_failed'].every((k) => un2.findings.some((f) => f.kind === k)),
    un2.findings.map((f) => f.kind).join());
  check('Unity counters include fast imports and shaders', un2.counters.imports === 2 && un2.counters.shadersCompiled === 1);
  parse('unity', 'Reloading assemblies for play mode.');
  const tr = devtools.traceEvents(t0 - 20000, t0 + 1000);
  check('Perfetto events: slices for timed events', tr.some((e) => e.ph === 'X' && e.name === 'domain-reload' && e.dur === 10195000) && tr.some((e) => e.ph === 'i'));

  // incremental tail: an older log starts at the end, a session log created just now is read from the start
  devtools._test.reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtools-')), log = path.join(dir, 'Editor.log'), fresh = path.join(dir, 'Batch.log');
  fs.writeFileSync(log, 'Domain Reload Profiling: 9999ms\n');
  fs.writeFileSync(fresh, '*** Tundra build success (1.5 seconds), 3 items updated, 9 evaluated\n');
  devtools._test.fresh.ms = 0; // treat Editor.log as an older log
  devtools.updateEditors([{ p: 10, n: 'Unity.exe', cmd: `Unity.exe -projectPath C:/P -logFile "${log}"` }]);
  const realNow = Date.now;
  Date.now = () => Math.floor(fs.statSync(log).birthtimeMs); // whole-ms clock still in the ms the log was born (was a 1-in-8 flake)
  await devtools.poll();
  Date.now = realNow;
  check('history of an older log is skipped', devtools._test.events.length === 0);
  devtools._test.fresh.ms = 120000;
  devtools.updateEditors([{ p: 10, n: 'Unity.exe', cmd: `Unity.exe -projectPath C:/P -logFile "${log}"` }, { p: 12, n: 'Unity.exe', cmd: `Unity.exe -batchmode -projectPath C:/Q -logFile "${fresh}"` }]);
  await devtools.poll();
  check('a just-created batch log is read from the start', devtools._test.events.map((e) => e.kind).join() === 'script-build');
  devtools._test.events.length = 0;
  fs.appendFileSync(log, '*** Tundra build success (32.17 seconds), 793 items updated, 1524 evaluated\nReloading assemblies for play mode.\n');
  await devtools.poll();
  check('appended lines are parsed', devtools._test.events.map((e) => e.kind).join() === 'script-build,play-mode', devtools._test.events.map((e) => e.kind).join());
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exitCode = fail ? 1 : 0;
})();

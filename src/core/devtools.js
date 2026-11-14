// Unreal/Unity view on top of the resource record: which editor sub-process (shader compile, asset import, build, DDC…)
// used which hardware, what the editor was doing at that moment (from its own log), and the engine's own profiling
// artifacts (Unreal Insights traces, CSV profiles, Unity memory snapshots) that cover the same window.
// Logs are read incrementally from the end while an editor runs; nothing is written. Command lines are reduced to the
// project/log path and worker name on arrival and never stored.
'use strict';

const fs = require('fs');
const path = require('path');
const analysis = require('./telemetry-analysis');

const EVENTS_MAX = 1000;
const READ_MAX = 1024 * 1024;
const MINUTE = 60 * 1000;

// PDH process names (no .exe) → [app, role].
const NAMES = [
  [/^UnrealEditor(-Cmd)?$/i, 'unreal', 'editor'], [/^ShaderCompileWorker$/i, 'unreal', 'shader-compile'],
  [/^zenserver$/i, 'unreal', 'ddc'], [/^(UnrealBuildTool|UbaHost|UbaCli)$/i, 'unreal', 'build'],
  [/^LiveCodingConsole$/i, 'unreal', 'live-coding'], [/^(UnrealTraceServer|UnrealInsights)$/i, 'unreal', 'trace'],
  [/^CrashReportClient(Editor)?$/i, 'unreal', 'crash'], [/^UnrealPak$/i, 'unreal', 'pak'],
  [/^Unity$/i, 'unity', 'editor'], [/^UnityShaderCompiler$/i, 'unity', 'shader-compile'],
  [/^(bee_backend|Unity\.ILPP\.Runner|Unity\.SourceGenerators.*)$/i, 'unity', 'script-build'],
  [/^UnityPackageManager$/i, 'unity', 'packages'], [/^UnityCrashHandler(32|64)$/i, 'unity', 'crash'],
  [/^Unity Hub$/i, 'unity', 'hub'], [/^Unity\.Licensing\.Client$/i, 'unity', 'licensing'],
];
// Compilers and hosts started by an editor or build tool take the role of that ancestor's app.
const BUILD_CHILD = /^(cl|link|lib|clang.*|lld-link|dotnet|csc|VBCSCompiler|MSBuild|rc|mt|ispc|netcorerun|conhost)$/i;

const editors = new Map(); // pid -> { app, role, project, log, exe }
const watchers = new Map(); // log file -> { app, offset, rest, state }
const events = []; // { t, app, kind, ... }
const minutes = new Map(); // `${app}:${minuteStart}` -> counters
let polling = false;
const fresh = { ms: 120000 };

function arg(cmd, name) {
  const m = String(cmd).match(new RegExp(`(?:^|\\s)-${name}(?:=|\\s+)("([^"]+)"|(\\S+))`, 'i'));
  return m ? (m[2] || m[3]) : null;
}

/** Reduce an editor command line to what the monitor needs. */
function describeEditor({ p, n, exe, cmd }) {
  const name = String(n || '').replace(/\.exe$/i, '');
  if (/^Unity$/i.test(name)) {
    const worker = arg(cmd, 'name');
    const role = /^AssetImportWorker\d+$/i.test(worker || '') ? 'asset-import' : / -batchmode/i.test(cmd) ? 'batch' : 'editor';
    const project = arg(cmd, 'projectPath');
    let log = arg(cmd, 'logFile');
    if (!log && role === 'editor') log = path.join(process.env.LOCALAPPDATA || '', 'Unity', 'Editor', 'Editor.log');
    return { pid: p, app: 'unity', role, worker: role === 'asset-import' ? worker : null, project, log: log && log !== '-' ? log : null, exe };
  }
  const found = String(cmd).match(/"([^"]+\.uproject)"|([^\s"]+\.uproject)/i);
  const uproject = found ? found[1] || found[2] : null;
  const role = /(^|\s)-game\b/i.test(cmd) ? 'game' : /(^|\s)-run=/i.test(cmd) ? 'commandlet' : 'editor';
  const log = arg(cmd, 'abslog') || (uproject ? path.join(path.dirname(uproject), 'Saved', 'Logs', `${path.basename(uproject, '.uproject')}.log`) : null);
  return { pid: p, app: 'unreal', role, project: uproject, log, exe };
}

let lastUnrealExe = null; // engine of the last seen UE editor, for opening its own Unreal Insights

/** Editor list from the sampler (every 15 s): start tailing new editor logs, keep logs of editors that went away. */
function updateEditors(rows) {
  editors.clear();
  for (const row of rows || []) {
    const e = describeEditor(row);
    editors.set(e.pid, e);
    if (e.app === 'unreal' && e.exe) lastUnrealExe = e.exe;
    // Asset-import workers write their own logs, but the editor log already carries their [WorkerN] lines.
    if (e.log && e.role !== 'asset-import' && !watchers.has(e.log)) watchers.set(e.log, { app: e.app, offset: null, rest: '', state: {} });
  }
  const live = new Set([...editors.values()].map((e) => e.log));
  // A log stays tailed for one more refresh after its editor exits, so the last lines are read.
  for (const [file, w] of watchers) if (live.has(file)) w.stale = 0; else if ((w.stale = (w.stale || 0) + 1) >= 2) watchers.delete(file);
}

function roleOf(proc, parents, historical = false) {
  const e = !historical && editors.get(proc.p);
  if (e) return { app: e.app, role: e.role };
  const name = String(proc.n || '');
  for (const [re, app, role] of NAMES) if (re.test(name)) return { app, role };
  if (historical || !BUILD_CHILD.test(name)) return null;
  let cur = parents?.get(proc.p) || 0;
  for (let hop = 0; hop < 8 && cur > 0; hop++) {
    const ed = editors.get(cur);
    if (ed) return { app: ed.app, role: ed.app === 'unity' ? 'script-build' : 'build' };
    cur = parents.get(cur) || 0;
  }
  return null;
}

// ---- editor log parsing -------------------------------------------------------------------------------------------

const UE_TIME = /^\[(\d{4})\.(\d\d)\.(\d\d)-(\d\d)\.(\d\d)\.(\d\d):(\d{3})\]\[\s*\d+\]/;
const num = (s) => Number(String(s).replace(',', '.'));

function count(app, t, key, by = 1, sample = null) {
  const k = `${app}:${Math.floor(t / MINUTE) * MINUTE}`;
  const c = minutes.get(k) || { app, t: Math.floor(t / MINUTE) * MINUTE, imports: 0, importMs: 0, shaders: 0, shadermapMisses: 0, names: [] };
  c[key] += by;
  if (sample && c.names.length < 5 && !c.names.includes(sample)) c.names.push(sample);
  minutes.set(k, c);
  if (minutes.size > 120) minutes.delete(minutes.keys().next().value);
}

function push(e) {
  events.push(e);
  if (events.length > EVENTS_MAX) events.splice(0, events.length - EVENTS_MAX);
  return e;
}

/** One log line → event (or counter update). `state` carries multi-line context per log. */
function parseLine(app, raw, state, now = Date.now()) {
  if (app === 'unreal') {
    const ts = raw.match(UE_TIME);
    const t = ts ? Date.UTC(+ts[1], +ts[2] - 1, +ts[3], +ts[4], +ts[5], +ts[6], +ts[7]) : now; // UE logs UTC by default
    const line = ts ? raw.slice(ts[0].length) : raw;
    let m;
    if ((m = line.match(/^LogMaterial: Display: Missing cached shadermap for (\S+)/))) return count(app, t, 'shadermapMisses', 1, m[1]);
    if ((m = line.match(/^LogShaderCompilers: Display: Using (\d+) local workers/))) return push({ t, app, kind: 'shader-workers', workers: +m[1] });
    if ((m = line.match(/^LogShaderCompilers: Display: Jobs assigned ([\d,]+), completed ([\d,]+)/))) {
      return (state.shaderStats = push({ t, app, kind: 'shader-compile-stats', assigned: num(m[1].replace(/,/g, '')), completed: num(m[2].replace(/,/g, '')) }));
    }
    if (state.shaderStats && (m = line.match(/^LogShaderCompilers: Display: Average processing rate: ([\d.]+) jobs\/sec/))) { state.shaderStats.jobsPerSec = num(m[1]); return null; }
    if (state.shaderStats && (m = line.match(/^LogShaderCompilers: Display: Effective parallelization: ([\d.]+)/))) { state.shaderStats.parallelization = num(m[1]); return null; }
    if (state.shaderStats && (m = line.match(/^LogShaderCompilers: Display: Time at least one job was in flight.*: ([\d.]+) s/))) { state.shaderStats.busySeconds = num(m[1]); return null; }
    if ((m = line.match(/^LogPSOHitching: Encountered (\d+) PSO creation hitches so far \((\d+) graphics, (\d+) compute\)\. (\d+) of them were precached/))) {
      return push({ t, app, kind: 'pso-hitches', total: +m[1], graphics: +m[2], compute: +m[3], precached: +m[4] });
    }
    if ((m = line.match(/^LogLoad: Took ([\d.]+) seconds to LoadMap\((.+)\)/))) return push({ t, app, kind: 'load-map', ms: Math.round(num(m[1]) * 1000), map: m[2] });
    if (/^LogInit: Display: Engine is initialized/.test(line)) return push({ t, app, kind: 'engine-ready' });
    if ((m = line.match(/Play in editor total start time ([\d.,]+) seconds/))) return push({ t, app, kind: 'pie-start', ms: Math.round(num(m[1]) * 1000) });
    if ((m = line.match(/^LogLiveCoding: Display: (Compiling\.\.\.|Compile success!|Compile error:|Linking\.\.\.|Link sucess!|Link error:|Patching\.\.\.|Patching done!)/))) {
      return push({ t, app, kind: 'live-coding', stage: m[1].replace(/[.:!]+$/, '').replace('sucess', 'success').toLowerCase(), failed: /error/i.test(m[1]) });
    }
    return null;
  }
  const t = now, line = raw.trim();
  let m;
  if (state.reload) {
    if ((m = line.match(/^(\w[\w .]*?) \((\d+)ms\)$/))) { state.reload.phases.push({ phase: m[1], ms: +m[2] }); return null; }
    const done = state.reload; state.reload = null;
    done.phases = done.phases.sort((a, b) => b.ms - a.ms).slice(0, 4);
  }
  if ((m = line.match(/^(?:\[Worker(\d+)\]\s*)?Start importing (.+?) using Guid\(\w+\)(?: \((\w+)\))?/))) { (state.importing ||= {})[m[1] || 'main'] = { asset: m[2], importer: m[3] || null }; return null; }
  if ((m = line.match(/^(?:\[Worker(\d+)\]\s*)?-> \(artifact id: '\w+'\) in ([\d.]+) seconds/))) {
    const ms = Math.round(num(m[2]) * 1000), current = (state.importing || {})[m[1] || 'main'];
    count(app, t, 'imports'); count(app, t, 'importMs', ms);
    return ms >= 500 && current ? push({ t, app, kind: 'import', asset: current.asset, importer: current.importer, worker: m[1] ? +m[1] : null, ms }) : null;
  }
  if ((m = line.match(/^Domain Reload Profiling: (\d+)ms/))) return (state.reload = push({ t, app, kind: 'domain-reload', ms: +m[1], phases: [] }));
  if ((m = line.match(/^Reloading assemblies (for play mode|after forced synchronous recompile)/))) return push({ t, app, kind: m[1] === 'for play mode' ? 'play-mode' : 'script-reload' });
  if ((m = line.match(/^\*\*\* Tundra build (success|failed) \(([\d.]+) seconds\), (\d+) items updated/))) {
    return push({ t, app, kind: 'script-build', failed: m[1] === 'failed', ms: Math.round(num(m[2]) * 1000), items: +m[3] });
  }
  if ((m = line.match(/^\[ScriptCompilation\] Requested script compilation because: (.+)/))) return push({ t, app, kind: 'script-compile-request', reason: m[1].slice(0, 120) });
  if ((m = line.match(/^Asset Pipeline Refresh \(id=\w+\): Total: ([\d.]+) seconds - Initiated by (\w+)/))) {
    const ms = Math.round(num(m[1]) * 1000); return ms >= 100 ? push({ t, app, kind: 'refresh', ms, by: m[2] }) : null;
  }
  if ((m = line.match(/^Compiling shader "(.+?)"/))) return count(app, t, 'shaders', 1, m[1]);
  if ((m = line.match(/^Opening scene '(.+?)'/))) return push({ t, app, kind: 'scene-open', scene: m[1] });
  if ((m = line.match(/^Unloading (\d+) unused Assets \/ \(([\d.]+ \w+)\)/))) return push({ t, app, kind: 'unload-assets', assets: +m[1], size: m[2] });
  if ((m = line.match(/error (CS\d{4}): (.{0,120})/))) return push({ t, app, kind: 'compile-error', code: m[1], text: m[2] });
  if (/^No valid Unity Editor license found/.test(line)) return push({ t, app, kind: 'license-error' }); // batch runs exit with code 198
  return null;
}

async function readLog(file, w) {
  let stat;
  try { stat = await fs.promises.stat(file); } catch { return; }
  // Both engines start a new log per session: a just-created log is this session (read it all), an older one starts at the end.
  // Date.now() is whole ms but birthtimeMs is sub-ms, so a log statted in the ms it was created has a negative age: clamp it.
  if (w.offset === null) w.offset = Math.max(0, Date.now() - stat.birthtimeMs) < fresh.ms ? 0 : stat.size;
  else if (stat.size < w.offset) { w.offset = 0; w.rest = ''; }
  if (stat.size === w.offset) return;
  const length = Math.min(stat.size - w.offset, READ_MAX), buffer = Buffer.alloc(length);
  const handle = await fs.promises.open(file, 'r');
  try { await handle.read(buffer, 0, length, w.offset); } finally { await handle.close(); }
  w.offset += length;
  const parts = (w.rest + buffer.toString('utf8')).split(/\r?\n/);
  w.rest = parts.pop();
  for (const line of parts) if (line) parseLine(w.app, line, w.state);
}

/** Called on every sample; one read per log at a time. */
async function poll() {
  if (polling || !watchers.size) return;
  polling = true;
  try { for (const [file, w] of watchers) await readLog(file, w).catch(() => {}); } finally { polling = false; }
}

// ---- window summary -------------------------------------------------------------------------------------------------

async function listRecent(dir, exts, since, depth = 1) {
  const out = [];
  let entries = [];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...await listRecent(full, exts, since, depth - 1));
    else if (exts.some((x) => e.name.toLowerCase().endsWith(x))) {
      const st = await fs.promises.stat(full).catch(() => null);
      if (st && st.mtimeMs >= since) out.push({ file: full, mb: Math.round(st.size / 104857.6) / 10, modified: new Date(st.mtimeMs).toISOString() });
    }
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 5);
}

/** The engine's own profiling output from this window, so the agent can drill in with the right tool. */
async function artifacts(app, list, since) {
  if (app === 'unreal') {
    const store = path.join(process.env.LOCALAPPDATA || '', 'UnrealEngine', 'Common', 'UnrealTrace', 'Store');
    const projects = [...new Set(list.map((e) => e.project).filter(Boolean))];
    const insights = list.map((e) => e.exe && path.join(path.dirname(e.exe), 'UnrealInsights.exe')).find((f) => f && fs.existsSync(f)) || null;
    const traces = [...await listRecent(store, ['.utrace'], since, 2)];
    const csv = [];
    for (const p of projects) {
      traces.push(...await listRecent(path.join(path.dirname(p), 'Saved', 'Profiling'), ['.utrace'], since, 1));
      csv.push(...await listRecent(path.join(path.dirname(p), 'Saved', 'Profiling', 'CSV'), ['.csv', '.csv.bin'], since, 0));
    }
    return { insightsTraces: traces.slice(0, 5), insightsExe: insights, csvProfiles: csv.slice(0, 5),
      use: 'CSV: ue_profile_summary. Traces: open in Unreal Insights. Live traces start from the editor (Trace > Start) or with -trace=default.' };
  }
  const snaps = [];
  for (const p of new Set(list.map((e) => e.project).filter(Boolean))) snaps.push(...await listRecent(path.join(p, 'MemoryCaptures'), ['.snap'], since, 0));
  return { memorySnapshots: snaps.slice(0, 5),
    use: 'Domain reload phases come from Unity\'s own profiling above. Live Profiler counters: the Unity MCP manage_profiler tool.' };
}

function devFindings(app, samples, rolePids, list) {
  const out = [];
  const shaderPids = rolePids.get('shader-compile') || new Set();
  let run = null;
  const flushRun = () => { if (run && (run.to - run.from) >= 10000) out.push(run); run = null; };
  for (const s of samples) {
    const rows = (s.procs || []).filter((p) => shaderPids.has(analysis.processKey(p)) || shaderPids.has(p.p)), cpu = rows.reduce((a, p) => a + p.c, 0);
    if (rows.length >= 2 && cpu >= 50) {
      if (!run) run = { kind: 'shader_compile_load', app, from: s.t, to: s.t, workersPeak: 0, cpuPeak: 0 };
      run.to = s.t; run.workersPeak = Math.max(run.workersPeak, rows.length); run.cpuPeak = Math.max(run.cpuPeak, Math.round(cpu));
    } else flushRun();
  }
  flushRun();
  for (const f of out) f.note = 'Shader compile workers used at least half of all CPU; the editor stays sluggish until the queue drains.';
  for (const e of list) {
    if (e.kind === 'domain-reload' && e.ms >= 5000) out.push({ kind: 'slow_domain_reload', app, at: e.t, ms: e.ms, phases: e.phases, note: 'Every script change and play-mode entry pays this; the largest phases show where.' });
    if (e.kind === 'import' && e.ms >= 2000) out.push({ kind: 'slow_import', app, at: e.t, asset: e.asset, importer: e.importer, ms: e.ms });
    if ((e.kind === 'script-build' || e.kind === 'live-coding') && e.failed) out.push({ kind: 'build_failed', app, at: e.t, source: e.kind, stage: e.stage || null });
    if (e.kind === 'license-error') out.push({ kind: 'license_missing', app, at: e.t, note: 'No active Unity license: sign in to Unity Hub; batch builds exit with code 198 until then.' });
  }
  const pso = list.filter((e) => e.kind === 'pso-hitches');
  if (pso.length >= 2 && pso[pso.length - 1].total > pso[0].total) {
    const last = pso[pso.length - 1];
    out.push({ kind: 'pso_hitches', app, newHitches: last.total - pso[0].total, precached: last.precached, total: last.total, note: 'PSO creation stalls during play; PSO precaching or a bundled PSO cache removes them.' });
  }
  return out;
}

/** Per-app view of a sample window: roles with their hardware use, editor events, findings and engine artifacts. */
async function summarize(samples, { since, until, parents } = {}) {
  const byApp = new Map();
  const latestKeys = new Map();
  for (const sample of samples) for (const proc of sample.procs || []) latestKeys.set(proc.p, analysis.processKey(proc));
  for (const s of samples) for (const p of s.procs || []) {
    const key = analysis.processKey(p);
    const r = roleOf(p, parents, key !== latestKeys.get(p.p));
    if (!r) continue;
    const app = byApp.get(r.app) || byApp.set(r.app, new Map()).get(r.app);
    (app.get(r.role) || app.set(r.role, new Set()).get(r.role)).add(key);
  }
  for (const e of editors.values()) if (!byApp.has(e.app)) byApp.set(e.app, new Map());
  const result = [];
  for (const [app, rolePids] of byApp) {
    const list = events.filter((e) => e.app === app && e.t >= since && e.t <= until);
    const counters = [...minutes.values()].filter((c) => c.app === app && c.t + MINUTE >= since && c.t <= until)
      .reduce((a, c) => ({ imports: a.imports + c.imports, importSeconds: a.importSeconds + c.importMs / 1000, shadersCompiled: a.shadersCompiled + c.shaders,
        shadermapMisses: a.shadermapMisses + c.shadermapMisses, examples: [...a.examples, ...c.names].slice(0, 5) }), { imports: 0, importSeconds: 0, shadersCompiled: 0, shadermapMisses: 0, examples: [] });
    const peakCount = (pids) => Math.max(0, ...samples.map((s) => (s.procs || []).filter((p) => pids.has(analysis.processKey(p))).length));
    const roles = [...rolePids].map(([role, pids]) => ({ role, processesPeak: peakCount(pids), ...analysis.usage(samples, pids) }))
      .sort((a, b) => b.cpuPercent.avg - a.cpuPercent.avg);
    const appEditors = [...editors.values()].filter((e) => e.app === app);
    result.push({ app, editors: appEditors.map(({ pid, role, worker, project }) => ({ pid, role, worker, project })),
      roles, counters: { ...counters, importSeconds: Math.round(counters.importSeconds * 10) / 10 },
      events: list.slice(-20), findings: devFindings(app, samples, rolePids, list), artifacts: await artifacts(app, appEditors, since) });
  }
  return result;
}

/** Open a .utrace in the Unreal Insights that ships with the editor's own engine (dashboard button). */
function openInsights(file) {
  const target = path.resolve(String(file || ''));
  if (!/\.utrace$/i.test(target) || !fs.existsSync(target)) throw new Error('not an existing .utrace file');
  const exe = lastUnrealExe && path.join(path.dirname(lastUnrealExe), 'UnrealInsights.exe');
  if (!exe || !fs.existsSync(exe)) throw new Error('Unreal Insights not found; start the editor once so the Hub knows its engine');
  require('child_process').spawn(exe, [target], { detached: true, stdio: 'ignore' }).unref();
  return { opened: target };
}

/** Instant/complete events for the Perfetto export (one track per app). */
function traceEvents(since, until) {
  const PIDS = { unreal: 0x7ffffff1, unity: 0x7ffffff2 }, out = [];
  for (const [app, pid] of Object.entries(PIDS)) out.push({ ph: 'M', name: 'process_name', pid, args: { name: app === 'unreal' ? 'Unreal Editor events' : 'Unity Editor events' } });
  for (const e of events) {
    if (e.t < since || e.t > until) continue;
    const { t, app, kind, ms, ...args } = e;
    out.push(ms ? { ph: 'X', name: kind, pid: PIDS[app], tid: 1, ts: (t - ms) * 1000, dur: ms * 1000, args }
      : { ph: 'i', s: 'p', name: kind, pid: PIDS[app], tid: 1, ts: t * 1000, args });
  }
  return out;
}

module.exports = { updateEditors, poll, summarize, traceEvents, openInsights, roleOf, describeEditor, parseLine,
  _test: { editors, watchers, events, minutes, fresh, reset:() => { editors.clear(); watchers.clear(); events.length = 0; minutes.clear(); } } };

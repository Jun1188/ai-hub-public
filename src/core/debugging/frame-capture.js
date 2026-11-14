// Debugging stage 4: what one captured frame spends its GPU time on. Reads a RenderDoc capture (.rdc) the user made
// (the Unreal/Unity RenderDoc buttons, or RenderDoc itself) through rdc-cli (MIT; `uv tool install rdc-cli` then
// `rdc setup-renderdoc`). Analysis only: nothing here launches or injects into a program (the MCP boundary). The replay
// runs in rdc's daemon on the GPU, so it waits for the Hub's GPU slot like local models do.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../analysis-process');
const { findOnPath } = require('../clitools');
const { maskPath } = require('./process-inspect');

const SESSION = 'aihub'; // our own rdc session, so a capture the user has open in the default one is left alone
const OPEN_MS = 150000, QUERY_MS = 180000; // counters replay every event of the frame; a heavy Unreal frame takes minutes
const round = (v, d = 1000) => Math.round(v * d) / d;
let active = false;

/** rdc on this PC: RDC_BIN, the uv tool folder, then PATH. */
function detect() {
  const env = process.env.RDC_BIN;
  if (env && fs.existsSync(env)) return env;
  const uv = path.join(os.homedir(), '.local', 'bin', 'rdc.exe');
  return fs.existsSync(uv) ? uv : findOnPath(['rdc.exe']);
}

/** Trust boundary (MCP input): an existing .rdc file that cannot be read as an option. Async: captures may sit under a synced folder (rule 1). */
async function capturePath(p) {
  const s = String(p || '').trim();
  if (!/\.rdc$/i.test(s) || s.startsWith('-')) throw new Error('not_rdc');
  const abs = path.resolve(s);
  const st = await fs.promises.stat(abs).catch(() => null);
  if (!st?.isFile()) throw new Error('capture_not_found');
  return abs;
}

// Run inside rdc's daemon (`rdc script`): the marker path of every draw and dispatch. Unreal's RDG passes are marker
// regions, while rdc's own pass list follows API passes (on D3D12, command lists) and its draw `marker` is only the nearest.
const MARKER_SCRIPT = `sf = state.structured_file
F = rd.ActionFlags
DRAW, DISPATCH, PASS = int(F.Drawcall) | int(F.MeshDispatch), int(F.Dispatch), int(F.BeginPass) | int(F.EndPass)
rows = []
def walk(actions, path):
    for a in actions:
        f = int(a.flags)
        if f & (DRAW | DISPATCH):
            rows.append([a.eventId, (a.numIndices // 3) * max(a.numInstances, 1) if f & DRAW else 0, 1 if f & DISPATCH else 0, path])
        if a.children:
            walk(a.children, path if f & PASS else path + [a.GetName(sf)])
walk(adapter.get_root_actions(), [])
result = rows
`;

/** Pure: render map → (marker name → source spots or null). Compares stems: "TSR 1920x1080" ↔ RDG_EVENT_NAME("TSR %dx%d"). */
function matcher(doc) {
  const base = (s) => String(s).split(/[%(]/)[0].trim().toLowerCase();
  const stems = new Map();
  for (const kind of ['rdgPasses', 'gpuStats', 'drawEvents']) for (const x of doc?.[kind] || []) {
    const m = base(x.name);
    if (m.length >= 3) (stems.get(m) || stems.set(m, []).get(m)).push({ kind, file: x.file, line: x.line }); // two letters match unrelated markers; "TSR" is the shortest real one
  }
  return (name) => {
    const words = base(name).split(' ');
    for (let i = words.length; i > 0; i--) { const hit = stems.get(words.slice(0, i).join(' ')); if (hit) return hit.slice(0, 3); }
    return null;
  };
}

/** Pure: rdc JSON, marker rows (MARKER_SCRIPT) and the newest render map → passes and draws ranked by replay GPU time, else triangles. */
function summarize({ info = {}, stats = {}, draws = [], counters = null, markers = [], doc = null, top = 10 }) {
  const gpu = new Map(); // eid → ms; GPU Duration is in seconds
  for (const r of counters?.rows || []) if (r.counter === 'GPU Duration' && r.unit === 'Seconds' && Number.isFinite(r.value) && r.value >= 0) gpu.set(r.eid, r.value * 1000);
  const timed = gpu.size > 0;
  const totalMs = [...gpu.values()].reduce((a, b) => a + b, 0);
  const known = matcher(doc), share = (ms) => (Number.isFinite(ms) && totalMs ? round(ms / totalMs) : null);
  const byMarkers = markers.some((r) => r[3].length);
  let root = 0; // markers every draw sits under ("Frame 599 > SceneRender…") say nothing per pass
  while (byMarkers && markers.every((r) => r[3].length > root + 1 && r[3][root] === markers[0][3][root])) root++;
  const groups = new Map(), passOf = new Map();
  for (const [eid, tris, dispatch, path] of byMarkers ? markers : []) {
    // The deepest marker the render map knows (RDG pass, GPU stat, draw event), else the nearest one. The path is context
    // only: D3D12 parallel command lists nest markers deeper than Unreal's pass tree (measured: ShadowDepths under NaniteBasePass).
    let i = path.length - 1;
    while (i >= 0 && !known(path[i])) i--;
    if (i < 0) i = path.length - 1;
    const name = path[i] ?? '(no marker)';
    passOf.set(eid, name);
    let g = groups.get(name);
    if (!g) groups.set(name, g = { name, path: path.slice(root, Math.max(root, i)).join(' > ') || null, draws: 0, dispatches: 0, triangles: 0, ms: null, source: known(name) });
    g.draws += dispatch ? 0 : 1; g.dispatches += dispatch; g.triangles += tris;
    if (gpu.has(eid)) g.ms = (g.ms ?? 0) + gpu.get(eid);
  }
  const apiMs = new Map();
  for (const d of draws) if (gpu.has(d.eid)) apiMs.set(d.pass, (apiMs.get(d.pass) || 0) + gpu.get(d.eid));
  const passes = (byMarkers
    ? [...groups.values()].map((g) => ({ name: g.name, path: g.path, draws: g.draws, dispatches: g.dispatches, triangles: g.triangles, target: null,
      gpuMs: g.ms === null ? null : round(g.ms), gpuShare: share(g.ms), ...(g.source ? { source: g.source } : {}) }))
    : (stats.per_pass || []).map((p) => ({ name: p.name, path: null, draws: p.draws, dispatches: p.dispatches, triangles: p.triangles,
      target: p.rt_w && p.rt_w !== '-' ? `${p.rt_w}x${p.rt_h}` : null, gpuMs: apiMs.has(p.name) ? round(apiMs.get(p.name)) : null,
      gpuShare: share(apiMs.get(p.name)), ...(known(p.name) ? { source: known(p.name) } : {}) })))
    .sort((a, b) => (timed ? (b.gpuMs ?? -1) - (a.gpuMs ?? -1) : b.triangles - a.triangles || b.dispatches - a.dispatches));
  const topDraws = draws.map((d) => ({ eid: d.eid, type: d.type, pass: passOf.get(d.eid) || d.pass, marker: d.marker, triangles: d.triangles,
    instances: d.instances, gpuMs: gpu.has(d.eid) ? round(gpu.get(d.eid)) : null }))
    .sort((a, b) => (timed ? (b.gpuMs ?? -1) - (a.gpuMs ?? -1) : b.triangles - a.triangles)).slice(0, top);
  return { capture: info.Capture ? maskPath(info.Capture) : null, api: info.API || null, events: info.Events ?? null, drawCalls: info['Draw Calls'] ?? null,
    gpu: timed ? { totalMs: round(totalMs), timedEvents: gpu.size, basis: 'replay' } : null,
    passBasis: byMarkers ? 'markers' : 'api', markerRoot: root ? markers[0][3].slice(0, root).join(' > ') : null,
    passes: passes.slice(0, 20), passCount: passes.length, topDraws,
    largestResources: (stats.largest_resources || []).slice(0, 5).map((r) => ({ name: r.name, type: r.type, bytes: r.size, format: r.format })),
    note: timed ? 'GPU times are sums of available replay counters. Missing events contribute no timing evidence. Live frame time was not measured.'
      : 'No GPU Duration values for this capture, so passes and draws are ranked by triangles (then dispatches).' };
}

/** Open one capture in rdc's daemon, read it, close it. Rejects with rdc_not_found / not_rdc / capture_not_found / frame_capture_busy / renderdoc_unavailable. */
async function analyze({ path: p, top = 10 } = {}) {
  if (typeof p === 'string' && /\.xml$/i.test(p.trim())) {
    if (process.platform !== 'win32') throw new Error('renderdoc_xml_windows_only');
    const file = path.resolve(p.trim());
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('renderdoc_xml_limit');
    const script = path.join(require('../paths').appRoot(), 'scripts', 'renderdoc-export.ps1');
    const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let result;
    try {
      result = await proc.run('renderdoc-xml-' + require('crypto').randomUUID(), shell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Capture', file],
        { timeoutMs: 15000, maxBytes: 65536 });
    } catch { throw new Error('renderdoc_xml_unreadable'); }
    return { basis: 'structured-export', ...JSON.parse(result.stdout) };
  }
  const exe = detect();
  if (!exe) throw new Error('rdc_not_found');
  const file = await capturePath(p);
  if (active) throw new Error('frame_capture_busy');
  active = true;
  const rdc = (args, timeoutMs = QUERY_MS) => proc.run('rdc', exe, ['--session', SESSION, ...args], { timeoutMs, maxBytes: 64 * 1024 ** 2 }).then((r) => r.stdout);
  const json = async (args) => JSON.parse(await rdc([...args, '--json']));
  try {
    return await require('../hardware-optimizer').withLocalSlot(async () => { // lazy: tests use summarize() alone
      try { // close runs even when open fails half-way, so no daemon is left holding the GPU
        // rdc probes the renderdoc module in a 5 s subprocess and, when that is slow, still exits 0 with a replay-less
        // daemon ("no-replay mode"); measured right after a Hub restart. Close and retry once with the DLLs now cached.
        const noReplay = async () => /no-replay mode/.test(await rdc(['open', file, '--timeout', '120'], OPEN_MS));
        if (await noReplay()) {
          await rdc(['close'], 30000).catch(() => {});
          if (await noReplay()) throw new Error('renderdoc_unavailable');
        }
        const [info, stats, draws] = [await json(['info']), await json(['stats']), await json(['draws'])];
        // Each extra query may fail alone; the rest of the analysis is kept (rule 9).
        let counters = null, countersError, markers = [], markersError;
        try { counters = await json(['counters', '--name', 'GPU Duration']); } catch (e) { countersError = e.message.slice(0, 300); }
        // Measured: RenderDoc 1.41 lists GPU Duration for a UE 5.8 D3D12 capture but FetchCounters returns nothing.
        if (counters && !counters.rows?.length) countersError = 'GPU Duration returned no values for this capture (RenderDoc replay gave no counter results)';
        const script = path.join(os.tmpdir(), 'aihub-rdc-markers.py'); // written per run, not run from the synced app folder (rule 5)
        try { await fs.promises.writeFile(script, MARKER_SCRIPT, 'utf8'); markers = (await json(['script', script])).return_value || []; }
        catch (e) { markersError = e.message.slice(0, 300); }
        const renderpipe = require('../renderpipe'), map = renderpipe.list()[0];
        const out = summarize({ info, stats, draws, counters, markers, doc: map ? renderpipe.load(map.name) : null, top });
        if (map) out.sourceMap = map.name;
        if (countersError) out.countersError = countersError;
        if (markersError) out.markersError = markersError;
        return out;
      } finally {
        await rdc(['close'], 30000).catch(() => {});
      }
    });
  } finally { active = false; }
}

module.exports = { analyze, detect, capturePath, summarize, matcher };

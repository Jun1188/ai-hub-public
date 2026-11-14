// Per-thread CPU over a probe capture, labelled with engine thread roles. Pure; shared by the render monitor and inspection.
'use strict';

// Unreal and Unity name their threads (SetThreadDescription); an unnamed main thread is the game/main thread.
const ROLES = [
  [/^GameThread/i, 'game'], [/^RenderThread/i, 'render'], [/^RHI(Submission|Interrupt)?Thread/i, 'rhi'],
  [/^UnityGfxDeviceWorker/i, 'render'], [/^(UnityMain|Main Thread)$/i, 'game'],
  [/^(TaskGraphThread|Foreground Worker|Background Worker|Job\.Worker|Background Job\.Worker)/i, 'workers'],
  [/ShaderCompil/i, 'shader-compile'], [/^(AsyncLoadingThread|Loading\.|IoDispatcher)/i, 'loading'], [/^Audio/i, 'audio'],
];
const round = (v) => Math.round(v * 10) / 10;

function role(name, main, engine) {
  for (const [re, r] of ROLES) if (re.test(name || '')) return r;
  return main ? (engine ? 'game' : 'main') : null;
}

/** @returns {{id, name, role, main, avg, peak}[]} busiest first; avg/peak are % of one core (100 = one core pegged) */
function aggregate(samples, engine = false) {
  const primed = samples.filter((s) => s.primed !== false && Array.isArray(s.threads));
  const by = new Map();
  for (const s of primed) for (const t of s.threads) {
    let a = by.get(t.id);
    if (!a) by.set(t.id, a = { id: t.id, name: '', main: false, sum: 0, peak: 0 });
    if (t.n) a.name = t.n;
    a.main ||= Boolean(t.main); a.sum += t.c; a.peak = Math.max(a.peak, t.c);
  }
  const n = primed.length || 1; // a thread missing from a sample was idle then, so it counts as 0
  return [...by.values()].map((a) => ({ id: a.id, name: a.name, role: role(a.name, a.main, engine), main: a.main, avg: round(a.sum / n), peak: round(a.peak) }))
    .sort((a, b) => b.avg - a.avg);
}

/** Per role: the busiest single thread (a pipeline stage is bound when one thread is pegged) and the total load. */
function byRole(list) {
  const out = {};
  for (const t of list) {
    if (!t.role) continue;
    const r = out[t.role] || (out[t.role] = { threads: 0, busiest: 0, total: 0 });
    r.threads++; r.busiest = Math.max(r.busiest, t.avg); r.total = round(r.total + t.avg);
  }
  return out;
}

module.exports = { aggregate, byRole, role };

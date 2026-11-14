// Which processes caused a machine-wide symptom: integrates one per-process rate over a span and ranks by share.
// Kept free of requires so telemetry-analysis (which feeds it owner/role lookups) can use it without a cycle.
'use strict';

const GAP_CAP_MS = 10000; // spans bridge misses up to 10 s; a longer gap must not inflate one sample's weight

/**
 * @param {object[]} hits samples inside the span (each with `t` and `procs`)
 * @param {(p:object)=>number} valueOf per-second rate of one process row
 * @param {(p:object)=>({app:string, role?:string, job?:string}|null)} describe
 * @returns {{name, pids:number[], app, role, job, share:number, amount:number, label:string}[]} processes with the same
 *   name are one entry (Chrome's renderers are one culprit, not twenty small ones)
 */
function rank(hits, valueOf, describe, { top = 3 } = {}) {
  const groups = new Map(); let total = 0;
  hits.forEach((s, i) => {
    const next = hits[i + 1], prev = hits[i - 1];
    const dt = Math.min(GAP_CAP_MS, prev ? s.t - prev.t : next ? next.t - s.t : 2000) / 1000;
    for (const p of s.procs || []) {
      const v = Number(valueOf(p)) * dt;
      if (!(v > 0)) continue;
      total += v;
      let g = groups.get(p.n);
      if (!g) groups.set(p.n, g = { name: p.n, pids: new Map(), amount: 0, ...(describe(p) || {}) });
      const started = typeof p.started === 'string' && /^\d{1,20}$/.test(p.started) ? p.started : null;
      g.pids.set(p.p, !g.pids.has(p.p) || g.pids.get(p.p) === started ? started : null);
      g.amount += v;
    }
  });
  if (!total) return [];
  // Entries that round to 0% are noise next to the real culprit (measured: Memory Compression 0% under a 100% mmap reader).
  return [...groups.values()].sort((a, b) => b.amount - a.amount).filter((g) => g.amount / total >= 0.005).slice(0, top).map((g) => {
    const pids = [...g.pids.keys()], share = Math.round((g.amount / total) * 100) / 100;
    const who = pids.length === 1 ? `${g.name}(${pids[0]})` : `${g.name}×${pids.length}`;
    const inspect = pids.length === 1 && g.pids.get(pids[0]) ? {pid:pids[0],started:g.pids.get(pids[0])} : null;
    return { name: g.name, pids, inspect, app: g.app || 'other', role: g.role || null, job: g.job || null, share, amount: Math.round(g.amount),
      label: `${who}${g.role ? ` [${g.role}]` : ''} ${Math.round(share * 100)}%` };
  });
}

module.exports = { rank };

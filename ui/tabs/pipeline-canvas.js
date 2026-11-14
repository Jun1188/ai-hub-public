// State-graph view in the style of LangGraph Studio: layered layout, typed edges, drag to arrange (saved as node.ui),
// click to select for the inspector, and live marks from pipeline:status events. Editing stays in the inspector.
'use strict';
window.pipelineCanvas = (() => {
  const W = 156, H = 46, GX = 56, GY = 64;
  const live = { runId: null, nodeId: null, visits: {}, final: null };
  let redraw = () => {};
  const edgesOf = n => n.kind === 'condition' ? [['true', n.onTrue], ['false', n.onFalse]] : n.kind === 'end' ? [] : [['next', n.next], ...(n.onError ? [['error', n.onError]] : [])];
  function layout(g) {
    const depth = {}, queue = [[g.entry, 0]];
    while (queue.length) {
      const [id, d] = queue.shift();
      if (id in depth) continue;
      depth[id] = d;
      const n = g.nodes.find(x => x.id === id);
      if (n) for (const [, to] of edgesOf(n)) if (to && !(to in depth)) queue.push([to, d + 1]);
    }
    const rows = {};
    for (const n of g.nodes) (rows[depth[n.id] ?? 0] ||= []).push(n);
    for (const [d, list] of Object.entries(rows)) list.forEach((n, i) => { if (!n.ui) n.ui = { x: 16 + i * (W + GX), y: 16 + Number(d) * (H + GY) }; });
  }
  function edgePath(a, b) {
    const x1 = a.ui.x + W / 2, y1 = a.ui.y + H, x2 = b.ui.x + W / 2, y2 = b.ui.y;
    if (y2 > y1) return `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`;
    const side = Math.max(a.ui.x, b.ui.x) + W + 28; // back edge (loop): route around the right side
    return `M${a.ui.x + W},${a.ui.y + H / 2} C${side},${a.ui.y + H / 2} ${side},${b.ui.y + H / 2} ${b.ui.x + W},${b.ui.y + H / 2}`;
  }
  const subtitle = n => n.kind === 'step' ? n.step?.type + (n.step?.type === 'offload' ? ' · ' + (n.step.worker || 'local') : '')
    : n.kind === 'condition' ? `${n.path} ${n.operator} ${JSON.stringify(n.value ?? '')}`.slice(0, 26) : n.kind;
  function render(host, g, selected, onSelect, onMove) {
    layout(g);
    const byId = new Map(g.nodes.map(n => [n.id, n]));
    const width = Math.max(...g.nodes.map(n => n.ui.x)) + W + 60, height = Math.max(...g.nodes.map(n => n.ui.y)) + H + 20;
    let svg = `<svg class="pg-canvas" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="상태 그래프">`
      + '<defs><marker id="pg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" class="pg-arrowhead"/></marker></defs>';
    for (const n of g.nodes) for (const [type, to] of edgesOf(n)) {
      const t = byId.get(to);
      if (t) svg += `<path class="pg-edge pg-edge-${type}" d="${edgePath(n, t)}" marker-end="url(#pg-arrow)"><title>${esc(n.id)} → ${esc(to)} (${type})</title></path>`;
    }
    for (const n of g.nodes) {
      const v = live.visits[n.id], cls = ['pg-n', 'pg-n-' + n.kind, n.id === selected ? 'pg-selected' : '', n.id === live.nodeId ? 'pg-live' : '', v ? 'pg-visited' : ''].join(' ');
      svg += `<g class="${cls}" data-pg-node="${esc(n.id)}" transform="translate(${n.ui.x},${n.ui.y})" tabindex="0">`
        + `<rect width="${W}" height="${H}" rx="8"/><text x="10" y="18">${esc(n.id)}${n.id === g.entry ? ' ▶' : ''}</text>`
        + `<text x="10" y="35" class="pg-sub">${esc(subtitle(n))}${v ? ' · ×' + v : ''}</text></g>`;
    }
    host.innerHTML = svg + '</svg>' + (live.runId ? `<p class="hint">실행 ${esc(live.runId.slice(0, 8))}: ${live.nodeId ? '현재 ' + esc(live.nodeId) : esc(live.final || '')}</p>` : '');
    const svgEl = host.querySelector('svg');
    host.querySelectorAll('[data-pg-node]').forEach(el => {
      const n = byId.get(el.dataset.pgNode);
      el.addEventListener('keydown', e => { if (e.key === 'Enter') onSelect(n.id); });
      el.addEventListener('pointerdown', e => {
        const scale = svgEl.viewBox.baseVal.width / svgEl.getBoundingClientRect().width, start = { x: e.clientX, y: e.clientY, ux: n.ui.x, uy: n.ui.y };
        let moved = false;
        const move = ev => {
          const dx = (ev.clientX - start.x) * scale, dy = (ev.clientY - start.y) * scale;
          if (!moved && Math.abs(dx) + Math.abs(dy) <= 4) return;
          if (!moved) onMove?.();
          moved = true;
          n.ui = { ...n.ui, x: Math.max(0, Math.round(start.ux + dx)), y: Math.max(0, Math.round(start.uy + dy)) };
          el.setAttribute('transform', `translate(${n.ui.x},${n.ui.y})`);
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (moved) render(host, g, selected, onSelect, onMove); else onSelect(n.id); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      });
    });
    redraw = () => render(host, g, selected, onSelect, onMove);
  }
  /** pipeline:status → live marks (current node, visit counts, final status). */
  function mark(e) {
    if (!e || !e.runId) return;
    if (e.runId !== live.runId) Object.assign(live, { runId: e.runId, nodeId: null, visits: {}, final: null });
    if (e.nodeId && e.transition) live.visits[e.nodeId] = (live.visits[e.nodeId] || 0) + 1;
    if (e.nodeId) live.nodeId = e.nodeId;
    if (e.status && e.status !== 'running') Object.assign(live, { nodeId: null, final: e.status });
    redraw();
  }
  return { render, mark, layout };
})();

'use strict';
const { pathToFileURL } = require('url');
const os = require('os');

const label = value => String(value || '').replace(/[\[\]|\r\n]/g, ' ').trim();
const filename = n => `${label(n.label || n.id).replace(/[<>:"/\\|?*#^%\x00-\x1f]/g, '-').slice(0, 64).replace(/[. ]+$/, '') || '노트'}--${String(n.id).replace(/[^a-z0-9_-]/gi, '')}.md`;

// Both the managed vault and one-time exports must use the same identity and link map.
function render(graph) {
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const paths = new Map([...nodes.values()].map(n => [n.id, 'Nodes/' + filename(n)]));
  const outgoing = new Map(), files = {};
  for (const e of graph.edges) {
    if (!nodes.has(e.source) || !nodes.has(e.target)) continue;
    if (!outgoing.has(e.source)) outgoing.set(e.source, []);
    outgoing.get(e.source).push(e);
  }
  for (const n of nodes.values()) {
    const title = label(n.label || n.id);
    const properties = { hub_id: n.id, title, aliases: [title], kind: n.kind, role: n.role || n.kind,
      source_path: n.sourceLocation || n.file || n.path, computer_id: n.computerId || 'unknown',
      source_scope: n.scope || graph.key, source_keys: n.sourceKeys || [n.scope || graph.key],
      location_status: n.status || 'unknown', observed_at: n.observedAt || null, evidence: n.evidence || 'EXTRACTED',
      purpose: n.purpose || '', source_line: n.line || null, bytes: n.bytes ?? null,
      cache_stats: n.cacheStats || null, freshness: n.freshness || null, hub_edges: outgoing.get(n.id) || [] };
    const head = Object.entries(properties).map(([k, v]) => `${k}: ${JSON.stringify(v ?? null)}`).join('\n');
    const source = n.file && n.computerId === os.hostname() ? `[원본 열기](${pathToFileURL(n.file).href})${n.line ? ' · 행 ' + n.line : ''}\n\n` : '';
    const excerpt = String(n.description || n.body || '');
    const fence = '`'.repeat(Math.max(3, ...[...excerpt.matchAll(/`+/g)].map(m => m[0].length + 1)));
    const links = (outgoing.get(n.id) || []).map(e =>
      `- ${label(e.relation)} (${label(e.evidence || 'EXTRACTED')}; ${label(e.scope || n.scope || graph.key)}): [[${paths.get(e.target)}|${label(nodes.get(e.target).label || e.target)}]]`);
    files[paths.get(n.id)] = '\uFEFF' + `---\n${head}\n---\n\n# ${title}\n\n${source}${fence}text\n${excerpt}\n${fence}\n\n## 연결\n\n${links.join('\n') || '- 없음'}\n`;
  }
  const roots = [...nodes.values()].filter(n => n.kind === 'directory' && n.path === '.' || /^(?:skills\/)?CATALOG\.md$/.test(n.path));
  files['Hub Index.md'] = '\uFEFF# ' + label(graph.label || 'Hub 지식 볼트') + '\n\n' +
    `갱신: ${graph.updatedAt || new Date().toISOString()}\n\n노드: ${nodes.size} · 관계: ${graph.edges.length}\n\n## 원본\n\n` +
    (roots.length ? roots : [...nodes.values()].slice(0, 30)).map(n => `- [[${paths.get(n.id)}|${label(n.label || n.id)}]]`).join('\n') +
    '\n\n## 수집 범위와 한계\n\n' + (graph.warnings || []).map(w => '- ' + label(w)).join('\n') + '\n';
  return files;
}

// Generated JSON-valued properties and ordinary YAML aliases are both accepted.
function metadata(text) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  let key;
  for (const line of (match?.[1] || '').split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      try { out[key] = JSON.parse(kv[2]); }
      catch { out[key] = kv[2].replace(/^['"]|['"]$/g, ''); }
    } else if (key === 'aliases' && /^\s+-\s+/.test(line)) {
      if (!Array.isArray(out.aliases)) out.aliases = [];
      out.aliases.push(line.replace(/^\s+-\s+/, '').replace(/^['"]|['"]$/g, ''));
    }
  }
  if (typeof out.aliases === 'string') out.aliases = out.aliases.replace(/^\[|\]$/g, '').split(',').map(v => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  return out;
}

module.exports = { render, metadata };

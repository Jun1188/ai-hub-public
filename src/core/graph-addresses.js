'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isSensitivePath, readCheckedFile } = require('./harness-bridge/virtual-workspace');
const io = fs.promises;
const MARKER = '[Hub graph addresses v1]';
const relationTypes = new Set(['contains', 'references', 'dependsOn', 'generates']);
const idPattern = /^[0-9a-f]{32}$/;
const maxBytes = 1024 * 1024;
const fail = reason => { throw new Error('Graph attachment: ' + reason); };
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

async function directoryHash(real) {
  const before = await io.stat(real, { bigint: true });
  const children = [];
  let visited = 0;
  for await (const entry of await io.opendir(real)) {
    if (++visited > 4096) fail('directory entry limit');
    if (!entry.isSymbolicLink() && !isSensitivePath(entry.name) && (entry.isDirectory() || entry.isFile())) {
      children.push([entry.name, entry.isDirectory() ? 'directory' : 'file']);
    }
  }
  children.sort((a, b) => order(a[0], b[0]));
  const after = await io.stat(real, { bigint: true });
  if (path.relative(real, await io.realpath(real)) || before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs) fail('directory changed');
  return sha256(JSON.stringify(children));
}

async function snapshot({ key, edges, projectDir }, loadGraph = require('./knowledge-graph').load) {
  if (!/^directory:[0-9a-f]{32}$/.test(key) || !Array.isArray(edges) || edges.length < 1 || edges.length > 16) fail('select up to 16 directory graph relations');
  const ids = new Set(), relations = [];
  for (const edge of edges) {
    if (!edge || !idPattern.test(edge.source) || !idPattern.test(edge.target) ||
        edge.source === edge.target || !relationTypes.has(edge.relation)) fail('invalid relation');
    ids.add(edge.source);
    ids.add(edge.target);
    relations.push({ source: edge.source, relation: edge.relation, target: edge.target });
  }
  if (ids.size > 16) fail('select up to 16 nodes');
  relations.sort((a, b) => order(a.source,b.source) || order(a.relation,b.relation) || order(a.target,b.target));
  if (new Set(relations.map(e => JSON.stringify(e))).size !== relations.length) fail('duplicate relation');
  const graph = await loadGraph(key);
  if (graph.key !== key || graph.vault || !path.isAbsolute(graph.root) || !path.isAbsolute(projectDir || '') ||
      isSensitivePath(graph.root) || isSensitivePath(projectDir)) fail('invalid directory root');
  const root = await io.realpath(graph.root);
  if (isSensitivePath(root) || path.relative(root, await io.realpath(projectDir)) !== '') fail('choose the indexed project folder');
  const byId = new Map(graph.nodes.filter(n => ids.has(n.id)).map(n => [n.id,n]));
  const nodes = [];
  for (const id of [...ids].sort()) {
    const n = byId.get(id);
    if (!n || n.virtual || n.hubImported || !['file','directory'].includes(n.kind)) fail('node unavailable');
    const rel = n.path;
    if (typeof rel !== 'string' || !rel || rel.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(rel) || path.posix.isAbsolute(rel) ||
        (rel !== '.' && rel.split('/').some(part => !part || part === '.' || part === '..')) || isSensitivePath(rel)) fail('invalid or sensitive path');
    const full = path.resolve(root, rel);
    const real = await io.realpath(full);
    if (isSensitivePath(real) || path.relative(full, real) !== '') fail('linked or sensitive target');
    const stat = await io.stat(real);
    if (n.kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) fail('node type changed');
    nodes.push({ id, kind: n.kind, path: rel, sha256: n.kind === 'directory' ? await directoryHash(real) : sha256(await readCheckedFile(root, full, real, maxBytes)) });
  }
  for (const e of relations.filter(e => e.relation === 'contains')) {
    const parent = byId.get(e.source), child = byId.get(e.target);
    if (parent.kind !== 'directory' || (parent.path !== '.' && !child.path.startsWith(parent.path + '/'))) fail('invalid containment');
  }
  return { schemaVersion: 1, key, nodes, edges: relations };
}

async function format(options) {
  const table = await snapshot(options);
  const body = JSON.stringify(table);
  // Filenames are user-controlled too. Check the final table at the prompt boundary.
  require('./prompt-safety').assertExternal(body);
  return MARKER + '\n' + body;
}

async function validatePrompt(prompt, projectDir) {
  if (!prompt.includes(MARKER)) return;
  const lines = prompt.split(/\r?\n/);
  let tables = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(MARKER)) continue;
    if (lines[i] !== MARKER) fail('invalid table marker');
    if (++tables > 4 || (lines[i+1] || '').length > 32768) fail('table size limit');
    let table;
    try { table = JSON.parse(lines[++i]); } catch { fail('invalid table'); }
    const verified = await format({ key: table?.key, edges: table?.edges, projectDir });
    if (verified !== MARKER + '\n' + lines[i]) fail('address changed; attach the selection again');
  }
}

module.exports = { snapshot, format, validatePrompt };

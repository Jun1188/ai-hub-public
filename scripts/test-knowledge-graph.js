// Regression: repository boundaries, examples, dated PC references, backlinks and legacy caches.
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-kg-regression-'));
process.env.APPDATA = path.join(tmp, 'Roaming');
process.env.LOCALAPPDATA = path.join(tmp, 'Local');
const repo = path.join(tmp, 'repository');
function write(relative, text) {
  const file = path.join(repo, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '\uFEFF' + text, 'utf8');
}
async function main() {
  write('skills/CATALOG.md', '[setup](../setup.md)\n[harness](development/custom-harness/SKILL.md)');
  write('skills/log-skill-setup.md', '[setup](../setup.md)');
  write('skills/development/custom-harness/SKILL.md', '---\nname: custom-harness\ndescription: contract\n---\n[harness](../../../harness/README.md)');
  write('skills/claude/academy-guide/SKILL.md', '---\nname: academy-guide\ndescription: template\n---\n`[Title](URL)`');
  write('setup.md', 'Setup contract'); write('harness/README.md', 'Harness contract');
  write('A.md', '[remote](missing.md)\n[unknown](unknown.md)');
  write('integrations/ai-hub/graph-locations.json', JSON.stringify({ version: 1, references: [{
    path: 'missing.md', locations: [{ computerId: 'OTHER-PC', scope: 'hub-app', path: 'docs/missing.md',
      observedAt: '2026-10-20T00:00:00Z', evidence: 'fixture observation' }]
  }] }));
  const config = require('../src/core/config'); config.setLocalOnly('sharedContext.repoPath', repo);
  const graph = require('../src/core/knowledge-graph');
  const skills = await graph.load('skills:repository');
  const setup = skills.nodes.find(n => n.path === 'setup.md');
  const harness = skills.nodes.find(n => n.path === 'harness/README.md');
  assert(setup && harness, 'contracts outside skills must be connected');
  assert.equal((await graph.detail(skills.key, setup.id)).backlinks.filter(e => e.relation === 'links').length, 2);
  assert.equal((await graph.detail(skills.key, harness.id)).backlinks.filter(e => e.relation === 'links').length, 1);
  assert(!skills.warnings.some(w => /setup.md|harness\/README|\u2192 URL/.test(w)), 'resolved/example links must not warn');
  assert(skills.nodes.filter(n => n.kind === 'skill').every(n => n.repositoryPath.startsWith('skills/')));
  const docs = await graph.load('repository:documents');
  const reported = docs.nodes.find(n => n.status === 'reported');
  const unknown = docs.nodes.find(n => n.status === 'location-unknown');
  assert.equal(reported.computerId, 'OTHER-PC'); assert.equal(reported.scope, 'hub-app');
  assert.equal(reported.file, undefined); assert.equal(unknown.computerId, 'unknown');
  const detail = await graph.detail(docs.key, reported.id);
  assert.equal(detail.backlinks[0].targetComputerId, 'OTHER-PC');
  assert.equal(detail.backlinks[0].targetScope, 'hub-app');
  assert(detail.backlinks.some(e => e.relation === 'links'));
  await assert.rejects(() => graph.original(docs.key, reported.id));
  assert((await graph.query({ key: docs.key, query: 'OTHER-PC' })).nodes.some(n => n.id === reported.id));
  const directory = await graph.buildDirectory({ root: repo });
  const selected = await graph.load(directory.key);
  const nodeId = rel => selected.nodes.find(n => n.path === rel).id;
  const address = require('../src/core/graph-addresses');
  const block = await address.format({ key: directory.key, projectDir: repo, edges: [
    { source: nodeId('harness'), relation: 'contains', target: nodeId('harness/README.md') }
  ] });
  assert(!block.includes('Harness contract') && !block.includes(repo));
  await address.validatePrompt(block, repo);
  write('harness/README.md', 'Changed contract');
  await assert.rejects(address.validatePrompt(block, repo), /address changed/);
  write('harness/README.md', 'Harness contract');
  const all = await graph.load('all:knowledge');
  assert.equal(all.nodes.find(n => n.id === reported.id).scope, 'hub-app');
  assert.equal(all.nodes.find(n => n.repositoryPath?.includes('custom-harness')).kind, 'skill');
  const vault = await graph.exportVault(docs.key);
  const noteName = fs.readdirSync(path.join(vault.folder, 'Nodes')).find(n => n.endsWith('--' + reported.id + '.md'));
  assert(noteName && !/^[a-f0-9]{32}\.md$/.test(noteName), 'exported note names must remain readable');
  const note = fs.readFileSync(path.join(vault.folder, 'Nodes', noteName), 'utf8');
  assert(note.includes('computer_id: "OTHER-PC"') && note.includes('location_status: "reported"'));
  assert(!note.includes('[원본 열기]'));
  const imported = await graph.importVault(path.join(vault.folder, 'Nodes'));
  assert.equal(imported.root, vault.folder, 'subfolders must resolve to the vault root');
  const roundtrip = await graph.load(imported.key);
  assert.equal(roundtrip.nodes.find(n => n.id === reported.id).label, reported.label);
  assert.equal(roundtrip.nodes.find(n => n.id === reported.id).computerId, 'OTHER-PC');
  assert(roundtrip.edges.some(e => e.source === detail.backlinks[0].source && e.target === reported.id && e.relation === 'links'));
  const generated = roundtrip.nodes.filter(n => n.originalId);
  assert.equal(new Set(generated.map(n => n.originalId)).size, generated.length, 'one node per original id');
  // A local repository symlink must never pull an out-of-root contract into the graph.
  const outside = path.join(tmp, 'private.md'); fs.writeFileSync(outside, 'private');
  try {
    fs.symlinkSync(outside, path.join(repo, 'outside.md'));
    write('skills/CATALOG.md', '[outside](../outside.md)');
    await graph.refresh(skills.key); const guarded = await graph.load(skills.key);
    assert(!guarded.nodes.some(n => n.file === outside || n.path === 'outside.md'));
  } catch (e) { if (e.code !== 'EPERM') throw e; }
  console.log('PASS knowledge graph: contracts, examples, PC references, backlinks, search, merge, vault, boundary');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  // Only remove this test's absolute, freshly allocated temporary directory.
  fs.rmSync(tmp, { recursive: true, force: true });
});

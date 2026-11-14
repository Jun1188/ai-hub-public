'use strict';
// REA bridge: runtime gate, evidence storage/tamper detection, analysis-context linkage and staleness. Offline (fake CLI).
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rea-')), prior = { ...process.env };
process.env.APPDATA = temporary;
// A pinned global install looks like <prefix>/rea-agents/{package.json,scripts/rea.mjs}.
const install = path.join(temporary, 'npm', 'rea-agents');
fs.mkdirSync(path.join(install, 'scripts'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'rea-fake-cli.mjs'), path.join(install, 'scripts', 'rea.mjs'));
const pin = version => fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ name: 'rea-agents', version }));
pin('6.4.0');
process.env.REA_CLI = path.join(install, 'scripts', 'rea.mjs');
process.env.REA_NODE = process.execPath;
const graph = require('../src/core/analysis-graph');
const rea = require('../src/core/rea-analysis');
const context = require('../src/core/analysis-context');
graph.setResourceGate(() => ({ admitted: true, sampledAt: Date.now() }));

async function main() {
  const secretName = 'sk-' + 'p'.repeat(30);
  const observe = (workflow, providerResult) => {
    const evidence = {normalized_result:providerResult};
    rea.projectResult(evidence, workflow);
    const report = rea.summarize(evidence, {workflow, input:{sha256:'local'}});
    assert(!JSON.stringify(evidence).includes(secretName), 'private strings must be omitted from the stored projection');
    return report.summary;
  };
  const artifact = observe('managed-artifact', {
    assembly:{name:'ManagedFixture',version:'0.0.0.0'}, module:{name:'ManagedFixture.dll'},
    classification:{implementation:'cil',managed_architecture:'anycpu'}, input_path:'C:/Users/private/app',
  });
  assert.deepEqual(artifact.artifact,{assemblyName:'ManagedFixture',version:'0.0.0.0',moduleName:'ManagedFixture.dll',implementation:'cil',architecture:'anycpu'});
  const members = observe('managed-members', {
    types:[{full_name:'Fixture.Counter'}, {full_name:secretName}],
    methods:[{name:'Adjust', body:'private IL'}, {name:'../private'}, ...Array(50).fill({name:'Label'})],
  });
  assert.deepEqual(members.members,{types:['Fixture.Counter'],methods:['Adjust','Label'],inspectedPerList:32});
  const node = resolved_path => ({observations:[{properties:{mechanism:'package.json:main',resolution_status:'resolved',resolved_path}}]});
  const script = observe('javascript',{summary:{browser_windows:0},
    graph:{nodes:[node('src/main.cjs'),node('/Users/private.js'),node('C:/private.js'),node('../private.js')]},
    semantic_graph:{nodes:[{kind:'function',properties:{name:'scale'}},{kind:'binding',properties:{name:'notFunction'}},
      {kind:'function',properties:{name:secretName}}]}});
  assert.deepEqual(script.application,{entryFiles:['main.cjs'],functions:['scale'],inspectedPerList:32});
  assert.equal(script.browser_windows,0);
  for (const name of ['C:\\Users\\private\\input.dll','/home/private/input.dll']) {
    assert.equal(rea.summarize({subject:{name}}, {input:{sha256:'local'}}).subject.name,'input.dll');
  }
  assert.equal(rea.summarize({subject:{name:secretName}}, {input:{sha256:'local'}}).subject.name,'');
  assert.equal(rea.supportedNode('v22.19.0'), true); assert.equal(rea.supportedNode('v24.11.1'), true);
  assert.equal(rea.supportedNode('v26.0.0'), true); assert.equal(rea.supportedNode('v23.9.0'), false);
  assert.equal(rea.supportedNode('v22.12.0'), false); assert.equal(rea.supportedNode('v20.18.0'), false);
  if (!rea.supportedNode(process.version)) {
    assert.equal((await rea.runtime()).reason, 'rea_node_runtime_unsupported');
    console.log('REA bridge: unsupported Node ' + process.version + ' is reported (bridge flow needs Node ^22.19/^24.11/>=26)');
    return;
  }
  const status = await rea.status();
  assert.equal(status.available, true); assert.equal(status.version, '6.4.0');
  assert.equal(status.providers[0].id, 'ghidra'); assert.equal(status.providers[0].status, 'unavailable');

  const target = path.join(temporary, 'Game.Managed.dll');
  fs.writeFileSync(target, 'MZ fixture');
  await assert.rejects(rea.analyze({ workflow: 'javascript', target }), /rea_target_kind_mismatch/);
  await assert.rejects(rea.analyze({ workflow: 'unknown', target }), /invalid_rea_workflow/);
  // Native PE goes to the Hub's persistent Ghidra project; REA keeps .NET and JS only.
  for (const workflow of ['overview', 'function', 'decompile', 'xrefs']) await assert.rejects(rea.analyze({ workflow, target }), /invalid_rea_workflow/);
  const result = await rea.analyze({ workflow: 'managed-members', target });
  assert.match(result.evidenceId, /^ev_[a-f0-9]{64}$/);
  assert.equal(result.provider.id, 'rea-managed'); assert.equal(result.rea.pinned, rea.PINNED);
  assert.deepEqual(result.limitations, ['Fixture limitation: metadata only.']);
  const loaded = rea.load(result.evidenceId);
  assert.equal(loaded.record.workflow, 'managed-members'); assert.equal(loaded.record.rea.version, '6.4.0');
  assert.equal(loaded.evidence.normalized_result.graph, undefined, 'only the bounded projection is stored');
  assert.equal(loaded.evidence.parameters, undefined); assert.equal(loaded.evidence.normalized_result.summary.types, 1);

  const pack = await context.prepare({ reaEvidenceId: result.evidenceId, purpose: 'learning', includeSource: true });
  assert.match(pack.evidenceId, /^[a-f0-9]{64}$/);
  assert.equal(pack.source, 'rea'); assert.equal(pack.reaEvidenceId, result.evidenceId);
  assert.match(pack.tool.version, /rea-agents 6\.4\.0/);
  assert.equal(pack.nodes[0].address, '0x1000'); assert.equal(pack.excerpts[0].evidence, 'INFERRED');
  assert.equal(pack.projectDir, undefined, 'local paths stay out of the model payload');
  assert.equal((await context.check(pack.evidenceId)).current, true);
  const again = await context.prepare({ reaEvidenceId: result.evidenceId, purpose: 'learning', includeSource: true });
  assert.equal(again.evidenceId, pack.evidenceId, 'same evidence and purpose reuse the frozen bundle');

  // Exercise the stored snapshot contract without invoking REA or rewriting an older frozen bundle.
  const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  const evidenceDir = path.join(temporary, 'ai-hub', 'rea-evidence.local');
  for (const count of [0, 12, 13, 24, 25, null]) {
    const original = { ...loaded.evidence, confidence: 'derived', authority: 'controlled-replay' };
    if (count === null) delete original.locations;
    else original.locations = Array.from({ length: Math.min(count, 24) }, (_, i) => ({ kind: 'symbol', name: 'symbol-' + i }));
    original.evidence_id = 'ev_' + hash(JSON.stringify({ count, original }));
    const bytes = JSON.stringify(original);
    const record = { ...loaded.record, evidenceId: original.evidence_id, storedSha256: hash(bytes) };
    fs.writeFileSync(path.join(evidenceDir, original.evidence_id + '.json'), bytes);
    fs.writeFileSync(path.join(evidenceDir, original.evidence_id + '.input.json'), JSON.stringify(record));
    const prepared = await context.prepare({ reaEvidenceId: original.evidence_id, purpose: 'learning' });
    const stored = count === null ? null : Math.min(count, 24);
    assert.deepEqual(prepared.locationCoverage, { storedLocations: stored, exportedLocations: Math.min(stored || 0, 12),
      totalLocations: null, projectionLimit: 24, contextLimit: 12, possiblyTruncated: stored === null ? null : stored >= 24 });
    assert.deepEqual(prepared.provenance, { confidence: 'derived', authority: 'controlled-replay' });
    assert.equal(prepared.authority, 'reference_only');
    assert.deepEqual(prepared.uncertainties, original.limitations);
    assert.ok(prepared.nodes.every(node => node.evidence === 'INFERRED'));
    assert.equal(rea.summarize(original, record).locationCoverage.storedLocations, stored);
    assert.equal((await context.prepare({ reaEvidenceId: original.evidence_id, purpose: 'learning' })).evidenceId, prepared.evidenceId);
    assert.equal((await context.check(prepared.evidenceId)).current, true);
  }
  for (const confidence of ['observed', 'inferred', undefined, 'future-level', '__proto__']) {
    const original = { ...loaded.evidence, confidence };
    original.evidence_id = 'ev_' + hash(JSON.stringify(original));
    const bytes = JSON.stringify(original);
    fs.writeFileSync(path.join(evidenceDir, original.evidence_id + '.json'), bytes);
    fs.writeFileSync(path.join(evidenceDir, original.evidence_id + '.input.json'), JSON.stringify({
      ...loaded.record, evidenceId: original.evidence_id, storedSha256: hash(bytes) }));
    const prepared = await context.prepare({ reaEvidenceId: original.evidence_id, purpose: 'learning' });
    assert.equal(prepared.provenance.confidence, confidence ?? null);
    assert.equal(prepared.nodes[0].evidence, confidence === 'observed' ? 'EXTRACTED' : confidence === 'inferred' ? 'INFERRED' : 'AMBIGUOUS');
  }
  const frozen = context.load(pack.evidenceId), beforePayload = JSON.stringify(frozen);
  const large = { ...frozen, nodes: Array.from({ length: 12 }, (_, i) => ({ ...frozen.nodes[0], id: 'n-' + i, label: 'x'.repeat(200) })),
    locationCoverage: { ...frozen.locationCoverage, storedLocations: 24, exportedLocations: 12 } };
  const compact = context.payload(large, JSON.stringify({ ...large, nodes: large.nodes.slice(0, 2) }).length + 40);
  assert.ok(compact.nodes.length < large.nodes.length);
  assert.equal(compact.locationCoverage.exportedLocations, compact.nodes.length);
  assert.equal(large.locationCoverage.exportedLocations, 12);
  assert.deepEqual(compact.provenance, frozen.provenance);
  assert.equal(JSON.stringify(frozen), beforePayload);
  const { locationCoverage, provenance, ...legacy } = frozen;
  assert.equal(context.payload(legacy).locationCoverage, undefined);
  assert.equal(context.payload(legacy).provenance, undefined);
  const { projection, ...legacyRecord } = loaded.record;
  assert.equal(rea.summarize(loaded.evidence, legacyRecord).locationCoverage.projectionLimit, null);

  fs.writeFileSync(target, 'MZ changed');
  const stale = await context.check(pack.evidenceId);
  assert.equal(stale.current, false); assert.match(stale.reason, /rea_target_stale_reanalyze/);
  await assert.rejects(context.prepare({ reaEvidenceId: result.evidenceId, purpose: 'development' }), /rea_target_stale_reanalyze/);
  const refreshed = await rea.analyze({ workflow: 'managed-members', target });
  assert.equal(refreshed.evidenceId, result.evidenceId, 'REA is deterministic for the same target path');
  assert.equal((await context.prepare({ reaEvidenceId: result.evidenceId, purpose: 'development' })).source, 'rea', 're-analysis clears staleness');
  const racing = await Promise.allSettled([rea.analyze({ workflow: 'managed-artifact', target }), rea.analyze({ workflow: 'managed-artifact', target })]);
  assert.equal(racing.filter(r => r.status === 'rejected' && /rea_analysis_in_progress/.test(r.reason.message)).length, 1);

  const stored = path.join(temporary, 'ai-hub', 'rea-evidence.local', result.evidenceId + '.json');
  fs.writeFileSync(stored, fs.readFileSync(stored, 'utf8').replace('metadata only', 'tampered'));
  assert.throws(() => rea.load(result.evidenceId), /rea_evidence_snapshot_changed/);

  const app = path.join(temporary, 'electron-app');
  fs.mkdirSync(app); fs.writeFileSync(path.join(app, 'main.js'), "require('electron');\n");
  const js = await rea.analyze({ workflow: 'javascript', target: app });
  assert.equal(typeof rea.load(js.evidenceId).record.input.treeSha256, 'string');
  const appPack = await context.prepare({ reaEvidenceId: js.evidenceId, purpose: 'learning' });
  const entry = path.join(app, 'main.js'), { atime, mtime } = fs.statSync(entry);
  fs.writeFileSync(entry, "require('electrom');\n"); fs.utimesSync(entry, atime, mtime);  // same size and mtime
  assert.match((await context.check(appPack.evidenceId)).reason, /rea_target_stale_reanalyze/, 'directory evidence hashes file contents');

  const failing = path.join(temporary, 'fail.dll'); fs.writeFileSync(failing, 'MZ');
  await assert.rejects(rea.analyze({ workflow: 'managed-artifact', target: failing }), /rea_failed: capability_unavailable: Fixture provider/);
  rea._reset(); pin('6.5.0');
  assert.equal((await rea.status()).reason, 'rea_version_mismatch');
  rea._reset(); process.env.REA_CLI = path.join(temporary, 'missing-rea.mjs');
  assert.equal((await rea.status()).reason, 'rea_cli_missing');
  console.log('REA bridge: pinned runtime gate, provider status, bounded workflows, evidence storage and tamper detection, analysis-context linkage, staleness and failures passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { process.env = prior; fs.rmSync(temporary, { recursive: true, force: true }); });

'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const graph = require('../src/core/analysis-graph');
const context = require('../src/core/analysis-context');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-analysis-context-')), prior = process.env.APPDATA;
  process.env.APPDATA = temporary;
  try {
    const project = path.join(temporary, 'project'); fs.mkdirSync(project);
    const source = 'function update(state) {\n  return state + 1;\n}\n';
    fs.writeFileSync(path.join(project, 'logic.js'), source, 'utf8');
    const name = 'learning-fixture', file = graph.graphPath(name); fs.mkdirSync(path.dirname(file), { recursive: true });
    const sample = { name, kind: 'source', root: project, createdAt: '2026-10-12T00:00:00Z', runtime: { name: 'fixture-parser', version: '1' },
      extractorHash: sha('fixture-parser/1'), warnings: ['Static references do not prove runtime execution.'],
      manifest: [{ file: 'logic.js', sha256: sha(source) }],
      nodes: [{ id: 'update', label: 'update', type: 'function', source_file: 'logic.js', source_location: 'logic.js:1-3', evidence: 'EXTRACTED' }], edges: [] };
    fs.writeFileSync(file, JSON.stringify(sample), 'utf8');
    const input = { graph: name, nodeIds: ['update'], purpose: 'learning' };
    const first = await context.prepare(input), reused = await context.prepare(input);
    assert.equal(first.evidenceId, reused.evidenceId);
    assert.equal(first.modelCalls, 0); assert.equal(first.authority, 'reference_only'); assert.equal(first.applies, null);
    assert.equal(first.excerpts.length, 0); assert.equal(first.nodes[0].startLine, 1); assert.equal(first.tool.version, '1');
    assert.equal((await context.check(first.evidenceId)).current, true);
    assert.ok(!JSON.stringify(context.payload(context.load(first.evidenceId))).includes(project));
    const withSource = await context.prepare({ ...input, includeSource: true });
    assert.match(withSource.excerpts[0].text, /state \+ 1/); assert.notEqual(first.evidenceId, withSource.evidenceId);
    assert.match(context.proposal(context.load(first.evidenceId)), /input-state-output/);
    await assert.rejects(context.prepare({ ...input, nodeIds: ['absent'] }), /not_found/);
    await assert.rejects(context.prepare({ ...input, nodeIds: Array(13).fill('update') }), /1_to_12/);
    await assert.rejects(context.prepare({ ...input, purpose: 'install' }), /purpose/);
    assert.throws(() => context.load(first.evidenceId, temporary), /project_mismatch/);
    await context.validateCurrent(context.load(first.evidenceId));
    fs.writeFileSync(path.join(project, 'logic.js'), source.replace('+ 1', '+ 2'), 'utf8');
    assert.equal((await context.check(first.evidenceId)).current, false);
    await assert.rejects(context.prepare(input), /sources_stale/);
    await assert.rejects(context.validateCurrent(context.load(first.evidenceId)));
    sample.manifest[0].sha256 = sha(source.replace('+ 1', '+ 2'));
    fs.writeFileSync(file, JSON.stringify(sample), 'utf8');
    const fresh = await context.prepare({ ...input, purpose: 'development' });
    assert.notEqual(fresh.evidenceId, first.evidenceId); assert.equal((await context.check(fresh.evidenceId)).current, true);
    assert.match(context.proposal(context.load(fresh.evidenceId)), /does not authorize/);
    const stored = path.join(temporary, 'ai-hub', 'analysis-contexts.local', fresh.evidenceId + '.json');
    const altered = JSON.parse(fs.readFileSync(stored, 'utf8')); altered.nodes[0].label = 'tampered'; fs.writeFileSync(stored, JSON.stringify(altered));
    assert.throws(() => context.load(fresh.evidenceId), /snapshot_changed/);
    const binaryName = 'binary-fixture', binaryFile = graph.graphPath(binaryName); fs.mkdirSync(path.dirname(binaryFile), { recursive: true });
    const binary = path.join(project, 'fixture.dll'); fs.writeFileSync(binary, Buffer.from('static fixture, never executed'));
    fs.writeFileSync(binaryFile, JSON.stringify({ name: binaryName, kind: 'binary', binaryPath: binary, binaryHash: sha(fs.readFileSync(binary)), exporterHash: sha('exporter'),
      runtime: { name: 'Ghidra', version: 'fixture' }, nodes: [{ id: 'fn', label: 'main', binary_address: '140001000', evidence: 'EXTRACTED' }], edges: [],
      selectedFunctions: [{ address: '140001000', decompiled: 'int main() { return 0; }', evidence: 'INFERRED' }] }), 'utf8');
    const binaryPack = await context.prepare({ graph: binaryName, nodeIds: ['fn'], purpose: 'modding', includeSource: true });
    assert.equal(binaryPack.nodes[0].address, '140001000'); assert.equal(binaryPack.excerpts[0].evidence, 'INFERRED');
    fs.appendFileSync(binary, 'changed'); assert.equal((await context.check(binaryPack.evidenceId)).current, false);
    console.log('analysis context: immutable IDs, opt-in excerpts, provenance, staleness detection, binary addresses and tamper detection passed');
  } finally {
    if (prior === undefined) delete process.env.APPDATA; else process.env.APPDATA = prior;
    if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir())) throw new Error('unsafe_test_cleanup');
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

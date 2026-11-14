'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const graph = require('../src/core/analysis-graph');

(async () => {
  const snapshot = { sampledAt: Date.now(), cpu: { usagePercent: 10 }, ram: { totalBytes: 16 * 1024 ** 3, usedBytes: 5 * 1024 ** 3 } };
  assert(graph.assessResources(snapshot, 'binary').admitted);
  assert(!graph.assessResources({ ...snapshot, sampledAt: Date.now() - 11000 }).admitted);
  assert(!graph.assessResources({ ...snapshot, cpu: { usagePercent: 90 } }).admitted);
  assert(!graph.assessResources({ ...snapshot, ram: { totalBytes: 8 * 1024 ** 3, usedBytes: 4 * 1024 ** 3 } }, 'binary').admitted);
  assert(!graph.assessResources({ ...snapshot, cpu: { usagePercent: null } }).admitted);
  const normalized = graph._normalize({ nodes: [
    { id: 'a', label: '인증 흐름', source_file: '자료/코드.py', source_location: 'L3' }, { id: 'b' }],
    edges: [{ source: 'a', target: 'b', relation: 'calls', confidence: 'INFERRED' },
      { source: 'a', target: 'missing', relation: 'calls' }] });
  assert.strictEqual(normalized.edges[0].evidence, 'INFERRED');
  assert.strictEqual(normalized.nodes[0].source_location, '자료/코드.py:3');
  assert.strictEqual(normalized.edges.length, 1);
  assert(normalized.warnings.some(x => x.includes('Dangling')));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-analysis-test-'));
  const beforeAppData = process.env.APPDATA;
  try {
    process.env.APPDATA = temporary;
    fs.mkdirSync(path.join(temporary, 'source', '자료'), { recursive: true });
    fs.writeFileSync(path.join(temporary, 'source', '자료', '코드.py'), 'def 인증():\n    return 1\n', 'utf8');
    fs.writeFileSync(path.join(temporary, 'outside.py'), 'print(1)', 'utf8');
    const scoped = await graph.selection(path.join(temporary, 'source'), ['자료', '자료/코드.py']);
    assert.strictEqual(scoped.files.length, 1);
    await assert.rejects(graph.selection(path.join(temporary, 'source'), ['../outside.py']), /outside_root/);
    await assert.rejects(graph.selection(path.join(temporary, 'source'), []), /explicit_source_scope/);
    const file = graph.graphPath('한글 그래프');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const sample = { name: '한글 그래프', kind: 'source', warnings: [], nodes: [
      { id: 'a', label: '호출자' }, { id: 'b', label: '중간' }, { id: 'c', label: '종료' }],
      edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }] };
    fs.writeFileSync(file, JSON.stringify(sample), 'utf8');
    assert.strictEqual((await graph.query('한글 그래프', '호출자', { direction: 'downstream' })).edges.length, 1);
    assert.strictEqual((await graph.shortestPath('한글 그래프', 'a', 'c')).edges.length, 2);
    assert.strictEqual((await graph.shortestPath('한글 그래프', 'c', 'a')).found, false);
    await assert.rejects(graph.shortestPath('한글 그래프', 'missing', 'a'), /exact_node_ids/);
    assert.strictEqual((await graph.list())[0].name, '한글 그래프');
    graph.setResourceGate(async () => ({ admitted: false, reason: 'test_resource_busy' }));
    assert((await graph.build({ name: 'deferred', root: 'absent', paths: ['absent'] })).deferred);
    assert.strictEqual(graph.cancel('no-job').requested, false);
  } finally {
    graph.setResourceGate(null);
    if (beforeAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = beforeAppData;
    const resolved = path.resolve(temporary);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir())) throw new Error('unsafe_test_cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  console.log('analysis graph: admission, scope, provenance, Korean, direction, deferral passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

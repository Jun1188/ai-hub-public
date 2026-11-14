'use strict';
const assert = require('assert');
const path = require('path');
const research = require('../src/core/research-review');
async function main() {
  const state = path.resolve(__dirname, '../isolated-state'), repo = path.resolve(__dirname, '../isolated-repository');
  let called = 0;
  const record = { count: 4, calibration: { samples: 0 }, selected: [
    { hypothesisId: 'hypothesis-one', title: 'Private cleanup', kind: 'local', origin: 'ponytail', component: 'client_tool', status: 'inconclusive', measured: false, source: { evidenceId: 'local-evidence', paths: ['private.js'] } },
  ] };
  const deps = { memory: { repoRoot: () => repo }, bootstrap: { manifest: () => ({ researchStateRoot: state }) },
    execFile: (_exe, args, opts, callback) => {
      called++; assert.deepEqual(args.slice(-2), ['--state', state]); assert.equal(opts.cwd, repo);
      assert(opts.timeout <= 8000); callback(null, JSON.stringify(record));
    } };
  const value = await research.read(deps), projected = research.project(value);
  assert.equal(called, 1); assert.equal(value.available, true); assert.equal(projected.selected[0].origin, 'ponytail');
  assert.equal(projected.selected[0].measured, false); assert.equal(projected.selected[0].source, undefined);
  assert.equal(projected.calibrationSamples, 0); assert.equal(projected.authority, 'proposals-only');
  const failed = await research.read({ ...deps, execFile: (_exe, _args, _opts, callback) => callback(new Error('timeout')) });
  assert.equal(failed.available, false);
  const missing = await research.read({ ...deps, memory: { repoRoot: () => null } }); assert.equal(missing.available, false);
  assert.equal(research.project({ available: true, selected: [{ title: 'Legacy', kind: 'paper' }] }).selected[0].origin, 'research');
  console.log('passed research state forwarding, private summary, legacy origin, timeout and missing-repository checks; offline only');
}
main().catch(e => { console.error(e); process.exitCode = 1; });

'use strict';
// Typed analysis-adapter manifest: tool version ranges, hard/soft dependencies, cycles, incompatibilities, and
// runtime adapters kept off the MCP list.
const assert = require('assert/strict');
const { references } = require('../src/core/analysis-adapters');
const { resolve, forMcp, satisfies } = require('../src/core/adapter-resolver');
const byId = result => Object.fromEntries(result.adapters.map(a => [a.id, a]));
const row = (id, extra = {}) => ({ id, integration: 'reference-candidate', supportedTargets: ['native'], tool: null, capabilities: ['static'],
  userGate: 'none', incompatibleWith: [], dependencies: { hard: [], soft: [] }, ...extra });

// The shipped manifest parses, REA needs its pinned CLI, and runtime adapters never reach MCP.
const shipped = resolve(references, { tools: { 'rea-agents': '6.4.0', ghidra: '11.4.2' } }), s = byId(shipped);
assert.equal(s.rea.enabled, true);
assert.equal(s.ghidra.enabled, true);
assert.deepEqual(shipped.cycles, []);
const mcp = forMcp(shipped).map(a => a.id);
assert.ok(mcp.includes('rea') && mcp.includes('cpp2il'));
for (const id of ['bepinex', 'harmonyx', 'il2cppinterop', 'ue4ss', 'skycraft', 'passthrough-mod-toolkit']) assert.ok(!mcp.includes(id), id + ' must stay off MCP');
assert.ok(references.every(r => typeof r.target === 'string' && typeof r.integration === 'string'), 'GUI list still reads target/integration');

const older = byId(resolve(references, { tools: { 'rea-agents': '6.3.0' } }));
assert.deepEqual(older.rea.reason, { code: 'tool_version_mismatch', tool: 'rea-agents', found: '6.3.0', range: '6.4.0' });
assert.deepEqual(older.ghidra.reason, { code: 'tool_not_found', tool: 'ghidra', range: '*' });

assert.equal(satisfies('0.9.1', '>=0.9.1 <0.10.0'), true);
assert.equal(satisfies('0.10.0', '>=0.9.1 <0.10.0'), false);
assert.equal(satisfies('v12.0.1', '<1.0.0 || >=12.0.0'), true);
assert.equal(satisfies('not-a-version', '*'), false);
assert.throws(() => satisfies('1.0.0', '^1.0.0'), /adapter_range_unsupported/);

const deps = byId(resolve([
  row('provider', { tool: { name: 'rizin', range: '>=0.9.1 <0.10.0' } }),
  row('needs-missing', { dependencies: { hard: ['not-in-manifest'], soft: [] } }),
  row('needs-provider', { dependencies: { hard: ['provider'], soft: [] } }),
  row('chained', { dependencies: { hard: ['needs-provider'], soft: [] } }),
  row('soft-only', { dependencies: { hard: [], soft: ['provider', 'not-in-manifest'] } }),
], { tools: { rizin: '0.8.0' } }));
assert.equal(deps.provider.reason.code, 'tool_version_mismatch');
assert.deepEqual(deps['needs-missing'].reason, { code: 'dependency_missing', dependency: 'not-in-manifest' });
assert.deepEqual(deps['needs-provider'].reason, { code: 'dependency_disabled', dependency: 'provider' });
assert.deepEqual(deps.chained.reason, { code: 'dependency_disabled', dependency: 'needs-provider' });
assert.equal(deps['soft-only'].enabled, true);
assert.deepEqual(deps['soft-only'].softMissing, ['provider', 'not-in-manifest']);

const looped = resolve([
  row('a', { dependencies: { hard: ['b'], soft: [] } }), row('b', { dependencies: { hard: ['a'], soft: [] } }),
  row('c', { dependencies: { hard: ['a'], soft: [] } }), row('self', { dependencies: { hard: ['self'], soft: [] } }),
]), l = byId(looped);
assert.deepEqual(looped.cycles, [['a', 'b'], ['self']]);
assert.equal(l.a.reason.code, 'dependency_cycle');
assert.equal(l.b.reason.code, 'dependency_cycle');
assert.equal(l.self.reason.code, 'dependency_cycle');
assert.deepEqual(l.c.reason, { code: 'dependency_disabled', dependency: 'a' });

const clash = byId(resolve([
  row('x', { incompatibleWith: ['y'] }), row('y'), row('p', { incompatibleWith: ['q'] }), row('q', { incompatibleWith: ['p'] }),
  row('z', { incompatibleWith: ['gone'], dependencies: { hard: [], soft: [] } }), row('gone', { dependencies: { hard: ['nowhere'], soft: [] } }),
  row('after-x', { dependencies: { hard: ['x'], soft: [] } }),
]));
assert.deepEqual(clash.x.reason, { code: 'incompatible_with', adapter: 'y' });
assert.equal(clash.y.enabled, true);
assert.equal(clash.p.enabled || clash.q.enabled, false);
assert.equal(clash.z.enabled, true, 'a disabled adapter does not clash');
assert.deepEqual(clash['after-x'].reason, { code: 'dependency_disabled', dependency: 'x' });

const targeted = byId(resolve(references, { tools: { 'rea-agents': '6.4.0', ghidra: '11.4.2' }, target: 'unity-il2cpp' }));
assert.equal(targeted.cpp2il.enabled, true);
assert.deepEqual(targeted.ghidra.reason, { code: 'target_unsupported', target: 'unity-il2cpp' });

const gated = resolve([row('gui-static', { userGate: 'approval' }), row('live', { capabilities: ['static', 'runtime'], userGate: 'approval' })]);
assert.deepEqual(forMcp(gated), []);
assert.throws(() => resolve([row('typo', { capabilities: ['runtme'] })]));
assert.throws(() => resolve([row('dup'), row('dup')]), /adapter_duplicate_id/);
console.log('Passed: shipped manifest parses, tool_version_mismatch/tool_not_found, missing and disabled hard dependencies, soft dependencies stay optional, cycles detected, incompatibilities order-independent, target filter, runtime/gated adapters off MCP');

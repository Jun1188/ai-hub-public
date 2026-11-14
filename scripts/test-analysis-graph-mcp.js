'use strict';
const assert = require('assert');
const tools = require('../src/mcp/analysis-graph-tools');
const registered = [];
tools.register({ registerTool: (name, options, handler) => registered.push({ name, options, handler }) });
assert.deepStrictEqual(registered.map(x => x.name), ['analysis_graph_list','analysis_graph_build','analysis_binary_query','analysis_binary_annotate',
  'analysis_graph_export','analysis_graph_query','analysis_graph_path','analysis_context_prepare','analysis_context_check']);
// Only the build tool takes input locations; nothing accepts execution, consent or approval flags.
const takesLocation = new Set(['analysis_graph_build']);
for (const row of registered) {
  const fields = Object.keys(row.options.inputSchema);
  assert(!fields.some(field => /execute|consent|approve|run_target/.test(field)), row.name);
  if (!takesLocation.has(row.name)) assert(!fields.some(field => /^(file|root|paths)$/.test(field)), row.name);
  assert.strictEqual(typeof row.handler, 'function');
}
// The annotate tool edits the analysis database only: no path or byte fields.
const annotate = registered.find(x => x.name === 'analysis_binary_annotate');
assert(!Object.keys(annotate.options.inputSchema).some(field => /bytes|patch|output|path/.test(field)));
const sanitized = tools.sanitize({ label: 'Authorization: Bearer dummy-credential-value',
  binaryHash: 'b'.repeat(64), note: 'api_key="dummy-value"', rationale: 'nvapi-' + 'z'.repeat(30) });
assert(!sanitized.label.includes('dummy-credential-value'));
assert(!sanitized.note.includes('dummy-value'));
assert(!sanitized.rationale.includes('nvapi-'));
assert.strictEqual(sanitized.binaryHash, 'b'.repeat(64));
assert.strictEqual(tools.sanitize({ evidenceId: 'e'.repeat(64) }).evidenceId, 'e'.repeat(64));
assert.strictEqual(tools.sanitize({ source_location: '자료/설계.md:12' }).source_location, '자료/설계.md:12');
console.log('analysis graph MCP: read-only schemas, credential-shaped redaction, Korean and provenance hash passed');

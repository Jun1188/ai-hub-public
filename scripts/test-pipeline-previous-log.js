'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-previous-log-'));
process.env.APPDATA = root;
process.env.LOCALAPPDATA = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('a following AI step receives the preceding MCP result before its provider runs', {timeout: 10000}, async () => {
  let prompt;
  const downstream = require.resolve('../src/core/downstream');
  const delegator = require.resolve('../src/core/delegator');
  require.cache[downstream] = { id: downstream, loaded: true, exports: {
    callTool: async () => ({ content: [{ type: 'text', text: 'synthetic-marker-$&' }] }),
  } };
  require.cache[delegator] = { id: delegator, loaded: true, exports: {
    delegate: async input => { prompt = input.prompt; return { model: 'fixture', content: 'ok' }; },
  } };
  const pipeline = require('../src/core/pipeline');
  const definition = pipeline.save({ name: 'previous log', steps: [
    { type: 'mcp-tool', name: 'produce', server: 'fixture', tool: 'sample' },
    { type: 'ai', name: 'consume', inputFrom: 'previousLog', promptTemplate: '{{input}}' },
  ] });
  const { runId } = pipeline.start(definition.id);
  for (let i = 0; i < 200 && pipeline.runStatus(runId).status === 'running'; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(pipeline.runStatus(runId).status, 'succeeded');
  assert.match(prompt, /synthetic-marker-\$&/);
});

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const aider = require('../src/core/aider-studio');

let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

(async () => {
  const state = await aider.status();
  check('provider-qualified model catalog exists', Array.isArray(state.models) &&
    state.models.every((m) => ['lmstudio', 'llamacpp', 'hf-cache'].includes(m.provider)));
  check('runtime inventories are separated', Array.isArray(state.llama.models) &&
    Array.isArray(state.lmstudio.models) && Array.isArray(state.hf.models));
  check('status does not expose local API keys', !/apiKey|Authorization/i.test(JSON.stringify(state)));

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'aider-studio.js'), 'utf8');
  check('noninteractive local runs do not open model warning pages',
    source.includes("'--no-show-model-warnings'") && source.includes("'--no-show-release-notes'"));
  check('Aider run logs survive the renderer and app process', source.includes("'aider-runs'") && source.includes('resultFile'));

  const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'local-runtime.js'), 'utf8');
  check('HF profile can prefer repository over launcher model',
    runtimeSource.includes('!options.preferRepo') && runtimeSource.includes("['-hf', modelRepo]"));

  const uiSource = fs.readFileSync(path.join(__dirname, '..', 'ui', 'tabs', 'aider-studio.js'), 'utf8');
  check('Aider owns local models and MCP surfaces', uiSource.includes("$('tab-delegate')") &&
    uiSource.includes("$('tab-mcp')") && uiSource.includes('data-aider-panel="connections"'));

  console.log(`\n통과 ${pass} / 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

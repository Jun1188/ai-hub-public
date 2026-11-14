#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const runtime = require('../src/core/local-runtime');
const config = require('../src/core/config');
let pass = 0, fail = 0;
function check(name, ok, detail = '') { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); } }
(async () => {
  const s = await runtime.status();
  const encoded = JSON.stringify(s);
  check('runtime/server/model absence is separated', Array.isArray(s.comfy.missing) && Array.isArray(s.llama.missing));
  check('status exposes no executable paths or launcher secrets', !/executable|desktopExe|modelPath|apiKey|Authorization/i.test(encoded), encoded);
  // Comfy Desktop 1.1+ keeps models in the shared folder its per-install extra-model-paths file names.
  check('Comfy Desktop shared model folder is read from base_path', JSON.stringify(runtime.yamlBasePaths(
    "# generated\ncomfy.desktop_0:\n  base_path: 'C:\\Shared\\models'\n  is_default: true\n  'checkpoints': 'checkpoints/'\n")) === JSON.stringify(['C:\\Shared\\models']));
  check('configured local model is basename only', !s.llama.configuredModelName || path.basename(s.llama.configuredModelName) === s.llama.configuredModelName);
  const localOnly = new Set(config.LOCAL_ONLY_PATHS);
  check('runtime URLs are per-machine only', localOnly.has('localRuntimes.comfyUrl') && localOnly.has('localRuntimes.llamaUrl'));
  check('installer toggle is per-machine only', localOnly.has('localRuntimes.showInstallActions'));
  const steps = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'local-pipeline-steps.js'), 'utf8');
  check('llama and Comfy pipeline steps exist', steps.includes("'llama-chat'") && steps.includes("'comfy-workflow'"));
  console.log(`\n통과 ${pass} / 실패 ${fail}`);
  // exitCode, not exit(): with ComfyUI running, status() leaves keep-alive fetch sockets open and process.exit() then
  // aborted on Windows (libuv "UV_HANDLE_CLOSING" assertion) after all checks had passed.
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error(err); process.exitCode = 1; });

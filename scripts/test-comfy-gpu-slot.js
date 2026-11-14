'use strict';
// ComfyUI runs must hold the local GPU slot, unload idle LM Studio models first and POST /free before releasing.
// Offline: fake fetch for ComfyUI, fake execFile for lms, mocked slot.
const assert = require('assert/strict'), fs = require('fs'), path = require('path'), os = require('os');
const childProcess = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-comfy-slot-fixture-')), saved = [];
function mock(name, exports) { const id = require.resolve('../src/core/' + name); saved.push([id, require.cache[id]]); require.cache[id] = { id, filename: id, loaded: true, exports }; }
const originalFetch = global.fetch, originalExecFile = childProcess.execFile;
const calls = [], bodies = {};
let scenario = {};

(async () => {
  // gpufit.unloadIdle: only idle LLMs are unloaded; an unreadable `lms ps` is not "nothing loaded".
  const lmsCalls = [];
  let psFails = false, vramLine = '';
  childProcess.execFile = (file, args, options, callback) => {
    if (String(args[0]).startsWith('--query-gpu')) return vramLine ? callback(null, Buffer.from(vramLine)) : callback(new Error('no nvidia-smi'));
    lmsCalls.push(args.join(' '));
    if (args[0] === 'ps') return psFails ? callback(new Error('lms missing')) : callback(null, Buffer.from(JSON.stringify([
      { identifier: 'busy-llm', status: 'busy', type: 'llm', sizeBytes: 4e9 },
      // 실제 LM Studio가 생성 중에 내는 상태들 — 노는 것으로 보면 진행 중인 요청이 끊긴다
      { identifier: 'gen-llm', status: 'generating', type: 'llm', sizeBytes: 4e9 },
      { identifier: 'prompt-llm', status: 'processingPrompt', type: 'llm', sizeBytes: 4e9 },
      { identifier: 'idle-llm', status: 'idle', type: 'llm', sizeBytes: 3e9 },
      { identifier: 'embedder', status: 'idle', type: 'embedding', sizeBytes: 1e8 },
    ])));
    return callback(null, Buffer.from(''));
  };
  const gpufit = require('../src/core/gpufit');
  const evicted = await gpufit.unloadIdle();
  assert.deepEqual(evicted.unloaded, ['idle-llm']);
  assert.deepEqual(lmsCalls, ['ps --json', 'unload idle-llm']);
  // A known need that already fits the free VRAM (8188 - 1200 - 640 display reserve = 6348 MiB) unloads nothing.
  vramLine = '8188, 1200\n'; lmsCalls.length = 0;
  assert.deepEqual(await gpufit.unloadIdle({ needMiB: 4000 }), { acted: false, unloaded: [], fits: true });
  assert.deepEqual(lmsCalls, []);
  assert.deepEqual((await gpufit.unloadIdle({ needMiB: 7000 })).unloaded, ['idle-llm']);
  vramLine = ''; lmsCalls.length = 0;
  assert.deepEqual((await gpufit.unloadIdle({ needMiB: 4000 })).unloaded, ['idle-llm'], 'unmeasurable VRAM must not be read as room');
  lmsCalls.length = 0; psFails = true;
  assert.equal((await gpufit.unloadIdle()).unknown, true);
  assert.deepEqual(lmsCalls, ['ps --json']);

  mock('config', { load: () => ({ localRuntimes: { comfyUrl: 'http://127.0.0.1:18188' } }) });
  mock('hardware-optimizer', { reserveLocalSlot: async () => { calls.push('slot'); return () => calls.push('release'); } });
  let unloadArgs = null;
  gpufit.unloadIdle = async (opts) => { calls.push('unload'); unloadArgs = opts;
    return scenario.fits ? { acted: false, unloaded: [], fits: true } : { acted: true, unloaded: ['idle-llm'] }; };
  global.fetch = async (url, options = {}) => {
    const route = new URL(url).pathname, method = options.method || 'GET';
    if (route !== '/system_stats' && route !== '/object_info') calls.push(`${method} ${route}`);
    if (options.body) bodies[route] = JSON.parse(options.body);
    if (route === '/system_stats') return new Response('{}');
    if (route === '/object_info') return new Response(JSON.stringify({ KSampler: {}, SaveImage: {} }));
    if (route === '/prompt') {
      if (scenario.abort) scenario.abort.abort();
      return scenario.promptFails ? new Response('boom', { status: 500 }) : new Response('{"prompt_id":"p1"}');
    }
    if (route === '/history/p1') {
      if (scenario.history === 'never') return new Response('{}');
      return new Response(JSON.stringify({ p1: { status: { status_str: scenario.history === 'error' ? 'error' : 'success' }, outputs: { 9: { images: [] } } } }));
    }
    if (route === '/free' && scenario.freeFails) return new Response('down', { status: 500 });
    if (['/free', '/queue', '/interrupt'].includes(route)) return new Response('');
    throw new Error('Unexpected request: ' + url);
  };
  const runtime = require('../src/core/local-runtime');
  const workflowFile = path.join(root, 'workflow.json');
  fs.writeFileSync(workflowFile, JSON.stringify({ 3: { class_type: 'KSampler', inputs: { seed: 1 } }, 9: { class_type: 'SaveImage', inputs: {} } }));
  const run = async (next, args = {}) => { scenario = next; calls.length = 0; for (const k of Object.keys(bodies)) delete bodies[k];
    return runtime.comfyWorkflow({ workflowFile, inputs: { 3: { seed: 7 } }, ...args }); };
  const done = ['POST /free', 'release'];

  const ok = await run({});
  assert.equal(ok.promptId, 'p1');
  assert.deepEqual(calls, ['slot', 'unload', 'POST /prompt', 'GET /history/p1', ...done]);
  assert.deepEqual(bodies['/free'], { unload_models: true, free_memory: true });
  assert.equal(bodies['/prompt'].prompt[3].inputs.seed, 7);
  assert.deepEqual(ok.gpu, { lmStudioUnloaded: ['idle-llm'], llamaUnloaded: [], llamaRestoreFailed: [] });
  assert.deepEqual(unloadArgs, { needMiB: undefined });

  const roomy = await run({ fits: true }, { vramMiB: 3000 });
  assert.deepEqual(unloadArgs, { needMiB: 3000 });
  assert.deepEqual(roomy.gpu.lmStudioUnloaded, []);

  // llama.cpp: only a Hub-started router yields its loaded models, and they come back after the run.
  const { yieldLlamaModels, restoreLlamaModels } = runtime._internals;
  const setCalls = [];
  const set = async (model, on) => { setCalls.push(`${on ? 'load' : 'unload'} ${model}`); if (model === 'stuck') throw new Error('busy'); };
  const router = async () => ({ running: true, router: true, models: [
    { id: 'coder', state: 'loaded' }, { id: 'stuck', state: 'loaded' }, { id: 'cold', state: 'unloaded' }, { id: 'broken', state: 'loaded', failed: true }] });
  let statusCalls = 0;
  assert.deepEqual(await yieldLlamaModels({ managed: null, status: async () => { statusCalls++; return router(); }, set }), []);
  assert.equal(statusCalls, 0, 'an external llama.cpp server is never touched');
  assert.deepEqual(await yieldLlamaModels({ managed: {}, status: async () => ({ running: true, router: false, models: [{ id: 'one', state: 'loaded' }] }), set }), []);
  assert.deepEqual(setCalls, [], 'a single-model server is not stopped');
  assert.deepEqual(await yieldLlamaModels({ managed: {}, status: router, set }), ['coder']);
  assert.deepEqual(setCalls, ['unload coder', 'unload stuck']);
  setCalls.length = 0;
  assert.deepEqual(await restoreLlamaModels(['coder', 'stuck'], { set }), ['stuck']);
  assert.deepEqual(setCalls, ['load coder', 'load stuck']);

  await assert.rejects(run({ history: 'error' }), /ComfyUI 실행 실패/);
  assert.deepEqual(calls, ['slot', 'unload', 'POST /prompt', 'GET /history/p1', ...done]);

  await assert.rejects(run({ promptFails: true }), /500/);
  assert.deepEqual(calls, ['slot', 'unload', 'POST /prompt', ...done]);

  await assert.rejects(run({ history: 'never' }, { timeoutMs: 500 }), /시간 초과/);
  assert.deepEqual(calls, ['slot', 'unload', 'POST /prompt', 'GET /history/p1', 'POST /queue', 'POST /interrupt', ...done]);
  assert.deepEqual(bodies['/queue'], { delete: ['p1'] });
  assert.deepEqual(bodies['/interrupt'], { prompt_id: 'p1' });

  const abort = new AbortController();
  await assert.rejects(run({ history: 'never', abort }, { signal: abort.signal }), /abort/i);
  assert.deepEqual(calls, ['slot', 'unload', 'POST /prompt', 'POST /queue', 'POST /interrupt', ...done]);

  assert.equal((await run({ freeFails: true })).promptId, 'p1');
  assert.deepEqual(calls.slice(-2), done);

  fs.writeFileSync(workflowFile, JSON.stringify({ 3: { class_type: 'MissingNode', inputs: {} } }));
  await assert.rejects(run({}), err => err.code === 'COMFY_MISSING_NODES');
  assert.deepEqual(calls, []);
  console.log('Passed: idle-only LM Studio unload, nothing unloaded when the known need fits, slot -> unload -> prompt -> history -> /free -> release on success, error, queue failure, timeout and abort (queue delete + interrupt), /free failure still releases, missing nodes never take the slot, only a Hub-started llama.cpp router yields and is restored');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  global.fetch = originalFetch; childProcess.execFile = originalExecFile;
  for (const [id, value] of saved) value ? require.cache[id] = value : delete require.cache[id];
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('hub-comfy-slot-fixture-')) fs.rmSync(root, { recursive: true, force: true });
});

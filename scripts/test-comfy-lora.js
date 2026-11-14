'use strict';
// ComfyUI LoRA: device-folder list without paths, name resolution before the GPU slot, LoraLoaderModelOnly chain after the
// diffusion model loader, VRAM request grows by the LoRA files, and unmatched LoRA keys in the ComfyUI log are reported.
// Offline: temp APPDATA with a fake Comfy Desktop install, fake fetch for ComfyUI, mocked slot and comfy-control.
const assert = require('assert/strict'), fs = require('fs'), path = require('path'), os = require('os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-comfy-lora-fixture-')), saved = [];
for (const [key, dir] of [['APPDATA', 'Roaming'], ['LOCALAPPDATA', 'Local'], ['AGENT_WORK_DIR', 'agent-work']]) {
  process.env[key] = path.join(root, dir);
  fs.mkdirSync(process.env[key], { recursive: true });
}
function mock(name, exports) { const id = require.resolve('../src/core/' + name); saved.push([id, require.cache[id]]); require.cache[id] = { id, filename: id, loaded: true, exports }; }
const originalFetch = global.fetch;

function safetensors(file, tensors, meta = {}) {
  const head = { __metadata__: meta };
  tensors.forEach((name, i) => { head[name] = { dtype: 'F32', shape: [1], data_offsets: [i * 4, i * 4 + 4] }; });
  const json = Buffer.from(JSON.stringify(head));
  const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(json.length));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([size, json, Buffer.alloc(tensors.length * 4)]));
}

(async () => {
  const lora = require('../src/core/comfy-lora');
  const shared = path.join(root, 'shared-models'), install = path.join(root, 'install');
  const style = ['diffusion_model.layers.0.attention.qkv.lora_down.weight', 'diffusion_model.layers.0.attention.qkv.lora_up.weight', 'diffusion_model.layers.0.attention.qkv.alpha'];
  safetensors(path.join(shared, 'loras', 'style.safetensors'), style, { 'modelspec.architecture': 'z-image', ss_network_dim: 16, 'modelspec.trigger_phrase': 'x'.repeat(500), ignored: 'secret-ish' });
  safetensors(path.join(shared, 'loras', 'sub', 'Char.safetensors'), ['a.lora_A.weight', 'a.lora_B.weight']);
  fs.writeFileSync(path.join(shared, 'loras', 'notes.txt'), 'not a model');
  fs.writeFileSync(path.join(shared, 'loras', 'old.ckpt'), Buffer.alloc(16));
  const broken = Buffer.alloc(16); broken.writeBigUInt64LE(1n << 40n); fs.writeFileSync(path.join(shared, 'loras', 'broken.safetensors'), broken);
  safetensors(path.join(install, 'ComfyUI', 'models', 'loras', 'style.safetensors'), ['dup.weight']); // same name in a later folder

  // list: names relative to loras/ (ComfyUI's lora_name), first folder wins, metadata trimmed to known keys, no paths.
  const listed = await lora.list([shared, path.join(install, 'ComfyUI', 'models'), path.join(root, 'missing')]);
  const byName = Object.fromEntries(listed.loras.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(byName).sort(), ['broken.safetensors', 'old.ckpt', path.join('sub', 'Char.safetensors'), 'style.safetensors'].sort());
  assert.equal(byName['style.safetensors'].tensors, 3, 'the first folder holding a name wins');
  assert.deepEqual(Object.keys(byName['style.safetensors'].meta).sort(), ['modelspec.architecture', 'modelspec.trigger_phrase', 'ss_network_dim']);
  assert.equal(byName['style.safetensors'].meta['modelspec.trigger_phrase'].length, 200);
  assert.equal(byName['style.safetensors'].meta.ss_network_dim, '16');
  assert.equal(byName['broken.safetensors'].tensors, undefined, 'an absurd header length is not read');
  assert.equal(byName['old.ckpt'].tensors, undefined);
  assert.ok(!JSON.stringify(listed).includes(root.replace(/\\/g, '\\\\')) && !JSON.stringify(listed).includes('"file"'), 'no device paths leave the module');
  assert.equal(listed.unreadable, undefined, 'a missing folder is not an unreadable one');

  // resolve: canonical name, default strength, size and tensor count; bad names never reach ComfyUI.
  const resolved = await lora.resolve([{ name: process.platform === 'win32' ? 'SUB/char.safetensors' : 'sub/Char.safetensors' }, { name: 'style.safetensors', strength: 0.6 }], [shared]);
  assert.deepEqual(resolved.map((x) => [x.name, x.strength, x.tensors]), [[path.join('sub', 'Char.safetensors'), 1, 2], ['style.safetensors', 0.6, 3]]);
  assert.ok(resolved[1].sizeBytes > 0);
  assert.deepEqual(await lora.resolve(undefined, [shared]), []);
  await assert.rejects(lora.resolve([{ name: 'nope.safetensors' }], [shared]), (e) => e.code === 'COMFY_LORA_NOT_FOUND' && e.available.includes('style.safetensors'));
  await assert.rejects(lora.resolve([{ name: '../outside.safetensors' }], [shared]), (e) => e.code === 'COMFY_LORA_INVALID');
  await assert.rejects(lora.resolve([{ name: path.join(shared, 'loras', 'style.safetensors') }], [shared]), (e) => e.code === 'COMFY_LORA_INVALID');
  await assert.rejects(lora.resolve([{ name: 'style.safetensors', strength: 'strong' }], [shared]), (e) => e.code === 'COMFY_LORA_INVALID');
  await assert.rejects(lora.resolve(Array(9).fill({ name: 'style.safetensors' }), [shared]), (e) => e.code === 'COMFY_LORA_INVALID');

  // inject: Z-Image graph (UNETLoader -> ModelSamplingAuraFlow -> KSampler) gets the chain between loader and its consumers.
  const zimage = { 1: { class_type: 'UNETLoader', inputs: { unet_name: 'z.safetensors' } }, 2: { class_type: 'CLIPLoader', inputs: {} },
    4: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3 } }, 8: { class_type: 'KSampler', inputs: { model: ['4', 0], seed: 1 } } };
  const chained = lora.inject(zimage, [{ name: 'a.safetensors', strength: 0.8 }, { name: 'b.safetensors', strength: -0.5 }]);
  assert.deepEqual(chained.hub_lora_1.inputs, { model: ['1', 0], lora_name: 'a.safetensors', strength_model: 0.8 });
  assert.deepEqual(chained.hub_lora_2.inputs, { model: ['hub_lora_1', 0], lora_name: 'b.safetensors', strength_model: -0.5 });
  assert.equal(chained.hub_lora_2.class_type, 'LoraLoaderModelOnly');
  assert.deepEqual(chained[4].inputs.model, ['hub_lora_2', 0]);
  assert.deepEqual(chained[8].inputs.model, ['4', 0]);
  assert.deepEqual(zimage[4].inputs.model, ['1', 0], 'the caller prompt is not mutated');
  assert.equal(lora.inject(zimage, []), zimage);
  // Checkpoint: only the MODEL output (slot 0) moves; CLIP (slot 1) stays on the loader.
  const ckpt = lora.inject({ 3: { class_type: 'CheckpointLoaderSimple', inputs: {} }, 5: { class_type: 'KSampler', inputs: { model: [3, 0] } },
    6: { class_type: 'CLIPTextEncode', inputs: { clip: ['3', 1] } } }, [{ name: 'a.safetensors', strength: 1 }]);
  assert.deepEqual(ckpt[5].inputs.model, ['hub_lora_1', 0]);
  assert.deepEqual(ckpt[6].inputs.clip, ['3', 1]);
  assert.deepEqual(ckpt.hub_lora_1.inputs.model, ['3', 0]);
  const two = { ...zimage, 9: { class_type: 'UNETLoader', inputs: {} } };
  assert.throws(() => lora.inject(two, [{ name: 'a', strength: 1 }]), (e) => e.code === 'COMFY_LORA_TARGET' && /1, 9/.test(e.message));
  assert.deepEqual(lora.inject(two, [{ name: 'a', strength: 1 }], '4')[8].inputs.model, ['hub_lora_1', 0], 'lora_target picks any node with MODEL at slot 0');
  assert.throws(() => lora.inject(zimage, [{ name: 'a', strength: 1 }], '77'), (e) => e.code === 'COMFY_LORA_TARGET');
  assert.throws(() => lora.inject({ 1: { class_type: 'UNETLoader', inputs: {} } }, [{ name: 'a', strength: 1 }]), (e) => e.code === 'COMFY_LORA_TARGET' && /쓰는 노드가 없습니다/.test(e.message));
  assert.throws(() => lora.inject(chained, [{ name: 'a', strength: 1 }], '1'), (e) => e.code === 'COMFY_LORA_TARGET');

  // notLoadedSince: only lines after the marker; a marker pushed out of the 300-line buffer gives a lower bound.
  const before = [{ t: '1', m: 'lora key not loaded: old.key\n' }, { t: '2', m: 'got prompt\n' }];
  const after = [...before, { t: '3', m: 'lora key not loaded: a.lora_A.weight\nlora key not loaded: a.lora_B.weight\n' }, { t: '4', m: 'NOT LOADED x\n' }];
  assert.deepEqual(lora.notLoadedSince(after, lora.logMarker(before), 5), { checked: true, verdict: 'some-not-loaded', notLoadedKeys: 3, sample: ['a.lora_A.weight', 'a.lora_B.weight', 'x'] });
  assert.equal(lora.notLoadedSince(after, lora.logMarker(before), 3).verdict, 'none-loaded');
  assert.equal(lora.notLoadedSince(after, lora.logMarker(before), null).verdict, 'some-not-loaded', 'unknown tensor count never claims none-loaded');
  assert.deepEqual(lora.notLoadedSince(before, lora.logMarker(before), 3), { checked: true, verdict: 'all-keys-loaded', notLoadedKeys: 0 });
  assert.equal(lora.notLoadedSince(after.slice(2), { t: '2', m: 'got prompt\n' }, 9).lowerBound, true);
  assert.equal(lora.logMarker([]), null);
  assert.equal(lora.notLoadedSince(after, null, 9).notLoadedKeys, 4, 'an empty buffer before the run counts everything after');

  // comfyWorkflow end to end with fakes.
  const desktop = path.join(process.env.APPDATA, 'Comfy Desktop');
  fs.mkdirSync(path.join(desktop, 'instance-model-paths'), { recursive: true });
  fs.writeFileSync(path.join(desktop, 'installations.json'), JSON.stringify([{ id: 'inst-1', status: 'installed', sourceId: 'standalone', installPath: install }]));
  fs.writeFileSync(path.join(desktop, 'instance-model-paths', 'inst-1.yaml'), `comfy.desktop_0:\n  base_path: '${shared}'\n  is_default: true\n  'loras': 'loras/'\n`);
  const calls = [], bodies = {};
  let scenario = {}, unloadArgs = null, ensureArgs = null, up = true;
  mock('config', { load: () => ({ localRuntimes: { comfyUrl: 'http://127.0.0.1:18188' } }) });
  mock('hardware-optimizer', { reserveLocalSlot: async () => { calls.push('slot'); return () => calls.push('release'); } });
  mock('gpufit', { unloadIdle: async (opts) => { calls.push('unload'); unloadArgs = opts; return { acted: false, unloaded: [], fits: true }; } });
  const { pickInstall } = require('../src/core/comfy-control');
  mock('comfy-control', { pickInstall, DEFAULT_VRAM_MIB: 5400, hold: () => () => {}, ensureComfy: async (opts) => { ensureArgs = opts; up = true; return { started: false }; } });
  let logEntries = [];
  global.fetch = async (url, options = {}) => {
    const route = new URL(url).pathname, method = options.method || 'GET';
    if (options.body) bodies[route] = JSON.parse(options.body);
    if (route === '/system_stats') { if (!up) throw new Error('ECONNREFUSED'); return new Response('{}'); }
    if (route === '/object_info') return new Response(JSON.stringify({ UNETLoader: {}, CLIPLoader: {}, ModelSamplingAuraFlow: {}, KSampler: {}, SaveImage: {}, LoraLoaderModelOnly: {} }));
    calls.push(`${method} ${route}`);
    if (route === '/internal/logs/raw') return scenario.noLogs ? new Response('nope', { status: 404 }) : new Response(JSON.stringify({ entries: logEntries }));
    if (route === '/prompt') { logEntries = [...logEntries, ...(scenario.warnings || [])]; return new Response('{"prompt_id":"p1"}'); }
    if (route === '/history/p1') return new Response(JSON.stringify({ p1: { status: { status_str: 'success' }, outputs: { 10: { images: [] } } } }));
    if (route === '/free') return new Response('');
    throw new Error('Unexpected request: ' + url);
  };
  const runtime = require('../src/core/local-runtime');
  const workflowFile = path.join(root, 'workflow.json');
  fs.writeFileSync(workflowFile, JSON.stringify({ ...zimage, 10: { class_type: 'SaveImage', inputs: { images: ['8', 0] } } }));
  const run = (next, args) => { scenario = next; calls.length = 0; logEntries = [{ t: '0', m: 'startup\n' }];
    return runtime.comfyWorkflow({ workflowFile, inputs: {}, ...args }); };
  const styleMiB = Math.ceil(fs.statSync(path.join(shared, 'loras', 'style.safetensors')).size / 1024 ** 2);

  const ok = await run({}, { vramMiB: 3000, loras: [{ name: 'style.safetensors', strength: 0.7 }] });
  assert.deepEqual(calls, ['slot', 'unload', 'GET /internal/logs/raw', 'POST /prompt', 'GET /history/p1', 'GET /internal/logs/raw', 'POST /free', 'release']);
  assert.deepEqual(bodies['/prompt'].prompt.hub_lora_1.inputs, { model: ['1', 0], lora_name: 'style.safetensors', strength_model: 0.7 });
  assert.deepEqual(bodies['/prompt'].prompt[4].inputs.model, ['hub_lora_1', 0]);
  assert.deepEqual(unloadArgs, { needMiB: 3000 + styleMiB }, 'a known need grows by the LoRA files');
  assert.deepEqual(ok.loras, [{ name: 'style.safetensors', strength: 0.7, sizeBytes: fs.statSync(path.join(shared, 'loras', 'style.safetensors')).size }]);
  assert.deepEqual(ok.loraCheck, { checked: true, verdict: 'all-keys-loaded', notLoadedKeys: 0 });

  const wrong = await run({ warnings: style.map((k, i) => ({ t: `w${i}`, m: `lora key not loaded: ${k}\n` })) }, { loras: [{ name: 'style.safetensors' }] });
  assert.equal(wrong.loraCheck.verdict, 'none-loaded', 'a LoRA for another base model is reported, not passed off as applied');
  assert.deepEqual(unloadArgs, { needMiB: undefined }, 'an unknown need stays unknown so every idle model makes room');

  assert.deepEqual((await run({ noLogs: true }, { loras: [{ name: 'style.safetensors' }] })).loraCheck, { checked: false, reason: 'comfy_log_unavailable' });

  // Server down: the start request carries the default server need plus the LoRA files.
  up = false;
  await run({}, { loras: [{ name: 'style.safetensors' }] });
  assert.deepEqual(ensureArgs.vramMiB, 5400 + styleMiB);
  up = false; ensureArgs = null;
  await run({}, {});
  assert.equal(ensureArgs.vramMiB, undefined, 'without LoRAs the start request is unchanged');

  const plain = await run({}, {});
  assert.deepEqual(calls, ['slot', 'unload', 'POST /prompt', 'GET /history/p1', 'POST /free', 'release'], 'no LoRA, no log reads');
  assert.equal(plain.loras, undefined);
  assert.equal(bodies['/prompt'].prompt.hub_lora_1, undefined);

  await assert.rejects(run({}, { loras: [{ name: 'missing.safetensors' }] }), (e) => e.code === 'COMFY_LORA_NOT_FOUND');
  assert.deepEqual(calls, [], 'an unknown LoRA never takes the GPU slot');

  const listedLive = await runtime.comfyLoras();
  assert.ok(listedLive.loras.some((x) => x.name === 'style.safetensors' && x.tensors === 3));

  // withGpu (LoRA training as a pipeline shell step): slot -> yields -> ComfyUI stop + /free -> admission -> program -> release.
  const control = require('../src/core/comfy-control');
  let gate = { admitted: true }, admissionArgs = null;
  control.stop = async () => { calls.push('comfy stop'); return { stopped: false }; };
  control.admission = async (mib) => { calls.push('admission'); admissionArgs = mib; return gate; };
  calls.length = 0;
  assert.equal(await runtime.withGpu({ vramMiB: 5500 }, async () => { calls.push('program'); return 0; }), 0);
  assert.deepEqual(calls, ['slot', 'unload', 'comfy stop', 'POST /free', 'admission', 'program', 'release']);
  assert.deepEqual(unloadArgs, { needMiB: 5500 });
  assert.equal(admissionArgs, 5500);
  gate = { admitted: false, reason: 'vram_insufficient', detail: { freeMiB: 4000, needMiB: 5500, reserveMiB: 768 } };
  calls.length = 0;
  await assert.rejects(runtime.withGpu({ vramMiB: 5500 }, async () => { calls.push('program'); }), (e) => e.code === 'GPU_DEFERRED' && e.reason === 'vram_insufficient');
  assert.deepEqual(calls, ['slot', 'unload', 'comfy stop', 'POST /free', 'admission', 'release'], 'a deferred start never runs the program and still releases');
  gate = { admitted: true };
  calls.length = 0;
  await assert.rejects(runtime.withGpu({ vramMiB: 5500 }, async () => { throw new Error('trainer crashed'); }), /trainer crashed/);
  assert.equal(calls.at(-1), 'release');
  // Cancelled while yielding models (admission then succeeds at once): the program must not start.
  const cancel = new AbortController();
  control.stop = async () => { calls.push('comfy stop'); cancel.abort(new Error('cancelled by user')); return { stopped: false }; };
  calls.length = 0;
  await assert.rejects(runtime.withGpu({ vramMiB: 5500, signal: cancel.signal }, async () => { calls.push('program'); }), /cancelled by user/);
  assert.deepEqual(calls, ['slot', 'unload', 'comfy stop', 'POST /free', 'admission', 'release'], 'a cancel during preparation never launches the program');

  // Pipeline: only a shell step with gpuVramMiB goes through withGpu; the log says it waited for the slot.
  const pipeline = require('../src/core/pipeline');
  const gpuCalls = [];
  runtime.withGpu = async (opts, fn) => { gpuCalls.push(opts.vramMiB); return fn(); };
  const saved = pipeline.save({ name: 'lora-train-test', steps: [
    { type: 'shell', name: 'train', command: 'echo trained-ok', gpuVramMiB: 5500 },
    { type: 'shell', name: 'plain', command: 'echo plain-ok' }] });
  const { runId } = pipeline.start(saved.id);
  const started = Date.now();
  let record = null;
  while (Date.now() - started < 30000) {
    record = pipeline.runStatus(runId);
    if (record && record.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(record && record.status, 'succeeded');
  assert.deepEqual(gpuCalls, [5500]);
  assert.match(pipeline.readLog(runId, 0), /GPU 슬롯[\s\S]*trained-ok/);
  assert.doesNotMatch(pipeline.readLog(runId, 1), /GPU 슬롯/);
  console.log('Passed: LoRA list (relative names, first folder wins, trimmed metadata, no paths), resolve (case, defaults, traversal, absolute, count, strength), LoraLoaderModelOnly chain (UNET and checkpoint slots, ambiguous/explicit/unused target), unmatched-key verdicts with marker and lower bound, comfyWorkflow injection, VRAM request + LoRA size, missing log route, unknown LoRA before the slot, withGpu order/deferral/crash release/cancel during preparation, pipeline shell gpuVramMiB branch');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  global.fetch = originalFetch;
  for (const [id, value] of saved) value ? require.cache[id] = value : delete require.cache[id];
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('hub-comfy-lora-fixture-')) fs.rmSync(root, { recursive: true, force: true });
});

'use strict';
// Headless ComfyUI control: start within the hardware budget, wait for a Desktop-owned server, stop only what the Hub
// started. Offline: fake spawn/fetch/snapshot/clock and a throwaway Desktop data folder; no real process is started.
const assert = require('assert/strict'), fs = require('fs'), path = require('path'), os = require('os');
const { EventEmitter } = require('events');
const control = require('../src/core/comfy-control');
const POLICY = require('../src/core/routing-policy.default.json');
const { admit, setDeps, reset } = control._internals;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-comfy-control-fixture-'));
const desktop = path.join(root, 'Comfy Desktop'), install = path.join(root, 'Installs', 'ComfyUI');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
write(path.join(desktop, 'installations.json'), JSON.stringify([
  { id: 'inst-cloud', status: 'installed', sourceId: 'cloud', remoteUrl: 'https://example.invalid/' },
  { id: 'inst-1', status: 'installed', installPath: install, sourceId: 'standalone', launchArgs: '--enable-manager' }]));
write(path.join(desktop, 'settings.json'), JSON.stringify({ inputDir: path.join(root, 'in'), outputDir: path.join(root, 'out') }));
write(path.join(desktop, 'instance-model-paths', 'inst-1.yaml'), 'comfy.desktop_0:\n  base_path: x\n');
write(path.join(install, 'ComfyUI', '.venv', 'Scripts', 'python.exe'), '');
write(path.join(install, 'ComfyUI', 'main.py'), '');
const procFile = path.join(desktop, 'comfy-procs', 'inst-1.json');
const logFile = path.join(root, 'comfyui-headless.log');

const GPU = { totalMiB: 8188, usedMiB: 1500, usagePercent: 40, busyPercent: 5 };
let st;
function fresh(extra = {}) {
  reset();
  st = { clock: 1_000_000, upAfter: Infinity, statsCalls: 0, spawns: [], kills: [], children: [], alive: new Set(), startTimes: {},
    queue: { queue_running: [], queue_pending: [] }, auto: true, idleMin: 10, url: 'http://127.0.0.1:18188',
    gpu: { ...GPU }, ram: { totalBytes: 32e9, usedBytes: 16e9 }, onAcPower: true, exitOnSpawn: false, ...extra };
  setDeps({
    fetch: async (url) => {
      const route = new URL(url).pathname;
      if (route === '/system_stats') { st.statsCalls++; if (st.statsCalls <= st.upAfter) throw new Error('ECONNREFUSED'); }
      return { ok: true, status: 200, json: async () => (route === '/queue' ? st.queue : {}) };
    },
    spawn: (file, args, options) => {
      const child = Object.assign(new EventEmitter(), { pid: 990000 + st.spawns.length, exitCode: null, signalCode: null });
      child.exit = (code) => { child.exitCode = code; child.emit('exit', code); };
      st.spawns.push({ file, args, options }); st.children.push(child);
      setImmediate(() => { child.emit('spawn'); if (st.exitOnSpawn) { fs.appendFileSync(logFile, 'Traceback: port in use'); child.exit(1); } });
      if (st.onSpawn) st.onSpawn(child);
      return child;
    },
    killTree: async (pid) => { st.kills.push(pid); for (const c of st.children) if (c.pid === pid && c.exitCode === null) c.exit(1); },
    killTreeSync: (pid) => st.kills.push(`sync ${pid}`),
    isAlive: (pid) => st.alive.has(pid),
    startTime: async (pid) => st.startTimes[pid] ?? null,
    sleep: async (ms, signal) => { if (signal && signal.aborted) throw signal.reason || new Error('aborted'); st.clock += ms; },
    now: () => st.clock,
    snapshot: async () => ({ sampledAt: st.clock, ram: st.ram, gpu: { devices: [st.gpu] } }),
    environment: async () => ({ onAcPower: st.onAcPower }),
    policy: () => POLICY,
    automaticPreparation: () => st.auto,
    settings: () => ({ comfyUrl: st.url, comfyIdleStopMin: st.idleMin }),
    desktopDir: () => desktop,
    logFile: () => logFile,
  });
}

(async () => {
  // Defer reasons use the shared routing policy; NVML usagePercent alone never blocks.
  const snap = (gpu, ram = { totalBytes: 32e9, usedBytes: 16e9 }) => ({ sampledAt: 1000, ram, gpu: { devices: [gpu] } });
  const gate = (s, extra = {}) => admit({ snapshot: s, environment: { onAcPower: true }, policy: POLICY, vramMiB: 5400, now: 1000, ...extra });
  assert.equal(gate(snap(GPU)).admitted, true);
  assert.equal(gate(snap({ ...GPU, usagePercent: 45, busyPercent: undefined })).admitted, true, 'wallpaper/OBS NVML load is not GPU busy');
  assert.equal(gate(snap({ ...GPU, busyPercent: 90 })).reason, 'gpu_busy');
  const low = gate(snap({ ...GPU, usedMiB: 7600 }));
  assert.equal(low.reason, 'vram_insufficient');
  assert.deepEqual(low.detail, { freeMiB: 588, needMiB: 5400, reserveMiB: 768 });
  assert.equal(gate(snap({ ...GPU, usedMiB: 7600 }), { vramMiB: 0 }).admitted, true, 'the manual start needs no workflow VRAM');
  assert.equal(gate(snap(GPU, { totalBytes: 32e9, usedBytes: 29e9 })).reason, 'ram_pressure');
  assert.equal(gate(snap(GPU), { environment: { onAcPower: false } }).reason, 'on_battery');
  assert.equal(gate(snap(GPU), { environment: { onAcPower: null } }).admitted, true, 'unknown power is neutral');
  assert.equal(gate({ sampledAt: 1000, ram: { totalBytes: 32e9, usedBytes: 1e9 }, gpu: { devices: [] } }).reason, 'vram_unmeasured');
  assert.equal(gate(snap(GPU), { now: 30000 }).reason, 'resource_sample_stale');
  assert.equal(gate(null).reason, 'resource_sample_stale');

  // Already running: nothing is spawned.
  fresh({ upAfter: 0 });
  assert.deepEqual(await control.ensureComfy(), { started: false });
  assert.equal(st.spawns.length, 0);

  // Desktop-owned server starting: wait for its API instead of spawning a second instance on the same DB.
  fresh({ upAfter: 3 });
  write(procFile, JSON.stringify({ childPid: 4321, port: 18188, childStartTime: '134366488808277760' }));
  st.alive.add(4321); st.startTimes[4321] = 134366488808277760;
  const waited = await control.ensureComfy();
  assert.equal(waited.desktop, true);
  assert.equal(st.spawns.length, 0);
  assert.deepEqual(await control.stop(), { stopped: false, reason: 'not_owned' }, 'a Desktop server is never stopped');
  assert.deepEqual(st.kills, []);
  fresh();
  st.alive.add(4321); st.startTimes[4321] = 134366488808277760;
  write(procFile, JSON.stringify({ childPid: 4321, port: 8188 }));
  await assert.rejects(control.ensureComfy(), (e) => e.code === 'COMFY_DESKTOP_RUNNING');
  // A reused PID (different start time) or a stop request is not a running Desktop server.
  for (const rec of [{ childPid: 4321, port: 18188, childStartTime: '134366400000000000' }, { childPid: 4321, port: 18188, stopRequestedAt: 1 }]) {
    fresh({ upAfter: 2 });
    st.alive.add(4321); st.startTimes[4321] = 134366488808277760;
    write(procFile, JSON.stringify(rec));
    assert.equal((await control.ensureComfy()).started, true);
    assert.equal(st.spawns.length, 1);
  }
  fs.rmSync(procFile);

  // Spawn + poll: Desktop's flags and paths from its own files, loopback port from comfyUrl, hidden window.
  fresh({ upAfter: 4 });
  const started = await control.ensureComfy();
  assert.equal(started.started, true);
  assert.equal(started.startupMs, 6000);
  const [spawned] = st.spawns;
  assert.equal(spawned.file, path.join(install, 'ComfyUI', '.venv', 'Scripts', 'python.exe'));
  assert.equal(spawned.options.cwd, install);
  assert.equal(spawned.options.windowsHide, true);
  assert.equal(spawned.options.env.PYTHONIOENCODING, 'utf-8');
  assert.deepEqual(spawned.args, ['-s', path.join('ComfyUI', 'main.py'), '--feature-flag', 'show_signin_button=true', '--enable-assets', '--enable-manager',
    '--extra-model-paths-config', path.join(desktop, 'instance-model-paths', 'inst-1.yaml'), '--input-directory', path.join(root, 'in'),
    '--output-directory', path.join(root, 'out'), '--listen', '127.0.0.1', '--port', '18188']);
  assert.equal(control.owner().pid, 990000);

  // Idle stop: never while a workflow holds it, not before the limit, not while the queue has work, then only ours.
  const done = control.hold();
  st.clock += 60 * 60000;
  assert.equal((await control.stopIfIdle()).stopped, false);
  done();
  st.clock += 5 * 60000;
  assert.equal((await control.stopIfIdle()).reason, 'recently_used');
  st.clock += 6 * 60000;
  st.queue = { queue_running: [['x']], queue_pending: [] };
  assert.equal((await control.stopIfIdle()).reason, 'queue_active');
  st.queue = { queue_running: [], queue_pending: [] };
  st.clock += 11 * 60000;
  assert.equal((await control.stopIfIdle()).stopped, true);
  assert.deepEqual(st.kills, [990000]);
  assert.equal(control.owner(), null);
  assert.deepEqual(await control.stop(), { stopped: false, reason: 'not_owned' });

  fresh({ upAfter: 1, idleMin: 0 });
  await control.ensureComfy();
  st.clock += 24 * 60 * 60000;
  assert.equal((await control.stopIfIdle()).stopped, false, 'comfyIdleStopMin 0 disables the idle stop');

  // Concurrent callers share one start.
  fresh({ upAfter: 3 });
  const both = await Promise.all([control.ensureComfy(), control.ensureComfy()]);
  assert.equal(st.spawns.length, 1);
  assert.equal(both[0], both[1]);

  // Timeout: the spawned tree is killed and the error names the log.
  fresh();
  await assert.rejects(control.ensureComfy({ timeoutMs: 10000 }), (e) => e.code === 'COMFY_START_TIMEOUT' && e.message.includes(logFile));
  assert.deepEqual(st.kills, [990000]);
  assert.equal(control.owner(), null);

  // The server dies during startup (e.g. port in use): fail fast with the decoded log tail.
  fresh({ exitOnSpawn: true });
  await assert.rejects(control.ensureComfy(), (e) => e.code === 'COMFY_START_FAILED' && /port in use/.test(e.message));
  assert.deepEqual(st.kills, []);

  // Abort while starting: only our startup is reaped.
  fresh();
  const abort = new AbortController();
  st.onSpawn = () => setImmediate(() => abort.abort());
  await assert.rejects(control.ensureComfy({ signal: abort.signal }), /abort/i);
  assert.deepEqual(st.kills, [990000]);

  // Budget, automatic-preparation and install gates: nothing is spawned.
  fresh({ gpu: { ...GPU, usedMiB: 7600 } });
  await assert.rejects(control.ensureComfy(), (e) => e.code === 'COMFY_DEFERRED' && e.reason === 'vram_insufficient' && e.detail.freeMiB === 588);
  fresh({ gpu: { ...GPU, busyPercent: 95 } });
  await assert.rejects(control.ensureComfy(), (e) => e.reason === 'gpu_busy');
  fresh({ onAcPower: false });
  await assert.rejects(control.ensureComfy(), (e) => e.reason === 'on_battery');
  assert.equal(st.spawns.length, 0);
  // A VRAM sample that lags behind an LM Studio unload settles within the window.
  fresh({ upAfter: 1, gpu: { ...GPU, usedMiB: 7600 } });
  setDeps({ snapshot: async () => ({ sampledAt: st.clock, ram: st.ram, gpu: { devices: [{ ...st.gpu, usedMiB: st.clock > 1_005_000 ? 1500 : 7600 }] } }) });
  assert.equal((await control.ensureComfy()).started, true);
  fresh({ auto: false });
  await assert.rejects(control.ensureComfy(), (e) => e.code === 'COMFY_AUTO_START_DISABLED' && /직접 시작/.test(e.message));
  fresh({ auto: false, upAfter: 1 });
  assert.equal((await control.ensureComfy({ manual: true, vramMiB: 0 })).started, true, 'the GUI button is a manual start');
  // 직접 시작한 서버는 브라우저 편집이 큐에 안 잡혀도 유휴로 끄지 않는다. 끄기 버튼(stop)으로만 내린다.
  assert.equal(control.owner().manual, true);
  st.clock += 60 * 60000;
  assert.equal((await control.stopIfIdle()).stopped, false, 'a manually started server is never idle-stopped');
  assert.equal((await control.stop()).stopped, true);
  // GUI 버튼은 기동을 기다리지 않고 돌아오고, 결과는 status().lastStart로 본다
  // 기동 경로가 실제 파일(설치 정보)을 비동기로 읽으므로 틱 수가 아니라 실제 시간으로 기다린다(test-all 부하에서 틱 200개는 모자랐다).
  const settle = async () => { const end = Date.now() + 10000; while (control.status().lastStart.state === 'starting' && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); };
  fresh({ upAfter: 1 });
  assert.deepEqual(control.startInBackground(), { pending: true }); assert.equal(control.status().lastStart.state, 'starting');
  assert.deepEqual(control.startInBackground(), { pending: true }, 'a second click joins the same start');
  await settle(); assert.equal(control.status().lastStart.state, 'up'); assert.equal(control.status().owner.manual, true);
  fresh({ url: 'http://192.168.0.5:8188' });
  control.startInBackground(); await settle();
  assert.equal(control.status().lastStart.state, 'failed'); assert.equal(control.status().lastStart.code, 'COMFY_REMOTE');
  fresh({ url: 'http://192.168.0.5:8188' });
  await assert.rejects(control.ensureComfy(), (e) => e.code === 'COMFY_REMOTE');
  fresh();
  write(path.join(desktop, 'settings.json'), '{broken');
  await assert.rejects(control.ensureComfy(), SyntaxError, 'a corrupt settings.json is not read as defaults');
  write(path.join(desktop, 'settings.json'), '{}');
  const instanceYaml=path.join(desktop,'instance-model-paths','inst-1.yaml');
  const sharedYaml=path.join(desktop,'shared_model_paths.yaml');
  write(sharedYaml,"comfy.desktop_0:\n  base_path: 'shared'\n");
  assert((await control._internals.launchSpec(18188)).args.includes(instanceYaml));
  fs.renameSync(instanceYaml,instanceYaml+'.saved');
  assert((await control._internals.launchSpec(18188)).args.includes(sharedYaml));
  fs.renameSync(instanceYaml+'.saved',instanceYaml);
  fs.rmSync(path.join(install, 'ComfyUI', 'main.py'));
  await assert.rejects(control.ensureComfy(), (e) => e.code === 'COMFY_NOT_INSTALLED');
  assert.equal(st.spawns.length, 0);
  fs.writeFileSync(path.join(install, 'ComfyUI', 'main.py'), '');

  // comfyWorkflow with the server down: slot -> LM Studio unload -> start -> convert the UI graph -> prompt -> /free -> release.
  const saved = [], calls = [];
  const mock = (name, exports) => { const id = require.resolve('../src/core/' + name); saved.push([id, require.cache[id]]); require.cache[id] = { id, filename: id, loaded: true, exports }; };
  mock('config', { load: () => ({ localRuntimes: { comfyUrl: 'http://127.0.0.1:18188' } }) });
  mock('hardware-optimizer', { reserveLocalSlot: async () => { calls.push('slot'); return () => calls.push('release'); } });
  mock('gpufit', { unloadIdle: async () => { calls.push('unload'); return { unloaded: ['idle-llm'], fits: true }; } });
  const objectInfo = { LoadImage: { input: { required: { image: [['a.png', 'b.png'], { image_upload: true }] } }, input_order: { required: ['image'] } },
    SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', {}] } }, input_order: { required: ['images', 'filename_prefix'] } } };
  let serverUp = false, posted = null;
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const route = new URL(url).pathname, method = options.method || 'GET';
    if (route === '/system_stats' || route === '/object_info') {
      if (!serverUp) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify(route === '/object_info' ? objectInfo : {}));
    }
    calls.push(`${method} ${route}`);
    if (route === '/prompt') { posted = JSON.parse(options.body).prompt; return new Response('{"prompt_id":"p1"}'); }
    if (route === '/history/p1') return new Response(JSON.stringify({ p1: { status: { status_str: 'success' }, outputs: { 2: { images: [] } } } }));
    return new Response('');
  };
  try {
    fresh();
    setDeps({ fetch: (...args) => global.fetch(...args) });
    st.onSpawn = () => { calls.push('spawn'); serverUp = true; };
    const workflowFile = path.join(root, 'ui-workflow.json');
    fs.writeFileSync(workflowFile, JSON.stringify({ nodes: [
      { id: 1, type: 'LoadImage', mode: 0, inputs: [], widgets_values: ['a.png', 'image'] },
      { id: 2, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 9 }], widgets_values: ['3d/out'] },
      { id: 3, type: 'MarkdownNote', mode: 0, inputs: [], widgets_values: ['read me'] }], links: [[9, 1, 0, 2, 0, 'IMAGE']] }));
    const result = await require('../src/core/local-runtime').comfyWorkflow({ workflowFile, inputs: { 1: { image: 'b.png' } } });
    assert.deepEqual(calls, ['slot', 'unload', 'spawn', 'POST /prompt', 'GET /history/p1', 'POST /free', 'release']);
    assert.deepEqual(Object.fromEntries(Object.entries(posted).map(([id, n]) => [id, [n.class_type, n.inputs]])),
      { 1: ['LoadImage', { image: 'b.png' }], 2: ['SaveImage', { filename_prefix: '3d/out', images: ['1', 0] }] });
    assert.equal(result.comfyStarted.pid, 990000);
    assert.equal(control.owner().holds, 0, 'the run released its hold so the idle stop can fire');
    // ComfyUI runs the outputs that validate and reports the rest in node_errors: that is a failure, not a partial success.
    calls.length = 0;
    const realFetch = global.fetch;
    global.fetch = async (url, options = {}) => (new URL(url).pathname === '/prompt'
      ? (calls.push('POST /prompt'), new Response(JSON.stringify({ prompt_id: 'p1', node_errors: { 2: { class_type: 'SaveImage',
        errors: [{ message: 'Required input is missing', details: 'images' }] } } })))
      : realFetch(url, options));
    await assert.rejects(require('../src/core/local-runtime').comfyWorkflow({ workflowFile }),
      (e) => e.code === 'COMFY_INVALID_WORKFLOW' && /SaveImage 2: Required input is missing: images/.test(e.message));
    assert.deepEqual(calls, ['slot', 'unload', 'POST /prompt', 'POST /queue', 'POST /interrupt', 'POST /free', 'release']);
  } finally {
    global.fetch = originalFetch;
    for (const [id, value] of saved) value ? require.cache[id] = value : delete require.cache[id];
  }
  console.log('Passed: comfyWorkflow starts a stopped server after slot+unload and converts a UI workflow, partial node_errors fail and dequeue; defer reasons (VRAM+reserve, RAM cap, Windows busy not NVML, battery, stale/unmeasured), already-running, Desktop-owned wait (port, reused PID, stop request), Desktop flags/paths, idle stop (hold, limit, queue, disabled), shared start, timeout kill, early exit log tail, abort reaps only ours, auto-preparation/manual, remote URL, corrupt settings, missing install');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  reset();
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('hub-comfy-control-fixture-')) fs.rmSync(root, { recursive: true, force: true });
});

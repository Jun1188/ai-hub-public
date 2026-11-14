// Aider owns code-editing orchestration. The hub supplies local model discovery,
// connection preparation, a visible command plan and a cancellable boundary.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const runtime = require('./local-runtime');
const lmstudio = require('./lmstudio');
const consoleText = require('./console-text');
const { hubDataDir } = require('./paths');

const HOME = os.homedir();
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const MAX_LOG_CHARS = 240000;
const RUNS_DIR = path.join(hubDataDir(), 'aider-runs');
let active = null;
let starting = false;
let emit = () => {};
const finished = new Map();

function setEmitter(fn) { emit = typeof fn === 'function' ? fn : () => {}; }
function firstExisting(candidates) {
  for (const file of candidates.filter(Boolean)) {
    try { if (fs.statSync(file).isFile()) return file; } catch { /* next */ }
  }
  return '';
}
function pathExecutables(name) {
  return String(process.env.PATH || '').split(path.delimiter)
    .map((dir) => path.join(dir, process.platform === 'win32' ? `${name}.exe` : name));
}
function executable() {
  return firstExisting([
    process.env.AIDER_BIN,
    path.join(HOME, '.local', 'bin', 'aider.exe'),
    path.join(HOME, '.local', 'share', 'uv', 'tools', 'aider-chat', 'Scripts', 'aider.exe'),
    path.join(APPDATA, 'Python', 'Python313', 'Scripts', 'aider.exe'),
    path.join(APPDATA, 'Python', 'Python312', 'Scripts', 'aider.exe'),
    path.join(LOCALAPPDATA, 'Programs', 'Python', 'Python313', 'Scripts', 'aider.exe'),
    ...pathExecutables('aider'),
  ]);
}
function hfExecutable() {
  return firstExisting([
    process.env.HF_BIN,
    path.join(HOME, '.local', 'bin', 'hf.exe'),
    path.join(HOME, '.local', 'share', 'uv', 'tools', 'huggingface-hub', 'Scripts', 'hf.exe'),
    ...pathExecutables('hf'),
  ]);
}
function installer() { return firstExisting([path.join(APPDATA, 'Python', 'Python314', 'Scripts', 'aider-install.exe')]); }

function execDecoded(file, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...consoleText.RAW_OUTPUT },
      (err, stdout, stderr) => {
        const output = [consoleText.decode(stdout), consoleText.decode(stderr)].filter(Boolean).join('\n').trim();
        if (err) reject(new Error(output || err.message));
        else resolve(output);
      });
  });
}
async function probeVersion(file) {
  if (!file) return { ok: false, version: '', error: '실행 파일 없음' };
  try { return { ok: true, version: await execDecoded(file, ['--version']), error: '' }; }
  catch (err) { return { ok: false, version: '', error: err.message }; }
}

function cachedRepoIds(value) {
  const rows = Array.isArray(value) ? value : (value && (value.repos || value.items || value.data)) || [];
  return [...new Set(rows.map((row) => row && (row.repo_id || row.repoId || row.id)).filter(Boolean))];
}
async function hfCacheStatus() {
  const bin = hfExecutable();
  if (!bin) return { installed: false, bin: '', models: [], error: 'hf CLI 실행 파일 없음' };
  try {
    const raw = await execDecoded(bin, ['cache', 'list', '--format', 'json'], 30000);
    const parsed = JSON.parse(raw || '[]');
    const models = cachedRepoIds(parsed).filter((id) => /^models--/.test(id) || String(id).includes('/'))
      .map((id) => ({ id: String(id).replace(/^models--/, '').replace(/--/g, '/'), state: 'cached' }));
    return { installed: true, bin, models, error: '' };
  } catch (err) { return { installed: true, bin, models: [], error: err.message }; }
}
async function lmStudioStatus() {
  try {
    const models = (await lmstudio.listModelsDetailed()).filter((m) => ['llm', 'vlm'].includes(m.type) || !m.type);
    return { running: true, url: lmstudio.baseUrl(), models, error: '' };
  } catch (err) { const models=await require('./local-server-control').catalog().catch(()=>[]); return {running:false,url:lmstudio.baseUrl(),models:models.map(m=>({...m,state:'registered'})),error:models.length?'':err.message}; }
}
function modelCatalog(llama, lm, hf) {
  return [
    ...llama.models.map((m) => ({ provider: 'llamacpp', ...m, label: `${m.id} · llama.cpp` })),
    ...lm.models.map((m) => ({ provider: 'lmstudio', id: m.id, state: m.state || 'available', label: `${m.id} · LM Studio` })),
    ...hf.models.map((m) => ({ provider: 'hf-cache', id: m.id, state: 'cached', label: `${m.id} · HF cache → llama.cpp` })),
  ];
}
async function status() {
  const bin = executable();
  const [probe, local, lm, hf] = await Promise.all([probeVersion(bin), runtime.status(), lmStudioStatus(), hfCacheStatus()]);
  const llama = {
    running: local.llama.running, ready: local.llama.ready, url: local.llama.url,
    router: local.llama.router,
    models: [...local.llama.models,...(local.llama.registeredModels||[])].map((m) => ({ id: m.id, label:m.label, state: m.state, failed: m.failed, contextLength:m.contextLength })),
  };
  return {
    installed: probe.ok, bin, installer: installer(), version: probe.version, error: probe.error,
    active: active ? { runId: active.runId, projectDir: active.projectDir, startedAt: active.startedAt } : null, starting,
    llama, lmstudio: lm, hf, control: runtime.llamaControlStatus(), models: modelCatalog(llama, lm, hf),
  };
}

async function projectRoot(value) {
  const root = path.resolve(String(value || '').trim());
  if (!value) throw new Error('프로젝트 폴더를 선택하세요.');
  const stat = await fs.promises.stat(root).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`프로젝트 폴더를 찾지 못했습니다: ${root}`);
  return root;
}
function filesWithin(root, values) {
  return (Array.isArray(values) ? values : []).map((value) => {
    const full = path.resolve(root, String(value || '').trim());
    const rel = path.relative(root, full);
    if (!value || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`프로젝트 밖의 파일은 추가할 수 없습니다: ${value}`);
    return rel;
  });
}
function safeOptions(input) {
  const mode = ['architect', 'code', 'ask'].includes(input.mode) ? input.mode : 'code';
  const provider = ['llamacpp', 'lmstudio', 'hf-cache'].includes(input.provider) ? input.provider : 'llamacpp';
  return {
    prompt: String(input.prompt || '').trim(), model: String(input.model || '').trim(), provider,
    mode, files: input.files, autoCommits: Boolean(input.autoCommits), dryRun: Boolean(input.dryRun),
  };
}
async function commandPlan(input, validateAddresses = true) {
  const bin = executable();
  const probe = await probeVersion(bin);
  if (!probe.ok) throw new Error(`Aider를 실행할 수 없습니다: ${probe.error}`);
  const root = await projectRoot(input.projectDir);
  const options = safeOptions(input);
  if (!options.prompt) throw new Error('작업 지시를 입력하세요.');
  if (validateAddresses) await require('./graph-addresses').validatePrompt(options.prompt, root);
  const state = await status();
  const candidates = state.models.filter((m) => m.provider === options.provider);
  const model = options.model || (candidates[0] && candidates[0].id);
  if (!model) throw new Error(`${options.provider}에서 사용할 모델을 찾지 못했습니다.`);
  if(!options.model)throw new Error('Choose an exact model for automatic local preparation');

  const args = [
    '--model', `openai/${model}`, '--message', options.prompt,
    '--yes-always', '--no-pretty', '--no-fancy-input',
    // Local OpenAI-compatible model ids are normally absent from Aider's metadata.
    // Browser warning pages and capability probes make a valid local run look broken.
    '--no-show-model-warnings', '--no-check-update', '--no-show-release-notes',
    '--no-gitignore', '--no-auto-lint', '--no-auto-test', '--no-suggest-shell-commands',
    options.autoCommits ? '--auto-commits' : '--no-auto-commits',
  ];
  if (options.mode === 'architect') args.push('--architect');
  else if (options.mode === 'ask') args.push('--chat-mode', 'ask');
  else args.push('--edit-format', 'whole');
  try { await execDecoded('git', ['-C', root, 'rev-parse', '--show-toplevel']); }
  catch { args.push('--no-git'); }
  if (options.dryRun) args.push('--dry-run');
  args.push(...filesWithin(root, options.files));
  const shown = args.map((arg) => /\s|["']/u.test(arg) ? JSON.stringify(arg) : arg).join(' ');
  const preparation = options.provider === 'hf-cache' ? `llama.cpp에서 HF 캐시 모델 ${model} 준비 후 실행\n` : '';
  return { bin, root, model, provider: options.provider, args, display: `${preparation}${JSON.stringify(bin)} ${shown}`, options };
}

async function waitForLlamaModel(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await runtime.llamaStatus();
    const loaded = state.models.find(m => m.state === 'loaded');
    if (loaded) return loaded.id;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`llama.cpp 모델 준비가 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다.`);
}
async function prepareConnection(plan,signal) {
  const ready=await require('./model-control').ensure({provider:plan.provider,model:plan.model,signal});
  plan.model=ready.model;plan.args[1]='openai/'+ready.model;
  return require('./local-credential-proxy').open({provider:plan.provider==='lmstudio'?'lmstudio':'llamacpp',model:ready.model,signal});
}
async function start(input) {
  if(require('./model-control').busy())throw new Error('Wait for model preparation or reconcile its uncertain outcome before starting Aider');
  input.signal?.throwIfAborted();
  if (active || starting) throw new Error('이미 실행 중이거나 준비 중인 Aider 작업이 있습니다.');
  starting = true;
  let releaseSlot,connection,spawned=false;
  try {
  releaseSlot=await require('./hardware-optimizer').reserveLocalSlot({signal:input.signal});
  const plan = await commandPlan(input, false);
  connection = await prepareConnection(plan,input.signal);
  await require('./graph-addresses').validatePrompt(plan.options.prompt, plan.root);
  input.signal?.throwIfAborted();
  const runId = `aider-${Date.now().toString(36)}`;
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const child = spawn(plan.bin, plan.args, {
    cwd: plan.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OPENAI_API_BASE: connection.apiBase, OPENAI_API_KEY: connection.apiKey, PYTHONUTF8: '1', NO_COLOR: '1' },
  });
  const state = { runId, child, projectDir: plan.root, startedAt: new Date().toISOString(), log: '' };
  const logFile = path.join(RUNS_DIR, `${runId}.log`);
  const resultFile = path.join(RUNS_DIR, `${runId}.json`);
  active = state;
  require('./shared-todo-queue').ownerActive(`hub-${runId}`, Date.parse(state.startedAt));
  emit('aider:status', { runId, state: 'running', projectDir: plan.root, model: plan.model, provider: plan.provider });
  const append = (stream, chunk, decoder) => {
    const text = decoder.write(chunk);
    state.log = (state.log + text).slice(-MAX_LOG_CHARS);
    emit('aider:log', { runId, stream, text });
  };
  const outDecoder = new StringDecoder('utf8');
  const errDecoder = new StringDecoder('utf8');
  child.stdout.on('data', (chunk) => append('stdout', chunk, outDecoder));
  child.stderr.on('data', (chunk) => append('stderr', chunk, errDecoder));
  state.done = new Promise((resolve) => {
    child.on('error', (err) => {
      const text = `\n${err.message}`;
      state.log = (state.log + text).slice(-MAX_LOG_CHARS);
      emit('aider:log', { runId, stream: 'stderr', text });
    });
    child.on('close', (code, signal) => {
      // close is the one end for exit, spawn failure and cancel (killTree); its time is the owner's end time.
      require('./shared-todo-queue').ownerFinished(`hub-${runId}`, Date.now());
      const tail = outDecoder.end() + errDecoder.end();
      if (tail) state.log = (state.log + tail).slice(-MAX_LOG_CHARS);
      const result = { runId, ok: code === 0, code, signal, output: state.log, elapsedMs: Date.now() - Date.parse(state.startedAt) };
      try {
        fs.writeFileSync(logFile, state.log, 'utf8');
        fs.writeFileSync(`${resultFile}.tmp`, JSON.stringify({ ...result, output: undefined,
          projectDir: plan.root, model: plan.model, provider: plan.provider, finishedAt: new Date().toISOString() }, null, 2), 'utf8');
        fs.renameSync(`${resultFile}.tmp`, resultFile);
      } catch (err) { result.logError = `로그 저장 실패: ${err.message}`; }
      finished.set(runId, result);
      if (finished.size > 10) finished.delete(finished.keys().next().value);
      if (active && active.runId === runId) active = null;
      emit('aider:status', { ...result, state: code === 0 ? 'completed' : 'failed', output: undefined });
      resolve(result);
    });
  });
  spawned=true;
  state.done.finally(()=>{connection.close();releaseSlot();}).catch(()=>{});
  return { runId, projectDir: plan.root, model: plan.model, provider: plan.provider, command: plan.display };
  } finally { starting = false; if(!spawned){connection?.close();releaseSlot?.();} }
}
async function wait(runId) {
  if (active && active.runId === runId) return active.done;
  if (finished.has(runId)) return finished.get(runId);
  throw new Error(`Aider 실행을 찾지 못했습니다: ${runId}`);
}
function result(runId) {
  if (!/^aider-[a-z0-9]+$/.test(runId)) throw new Error('잘못된 Aider 실행 ID입니다.');
  if (active && active.runId === runId) return { runId, state: 'running', output: active.log, projectDir: active.projectDir, startedAt: active.startedAt };
  if (finished.has(runId)) { const value = finished.get(runId); return { ...value, state: value.ok ? 'completed' : 'failed' }; }
  const resultFile = path.join(RUNS_DIR, `${runId}.json`);
  const logFile = path.join(RUNS_DIR, `${runId}.log`);
  if (fs.existsSync(resultFile)) {
    const value = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    const output = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-MAX_LOG_CHARS) : '';
    return { ...value, output, state: value.ok ? 'completed' : 'failed' };
  }
  throw new Error(`Aider 실행을 찾지 못했습니다: ${runId}`);
}
function cancel(runId) {
  if (!active || active.runId !== runId) throw new Error('취소할 Aider 작업이 없습니다.');
  require('./agent-workers').killTree(active.child);
  return { cancelled: true, runId };
}
async function execute(input) { const started = await start(input); return wait(started.runId); }

// commandPlan이 Aider에 넘기는 플래그 전부. 원본 갱신(supply/tool-updates)의 계약 시험이 새 버전의 --help에 이것들이 있는지 본다.
const CLI_FLAGS = ['--model', '--message', '--yes-always', '--no-pretty', '--no-fancy-input', '--no-show-model-warnings', '--no-check-update',
  '--no-show-release-notes', '--no-gitignore', '--no-auto-lint', '--no-auto-test', '--no-suggest-shell-commands', '--auto-commits',
  '--no-auto-commits', '--architect', '--chat-mode', '--edit-format', '--no-git', '--dry-run'];

module.exports = { status, commandPlan, start, wait, result, cancel, execute, setEmitter, RUNS_DIR, CLI_FLAGS, executable,
  isBusy: () => Boolean(active || starting) };
require('./change-signals').registerBusy('aider', module.exports.isBusy);

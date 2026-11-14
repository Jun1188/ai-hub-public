// Local inference runtimes: ComfyUI workflow API and llama.cpp OpenAI API.
// All paths are detected per machine and are never persisted in shared config.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const config = require('./config');
const consoleText = require('./console-text');
const { withTimeout } = require('./promise-timeout');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const COMFY_DESKTOP_DIR = path.join(LOCALAPPDATA, 'Programs', 'Comfy Desktop');
const COMFY_INSTALLS = path.join(APPDATA, 'Comfy Desktop', 'installations.json');
const DEFAULT_LLAMA_REPO = 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M';
const CHARS_PER_TOKEN = 3;
let managedLlama = null;
let llamaStartPending = false;
let lastLlamaError = '';

function llamaControlStatus() {
  return managedLlama ? { managed: true, model: managedLlama.model, pid: managedLlama.child.pid,
    state: managedLlama.state, instanceId: managedLlama.instanceId, error: lastLlamaError } : { managed: false, error: lastLlamaError };
}

async function stopLlama() {
  if (!managedLlama) throw new Error('Hub에서 시작한 서버가 아닙니다. 해당 서버의 실행 창에서 종료하세요.');
  const current = managedLlama;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('llama.cpp 종료 시간 초과')), 10000);
    current.child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (!current.child.kill()) { clearTimeout(timer); reject(new Error('서버 종료 요청 실패')); }
  });
  return { stopped: true, unloaded: true };
}

function cfg() {
  const c = config.load().localRuntimes || {};
  return {
    comfyUrl: c.comfyUrl || 'http://127.0.0.1:8188',
    llamaUrl: c.llamaUrl || 'http://127.0.0.1:8080',
    showInstallActions: c.showInstallActions !== false,
    llamaRepo: c.llamaRepo || DEFAULT_LLAMA_REPO,
  };
}

function comfyInstall() {
  let installs = [];
  try { installs = JSON.parse(fs.readFileSync(COMFY_INSTALLS, 'utf8')); } catch { /* not installed */ }
  const item = require('./comfy-control').pickInstall(installs);
  const desktopExe = path.join(COMFY_DESKTOP_DIR, 'Comfy Desktop.exe');
  const root = item && item.installPath;
  // Comfy Desktop 1.1+ downloads into a shared folder named by base_path in the install's extra-model-paths file, not
  // <install>/ComfyUI/models — counting only the latter reported 0 models with 7 installed (2026-10-17).
  let shared = [];
  if (item) {
    const dir = path.join(APPDATA, 'Comfy Desktop');
    const configs = [path.join(dir, 'instance-model-paths', `${item.id}.yaml`),path.join(dir,'shared_model_paths.yaml')];
    for (const file of configs) {
      try { shared = yamlBasePaths(fs.readFileSync(file,'utf8')); break; }
      catch (err) { if (err.code !== 'ENOENT') break; }
    }
  }
  return {
    installed: fs.existsSync(desktopExe) || Boolean(root),
    desktopExe: fs.existsSync(desktopExe) ? desktopExe : '',
    root: root || '',
    modelRoots: [...(root ? [path.join(root, 'ComfyUI', 'models')] : []), ...shared],
    // The shared folder is is_default, which ComfyUI searches first: a duplicate name resolves to that file.
    searchRoots: [...shared, ...(root ? [path.join(root, 'ComfyUI', 'models')] : [])],
    version: (item && (item.comfyVersionTag || item.version)) || '',
  };
}

const yamlBasePaths = (text) => [...String(text).matchAll(/^\s*base_path:\s*['"]?(.*?)['"]?\s*$/gm)].map((m) => m[1]).filter(Boolean);

async function countModelFiles(roots, maxFiles = 5000) {
  const exts = new Set(['.safetensors', '.gguf', '.ckpt', '.pt', '.pth', '.bin']);
  const stack = [...new Set(roots)].map((r) => [r, r]);
  const deadline = Date.now() + 5000;
  let seen = 0;
  let count = 0;
  let unreadable = 0; // 시간 초과·권한 오류 폴더 — 세지 않으면 "모델 0개"와 "못 읽음"이 같아진다
  const examples = [];
  while (stack.length && seen < maxFiles && Date.now() < deadline) {
    const [dir, modelRoot] = stack.pop();
    let entries = [];
    try {
      entries = await withTimeout(fs.promises.readdir(dir, { withFileTypes: true }), 1000, () => new Error('model scan timeout'));
    } catch (e) { if (e.code !== 'ENOENT') unreadable++; continue; }
    for (const ent of entries) {
      seen++;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push([full, modelRoot]);
      else if (exts.has(path.extname(ent.name).toLowerCase())) {
        count++;
        if (examples.length < 5) examples.push(path.relative(modelRoot, full));
      }
      if (seen >= maxFiles) break;
    }
  }
  return { count, examples, unreadable, truncated: seen >= maxFiles || Date.now() >= deadline };
}

function llamaCandidates() {
  return [
    process.env.LLAMA_CPP_BIN,
    path.join(LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'llama.exe'),
    path.join(LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'llama-server.exe'),
    path.join(os.homedir(), '.llama-app', 'llama.exe'),
    path.join(LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'llama.exe'),
  ].filter(Boolean);
}

function llamaExecutable() {
  return llamaCandidates().find((p) => fs.existsSync(p)) || '';
}

function llamaLauncherConfig() {
  const selected=config.load().localRuntimes||{};
  if(selected.llamaModelPath) {
    const endpoint=new URL(selected.llamaUrl||'http://127.0.0.1:8080');
    return {modelPath:selected.llamaModelPath,credentialConfigured:false,port:Number(endpoint.port)||8080,modelConfigured:true};
  }
  const desktop = path.join(os.homedir(), 'Desktop');
  let files = [];
  try { files = fs.readdirSync(desktop); } catch { /* desktop unavailable */ }
  const name = files.find((f) => /^llama loader.*\.bat$/i.test(f));
  if (!name) return null;
  const launcher = path.join(desktop, name);
  let raw = '';
  try { raw = consoleText.decode(fs.readFileSync(launcher)); } catch { return null; }
  const vars = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*set\s+([A-Z0-9_]+)=(.*)\s*$/i.exec(line);
    if (m) vars[m[1].toUpperCase()] = m[2].trim();
  }
  return {
    launcher,
    modelPath: vars.MODEL_PATH || '',
    credentialConfigured: Boolean(vars.API_KEY),
    port: Number(vars.PORT) || 8080,
    modelConfigured: Boolean(vars.MODEL_PATH),
  };
}

async function pathAccessible(file, timeoutMs = 2000) {
  if (!file) return false;
  try {
    await withTimeout(fs.promises.access(file, fs.constants.R_OK), timeoutMs, () => new Error('path access timeout'));
    return true;
  } catch { return false; }
}

function llamaClientConnection() {
  return {apiBase:cfg().llamaUrl.replace(/\/+$/,'')+'/v1',credentialRef:'credential:llamacpp',provider:'llamacpp'};
}
async function llamaRequest(action,body,timeoutMs=10000) {
  const broker=require('./credential-broker');
  return broker.request({credentialRef:'credential:llamacpp',operationId:'llamacpp.'+action,jobId:broker.jobId('llama'),payload:{body}},{timeoutMs});
}
async function fetchJson(url, options = {}, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, redirect:'error', signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  } finally { clearTimeout(timer); }
}

async function comfyApiStatus(baseUrl) {
  try {
    const [stats, objectInfo] = await Promise.all([
      fetchJson(`${baseUrl}/system_stats`),
      fetchJson(`${baseUrl}/object_info`, {}, 5000),
    ]);
    return {
      running: true,
      stats,
      nodeClasses: Object.keys(objectInfo || {}),
    };
  } catch (err) {
    return { running: false, error: String(err && err.message || err), nodeClasses: [] };
  }
}

async function llamaApiStatus(baseUrl) {
  try {
    const models = await llamaRequest('models',undefined,2500);
    const props = await llamaRequest('props',undefined,2500).catch(() => ({}));
    const list = (Array.isArray(models.data) ? models.data : []).map(m => ({ id: m.id,
      state: m.status?.value || 'loaded', failed: m.status?.failed === true,
      contextLength: m.meta?.n_ctx || props.default_generation_settings?.n_ctx || null }));
    return { running: true, router: props.role === 'router', models: list };
  } catch (err) {
    // stopped: 연결 거절 — 서버가 확실히 꺼져 있다(브로커는 시간 초과가 아닌 ECONNREFUSED·ENOENT에만 transportCode를 붙인다).
    // 시간 초과·503(적재 중)과 구별해 model-control이 결과 표식을 맞춘다.
    return { running: false, stopped: err?.code === 'BROKER_OUTCOME_UNKNOWN' && Boolean(err.transportCode), error: String(err && err.message || err), models: [] };
  }
}

async function status() {
  const c = cfg();
  const install = comfyInstall();
  const [comfyApi, llamaApi] = await Promise.all([
    comfyApiStatus(c.comfyUrl),
    llamaApiStatus(c.llamaUrl),
  ]);
  const comfyModels = await countModelFiles(install.modelRoots);
  const registeredModels=llamaApi.running?[]:(await require('./model-control').catalog('llamacpp').catch(()=>[])).map(({modelPath,mmprojPath,...m})=>({...m,state:'registered'}));
  const llamaBin = llamaExecutable();
  const launcher = llamaLauncherConfig();
  const launcherModelExists = await pathAccessible(launcher && launcher.modelPath);
  return {
    showInstallActions: c.showInstallActions,
    comfy: {
      installed: install.installed,
      version: install.version,
      url: c.comfyUrl,
      ...comfyApi,
      models: comfyModels,
      ready: install.installed && comfyApi.running && comfyModels.count > 0,
      control: require('./comfy-control').status(),
      missing: [
        ...(!install.installed ? ['runtime'] : []),
        ...(!comfyApi.running ? ['server'] : []),
        ...(comfyModels.count === 0 ? [comfyModels.unreadable ? 'model-unreadable' : 'model'] : []),
      ],
    },
    llama: {
      installed: Boolean(llamaBin),
      url: c.llamaUrl,
      repo: c.llamaRepo,
      preparationContract:'hardware-admission/2',automaticPreparation:require('./device-profile').automaticPreparation(),
      registeredModels,
      configuredModel: launcherModelExists,
      configuredModelName: launcher && launcher.modelPath ? path.basename(launcher.modelPath) : '',
      ...llamaApi,
      ready: llamaApi.running && llamaApi.models.some(m => m.state === 'loaded'),
      missing: [
        ...(!llamaBin ? ['runtime'] : []),
        ...(!llamaApi.running ? ['server'] : []),
        ...(!llamaApi.models.length && !launcherModelExists ? ['model'] : []),
      ],
    },
    routing: {
      automaticBackend: 'measured',
      reason: 'offload는 local-model-quality.json에 잰 모델(LM Studio·HF 캐시 GGUF) 중 지금 하드웨어 예산에 들어가는 가장 나은 것을 골라 서버를 띄운다. 잰 모델이 없거나 안 들어가면 LM Studio 어드바이저 경로.',
    },
  };
}

function runCommand(file, args, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...consoleText.RAW_OUTPUT },
      (err, stdout, stderr) => {
        const out = consoleText.decode(stdout);
        const bad = consoleText.decode(stderr);
        if (err) reject(new Error(`${err.message}\n${bad || out}`.trim()));
        else resolve({ ok: true, output: [out, bad].filter(Boolean).join('\n') });
      });
  });
}

async function install(kind) {
  const ids = { comfy: 'Comfy.ComfyUI-Desktop', llama: 'ggml.llamacpp' };
  if (!ids[kind]) throw new Error(`알 수 없는 런타임: ${kind}`);
  return runCommand('winget', [
    'install', '--id', ids[kind], '--exact', '--silent',
    '--accept-package-agreements', '--accept-source-agreements',
  ]);
}

// The GUI button: Comfy Desktop.exe only opens its dashboard and never starts the server, so start the same headless
// server the workflows use (comfy-control picks vramMiB 0: an idle server needs no workflow VRAM). Startup can take
// 3 minutes, so it runs in the background and the reply returns at once (.claude/rules/ipc.md); progress is in
// status().comfy.control.lastStart. Desktop opens only when no ComfyUI instance is installed yet.
async function startComfy() {
  const info = comfyInstall();
  if (info.root) return { runtime: 'comfy', ...require('./comfy-control').startInBackground() };
  if (!info.desktopExe) throw new Error('ComfyUI 설치를 찾지 못했습니다. ComfyUI Desktop을 먼저 설치하세요.');
  const child = spawn(info.desktopExe, [], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { started: false, runtime: 'comfy', desktopOpened: true,
    message: 'ComfyUI 인스턴스 설치를 찾지 못해 Comfy Desktop을 열었습니다. 대시보드에서 설치를 마친 뒤 다시 시작하세요.' };
}
const stopComfy = () => require('./comfy-control').stop();

async function startLlama(repo, options = {}) {
  if (managedLlama || llamaStartPending) throw new Error('먼저 현재 모델을 unload 하세요.');
  llamaStartPending = true;
  try {
  if ((await llamaApiStatus(cfg().llamaUrl)).running) throw new Error('이미 실행 중인 llama.cpp 서버가 있습니다.');
  const bin = llamaExecutable();
  if (!bin) throw new Error('llama.cpp 실행 파일을 찾지 못했습니다. 먼저 설치하세요.');
  const c = cfg();
  const port = Number(new URL(c.llamaUrl).port || 8080);
  const launcher = options.modelPath ? {modelPath:options.modelPath,port,credentialConfigured:false} : llamaLauncherConfig();
  const modelRepo = String(repo || c.llamaRepo || DEFAULT_LLAMA_REPO);
  const useLocalModel = !options.preferRepo && await pathAccessible(launcher && launcher.modelPath);
  if (options.localOnly && !useLocalModel) throw new Error('Configured local GGUF missing; automatic download is disabled');
  const actualPort = useLocalModel ? launcher.port : port;
  const modelArgs = useLocalModel
    ? ['-m', launcher.modelPath]
    : ['-hf', modelRepo];
  modelArgs.push('--host','127.0.0.1');
  if(options.localOnly) {
    const endpoint=new URL(c.llamaUrl);
    if(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))throw new Error('Automatic model load requires loopback');
    modelArgs.push('--ctx-size',String(options.contextLength||4096));
    modelArgs.push('--parallel','1','--offline');
    if(options.modelId)modelArgs.push('--alias',options.modelId);
    if(options.mmprojPath)modelArgs.push('--mmproj',options.mmprojPath);
    if(options.placement==='cpu')modelArgs.push('--gpu-layers','0',...(options.mmprojPath?['--no-mmproj-offload']:[]));
    // 승인이 부분 오프로드까지 GPU로 보낸다(model-admission). 들어가는 층만 올리고 화면·다른 앱 몫은 남긴다.
    if(options.placement==='gpu')modelArgs.push('--fit','on','--fit-target','1024');
    if(options.placement==='moe')modelArgs.push('--cpu-moe','--fit','on','--fit-target','1536','--load-mode','mmap','--flash-attn','on','--jinja');
  }
  const args = path.basename(bin).toLowerCase() === 'llama.exe'
    ? ['serve', ...modelArgs, '--port', String(actualPort)]
    : [...modelArgs, '--port', String(actualPort)];
  const child = spawn(bin, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + consoleText.decode(chunk)).slice(-4000); });
  lastLlamaError = '';
  managedLlama = { child, instanceId: require('crypto').randomUUID(), model: useLocalModel ? path.basename(launcher.modelPath) : modelRepo, state: 'loading' };
  child.once('error', err => {
    lastLlamaError = err.message;
    if (managedLlama?.child === child) managedLlama = null;
  });
  child.once('exit', code => {
    if (code && managedLlama?.child === child) lastLlamaError = `llama.cpp exit ${code}: ${diagnostics}`;
    if (managedLlama?.child === child) managedLlama = null;
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return { started: true, runtime: 'llama', model: useLocalModel ? path.basename(launcher.modelPath) : modelRepo, port: actualPort };
  } finally { llamaStartPending = false; }
}

function llamaStatus() { return llamaApiStatus(cfg().llamaUrl); }
async function configuredLocalLlama() {
  const launcher=llamaLauncherConfig();
  if(!launcher || !llamaExecutable() || !(await pathAccessible(launcher.modelPath)))return null;
  return require('./local-gguf-catalog').describe(launcher.modelPath);
}
async function startConfiguredLocalLlama(options={}) {
  options.signal?.throwIfAborted();
  await startLlama(undefined,{...options,localOnly:true});
  const deadline=options.deadline||Date.now()+120000;
  try {
    while(Date.now()<deadline) {
      options.signal?.throwIfAborted();
      const state=await llamaStatus();
      if(state.running) {
        const target=state.models.find(m=>m.state==='loaded'&&(!options.modelId||options.modelId==='configured-local'||m.id===options.modelId));
        if(target){if(managedLlama)managedLlama.state='loaded';return {model:target.id,state:'loaded'};}
      }
      if(lastLlamaError)throw new Error('Configured llama.cpp failed to start');
      const snap=await require('./resource-monitor').snapshot();
      if(snap.ram.usagePercent>90)throw new Error('Observed RAM pressure exceeded startup budget');
      if((snap.gpu.devices||[]).some(g=>g.totalMiB>0&&g.usedMiB/g.totalMiB>0.97))throw new Error('Observed VRAM pressure exceeded startup budget');
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
    throw new Error('Load outcome unknown; inspect this operation before retry');
  } catch(error) {
    // Stop only this Hub-owned startup. Existing external models are never unloaded.
    if(managedLlama && (options.signal?.aborted || /(?:RAM|VRAM) pressure/.test(error.message)))await stopLlama().catch(()=>{});
    throw error;
  }
}
async function setLlamaModel(model, on) {
  if (typeof model !== 'string' || !model) throw new Error('모델 ID가 필요합니다.');
  const state = await llamaStatus();
  if (state.router) {
    if (!state.models.some(m => m.id === model)) throw new Error('router에 등록되지 않은 모델입니다. 모델 목록을 새로고침하세요.');
    await llamaRequest(on?'load':'unload',{model},120000);
  } else if (on) await startLlama(model, { preferRepo: true });
  else {
    if (managedLlama?.model !== model) throw new Error('외부 단일 모델 서버는 실행한 앱에서 종료하세요.');
    return stopLlama();
  }
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const live = await llamaStatus();
    const target = live.models.find(m => m.id === model) || (!live.router && managedLlama?.model === model ? live.models[0] : null);
    if (target?.failed) throw new Error(`${model} 모델 로딩 실패`);
    if (on && target?.state === 'loaded') {
      if (managedLlama) managedLlama.state = 'loaded';
      return { model, state: 'loaded' };
    }
    if (!on && live.running && (!target || target.state === 'unloaded')) return { model, state: 'unloaded' };
    if (!live.running && !managedLlama) throw new Error(lastLlamaError || 'llama.cpp 서버가 응답하지 않습니다.');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`${model} 상태 변경 시간 초과. 현재 상태를 새로고침하세요.`);
}

async function listModelsDetailed() {
  const c = cfg();
  const api = await llamaApiStatus(c.llamaUrl);
  if (!api.running) { const rows=await require('./model-control').catalog('llamacpp'); return rows.map(({modelPath,mmprojPath,...m})=>({...m,type:'llm',state:'registered',contextLength:null})); }
  return api.models.map((m) => ({
    id: m.id,
    type: 'llm',
    state: m.state,
    contextLength: m.contextLength,
  }));
}

function estimateTokens(text) { return Math.ceil((typeof text === 'number' ? Math.max(0,text) : String(text || '').length) / CHARS_PER_TOKEN); }

async function chatPrepared({ model, messages, temperature, maxTokens, timeoutMs, imagePath, signal }) {
  const c = cfg();
  const list = await listModelsDetailed();
  const requested = model || (list[0] && list[0].id);
  if (!requested) throw new Error('llama.cpp 서버에 로드된 모델이 없습니다.');
  // Exact loaded model only — no substitution or download.
  const info = list.find(m => m.id === requested && !m.failed && (!m.state || m.state === 'loaded'));
  if (!info) throw new Error('Requested model is not loaded; inspect the pipeline preparation operation. No fallback or download.');
  const selected = info.id;
  const promptTokens = estimateTokens(JSON.stringify(messages)) + messages.length * 16;
  const reply = require('./reply-budget');
  if (reply.exceedsContext({contextLength:info.contextLength,promptTokens})) throw new Error('Local prompt exceeds the reply budget; send a smaller task.');
  const budget = reply.planReplyTokens({requested:maxTokens || 1200,contextLength:info.contextLength,promptTokens});
  let bodyMessages = messages;
  if (imagePath) {
    const bytes = await withTimeout(fs.promises.readFile(imagePath), 10000, () => new Error('이미지 읽기 시간 초과'));
    const ext = path.extname(imagePath).slice(1).toLowerCase() || 'png';
    bodyMessages = messages.map((m, i) => i === messages.length - 1
      ? { ...m, content: [{ type: 'text', text: String(m.content) }, { type: 'image_url', image_url: { url: `data:image/${ext};base64,${bytes.toString('base64')}` } }] }
      : m);
  }
  return require('./local-chat-stream').chat({
    url: `${c.llamaUrl.replace(/\/+$/, '')}/v1/chat/completions`, signal,
    fetchFn:(_url,options)=>require('./credential-broker').requestResponse({credentialRef:'credential:llamacpp',operationId:'llamacpp.chat',jobId:require('./credential-broker').jobId('llama-chat'),payload:{body:JSON.parse(options.body)}},{signal:options.signal,timeoutMs:timeoutMs||600000}),
    body: {model:selected,messages:bodyMessages,temperature,max_tokens:budget.tokens},
    timeoutMs: timeoutMs || 600000,
  });
}

async function readJsonFile(file, timeoutMs = 10000) {
  return JSON.parse(await withTimeout(fs.promises.readFile(file, 'utf8'), timeoutMs, () => new Error(`파일 읽기 시간 초과: ${file}`)));
}

function workflowPrompt(doc) {
  if (doc && doc.prompt && typeof doc.prompt === 'object') return doc.prompt;
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) return doc;
  throw new Error('ComfyUI API 형식의 workflow JSON object가 필요합니다.');
}

function comfyPost(baseUrl, route, body) {
  return fetchJson(`${baseUrl}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 5000)
    .catch(() => null);
}

// Only the Hub-started llama.cpp router yields: external servers are never unloaded (startConfiguredLocalLlama), and
// unloading a single-model server would stop the process.
async function yieldLlamaModels({ managed = managedLlama, status = llamaStatus, set = setLlamaModel } = {}) {
  if (!managed) return [];
  const live = await status();
  if (!live.running || !live.router) return [];
  const unloaded = [];
  for (const m of live.models.filter((x) => x.state === 'loaded' && !x.failed)) {
    try { await set(m.id, false); unloaded.push(m.id); } catch { /* 못 내린 모델은 그대로 둔다 */ }
  }
  return unloaded;
}

// Offload routes to llama.cpp only while its model is loaded, so put back what we took instead of waiting for a JIT load.
async function restoreLlamaModels(ids, { set = setLlamaModel } = {}) {
  const failed = [];
  for (const id of ids) { try { await set(id, true); } catch { failed.push(id); } }
  return failed;
}

// UI-format graphs (templates, saved workflows) are converted against the live /object_info; API format passes through.
async function comfyApiPrompt(baseUrl, doc, inputs, nodeClasses, loras = [], loraTarget) {
  const format = require('./comfy-workflow-format');
  let prompt = format.isUiWorkflow(doc) ? format.toApiPrompt(doc, await fetchJson(`${baseUrl}/object_info`, {}, 15000)) : workflowPrompt(doc);
  for (const [nodeId, fields] of Object.entries(inputs || {})) {
    if (!prompt[nodeId] || !prompt[nodeId].inputs) throw new Error(`워크플로 노드가 없습니다: ${nodeId}`);
    Object.assign(prompt[nodeId].inputs, fields);
  }
  prompt = require('./comfy-lora').inject(prompt, loras, loraTarget);
  const required = [...new Set(Object.values(prompt).map((n) => n && n.class_type).filter(Boolean))];
  const missingNodes = required.filter((name) => !nodeClasses.includes(name));
  if (missingNodes.length) {
    const err = new Error(`ComfyUI 커스텀 노드 누락: ${missingNodes.join(', ')}`);
    err.code = 'COMFY_MISSING_NODES';
    err.missingNodes = missingNodes;
    throw err;
  }
  return prompt;
}

async function comfyWorkflow({ workflowFile, inputs, timeoutMs = 600000, signal, vramMiB, loras: requestedLoras, loraTarget }, prepared) {
  const c = cfg();
  if (prepared && new URL(c.comfyUrl).origin !== prepared.endpoint)
    throw Error('확인 이후 ComfyUI 수신처가 변경되었습니다.');
  if (prepared) c.comfyUrl = prepared.endpoint;
  const control = require('./comfy-control');
  const comfyLora = require('./comfy-lora');
  const doc = prepared ? prepared.workflow : await readJsonFile(workflowFile);
  const loras = await comfyLora.resolve(requestedLoras, comfyInstall().searchRoots);
  // Conservative: count whole LoRA files as VRAM (patching casts them to the GPU; lowvram keeps per-layer patches there).
  const loraMiB = Math.ceil(loras.reduce((sum, l) => sum + l.sizeBytes, 0) / 1024 ** 2);
  let api = await comfyApiStatus(c.comfyUrl);
  // A server that is already up is checked before taking the slot, so missing nodes never unload LM Studio models.
  let prompt = api.running ? await comfyApiPrompt(c.comfyUrl, doc, inputs, api.nodeClasses, loras, loraTarget) : null;
  // ComfyUI shares the GPU with LM Studio: without the local-inference slot both load on top of each other and
  // overflow silently (gpufit.js).
  const release = await require('./hardware-optimizer').reserveLocalSlot({ signal });
  const done = control.hold();
  const gpu = { lmStudioUnloaded: [], llamaUnloaded: [], llamaRestoreFailed: [] };
  let id = '', item = null, started = 0, startup = null, loraCheck = null, marker;
  try {
    // An unknown need stays unknown so every idle model still makes room, as before LoRAs.
    const room = await require('./gpufit').unloadIdle({ needMiB: vramMiB > 0 ? vramMiB + loraMiB : vramMiB });
    gpu.lmStudioUnloaded = room.unloaded || [];
    if (!room.fits) gpu.llamaUnloaded = await yieldLlamaModels();
    // Start only after the yield above, so the hardware budget sees the VRAM those models gave back.
    if (!prompt) {
      startup = await control.ensureComfy({ vramMiB: loraMiB ? (vramMiB > 0 ? vramMiB : control.DEFAULT_VRAM_MIB) + loraMiB : vramMiB, signal });
      api = await comfyApiStatus(c.comfyUrl);
      if (!api.running) throw new Error(`ComfyUI API가 응답하지 않습니다: ${api.error || ''}`.trim());
      prompt = await comfyApiPrompt(c.comfyUrl, doc, inputs, api.nodeClasses, loras, loraTarget);
    }
    // /internal/logs is the frontend's route, not a contract: a missing route only skips the check.
    const logs = () => fetchJson(`${c.comfyUrl}/internal/logs/raw`, {}, 5000).then((r) => (Array.isArray(r && r.entries) ? r.entries : null), () => null);
    if (loras.length) marker = await logs().then((entries) => (entries ? comfyLora.logMarker(entries) : undefined));
    const queued = await fetchJson(`${c.comfyUrl}/prompt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: `ai-hub-${Date.now()}` }),
    }, 10000);
    id = queued.prompt_id;
    if (!id) throw new Error(`ComfyUI가 prompt_id를 반환하지 않았습니다: ${JSON.stringify(queued)}`);
    require('./work-table').job('comfy', id, { worker: 'local', state: 'working', summary: `comfy ${path.basename(String(workflowFile))}` });
    // ComfyUI queues the outputs that validate and drops the rest: that read as success with no result (2026-10-18).
    // Throwing here with an id set also dequeues and interrupts the partial run in finally.
    const invalid = Object.entries(queued.node_errors || {});
    if (invalid.length) {
      const detail = invalid.map(([nodeId, e]) => `${e.class_type || ''} ${nodeId}: ${(e.errors || []).map((x) => [x.message, x.details].filter(Boolean).join(': ')).join(', ')}`);
      throw Object.assign(new Error(`ComfyUI 워크플로 검증 실패: ${detail.join('; ')}`), { code: 'COMFY_INVALID_WORKFLOW', nodeErrors: queued.node_errors });
    }
    started = Date.now();
    while (!item && Date.now() - started < timeoutMs) {
      if (signal && signal.aborted) throw signal.reason || new Error('aborted');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const history = await fetchJson(`${c.comfyUrl}/history/${encodeURIComponent(id)}`, {}, 5000);
      if (history[id]) item = history[id];
    }
    if (!item) throw new Error(`ComfyUI 워크플로 시간 초과 (${Math.round(timeoutMs / 1000)}초)`);
    if (item.status && item.status.status_str === 'error') throw new Error(`ComfyUI 실행 실패: ${JSON.stringify(item.status)}`);
    if (loras.length) {
      const entries = marker === undefined ? null : await logs();
      const tensors = loras.every((l) => l.tensors > 0) ? loras.reduce((sum, l) => sum + l.tensors, 0) : null;
      loraCheck = entries ? comfyLora.notLoadedSince(entries, marker, tensors) : { checked: false, reason: 'comfy_log_unavailable' };
    }
  } finally {
    // A prompt we stop waiting for keeps the GPU and /free only acts after it ends, so drop or stop ours first.
    if (id && !item) {
      await comfyPost(c.comfyUrl, '/queue', { delete: [id] });
      await comfyPost(c.comfyUrl, '/interrupt', { prompt_id: id });
    }
    // shortcut: /free only flags the ComfyUI worker, so VRAM may drop shortly after release; poll /system_stats if LM Studio loads collide.
    await comfyPost(c.comfyUrl, '/free', { unload_models: true, free_memory: true });
    // Restore while still holding the slot so the next GPU job cannot start on top of the reload.
    gpu.llamaRestoreFailed = await restoreLlamaModels(gpu.llamaUnloaded);
    done(); // a Hub-started server is stopped after comfyIdleStopMin without workflows
    release();
    if (id) require('./work-table').job('comfy', id, { worker: 'local', state: require('./work-table').ended(item && !(item.status && item.status.status_str === 'error')),
      summary: `comfy ${path.basename(String(workflowFile))}` });
  }
  return { promptId: id, outputs: item.outputs || {}, elapsedMs: Date.now() - started, gpu,
    ...(loras.length ? { loras: loras.map(({ name, strength, sizeBytes }) => ({ name, strength, sizeBytes })), loraCheck } : {}),
    ...(startup && startup.started ? { comfyStarted: { pid: startup.pid, startupMs: startup.startupMs } } : {}) };
}

/**
 * Hold the GPU for an external program such as LoRA training (pipeline shell step with gpuVramMiB): the same slot and yields
 * as comfyWorkflow, so Hub GPU work waits instead of loading on top (rule 13). A Hub-started ComfyUI is stopped because its
 * CUDA context alone keeps VRAM; a Desktop-started one only frees its models. The start waits for the hardware budget.
 */
async function withGpu({ vramMiB, signal }, fn) {
  const control = require('./comfy-control');
  const release = await require('./hardware-optimizer').reserveLocalSlot({ signal });
  let llamaUnloaded = [];
  try {
    const room = await require('./gpufit').unloadIdle({ needMiB: vramMiB });
    if (!room.fits) llamaUnloaded = await yieldLlamaModels();
    await control.stop().catch(() => {});
    await comfyPost(cfg().comfyUrl, '/free', { unload_models: true, free_memory: true });
    const gate = await control.admission(vramMiB, signal);
    if (!gate.admitted) {
      throw Object.assign(new Error(`하드웨어 여유가 없어 GPU 작업을 보류했습니다(${gate.reason}${gate.detail ? ` ${JSON.stringify(gate.detail)}` : ''}).`),
        { code: 'GPU_DEFERRED', reason: gate.reason, detail: gate.detail });
    }
    // A cancel during the yields above found no child to kill yet: never start the program after it.
    if (signal && signal.aborted) throw signal.reason || new Error('aborted');
    return await fn();
  } finally {
    await restoreLlamaModels(llamaUnloaded);
    release();
  }
}

/** comfy_lora_list: LoRA names ComfyUI accepts as lora_name, without folder paths. */
const comfyLoras = () => require('./comfy-lora').list(comfyInstall().searchRoots);

async function chat(args) {
  return require('./hardware-optimizer').withLocalSlot(async()=>{
    if(!args.model)throw new Error('Automatic local preparation requires an explicit model');
    const ready=await require('./model-control').ensure({provider:'llamacpp',model:args.model,signal:args.signal});
    return chatPrepared({...args,model:ready.model});
  },{signal:args.signal});
}
module.exports = {
  configuredLocalLlama, startConfiguredLocalLlama,
  stopLlama, llamaControlStatus, llamaStatus, setLlamaModel,
  status, install, startComfy, stopComfy, startLlama, chat, listModelsDetailed, estimateTokens, yamlBasePaths,
  comfyWorkflow, comfyLoras, withGpu, llamaClientConnection, llamaExecutable, CHARS_PER_TOKEN, DEFAULT_LLAMA_REPO,
  _internals: { yieldLlamaModels, restoreLlamaModels },
};

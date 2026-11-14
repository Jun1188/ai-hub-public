// ComfyUI 서버를 허브가 직접(헤드리스) 띄우고, 허브가 띄운 것만 내린다.
//
// 왜: Comfy Desktop.exe는 대시보드만 열고 서버는 시작하지 않는다(autoLaunchOnStartup 기본 "none").
// 그래서 서버가 꺼져 있으면 comfy_workflow_run이 항상 실패했다(2026-10-18 실측). Desktop과 같은 venv·
// 플래그로 띄우되 Desktop 인스턴스와 동시에 돌리지 않는다 — 둘은 ComfyUI\user\comfyui.db(+.lock)와
// 포트를 공유한다. 경로는 전부 Desktop의 installations.json·settings.json에서 그때 읽는다(규칙 8).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const consoleText = require('./console-text');

const MIB = 1024 ** 2;
// 번들 템플릿(3d_pixal3d_trellis2_image_to_model)의 가장 큰 스테이징 모델 Trellis2가 5320 MB다. 실측 피크
// 약 6.0 GB(2026-10-18, RTX 4060 Ti 8 GB 전체 7164 MiB)는 DynamicVRAM이 남는 만큼 채운 값이라 요구량이 아니다 —
// 피크+예비를 요구하면 데스크톱 앱 1.5 GB만으로 영원히 보류된다. 다른 모델이 VRAM을 쥐고 있을 때만 막는다.
const DEFAULT_VRAM_MIB = 5400;
const POLL_MS = 2000;
const START_TIMEOUT_MS = 180000; // 실측 기동 약 70초, 첫 기동 약 90초
const SETTLE_MS = 15000; // LM Studio를 막 내린 직후에는 VRAM 표본이 몇 초 늦게 따라온다
const SETTLE_POLL_MS = 3000;
const IDLE_STOP_MIN = 10;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function run(file, args, timeoutMs) {
  return new Promise((resolve) => childProcess.execFile(file, args, { timeout: timeoutMs, windowsHide: true, ...consoleText.RAW_OUTPUT },
    (error, stdout, stderr) => resolve({ error, out: consoleText.decode(stdout), err: consoleText.decode(stderr) })));
}

const defaults = {
  fetch: (...args) => fetch(...args),
  spawn: (...args) => childProcess.spawn(...args),
  killTree: async (pid) => {
    const r = await run('taskkill', ['/T', '/F', '/PID', String(pid)], 10000);
    if (r.error) throw new Error(`ComfyUI 종료 실패: ${(r.err || r.out || r.error.message).trim()}`);
  },
  killTreeSync: (pid) => childProcess.spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 5000 }),
  isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } },
  // FILETIME(UTC, 100ns). Desktop의 comfy-procs 기록과 같은 단위다.
  startTime: async (pid) => {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToFileTimeUtc()`], 5000);
    const value = Number(r.out.trim());
    return !r.error && value > 0 ? value : null;
  },
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason || new Error('aborted'));
    const abort = () => { clearTimeout(timer); reject(signal.reason || new Error('aborted')); };
    const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal) signal.addEventListener('abort', abort, { once: true });
  }),
  now: () => Date.now(),
  snapshot: () => require('./resource-monitor').snapshot({ force: true }),
  environment: async () => { const hw = require('./hardware-optimizer'); await hw.refresh(); return hw.status(); },
  policy: () => require('./hardware-optimizer').policy(),
  automaticPreparation: () => require('./device-profile').automaticPreparation(),
  settings: () => require('./config').load().localRuntimes || {},
  desktopDir: () => path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Comfy Desktop'),
  logFile: () => path.join(require('./paths').hubDataDir(), 'comfyui-headless.log'),
};
let deps = { ...defaults };
let owned = null; // { child, pid, startedAt } — 허브가 띄운 서버만
let starting = null; // 동시에 들어온 호출은 한 번의 기동을 같이 기다린다
let holds = 0;
let lastUsedAt = 0;
let idleTimer = null;
let exitHooked = false;

function coded(code, message, extra = {}) { return Object.assign(new Error(message), { code }, extra); }
const isRunning = (child) => child.exitCode === null && child.signalCode === null;
const pickInstall = (list) => (Array.isArray(list) ? list : []).find((x) => x && x.status === 'installed' && x.installPath && x.sourceId !== 'cloud');

function endpoint() {
  const url = new URL(deps.settings().comfyUrl || 'http://127.0.0.1:8188');
  return { base: String(url).replace(/\/+$/, ''), host: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) };
}

async function readJson(file, timeoutMs = 5000) {
  return JSON.parse(await require('./promise-timeout').withTimeout(fs.promises.readFile(file, 'utf8'), timeoutMs, () => new Error(`파일 읽기 시간 초과: ${file}`)));
}
// 없는 파일만 "없음"이다. 깨진 파일을 기본값으로 읽으면 Desktop과 다른 입출력 폴더로 띄우게 된다(규칙 6).
const readOptionalJson = (file) => readJson(file).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
const exists = (file) => fs.promises.access(file).then(() => true, () => false);

async function getJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await deps.fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}
const apiUp = (base) => getJson(`${base}/system_stats`, 2500).then(() => true, () => false);

const splitArgs = (text) => [...String(text || '').matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);

async function launchSpec(port) {
  const dir = deps.desktopDir();
  const install = pickInstall(await readOptionalJson(path.join(dir, 'installations.json')));
  if (!install) throw coded('COMFY_NOT_INSTALLED', 'ComfyUI 설치(Comfy Desktop)를 찾지 못했습니다.');
  const python = path.join(install.installPath, 'ComfyUI', '.venv', 'Scripts', 'python.exe');
  const main = path.join('ComfyUI', 'main.py');
  if (!(await exists(python)) || !(await exists(path.join(install.installPath, main)))) {
    throw coded('COMFY_NOT_INSTALLED', `헤드리스 실행에 필요한 ComfyUI venv를 찾지 못했습니다(설치 형식: ${install.sourceId || '알 수 없음'}).`);
  }
  const settings = (await readOptionalJson(path.join(dir, 'settings.json'))) || {};
  const instancePaths = path.join(dir, 'instance-model-paths', `${install.id}.yaml`);
  const modelPaths = await exists(instancePaths) ? instancePaths : path.join(dir,'shared_model_paths.yaml');
  // Desktop app.log에 남은 실행 줄과 같은 플래그. --port는 Desktop도 충돌 때만 붙인다.
  const args = ['-s', main, '--feature-flag', 'show_signin_button=true', '--enable-assets', ...splitArgs(install.launchArgs)];
  if (await exists(modelPaths)) args.push('--extra-model-paths-config', modelPaths);
  if (settings.inputDir) args.push('--input-directory', settings.inputDir);
  if (settings.outputDir) args.push('--output-directory', settings.outputDir);
  args.push('--listen', '127.0.0.1', '--port', String(port));
  return { python, cwd: install.installPath, args, procFile: path.join(dir, 'comfy-procs', `${install.id}.json`) };
}

async function desktopInstance(procFile) {
  const rec = await readJson(procFile).catch(() => null);
  const pid = Number(rec && rec.childPid);
  if (!rec || rec.stopRequestedAt || !Number.isInteger(pid) || pid <= 0 || !deps.isAlive(pid)) return null;
  // PID는 재사용된다: Desktop이 죽으며 남긴 기록이 남의 프로세스를 가리키면 매번 시간 초과까지 기다리게 된다.
  const recorded = Number(rec.childStartTime);
  if (recorded > 0) {
    const actual = await deps.startTime(pid);
    if (actual && Math.abs(actual - recorded) > 1e7) return null;
  }
  return { pid, port: Number(rec.port) || null };
}

async function waitForApi(base, { deadline, signal, alive }) {
  while (deps.now() < deadline) {
    if (await apiUp(base)) return 'up';
    if (!alive()) return 'exited';
    await deps.sleep(POLL_MS, signal);
  }
  return (await apiUp(base)) ? 'up' : 'timeout';
}

// model-admission.js와 같은 정책 값·예비량 공식을 쓴다. 판정 대상만 "모델 하나"가 아니라 ComfyUI 서버다.
function admit({ snapshot, environment, policy = {}, vramMiB, now }) {
  const adm = policy.admission || {}, ram = policy.ram || {}, vram = policy.vram || {};
  const defer = (reason, detail = null) => ({ admitted: false, reason, detail });
  if (!snapshot || !Number.isFinite(snapshot.sampledAt) || now - snapshot.sampledAt > 10000) return defer('resource_sample_stale');
  if ((adm.requireAcPowerForLocal ?? adm.requireAcPower) !== false && environment && environment.onAcPower === false) return defer('on_battery');
  const total = snapshot.ram && snapshot.ram.totalBytes, used = snapshot.ram && snapshot.ram.usedBytes;
  if (!(total > 0) || !Number.isFinite(used)) return defer('ram_sample_unavailable');
  const cap = Math.min(0.9, Number(ram.maxUsedFraction) || 0.9);
  if (used / total >= cap) return defer('ram_pressure', { usedPercent: Math.round(100 * used / total), capPercent: Math.round(100 * cap) });
  const devices = ((snapshot.gpu && snapshot.gpu.devices) || []).filter((d) => d.totalMiB > 0 && Number.isFinite(d.usedMiB));
  const gpu = devices.sort((a, b) => (b.totalMiB - b.usedMiB) - (a.totalMiB - a.usedMiB))[0];
  if (vramMiB > 0) {
    if (!gpu) return defer('vram_unmeasured'); // 못 잰 VRAM을 여유로 읽지 않는다
    const reserveMiB = Math.ceil(Math.max(768, (Number(vram.reserveBytes) || 0) / MIB, (Number(vram.reserveFraction) || 0.08) * gpu.totalMiB));
    const freeMiB = gpu.totalMiB - gpu.usedMiB;
    if (freeMiB < vramMiB + reserveMiB) return defer('vram_insufficient', { freeMiB, needMiB: vramMiB, reserveMiB });
  }
  // NVML usagePercent는 배경화면·OBS만으로 36–45%라 쓰지 않는다. busyPercent가 없으면 판단을 미룬다(중립).
  const gatePercent = 100 * (adm.maxGpuUtilForBackground ?? adm.maxGpuUtilBackground ?? 0.35);
  if (gpu && Number.isFinite(gpu.busyPercent) && gpu.busyPercent > gatePercent) return defer('gpu_busy', { busyPercent: gpu.busyPercent, gatePercent });
  return { admitted: true, reason: 'fits', detail: null };
}

async function admission(vramMiB, signal) {
  const until = deps.now() + SETTLE_MS;
  const environment = await deps.environment().catch(() => null);
  for (;;) {
    const snapshot = await deps.snapshot().catch(() => null);
    const gate = admit({ snapshot, environment, policy: deps.policy(), vramMiB, now: deps.now() });
    if (gate.admitted || deps.now() >= until) return gate;
    await deps.sleep(SETTLE_POLL_MS, signal);
  }
}

async function logTail(file) {
  try { return consoleText.decode(await fs.promises.readFile(file)).slice(-1500).trim(); } catch { return ''; }
}

function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  // 비분리 자식은 허브와 함께 죽지만 venv python.exe는 실제 인터프리터를 자식으로 띄우는 런처라
  // 트리 전체가 내려간다고 보장할 수 없다.
  process.once('exit', () => { if (owned && isRunning(owned.child)) { try { deps.killTreeSync(owned.pid); } catch { /* 종료 중 */ } } });
}

async function spawnServer(spec, logFile) {
  const log = await fs.promises.open(logFile, 'w');
  try {
    const child = deps.spawn(spec.python, spec.args, { cwd: spec.cwd, stdio: ['ignore', log.fd, log.fd], windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONFAULTHANDLER: '1', PYTHONUNBUFFERED: '1' } });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    return child;
  } finally { await log.close().catch(() => {}); }
}

async function start(ep, { vramMiB, signal, timeoutMs, manual }) {
  if (!LOOPBACK.has(ep.host)) throw coded('COMFY_REMOTE', `원격 ComfyUI 주소(${ep.host})는 허브가 시작하지 않습니다.`);
  const spec = await launchSpec(ep.port);
  const desktop = await desktopInstance(spec.procFile);
  if (desktop) {
    if (desktop.port && desktop.port !== ep.port) {
      throw coded('COMFY_DESKTOP_RUNNING', `Comfy Desktop이 같은 설치를 포트 ${desktop.port}에서 실행 중입니다. localRuntimes.comfyUrl을 그 포트로 맞추세요.`);
    }
    const begun = deps.now();
    const state = await waitForApi(ep.base, { deadline: begun + timeoutMs, signal, alive: () => deps.isAlive(desktop.pid) });
    if (state === 'up') return { started: false, desktop: true, waitedMs: deps.now() - begun };
    if (state === 'timeout') throw coded('COMFY_START_TIMEOUT', 'Comfy Desktop이 띄운 ComfyUI가 시간 안에 응답하지 않았습니다.');
    // exited: Desktop 서버가 기동 중에 죽었으면 아래에서 직접 띄운다.
  }
  if (!manual && !deps.automaticPreparation()) {
    throw coded('COMFY_AUTO_START_DISABLED', '이 기기는 로컬 자동 준비가 꺼져 있어 ComfyUI를 자동으로 시작하지 않습니다. ComfyUI를 직접 시작한 뒤 다시 실행하세요.');
  }
  const gate = await admission(vramMiB, signal);
  if (!gate.admitted) {
    throw coded('COMFY_DEFERRED', `하드웨어 여유가 없어 ComfyUI 시작을 보류했습니다(${gate.reason}${gate.detail ? ` ${JSON.stringify(gate.detail)}` : ''}).`,
      { reason: gate.reason, detail: gate.detail });
  }
  const logFile = deps.logFile();
  const child = await spawnServer(spec, logFile);
  // 사용자가 버튼으로 띄운 서버는 브라우저에서 편집할 수 있다. 편집은 큐에 안 잡혀 유휴로 보이므로 자동 종료하지 않는다.
  const mine = { child, pid: child.pid, startedAt: deps.now(), manual: Boolean(manual) };
  owned = mine;
  child.once('exit', () => { if (owned === mine) { owned = null; clearIdle(); } });
  hookExit();
  let state;
  try {
    state = await waitForApi(ep.base, { deadline: mine.startedAt + timeoutMs, signal, alive: () => isRunning(child) });
  } catch (err) { await stop().catch(() => {}); throw err; } // 취소: 우리가 띄운 기동만 거둔다
  if (state !== 'up') {
    if (state === 'timeout') await stop().catch(() => {});
    const tail = await logTail(logFile);
    throw coded(state === 'timeout' ? 'COMFY_START_TIMEOUT' : 'COMFY_START_FAILED',
      `${state === 'timeout' ? `ComfyUI가 ${Math.round(timeoutMs / 1000)}초 안에 응답하지 않아 종료했습니다` : 'ComfyUI가 기동 중에 종료됐습니다'} (로그: ${logFile})${tail ? `\n${tail}` : ''}`);
  }
  lastUsedAt = deps.now();
  armIdle();
  return { started: true, pid: mine.pid, startupMs: deps.now() - mine.startedAt, logFile };
}

/** API가 떠 있으면 그대로, 아니면 하드웨어 예산 안에서 헤드리스로 띄운다. manual은 사용자가 누른 시작 버튼. */
async function ensureComfy({ vramMiB = DEFAULT_VRAM_MIB, signal, timeoutMs = START_TIMEOUT_MS, manual = false } = {}) {
  const ep = endpoint();
  if (await apiUp(ep.base)) return { started: false };
  if (!starting) starting = start(ep, { vramMiB, signal, timeoutMs, manual }).finally(() => { starting = null; });
  return starting;
}

/** 허브가 띄운 서버만 프로세스 트리째 내린다. */
async function stop() {
  const current = owned;
  if (!current || !isRunning(current.child)) return { stopped: false, reason: 'not_owned' };
  clearIdle();
  // 자식 핸들을 쥐고 있는 동안 Windows는 이 PID를 재사용하지 않는다 — 살아 있으면 우리가 띄운 그 프로세스다.
  const exited = new Promise((resolve) => current.child.once('exit', resolve));
  await deps.killTree(current.pid);
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10000).unref())]);
  if (owned === current) owned = null;
  return { stopped: true, pid: current.pid, ranMs: deps.now() - current.startedAt };
}

function idleLimitMs() {
  const minutes = Number(deps.settings().comfyIdleStopMin);
  return (Number.isFinite(minutes) ? minutes : IDLE_STOP_MIN) * 60000; // 0 이하 = 자동 종료 안 함
}
function clearIdle() { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; }
function armIdle(delayMs = idleLimitMs()) {
  clearIdle();
  if (holds || !owned || owned.manual || !isRunning(owned.child) || !(idleLimitMs() > 0)) return;
  idleTimer = setTimeout(() => { stopIfIdle().catch(() => {}); }, Math.max(1000, delayMs));
  if (idleTimer.unref) idleTimer.unref();
}

/** 워크플로가 도는 동안 유휴 종료를 막는다. 돌려받은 함수를 끝날 때 부른다. */
function hold() {
  holds += 1;
  clearIdle();
  let released = false;
  return () => { if (released) return; released = true; holds = Math.max(0, holds - 1); lastUsedAt = deps.now(); armIdle(); };
}

async function stopIfIdle() {
  const limit = idleLimitMs();
  if (holds || !owned || owned.manual || !isRunning(owned.child) || !(limit > 0)) return { stopped: false, reason: 'not_idle_or_not_owned' };
  const idle = deps.now() - lastUsedAt;
  if (idle < limit) { armIdle(limit - idle); return { stopped: false, reason: 'recently_used' }; }
  // 브라우저에서 직접 넣은 작업은 hold()를 거치지 않는다: 큐가 빌 때까지 미룬다.
  const queue = await getJson(`${endpoint().base}/queue`, 5000).catch(() => null);
  if (queue && ((queue.queue_running || []).length || (queue.queue_pending || []).length)) {
    lastUsedAt = deps.now();
    armIdle(limit);
    return { stopped: false, reason: 'queue_active' };
  }
  return stop();
}

function owner() { return owned && isRunning(owned.child) ? { pid: owned.pid, startedAt: owned.startedAt, holds, manual: owned.manual } : null; }

// GUI 버튼용: 기동은 최대 3분이라 IPC 응답을 붙잡지 않는다(.claude/rules/ipc.md). 결과는 status()의 lastStart로 본다.
let lastStart = null;
function startInBackground() {
  // ensureComfy는 API 확인을 await한 뒤에야 starting을 잡으므로, 연속 클릭은 여기서 동기적으로 막는다.
  if (starting || (lastStart && lastStart.state === 'starting')) return { pending: true };
  const at = deps.now();
  lastStart = { state: 'starting', at };
  ensureComfy({ manual: true, vramMiB: 0 })
    .then((r) => { lastStart = { state: 'up', at, started: Boolean(r.started), startupMs: r.startupMs || null }; })
    .catch((e) => { lastStart = { state: 'failed', at, code: e.code || null, error: String(e.message || e).slice(0, 400) }; });
  return { pending: true };
}
const status = () => ({ owner: owner(), lastStart });

module.exports = {
  ensureComfy, stop, stopIfIdle, hold, owner, startInBackground, status, pickInstall, admission, DEFAULT_VRAM_MIB,
  _internals: {
    admit, launchSpec, splitArgs,
    setDeps: (overrides) => { deps = { ...deps, ...overrides }; },
    reset: () => { clearIdle(); deps = { ...defaults }; owned = null; starting = null; holds = 0; lastUsedAt = 0; lastStart = null; },
  },
};

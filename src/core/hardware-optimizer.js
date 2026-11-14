// AI Hub ↔ 공유 하드웨어 어드바이저(hardware-advisor.js) 어댑터.
//
// 왜: 이 Hub의 자원 측정(resource-monitor·gpufit)은 화면 표시와 모델 로드 직전 검사에만
// 쓰였고, offload 수용·배경 작업·동시 실행은 하드웨어 상태를 보지 않았다. 실측(2026-07,
// RTX 5060 Laptop 8GB): VRAM을 넘는 12~14B 모델 위임 EMA가 100~183초였다. 같은 PC에서
// VRAM에 다 들어가는 7~8B는 수 초대다. 측정을 결정에 연결한다.
//
// 원칙: 뜨거운 경로(offload 판단·autopilot)는 캐시만 읽는다(gpufit.js와 같은 규칙).
// 전원·실행 앱·모델 카탈로그는 비동기 갱신으로 채우며 타임아웃과 회로 차단 뒤에서만 부른다.
// 모르는 값은 중립이다 — 모른다는 이유로 막거나 순위를 바꾸지 않는다.
'use strict';

const { execFile } = require('child_process');
const advisor = require('./hardware-advisor');
const DEFAULT_POLICY = require('./routing-policy.default.json');

const MIB = 1024 * 1024;
const REFRESH_MS = 60000;
const EXEC_TIMEOUT_MS = 5000;
const BREAKER_TRIP_AFTER = 3;
const BREAKER_RESET_MS = 10 * 60 * 1000;

const env = { at: 0, onAcPower: null, heavyApps: [], failures: 0, retryAt: 0 };
let catalog = { at: 0, models: [] };
let refreshing = null;

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(base, extra) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(extra)) return out;
  for (const [k, v] of Object.entries(extra)) out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}

/** 공유 기본 정책 + 이 PC 전용 덮어쓰기(config.local.json의 hardware.policyOverrides). */
function policy() {
  let overrides = null;
  try { overrides = (require('./config').load().hardware || {}).policyOverrides; } catch { /* 기본값 사용 */ }
  return deepMerge(DEFAULT_POLICY, overrides || {});
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : String(stdout || ''));
    });
  });
}

async function probePower() {
  if (process.platform !== 'win32') return null;
  try {
    // Electron 주 프로세스면 OS 이벤트 기반 값을 쓴다(프로세스 생성 없음).
    if (process.versions.electron) {
      const { powerMonitor } = require('electron');
      if (powerMonitor && typeof powerMonitor.isOnBatteryPower === 'function') return !powerMonitor.isOnBatteryPower();
    }
  } catch { /* stdio 프로세스: 아래 조회로 */ }
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$b=Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue; if($null -eq $b){"none"}else{($b|Select-Object -First 1).BatteryStatus}']);
  if (out == null) return undefined;
  const text = out.trim();
  if (text === 'none') return true; // 배터리 없는 데스크톱은 상시 AC다.
  const status = Number(text);
  if (!Number.isFinite(status)) return undefined;
  return status !== 1; // Win32_Battery.BatteryStatus 1 = 방전 중(배터리 사용)
}

// 이름만으로는 부족하다: Unity CLI 데몬과 Unity 에디터가 둘 다 unity.exe다(2026-10 실측,
// 32MB CLI가 에디터로 판정돼 GPU가 막혔다). 정확한 이름 + 메모리 하한으로 판정한다.
async function probeHeavyApps(patterns, minBytes) {
  if (process.platform !== 'win32' || !patterns.length) return [];
  const out = await run('tasklist.exe', ['/FO', 'CSV', '/NH']);
  if (out == null) return undefined;
  const wanted = new Set(patterns.map((p) => String(p).toLowerCase()));
  const found = new Set();
  for (const line of out.split(/\r?\n/)) {
    const cols = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (cols.length < 5) continue;
    const name = cols[0].replace(/\.exe$/i, '');
    const bytes = Number(cols[4].replace(/\D/g, '') || 0) * 1024;
    if (wanted.has(name.toLowerCase()) && bytes >= minBytes) found.add(name);
  }
  return [...found].sort();
}

async function refreshCatalog() {
  try {
    // 모델 목록 실패는 아래 catch로 보내 이전 값을 지킨다. 전에는 빈 목록으로 덮어써, 느린 LM Studio 응답 한 번에
    // 후보가 0개가 되어 offload가 local_not_viable로 거절됐다.
    const [v1, v0] = await Promise.all([
      require('./model-control').catalog('lmstudio'),
      require('./lmstudio').listModelsDetailed().catch(() => []),
    ]);
    const typeOf = new Map(v0.map((m) => [m.id, m.type]));
    catalog = {
      at: Date.now(),
      models: v1.filter((m) => m && m.id).map((m) => {
        const t = typeOf.get(m.id) || '';
        return { key: m.id, type: /embed/.test(t) ? 'embedding' : 'llm', vision: t === 'vlm', sizeBytes: m.sizeBytes || 0, maxContext: m.maxContext || null };
      }),
    };
  } catch { /* 카탈로그를 못 읽으면 이전 값을 유지한다 */ }
}

/** 비동기 갱신. 동시에 여러 번 불려도 한 번만 돈다. */
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const pol = policy();
    if (Date.now() >= env.retryAt) {
      const adm = pol.admission || {};
      const [power, heavy] = await Promise.all([probePower(), probeHeavyApps(adm.heavyApps || [], Number(adm.heavyAppMinBytes) || 0)]);
      const failed = power === undefined || heavy === undefined;
      env.failures = failed ? env.failures + 1 : 0;
      if (env.failures >= BREAKER_TRIP_AFTER) { env.retryAt = Date.now() + BREAKER_RESET_MS; env.failures = 0; }
      if (power !== undefined) env.onAcPower = power;
      if (heavy !== undefined) env.heavyApps = heavy;
      env.at = Date.now();
    }
    await refreshCatalog();
    try { await require('./resource-monitor').snapshot(); } catch { /* 측정 실패는 미상으로 둔다 */ }
  })();
  try { return await refreshing; } finally { refreshing = null; }
}

/** 오래됐으면 백그라운드 갱신만 건다. 절대 기다리지 않는다. */
function kick() {
  const stale = Date.now() - Math.min(env.at || 0, catalog.at || 0) > REFRESH_MS;
  if (stale && !refreshing) setImmediate(() => { refresh().catch(() => {}); });
}

function machine(snap) {
  const gpus = snap && snap.gpu && snap.gpu.available
    ? (snap.gpu.devices || []).map((d) => ({ name: d.name, vramBytes: (d.totalMiB || 0) * MIB }))
    : [];
  return { ramBytes: snap && snap.ram ? snap.ram.totalBytes : 0, gpus };
}

function resources(snap) {
  const out = { onAcPower: env.onAcPower, heavyApps: env.heavyApps.slice() };
  if (snap && snap.ram) { out.ramTotalBytes = snap.ram.totalBytes; out.ramUsedBytes = snap.ram.usedBytes; }
  if (snap && snap.cpu && snap.cpu.usagePercent != null) out.cpuUtil = snap.cpu.usagePercent / 100;
  const devices = snap && snap.gpu && snap.gpu.available ? (snap.gpu.devices || []) : [];
  const gpu = devices.filter((d) => d.totalMiB > 0).sort((a, b) => b.totalMiB - a.totalMiB)[0];
  if (gpu) {
    // model-admission과 같은 값을 본다: busyPercent는 배경화면·dwm·Hub 작업을 뺀 사용률이다. nvidia usagePercent는
    // 배경화면 엔진 하나로 36~45%라 35% 문턱을 늘 넘어 배경 작업이 모두 gpu-busy로 보류됐다(2026-10-18 이 PC).
    const busy = Number.isFinite(gpu.busyPercent) ? gpu.busyPercent : gpu.usagePercent;
    out.gpu = { vramTotalBytes: gpu.totalMiB * MIB, vramUsedBytes: gpu.usedMiB == null ? null : gpu.usedMiB * MIB,
      util: busy == null ? null : busy / 100 };
  }
  try {
    const assessed = require('./gpufit').lastAssessment();
    out.loadedModels = (assessed.models || []).map((m) => ({ key: m.id }));
  } catch { out.loadedModels = []; }
  return out;
}

/** 오래되거나 표본이 적은 지연 통계는 넘기지 않는다(고착된 판단 방지). */
function freshStats(pol) {
  const li = pol.localInference || {};
  const minSamples = Number(li.statsMinSamples) || 3;
  const maxAgeMs = (Number(li.statsStaleDays) || 30) * 86400000;
  let models = {};
  try { models = require('./stats').models(); } catch { return {}; }
  const out = {};
  for (const [key, s] of Object.entries(models || {})) {
    const at = Date.parse(s && s.lastUsed);
    if (s && s.count >= minSamples && Number.isFinite(at) && Date.now() - at <= maxAgeMs) out[key] = s;
  }
  return out;
}

function snapshotPeek() {
  try { return require('./resource-monitor').peek(); } catch { return null; }
}

// 캐시는 주 프로세스의 주기 점검(main.js verifyGpuFit)과 offload·autopilot 판단이 채운다.
function input(extra, { kickRefresh = true } = {}) {
  if (kickRefresh && process.env.AIHUB_HW_REFRESH !== '0') kick();
  const pol = policy();
  const snap = snapshotPeek();
  return Object.assign({ policy: pol, machine: machine(snap), resources: resources(snap), models: catalog.models, stats: freshStats(pol) }, extra);
}

function advise(task) { return advisor.advise(input({ task })); }

/** 배경 작업을 지금 로컬에서 돌려도 되는가(전원·무거운 앱·GPU/CPU 바쁨). 캐시만 읽는다. */
function backgroundAdmission() {
  const i = input({});
  return advisor.admission({ interactive: false }, advisor.normalizeResources(i.resources, i.machine), i.policy);
}

// ---- 프로세스 전역 로컬 추론 슬롯 ------------------------------------------
// 호출자마다 따로 직렬화하면 같은 GPU에 동시에 들어간다. 처리량은 그대로인데
// n_ctx 재처리·모델 스왑으로 지연만 커진다 — 프로세스 전역 슬롯 하나로 묶는다.
const slot = { active: 0, queue: [] };

function maxConcurrent() { return 1; } // Cross-process single inference lease; per-GPU parallel reservations are not verified yet.

function acquire(signal) {
  if (signal && signal.aborted) return Promise.reject(signal.reason || new Error('aborted'));
  if (slot.active < maxConcurrent()) { slot.active += 1; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    slot.queue.push(waiter);
    if (signal) {
      signal.addEventListener('abort', () => {
        const i = slot.queue.indexOf(waiter);
        if (i >= 0) { slot.queue.splice(i, 1); reject(signal.reason || new Error('aborted')); }
      }, { once: true });
    }
  });
}

function release() {
  const next = slot.queue.shift();
  if (next) next.resolve(); else slot.active = Math.max(0, slot.active - 1);
}

/** fn을 로컬 추론 슬롯 안에서 실행한다. 대기 시간은 호출자의 추론 시간에 넣지 않는다. */
async function reserveLocalSlot({signal}={}) {
  await require('./change-signals').waitGate('local-inference',{signal}); // 거버너가 페이징·VRAM 넘침 중이라고 본 동안만
  await acquire(signal);
  let lease;
  try{lease=await require('./local-inference-lease').acquire(signal);}
  catch(error){release();throw error;}
  let released=false;
  require('./model-lifecycle').instance().touch();
  return ()=>{if(released)return;released=true;require('./model-lifecycle').instance().touch();try{lease();}finally{release();}};
}
async function withLocalSlot(fn,{signal}={}) {
  const done=await reserveLocalSlot({signal});
  try{return await fn();}finally{done();}
}

function slotState() { return { active: slot.active, waiting: slot.queue.length, maxConcurrent: maxConcurrent() }; }

/** 패널 하드웨어 탭용 현재 값. 캐시만 읽는다(오래됐으면 갱신만 건다). */
function status() {
  const i = input({});
  return { at: env.at || null, failures:env.failures,retryAt:env.retryAt, onAcPower: env.onAcPower, heavyApps: env.heavyApps.slice(), machine: i.machine,
    resources: i.resources, models: i.models.slice(), slot: slotState(), policy: i.policy };
}

module.exports = {
  policy, refresh, kick, advise, backgroundAdmission, reserveLocalSlot, withLocalSlot, slotState, status,
  _internals: { env, setCatalog: (models) => { catalog = { at: Date.now(), models }; }, resources, machine, deepMerge, slot },
};

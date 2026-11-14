// Autopilot: Claude-Code-style background work, restricted to SAFE tasks —
// jobs that only touch the hub's own local data and never run shell commands,
// builds, or downstream tools. Runs inside the GUI/tray process while the app
// is alive.
//
// Safe job catalog:
//   memoryConsolidate  merge near-duplicate memories            (6h cadence)
//   safePipelines      run pipelines marked auto:{enabled} IF every step is a
//                      safe type (ai/source-index/finetune-gen) —
//                      shell/msbuild/unity-batch/uat/mcp-tool never auto-run
'use strict';

const fs = require('fs');
const path = require('path');
const { hubDataDir } = require('./paths');
const config = require('./config');

const STATE_FILE = path.join(hubDataDir(), 'autopilot-state.json');
const LOG_FILE = path.join(hubDataDir(), 'autopilot.log');
const TICK_MS = 5 * 60 * 1000;

/** step types that cannot touch anything outside the hub's own data + LM Studio */
const SAFE_STEP_TYPES = ['ai', 'source-index', 'finetune-gen'];

const CADENCE_MS = {
  memoryConsolidate: 6 * 3600 * 1000,
};

let timer = null;
let ticking = false;
const activity = []; // ring buffer of recent actions, newest first

function log(job, message) {
  const entry = { ts: new Date().toISOString(), job, message: String(message).slice(0, 300) };
  activity.unshift(entry);
  if (activity.length > 50) activity.pop();
  try { fs.appendFileSync(LOG_FILE, `${entry.ts} [${job}] ${entry.message}\n`, 'utf8'); } catch { /* best-effort */ }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { lastRun: {} }; }
}

function writeState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

function due(state, key, cadenceMs) {
  const last = state.lastRun[key] || 0;
  return Date.now() - last >= cadenceMs;
}

function isSafePipeline(p) {
  return !p.graph && Array.isArray(p.steps) && p.steps.length > 0 && p.steps.every((s) => SAFE_STEP_TYPES.includes(s.type));
}

// ---- jobs ----------------------------------------------------------------

async function jobMemoryConsolidate() {
  const memory = require('./memory');
  const r = memory.consolidate();
  if (r.removedCount > 0) log('메모리 정리', `중복 메모리 ${r.removedCount}개 통합`);
  return r.removedCount;
}

async function jobSafePipelines(state) {
  const pipeline = require('./pipeline');
  let started = 0;
  for (const p of pipeline.list()) {
    if (!p.auto || !p.auto.enabled) continue;
    if (!isSafePipeline(p)) {
      log('자동 파이프라인', `"${p.name}" 건너뜀 — 안전하지 않은 스텝 포함 (${p.steps.map((s) => s.type).join(', ')})`);
      continue;
    }
    const intervalMs = Math.max(60, Number(p.auto.intervalMin) || 1440) * 60 * 1000;
    const key = `pipeline:${p.id}`;
    if (!due(state, key, intervalMs)) continue;
    // never stack runs of the same pipeline
    const lastRun = pipeline.history(p.id)[0];
    if (lastRun && lastRun.status === 'running') continue;
    try {
      const { runId } = pipeline.start(p.id);
      state.lastRun[key] = Date.now();
      started++;
      log('자동 파이프라인', `"${p.name}" 실행 시작 (${runId.slice(0, 8)})`);
    } catch (e) {
      log('자동 파이프라인', `"${p.name}" 실패: ${e.message}`);
    }
  }
  return started;
}

// ---- worker loop ---------------------------------------------------------

// 배경 AI 작업은 이 PC가 여유 있을 때만 돈다. 노트북 배터리 사용 중, 게임 편집기 같은 무거운
// 앱 실행 중, GPU/CPU가 바쁠 때는 보류한다(hardware-optimizer.backgroundAdmission, 캐시만 읽음).
// 측정 전이면 막지 않는다. 같은 사유는 한 번만 기록한다.
let lastHold = '';
function hardwareHold() {
  try {
    const a = require('./hardware-optimizer').backgroundAdmission();
    const blocking = a.reasons.filter((r) => !a.localAllowed || r.startsWith('heavy-app') || r === 'gpu-busy');
    const hold = !a.localAllowed || blocking.length ? (blocking.join(', ') || 'local-not-allowed') : '';
    if (hold && hold !== lastHold) log('하드웨어', `배경 AI 작업 보류: ${hold}`);
    lastHold = hold;
    return hold;
  } catch {
    return '';
  }
}

async function tick(force = false) {
  if (ticking) return { skipped: 'already running' };
  const cfg = config.load().autopilot || {};
  if (!cfg.enabled && !force) return { skipped: 'disabled' };
  ticking = true;
  try {
    const state = readState();
    const jobs = cfg.jobs || {};
    const lmstudio = require('./lmstudio');
    const aiAlive = (await lmstudio.isAlive()) && !hardwareHold();

    if ((jobs.memoryConsolidate !== false) && (force || due(state, 'memoryConsolidate', CADENCE_MS.memoryConsolidate))) {
      try { await jobMemoryConsolidate(); } catch (e) { log('메모리 정리', '실패: ' + e.message); }
      state.lastRun.memoryConsolidate = Date.now();
    }
    if ((jobs.safePipelines !== false) && aiAlive) {
      try { await jobSafePipelines(state); } catch (e) { log('자동 파이프라인', '실패: ' + e.message); }
    }

    state.lastTick = Date.now();
    writeState(state);
    return { ok: true };
  } finally {
    ticking = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  // first pass shortly after launch so 사용자가 켠 직후 바로 동작을 볼 수 있음
  setTimeout(() => { tick().catch(() => {}); }, 20000);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function status() {
  const cfg = config.load().autopilot || {};
  const state = readState();
  return {
    enabled: Boolean(cfg.enabled),
    jobs: {
      memoryConsolidate: cfg.jobs ? cfg.jobs.memoryConsolidate !== false : true,
      safePipelines: cfg.jobs ? cfg.jobs.safePipelines !== false : true,
    },
    lastTick: state.lastTick || null,
    lastRun: state.lastRun || {},
    activity: activity.slice(0, 30),
    safeStepTypes: SAFE_STEP_TYPES,
  };
}

module.exports = { start, stop, tick, status, isSafePipeline, SAFE_STEP_TYPES };

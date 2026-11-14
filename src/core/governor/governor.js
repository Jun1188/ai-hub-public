// 자원 거버너(1/3): 자원 기록·디버깅 진단과 Hub 내부 상태(작업 큐·슬롯·버스)를 들여다보고(data snooping)
// 앱 작업을 조절한다. 쓰는 지렛대는 이미 검증된 것뿐이다: 로컬 추론 입장 관문(대기, 상한 있음)과
// gpufit.unloadIdle(노는 모델만 내림, LM Studio가 JIT로 다시 올림 — 되돌릴 수 있다). 프로세스를 죽이지 않는다.
// 결정은 판단 직전 지표와 함께 장부에 남고, governor-eval이 몇 분 뒤 효과를 판정한다.
'use strict';
const fs = require('fs');
const path = require('path');

// foreignShare: 다른 앱이 넘침의 원인으로 치려면 차지한 GPU 메모리 몫이 이 이상(런처·브라우저의 수백 MB는 원인이 아니다).
const POLICY = { tickMs: 30000, throttleMs: 5 * 60 * 1000, thermalThrottleMs: 3 * 60 * 1000, windowSeconds: 120, foreignShare: 0.2 };
// 결정을 만든 규칙(decide와 그것이 읽는 telemetry-analysis 진단)의 버전. 결정 행에 찍고 governor-eval은 같은 버전 행만 판정한다 —
// 1.32.17 전의 거짓 vram_spill로 낸 결정이 고친 뒤에도 "release-gate 악화" 제안의 근거로 남았다. decide나 진단 기준을 바꾸면 올린다.
const RULES_VERSION = 'governor-1.32.17';
let timer = null;
let lastDecision = null;
let lastUnloadAt = 0;

const ledgerFile = (deps = {}) => path.join(deps.dataDir || require('../paths').hubDataDir(), 'governor', 'decisions.jsonl');
const LEDGER_MAX_BYTES = 2 * 1024 * 1024; // 넘으면 .1로 굴린다 — 평가는 최근 결정만 본다

/** Hub 안팎을 한 번에 읽는다. 각 원천은 실패해도 나머지를 잃지 않는다(실패도 관측값으로 남긴다). */
async function observe(deps = {}) {
  const o = { at: Date.now(), errors: [], lastUnloadAt };
  const tel = deps.telemetry || require('../telemetry');
  try {
    const r = await tel.report({ sinceSeconds: POLICY.windowSeconds, top: 4 });
    o.findings = (r.findings || []).map((f) => ({ kind: f.kind, from: f.from, seconds: f.seconds,
      culprits: (f.culprits || []).slice(0, 3).map((c) => ({ app: c.app || null, name: c.name || c.process || null, share: c.share ?? null })).filter((c) => c.app || c.name) }));
    o.machine = r.machine ? { cpuPeak: r.machine.cpuPercent?.peak ?? null, vramPeak: r.machine.vramPeakBytes ?? null, sharedPeak: r.machine.sharedVramPeakBytes ?? null } : null;
    o.samples = r.samples || 0;
    o.sampler = r.sampler || (tel.status ? tel.status() : null);
  } catch (e) { o.errors.push('telemetry:' + String(e.message || e).slice(0, 80)); }
  const signals = require('../change-signals');
  o.busy = signals.busy('offload', 'aider', 'pipeline');
  o.gate = signals.gate('local-inference');
  o.gateWaiting = signals.gateWaiting('local-inference');
  try { o.slot = (deps.optimizer || require('../hardware-optimizer')).slotState(); } catch (e) { o.errors.push('slot:' + e.message); }
  try { o.routedModel = (deps.gpufit || require('../gpufit')).lastRouted?.() || null; } catch (e) { o.errors.push('gpufit:' + e.message); }
  try { o.scheduler = (deps.scheduler || require('../multiagent/scheduler').instance()).state(); } catch (e) { o.errors.push('scheduler:' + e.message); }
  try { o.offloadJobs = (deps.offload || require('../offload')).active().map((j) => ({ worker: j.worker, caller: j.caller || null })); } catch (e) { o.errors.push('offload:' + e.message); }
  return o;
}

// LM Studio는 올린 모델마다 llama-server 자식을 띄운다(2026-10-22 실측: JIT로 다시 올릴 때마다 pid가 바뀜). 이름으로도 보는 이유:
// 부모 트리는 15초마다 갱신돼 새 자식은 잠시 소속을 모르고, 남의 llama-server여도 unloadIdle은 LM Studio의 노는 모델만 내린다.
const isLocalModel = (c) => c.app === 'lmstudio' || ['lmstudio', 'llama.cpp'].includes(require('../telemetry-analysis').classify(c.name));

/** 순수 판단. 같은 관측이면 같은 행동. */
function decide(o, policy = POLICY) {
  const findings = o.findings || [];
  const kinds = new Set(findings.map((f) => f.kind));
  const actions = [];
  if (kinds.has('paging') || kinds.has('vram_spill')) {
    const spills = findings.filter((f) => f.kind === 'vram_spill');
    // 넘침에 관문을 거는 건 다른 앱(게임·UE 편집기)이 VRAM을 차지했을 때뿐이다. LM Studio 모델 자신이 넘친 것은
    // 관문으로 줄지 않고 Hub의 로컬 작업만 묶는다. 원인을 못 잡았으면(카운터 없음) 예전처럼 건다.
    const foreign = spills.flatMap((f) => f.culprits || []).find((c) => !isLocalModel(c) && (c.share ?? 1) >= policy.foreignShare);
    const blind = spills.some((f) => !(f.culprits || []).length);
    if (kinds.has('paging') || foreign || blind) {
      actions.push({ type: 'gate-local-inference', ms: policy.throttleMs, reason: kinds.has('paging') ? 'paging' : foreign ? `vram_spill from ${foreign.name || foreign.app}` : 'vram_spill without a culprit' });
    }
    // 노는 모델 내리기는 그 자리를 누가 쓸 때만: LM Studio 모델이 원인이면서 다른 앱도 넘침을 만들었거나 페이징일 때, 또는
    // 로컬 작업이 기다릴 때. 남의 앱만의 압박에 내려 봐야 다음 요청이 콜드 로드만 한다(2026-10-22 평가: 원인을 안 보고 내린 9번 중
    // 8번 효과 없음). LM Studio 모델 혼자 넘친 때도 안 내린다: 내린 8개 중 7개가 4~79초 만에 새 pid로 다시 올라와 같은 넘침이
    // 됐고, 그 넘침은 모델이 올라 있는 내내 이어져(공유 1 GiB 판정) 내리기가 쓰는 중인 모델을 주기적으로 쫓아내게 된다.
    const local = findings.filter((f) => f.kind === 'paging' || f.kind === 'vram_spill').flatMap((f) => f.culprits || []).find(isLocalModel);
    const crowded = local && (foreign || kinds.has('paging'));
    const queued = (o.slot?.waiting || 0) > 0;
    // 판단 창에는 직전 내림 이전의 표본이 아직 남아 있다 — 같은 증거로 다시 내리지 않는다
    // (2026-10-22 실측: 창이 지날 때까지 30초마다 다시 올라온 모델을 내려 진행 중인 요청을 끊었다).
    if ((crowded || queued) && (!o.lastUnloadAt || (o.at || Date.now()) - o.lastUnloadAt >= policy.windowSeconds * 1000)) {
      // 기다리는 작업이 쓸 모델(가장 최근 라우팅)은 남긴다 — 라우팅은 슬롯 대기 전에 일어난다(delegator·offload).
      actions.push({ type: 'unload-idle-models', reason: crowded ? `${local.name || local.app} holds the memory` : 'local work queued',
        ...(queued && o.routedModel ? { keep: o.routedModel } : {}) });
    }
  } else if (kinds.has('gpu_throttle')) {
    actions.push({ type: 'gate-local-inference', ms: policy.thermalThrottleMs, reason: 'gpu_throttle' });
  } else if (kinds.has('cpu_saturation') && (o.slot?.waiting || 0) > 0) {
    actions.push({ type: 'gate-local-inference', ms: 60000, reason: 'cpu_saturation with queued local work' });
  } else if (o.gate) {
    actions.push({ type: 'release-gate', reason: 'no pressure findings in the last window' });
  }
  return actions;
}

async function act(actions, deps = {}) {
  const signals = require('../change-signals');
  const done = [];
  for (const a of actions) {
    try {
      if (a.type === 'gate-local-inference') { signals.setGate('local-inference', Date.now() + a.ms, a.reason); done.push({ ...a, ok: true }); }
      else if (a.type === 'release-gate') { signals.setGate('local-inference', 0); done.push({ ...a, ok: true }); }
      else if (a.type === 'unload-idle-models') { const r = await (deps.gpufit || require('../gpufit')).unloadIdle(a.keep ? { keep: a.keep } : {}); lastUnloadAt = Date.now(); done.push({ ...a, ok: true, unloaded: (r && r.unloaded) || [] }); }
    } catch (e) { done.push({ ...a, ok: false, error: String(e.message || e).slice(0, 120) }); }
  }
  return done;
}

/** 한 주기: 관측 → 판단 → 실행 → 장부 → 감시 공백 기록. */
async function tick(deps = {}) {
  const o = await observe(deps);
  const actions = decide(o);
  const done = actions.length ? await act(actions, deps) : [];
  await require('./monitoring-gaps').note(o, done, deps).catch(() => {});
  if (done.length) {
    // 관문이 막을 로컬 작업이 있었는지를 평가가 알 수 있게: 로컬 슬롯을 쓰는 중(slotActive)·슬롯 대기(slotWaiting)·관문 대기(gateWaiting).
    // busy는 원격(codex·agy) offload도 포함해 관문의 대상이 아니다(1.32.23, Codex 교차 리뷰) — 기록만 남긴다.
    const row = { at: new Date(o.at).toISOString(), rules: RULES_VERSION, actions: done, before: { findings: (o.findings || []).map((f) => f.kind), machine: o.machine, busy: o.busy,
      slotActive: o.slot?.active || 0, slotWaiting: o.slot?.waiting || 0, gateWaiting: o.gateWaiting || 0 } };
    await require('../atomic-file').appendLine(ledgerFile(deps), JSON.stringify(row), { maxBytes: LEDGER_MAX_BYTES });
    lastDecision = row;
  }
  return { observed: { findings: o.findings || [], busy: o.busy, gate: o.gate, errors: o.errors }, actions: done };
}

function start(deps = {}) {
  if (timer) return;
  timer = setInterval(() => { tick(deps).catch(() => {}); }, POLICY.tickMs);
  timer.unref?.();
}
function stop() { if (timer) clearInterval(timer); timer = null; }
const status = () => ({ running: Boolean(timer), gate: require('../change-signals').gate('local-inference'), lastDecision, policy: POLICY });

async function decisions({ limit = 200 } = {}, deps = {}) {
  let text = '';
  // 없으면 빈 장부, 그 밖의 읽기 오류는 던진다 — 거버너 평가가 "결정 없음"으로 잘못 판정하지 않게(규칙 6).
  try { text = await fs.promises.readFile(ledgerFile(deps), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return text.split('\n').filter(Boolean).slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

module.exports = { observe, decide, act, tick, start, stop, status, decisions, POLICY, RULES_VERSION, ledgerFile };

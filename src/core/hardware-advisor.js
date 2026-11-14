'use strict';
// 공유 하드웨어 라우팅 어드바이저 (schemaVersion 1).
// 순수 함수만 둔다: 작업·기기 프로필·실시간 자원·모델 목록·실측 통계·정책 → 경로 결정.
// 모델 로드, 추론, 네트워크 호출, 파일 쓰기를 하지 않는다.
// 저장소(harness/lib)와 AI Hub(src/core)가 바이트 단위로 같은 파일을 쓴다. doctor가 해시를 대조한다.

const SCHEMA_VERSION = 1;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseParamsB(model) {
  if (!model) return null;
  if (Number.isFinite(model.paramsB) && model.paramsB > 0) return model.paramsB;
  const text = String(model.paramsString || model.params || '');
  const moe = text.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*B/i);
  if (moe) return Number(moe[1]) * Number(moe[2]);
  const plain = text.match(/(\d+(?:\.\d+)?)\s*B/i);
  if (plain) return Number(plain[1]);
  const fromKey = String(model.key || '').match(/(\d+(?:\.\d+)?)b(?![a-z])/i);
  return fromKey ? Number(fromKey[1]) : null;
}

function kvBytesPerToken(model, policy) {
  const arch = model && model.arch;
  if (arch && arch.layers > 0 && arch.kvHeads > 0 && arch.headDim > 0) {
    const bits = arch.kvBits > 0 ? arch.kvBits : 16;
    return Math.ceil((2 * arch.layers * arch.kvHeads * arch.headDim * bits) / 8);
  }
  const paramsB = parseParamsB(model) || 8;
  return Math.ceil(num(policy.heuristics.kvBytesPerTokenPerB, 16384) * paramsB);
}

function footprint(model, ctxTokens, policy) {
  const weights = Math.max(0, num(model.sizeBytes));
  const kv = model.type === 'embedding' ? 0 : kvBytesPerToken(model, policy) * ctxTokens;
  const overhead = num(policy.vram.computeOverheadBytes);
  return { weights, kv, overhead, total: weights + kv + overhead };
}

function loadedEntry(resources, key) {
  const list = Array.isArray(resources && resources.loadedModels) ? resources.loadedModels : [];
  for (const item of list) {
    if (item === key) return { key };
    if (item && typeof item === 'object' && item.key === key) return item;
  }
  return null;
}

// 실시간 수치가 없으면 기기 프로필 총량을 쓰고, 사용량 미상은 보수적으로 가정한다.
function normalizeResources(resources, machine) {
  const r = resources || {};
  const gpu = r.gpu || {};
  const gpus = (machine && Array.isArray(machine.gpus)) ? machine.gpus : [];
  const dedicated = gpus.filter((g) => num(g.vramBytes) > 0).sort((a, b) => num(b.vramBytes) - num(a.vramBytes));
  const unknown = [];
  let vramTotal = num(gpu.vramTotalBytes);
  if (!vramTotal && dedicated.length) { vramTotal = num(dedicated[0].vramBytes); unknown.push('vram-total-from-profile'); }
  let vramUsed = gpu.vramUsedBytes == null ? null : num(gpu.vramUsedBytes);
  if (vramUsed == null && vramTotal) { vramUsed = Math.round(vramTotal * 0.15); unknown.push('vram-used-assumed-15pct'); }
  let ramTotal = num(r.ramTotalBytes);
  if (!ramTotal && machine) { ramTotal = num(machine.ramBytes); unknown.push('ram-total-from-profile'); }
  let ramUsed = r.ramUsedBytes == null ? null : num(r.ramUsedBytes);
  if (ramUsed == null && ramTotal) { ramUsed = Math.round(ramTotal * 0.6); unknown.push('ram-used-assumed-60pct'); }
  return {
    vramTotal,
    vramUsed: vramUsed || 0,
    ramTotal,
    ramUsed: ramUsed || 0,
    gpuUtil: gpu.util == null ? null : num(gpu.util),
    cpuUtil: r.cpuUtil == null ? null : num(r.cpuUtil),
    onAcPower: typeof r.onAcPower === 'boolean' ? r.onAcPower : null,
    heavyApps: Array.isArray(r.heavyApps) ? r.heavyApps.map(String) : [],
    raw: r,
    unknown,
  };
}

function admission(task, res, policy) {
  const a = policy.admission || {};
  const reasons = [];
  let localAllowed = true;
  let gpuAllowed = res.vramTotal > 0;
  if (!gpuAllowed) reasons.push('no-dedicated-gpu');
  if (a.requireAcPowerForLocal && res.onAcPower === false) {
    localAllowed = false;
    reasons.push('on-battery');
  }
  const patterns = Array.isArray(a.heavyApps) ? a.heavyApps.map((s) => String(s).toLowerCase()) : [];
  const heavy = res.heavyApps.filter((name) => patterns.some((p) => name.toLowerCase().includes(p)));
  if (heavy.length) {
    gpuAllowed = false;
    if (a.heavyAppPolicy === 'defer') localAllowed = false;
    reasons.push(`heavy-app:${heavy.join(',')}`);
  }
  if (!task.interactive) {
    if (res.gpuUtil != null && res.gpuUtil > num(a.maxGpuUtilForBackground, 1)) {
      gpuAllowed = false;
      reasons.push('gpu-busy');
    }
    if (res.cpuUtil != null && res.cpuUtil > num(a.maxCpuUtilForBackground, 1)) {
      localAllowed = false;
      reasons.push('cpu-busy');
    }
  }
  return { localAllowed, gpuAllowed: localAllowed && gpuAllowed, reasons };
}

function place(model, ctxTokens, res, policy, gpuAllowed) {
  const fp = footprint(model, ctxTokens, policy);
  const loaded = loadedEntry(res.raw, model.key);
  if (loaded) {
    const usable = res.vramTotal - Math.max(num(policy.vram.reserveBytes), num(policy.vram.reserveFraction) * res.vramTotal);
    const assumed = loaded.placement || (fp.total <= usable ? 'gpu-full' : 'gpu-partial');
    return { placement: assumed, footprint: fp, loaded: true };
  }
  const vramReserve = Math.max(num(policy.vram.reserveBytes), num(policy.vram.reserveFraction) * res.vramTotal);
  const freeVram = Math.max(0, res.vramTotal - res.vramUsed - vramReserve);
  const ramReserve = Math.max(num(policy.ram.reserveBytes), (1 - num(policy.ram.maxUsedFraction, 0.9)) * res.ramTotal);
  const freeRam = Math.max(0, res.ramTotal - res.ramUsed - ramReserve);
  if (gpuAllowed && res.vramTotal > 0) {
    if (fp.total <= freeVram) return { placement: 'gpu-full', footprint: fp, freeVram, freeRam };
    const gpuWeights = freeVram - fp.overhead - fp.kv;
    const fraction = fp.weights > 0 ? gpuWeights / fp.weights : 0;
    if (fraction >= num(policy.vram.minPartialFraction, 0.6) && fp.weights - gpuWeights <= freeRam) {
      return { placement: 'gpu-partial', gpuFraction: Math.min(1, fraction), footprint: fp, freeVram, freeRam };
    }
  }
  if (fp.weights + fp.kv <= freeRam) return { placement: 'cpu', footprint: fp, freeVram, freeRam };
  return { placement: 'none', footprint: fp, freeVram, freeRam };
}

// 부분 오프로드는 토큰마다 GPU 층과 CPU 층을 차례로 지나므로 토큰당 시간을 층 비율로 섞는다.
function tokenRates(placement, paramsB, gpuFraction, h) {
  const rate = (p) => num(h.decodeTpsPerB[p], 45) / paramsB;
  const prefill = (p) => rate(p) * num(h.prefillMultiplier[p], 6);
  if (placement === 'gpu-partial' && gpuFraction > 0 && gpuFraction < 1) {
    const f = gpuFraction;
    const decodeSec = (1 - f) / rate('cpu') + f / rate('gpu-full');
    const prefillSec = (1 - f) / prefill('cpu') + f / prefill('gpu-full');
    return { decodeTps: 1 / decodeSec, prefillTps: 1 / prefillSec };
  }
  return { decodeTps: rate(placement), prefillTps: prefill(placement) };
}

function estimateMs(model, placement, task, stat, loaded, policy, gpuFraction) {
  const h = policy.heuristics;
  const inTok = Math.max(0, num(task.estInputTokens, 500));
  const outTok = Math.max(0, num(task.estOutputTokens, 300));
  const ratio = stat && stat.reasoningRatio > 0 && stat.reasoningRatio < 1 ? stat.reasoningRatio : 0;
  const inflation = Math.min(num(h.reasoningInflationMax, 8), 1 / (1 - ratio));
  const loadMs = loaded ? 0 : num(h.loadOverheadMs) + (num(model.sizeBytes) / num(h.diskBytesPerSec, 1.5e9)) * 1000;
  if (stat && num(stat.count) >= 3 && num(stat.emaMs) > 0 && num(stat.totalTokens) > 0) {
    // 같은 PC의 실측 EMA를 토큰 규모로 선형 보정한다. 측정 당시 배치(placement)는 알 수 없으므로 범위를 제한한다.
    const perRun = num(stat.totalTokens) / num(stat.count);
    const scale = Math.max(0.25, Math.min(4, (inTok + outTok * inflation) / Math.max(1, perRun)));
    return { ms: Math.round(loadMs + num(stat.emaMs) * scale), basis: 'measured-ema' };
  }
  const paramsB = parseParamsB(model) || 8;
  const { decodeTps, prefillTps } = tokenRates(placement, paramsB, gpuFraction, h);
  const genMs = ((inTok / prefillTps) + (outTok * inflation) / decodeTps) * 1000;
  return { ms: Math.round(loadMs + genMs), basis: 'heuristic' };
}

function qualityOf(task, policy) {
  const kind = (policy.kinds && policy.kinds[task.kind]) || {};
  return task.quality || kind.quality || 'high';
}

function meetsQuality(model, quality, policy) {
  const q = (policy.quality && policy.quality[quality]) || {};
  if (q.cloudOnly) return false;
  if (model.type === 'embedding') return true;
  const paramsB = parseParamsB(model);
  return paramsB != null && paramsB >= num(q.minParamsB, 0);
}

function normalizeTask(task, policy) {
  const t = Object.assign({ kind: 'plan', interactive: true, privacy: 'any' }, task || {});
  // The window must hold the task itself: a 6.6K-token task was once judged to fit a 4K context.
  t.ctxTokens = Math.max(num(policy.context.minTokens, 2048), num(t.ctxTokens, num(policy.context.defaultTokens, 8192)),
    num(t.estInputTokens, 0) + num(t.estOutputTokens, 0));
  return t;
}

function cloudCandidate(task, policy) {
  const c = policy.cloud || {};
  const inTok = Math.max(0, num(task.estInputTokens, 500));
  const outTok = Math.max(0, num(task.estOutputTokens, 300));
  const prefix = num(c.sessionPrefixTokens, 0);
  const candidate = {
    route: c.route || 'codex',
    fits: task.privacy !== 'local-only',
    expectedMs: Math.round(num(c.baseMs, 4000) + outTok * num(c.msPerOutputToken, 25)),
    costTokens: prefix + inTok + outTok,
    reasons: [],
  };
  if (task.privacy === 'local-only') candidate.reasons.push('privacy-local-only');
  // 새 Codex 세션은 세션 간 prefix 캐시가 0으로 측정됐다. 작은 작업은 한 세션에 묶는다.
  if (inTok + outTok < num(c.batchWhenTaskTokensBelow, 0)) {
    candidate.batchHint = true;
    candidate.reasons.push(`session-prefix-dominates:${prefix}`);
  }
  return candidate;
}

const TRANSIENT = ['on-battery', 'cpu-busy', 'gpu-busy'];

function deferInstead(task, gate, policy) {
  const a = policy.admission || {};
  if (!a.deferBackgroundWhenTransient) return false;
  const transient = gate.reasons.some((r) => TRANSIENT.includes(r) || r.startsWith('heavy-app'));
  const deadline = num(task.deadlineMs, Infinity);
  return transient && deadline >= num(a.minDeadlineToDeferMs, 0);
}

function advise(input) {
  if (!input || !input.policy) throw new Error('policy is required');
  const policy = input.policy;
  const task = normalizeTask(input.task, policy);
  const res = normalizeResources(input.resources, input.machine);
  const stats = input.stats || {};
  const kindCfg = (policy.kinds && policy.kinds[task.kind]) || {};
  const base = { schemaVersion: SCHEMA_VERSION, task: { kind: task.kind, interactive: !!task.interactive, privacy: task.privacy }, unknown: res.unknown };
  if (task.deterministic || kindCfg.route === 'tool') {
    return Object.assign(base, { route: 'tool', reasons: ['deterministic-tool-first'], candidates: [] });
  }
  const quality = qualityOf(task, policy);
  const gate = admission(task, res, policy);
  const wantType = kindCfg.modelType || 'llm';
  const limit = task.interactive
    ? num(policy.valueGate.interactiveMaxMs, 60000)
    : Math.min(num(task.deadlineMs, Infinity), num(policy.valueGate.backgroundMaxMs, 900000));
  const candidates = [];
  for (const model of Array.isArray(input.models) ? input.models : []) {
    if ((model.type || 'llm') !== wantType) continue;
    if (task.needsVision && !model.vision) continue;
    if (task.needsTools && model.toolUse === false) continue;
    const c = { route: 'local', model: model.key, fits: false, withinGate: false, reasons: [] };
    candidates.push(c);
    if (!meetsQuality(model, quality, policy)) { c.reasons.push(`below-quality:${quality}`); continue; }
    if (!gate.localAllowed) { c.reasons.push(...gate.reasons); continue; }
    const maxCtx = num(model.maxContext, Infinity) || Infinity;
    const ctx = Math.min(maxCtx, task.ctxTokens);
    const p = place(model, ctx, res, policy, gate.gpuAllowed);
    Object.assign(c, { placement: p.placement, ctxTokens: ctx, loaded: !!p.loaded, footprintBytes: p.footprint.total });
    if (p.gpuFraction != null) c.gpuFraction = Number(p.gpuFraction.toFixed(3));
    if (p.placement === 'none') { c.reasons.push('insufficient-memory'); continue; }
    c.fits = true;
    const est = estimateMs(model, p.placement, task, stats[model.key], p.loaded, policy, p.gpuFraction);
    c.expectedMs = est.ms;
    c.basis = est.basis;
    c.withinGate = est.ms <= limit;
    if (!c.withinGate) c.reasons.push(`over-value-gate:${limit}`);
    if (!gate.gpuAllowed && gate.reasons.length) c.reasons.push(...gate.reasons.map((r) => `gpu-denied:${r}`));
  }
  // 예상 시간에 이미 로드 시간이 들어 있으므로 시간순으로 고른다. 로드된 모델 선호는 정책의 보너스로만 준다.
  const bonus = num(policy.heuristics.loadedModelBonusMs, 0);
  const viable = candidates
    .filter((c) => c.withinGate)
    .sort((a, b) => (a.expectedMs - (a.loaded ? bonus : 0)) - (b.expectedMs - (b.loaded ? bonus : 0)));
  const cloud = cloudCandidate(task, policy);
  candidates.push(cloud);
  const reasons = [`quality:${quality}`];
  let choice = null;
  // Codex는 임베딩을 만들지 않는다. 로컬 임베딩 모델이 없거나 지금 못 쓰면 보류한다.
  const cloudCapable = wantType === 'llm';
  if (!cloudCapable) cloud.fits = false;
  if (task.privacy === 'local-only' || !cloudCapable) {
    if (viable.length) choice = viable[0];
    else reasons.push('no-local-capacity-within-gate');
  } else if (quality === 'high' || (policy.quality[quality] || {}).cloudOnly) {
    choice = cloud;
    reasons.push('quality-requires-cloud');
  } else if (viable.length && (kindCfg.localPreferred || !task.interactive)) {
    choice = viable[0];
  } else if (!task.interactive && deferInstead(task, gate, policy)) {
    // 배터리·무거운 앱·바쁜 CPU/GPU는 곧 풀리는 제약이다. 급하지 않은 배경 작업을 클라우드로 보내 토큰을 쓰지 않는다.
    reasons.push('transient-local-block');
  } else {
    choice = cloud;
    reasons.push(viable.length ? 'interactive-prefers-cloud' : 'no-viable-local');
  }
  if (!choice) {
    return Object.assign(base, { route: 'defer', reasons: reasons.concat(gate.reasons), admission: gate, candidates });
  }
  return Object.assign(base, {
    route: choice.route,
    model: choice.model || null,
    placement: choice.placement || null,
    ctxTokens: choice.ctxTokens || null,
    expectedMs: choice.expectedMs,
    batchHint: !!choice.batchHint,
    reasons: reasons.concat(choice.reasons || []),
    admission: gate,
    candidates,
  });
}

// 배경 작업 묶음 계획: 같은 모델끼리 모으고(로드/스왑 최소화) 같은 prefix family를 연속 배치해 KV 캐시 재사용을 늘린다.
function planBatch(input) {
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const loadedKeys = new Set(((input.resources && input.resources.loadedModels) || []).map((m) => (typeof m === 'string' ? m : m.key)));
  const groups = new Map();
  const decisions = [];
  for (const task of tasks) {
    const decision = advise(Object.assign({}, input, { task }));
    decisions.push({ id: task.id, route: decision.route, model: decision.model || null });
    const key = decision.route === 'local' ? `local:${decision.model}` : decision.route;
    if (!groups.has(key)) groups.set(key, { route: decision.route, model: decision.model || null, tasks: [] });
    groups.get(key).tasks.push({ id: task.id, family: task.family || '' });
  }
  const ordered = [...groups.values()].sort((a, b) => {
    const al = a.model && loadedKeys.has(a.model) ? 0 : 1;
    const bl = b.model && loadedKeys.has(b.model) ? 0 : 1;
    if (al !== bl) return al - bl;
    return b.tasks.length - a.tasks.length;
  });
  for (const g of ordered) g.tasks.sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : 0));
  const localModels = ordered.filter((g) => g.route === 'local').map((g) => g.model);
  const swaps = localModels.filter((m) => !loadedKeys.has(m)).length;
  const cloudTasks = ordered.filter((g) => g.route === 'codex').reduce((n, g) => n + g.tasks.length, 0);
  return { schemaVersion: SCHEMA_VERSION, groups: ordered, decisions, modelLoads: swaps, cloudTasks, cloudSessionsIfBatched: cloudTasks ? 1 : 0 };
}

module.exports = { SCHEMA_VERSION, advise, planBatch, admission, place, footprint, kvBytesPerToken, parseParamsB, estimateMs, normalizeResources };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const inputPath = opt('--input');
  const raw = inputPath && inputPath !== '-' ? fs.readFileSync(inputPath, 'utf8') : fs.readFileSync(0, 'utf8');
  const input = JSON.parse(raw.replace(/^﻿/, ''));
  if (!input.policy) {
    const policyPath = opt('--policy') || path.join(__dirname, '..', 'routing-policy.json');
    input.policy = JSON.parse(fs.readFileSync(policyPath, 'utf8').replace(/^﻿/, ''));
  }
  const out = args.includes('--batch') ? planBatch(input) : advise(input);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

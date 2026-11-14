// Hub 하드웨어 어댑터·전역 로컬 추론 슬롯·지연 통계 통합 회귀 테스트.
// LM Studio·nvidia-smi·외부 프로세스를 부르지 않는다(측정값과 카탈로그는 스텁).
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-hw-'));
process.env.APPDATA = SANDBOX;
process.env.AIHUB_HW_REFRESH = '0';

const MiB = 1024 * 1024;
const monitor = require('../src/core/resource-monitor');
const gpufit = require('../src/core/gpufit');
const stats = require('../src/core/stats');
const lmstudio = require('../src/core/lmstudio');
const config = require('../src/core/config');
const hw = require('../src/core/hardware-optimizer');

const snap = { sampledAt: Date.now(), cpu: { logicalCores: 16, usagePercent: 10 },
  ram: { totalBytes: 25.1e9, usedBytes: 12e9, usagePercent: 47.8 },
  gpu: { available: true, devices: [{ index: 0, name: 'RTX 5060 Laptop', usagePercent: 2, totalMiB: 8151, usedMiB: 411 }] } };
monitor.peek = () => snap;
gpufit.lastAssessment = () => ({ verdict: 'ok', models: [] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1) 측정값 변환
  const r = hw._internals.resources(snap);
  assert.equal(r.gpu.vramTotalBytes, 8151 * MiB);
  assert.equal(r.gpu.util, 0.02);
  assert.equal(r.cpuUtil, 0.1);
  // 배경화면이 nvidia 사용률만 올린 경우: 배경을 뺀 busyPercent로 판단해 gpu-busy가 아니다
  const wallpaper = { ...snap, gpu: { available: true, devices: [{ ...snap.gpu.devices[0], usagePercent: 45, busyPercent: 2.5 }] } };
  assert.equal(hw._internals.resources(wallpaper).gpu.util, 0.025);

  // 2) offload가 쓰는 조언: 카탈로그 크기로 VRAM에 다 들어가는 로컬 모델을 고른다
  hw._internals.setCatalog([
    { key: 'vendor/fit-8b', type: 'llm', sizeBytes: 6.19e9, maxContext: 32768 },
    { key: 'vendor/spill-12b', type: 'llm', sizeBytes: 7.56e9, maxContext: 32768 },
  ]);
  const fit = hw.advise({ kind: 'extract', interactive: false, privacy: 'local-only', estInputTokens: 2000, estOutputTokens: 600 });
  assert.equal(fit.route, 'local'); assert.equal(fit.model, 'vendor/fit-8b'); assert.equal(fit.placement, 'gpu-full');
  assert(fit.expectedMs < 60000, String(fit.expectedMs));

  // 3) 배경 허용: 전원 미상이면 허용, 배터리면 거부
  assert.equal(hw.backgroundAdmission().localAllowed, true);
  hw._internals.env.onAcPower = false;
  const denied = hw.backgroundAdmission();
  assert.equal(denied.localAllowed, false);
  assert(denied.reasons.includes('on-battery'));
  hw._internals.env.onAcPower = true;

  // 4) 전역 슬롯: 동시 3건이 1건씩 FIFO로, 대기 중 취소는 다른 대기자를 막지 않는다
  let active = 0; let peak = 0; const order = [];
  const job = (id, ms) => hw.withLocalSlot(async () => { active += 1; peak = Math.max(peak, active); order.push(id); await sleep(ms); active -= 1; return id; });
  const ac = new AbortController();
  const p1 = job('a', 30); const p2 = hw.withLocalSlot(async () => 'never', { signal: ac.signal }); const p3 = job('c', 5);
  ac.abort(new Error('cancelled'));
  await assert.rejects(p2, /cancelled/);
  assert.deepEqual(await Promise.all([p1, p3]), ['a', 'c']);
  assert.equal(peak, 1);
  assert.deepEqual(order, ['a', 'c']);
  assert.deepEqual(hw.slotState(), { active: 0, waiting: 0, maxConcurrent: 1 });

  // 5) 기기 전용 덮어쓰기로 동시 2건
  config.update({ hardware: { policyOverrides: { localInference: { maxConcurrent: 2 } } } });
  assert.equal(hw.slotState().maxConcurrent, 1);
  active = 0; peak = 0;
  await Promise.all([job('x', 20), job('y', 20), job('z', 5)]);
  assert.equal(peak, 1);
  const local = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'ai-hub', 'config.local.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(local.hardware.policyOverrides.localInference.maxConcurrent, 2);
  config.update({ hardware: { policyOverrides: {} } });

  // 6) 통계: 추론 없는 반려는 EMA에 넣지 않고, 표본 3개 미만·오래된 EMA는 판단에 쓰지 않는다
  stats.record({ taskType: 'custom', model: 'vendor/fit-8b', elapsedMs: 3, ok: true, skipped: 'context' });
  assert.equal(stats.latencyOf('vendor/fit-8b'), null);
  for (const ms of [90000, 100000, 110000]) stats.record({ taskType: 'custom', model: 'vendor/spill-12b', elapsedMs: ms, ok: true, tokens: 900 });
  assert(stats.freshLatencyOf('vendor/spill-12b') > 60000);
  stats.record({ taskType: 'custom', model: 'vendor/fit-8b', elapsedMs: 8000, ok: true, tokens: 900 });
  assert.equal(stats.freshLatencyOf('vendor/fit-8b'), null);
  const file = JSON.parse(fs.readFileSync(stats.STATS_FILE, 'utf8').replace(/^\uFEFF/, ''));
  file.models['vendor/spill-12b'].lastUsed = '2026-01-01T00:00:00.000Z';
  fs.writeFileSync(stats.STATS_FILE, JSON.stringify(file));
  assert.equal(stats.freshLatencyOf('vendor/spill-12b'), null);
  assert(stats.latencyOf('vendor/spill-12b') > 60000);

  console.log('Passed: resource conversion, local-only extraction advice, battery admission, FIFO global slot + abort, device-only overrides, EMA skip/fresh/stale rules');
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* temp */ } });

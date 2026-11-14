#!/usr/bin/env node
// 공유 하드웨어 어드바이저(순수 함수) 회귀 테스트. 모델·네트워크·프로세스를 쓰지 않는다.
// 수치는 실제 PC 하나(RTX 5060 Laptop 8GB, RAM 24GB, 2026-10 측정)를 본뜬 고정 입력이다.
'use strict';
const assert = require('assert/strict');
const advisor = require('../src/core/hardware-advisor');
const policy = require('../src/core/routing-policy.default.json');

const MiB = 1024 * 1024;
const GB = 1e9;
const machine = { ramBytes: 25.1 * GB, gpus: [{ name: 'RTX 5060 Laptop', vramBytes: 8151 * MiB }] };
const idle = { ramTotalBytes: 25.1 * GB, ramUsedBytes: 12 * GB, cpuUtil: 0.1, onAcPower: true, heavyApps: [], loadedModels: [],
  gpu: { vramTotalBytes: 8151 * MiB, vramUsedBytes: 411 * MiB, util: 0.02 } };
const models = [
  { key: 'qwen/qwen3-vl-8b', type: 'llm', vision: true, sizeBytes: 6186994398, maxContext: 262144 },
  { key: 'google/gemma-4-12b', type: 'llm', vision: true, sizeBytes: 7556574286, maxContext: 262144 },
  { key: 'text-embedding-nomic-embed-text-v1.5', type: 'embedding', sizeBytes: 84106624, maxContext: 2048 },
];
const gemmaMeasured = { 'google/gemma-4-12b': { count: 49, emaMs: 183483, totalTokens: 47092, reasoningRatio: 0.8839 } };
const advise = (task, over = {}) => advisor.advise({ policy, machine, resources: idle, models, stats: {}, task, ...over });

// 1) 파라미터 추정
assert.equal(advisor.parseParamsB({ key: 'google/gemma-4-12b' }), 12);
assert.equal(advisor.parseParamsB({ key: 'qwen/qwen2.5-coder-14b' }), 14);
assert.equal(advisor.parseParamsB({ paramsString: '8x7B' }), 56);
assert.equal(advisor.parseParamsB({ key: 'text-embedding-nomic-embed-text-v1.5' }), null);
assert.equal(advisor.kvBytesPerToken({ arch: { layers: 36, kvHeads: 8, headDim: 128 } }, policy), 147456);

// 2) 8GB VRAM 적합도: 8B Q4는 4K 문맥에서 GPU에 다 들어가고, 12B Q4는 부분 오프로드다.
const res = advisor.normalizeResources(idle, machine);
const q = advisor.place(models[0], 4096, res, policy, true);
const g = advisor.place(models[1], 4096, res, policy, true);
assert.equal(q.placement, 'gpu-full');
assert.equal(g.placement, 'gpu-partial');
assert(g.gpuFraction > 0.6 && g.gpuFraction < 0.95, String(g.gpuFraction));

// 3) 대화형 요약: 들어가는 8B를 로컬로, 실측이 느린 12B는 게이트에서 탈락
let d = advise({ kind: 'summarize', interactive: true, estInputTokens: 500, estOutputTokens: 300 }, { stats: gemmaMeasured });
assert.equal(d.route, 'local');
assert.equal(d.model, 'qwen/qwen3-vl-8b');
const gemma = d.candidates.find((c) => c.model === 'google/gemma-4-12b');
assert.equal(gemma.basis, 'measured-ema');
assert.equal(gemma.withinGate, false);

// 4) 품질 high는 클라우드, 결정적 작업은 도구
assert.equal(advise({ kind: 'code-edit' }).route, 'codex');
assert.equal(advise({ kind: 'deterministic' }).route, 'tool');

// 5) 배터리 사용 중: 로컬 금지 → 클라우드, local-only면 보류
const battery = { ...idle, onAcPower: false };
assert.equal(advise({ kind: 'summarize' }, { resources: battery }).route, 'codex');
d = advise({ kind: 'summarize', privacy: 'local-only' }, { resources: battery });
assert.equal(d.route, 'defer');
assert(d.reasons.includes('on-battery'));

// 6) 게임 편집기 실행 중(기본 정책 defer): 대화형은 클라우드, 급하지 않은 배경 작업은 보류
const unity = { ...idle, heavyApps: ['Unity'] };
assert.equal(advise({ kind: 'summarize', interactive: true }, { resources: unity }).route, 'codex');
d = advise({ kind: 'summarize', interactive: false }, { resources: unity });
assert.equal(d.route, 'defer');
assert(d.reasons.includes('transient-local-block'));
assert.equal(advise({ kind: 'summarize', interactive: false, deadlineMs: 60000 }, { resources: unity }).route, 'codex');
// 기기별 덮어쓰기 cpu-only: RAM 여유가 있으면 배경 작업은 CPU 로컬, 부족하면 클라우드
const cpuOnly = { ...policy, admission: { ...policy.admission, heavyAppPolicy: 'cpu-only' } };
d = advisor.advise({ policy: cpuOnly, machine, resources: unity, models, stats: {},
  task: { kind: 'summarize', interactive: false, estInputTokens: 500, estOutputTokens: 300 } });
assert.equal(d.route, 'local');
assert.equal(d.placement, 'cpu');
d = advisor.advise({ policy: cpuOnly, machine, resources: { ...unity, ramUsedBytes: 20.7 * GB }, models, stats: {},
  task: { kind: 'summarize', interactive: true } });
assert.equal(d.route, 'codex');
assert(d.candidates.some((c) => c.reasons.includes('insufficient-memory')));

// 7) 이미 로드된 모델은 로드 시간이 없고 우선한다
const loaded = { ...idle, loadedModels: [{ key: 'qwen/qwen3-vl-8b', placement: 'gpu-full' }] };
d = advise({ kind: 'classify', interactive: true }, { resources: loaded });
assert.equal(d.model, 'qwen/qwen3-vl-8b');
assert(d.candidates.find((c) => c.model === 'qwen/qwen3-vl-8b').loaded);

// 8) 임베딩은 임베딩 모델만 고른다
d = advise({ kind: 'embed', interactive: false });
assert.equal(d.route, 'local');
assert.equal(d.model, 'text-embedding-nomic-embed-text-v1.5');

// 8-1) Codex는 임베딩을 만들지 않으므로 배터리에서는 클라우드가 아니라 보류
assert.equal(advise({ kind: 'embed', interactive: false }, { resources: battery }).route, 'defer');

// 9) GPU 없는 PC: CPU 배치만
d = advisor.advise({ policy, machine: { ramBytes: 32 * GB, gpus: [] }, models, stats: {},
  resources: { ramTotalBytes: 32 * GB, ramUsedBytes: 8 * GB, onAcPower: true },
  task: { kind: 'summarize', interactive: false } });
assert.equal(d.placement, 'cpu');

// 10) 작은 클라우드 작업은 세션 prefix가 지배하므로 묶음 실행 힌트
d = advise({ kind: 'plan', estInputTokens: 300, estOutputTokens: 200 });
assert.equal(d.route, 'codex');
assert.equal(d.batchHint, true);

// 11) 배치 계획: 같은 모델끼리, family 순서로, 클라우드 작업은 한 세션 후보로
const plan = advisor.planBatch({ policy, machine, resources: idle, models, stats: {}, tasks: [
  { id: 'a2', family: 'notes', kind: 'summarize', interactive: false },
  { id: 'b1', family: 'logs', kind: 'classify', interactive: false },
  { id: 'a1', family: 'notes', kind: 'summarize', interactive: false },
  { id: 'p1', kind: 'plan' },
] });
const local = plan.groups.find((x) => x.route === 'local');
assert.deepEqual(local.tasks.map((t) => t.id), ['b1', 'a2', 'a1']);
assert.equal(plan.modelLoads, 1);
assert.equal(plan.cloudTasks, 1);

// The context window holds the whole task: 6K in + 600 out must not be sized at the 4K default.
const big = advise({ kind: 'summarize', interactive: false, estInputTokens: 6000, estOutputTokens: 600 });
for (const c of big.candidates.filter((x) => x.route === 'local' && x.ctxTokens)) assert(c.ctxTokens >= 6600, `${c.model} ctx ${c.ctxTokens}`);
// Measured defect-finding precision of 7–14B models was 0/6: critique goes to the cloud.
assert.equal(advise({ kind: 'critique', interactive: false }).route, 'codex');

console.log('Passed: params/KV, 8GB fit (8B full, 12B partial), measured value gate, quality/tool routing, battery/heavy-app admission (defer vs cpu-only), loaded affinity, embedding (never cloud), CPU-only, cloud batch hint, batch plan');

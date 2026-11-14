#!/usr/bin/env node
'use strict';
// VRAM 넘침의 원인 프로세스와 거버너 지렛대: 가짜 샘플러 출력(telemetry-sampler.ps1의 JSON 줄, GPU Process Memory의 vd/vs)을
// 자원 기록에 넣고 진단 → 거버너 관측·판단 → 공백 기록까지 본다. 샘플러·nvidia-smi·LM Studio는 띄우지 않는다.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// gpufit이 부르는 lms는 가짜: ps는 고정 목록, unload는 기록만 한다. gpufit이 불러올 때 execFile을 묶으므로 require보다 먼저.
const lmsCalls = [];
const LOADED = [{ identifier: 'google/gemma-4-12b', type: 'llm', status: 'idle', sizeBytes: 7e9 }, { identifier: 'qwen/qwen3-4b', type: 'llm', status: 'idle', sizeBytes: 3e9 },
  { identifier: 'busy/model', type: 'llm', status: 'generating', sizeBytes: 2e9 }];
require('child_process').execFile = (cmd, args, opts, cb) => { lmsCalls.push(args.join(' ')); cb(null, Buffer.from(args[0] === 'ps' ? JSON.stringify(LOADED) : '')); };

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-vram-'));
process.env.LOCALAPPDATA = scratch;
const gpufit = require('../src/core/gpufit');
const telemetry = require('../src/core/telemetry');
const analysis = require('../src/core/telemetry-analysis');
const governor = require('../src/core/governor/governor');
const gaps = require('../src/core/governor/monitoring-gaps');
const geval = require('../src/core/governor/governor-eval');
telemetry._test.disableSampler();

let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); } }
const MIB = 1024 ** 2;
const proc = (p, n, vdMiB, vsMiB, pp = 0) => ({ p, pp, n, c: 1, m: 400 * MIB, r: 0, w: 0, hf: 0, vd: vdMiB * MIB, vs: vsMiB * MIB, g: {} });
// 샘플러가 내는 한 줄. nv는 실제로는 nvidia-smi 스트림이 붙인다(전용 VRAM이 거의 찼다는 근거).
const line = (t, procs, { usedMiB = 7900, adapterSharedMiB = 2900 } = {}) => JSON.stringify({ t, cpu: 12, mem: { avail: 12e9, commit: 1e10, limit: 3e10, pagesIn: 0 },
  disks: [], net: { rx: 0, tx: 0 }, adapters: [{ luid: '0x0000D3A8', ded: usedMiB * MIB, sh: adapterSharedMiB * MIB, eng: { Compute_0: 60 } }], procs,
  nv: [{ index: 0, util: 60, memUsedMiB: usedMiB, memTotalMiB: 8188, reasons: [] }] });
// 장면마다 새 저장 폴더: 앞 장면의 10초 묶음이 디스크에서 다시 읽혀 다음 장면의 창에 섞이지 않게.
const feed = (procs, opts = {}) => {
  telemetry._test.flush();
  process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(scratch, 'scene-'));
  telemetry._test.ring.length = 0;
  const now = Date.now();
  for (let i = (opts.count || 10) - 1; i >= 0; i--) telemetry._test.onSample(line(now - i * 2000, typeof procs === 'function' ? procs(i) : procs, opts));
};
const desktop = [proc(1848, 'dwm', 430, 3), proc(13772, 'NVIDIA Overlay', 278, 0)];
const deps = { dataDir: scratch, telemetry, optimizer: { slotState: () => ({ active: 0, waiting: 0, maxConcurrent: 1 }) },
  offload: { active: () => [] }, scheduler: { state: () => ({}) } };
const spillOf = async () => (await telemetry.report({ sinceSeconds: 120 })).findings.find((f) => f.kind === 'vram_spill');

(async () => {
  // 2026-10-22 실측 모양: LM Studio가 띄운 llama-server가 전용 6 GB + 공유 2.8 GB를 혼자 잡았다. 공유는 부분 오프로드의 CPU 층이다
  // (1.32.15 대조: 같은 모델의 공유가 오프로드 최대 1.6 → 0.79 2.2 → 0.6 3.5 GB, 전용+공유는 늘 약 8.9 GB).
  const lmApps = [...desktop, proc(9264, 'LM Studio', 325, 144), proc(20576, 'EpicGamesLauncher', 349, 0)];
  feed([...lmApps, proc(41904, 'llama-server', 6060, 2870, 9264)]);
  await check('a model server\'s host-resident layers are no spill, even on a nearly full board', async () => assert.strictEqual(await spillOf(), undefined));
  // 같은 모델의 할당 1 GiB가 카드에서 밀려나면(전용 → 공유) 넘침이다.
  feed((i) => [...lmApps, i < 5 ? proc(41904, 'llama-server', 5000, 3930, 9264) : proc(41904, 'llama-server', 6060, 2870, 9264)]);
  const self = await spillOf();
  await check('spill culprits ranked by GPU memory held, desktop background left out', () => {
    assert(self, 'vram_spill expected');
    assert.strictEqual(self.basis, 'gpu-memory');
    assert.strictEqual(self.culprits[0].name, 'llama-server'); assert(self.culprits[0].share >= 0.85, JSON.stringify(self.culprits));
    assert.strictEqual(self.culprits[0].dedicatedPeakMiB, 5000); assert.strictEqual(self.culprits[0].sharedPeakMiB, 3930);
    assert(!self.culprits.some((c) => c.name === 'dwm' || c.name === 'NVIDIA Overlay'));
    assert.strictEqual(self.process, 'llama-server'); assert.strictEqual(self.pid, 41904);
  });
  const selfObs = await governor.observe(deps);
  await check('LM Studio model spilling by itself: neither gate nor unload (LM Studio would reload it)', () => {
    assert.deepStrictEqual(governor.decide(selfObs), []);
  });
  await check('attributed spill records no unattributed gap', () => {
    assert(!gaps.detect(selfObs).some((g) => g.key === 'unattributed-vram_spill'));
  });
  await check('self-spill with queued local work: unload, keeping the model the queued work was routed to', () => {
    const a = governor.decide({ ...selfObs, slot: { waiting: 1 }, routedModel: 'google/gemma-4-12b' });
    assert.deepStrictEqual(a, [{ type: 'unload-idle-models', reason: 'local work queued', keep: 'google/gemma-4-12b' }]);
    assert.strictEqual(governor.decide({ ...selfObs, slot: { waiting: 1 } })[0].keep, undefined);
  });

  // 1.32.6 실측(2026-10-23): 보드 전용 82%인데 llama-server가 공유 3,754 MiB를 잡고 있었다(1.32.8~1.32.15는 넘침으로 셌다). LM Studio 임베딩 호스트는 공유 612 MiB.
  const live = [...desktop, proc(45560, 'LM Studio', 858, 612), proc(49524, 'llama-server', 5100, 3754, 45560), proc(21088, 'EpicGamesLauncher', 412, 4)];
  feed(live, { usedMiB: 6711, adapterSharedMiB: 3938, count: 12 });
  await check('model server shared memory with a roomy board is no spill', async () => assert.strictEqual(await spillOf(), undefined));
  // 보드에 여유가 있어도 1 GiB 넘게 밀려난 채 20초면 넘침이다(마지막 n개 표본에서 1,100 MiB가 전용 → 공유).
  const moving = (n) => (i) => [...live.slice(0, 3), i < n ? proc(49524, 'llama-server', 4000, 4854, 45560) : live[3], live[4]];
  feed(moving(11), { usedMiB: 6711, adapterSharedMiB: 4900, count: 12 });
  const roomy = await spillOf();
  await check('1 GiB+ moved to shared is a spill even with the board under 90%, culprits as before', () => {
    assert(roomy, 'vram_spill expected');
    assert.strictEqual(roomy.basis, 'gpu-memory'); assert.strictEqual(roomy.culprits[0].name, 'llama-server'); assert.strictEqual(roomy.culprits[0].sharedPeakMiB, 4854);
  });
  await check('that LM Studio-only spill starts no gate and no unload', async () => assert.deepStrictEqual(governor.decide(await governor.observe(deps)), []));
  feed(moving(10), { usedMiB: 6711, adapterSharedMiB: 4900, count: 12 });
  await check('a shared-only spill shorter than 20 s is not reported', async () => assert.strictEqual(await spillOf(), undefined));
  feed([...desktop, proc(5100, 'UnrealEditor', 3000, 1200)], { usedMiB: 4300, adapterSharedMiB: 1300, count: 12 });
  await check('1 GiB+ shared in a non-model process for 20 s is a spill with a roomy board', async () => assert.strictEqual((await spillOf())?.process, 'UnrealEditor'));
  feed([...desktop, proc(45560, 'LM Studio', 858, 612), proc(7700, 'EternalReturn', 2400, 361)], { usedMiB: 3300, adapterSharedMiB: 1000, count: 12 });
  await check('embedding host (612 MiB) and game staging (361 MiB) shared memory with a roomy board is no spill', async () => assert.strictEqual(await spillOf(), undefined));

  // UE 편집기가 VRAM 대부분을 차지하고 LM Studio의 노는 모델이 나머지를 잡은 경우.
  feed([...desktop, proc(5100, 'UnrealEditor', 5600, 900), proc(9264, 'LM Studio', 325, 144), proc(41904, 'llama-server', 1700, 300, 9264)]);
  await check('editor spill with an LM Studio model: gate and unload', async () => {
    const a = governor.decide(await governor.observe(deps));
    assert.deepStrictEqual(a.map((x) => x.type), ['gate-local-inference', 'unload-idle-models']); assert(/UnrealEditor/.test(a[0].reason));
  });

  // 게임이 밀려났고 llama-server는 부분 오프로드로 공유 3.5 GB를 들고 있다: 그 CPU 층은 카드를 차지하지 않으니 게임 몫을 깎지 않는다
  // (전용+공유로 재면 게임 몫 16%라 관문이 안 걸렸다).
  feed([...desktop, proc(7700, 'Cyberpunk2077', 1500, 300), proc(9264, 'LM Studio', 325, 144), proc(41904, 'llama-server', 5370, 3500, 9264)]);
  await check('a game pushed out next to a partly offloaded model: gate and unload', async () => {
    const a = governor.decide(await governor.observe(deps));
    assert.deepStrictEqual(a.map((x) => x.type), ['gate-local-inference', 'unload-idle-models']); assert(/Cyberpunk2077/.test(a[0].reason));
  });

  // 게임 혼자 넘친 경우: LM Studio는 원인이 아니다.
  feed([...desktop, proc(7700, 'Cyberpunk2077', 7100, 1300), proc(20576, 'EpicGamesLauncher', 349, 0)]);
  const game = await governor.observe(deps);
  await check('game spill without LM Studio: gate only, unload only when local work waits', () => {
    assert.deepStrictEqual(governor.decide(game).map((x) => x.type), ['gate-local-inference']);
    const q = governor.decide({ ...game, slot: { waiting: 1 } });
    assert.deepStrictEqual(q.map((x) => x.type), ['gate-local-inference', 'unload-idle-models']); assert.strictEqual(q[1].reason, 'local work queued');
  });
  await check('a launcher holding a few hundred MB is not a foreign cause', () => {
    const tiny = { findings: [{ kind: 'vram_spill', culprits: [{ app: 'lmstudio', name: 'llama-server', share: 0.95 }, { app: 'other', name: 'EpicGamesLauncher', share: 0.05 }] }] };
    assert.deepStrictEqual(governor.decide(tiny), []);
  });

  // 프로세스별 GPU 메모리 카운터가 없는 PC: 어댑터는 넘쳤는데 누구 것인지 모른다.
  feed([{ ...proc(7700, 'Cyberpunk2077', 0, 0), vd: 0, vs: 0 }, proc(9000, 'chrome', 0, 0)], { adapterSharedMiB: 1500 });
  const blind = await governor.observe(deps);
  await check('no per-process counters: spill reported without culprit, gated, and recorded as a gap', () => {
    const f = blind.findings.find((x) => x.kind === 'vram_spill');
    assert(f && f.culprits.length === 0, JSON.stringify(blind.findings));
    assert.deepStrictEqual(governor.decide(blind).map((x) => x.type), ['gate-local-inference']);
    assert(gaps.detect(blind).some((g) => g.key === 'unattributed-vram_spill'));
  });
  await check('shared memory with free dedicated VRAM is still not a spill', () => {
    const now = Date.now();
    const s = [0, 1, 2, 3, 4].map((i) => JSON.parse(line(now + i * 2000, [proc(1, 'LM Studio', 300, 400)], { usedMiB: 1200 })));
    assert(!analysis.findings(s, {}).some((f) => f.kind === 'vram_spill'));
  });

  await check('paging names LM Studio → unload; paging from another app → gate only', () => {
    assert.deepStrictEqual(governor.decide({ findings: [{ kind: 'paging', culprits: [{ app: 'llama.cpp', name: 'llama-server', share: 0.9 }] }] }).map((x) => x.type),
      ['gate-local-inference', 'unload-idle-models']);
    assert.deepStrictEqual(governor.decide({ findings: [{ kind: 'paging', culprits: [{ app: 'other', name: 'SetupHost', share: 0.9 }] }] }).map((x) => x.type), ['gate-local-inference']);
  });
  await check('unloadIdle keep: the kept model stays, the generating one is never unloaded', async () => {
    lmsCalls.length = 0;
    assert.deepStrictEqual((await gpufit.unloadIdle({ keep: 'google/gemma-4-12b' })).unloaded, ['qwen/qwen3-4b']);
    assert.deepStrictEqual(lmsCalls.filter((c) => c.startsWith('unload')), ['unload qwen/qwen3-4b']);
    lmsCalls.length = 0;
    assert.deepStrictEqual((await gpufit.unloadIdle({})).unloaded, ['google/gemma-4-12b', 'qwen/qwen3-4b']);
    assert(!lmsCalls.some((c) => c.includes('busy/model')));
  });
  await check('governor passes keep from the routed model to unloadIdle', async () => {
    let seen = null;
    const fake = { unloadIdle: async (o) => { seen = o; return { unloaded: [] }; }, lastRouted: () => 'google/gemma-4-12b' };
    assert.strictEqual((await governor.observe({ ...deps, gpufit: fake })).routedModel, 'google/gemma-4-12b');
    await governor.act([{ type: 'unload-idle-models', reason: 'local work queued', keep: 'google/gemma-4-12b' }], { gpufit: fake });
    assert.deepStrictEqual(seen, { keep: 'google/gemma-4-12b' });
  });
  await check('governor-eval: an unload that unloaded nothing is not counted as an unload', () => {
    // 막을 로컬 작업(로컬 슬롯을 쓰는 중)이 있던 관문 — 없으면 관문은 no-target으로 빠진다(test-judge-calibration).
    const d = { before: { findings: ['vram_spill'], busy: ['offload'], slotActive: 1 }, actions: [{ type: 'gate-local-inference', ok: true }, { type: 'unload-idle-models', ok: true, unloaded: [] }] };
    assert.deepStrictEqual(geval.judge(d, ['vram_spill']).types, ['gate-local-inference']);
    assert.deepStrictEqual(geval.judge({ ...d, actions: [{ type: 'unload-idle-models', ok: true, unloaded: ['m'] }] }, []).types, ['unload-idle-models']);
  });

  telemetry._test.flush();
  setTimeout(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
    console.log(`통과 ${passed} / 실패 ${failed}`);
    process.exit(failed ? 1 : 0);
  }, 200);
})();

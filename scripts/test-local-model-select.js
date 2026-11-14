'use strict';
// 서버가 꺼져 있을 때 잰 품질과 지금 예산으로 로컬 모델을 고르는지, HF 캐시 GGUF를 후보로 찾는지 본다(모델·프로세스 없음).
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const { choose, qualityOf } = require('../src/core/local-model-select');
const { cached } = require('../src/core/local-gguf-catalog');
const GIB = 1024 ** 3;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-select-fixture-'));
const gguf = (rel, bytes = 2048) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(bytes)])); return file; };

(async () => {
  try {
    // 1) HF 캐시: 첫 샤드만, mmproj 제외, 설정된 파일 제외, 헤더가 틀린 파일 제외
    const configured = gguf('models--a--b/snapshots/s1/configured-q4.gguf');
    gguf('models--a--b/snapshots/s1/other-q5_k_m.gguf');
    gguf('models--c--d/snapshots/s2/big-00001-of-00002.gguf'); gguf('models--c--d/snapshots/s2/big-00002-of-00002.gguf');
    gguf('models--c--d/snapshots/s2/mmproj-f16.gguf');
    fs.writeFileSync(path.join(root, 'models--c--d/snapshots/s2/broken.gguf'), Buffer.alloc(4096));
    const found = await cached({ root, exclude: [configured] });
    assert.deepEqual(found.map((m) => m.id).sort(), ['big-00001-of-00002', 'other-q5_k_m']);
    assert(found.every((m) => m.startup && !m.loaded && m.modelPath));
    assert.deepEqual(await cached({ root: path.join(root, 'missing') }), []);

    // 2) 품질 표는 ID 또는 GGUF 파일 이름으로 찾는다
    assert(qualityOf({ id: 'configured-local', label: 'qwen2.5-coder-7b-instruct-q5_k_m.gguf' }));
    assert.equal(qualityOf({ id: 'vendor/unmeasured-9b' }), null);

    // 3) 고르기: 잰 모델만, 예산에 들어가는 것 중 품질이 높고 GPU인 것
    const catalogs = {
      llamacpp: [{ id: 'qwen2.5-coder-7b-instruct-q5_k_m', label: 'qwen2.5-coder-7b-instruct-q5_k_m.gguf', sizeBytes: 5.4 * GIB, startup: true, loaded: false },
        { id: 'rlm-qwen3-8b-v0.1-q4_k_m', label: 'rlm-qwen3-8b-v0.1-q4_k_m.gguf', sizeBytes: 5 * GIB, startup: true, loaded: false }],
      lmstudio: [{ id: 'vendor/unmeasured-9b', sizeBytes: 6 * GIB, loaded: false }],
    };
    let gates = {};
    const deps = (over = {}) => ({
      control: { catalog: async (p) => { if (over.fail === p) throw new Error('down'); return catalogs[p]; } },
      hardware: { refresh: async () => {}, status: () => ({}), policy: () => ({}) },
      monitor: { snapshot: async () => ({ sampledAt: Date.now() }) },
      assess: ({ target }) => gates[target.id] || { admitted: true, expected: { placement: 'gpu' } },
    });
    const best = await choose({ deps: deps() });
    assert.equal(best.picked.model, 'qwen2.5-coder-7b-instruct-q5_k_m'); assert.equal(best.picked.provider, 'llamacpp');
    assert.equal(best.picked.placement, 'gpu'); assert.equal(best.picked.contextLength, 6144);
    // MoE 배치(전문가만 CPU)는 GPU 후보로 친다: 품질이 높으면 그대로 고르고 배치를 넘긴다
    gates = { 'qwen2.5-coder-7b-instruct-q5_k_m': { admitted: true, expected: { placement: 'moe' } } };
    assert.deepEqual([(await choose({ deps: deps() })).picked.model, (await choose({ deps: deps() })).picked.placement], ['qwen2.5-coder-7b-instruct-q5_k_m', 'moe']);
    // 품질이 높은 쪽이 CPU뿐이면 GPU에 들어가는 다음 후보
    gates = { 'qwen2.5-coder-7b-instruct-q5_k_m': { admitted: true, expected: { placement: 'cpu' } } };
    assert.equal((await choose({ deps: deps() })).picked.model, 'rlm-qwen3-8b-v0.1-q4_k_m');
    // 모두 CPU면 CPU라도 품질 순
    gates['rlm-qwen3-8b-v0.1-q4_k_m'] = { admitted: true, expected: { placement: 'cpu' } };
    assert.deepEqual([(await choose({ deps: deps() })).picked.model, (await choose({ deps: deps() })).picked.placement], ['qwen2.5-coder-7b-instruct-q5_k_m', 'cpu']);
    // 아무것도 안 들어가면 사유와 함께 고르지 않는다
    gates = { 'qwen2.5-coder-7b-instruct-q5_k_m': { admitted: false, reason: 'ram_pressure' }, 'rlm-qwen3-8b-v0.1-q4_k_m': { admitted: false, reason: 'gpu_busy' } };
    const none = await choose({ deps: deps() });
    assert.equal(none.picked, null); assert.equal(none.reason, 'no_measured_model_fits_budget'); assert.equal(none.detail.length, 2);
    // 잰 모델이 하나도 없으면(llama 쪽 읽기 실패) 어드바이저 경로로 넘긴다
    gates = {};
    assert.equal((await choose({ deps: deps({ fail: 'llamacpp' }) })).reason, 'no_measured_local_model');

    // 4) 큰 입력이 청한 창: 승인되면 그 창, 거절되면 예전 기본 창(6144), 올라간 모델은 이미 잡힌 창, 모델 상한은 넘지 않는다
    const seen = [];
    const ctxDeps = (refuseAbove) => ({ ...deps(), assess: ({ target, contextLength }) => { seen.push([target.id, contextLength]);
      return contextLength > refuseAbove ? { admitted: false, reason: 'projected_vram_exceeds_budget' } : { admitted: true, expected: { placement: 'gpu' } }; } });
    assert.equal((await choose({ contextLength: 12288, deps: ctxDeps(Infinity) })).picked.contextLength, 12288);
    assert.equal((await choose({ contextLength: 12288, deps: ctxDeps(8192) })).picked.contextLength, 6144);
    assert(seen.some(([, c]) => c === 12288) && seen.some(([, c]) => c === 6144), 'the wide window is judged by admission first');
    assert.equal((await choose({ contextLength: 2048, deps: ctxDeps(Infinity) })).picked.contextLength, 6144, 'never narrower than before');
    catalogs.llamacpp[0] = { ...catalogs.llamacpp[0], maxContext: 8192 };
    assert.equal((await choose({ contextLength: 12288, deps: ctxDeps(Infinity) })).picked.contextLength, 8192);
    catalogs.llamacpp[0] = { ...catalogs.llamacpp[0], loaded: true, contextLength: 4096 };
    seen.length = 0;
    const loaded = await choose({ contextLength: 12288, deps: ctxDeps(Infinity) });
    assert.deepEqual([loaded.picked.model, loaded.picked.contextLength], ['qwen2.5-coder-7b-instruct-q5_k_m', 4096], 'a loaded model is not reloaded, so its window is the real one');
    assert.deepEqual(seen.filter(([id]) => id === 'qwen2.5-coder-7b-instruct-q5_k_m').map(([, c]) => c), [4096]);
    // LM Studio는 적재된 인스턴스의 context_length(allocatedContextTokens)가 실제 창이다
    catalogs.lmstudio[0] = { id: 'google/gemma-4-12b', sizeBytes: 7 * GIB, loaded: true, allocatedContextTokens: 6144, maxContext: 262144 };
    seen.length = 0;
    await choose({ contextLength: 12288, deps: ctxDeps(Infinity) });
    assert.deepEqual(seen.filter(([id]) => id === 'google/gemma-4-12b'), [['google/gemma-4-12b', 6144]]);
    console.log('Local model select: HF-cache GGUF discovery (first shard, no mmproj/configured/broken), quality lookup, measured+budget choice, GPU before CPU, no-fit reasons, unmeasured never auto-picked');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exitCode = 1; });

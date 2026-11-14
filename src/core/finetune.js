// Fine-tuning dataset generator: samples code chunks from a source index and
// uses a local model to produce instruction/output pairs (Alpaca JSONL).
// Actual training happens in an external tool (Unsloth etc.) — LM Studio is
// inference-only. A GUIDE.md is written next to each dataset.
'use strict';

const fs = require('fs');
const path = require('path');
const { hubDataDir } = require('./paths');
const codeindex = require('./codeindex');
const delegator = require('./delegator');

const OUT_DIR = path.join(hubDataDir(), 'finetune');
const running = new Map(); // jobName -> {cancel, progress}

const GEN_SYSTEM = `You create fine-tuning data for an Unreal Engine coding assistant.
Given a C++ source excerpt from Unreal Engine, produce ONE high-quality training example as strict JSON:
{"instruction": "<a realistic developer question answerable from this code>", "output": "<accurate, concise answer with code references>"}
Rules: base everything ONLY on the given code; no invented APIs; answer in English; output ONLY the JSON object.`;

function jobs() {
  return [...running.entries()].map(([name, s]) => ({ name, ...s.progress }));
}

/**
 * Generate a dataset. Long-running; progress via onProgress; cancellable.
 * @param {{indexName:string, count:number, model?:string, jobName?:string}} p
 */
async function generate(p, onProgress) {
  // jobName becomes an output filename — never let it carry path separators
  const jobName = String(p.jobName || `${p.indexName}-${Date.now()}`)
    .replace(/[^\w.-]/g, '-').replace(/\.\.+/g, '.').slice(0, 80);
  if (running.has(jobName)) throw new Error('Job already running.');
  const count = Math.max(1, Math.min(2000, Number(p.count) || 100));
  const state = { cancel: false, progress: { phase: 'sampling', done: 0, total: count, ok: 0, failed: 0 } };
  running.set(jobName, state);
  const report = () => onProgress && onProgress({ job: jobName, ...state.progress });

  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    // 표본 추출: 파일을 돌아가며 뽑고(라운드로빈), 학습 가치가 낮은 청크는 건너뛴다.
    //
    // 예전에는 전체 목록을 일정 간격으로 훑었는데, 청크가 파일 순서대로 쌓여 있어
    // 거대한 파일 하나가 표본을 독차지했다. 또 #include 나열이나 전방 선언만 든
    // 청크로 Q&A를 만들면 "이 코드는 헤더를 포함합니다" 같은 쓸모없는 쌍이 나온다.
    const chunks = sampleForTraining(allChunksOf(p.indexName), count);
    state.progress.total = chunks.length;

    const outFile = path.join(OUT_DIR, `${jobName}.jsonl`);
    const fd = fs.openSync(outFile, 'w');
    state.progress.phase = 'generating';
    try {
      for (const chunk of chunks) {
        if (state.cancel) break;
        try {
          const r = await delegator.delegate({
            prompt: `Source file: ${chunk.file} (lines ${chunk.startLine}-${chunk.endLine})\n\n\`\`\`cpp\n${chunk.text.slice(0, 4000)}\n\`\`\``,
            taskType: 'custom',
            model: p.model || undefined,
            // 파이프라인에서 온 호출만 켠다(공유된 파이프라인의 모델은 이 컴퓨터에
            // 없을 수 있다). GUI에서 사용자가 직접 고른 모델은 오류로 알려야 한다.
            modelFallback: p.modelFallback === true,
            systemPrompt: GEN_SYSTEM,
            maxTokens: 900,
            temperature: 0.4,
          });
          // 왜 실패했는지를 구별해 센다. 예전엔 전부 failed 하나로 뭉쳐서, 모델이
          // 죽은 건지 JSON 규약만 못 지킨 건지 알 수 없었다 — 실측에서 코더 모델은
          // 세 번 다 정상 응답했는데도 1건이 failed로 잡혔고, 원인은 JSON이었다.
          // 모델을 바꿔야 하는 문제와 프롬프트를 고쳐야 하는 문제는 대응이 다르다.
          if (r.escalationRequested) {
            state.progress.failed += 1;
            state.progress.skipped = (state.progress.skipped || 0) + 1;
          } else {
            const m = r.content.match(/\{[\s\S]*\}/);
            const obj = JSON.parse(m ? m[0] : r.content);
            if (obj.instruction && obj.output) {
              fs.writeSync(fd, JSON.stringify({
                instruction: String(obj.instruction),
                input: '',
                output: String(obj.output),
                meta: { file: chunk.file, lines: `${chunk.startLine}-${chunk.endLine}` },
              }) + '\n');
              state.progress.ok += 1;
            } else {
              state.progress.failed += 1;
              state.progress.badJson = (state.progress.badJson || 0) + 1;
            }
          }
        } catch (err) {
          state.progress.failed += 1;
          // JSON.parse만 여기서 던진다(위임 실패는 delegate가 자기 오류를 던진다).
          const key = err instanceof SyntaxError ? 'badJson' : 'callFailed';
          state.progress[key] = (state.progress[key] || 0) + 1;
        }
        state.progress.done += 1;
        report();
      }
    } finally {
      fs.closeSync(fd);
    }
    writeGuide();
    state.progress.phase = state.cancel ? 'cancelled' : 'done';
    report();
    return {
      jobName, outFile, ok: state.progress.ok, failed: state.progress.failed,
      // 실패 내역: badJson(모델은 답했는데 JSON 규약 위반) / callFailed(호출 자체 실패)
      // / skipped(컨텍스트가 모자라 아예 부르지 않음). 대응이 서로 다르다.
      badJson: state.progress.badJson || 0,
      callFailed: state.progress.callFailed || 0,
      skipped: state.progress.skipped || 0,
    };
  } finally {
    running.delete(jobName);
  }
}

function allChunksOf(indexName) {
  // reuse the index's chunk store via codeindex internals
  const dir = path.join(codeindex.INDEX_ROOT, indexName);
  return fs.readFileSync(path.join(dir, 'chunks.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** 학습 쌍을 만들 만한 내용이 있는 청크인가 — 선언·include만 있는 건 버린다. */
function isTrainable(chunk) {
  const text = chunk.text || '';
  if (text.length < 200) return false;
  const lines = text.split('\n');
  const meaningful = lines.filter((l) => {
    const t = l.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
    if (/^#include\b/.test(t)) return false;
    if (/^(class|struct)\s+\w+\s*;$/.test(t)) return false; // 전방 선언
    return true;
  });
  if (meaningful.length < 6) return false;
  // 본문(중괄호 블록)이 하나라도 있어야 설명할 로직이 있다.
  return text.includes('{') && text.includes('}');
}

/**
 * 파일을 돌아가며 균등하게 뽑는다. 한 파일이 표본을 독차지하지 않게 하고,
 * 학습 가치가 낮은 청크는 제외한다.
 */
function sampleForTraining(all, count) {
  const byFile = new Map();
  for (const c of all) {
    if (!isTrainable(c)) continue;
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file).push(c);
  }
  // 후보가 너무 적으면 필터를 풀어 원래 방식으로 되돌린다(빈 데이터셋 방지).
  if (byFile.size === 0) {
    const step = Math.max(1, Math.floor(all.length / count));
    const list = [];
    for (let i = 0; i < all.length && list.length < count; i += step) list.push(all[i]);
    return list;
  }
  const queues = [...byFile.values()];
  const picked = [];
  for (let round = 0; picked.length < count; round++) {
    let addedThisRound = 0;
    for (const q of queues) {
      if (picked.length >= count) break;
      if (round < q.length) {
        // 파일 안에서도 앞부분만 쏠리지 않게 간격을 두고 고른다.
        const stride = Math.max(1, Math.floor(q.length / Math.max(1, Math.ceil(count / queues.length))));
        const idx = Math.min(q.length - 1, round * stride);
        picked.push(q[idx]);
        addedThisRound++;
      }
    }
    if (!addedThisRound) break; // 더 뽑을 게 없음
  }
  return picked;
}

function cancel(jobName) {
  const s = running.get(jobName);
  if (s) s.cancel = true;
  return Boolean(s);
}

function listDatasets() {
  try {
    return fs.readdirSync(OUT_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const p = path.join(OUT_DIR, f);
        const st = fs.statSync(p);
        return { file: f, path: p, sizeKB: Math.round(st.size / 1024), mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch {
    return [];
  }
}

function writeGuide() {
  const guide = `# 파인튜닝 가이드 (UE 코딩 어시스턴트)

이 폴더의 .jsonl 파일은 Alpaca 형식(instruction/input/output)입니다.

## 권장 경로: Unsloth (무료, 로컬 GPU)
1. Python 3.11 + CUDA 환경에서: \`pip install unsloth\`
2. 베이스 모델은 LM Studio에서 쓰던 것과 같은 계열 권장 (예: Qwen2.5-Coder-14B)
3. 학습 스크립트 예시:
\`\`\`python
from unsloth import FastLanguageModel
from datasets import load_dataset
model, tokenizer = FastLanguageModel.from_pretrained("unsloth/Qwen2.5-Coder-14B-Instruct", load_in_4bit=True)
model = FastLanguageModel.get_peft_model(model, r=16, lora_alpha=16)
ds = load_dataset("json", data_files="<이 폴더의 파일>.jsonl", split="train")
# alpaca 포맷팅 후 SFTTrainer로 학습 (Unsloth 공식 노트북 참고)
\`\`\`
4. 학습 후 GGUF로 내보내기: \`model.save_pretrained_gguf("out", tokenizer, quantization_method="q4_k_m")\`
5. 생성된 .gguf를 LM Studio 모델 폴더(내 모델 → 폴더 열기)에 넣으면 허브에서 바로 사용 가능

## 주의
- VRAM 12GB 미만이면 7B/8B 베이스 + 4bit LoRA 권장
- 데이터 품질이 전부입니다: GUI에서 생성된 쌍을 훑어보고 이상한 항목은 지우세요
- Epic Games EULA상 UE 소스 기반 산출물은 개인/팀 내부 사용으로 제한하세요 (모델 공개 배포 금지)
`;
  fs.writeFileSync(path.join(OUT_DIR, 'GUIDE.md'), guide, 'utf8');
}

module.exports = { generate, cancel, listDatasets, jobs, OUT_DIR, sampleForTraining, isTrainable };

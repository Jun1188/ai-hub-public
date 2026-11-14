'use strict';

const fs = require('fs');

/** flatten an MCP tools/call result into log text + error flag */
function mcpResultToLog(result) {
  if (result === null || result === undefined || typeof result !== 'object') {
    return { text: String(result ?? ''), isError: false };
  }
  const isError = result.isError === true;
  if (!Array.isArray(result.content)) return { text: JSON.stringify(result, null, 2), isError };
  const parts = [];
  for (const item of result.content) {
    if (item && typeof item === 'object' && typeof item.text === 'string') parts.push(item.text);
    else parts.push(JSON.stringify(item));
  }
  return { text: parts.join('\n') || '(빈 응답)', isError };
}

async function executeAiStep(step, stepIndex, run, ctx, { appendLog, readStepInput, substituteVars }) {
  const delegator = require('./delegator'); // lazy: avoid startup cycles

  let input = '';
  if (step.inputFrom === 'previousLog' && stepIndex > 0) {
    input = await readStepInput(run.record.runId, stepIndex - 1);
    if (run.cancelled) return -1;
    if (input.length > 60000) input = input.slice(-60000); // keep prompt bounded for local models
  } else if (step.inputFrom === 'file' && step.inputPath) {
    const p = substituteVars(step.inputPath, ctx);
    // 입력 파일이 없으면 실패다 — 빈 입력으로 모델을 부르면 근거 없는 답이 "성공"으로 남는다.
    if (!fs.existsSync(p)) { appendLog(run.record.runId, stepIndex, `[hub] AI 스텝 입력 파일이 없습니다: ${p}\r\n`, 'stderr'); return 1; }
    input = fs.readFileSync(p, 'utf8');
  }

  // function replacement — a plain string would expand `$&` patterns inside log content
  const prompt = substituteVars(step.promptTemplate, ctx).replace('{{input}}', () => input);
  appendLog(run.record.runId, stepIndex, `[hub] AI 스텝 (${step.taskType || 'reasoning'}) — 로컬 모델에 위임 중…\r\n`, 'stdout');

  const out = await delegator.delegate({
    prompt,
    taskType: step.taskType,
    model: step.model || undefined,
    modelFallback: true, // 공유된 파이프라인의 모델이 이 컴퓨터엔 없을 수 있다 — 실패 대신 자동 선택
    source: 'pipeline',
    maxTokens: step.maxTokens || undefined,
    temperature: step.temperature,
  });
  if (run.cancelled) return -1;
  if (out.modelFallback) appendLog(run.record.runId, stepIndex, `[hub] 지정 모델 "${out.modelFallback.requested}"이 없어 ${out.modelFallback.used}(으)로 대체했습니다.\r\n`, 'stderr');
  const text = out.content || '';

  if (step.outputTo === 'file' && step.outputPath) {
    const outPath = substituteVars(step.outputPath, ctx);
    fs.writeFileSync(outPath, text, 'utf8');
    appendLog(run.record.runId, stepIndex, `[hub] 결과를 저장했습니다: ${outPath} (모델: ${out.model})\r\n`, 'stdout');
  } else {
    appendLog(run.record.runId, stepIndex, `\r\n${text.replace(/\n/g, '\r\n')}\r\n[hub] (모델: ${out.model})\r\n`, 'stdout');
  }
  if (out.escalationRequested) {
    appendLog(run.record.runId, stepIndex, `[hub] 로컬 모델이 NEEDS_ESCALATION을 반환했습니다 — 상위 AI 확인이 필요합니다.\r\n`, 'stderr');
    return 1;
  }
  return 0;
}

/** semantic source indexing as a pipeline step (UE/C++ 소스 트리 등) */
async function executeSourceIndexStep(step, stepIndex, run, ctx, { appendLog, substituteVars }) {
  const codeindex = require('./codeindex'); // lazy: avoid startup cycles
  if (!step.index || !step.root) throw new Error('source-index 스텝에는 index(인덱스 이름)와 root(소스 경로)가 필요합니다.');
  const root = substituteVars(step.root, ctx);
  const name = substituteVars(step.index, ctx);

  appendLog(run.record.runId, stepIndex, `[hub] 소스 인덱싱 시작: "${name}" ← ${root}\r\n`, 'stdout');
  run.cancelHook = () => codeindex.cancelBuild(name);
  let lastLog = 0;
  try {
    const meta = await codeindex.buildIndex(
      { name, root, exts: step.exts || undefined, maxChunks: step.maxChunks || undefined },
      (p) => {
        const now = Date.now();
        if (now - lastLog > 2000 || p.phase === 'done') {
          lastLog = now;
          appendLog(run.record.runId, stepIndex, `[hub] ${p.phase} files=${p.files} chunks=${p.chunks} embedded=${p.embedded}/${p.total}\r\n`, 'stdout');
        }
      }
    );
    appendLog(run.record.runId, stepIndex, `[hub] 인덱스 완료: ${meta.chunkCount} 청크, ${meta.classCount} 클래스\r\n`, 'stdout');
    return 0;
  } finally {
    run.cancelHook = null;
  }
}

/** Alpaca JSONL 파인튜닝 데이터셋 생성을 파이프라인 스텝으로 */
async function executeFinetuneStep(step, stepIndex, run, ctx, { appendLog, substituteVars }) {
  const finetune = require('./finetune'); // lazy: avoid startup cycles
  if (!step.indexName) throw new Error('finetune-gen 스텝에는 indexName이 필요합니다.');
  const jobName = step.jobName ? substituteVars(step.jobName, ctx) : `${step.indexName}-run-${run.record.runId.slice(0, 8)}`;

  appendLog(run.record.runId, stepIndex, `[hub] 파인튜닝 데이터셋 생성 시작: index="${step.indexName}" count=${step.count || 100}\r\n`, 'stdout');
  run.cancelHook = () => finetune.cancel(jobName);
  let lastLog = 0;
  try {
    const r = await finetune.generate(
      { indexName: step.indexName, count: step.count, model: step.model, jobName, modelFallback: true },
      (p) => {
        const now = Date.now();
        if (now - lastLog > 3000 || p.phase === 'done' || p.phase === 'cancelled') {
          lastLog = now;
          appendLog(run.record.runId, stepIndex, `[hub] ${p.phase} ${p.done}/${p.total} (ok=${p.ok} failed=${p.failed})\r\n`, 'stdout');
        }
      }
    );
    if (run.cancelled) return -1;
    appendLog(run.record.runId, stepIndex, `[hub] 데이터셋 완료: ${r.outFile} (샘플 ${r.ok}개, 실패 ${r.failed}개)\r\n` +
      `[hub] 학습 절차는 같은 폴더의 GUIDE.md 참고 (Unsloth LoRA → GGUF → LM Studio)\r\n`, 'stdout');
    return r.ok > 0 ? 0 : 1;
  } finally {
    run.cancelHook = null;
  }
}

async function executeMcpStep(step, stepIndex, run, ctx, { appendLog, substituteVars }) {
  const downstream = require('./downstream'); // lazy: avoid startup cycles

  let args = {};
  if (step.argsJson && step.argsJson.trim()) {
    const raw = substituteVars(step.argsJson, ctx);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`argsJson 파싱 실패: ${String(e.message || e)}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('argsJson은 JSON object여야 합니다 (예: {"source": "..."} )');
    }
    args = parsed;
  }

  appendLog(
    run.record.runId, stepIndex,
    `[hub] MCP 도구 호출: ${step.server} / ${step.tool}\r\n[hub] args: ${JSON.stringify(args)}\r\n\r\n`,
    'stdout'
  );

  const result = await downstream.callTool(step.server, step.tool, args);
  if (run.cancelled) return -1;

  const { text, isError } = mcpResultToLog(result);
  appendLog(run.record.runId, stepIndex, `${text.replace(/\r?\n/g, '\r\n')}\r\n`, isError ? 'stderr' : 'stdout');
  return isError ? 1 : 0;
}

module.exports = { executeAiStep, executeMcpStep, executeSourceIndexStep, executeFinetuneStep, mcpResultToLog };

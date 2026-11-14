// ComfyUI and llama.cpp pipeline steps kept outside pipeline.js's line budget.
'use strict';

const localRuntime = require('./local-runtime');

async function execute(step, stepIndex, run, ctx, io) {
  if (step.type === 'llama-chat') return runLlama(step, stepIndex, run, ctx, io);
  if (step.type === 'comfy-workflow') return runComfy(step, stepIndex, run, ctx, io);
  return null;
}

async function runLlama(step, stepIndex, run, ctx, io) {
  const prompt = io.substituteVars(String(step.prompt || ''), ctx);
  if (!prompt) throw new Error('llama-chat 스텝에는 prompt가 필요합니다.');
  io.appendLog(run.record.runId, stepIndex, '[hub] llama.cpp 로컬 위임\r\n\r\n', 'stdout');
  const models = await localRuntime.listModelsDetailed();
  const result = await localRuntime.chat({
    signal:run.abort?.signal,
    model: step.model || (models[0] && models[0].id),
    messages: [
      ...(step.systemPrompt ? [{ role: 'system', content: io.substituteVars(step.systemPrompt, ctx) }] : []),
      { role: 'user', content: prompt },
    ],
    temperature: step.temperature === undefined ? 0.2 : Number(step.temperature),
    maxTokens: Number(step.maxTokens) || 4096,
    timeoutMs: Number(step.timeoutMs) || 600000,
    imagePath: step.imagePath ? io.substituteVars(step.imagePath, ctx) : undefined,
  });
  if (run.cancelled) return -1;
  io.appendLog(run.record.runId, stepIndex, `${result.content.replace(/\r?\n/g, '\r\n')}\r\n`, 'stdout');
  return result.content && result.finishReason!=='length' ? 0 : 1;
}

async function runComfy(step, stepIndex, run, ctx, io) {
  const workflowFile = io.substituteVars(String(step.workflowFile || ''), ctx);
  if (!workflowFile) throw new Error('comfy-workflow 스텝에는 workflowFile이 필요합니다.');
  let inputs = {};
  if (step.inputsJson) {
    try { inputs = JSON.parse(io.substituteVars(step.inputsJson, ctx)); }
    catch (err) { throw new Error(`inputsJson 파싱 실패: ${String(err.message || err)}`); }
  }
  io.appendLog(run.record.runId, stepIndex, `[hub] ComfyUI 워크플로: ${workflowFile}\r\n\r\n`, 'stdout');
  const result = await localRuntime.comfyWorkflow({
    signal: run.abort?.signal,
    vramMiB: Number(step.vramMiB) || undefined,
    workflowFile,
    inputs,
    timeoutMs: Number(step.timeoutMs) || 600000,
    loras: Array.isArray(step.loras) ? step.loras : undefined,
    loraTarget: step.loraTarget,
  });
  if (run.cancelled) return -1;
  io.appendLog(run.record.runId, stepIndex, `${JSON.stringify(result, null, 2).replace(/\n/g, '\r\n')}\r\n`, 'stdout');
  return 0;
}

module.exports = { execute };
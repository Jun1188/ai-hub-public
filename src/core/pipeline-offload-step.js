'use strict';
// Graph step that delegates through offload: the Hub reads the files, the worker returns compact schema-checked
// results into graph state (last.data). Declined or failed → exit 1, so the graph can route to a review node
// and the main agent does the work itself instead of waiting on a model that cannot do it.
const STATE_BUDGET = 48 * 1024; // pipeline state is capped at 64 KiB per step
const INLINE_MAX = 200 * 1024;

// inline: the Hub reads the (small) files and passes them as the input text instead of asking the worker to read them.
// Codex's file-read helper sometimes fails to start ("helper_unknown_error"), and the worker then honestly returns an
// empty proposal (2026-10-23 live L1: the INV proposer could not read brief.md). Over the cap is an error, not a silent cut.
async function inlineFiles(files) {
  const fs = require('fs');
  const path = require('path');
  const parts = [];
  let total = 0;
  for (const f of files) {
    const text = (await fs.promises.readFile(f, 'utf8')).replace(/^\uFEFF/, '');
    total += Buffer.byteLength(text);
    if (total > INLINE_MAX) throw Object.assign(new Error(`inline files exceed ${INLINE_MAX} bytes`), { code: 'inline_too_large' });
    parts.push(`### ${path.basename(f)}\n${text}`);
  }
  return parts.join('\n\n');
}

function compact(r) {
  const data = { state: r.state, reason: r.reason || null, verification: r.verification, usage: r.usage, route: r.route,
    hardware: r.hardware || null, failures: (r.failures || []).slice(0, 20), results: [], truncated: false };
  for (const item of r.results || []) {
    data.results.push(item);
    if (Buffer.byteLength(JSON.stringify(data)) > STATE_BUDGET) { data.results.pop(); data.truncated = true; break; }
  }
  return data;
}

async function execute(step, index, run, ctx, io) {
  const offload = require('./offload');
  let files = (step.files || []).map((f) => io.substituteVars(f, ctx));
  let text = step.text ? io.substituteVars(step.text, ctx) : undefined;
  if (step.inline === true && files.length) { const inlined = await inlineFiles(files); text = text ? `${text}

${inlined}` : inlined; files = []; }
  const id = offload.run({ task: io.substituteVars(step.task, ctx), files,
    text, schema: step.schema, worker: step.worker || 'local',
    model: step.model, tier: step.tier, maxOutputTokens: step.maxOutputTokens, expert: step.expert });
  // 자원 기록의 작업 ID(offload.js telemetryHooks가 붙이는 이름)를 단계에 남겨, 검토 화면이 이 노드의 작업을 정확히 찾게 한다.
  if (run.record.steps?.[index]) run.record.steps[index].jobId = 'offload-' + id;
  run.cancelHook = () => offload.cancel(id);
  let r;
  try { do { r = await offload.wait(id, 50); } while (r.state === 'running' && !run.cancelled); }
  finally { run.cancelHook = null; }
  const data = compact(r);
  require('./pipeline-state-graph').clean(data);
  run.graphStepData = data;
  io.appendLog(run.record.runId, index, `[offload] ${r.state}${r.reason ? ` (${r.reason})` : ''} worker=${r.route?.worker} model=${r.route?.model || '-'} `
    + `results=${data.results.length}${data.truncated ? '+' : ''} schemaInvalid=${r.verification?.schemaInvalid ?? 0} ms=${r.usage?.workerMs ?? '-'}\n`, 'stdout');
  return r.state === 'succeeded' ? 0 : 1;
}

module.exports = { execute, compact, inlineFiles, INLINE_MAX };

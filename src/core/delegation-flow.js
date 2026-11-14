// Live role map of delegation, numbers first: what the calling agents used (MCP calls and response bytes ≈ their
// token cost), what was offloaded and how it ended, and which pipelines are running. In-memory only.
'use strict';

const ROLES = [
  ['deterministic', /^(symbol_|ue_|analysis_|source_read|source_search|source_index_status|render_pipeline_map|deep_analysis_briefing|project_list)/],
  ['local-model', /^(source_qa|render_pipeline_analyze|local_model_|local_llama_|comfy_)/],
  ['offload', /^offload_/],
  ['aider', /^aider_/],
  ['pipelines', /^(devpipeline_|dev_pipeline_graph_|api_)/],
  ['resources', /^(local_resource_status|resource_timeline|local_runtime_status|hub_status|render_monitor|process_inspect|frame_capture_analyze)/],
  ['downstream', /^downstream_/],
];
const roleOf = (tool) => (ROLES.find(([, re]) => re.test(tool)) || ['other'])[0];

function snapshot(deps = {}) {
  const roles = {};
  for (const [tool, s] of Object.entries(require('./tool-usage').snapshot())) {
    const r = roles[roleOf(tool)] || (roles[roleOf(tool)] = { calls: 0, errors: 0, bytes: 0, ms: 0, tools: {} });
    r.calls += s.calls; r.errors += s.errors; r.bytes += s.bytes; r.ms += s.ms;
    r.tools[tool] = { calls: s.calls, bytes: s.bytes };
  }
  const offload = require('./offload'), recent = offload.list().slice(-12);
  const totals = { succeeded: 0, declined: 0, failed: 0, cancelled: 0, workerMs: 0, outputTokens: 0, energyWh: 0 };
  for (const r of recent) {
    if (r.state in totals) totals[r.state]++;
    totals.workerMs += r.usage?.workerMs || 0; totals.outputTokens += r.usage?.outputTokens || 0; totals.energyWh += r.hardware?.energyWh || 0;
  }
  totals.energyWh = Math.round(totals.energyWh * 100) / 100;
  return { at: Date.now(), roles, offload: { active: offload.active(), recent: recent.map((r) => ({ id: r.id, state: r.state, worker: r.worker,
    model: r.model, workerMs: r.usage?.workerMs ?? null, outputTokens: r.usage?.outputTokens ?? null, schemaInvalid: r.verification?.schemaInvalid ?? 0,
    energyWh: r.hardware?.energyWh ?? null, reason: r.reason || null })), totals },
  pipelines: deps.pipeline ? deps.pipeline.running() : [], telemetry: require('./telemetry').status() };
}

module.exports = { snapshot, roleOf };

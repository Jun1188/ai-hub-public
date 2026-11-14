// MCP: who used which hardware, when and how much — from the continuous telemetry record.
'use strict';
const { z } = require('zod');
const telemetry = require('../core/telemetry');

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

function register(server) {
  server.registerTool('resource_timeline', {
    title: 'Per-process hardware usage over time',
    description: 'Summarize the continuous hardware record for the last `since_s` seconds (full rate 30 min, 10-s buckets 2 days) or one Hub job: machine CPU/GPU/VRAM/power, top processes with their app or Hub job, and findings (VRAM spill, GPU contention, throttling, paging, disk or CPU saturation) with `culprits` ranked by share. With Unreal/Unity running, `dev` splits each editor into roles (shader compile, import, build, DDC...) with editor-log events and profile artifacts for ue_profile_summary. export_trace writes a local Chrome/Perfetto trace and returns its path. Never loads models.',
    inputSchema: { since_s: z.number().int().min(10).max(172800).optional(), job_id: z.string().max(160).optional(),
      top: z.number().int().min(1).max(20).optional(), export_trace: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const report = await telemetry.report({ sinceSeconds: a.since_s ?? 600, jobId: a.job_id, top: a.top ?? 6 });
    if (a.export_trace) report.trace = await telemetry.exportTrace({ sinceSeconds: a.since_s ?? 600 });
    return text(report);
  });
}

module.exports = { register };

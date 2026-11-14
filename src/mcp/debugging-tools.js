// MCP: live debugging of one process — what bounds its rendering, and what it holds (threads, mapped files, hardware) —
// and what one captured frame spends its GPU time on.
'use strict';
const { z } = require('zod');
const renderMonitor = require('../core/debugging/render-monitor');
const processInspect = require('../core/debugging/process-inspect');
const frameCapture = require('../core/debugging/frame-capture');

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

function register(server) {
  server.registerTool('render_monitor', {
    title: 'Live render-stage bottleneck of one process',
    description: 'Watch one process for `seconds` (default 15; without `pid`, the heaviest GPU user) and name the saturated stage: `gpu`, `render-thread`, `rhi-thread`, `game-thread` or `none`, with advice, from per-thread CPU by name, GPU engines, throttling and Unreal/Unity render log events. `frames` adds PresentMon frame times (fps, p50/p99, GPU-busy share) when PresentMon is installed and this account may trace; otherwise `frames` is null and `framesError` says why. No admin, never loads models.',
    inputSchema: { pid: z.number().int().positive().optional(), seconds: z.number().int().min(5).max(40).optional() },
    annotations: { readOnlyHint: true },
  }, async (a) => text(await renderMonitor.monitor({ pid: a.pid ?? null, seconds: a.seconds ?? 15 })));

  server.registerTool('process_inspect', {
    title: 'What one process holds right now',
    description: 'Inspect one process for `seconds` (default 5): CPU/GPU-engine/VRAM/IO/hard-fault usage from the continuous record, its busiest threads by name and engine role, and its memory-mapped files (models, paks, DLLs) with mapped size, resident size and changes in resident size. The process counter and mapped-file growth do not identify a fault backing file. Paths under the user profile are shown as %USERPROFILE%. Elevated or protected processes return `filesError: open_failed`. No admin.',
    inputSchema: { pid: z.number().int().positive(), seconds: z.number().int().min(2).max(20).optional() },
    annotations: { readOnlyHint: true },
  }, async (a) => text(await processInspect.inspect({ pid: a.pid, seconds: a.seconds ?? 5 })));

  server.registerTool('frame_capture_analyze', {
    title: 'What one captured frame spends its GPU time on',
    description: 'For a Windows RenderDoc structured XML export (up to 16 MiB), read frame API calls and recorded numeric arguments without replay. Analyze an existing RenderDoc capture (`path` to an .rdc the user made) through rdc-cli: event and draw counts, passes ranked by GPU time (engine markers when present, `passBasis`), the `top` (default 10) costliest draws, the largest resources, and `source` file:line from render_pipeline_map. GPU times come from replaying on this GPU (`gpu.basis: replay`); when the duration counter is empty, passes rank by triangles then dispatches and `countersError` says so. Never launches or injects into a program; waits for the Hub GPU slot. Errors: rdc_not_found, not_rdc, capture_not_found, frame_capture_busy, renderdoc_unavailable.',
    inputSchema: { path: z.string().min(1), top: z.number().int().min(1).max(50).optional() },
    annotations: { readOnlyHint: true },
  }, async (a) => text(await frameCapture.analyze({ path: a.path, top: a.top ?? 10 })));
}

module.exports = { register };

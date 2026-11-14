// MCP tools for the offload path (src/core/offload.js). Results are compact JSON — never the task,
// file contents or prompts — so a caller spends one call per finished job instead of polling sessions.
'use strict';

const { z } = require('zod');

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const waitS = z.number().int().min(0).max(50).optional()
  .describe('Seconds to wait server-side for completion (0-50, default 45).');

function register(server) {
  const offload = require('../core/offload');
  const { AGY_TIERS } = require('../core/agent-workers');
  server.registerTool('offload_run', {
    title: 'Offload bounded extraction to a worker',
    description: 'Give large inputs (files or text) to a worker that reads them and returns only small schema-checked results: '
      + 'extraction, classification, format conversion. Never edits; reasoning only with worker "agy" tier "reasoning" or "deep". '
      + 'Below the break-even read the files yourself: each offload call or wait is one more round trip that re-sends your whole '
      + 'context. worker "local" (default): this PC\'s local model, one call per chunk, only for more than about 25 KB in total; '
      + 'state "declined" with a reason when hardware or models '
      + 'cannot take it, then do the work yourself (never a cloud fallback). "codex" (read-only Codex CLI) and "agy" (Antigravity, '
      + 'Gemini 4, the user\'s quota) only when requested; agy only for about 100 KB or more in total (each run costs ~20k input '
      + 'tokens before reading), and bundle small jobs with "tasks" into one run. Declines (agy_auth, agy_quota_exhausted, '
      + 'blocked_secret_like_text, ...) never switch worker or tier. Waits up to wait_s; if still "running", call offload_wait.',
    inputSchema: {
      task: z.string().min(1).max(8000).optional().describe('Instruction applied to each file chunk (or the text). Give task or tasks.'),
      tasks: z.array(z.object({ task: z.string().min(1).max(8000), files: z.array(z.string()).max(64).optional(), text: z.string().max(2097152).optional(),
        schema: z.record(z.string(), z.any()) })).min(2).max(16).optional()
        .describe('worker "agy" only, instead of task/files/text/schema: 2-16 small independent tasks with their own inputs and '
          + 'item schema, answered in one agy run. Results and failures carry "task" (1-based); only tasks with invalid items are re-run, once.'),
      files: z.array(z.string()).max(64).optional().describe('Absolute paths read by the worker. Contents are never returned.'),
      text: z.string().max(2097152).optional().describe('Inline input when there is no file.'),
      schema: z.record(z.string(), z.any()).optional().describe('JSON Schema for each result item; items are validated and an invalid item is retried once. '
        + 'A valid empty list from codex/agy succeeds with results: [] (zero results), unless an input could not be read.'),
      worker: z.enum(['local', 'codex', 'agy']).optional(),
      model: z.string().min(1).max(128).optional().describe('worker "agy" only: exact Gemini 4 model ID from agy models, '
        + 'e.g. gemini-4-hydrogen-low. Use model or tier, not both. Effort follows the model suffix; unavailable models are declined without fallback.'),
      tier: z.enum(AGY_TIERS).optional().describe('worker "agy" only, all Gemini 4. "fast" (default): extraction, summary, '
        + 'conversion, short classification. "reasoning": verdicts with evidence, root-cause tracing. "deep": highest effort for '
        + 'comparing designs and decisions, slower and costlier. If "reasoning" or "deep" is declined, do not retry another tier: '
        + 'hand the task to the user (they prefer the Gemini desktop app, which the Hub cannot reach) or do it yourself.'),
      max_output_tokens: z.number().int().min(64).max(8192).optional(),
      expert: z.boolean().optional().describe('Wrap task with the expert framework when expert_reprompt rules apply (no schema, no tasks); result.expert says why not.'),
      wait_s: waitS,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (a) => text(await offload.runAndWait({ task: a.task, tasks: a.tasks, files: a.files, text: a.text, schema: a.schema,
    worker: a.worker, model: a.model, tier: a.tier, maxOutputTokens: a.max_output_tokens, expert: a.expert }, a.wait_s ?? 45)));

  // 위임 프롬프트를 감싸는 도구라 offload 곁에 둔다. 설명은 짧게 — 도구 정의는 모든 클라이언트 요청마다 다시 실린다.
  server.registerTool('expert_reprompt', {
    title: 'Expert re-prompt (deterministic gate)',
    description: 'For deep analysis, design, planning, research or report work: fixed rules decide whether the user\'s expert framework '
      + 'applies; if so the request comes back behind its byte-fixed prefix (forward the prompt whole so prompt caches hit). '
      + 'Chat, lookups, arithmetic, translation and settings return only the verdict: answer those directly. No model call.',
    inputSchema: { request: z.string().min(1).max(8000), target: z.enum(['agent', 'local']).optional(), force: z.boolean().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (a) => text(require('../core/expert-reprompt').reprompt(a.request, { target: a.target, force: a.force })));

  server.registerTool('offload_wait', {
    title: 'Wait for an offload job',
    description: 'Long-poll an offload job: returns as soon as it finishes, or after wait_s, with the same compact result as '
      + 'offload_run. Use this instead of sleeping or polling in a loop — a 3-minute job takes about 4 calls.',
    inputSchema: { id: z.string().uuid(), wait_s: waitS },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (a) => text(await offload.wait(a.id, a.wait_s ?? 45)));

  server.registerTool('offload_cancel', {
    title: 'Cancel an offload job',
    description: 'Cancel a running offload job. Results already produced stay readable with offload_wait.',
    inputSchema: { id: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (a) => text(offload.cancel(a.id)));
}

module.exports = { register };

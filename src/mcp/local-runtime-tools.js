// MCP tools for local runtime observability and ComfyUI API workflows.
'use strict';

const { z } = require('zod');
const runtime = require('../core/local-runtime');
const aider = require('../core/aider-studio');

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function registerLocalRuntimeTools(server) {
  const models = require('../core/model-control');
  server.registerTool('local_llama_configure', {
    description:'Select one existing local GGUF for authorized future llama.cpp preparation. Validates the file and stores its path in device-only config. Does not start, download, copy, unload or infer. Never share this path.',
    inputSchema:{model_file:z.string()},
  },async a=>text(await require('../core/llama-model-config').select(a.model_file)));
  server.registerTool('local_model_catalog', {
    description: 'Discover exact model IDs and loaded states. Read-only; never downloads a model.',
    inputSchema: { provider: z.enum(['lmstudio', 'llamacpp']) },
  }, async a => text((await models.catalog(a.provider)).map(({modelPath,mmprojPath,...m})=>(mmprojPath?{...m,vision:true}:m))));
  server.registerTool('local_model_prepare', {
    description: 'Load an existing local model for an authorized task. Returns a requestId immediately. Reuse local_model_operation to poll; do not resubmit during delay. Refuses active offload/Aider jobs and memory pressure. llama.cpp may start its existing configured local GGUF. Does not download or unload other models.',
    inputSchema: { provider: z.enum(['lmstudio', 'llamacpp']), model: z.string(), placement:z.enum(['auto','cpu']).optional(), context_length: z.number().int().min(512).max(32768).optional() },
  }, async a => text(models.start({ provider: a.provider, model: a.model, placement:a.placement, contextLength: a.context_length })));
  server.registerTool('local_model_operation', {
    description: 'Read a model operation by ID without loading or inference. After failure reconcile catalog state before any explicit retry.',
    inputSchema: { request_id: z.string() },
  }, async a => text(models.result(a.request_id)));
  server.registerTool('local_resource_status', {
    title: 'CPU, RAM, GPU and VRAM measurements',
    description: 'Read system-wide resource use, including game editors. Shared 5-second cache; missing GPU data is unknown, not zero. Never loads models or runs inference.',
    inputSchema: { include_history: z.boolean().optional() },
  }, async ({ include_history }) => {
    const monitor = require('../core/resource-monitor');
    const snapshot = await monitor.snapshot();
    return text({ ...snapshot, ...(include_history ? { history: monitor.history() } : {}) });
  });
  require('./pipeline-graph-tools').register(server);
  require('./research-tools').register(server);
  require('./offload-tools').register(server);
  require('./resource-tools').register(server);
  require('./debugging-tools').register(server);
  require('./ue-tuning-tools').register(server);
  server.registerTool('local_runtime_status', {
    title: 'Local runtime readiness',
    description: 'Separately reports ComfyUI/llama.cpp runtime, server, plugin-node and model readiness. Does not install or start anything.',
    inputSchema: {},
  }, async () => text(await runtime.status()));

  server.registerTool('comfy_workflow_run', {
    title: 'Run a local ComfyUI workflow',
    description: 'Run a ComfyUI workflow JSON locally. If the local ComfyUI server is down, the Hub starts it headless when the hardware budget allows (free VRAM, RAM, GPU busy, AC power) and stops it after an idle period; otherwise the error names the deferral reason. UI-format (graph) workflows such as ComfyUI templates are converted to API format against the live node definitions. Missing custom node classes are returned explicitly instead of silently failing. loras chains LoraLoaderModelOnly nodes after the diffusion model loader; loraCheck reports LoRA keys ComfyUI could not match (a LoRA for another base model draws without effect).',
    inputSchema: {
      workflow_file: z.string().describe('Absolute path to a ComfyUI workflow JSON file (API format or UI/graph format).'),
      inputs: z.record(z.string(), z.record(z.string(), z.any())).optional()
        .describe('Per-node input overrides: {"nodeId":{"field":value}}.'),
      timeout_ms: z.number().int().min(1000).max(3600000).optional(),
      // 강도 상한은 오타(예: 80) 방지용이다. ComfyUI 노드 자체는 ±100을 받는다.
      loras: z.array(z.object({ name: z.string().min(1), strength: z.number().min(-4).max(4).optional() })).max(8).optional()
        .describe('LoRA names from comfy_lora_list, applied in order; strength defaults to 1.'),
      lora_target: z.string().optional()
        .describe('Node id whose MODEL output (slot 0) receives the LoRAs; only needed when the workflow lacks exactly one UNETLoader/CheckpointLoaderSimple/UnetLoaderGGUF.'),
    },
  }, async (args) => text(await runtime.comfyWorkflow({
    workflowFile: args.workflow_file,
    inputs: args.inputs || {},
    timeoutMs: args.timeout_ms,
    loras: args.loras,
    loraTarget: args.lora_target,
  })));

  server.registerTool('comfy_lora_list', {
    title: 'List local ComfyUI LoRAs',
    description: "List LoRA files in this PC's ComfyUI loras folders: the name to pass to comfy_workflow_run loras, size, tensor count and training metadata (base model, rank, trigger) when present. Read-only; never downloads, starts ComfyUI or returns folder paths.",
    inputSchema: {},
  }, async () => text(await runtime.comfyLoras()));

  server.registerTool('aider_status', {
    title: 'Aider Studio readiness',
    description: 'Report Aider readiness and its LM Studio, live llama.cpp, and Hugging Face cache model catalog. Does not modify files.',
    inputSchema: {},
  }, async () => text(await aider.status()));

  server.registerTool('aider_command_preview', {
    title: 'Preview an Aider coding run',
    description: 'Validate and show the exact Aider command without running it or changing files.',
    inputSchema: {
      project_dir: z.string(),
      prompt: z.string(),
      provider: z.enum(['lmstudio', 'llamacpp', 'hf-cache']).optional(),
      model: z.string().optional(),
      mode: z.enum(['architect', 'code', 'ask']).optional(),
      files: z.array(z.string()).optional(),
      auto_commits: z.boolean().optional(),
      dry_run: z.boolean().optional(),
    },
  }, async (args) => text(await aider.commandPlan({
    projectDir: args.project_dir, prompt: args.prompt, provider: args.provider, model: args.model,
    mode: args.mode, files: args.files, autoCommits: args.auto_commits, dryRun: args.dry_run,
  })));

  server.registerTool('aider_run', {
    title: 'Run Aider on a local project',
    description: 'Let Aider orchestrate one coding task using LM Studio, live llama.cpp, or an HF cache profile served by llama.cpp. This may edit files. Auto-commits are off unless explicitly enabled.',
    inputSchema: {
      project_dir: z.string(),
      prompt: z.string(),
      provider: z.enum(['lmstudio', 'llamacpp', 'hf-cache']).optional(),
      model: z.string().optional(),
      mode: z.enum(['architect', 'code', 'ask']).optional(),
      files: z.array(z.string()).optional(),
      auto_commits: z.boolean().optional(),
      dry_run: z.boolean().optional(),
    },
  }, async (args) => text(await aider.start({
    projectDir: args.project_dir, prompt: args.prompt, provider: args.provider, model: args.model,
    mode: args.mode, files: args.files, autoCommits: args.auto_commits, dryRun: args.dry_run,
  })));

  server.registerTool('aider_result', {
    title: 'Read an Aider run',
    description: 'Poll a run started by aider_run. Returns running output or the completed exit status and full output.',
    inputSchema: { run_id: z.string() },
  }, async (args) => text(aider.result(args.run_id)));

  server.registerTool('aider_cancel', {
    title: 'Cancel an Aider run',
    description: 'Stop the currently running Aider task.',
    inputSchema: { run_id: z.string() },
  }, async (args) => text(aider.cancel(args.run_id)));
}

module.exports = { registerLocalRuntimeTools };

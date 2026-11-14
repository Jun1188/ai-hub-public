'use strict';

const { McpServer } = require('@modelcontextprotocol/server');
const { z } = require('zod');
const lmstudio = require('../core/lmstudio');
const downstream = require('../core/downstream');
const config = require('../core/config');
const { registerLocalRuntimeTools } = require('./local-runtime-tools');
// 조립 루트: 자격 증명 브로커(platform)가 api.request에 쓸 API 연결 저장소(integration)를 여기서 넣는다.
require('../core/credential-broker').useConnections(() => require('../core/api-connections').instance());

function text(payload) {
  const s = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text: s }] };
}

/**
 * Run `fn` while sending MCP progress notifications every 5 s (if the client
 * supplied a progressToken). Keeps clients like Claude Code from timing out
 * while a local model cold-loads, which can take minutes.
 */
async function withProgress(extra, label, fn) {
  const token = extra && extra._meta && extra._meta.progressToken;
  let timer = null;
  if (token !== undefined && token !== null && extra.sendNotification) {
    let elapsed = 0;
    timer = setInterval(() => {
      elapsed += 5;
      extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: elapsed, message: `${label}... ${elapsed}s` },
      }).catch(() => clearInterval(timer));
    }, 5000);
  }
  try {
    return await fn();
  } finally {
    if (timer) clearInterval(timer);
  }
}

function createHubServer() {
  const todoQueue = require('./shared-todo-queue'), capabilities = require('./hub-capabilities');
  // 두 고정 문자열만 잇는다 — 요청마다 다시 실리므로 바이트가 바뀌면 프롬프트 캐시가 깨진다(hub-capabilities.js).
  const server = require('../core/tool-usage').instrument(new McpServer({ name: 'ai-hub', version: require('../../package.json').version },
    { instructions: todoQueue.INSTRUCTIONS + '\n\n' + capabilities.INSTRUCTIONS }));
  todoQueue.register(server);
  // 경량 기기에서 끈 기능의 도구는 등록하지 않는다(feature-profile.js). 전체 프로필은 전부 그대로다.
  const register = server.registerTool.bind(server), features = require('../core/feature-profile'), profileConfig = config.load();
  // 앱 전용 패널 도구(_meta.ui.visibility ['app'])는 MCP Apps 확장을 알린 클라이언트에만 남긴다. 화면을 못 그리는 클라이언트(Claude Code·Codex 등)의
  // tools/list에 세션마다 약 5 KB가 실렸다(1.32.9 측정). 이름은 그대로이고, 패널을 그리는 호스트에서는 전과 같다.
  const appOnly = [], modelTools = [];
  server.registerTool = (name, options, ...rest) => {
    if (!features.toolEnabled(name, profileConfig)) return null;
    const tool = register(name, options, ...rest);
    const visibility = options?._meta?.ui?.visibility;
    if (Array.isArray(visibility) && visibility.length && !visibility.includes('model')) appOnly.push(tool);
    else modelTools.push({ name, title: options?.title || '', description: options?.description || '' });
    return tool;
  };
  capabilities.register(server, () => modelTools);
  server.server.oninitialized = () => {
    if (!server.server.getClientCapabilities()?.extensions?.['io.modelcontextprotocol/ui']) for (const tool of appOnly) tool.disable();
  };
  registerLocalRuntimeTools(server);
  require('./analysis-graph-tools').register(server);
  require('./knowledge-graph-tools').register(server);
  require('./external-connection-tools').register(server);
  require('./hub-command-tools').register(server);
  require('./self-improvement-tools').register(server);
  require('./harness-bus-tools').register(server);
  require('./app-lifecycle-tools').register(server);
  require('./creation-studio-tools').register(server);
  require('./herdr-tools').register(server);
  require('../core/rsi/hub-operations').registerAll(); // 이 프로세스에서 도는 상태 그래프의 hub-tool 단계용
  require('./harness-panel').registerHarnessPanel(server);

  server.registerTool(
    'hub_status',
    {
      title: 'Hub status',
      description: 'Health of LM Studio, configured downstream MCP servers, local model defaults and the Gemini agy offload worker (CLI version, recorded jobs).',
      inputSchema: {},
    },
    async () => {
      const [alive, agy] = await Promise.all([lmstudio.isAlive(), require('../core/agent-workers').agyStatus()]);
      // 1.29.0에서 뺀 기능의 키가 사용자 설정에 남아 있어도 보여 주지 않는다.
      const d = config.load().delegation;
      return text({
        lmstudio: { url: lmstudio.baseUrl(), alive },
        downstreamServers: downstream.listConfigured(),
        delegationDefaults: { defaultModel: d.defaultModel, defaultTemperature: d.defaultTemperature,
          defaultMaxTokens: d.defaultMaxTokens, modelTiers: d.modelTiers, retryOnTruncation: d.retryOnTruncation },
        offloadActive: require('../core/offload').active().length,
        offloadWorkers: { agy },
      });
    }
  );

  server.registerTool(
    'downstream_list_tools',
    {
      title: 'List downstream MCP tools',
      description: 'List the tools exposed by a configured downstream MCP server (e.g. Unity or Unreal).',
      inputSchema: {
        server: z.string().optional().describe('Downstream server name. Omit to list servers.'),
      },
    },
    async (args) => {
      if (!args.server) return text(downstream.listConfigured());
      return text(await downstream.listTools(args.server));
    }
  );

  server.registerTool(
    'downstream_call_tool',
    {
      title: 'Call downstream MCP tool',
      description:
        'Invoke a tool on a downstream MCP server. Names and schemas come from downstream_list_tools.',
      inputSchema: {
        server: z.string().describe('Downstream server name.'),
        tool: z.string().describe('Tool name on that server.'),
        arguments: z.record(z.any()).optional().describe('Arguments object for the tool.'),
      },
    },
    async (args) => {
      const result = await downstream.callTool(args.server, args.tool, args.arguments);
      return result; // pass through content blocks from the downstream server
    }
  );

  server.registerTool(
    'project_list',
    {
      title: 'List registered projects',
      description:
        'List registered Unity, Unreal, Node.js and Visual Studio projects (kind, paths, engine version, declared scripts or solution) ' +
        'plus locally detected engines and Visual Studio. Projects are per-machine.',
      inputSchema: {},
    },
    async () => {
      const projects = require('../core/projects'), fs = require('fs');
      // projects.json is shared between PCs: a project registered on another PC keeps that PC's path.
      return text({ projects: projects.list().map((p) => ({ ...p, missingHere: !fs.existsSync(p.path) })), tools: await projects.detectTools() });
    }
  );

  server.registerTool(
    'devpipeline_list',
    {
      title: 'List build pipelines',
      description: 'List game build pipelines (shell/msbuild/unity-batch/uat/ai/mcp-tool step sequences).',
      inputSchema: {},
    },
    async () => text(require('../core/pipeline').list())
  );

  server.registerTool(
    'devpipeline_run',
    {
      title: 'Run a build pipeline',
      description:
        'Start a build pipeline by id and return its runId immediately. ' +
        'Poll progress with devpipeline_status. Long builds keep running after this call returns.',
      inputSchema: {
        pipeline_id: z.string(),
        project_id: z.string().optional(),
      },
    },
    async (args) => text(require('../core/pipeline').start(args.pipeline_id, args.project_id))
  );

  server.registerTool(
    'devpipeline_status',
    {
      title: 'Build pipeline run status',
      description:
        'Status of a pipeline run: overall + per-step state, exit codes, durations. ' +
        'Optionally include the tail of a step\'s log.',
      inputSchema: {
        run_id: z.string(),
        log_step: z.number().int().min(0).max(999).optional(),
        log_tail_chars: z.number().int().min(100).max(20000).default(4000),
      },
    },
    async (args) => {
      const pipeline = require('../core/pipeline');
      const record = pipeline.runStatus(args.run_id);
      if (!record) return text({ error: `run을 찾을 수 없습니다: ${args.run_id}` });
      const out = { ...record };
      // graphState는 graphCheckpoint.data와 같은 값이다 — 응답에 두 번 싣지 않는다(큰 offload 결과가 그대로 복제됨).
      if (out.graphCheckpoint && JSON.stringify(out.graphState) === JSON.stringify(out.graphCheckpoint.data)) {
        delete out.graphState;
        out.graphStateIn = 'graphCheckpoint.data';
      }
      if (args.log_step !== undefined) {
        const log = pipeline.readLog(args.run_id, args.log_step);
        out.log = log.length > args.log_tail_chars ? log.slice(-args.log_tail_chars) : log;
      }
      return text(out);
    }
  );

  const codeindex = require('../core/codeindex');

  server.registerTool(
    'source_qa',
    {
      title: 'Ask a question about indexed source (learning)',
      description:
        'Learning-oriented Q&A over a locally indexed source tree: retrieves the most relevant code ' +
        'and has a local model explain it in Korean with citations. Optionally saves the answer as a ' +
        'learning note in hub memory.',
      inputSchema: {
        question: z.string().describe('What you want to understand about the source.'),
        index: z.string().optional().describe('Index name. Omit to use the first available index.'),
        save_note: z.boolean().default(false).describe('Save the answer as a learning note in hub memory.'),
      },
    },
    async (args, extra) => {
      const indexes = codeindex.listIndexes();
      if (!indexes.length) return text('No source index exists yet. Build one in the hub GUI (소스 분석 tab).');
      const name = args.index || indexes[0].name;
      const r = await withProgress(extra, 'source Q&A', () =>
        require('../core/source-qa').ask(name, args.question, { save: args.save_note })
      );
      return text(r);
    }
  );

  server.registerTool(
    'source_search',
    {
      title: 'Semantic search over indexed source code',
      description:
        'Semantic search over a locally indexed source tree (e.g. Unreal Engine source). ' +
        'Returns the most relevant code chunks with file paths and line numbers.',
      inputSchema: {
        query: z.string().describe('Natural-language or code query.'),
        index: z.string().optional().describe('Index name. Omit to use the first available index.'),
        top_k: z.number().int().min(1).max(20).default(6),
      },
    },
    async (args, extra) => {
      const indexes = codeindex.listIndexes();
      if (!indexes.length) return text('No source index exists yet. Build one in the hub GUI (소스 분석 tab).');
      const name = args.index || indexes[0].name;
      const results = await withProgress(extra, 'searching source index', () =>
        codeindex.search(name, args.query, args.top_k)
      );
      return text(results);
    }
  );

  server.registerTool(
    'source_read',
    {
      title: 'Read indexed source file',
      description: 'Read a line range from a file inside an indexed source tree (read-only, max 400 lines).',
      inputSchema: {
        file: z.string().describe('File path relative to the index root (as returned by source_search).'),
        start_line: z.number().int().min(1).default(1),
        end_line: z.number().int().min(1).default(200),
        index: z.string().optional(),
      },
    },
    async (args) => {
      const indexes = codeindex.listIndexes();
      if (!indexes.length) return text('No source index exists yet.');
      const name = args.index || indexes[0].name;
      return text(codeindex.readSource(name, args.file, args.start_line, args.end_line));
    }
  );

  server.registerTool(
    'ue_class_info',
    {
      title: 'Unreal class/struct info',
      description:
        'Look up an Unreal Engine UCLASS/USTRUCT/UENUM/UINTERFACE by name in the source index: ' +
        'declaration site, specifiers, parent classes, and known child classes.',
      inputSchema: {
        class_name: z.string().describe('e.g. AActor, UActorComponent, FVector'),
        index: z.string().optional(),
      },
    },
    async (args) => {
      const indexes = codeindex.listIndexes();
      if (!indexes.length) return text('No source index exists yet.');
      const name = args.index || indexes[0].name;
      return text(codeindex.classInfo(name, args.class_name));
    }
  );

  server.registerTool(
    'source_index_status',
    {
      title: 'Source index status',
      description: 'List locally built source-code indexes (name, root, chunk/class counts, build progress).',
      inputSchema: {},
    },
    async () => text(codeindex.listIndexes())
  );

  // 엔진 심볼 맵 — 임베딩 없이 만든 "어디에 무엇이 있나" 지도.
  // 호출하는 AI(Claude·Gemini 등)가 부족한 건 UE에 대한 추론력이 아니라 **이 설치본의
  // 소스가 컨텍스트에 없다는 것**이다. 그 좌표를 즉시 돌려주는 게 이 툴들의 목적이라
  // 모델을 전혀 태우지 않는다(질의 실측 150ms).
  const symbolmap = require('../core/symbolmap');

  server.registerTool(
    'symbol_find',
    {
      title: 'Find engine symbols',
      description:
        'Locate C++ types (UCLASS/USTRUCT/UINTERFACE/UENUM/class) in a scanned engine source tree by name, ' +
        'with file:line, module, and base classes. Exact matches rank first, then prefix, then substring. ' +
        'Also returns curated documentation sections that mention the symbol. No model call — instant. ' +
        'Maps are built in the hub GUI (소스 분석 tab); omit `map` to list available maps.',
      inputSchema: {
        map: z.string().regex(/^[\w-]{1,64}$/).optional().describe('Map name. Omit to list all maps.'),
        query: z.string().optional().describe('Symbol name or fragment, e.g. "FSceneRenderer", "Nanite".'),
        kind: z.enum(['UCLASS', 'USTRUCT', 'UINTERFACE', 'UENUM', 'class']).optional()
          .describe('Restrict to one declaration kind.'),
        module: z.string().optional().describe('Restrict to a UE module, e.g. "Renderer", "Engine".'),
        limit: z.number().int().min(1).max(200).default(30).describe('Max matches to return.'),
      },
    },
    async (args) => {
      if (!args.map) return text(symbolmap.list());
      if (!args.query) return text({ error: 'query is required when map is given' });
      return text(symbolmap.find(args.map, args.query, {
        kind: args.kind, module: args.module, limit: args.limit,
      }));
    }
  );

  server.registerTool(
    'symbol_hierarchy',
    {
      title: 'Engine class hierarchy',
      description:
        'Full inheritance chain for a type in a scanned engine source tree: the ancestor chain up to the root, ' +
        'implemented interfaces (separated from the base class), and direct subclasses — each with file:line. ' +
        'Ancestors declared outside the scanned tree are still listed, with kind "?" and no location. ' +
        'Also returns curated documentation sections mentioning the type. No model call.',
      inputSchema: {
        map: z.string().regex(/^[\w-]{1,64}$/).describe('Map name from symbol_find.'),
        symbol: z.string().describe('Exact type name, e.g. "UCharacterMovementComponent".'),
      },
    },
    async (args) => text(symbolmap.hierarchy(args.map, args.symbol))
  );

  server.registerTool(
    'deep_analysis_briefing',
    {
      title: 'Assemble a deep-analysis briefing',
      description:
        'Assemble a grounded briefing for analysing an engine subsystem: symbol coordinates + inheritance ' +
        'hierarchy + curated documentation sections (tier 1), optionally with code excerpts from a built ' +
        'semantic index (tier 2). The caller (you) does the analysis — this tool only gathers evidence, ' +
        'no model call, instant. Secrets/user paths are scrubbed.',
      inputSchema: {
        map: z.string().regex(/^[\w-]{1,64}$/).describe('Symbol map name (see symbol_find with no args).'),
        topic: z.string().describe('Subsystem or type to analyse, e.g. "Lumen", "UCharacterMovementComponent".'),
        question: z.string().optional().describe('The actual question — steers excerpt retrieval.'),
        index: z.string().regex(/^[\w-]{1,64}$/).optional().describe('Semantic index name for code excerpts (see source_index_status).'),
        include_source: z.boolean().default(false).describe('Include code excerpts from the index. Default off.'),
      },
    },
    async (args) => {
      const deepdive = require('../core/deepdive');
      const b = await deepdive.briefing({
        map: args.map, topic: args.topic, question: args.question,
        index: args.index, includeSource: args.include_source,
      });
      return text(b.text);
    }
  );

  const renderpipe = require('../core/renderpipe');

  server.registerTool(
    'render_pipeline_map',
    {
      title: 'List/query rendering-pipeline maps',
      description:
        'Rendering-pipeline structure scanned from a UE renderer source tree: RDG passes, global shaders, ' +
        'GPU stats, draw events, and renderer functions with file:line. Scans are built in the hub GUI (소스 분석 tab).',
      inputSchema: {
        map: z.string().regex(/^[\w-]{1,64}$/).optional().describe('Scan name. Omit to list all scans.'),
        filter: z.string().optional().describe('Case-insensitive keyword to filter entries (e.g. "BasePass", "Lumen").'),
      },
    },
    async (args) => {
      if (!args.map) return text(renderpipe.list());
      return text(renderpipe.query(args.map, args.filter || ''));
    }
  );

  server.registerTool(
    'render_pipeline_analyze',
    {
      title: 'Explain a rendering-pipeline feature',
      description:
        'Explain how a rendering feature (e.g. BasePass, Shadow, Lumen, Nanite, PostProcess) flows through a ' +
        'frame: grounded in the scanned render map plus real source excerpts, answered by a local model with ' +
        'file:line citations. Requires a render map built in the hub GUI.',
      inputSchema: {
        map: z.string().regex(/^[\w-]{1,64}$/).describe('Scan name from render_pipeline_map.'),
        topic: z.string().describe('The rendering feature to explain.'),
        save_note: z.boolean().default(false).describe('Save the explanation as a learning note in hub memory.'),
      },
    },
    async (args, extra) => {
      const r = await withProgress(extra, 'analyzing render pipeline', () =>
        renderpipe.analyze(args.map, args.topic, { save: args.save_note })
      );
      return text(r);
    }
  );

  return server;
}

module.exports = { createHubServer };

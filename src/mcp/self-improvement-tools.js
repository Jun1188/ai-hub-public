// MCP: 평가 3계층·RSI 제안 큐·스킬 색인/캐시·도구 경로 표·거버너·구조 감사·공급망 안전성·게이머 관점 서브에이전트.
// 바꾸는 동작(승인·데이터셋 쓰기·포크 적용)은 GUI 전용이거나 confirmed:true가 필요하다. 나머지는 읽기·제안이다.
'use strict';
const { z } = require('zod');

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const ops = () => { const h = require('../core/rsi/hub-operations'); h.registerAll(); return h.operations(); };
// 도구 경로 실행기가 부르는 위 계층 대상. 지연 로드 — pipeline.js는 로드할 때 실행 기록을 정리하므로 pipeline: 경로에서만 올린다.
const routeTargets = {
  invokeOp: (name, args) => require('../core/pipeline-hub-step').invoke(name, args),
  apiRequest: (...a) => require('../core/pipeline-api-request').request(...a),
  pipeline: { list: () => require('../core/pipeline').list(), start: (id) => require('../core/pipeline').start(id) },
};

function register(server) {
  server.registerTool('eval_run', {
    title: 'Run one tier of the evaluation system',
    description: 'Tier `deterministic` (rule program: structure audit — cycles, cross-domain coupling, upward dependencies, duplication, 700-line budget, classification; or for `shared-skills` the harness surface, skill frontmatter/discoverability, secrets and script safety), tier `agent` (a worker judges a rubric extracted from skill/project rules with internal debugging and source-analysis evidence; never sees tier-1 results; failure scores null, not 0; cached per rubric+fingerprint), tier `meta` (current judge version only, `measured` needs 5 pairs from 5 distinct subjects: agreement kappa with subject-cluster bootstrap intervals, Brier skill vs the base rate, reliability bins, judge confidence spread, one-way judge lean, repeat stability, judge failure rate, rubric coverage and evaluator-improvement proposals; other judge versions reported apart). Subjects: hub-source | shared-skills. With no worker, Codex receives the rubric, relative source locations and aggregate metrics. Select local to keep the evaluation on this PC.',
    inputSchema: { tier: z.enum(['deterministic', 'agent', 'meta']), subject: z.enum(['hub-source', 'shared-skills']).optional(), worker: z.enum(['local', 'codex', 'agy']).optional() },
  }, async (a) => text(await ops()[a.tier === 'agent' ? 'eval.agent' : a.tier === 'meta' ? 'eval.meta' : 'eval.deterministic'].fn({ subject: a.subject, worker: a.worker }, {})));

  server.registerTool('rsi_overview', {
    title: 'Self-improvement overview',
    description: 'Latest evaluations of all three tiers, whether the three RSI loops are installed as state graphs, the proposal queue (proposed → reviewed → approved/rejected by a human in the Hub) and `proposalReview` (review verdicts vs human decisions, recommend share, per-origin approval base rates, open proposals whose evidence producer changed), cache hit ratios (this session, lifetime across restarts and the recent 7 days, per class/category, with estimated loader time saved and categories never hit), harness compatibility, governor state and monitoring gaps, structure audit totals, Obsidian status and `capabilityGaps` (failure signals grouped into capability gaps with fixed-vocabulary research queries, counts only).',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => text(await require('../core/rsi/overview').overview()));

  server.registerTool('rsi_install_loops', {
    title: 'Install or update the three RSI loops as state-graph pipelines',
    description: 'Save rsi-l1-artifact, rsi-l2-evaluator and rsi-l3-meta as pipelines (L1 and L3 never auto-run; the desktop Hub starts L2 only on new evaluation fingerprints or a Hub version change; run them with devpipeline_run and resume review pauses with dev_pipeline_graph_resume). `l1Scope` is the repository-relative harness folder L1 improves (default skills/development), `l1Worker` the proposer worker (codex|agy|local), `l2JudgeWorker` the tier-2 judge used when L2 samples (local is declined when the GPU is busy; offload never falls back to the cloud on its own). Optional, costly L1 paths (default off): `l1Mode` "module" proposes per module (one skill folder or harness component, up to `l1MaxModules`, `l1PerModule` each) and re-judges the `l1Combos` best predicted module combinations — about 4-8x the Codex calls of the default "pair" (INV+DOM); `l1JudgeSamples` judges every view k times and records majority and consistency (judge calls x k). `l1JudgeOrder` defaults to ["agy","codex","local"] when no judge is specified. Cloud workers run in their configured order. A mixed order uses local only if every configured cloud worker reports exhausted quota. A single explicit local judge stays local. On a qualifying mid-run refusal the next judge evaluates every view again. The order overrides `l1JudgeWorker`. Pass the options already in use again, or they reset. Needs confirmed:true.',
    inputSchema: { confirmed: z.literal(true), l1Scope: z.string().max(120).optional(), l1Worker: z.enum(['codex', 'agy', 'local']).optional(), l1JudgeWorker: z.enum(['codex', 'agy', 'local']).optional(), l1JudgeOrder: z.array(z.enum(['codex', 'agy', 'local'])).min(1).max(3).optional(), l2JudgeWorker: z.enum(['codex', 'agy', 'local']).optional(),
      l1Mode: z.enum(['pair', 'module']).optional(), l1JudgeSamples: z.number().int().min(1).max(5).optional(), l1MaxModules: z.number().int().min(1).max(8).optional(),
      l1PerModule: z.number().int().min(1).max(3).optional(), l1Combos: z.number().int().min(0).max(4).optional() },
  }, async (a) => text(require('../core/rsi/triple-loop').install({ confirmed: true, options: { 'rsi-l1-artifact': { scope: a.l1Scope, worker: a.l1Worker, judgeWorker: a.l1JudgeWorker, judgeOrder: a.l1JudgeOrder,
    mode: a.l1Mode, judgeSamples: a.l1JudgeSamples, maxModules: a.l1MaxModules, perModule: a.l1PerModule, combos: a.l1Combos }, 'rsi-l2-evaluator': { judgeWorker: a.l2JudgeWorker } } })));

  server.registerTool('rsi_propose', {
    title: 'Collect and screen improvement proposals',
    description: 'Run the proposer agent (research-review picks of new papers/sources, evaluator improvements from meta-eval, structure audit, tool-route edits, monitoring gaps, governor evaluation, multi-agent society) and the reviewer agent (frozen-area, evidence and risk screen, stale evidence producer, per-origin approval base rate from human decisions + priority = 3·relevance+2·evidence+2·reproducibility+novelty+recent−2·risk−effort). Approval is human-only in the Hub GUI; approved code changes become work orders, never applied automatically.',
    inputSchema: {},
  }, async () => { const research = require('../core/rsi/research-agents'); ops(); const p = await research.propose(); const r = await research.review(null, {}); return text({ added: p.added, unavailable: p.unavailable, reviewed: r.reviewed }); });

  server.registerTool('skill_find', {
    title: 'Find a skill or a problem log',
    description: 'Hybrid search over the shared skill catalog and problem logs: binary-search name index, BM25 over Hangul bigrams + words, and a header-only hashed vector index; ranked up by recorded real use. The index is cached across sessions and rebuilt only when a SKILL.md/log changes. Uses the repository-generated skills/catalog.json and logs/INDEX.json and re-reads only files changed since. Returns `notFound: true` instead of forcing weak matches. `semantic.mode` is `cross-lingual` when the local embedding model passed the translation-pair probe (a Korean query may then match an English description), else `rerank-only` (embeddings only reorder lexical matches — query in the description\'s language). Returns repository-relative paths plus the shared todoQueue read before lookup; read only the SKILL.md you pick.',
    inputSchema: { query: z.string().min(1).max(200), kind: z.enum(['skill', 'log']).optional(), limit: z.number().int().min(1).max(20).optional() },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const todoQueue = await require('../core/shared-todo-queue').read();
    const v = await require('../core/cache/skill-index').findVerdict(a.query, { kind: a.kind, limit: a.limit ?? 8 });
    await require('../core/knowledge-metrics').recordFind(a.query, v).catch(() => {}); // 지식 그래프 추이용 — 검색 결과에는 영향 없음
    return text({ todoQueue, notFound: v.notFound, semantic: v.semantic, results: v.results.map(({ id, kind, name, description, category, path, score }) => ({ id, kind, name, description, category, path, score })) });
  });

  server.registerTool('skill_use', {
    title: 'Record that you actually used a skill',
    description: 'Count one real use of skill `name` (after you read and applied its SKILL.md). Real use ranks skills in skill_find and sizes nodes in the knowledge graph. Claude Code (Skill tool or reading a SKILL.md) and Codex (reading a SKILL.md) are already counted from their own session logs, so do not call this there — it would count twice. Call it from harnesses whose logs the Hub cannot read (Antigravity, Gemini CLI, GUI apps).',
    inputSchema: { name: z.string().min(1).max(80) },
  }, async (a) => text({ uses: await require('../core/cache/skill-index').recordUse(`skill:${a.name}`, { harness: require('../core/harness-usage').harnessOfCaller() }) }));

  server.registerTool('tool_route', {
    title: 'Cheapest way to do a task (dynamic syscall table)',
    description: 'Only when you do not know which tool fits — call known tools directly (each call is one more round trip). Map an intent to a route: `table` (deterministic Hub tool) < `graph` (state-graph pipeline) < `api` (registered HTTP connection) < `mcp` (downstream server or another harness through the bus) < `guide` (path checked only in official docs or run inside another harness: its note is returned, never run) < `computer-use` (GUI-only work, delegate to a harness that has it). Learned success rates adjust the order; routes whose capabilities exceed the sandbox policy are never chosen. Report the outcome with tool_route_record.',
    inputSchema: { intent: z.string().min(2).max(300) }, annotations: { readOnlyHint: true },
  }, async (a) => text(await require('../core/toolroute/route-table').resolve(a.intent)));

  server.registerTool('tool_route_run', {
    title: 'Run a task through its cheapest route (table/graph/API/MCP/computer use)',
    description: 'Resolve `intent` (or take `routeId`) and run its cheapest route: Hub tools (`mcp:`), state-graph operations (`hub:`), pipelines (`pipeline:`), registered HTTP connections (`api:<connection>`, args.route/method/body), downstream MCP servers, web computer use (`web:sandbox`, args.steps of navigate{url}/screenshot/text/click{selector|x,y}/type{text,selector?}/key{key}/wait{ms} in an isolated Hub browser; loopback and computerUse.allowedOrigins only; click/type/key need confirmed:true) or desktop computer use (`harness:<id>`, confirmed:true, handed to a GUI-capable harness). `guide` routes are never run; their note is returned. Pass logical paths (repo:, app:, rsi:); drive paths, secret-like arguments and routes outside the sandbox policy are refused. Outcomes feed the route ledger.',
    inputSchema: { intent: z.string().min(2).max(300).optional(), routeId: z.string().max(64).optional(), args: z.record(z.string(), z.any()).optional(), confirmed: z.boolean().optional() },
  }, async (a) => text(await require('../core/toolroute/route-executor').run({ intent: a.intent, routeId: a.routeId, args: a.args || {}, confirmed: a.confirmed }, routeTargets)));

  server.registerTool('tool_route_record', {
    title: 'Report how a route worked',
    description: 'Record success/failure (and ms) of route `id`. Failure rates, misses and unused routes become route-table edit proposals for human approval.',
    inputSchema: { id: z.string().min(1).max(64), ok: z.boolean(), ms: z.number().int().min(0).optional() },
  }, async (a) => text(await require('../core/toolroute/route-table').record(a.id, { ok: a.ok, ms: a.ms })));

  server.registerTool('governor_status', {
    title: 'Resource governor, its gaps and its evaluation',
    description: 'The governor watches telemetry findings and Hub internals (queues, local GPU slot, bus) and gates new local inference during paging/VRAM spill/thermal throttle and unloads idle models. Also returns monitoring/debugging gaps it recorded and the helped/hurt/no-effect/confounded evaluation of its past decisions.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => text({ ...require('../core/governor/governor').status(), gaps: await require('../core/governor/monitoring-gaps').list(), evaluation: await require('../core/governor/governor-eval').evaluate({ limit: 30 }).catch((e) => ({ error: e.message })) }));

  server.registerTool('script_safety_scan', {
    title: 'Static safety check of a script or skill text',
    description: 'Scan `text` (as file `path` for language detection) for destructive deletes, remote-code-execution pipes, persistence, credential harvesting, defense evasion, Trojan-Source bidi characters (block) and eval/obfuscation/lifecycle scripts/uploads/prompt injection/zero-width characters (review). Returns verdict pass|review|block with line numbers; excerpts are secret-scrubbed.',
    inputSchema: { text: z.string().min(1).max(1024 * 1024), path: z.string().max(200).optional() }, annotations: { readOnlyHint: true },
  }, async (a) => text(require('../core/supply/script-safety').scanText(a.text, { path: a.path || 'input.txt' })));

  server.registerTool('upstream_sync_check', {
    title: 'Check forks of external plugins/skills against their upstream',
    description: 'Runs the upstream update policy (user decision 2026-10-26) and reports. `forks`: registered local forks that are due are checked with `git ls-remote`; a fork that fell behind gets a 3-way sync proposal (script-safety scan, compatibility checks). `tools`: uv-installed tools such as Aider are checked against PyPI. Then by kind: unmodified data lists are applied after verification; adapted code, registry entries and unmodified tools are applied only when no deterministic risk is found AND a reviewer model from another worker answers "safe" (with post-check and rollback); everything else waits in `approvals` for a human, who approves only in the Hub GUI (never via MCP). `shared`: the shared repository registry (evolve/research/upstreams.json) is observe-only.',
    inputSchema: {},
  }, async () => text({ forks: await require('../core/supply/upstream-sync').syncDue(), tools: await require('../core/supply/tool-updates').syncTools(),
    approvals: (await require('../core/supply/update-policy').list()).filter((x) => x.state === 'pending').map(({ publicText, ...x }) => x),
    shared: await require('../core/supply/upstream-observe').observeShared({ repoRoot: require('../core/shared-repo-memory').repoRoot() }) }));

  server.registerTool('gamer_lens_collect', {
    title: 'Steam store facts and representative player reviews',
    description: 'Public Steam data for `appId`: store details, review summary, and up to `k` representative reviews (helpful, both stances in proportion, deduplicated, covering different aspects such as gameplay/performance/price). Author identity is removed. Responses are cached 24 h and Steam is called at most once per 1.1 s.',
    inputSchema: { appId: z.number().int().positive().max(1e8), language: z.string().max(20).optional(), k: z.number().int().min(2).max(20).optional() }, annotations: { readOnlyHint: true },
  }, async (a) => {
    const steam = require('../core/gamer-lens/steam-source');
    const [details, rv] = await Promise.all([steam.appDetails(a.appId), steam.reviews(a.appId, { language: a.language || 'all', max: 200 })]);
    return text({ details, summary: rv.summary, representative: require('../core/gamer-lens/review-select').representative(rv.reviews, { k: a.k ?? 8, summary: rv.summary }) });
  });

  server.registerTool('gamer_lens_dataset', {
    title: 'Write a multi-game gamer-perspective dataset',
    description: 'Collect (Steam facts + representative reviews + open statistics ↔ game content) pairs for up to 40 Steam app ids and write one dataset (train/eval JSONL, card, LoRA config) under the Hub data folder. Open sources only: Steam store and Web API (current players, review histogram, Metacritic score from store data) and SteamSpy; SteamDB/SteamCharts are not used (no public API, scraping disallowed). Needs confirmed:true. Runs as a job: the call returns `jobId`; call again with only `jobId` for the result. Personal research use; Steam reviews are user content and must not be redistributed.',
    inputSchema: { appIds: z.array(z.number().int().positive().max(1e8)).min(1).max(40).optional(), name: z.string().min(1).max(80).optional(), language: z.string().max(20).optional(), maxPerGame: z.number().int().min(20).max(500).optional(), confirmed: z.literal(true).optional(), jobId: z.string().uuid().optional() },
  }, async (a) => {
    const ds = require('../core/gamer-lens/dataset-builder');
    if (a.jobId) return text(ds.status(a.jobId));
    if (!a.appIds || !a.name || a.confirmed !== true) return text({ ok: false, reason: 'appIds, name and confirmed:true are required (or pass jobId)' });
    return text(ds.start({ appIds: a.appIds, name: a.name, language: a.language, maxPerGame: a.maxPerGame, confirmed: true }));
  });

  server.registerTool('gamer_lens_postprocess', {
    title: 'Re-read an analysis from the player\'s point of view',
    description: 'Harness post-processing sub-agent: builds a briefing that pairs `analysisText` (your design/analysis output) with the game\'s Steam facts and representative reviews. Without `worker` it returns the briefing for you to run (pull). With `worker` (local|codex|agy) the Hub runs it through offload and returns concerns that must cite review ids (unknown ids are dropped). A worker run longer than about 45 s returns state "running" with `jobId`; call again with the same appId and that jobId (no analysisText) to collect it.',
    inputSchema: { appId: z.number().int().positive().max(1e8), analysisText: z.string().min(1).max(60000).optional(), worker: z.enum(['local', 'codex', 'agy']).optional(), jobId: z.string().uuid().optional() },
  }, async (a) => {
    if (!a.analysisText && !a.jobId) return text({ ok: false, reason: 'analysisText or jobId is required' });
    const steam = require('../core/gamer-lens/steam-source'), pp = require('../core/gamer-lens/postprocess');
    const [details, rv] = await Promise.all([steam.appDetails(a.appId), steam.reviews(a.appId, { max: 200 })]);
    const representative = require('../core/gamer-lens/review-select').representative(rv.reviews, { k: 8, summary: rv.summary });
    const offload = require('../core/offload');
    let id = a.jobId;
    if (!id) {
      const brief = pp.briefing({ analysisText: a.analysisText, details, summary: rv.summary, representative });
      if (!a.worker) return text({ briefing: brief, outputSchema: pp.outputSchema });
      id = offload.run({ task: brief.task, text: brief.files.map((f) => `## ${f.name}\n${f.text}`).join('\n\n'), schema: pp.outputSchema, worker: a.worker, maxOutputTokens: 2048 });
    }
    // MCP 클라이언트 제한 시간(약 60초) 안에 돌려준다 — 끝나지 않았으면 jobId로 다시 받는다(offload_run·offload_wait와 같은 방식).
    const r = await offload.wait(id, 45);
    if (r.state === 'running') return text({ ok: false, state: 'running', jobId: id });
    return text(r.state === 'succeeded' ? pp.parse(r.results?.[0]?.value, { reviewIds: representative.map((x) => x.id) }) : { ok: false, reason: r.reason || r.state });
  });
}

module.exports = { register };

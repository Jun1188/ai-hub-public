// 도구 경로 실행기: 경로 표가 고른 길을 실제로 실행한다 — compute use(GUI)·API·MCP·상태 그래프를 한 입구로 묶는다.
//   mcp:<도구>          이 프로세스에 등록된 Hub MCP 도구를 왕복 없이 부른다(결정적 표·그래프 질의가 대부분)
//   hub:<연산>          상태 그래프 hub-tool 연산(평가·감사·캐시 등)
//   pipeline:<id>       상태 그래프 파이프라인을 시작한다(실행 ID만 돌려준다)
//   api:<연결 ID>       등록된 HTTP 연결로 요청(pipeline-api-request의 원점 고정·시크릿 검사·회로 차단·호출 상한을 그대로 쓴다)
//   downstream:<서버>/<도구>  다운스트림 MCP 서버
//   web:sandbox         computer use(웹 GUI) — Hub 안의 격리된 브라우저 창에서 직접 본다·누른다(web-sandbox.js, 입력은 확인 필요)
//   harness:<id>        computer use(데스크톱 GUI) — GUI를 다룰 수 있는 하네스의 우편함에 넘긴다(사람 확인 필요, 직접 조작하지 않는다)
// 샌드박스 가상화: 인자 속 논리 경로(repo:·app:·rsi:)는 여기서만 실제 경로로 바꾸고, 드라이브 경로·시크릿은 거부한다.
// 정책 밖 능력을 선언한 경로는 실행하지 않는다. 결과(성공·지연)는 경로 장부에 남아 자가개선 제안의 근거가 된다.
'use strict';

const LOGICAL = /^(repo|app|rsi):/;
const DRIVE = /^[a-z]:[\\/]|^\\\\/i;

async function resolveArgs(value, deps, depth = 0) {
  if (depth > 6) throw new Error('arguments nest too deep');
  if (typeof value === 'string') {
    if (DRIVE.test(value)) throw Object.assign(new Error('use logical paths (repo:, app:, rsi:) instead of drive paths'), { code: 'route_path_refused' });
    if (!LOGICAL.test(value)) return value;
    const r = await require('../harness-bridge/virtual-workspace').resolve(value, deps);
    if (!r.ok) throw Object.assign(new Error(`${value}: ${r.reason}`), { code: 'route_path_refused' });
    return r.path;
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => resolveArgs(v, deps, depth + 1)));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await resolveArgs(v, deps, depth + 1);
    return out;
  }
  return value;
}

function parseTarget(target) {
  const m = /^(mcp|hub|pipeline|api|downstream|web|harness):(.+)$/.exec(String(target || ''));
  if (!m) throw new Error('bad route target: ' + target);
  return { scheme: m[1], name: m[2] };
}

// hub·pipeline·api 대상은 위 계층(파이프라인)이라 부르는 쪽이 deps.invokeOp·pipeline·apiRequest로 넘긴다(조립: mcp/self-improvement-tools).
async function dispatch(route, args, opts, deps) {
  const { scheme, name } = parseTarget(route.target);
  if (scheme === 'mcp') {
    const r = await (deps.invokeTool || require('../tool-usage').invokeTool)(name, args);
    const text = (r && r.content || []).map((c) => c.text || '').join('\n');
    let data = null;
    try { data = JSON.parse(text); } catch { data = text.slice(0, 20000); }
    return { ok: !(r && r.isError), data };
  }
  if (scheme === 'hub') return { ok: true, data: await deps.invokeOp(name, args) };
  if (scheme === 'pipeline') {
    const { pipeline } = deps;
    if (!pipeline.list().some((p) => p.id === name)) throw new Error('pipeline not found: ' + name);
    return { ok: true, data: { runId: pipeline.start(name) } };
  }
  if (scheme === 'api') {
    if (typeof args.route !== 'string') throw new Error('api routes need args.route (path under the connection origin)');
    // 인증이 아닌 고정 헤더(예: Anthropic의 anthropic-version)는 넘긴다 — 인증 모양 헤더는 api-request가 거부하고 연결의 암호화 키를 쓴다.
    const step = { type: 'api-request', name: route.id, connection: name, route: args.route, method: args.method || 'GET', ...(args.body !== undefined ? { body: args.body } : {}), ...(args.headers ? { headers: args.headers } : {}) };
    const run = { record: { runId: `route-${Date.now()}` }, cancelled: false, abort: new AbortController() };
    const r = await deps.apiRequest(step, {}, { substituteVars: (t) => t, appendLog: () => {} }, run);
    return { ok: r.exitCode === 0, data: r.data };
  }
  if (scheme === 'downstream') {
    const [server, tool] = name.split('/');
    if (!server || !tool) throw new Error('downstream target is <server>/<tool>');
    const r = await (deps.downstream || require('../downstream')).callTool(server, tool, args);
    return { ok: !(r && r.isError), data: r };
  }
  if (scheme === 'web') return (deps.webSandbox || require('./web-sandbox')).run({ steps: args.steps, confirmed: opts.confirmed }, deps);
  // harness: GUI 조작은 되돌릴 수 없는 일이 많다 — 사람 확인 뒤, GUI를 다룰 수 있는 하네스 세션이 우편함에서 집어 간다.
  if (opts.confirmed !== true) return { ok: false, needsConfirmation: true, data: { reason: 'computer-use routes need confirmed:true (GUI actions are not reversible)' } };
  const bus = deps.bus || require('../harness-bridge/harness-bus');
  const sent = await bus.send({ from: opts.from || 'ai-hub', to: name, kind: 'ask', topic: `computer use: ${String(opts.intent || route.id).slice(0, 100)}`,
    body: String(args.instructions || opts.intent || '').slice(0, 60000) || '(no instructions)', refs: Array.isArray(args.refs) ? args.refs : [] }, deps);
  return { ok: true, data: { handedOff: true, messageId: sent.id, to: name, note: 'GUI-capable session picks it up from bus_inbox; the answer comes back as a result message' } };
}

/**
 * run({ intent | routeId, args, confirmed, from }) → { route, ok, data, ms }
 * 같은 의도를 다음에 다시 부르면 장부의 성공률이 반영된 순서로 고른다.
 */
async function run(input = {}, deps = {}) {
  const table = deps.table || require('./route-table');
  let route;
  if (input.routeId) route = (await table.load(deps)).find((r) => r.id === input.routeId);
  else route = (await table.resolve(String(input.intent || ''), {}, deps)).best;
  if (!route) return { ok: false, route: null, data: { reason: 'no route — ask the user or use a harness with computer use' } };
  const denied = table.allowed(route);
  if (denied.length) return { ok: false, route: route.id, data: { reason: 'capabilities outside the sandbox policy: ' + denied.join(', ') } };
  if (route.kind === 'guide') return { ok: false, route: route.id, kind: route.kind, target: route.target, guide: true, data: { note: route.note || '' } };
  try { require('../prompt-safety').assertNoSecrets(JSON.stringify(input.args || {})); }
  catch { return { ok: false, route: route.id, data: { reason: 'arguments look like they contain a secret' } }; }
  const started = Date.now();
  let out;
  try {
    const args = await resolveArgs(input.args || {}, deps);
    out = await dispatch(route, args, { confirmed: input.confirmed, from: input.from, intent: input.intent }, deps);
  } catch (e) { out = { ok: false, data: { reason: e.code || String(e.message || e).slice(0, 200) } }; }
  const ms = Date.now() - started;
  if (!out.needsConfirmation) await table.record(route.id, { ok: !!out.ok, ms }, deps).catch(() => {});
  return { route: route.id, kind: route.kind, target: route.target, ms, ...out };
}

module.exports = { run, resolveArgs, parseTarget };

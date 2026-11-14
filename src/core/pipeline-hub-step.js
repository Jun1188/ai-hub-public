'use strict';
// 상태 그래프 단계 'hub-tool': Hub 프로세스 안의 등록된 연산(평가·RSI·거버너·캐시 GC)을 부르고 결과를 last.data에 싣는다.
// mcp-tool은 외부 MCP 서버만 부르고 종료 코드만 돌려줘서, 점수로 분기하는 자가개선 루프를 그릴 수 없었다.
// 연산은 위 계층(rsi/hub-operations)이 시작할 때 등록한다 — 파이프라인이 자가개선 모듈을 require하지 않게.
const STATE_BUDGET = 48 * 1024;
const operations = new Map();

function register(name, fn, { description = '' } = {}) {
  if (!/^[a-z][\w-]*(\.[a-z][\w-]*)+$/.test(name)) throw new Error('hub-tool 이름은 domain.action 형식입니다: ' + name);
  operations.set(name, { fn, description });
}
const list = () => [...operations].map(([name, o]) => ({ name, description: o.description }));
/** 그래프 밖에서 같은 연산을 부른다(도구 경로 실행기). */
async function invoke(name, args = {}) {
  const op = operations.get(name);
  if (!op) throw Object.assign(new Error('등록되지 않은 연산: ' + name), { code: 'op_not_registered' });
  return op.fn(args, { runId: `route-${Date.now()}`, state: {}, cancelled: () => false });
}

function validate(step, id) {
  if (!/^[a-z][\w-]*(\.[a-z][\w-]*)+$/.test(step.tool)) throw new Error(id + ': hub-tool tool은 domain.action 형식입니다.');
  if (step.argsJson !== undefined && typeof step.argsJson !== 'string') throw new Error(id + ': argsJson은 JSON 문자열입니다.');
}

// 상태 예산을 넘는 배열은 앞에서부터 잘라 담는다 — 분기에 쓰는 요약 필드는 배열 밖에 둔다.
function fit(value) {
  const copy = JSON.parse(JSON.stringify(value ?? null));
  if (!copy || typeof copy !== 'object') return { value: copy };
  let text = JSON.stringify(copy);
  while (Buffer.byteLength(text) > STATE_BUDGET) {
    const key = Object.keys(copy).filter((k) => Array.isArray(copy[k]) && copy[k].length).sort((a, b) => JSON.stringify(copy[b]).length - JSON.stringify(copy[a]).length)[0];
    if (!key) return { truncated: true, summary: text.slice(0, 2000) };
    copy[key] = copy[key].slice(0, Math.floor(copy[key].length / 2));
    copy.truncated = true;
    text = JSON.stringify(copy);
  }
  return copy;
}

async function execute(step, index, run, ctx, io) {
  // 등록은 조립 루트(Electron 시작·MCP 서버 생성)가 한다 — 여기서 자가개선 모듈을 끌어오면 계층이 거꾸로 묶인다.
  const op = operations.get(step.tool);
  if (!op) { io.appendLog(run.record.runId, index, `[hub-tool] 등록되지 않은 연산: ${step.tool}\n`, 'stderr'); return 1; }
  let args = {};
  if (step.argsJson && step.argsJson.trim()) {
    try { args = JSON.parse(io.substituteVars(step.argsJson, ctx)); } catch (e) { throw new Error(`argsJson 파싱 실패: ${e.message}`); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('argsJson은 JSON object여야 합니다');
  }
  io.appendLog(run.record.runId, index, `[hub-tool] ${step.tool} ${JSON.stringify(args).slice(0, 400)}\n`, 'stdout');
  let result;
  try { result = await op.fn(args, { run, runId: run.record.runId, state: ctx.state || {}, cancelled: () => run.cancelled }); }
  catch (e) {
    run.graphStepData = { ok: false, error: String(e.message || e).slice(0, 300) };
    io.appendLog(run.record.runId, index, `[hub-tool] 실패: ${run.graphStepData.error}\n`, 'stderr');
    return 1;
  }
  const data = fit(result);
  require('./pipeline-state-graph').clean(data);
  run.graphStepData = data;
  io.appendLog(run.record.runId, index, `[hub-tool] ok ${JSON.stringify(data).slice(0, 600)}\n`, 'stdout');
  return data && data.ok === false ? 1 : 0;
}

module.exports = { register, list, invoke, validate, execute, fit };

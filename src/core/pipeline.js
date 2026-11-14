// Build pipeline engine (ported from DevPipeline): shell / msbuild /
// unity-batch / uat / ai / mcp-tool steps defined as JSON, with live log
// streaming, cancellation (process-tree kill) and bounded run history.
// AI steps run through the hub's local-model delegator; mcp-tool steps run
// through the hub's downstream MCP connections — no separate providers.
// Storage: %APPDATA%/ai-hub/{pipelines.json,runs.json,logs/<runId>/}.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const { hubDataDir } = require('./paths');
const projects = require('./projects');
const localSteps = require('./local-pipeline-steps');
const internalSteps = require('./pipeline-internal-steps');
const { mcpResultToLog } = internalSteps;

const PIPELINES_FILE = path.join(hubDataDir(), 'pipelines.json');
const RUNS_FILE = path.join(hubDataDir(), 'runs.json');
const LOGS_ROOT = path.join(hubDataDir(), 'logs');

const MAX_RUN_HISTORY = 50;
const { UUID_RE } = require('./pipeline-run-logs');

// ---- event stream (GUI live log) ----------------------------------------

let emitter = null;
/** GUI wiring: fn(channel, payload) with channel 'pipeline:log' | 'pipeline:status' */
function setEmitter(fn) {
  emitter = fn;
}
function emit(channel, payload) {
  if (emitter) {
    try { emitter(channel, payload); } catch { /* renderer gone */ }
  }
}

// ---- stores --------------------------------------------------------------

function readJson(file,key){
 try{const obj=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(obj[key]))throw Error('Invalid '+key+' store');return obj;}
 catch(e){if(e.code==='ENOENT')return {version:1,[key]:[]};throw e;}
}
function writeJson(file,obj){
 fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp';
 fs.writeFileSync(temp,JSON.stringify(obj,null,2),'utf8');fs.renameSync(temp,file);
}

// ---- variable substitution ----------------------------------------------

/**
 * substitute ${...}: project.path/name/editorPath/slnPath/uprojectPath/
 * engineVersion, engine.uatPath/editorPath/installLocation, run.id, env.NAME
 */
function substituteVars(input, ctx) {
  return input.replace(/\$\{([a-zA-Z0-9_.]+)\}/g, (_whole, key) => {
    const value = resolveVar(key, ctx);
    if (value === undefined) throw new Error(`치환할 수 없는 변수입니다: \${${key}}`);
    return value;
  });
}

function resolveVar(key, ctx) {
  const [scope, ...rest] = key.split('.');
  const field = rest.join('.');
  switch (scope) {
    case 'project': {
      const p = ctx.project;
      if (!p) return undefined;
      switch (field) {
        case 'path': return p.path;
        case 'name': return p.name;
        case 'editorPath': return projects.resolveEditorPath(p);
        case 'slnPath': return projects.resolveSlnPath(p);
        case 'uprojectPath': return p.uprojectPath;
        case 'engineVersion': return p.engineVersion;
        case 'engineRoot': return p.engineRoot;
        default: return undefined;
      }
    }
    case 'engine': {
      if (!ctx.engine) return undefined;
      switch (field) {
        case 'uatPath': return ctx.engine.uatPath;
        case 'editorPath': return ctx.engine.editorPath;
        case 'installLocation': return ctx.engine.installLocation;
        default: return undefined;
      }
    }
    case 'run':
      return field === 'id' ? ctx.runId : undefined;
    case 'state': {const value=require('./pipeline-state-graph').read(ctx.state||{},field);return value===undefined?undefined:typeof value==='string'?value:JSON.stringify(value);}
    case 'env':
      return process.env[field];
    default:
      return undefined;
  }
}

// ---- step resolution (process-backed steps) ------------------------------

/** resolve shell/msbuild/unity-batch/uat to { exe, args, cwd?, env?, viaCmd? } */
async function resolveStep(step, ctx, project) {
  const sub = (s) => substituteVars(s, ctx);

  switch (step.type) {
    case 'shell':
      return {
        exe: 'cmd',
        args: ['/d', '/s', '/c', sub(step.command)],
        cwd: step.cwd ? sub(step.cwd) : project && project.path,
        env: step.env ? Object.fromEntries(Object.entries(step.env).map(([k, v]) => [k, sub(v)])) : undefined,
      };

    case 'msbuild': {
      const tools = await projects.detectTools();
      const msbuild = tools.visualStudio && tools.visualStudio.msbuildPath;
      if (!msbuild || !fs.existsSync(msbuild)) {
        throw new Error('MSBuild를 찾을 수 없습니다. Visual Studio가 설치되어 있는지 확인하세요.');
      }
      const args = [sub(step.sln), '/m', '/v:m', `/p:Configuration=${step.configuration || 'Debug'}`];
      if (step.platform) args.push(`/p:Platform=${step.platform}`);
      if (step.targets && step.targets.length) args.push(`/t:${step.targets.join(';')}`);
      if (step.extraArgs) args.push(...step.extraArgs.map(sub));
      return { exe: msbuild, args, cwd: project && project.path };
    }

    case 'unity-batch': {
      if (!project || project.kind !== 'unity') {
        throw new Error('unity-batch 스텝은 Unity 프로젝트가 연결된 파이프라인에서만 실행할 수 있습니다.');
      }
      const editor = projects.resolveEditorPath(project);
      if (!editor || !fs.existsSync(editor)) {
        throw new Error(`Unity 에디터(${project.engineVersion})를 찾을 수 없습니다.`);
      }
      const args = [
        '-batchmode', '-quit',
        '-projectPath', project.path,
        '-executeMethod', sub(step.executeMethod),
        '-logFile', '-', // stream editor log to stdout for live view
      ];
      if (step.extraArgs) args.push(...step.extraArgs.map(sub));
      return { exe: editor, args };
    }

    case 'uat': {
      if (!project || project.kind !== 'unreal') {
        throw new Error('uat 스텝은 Unreal 프로젝트가 연결된 파이프라인에서만 실행할 수 있습니다.');
      }
      const tools = await projects.detectTools();
      const engine =
        tools.unrealEngines.find((e) => e.version === project.engineVersion || e.version.startsWith(project.engineVersion)) ||
        tools.unrealEngines[0];
      if (!engine || !fs.existsSync(engine.uatPath)) {
        throw new Error(`Unreal 엔진(${project.engineVersion})의 RunUAT.bat을 찾을 수 없습니다.`);
      }
      const args = [sub(step.command)];
      if (project.uprojectPath) args.push(`-project=${project.uprojectPath}`);
      if (step.args) args.push(...step.args.map(sub));
      return { exe: engine.uatPath, args, viaCmd: true };
    }

    default:
      throw new Error(`알 수 없는 스텝 타입: ${step.type}`);
  }
}

/** kill a whole process tree (Windows: taskkill /T) */
function killTree(pid, force) {
  if (process.platform === 'win32') {
    exec(`taskkill /pid ${pid} /T${force ? ' /F' : ''}`, { windowsHide: true }, () => {});
  } else {
    try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* gone */ }
  }
}

// ---- pipeline CRUD -------------------------------------------------------

function list() {
  return readJson(PIPELINES_FILE, 'pipelines').pipelines;
}

function save(pipeline) {
  if(pipeline?.graph){
    const graph=require('./pipeline-state-graph').validate(pipeline.graph);
    if(pipeline.auto?.enabled)throw Error('상태 그래프는 명시적으로 실행하세요. 자동 실행은 지원하지 않습니다.');
    pipeline={...pipeline,graph,steps:graph.nodes.filter(n=>n.kind==='step').map(n=>n.step),auto:{...pipeline.auto,enabled:false}};
  }
  if (!pipeline || typeof pipeline.name !== 'string' || !Array.isArray(pipeline.steps)) {
    throw new Error('파이프라인은 { name, steps[] } 형태여야 합니다.');
  }
  const now = new Date().toISOString();
  const normalized = {
    ...pipeline,
    id: pipeline.id || crypto.randomUUID(),
    createdAt: pipeline.createdAt || now,
    updatedAt: now,
  };
  const f = readJson(PIPELINES_FILE, 'pipelines');
  const exists = f.pipelines.some((p) => p.id === normalized.id);
  f.pipelines = exists
    ? f.pipelines.map((p) => (p.id === normalized.id ? normalized : p))
    : [...f.pipelines, normalized];
  writeJson(PIPELINES_FILE, f);
  return normalized;
}

function removePipeline(id) {
  const f = readJson(PIPELINES_FILE, 'pipelines');
  f.pipelines = f.pipelines.filter((p) => p.id !== id);
  writeJson(PIPELINES_FILE, f);
}

// ---- run history ---------------------------------------------------------

// runs.json에는 graphCheckpoint만 둔다. graphState는 그 data와 같은 값이라 읽을 때 채운다(실제 L1 기록에서 26 KB가 두 번 저장됐다).
const withGraphState = (r) => (r && r.graphCheckpoint ? { ...r, graphState: r.graphCheckpoint.data } : r);

function history(pipelineId) {
  const runs = readJson(RUNS_FILE, 'runs').runs.map(withGraphState);
  return pipelineId ? runs.filter((r) => r.pipelineId === pipelineId) : runs;
}

function persistRun(record) {
  const f = readJson(RUNS_FILE, 'runs');
  const others = f.runs.filter((r) => r.runId !== record.runId);
  // 읽을 때 채운 사본을 다시 저장하는 경우(재개·취소)와 1.32.10까지의 기록에서도 중복을 뺀다.
  f.runs = [record, ...others].slice(0, MAX_RUN_HISTORY).map(({ graphState: _copy, ...r }) => r);
  writeJson(RUNS_FILE, f);
}

/** runs left 'running' by a crash can never resume — mark them failed */
function sweepStaleRuns() {
  const f = readJson(RUNS_FILE, 'runs');
  let touched = false;
  f.runs = f.runs.map((r) => {
    if (r.status !== 'running') return r;
    touched = true;
    return {
      ...r,
      status: 'failed',
      finishedAt: r.finishedAt || new Date().toISOString(),
      steps: r.steps.map((s) =>
        s.status === 'running' ? { ...s, status: 'failed' }
        : s.status === 'pending' ? { ...s, status: 'skipped' }
        : s
      ),
    };
  });
  if (touched) writeJson(RUNS_FILE, f);
}

/** delete log dirs of runs pruned out of history (bounded disk usage) */
function cleanupOrphanLogs() {
  try {
    if (!fs.existsSync(LOGS_ROOT)) return;
    const known = new Set(readJson(RUNS_FILE, 'runs').runs.map((r) => r.runId));
    for (const entry of fs.readdirSync(LOGS_ROOT)) {
      if (UUID_RE.test(entry) && !known.has(entry)) {
        fs.rmSync(path.join(LOGS_ROOT, entry), { recursive: true, force: true });
      }
    }
  } catch { /* best-effort */ }
}

// 단계 로그 파일·GUI 실시간 로그는 pipeline-run-logs.js. 그래프 단계 출력은 실행 중인 run에 따로 담는다.
const { readLog, readStepInput, appendLog, flushLogBuffer, logBuffers, fileStreams } = require('./pipeline-run-logs').createRunLogs({
  root: LOGS_ROOT, emit,
  onChunk: (runId, chunk) => { const graphRun = active.get(runId); if (graphRun?.graphCapture) graphRun.graphCapture.text = (graphRun.graphCapture.text + chunk).slice(-12000); },
  onWarning: (runId, text) => { const r = active.get(runId); if (r) (r.record.warnings = r.record.warnings || []).push(text); },
});

const internalStepContext = { appendLog, readStepInput, substituteVars };

// ---- execution -----------------------------------------------------------

const active = new Map(); // runId -> { record, child?, cancelled, abort }

function cancel(runId) {
  const run = active.get(runId);
  if(!run){
    const record=history().find(r=>r.runId===runId&&r.status==='paused'&&r.graphCheckpoint);
    if(!record)return {cancelled:false};
    record.status='cancelled';record.finishedAt=new Date().toISOString();persistRun(record);return {cancelled:true};
  }
  run.cancelled = true;
  run.abort.abort();
  if (run.cancelHook) {
    try { run.cancelHook(); } catch { /* best-effort */ }
  }
  const child = run.child;
  const pid = child && child.pid;
  if (pid) {
    killTree(pid, false);
    setTimeout(() => {
      const still = active.get(runId);
      if (still && still.child && still.child.pid === pid) killTree(pid, true);
    }, 5000);
  }
  return { cancelled: true };
}

function start(pipelineId, projectIdOverride) {
  const pipeline = list().find((p) => p.id === pipelineId);
  if (!pipeline) throw new Error(`파이프라인을 찾을 수 없습니다: ${pipelineId}`);

  if(pipeline.graph)require('./pipeline-state-graph').validate(pipeline.graph);
  const runId = crypto.randomUUID();
  const record = {
    runId,
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    projectId: projectIdOverride || pipeline.projectId,
    caller: require('./caller').current(),
    startedAt: new Date().toISOString(),
    status: 'running',
    steps: pipeline.graph?[]:pipeline.steps.map((s) => ({ name: s.name, type: s.type, status: 'pending' })),
  };
  const activeRun = { record, cancelled: false, abort: new AbortController() };
  active.set(runId, activeRun);
  persistRun(record);

  executeAsPipeline(pipeline, activeRun).catch(() => {});
  return { runId };
}

// Offload and model steps record the pipeline as their caller (keeping the starter's client); runs.json keeps the starter.
function executeAsPipeline(pipeline, run) {
  const caller = require('./caller');
  return caller.run({ ...caller.current(), via: 'pipeline', runId: run.record.runId }, () => execute(pipeline, run));
}

function resume(runId,stateOverride) {
  if(!UUID_RE.test(runId)||active.has(runId))throw Error('재개할 중단된 실행을 선택하세요.');
  const record=history().find(r=>r.runId===runId&&r.status==='paused'&&r.graphCheckpoint);
  if(!record)throw Error('사용자 검토에서 중단된 그래프만 재개할 수 있습니다.');
  const pipeline=list().find(p=>p.id===record.pipelineId),graph=require('./pipeline-state-graph');
  if(!pipeline?.graph||graph.fingerprint(pipeline.graph)!==record.graphCheckpoint.graphSha)throw Error('그래프가 변경되었습니다. 새 실행을 시작하세요.');
  if(stateOverride!==undefined){stateOverride=graph.clean(stateOverride);if(!stateOverride||typeof stateOverride!=='object'||Array.isArray(stateOverride))throw Error('재개 상태는 객체여야 합니다.');}
  const run={record,cancelled:false,abort:new AbortController(),graphResume:true,stateOverride};
  record.status='running';delete record.finishedAt;active.set(runId,run);persistRun(record);
  executeAsPipeline(pipeline,run).catch(()=>{});return {runId};
}

function runStatus(runId) {
  const live = active.get(runId);
  if (live) return withGraphState(live.record);
  return history().find((r) => r.runId === runId) || null;
}

/** 지금 돌고 있는 실행 수. 자동 업데이트가 작업을 끊지 않도록 확인용. */
function activeCount() {
  return active.size;
}
require('./change-signals').registerBusy('pipeline', () => active.size > 0);

/** Running runs with their current graph node, for the live delegation map (no I/O). */
function running() {
  return [...active.values()].map(({ record: r }) => ({ runId: r.runId, pipelineId: r.pipelineId, name: r.pipelineName,
    nodeId: (r.steps[r.steps.length - 1] || {}).nodeId || null, steps: r.steps.length }));
}

function tryGetProject(id) {
  try { return projects.getById(id); } catch { return undefined; }
}

function markRemainingSkipped(record, fromIndex) {
  for (let i = fromIndex; i < record.steps.length; i++) {
    if (record.steps[i].status === 'pending') record.steps[i].status = 'skipped';
  }
}

async function execute(pipeline, run) {
  return require('./pipeline-run-lifecycle').execute(pipeline,run,{tryGetProject,executeStep,markRemainingSkipped,appendLog,emit,persistRun,active,flushLogBuffer,logBuffers,fileStreams});
}

async function executeStep(step, stepIndex, run, project) {
  const ctx = { project, runId: run.record.runId, state:run.graphState };

  if (step.type === 'api-request') return require('./pipeline-api-request').execute(step,stepIndex,run,ctx,{appendLog,substituteVars,persistRun});
  if (step.type === 'delay') return require('./pipeline-delay').execute(step,run);
  if (step.type === 'herdr-agent') return require('./pipeline-herdr-step').execute(step, stepIndex, run, ctx, { appendLog, substituteVars });
  if (step.type === 'offload') return require('./pipeline-offload-step').execute(step, stepIndex, run, ctx, { appendLog, substituteVars });
  if (step.type === 'hub-tool') return require('./pipeline-hub-step').execute(step, stepIndex, run, ctx, { appendLog, substituteVars });
  if (step.type === 'ai') return internalSteps.executeAiStep(step, stepIndex, run, ctx, internalStepContext);
  if (step.type === 'mcp-tool') return internalSteps.executeMcpStep(step, stepIndex, run, ctx, internalStepContext);
  if (step.type === 'source-index') return internalSteps.executeSourceIndexStep(step, stepIndex, run, ctx, internalStepContext);
  if (step.type === 'finetune-gen') return internalSteps.executeFinetuneStep(step, stepIndex, run, ctx, internalStepContext);
  if (step.type === 'llama-chat' || step.type === 'comfy-workflow') return localSteps.execute(step, stepIndex, run, ctx, { appendLog, substituteVars });
  // A GPU program such as LoRA training holds the local GPU slot for its whole run, like ComfyUI workflows (rule 13).
  if (step.type === 'shell' && Number(step.gpuVramMiB) > 0) {
    appendLog(run.record.runId, stepIndex, `[hub] GPU 슬롯 대기·확보 (요청 ${Number(step.gpuVramMiB)} MiB)\r\n`, 'stdout');
    return require('./local-runtime').withGpu({ vramMiB: Number(step.gpuVramMiB), signal: run.abort?.signal }, () => runProgram(step, stepIndex, run, ctx, project));
  }
  return runProgram(step, stepIndex, run, ctx, project);
}

async function runProgram(step, stepIndex, run, ctx, project) {
  const spec = await resolveStep(step, ctx, project);
  const exe = spec.viaCmd ? 'cmd' : spec.exe;
  const args = spec.viaCmd ? ['/d', '/s', '/c', spec.exe, ...spec.args] : spec.args;

  appendLog(run.record.runId, stepIndex, `[hub] ${step.name}\r\n[hub] $ ${spec.exe} ${spec.args.join(' ')}\r\n\r\n`, 'stdout');

  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      cwd: spec.cwd,
      env: spec.env ? { ...process.env, ...spec.env } : undefined,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    run.child = child;

    child.stdout.on('data', (chunk) => appendLog(run.record.runId, stepIndex, chunk.toString('utf8'), 'stdout'));
    child.stderr.on('data', (chunk) => appendLog(run.record.runId, stepIndex, chunk.toString('utf8'), 'stderr'));
    child.on('error', (err) => {
      appendLog(run.record.runId, stepIndex, `\r\n[hub] 프로세스 실행 실패: ${err.message}\r\n`, 'stderr');
      run.child = undefined;
      resolve(-1);
    });
    child.on('close', (code) => {
      run.child = undefined;
      flushLogBuffer(run.record.runId);
      resolve(code === null || code === undefined ? -1 : code);
    });
  });
}

// startup hygiene
sweepStaleRuns();
cleanupOrphanLogs();

module.exports = {
  setEmitter,
  list, save, removePipeline, history, readLog, start, resume, cancel, runStatus, activeCount, running,
  // exported for tests
  substituteVars, mcpResultToLog,
  PIPELINES_FILE, RUNS_FILE,
};

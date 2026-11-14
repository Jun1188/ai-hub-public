// Headless test for the DevPipeline integration: project registry round-trip
// with a fake Unity project, tool detection, variable substitution, and a
// shell + ai pipeline run end to end (ai step needs LM Studio running).
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const projects = require('../src/core/projects');
const pipeline = require('../src/core/pipeline');

function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  // ---- variable substitution ----
  const ctx = { project: { path: 'C:\\P', name: 'Game', engineVersion: '5.5' }, runId: 'RID' };
  assert(pipeline.substituteVars('${project.name}@${run.id}', ctx) === 'Game@RID', 'substituteVars basic');
  let threw = false;
  try { pipeline.substituteVars('${nope.x}', ctx); } catch { threw = true; }
  assert(threw, 'substituteVars throws on unknown var');

  // ---- mcp result flattening ----
  const flat = pipeline.mcpResultToLog({ content: [{ type: 'text', text: 'hi' }], isError: false });
  assert(flat.text === 'hi' && !flat.isError, 'mcpResultToLog');

  // ---- fake unity project registry round-trip ----
  const fake = path.join(os.tmpdir(), 'aihub-fake-unity-' + Date.now());
  fs.mkdirSync(path.join(fake, 'ProjectSettings'), { recursive: true });
  fs.writeFileSync(path.join(fake, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.32f1\n');
  const before = projects.list().length;
  const proj = await projects.add(fake);
  assert(proj.kind === 'unity' && proj.engineVersion === '6000.0.32f1', 'unity project detected');
  assert(projects.list().length === before + 1, 'project persisted');
  const again = await projects.refresh(proj.id);
  assert(again.id === proj.id && again.kind === 'unity', 'refresh keeps id');

  // ---- tool detection (informational) ----
  const tools = await projects.detectTools(true);
  console.log(`INFO: unity=${tools.unityEditors.length} unreal=${tools.unrealEngines.length}` +
    ` vs=${tools.visualStudio ? 'yes' : 'no'} antigravity=${tools.antigravityPath ? 'yes' : 'no'}`);

  // ---- shell pipeline end to end ----
  const saved = pipeline.save({
    name: 'test-shell',
    projectId: proj.id,
    steps: [
      { type: 'shell', name: 'greet', command: 'echo hello-from-${project.name}' },
      { type: 'shell', name: 'fail-ok', command: 'exit 3', continueOnError: true },
      { type: 'shell', name: 'last', command: 'echo done' },
    ],
  });
  const { runId } = pipeline.start(saved.id);
  const record = await waitRun(runId, 60000);
  assert(record && record.status === 'failed', 'run finishes (failed: continueOnError step exit 3)');
  assert(record.steps[0].status === 'succeeded' && record.steps[1].status === 'failed' && record.steps[2].status === 'succeeded',
    'per-step statuses with continueOnError');
  const log0 = pipeline.readLog(runId, 0);
  assert(log0.includes('hello-from-' + path.basename(fake)), 'variable substitution in shell + log capture');

  // ---- ai step (requires LM Studio) ----
  const aiPipe = pipeline.save({
    name: 'test-ai',
    steps: [
      { type: 'shell', name: 'produce', command: 'echo BANANA-77 is the secret code' },
      { type: 'ai', name: 'summarize', taskType: 'reasoning', inputFrom: 'previousLog', maxTokens: 2000,
        promptTemplate: 'What is the secret code in this log? Answer with the code only.\n{{input}}' },
    ],
  });
  const aiRun = pipeline.start(aiPipe.id);
  const aiRecord = await waitRun(aiRun.runId, 240000);
  if (aiRecord && aiRecord.status === 'succeeded') {
    const aiLog = pipeline.readLog(aiRun.runId, 1);
    assert(/BANANA-77/.test(aiLog), 'ai step reads previous log and answers');
  } else {
    console.log(`SKIP: ai step (status=${aiRecord && aiRecord.status}) — LM Studio 필요`);
  }

  // ---- cleanup ----
  pipeline.removePipeline(saved.id);
  pipeline.removePipeline(aiPipe.id);
  projects.remove(proj.id);
  fs.rmSync(fake, { recursive: true, force: true });
  assert(!pipeline.list().some((p) => p.id === saved.id || p.id === aiPipe.id), 'pipelines removed');
  console.log('DONE');
  process.exit(process.exitCode || 0);
}

function waitRun(runId, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const t = setInterval(() => {
      const r = pipeline.runStatus(runId);
      if ((r && r.status !== 'running') || Date.now() - started > timeoutMs) {
        clearInterval(t);
        resolve(r);
      }
    }, 300);
  });
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});

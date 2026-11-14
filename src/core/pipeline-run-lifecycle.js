'use strict';
async function execute(pipeline, run, io) {
  let status = 'failed';
  const row = (state) => require('./work-table').job('pipeline', run.record.runId, { worker: pipeline.id || 'run', state,
    summary: `pipeline ${pipeline.name || pipeline.id || ''}${state === 'working' ? '' : ' ' + status}` });
  row('working');
  try {
    status = await executeSteps(pipeline, run, io);
  } finally {
    row(status === 'succeeded' ? 'done' : 'failed');
  }
}

async function executeSteps(pipeline, run, io) {
  const {tryGetProject,executeStep,markRemainingSkipped,appendLog,emit,persistRun,active,flushLogBuffer,logBuffers,fileStreams}=io;
  const { record } = run;
  const project = record.projectId ? tryGetProject(record.projectId) : undefined;
  let finalStatus = 'succeeded';

  if(pipeline.graph){try{finalStatus=await require('./pipeline-graph-adapter').graphExecute(pipeline,run,io);}catch(e){finalStatus=run.cancelled?'cancelled':'failed';appendLog(record.runId,Math.max(0,record.steps.length-1),'[graph] '+e.message+'\n','stderr');}}
  else {
  for (let i = 0; i < pipeline.steps.length; i++) {
    if (run.cancelled) {
      markRemainingSkipped(record, i);
      finalStatus = 'cancelled';
      break;
    }

    const step = pipeline.steps[i];
    record.steps[i].status = 'running';
    emit('pipeline:status', { runId: record.runId, status: 'running', stepIndex: i });

    const startedAt = Date.now();
    let exitCode;
    try {
      exitCode = await executeStep(step, i, run, project);
    } catch (err) {
      appendLog(record.runId, i, `\r\n[hub] 스텝 실패: ${String(err.message || err)}\r\n`, 'stderr');
      exitCode = -1;
    }

    record.steps[i].exitCode = exitCode;
    record.steps[i].durationMs = Date.now() - startedAt;

    if (run.cancelled) {
      record.steps[i].status = 'cancelled';
      markRemainingSkipped(record, i + 1);
      finalStatus = 'cancelled';
      break;
    }

    if (exitCode === 0) {
      record.steps[i].status = 'succeeded';
    } else {
      record.steps[i].status = 'failed';
      finalStatus = 'failed';
      if (!step.continueOnError) {
        markRemainingSkipped(record, i + 1);
        break;
      }
    }
  }

  }
  // Once callers see a terminal state they can immediately read the step logs.
  // Wait for actual WriteStreams to finish, including their error path.
  const closing = [];
  for (const [key, stream] of fileStreams) {
    if (!key.startsWith(record.runId + ':')) continue;
    if (stream.once) {
      closing.push(require('node:stream/promises').finished(stream, { cleanup: true }).catch(() => {}));
    }
    stream.end();
  }
  if (closing.length) await Promise.all(closing);
  for (const key of fileStreams.keys()) {
    if (key.startsWith(record.runId + ':')) fileStreams.delete(key);
  }
  flushLogBuffer(record.runId);
  logBuffers.delete(record.runId);
  record.status = finalStatus;
  record.finishedAt = new Date().toISOString();
  persistRun(record);
  active.delete(record.runId);
  emit('pipeline:status', { runId: record.runId, status: finalStatus });
  return finalStatus;
}

module.exports={execute};

'use strict';
const fs = require('fs');
const path = require('path');
const ids = new Set(['rsi-l1-artifact','rsi-l2-evaluator','rsi-l3-meta']);
const safeId = value => typeof value === 'string' && /^[\w-]{1,80}$/.test(value) ? value : null;
const status = value => ['pending','running','succeeded','failed','cancelled','paused','skipped','review'].includes(value) ? value : 'unknown';

async function decisionSummary(file) {
  try {
    const handle = await fs.promises.open(file,'r');
    let data;
    try {
      const size=(await handle.stat()).size;
      if (size > 2*1024*1024) return {state:'too-large'};
      const bytes=Buffer.alloc(size);
      const {bytesRead}=await handle.read(bytes);
      if(bytesRead!==size)return {state:'unreadable'};
      data=JSON.parse(bytes.toString('utf8'));
    } finally {await handle.close();}
    if (!['KEEP_BASE','ADOPT','MERGE'].includes(data.decision)) return {state:'unreadable'};
    const outcomes=(Array.isArray(data.rows)?data.rows:[]).slice(0,24).map(row=>{
      const reason=typeof row?.reason==='string'?row.reason:'';
      const basis=reason.startsWith('critical:')?'고정 회귀 실패':reason.startsWith('health:')?'건강 검사 실패':
        reason.startsWith('lcb ')?'개선 하한·최소 개선폭 판정':reason==='best'?'최고 점수':reason==='merge-partner'?'결합 후보':'추가 근거 미기록';
      return {candidate:safeId(row?.candidate),basis,improvement:Number.isFinite(row?.improvement)?row.improvement:null};
    });
    return {state:'recorded',verdict:data.decision,outcomes,
      chosen:(Array.isArray(data.chosen)?data.chosen:[]).map(safeId).filter(Boolean).slice(0,8),
      rejected:(Array.isArray(data.rows)?data.rows:[]).filter(row=>row?.decision==='dropped').length};
  } catch (error) { return {state:error.code==='ENOENT'?'not-recorded':'unreadable'}; }
}

async function list(deps={}) {
  const rows = (deps.pipeline || require('../pipeline')).history();
  const base = deps.dataDir || require('../paths').hubDataDir();
  return Promise.all(rows.filter(r=>ids.has(r.pipelineId)&&safeId(r.runId)).slice(0,12).map(async r=>{
    const steps = (Array.isArray(r.steps)?r.steps:[]).slice(0,128).map(step=>({
      node:safeId(step.nodeId),status:status(step.status),visit:Number.isInteger(step.visit)?step.visit:null,
      exit:Number.isInteger(step.exitCode)?step.exitCode:null,ms:Number.isFinite(step.durationMs)&&step.durationMs>=0?step.durationMs:null
    }));
    return {runId:r.runId,pipeline:r.pipelineId,status:status(r.status),steps,
      decision:r.pipelineId==='rsi-l1-artifact'?await decisionSummary(path.join(base,'rsi','runs',r.runId,'decision.json')):{state:'not-applicable'}};
  }));
}
module.exports={list};

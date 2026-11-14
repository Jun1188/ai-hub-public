'use strict';
async function graphExecute(pipeline,run,io){
 const {record}=run,graph=require('./pipeline-state-graph');let preparedIndex=null;
 const result=await graph.execute(pipeline.graph,{
  checkpoint:run.graphResume?record.graphCheckpoint:undefined,stateOverride:run.stateOverride,shouldStop:()=>run.cancelled,
  executeStep:async(n,data)=>{
   const index=record.steps.length;preparedIndex=index;
   record.steps.push({nodeId:n.id,name:n.name||n.step.name,type:n.step.type,status:'running',startedAt:Date.now()});
   run.graphState=data;run.graphCapture={text:''};run.graphStepData=undefined;
   io.emit('pipeline:status',{runId:record.runId,status:'running',stepIndex:index,nodeId:n.id});
   const started=Date.now();let exitCode;
   try{const step=await require('./game-pipeline-context').prepare(n);exitCode=await io.executeStep(step,index,run,record.projectId?io.tryGetProject(record.projectId):undefined);}
   catch(e){io.appendLog(record.runId,index,'[hub] '+String(e.message||e)+'\n','stderr');exitCode=-1;}
   const output=run.graphCapture.text;run.graphCapture=null;
   record.steps[index].durationMs=Date.now()-started;return{exitCode,output,data:run.graphStepData};
  },
  onTransition:async(event,checkpoint)=>{
   const index=preparedIndex===null?record.steps.length:preparedIndex;
   if(preparedIndex===null)record.steps.push({nodeId:event.nodeId,name:event.nodeId,type:event.kind});
   Object.assign(record.steps[index],event);preparedIndex=null;
   record.graphCheckpoint=checkpoint;
   io.appendLog(record.runId,index,'[graph] '+event.nodeId+' #'+event.visit+' '+event.status+' -> '+(event.next||'END')+'\n','stdout');
   io.persistRun(record);io.emit('pipeline:status',{runId:record.runId,status:'running',stepIndex:index,nodeId:event.nodeId,transition:event.transition});
  },
 });
 return result.status;
}
module.exports={graphExecute};

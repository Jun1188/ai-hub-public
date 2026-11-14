'use strict';
async function execute(step,index,run,ctx,io){
 const herdr=require('./herdr');
 const input={action:'prompt',requestId:require('node:crypto').randomUUID(),session:step.session,target:step.target,prompt:io.substituteVars(step.prompt,ctx),wait:true,until:step.until||'done',timeoutMs:step.timeoutMs||300000};
 const submitted=herdr.submit(input);
 run.record.steps[index].herdrRequestId=submitted.id;
 io.appendLog(run.record.runId,index,'[herdr] '+input.session+' / '+input.target+' request '+submitted.id+'\n','stdout');
 let result;
 do{
  result=herdr.status(submitted.id);
  if(result.state==='running')await new Promise(resolve=>setTimeout(resolve,1000));
 }while(result.state==='running'&&!run.cancelled);
 // Cancelling this pipeline never claims the separate terminal agent stopped.
 if(run.cancelled){io.appendLog(run.record.runId,index,'[herdr] 파이프라인 대기 취소. 에이전트는 대상 세션에서 직접 확인하세요.\n','stderr');return 1;}
 const compact=JSON.stringify(result.result||{});
 run.graphStepData={requestId:result.id,state:result.state,session:input.session,target:input.target,result:require('./secret-scrub').scrub(compact).slice(0,12000)};
 io.appendLog(run.record.runId,index,'[herdr] '+result.state+'\n','stdout');
 const blocked=/"(?:state|status)"\s*:\s*"blocked"/.test(compact);
 return result.state==='succeeded'&&!blocked?0:1;
}
module.exports={execute};

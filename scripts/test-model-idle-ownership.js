'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-idle-owner-fixture-')),saved=[];
function mock(name,exports){const id=require.resolve('../src/core/'+name);saved.push([id,require.cache[id]]);require.cache[id]={id,filename:id,loaded:true,exports};}
(async()=>{
  mock('paths',{hubDataDir:()=>root});mock('config',{load:()=>({localRuntimes:{llamaUrl:'http://127.0.0.1:8080'}})});
  let leased=false,loaded=true,stops=0;
  mock('local-inference-lease',{busy:()=>leased});
  mock('lmstudio',{baseUrl:()=> 'http://127.0.0.1:1234'});
  mock('credential-broker',{jobId:()=> 'fixture',request:async()=>({models:[{type:'llm',key:'lm-fixture',loaded_instances:loaded?[{id:'instance'}]:[]}]})});
  let instanceId='fixture-first',identity={origin:'http://127.0.0.1:1234',port:1234,pid:123,startedAt:'2026-10-09T00:00:00Z'};
  mock('local-runtime',{llamaStatus:async()=>({running:true,models:[{id:'llama-fixture',state:loaded?'loaded':'unloaded'}]}),
    llamaControlStatus:()=>({managed:true,pid:123,instanceId}),stopLlama:async()=>{stops++;loaded=false;},configuredLocalLlama:async()=>null});
  mock('local-server-control',{identity:async()=>identity,stop:async()=>{stops++;}});
  const control=require('../src/core/model-control');
  const llama={provider:'llamacpp',model:'llama-fixture',serverOwned:true,instanceId:'fixture-first'};
  leased=true;await assert.rejects(control.cleanupOwned(llama),/cannot overlap/);leased=false;assert.equal(stops,0);
  instanceId='fixture-second';await assert.rejects(control.cleanupOwned(llama),/process changed/);assert.equal(stops,0);
  instanceId='fixture-first';await control.cleanupOwned(llama);assert.equal(stops,1);
  const original={...identity},lm={provider:'lmstudio',model:'lm-fixture',serverOwned:true,serverIdentity:original,runtimeTtl:true};
  identity={...original,startedAt:'2026-10-09T01:00:00Z'};await assert.rejects(control.cleanupOwned(lm),/changed/);assert.equal(stops,1);
  identity=original;await control.cleanupOwned(lm);assert.equal(stops,2);
  loaded=true;assert.equal((await control.cleanupOwned(lm)).retain,true);assert.equal(stops,2);
  assert.equal(control.transportUnavailable({code:'BROKER_HTTP_REJECTED',status:401}),false);
  assert.equal(control.transportUnavailable({code:'BROKER_OUTCOME_UNKNOWN',transportCode:'ECONNREFUSED'}),true);
  assert.equal(control.transportUnavailable({code:'BROKER_OUTCOME_UNKNOWN'}),false);
  assert.equal(control.transportUnavailable(new Error('vault decryption failed')),false);
  console.log('Passed: no idle cleanup during inference, llama instance token prevents PID reuse, LM PID/start-time/origin listener binding, native idle TTL retains active model, HTTP/vault/timeout never trigger server startup fallback');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
  for(const[id,value]of saved)value?require.cache[id]=value:delete require.cache[id];
  if(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('hub-idle-owner-fixture-'))fs.rmSync(root,{recursive:true,force:true});
});

'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-cpu-test-')),saved=[],originalFetch=global.fetch;
function mock(name,value){const id=require.resolve('../src/core/'+name);saved.push([id,require.cache[id]]);require.cache[id]={id,filename:id,loaded:true,exports:value};}
const wait=()=>new Promise(r=>setTimeout(r,5));
(async()=>{
  mock('paths',{hubDataDir:()=>root});mock('lmstudio',{baseUrl:()=> 'http://127.0.0.1:1234'});
  mock('credential-vault',{status:()=>[{provider:'lmstudio',stored:false}]});
  mock('offload',{active:()=>[]});
  mock('aider-studio',{isBusy:()=>false});
  let used=4*1024**3,calls=0,loaded=false;
  mock('hardware-optimizer',{refresh:async()=>{},reserveLocalSlot:async()=>()=>{},status:()=>({at:Date.now(),onAcPower:true,heavyApps:[],failures:0}),policy:()=>({}),slotState:()=>({active:1})});
  mock('resource-monitor',{snapshot:async()=>({sampledAt:Date.now(),cpu:{usagePercent:5},ram:{totalBytes:24*1024**3,usedBytes:used,usagePercent:used/(24*1024**3)*100},gpu:{available:true,devices:[{totalMiB:8192,usedMiB:7500,usagePercent:2}]}})});
  mock('local-server-control',{load:async(model,ctx)=>{calls++;assert.equal(model,'fixture');assert.equal(ctx,2048);loaded=true;return{placement:'cpu'};}});
  global.fetch=async()=>({ok:true,json:async()=>({models:[{key:'fixture',type:'llm',size_bytes:4*1024**3,loaded_instances:loaded?[{id:'fixture'}]:[],max_context_length:8192}]})});
  const models=require('../src/core/model-control');
  const first=models.start({provider:'lmstudio',model:'fixture',placement:'cpu',contextLength:2048});
  assert.equal(models.start({provider:'lmstudio',model:'fixture',placement:'cpu',contextLength:2048}).requestId,first.requestId);
  while(models.result(first.requestId).state==='running')await wait();
  assert.equal(models.result(first.requestId).state,'completed');assert.equal(calls,1);assert(!models.busy());
  loaded=false;used=22*1024**3;
  const blocked=models.start({provider:'lmstudio',model:'fixture',placement:'cpu',contextLength:2048});
  while(models.result(blocked.requestId).state==='running')await wait();
  assert.equal(models.result(blocked.requestId).state,'failed');assert.equal(calls,1);assert(!models.busy());
  assert.throws(()=>models.start({provider:'lmstudio',model:'fixture',placement:'invalid'}),/Invalid preparation/);
  console.log('Passed: explicit CPU placement, deduplication, observed loaded catalog, VRAM-independent RAM guard, no invalid provider load');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
  global.fetch=originalFetch;for(const[id,value]of saved)value?require.cache[id]=value:delete require.cache[id];
  const tmp=path.resolve(os.tmpdir())+path.sep,target=path.resolve(root);
  if(target.startsWith(tmp)&&path.basename(target).startsWith('hub-cpu-test-'))fs.rmSync(target,{recursive:true,force:true});
});

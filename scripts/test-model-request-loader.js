'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-loader-test-')),saved=[];
function mock(name,exports){const id=require.resolve('../src/core/'+name);saved.push([id,require.cache[id]]);require.cache[id]={id,filename:id,loaded:true,exports};}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  mock('paths',{hubDataDir:()=>root});mock('lmstudio',{});
  mock('offload',{active:()=>[]});
  mock('aider-studio',{isBusy:()=>false});
  mock('resource-monitor',{snapshot:async()=>({sampledAt:Date.now(),cpu:{usagePercent:5},ram:{totalBytes:32*1024**3,usedBytes:4*1024**3,usagePercent:12.5},gpu:{available:false}})});
  mock('hardware-optimizer',{refresh:async()=>{},reserveLocalSlot:async()=>()=>{},status:()=>({at:Date.now(),onAcPower:true,heavyApps:[],failures:0}),policy:()=>({})});
  let starts=0;
  mock('local-runtime',{llamaStatus:async()=>({running:false}),configuredLocalLlama:async()=>({id:'configured-local',startup:true,loaded:false,sizeBytes:4*1024**3}),
    startConfiguredLocalLlama:async()=>{starts++;await sleep(10);return {state:'loaded'};}});
  const models=require('../src/core/model-control');
  const one=models.start({provider:'llamacpp',model:'configured-local'});
  assert.equal(models.start({provider:'llamacpp',model:'configured-local'}).requestId,one.requestId);
  for(let i=0;i<100&&models.result(one.requestId).state==='running';i++)await sleep(5);
  assert.equal(models.result(one.requestId).state,'completed');assert.equal(starts,1);
  const bad=models.start({provider:'llamacpp',model:'unregistered'});
  for(let i=0;i<100&&models.result(bad.requestId).state==='running';i++)await sleep(5);
  assert.equal(models.result(bad.requestId).state,'failed');assert.equal(starts,1);
  assert(!fs.existsSync(path.join(root,'model-operation.local.json')));
  console.log('Passed: existing configured llama.cpp request, duplicate operation dedupe, no unregistered download/start');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
  for(const[id,previous]of saved)previous?require.cache[id]=previous:delete require.cache[id];
  if(!path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(root).startsWith('hub-loader-test-'))throw new Error('Unsafe cleanup');
  fs.rmSync(root,{recursive:true,force:true});
});

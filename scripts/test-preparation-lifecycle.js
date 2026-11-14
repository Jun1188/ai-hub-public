'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-lifecycle-fixture-')),saved=[],originalTimeout=global.setTimeout;
function mock(name,exports){const id=require.resolve('../src/core/'+name);saved.push([id,require.cache[id]]);require.cache[id]={id,filename:id,loaded:true,exports};}
global.setTimeout=(fn,ms,...args)=>originalTimeout(fn,Math.min(ms,5),...args);
const sleep=ms=>new Promise(resolve=>originalTimeout(resolve,ms));
(async()=>{
 mock('paths',{hubDataDir:()=>root});mock('config',{load:()=>({localRuntimes:{llamaUrl:'http://127.0.0.1:8080'}})});
 mock('lmstudio',{baseUrl:()=> 'http://127.0.0.1:1234'});
 mock('credential-vault',{status:()=>[]});
 mock('hardware-optimizer',{refresh:async()=>{},status:()=>({at:Date.now(),onAcPower:true,heavyApps:[],failures:0}),policy:()=>({}),slotState:()=>({active:1})});
 let used=4,loaded=false,starts=0,unknown=false;
 mock('resource-monitor',{snapshot:async()=>({sampledAt:Date.now(),cpu:{usagePercent:5},ram:{totalBytes:32*1024**3,usedBytes:used*1024**3,usagePercent:used/32*100},gpu:{available:false}})});
 mock('local-runtime',{
  llamaStatus:async()=>({running:loaded,models:loaded?[{id:'fixture',state:'loaded',contextLength:4096}]:[]}),
  configuredLocalLlama:async()=>({id:'fixture',sizeBytes:4*1024**3,loaded:false,startup:true,modelPath:'fixture.gguf'}),
  startConfiguredLocalLlama:async options=>{starts++;assert.equal(options.modelId,'fixture');assert.equal(options.contextLength,4096);
   await sleep(20);options.signal?.throwIfAborted();if(unknown)throw new Error('fixture load outcome unknown');
   loaded=true;return {model:'fixture',state:'loaded'};},
 });
 const models=require('../src/core/model-control'),ids=[];
 const args={provider:'llamacpp',model:'fixture',onProgress:r=>ids.push(r.requestId)};
 const [a,b]=await Promise.all([models.ensure(args),models.ensure(args)]);
 assert.equal(a.requestId,b.requestId);assert.equal(new Set(ids).size,1);assert.equal(starts,1);assert.equal(models.result(a.requestId).state,'completed');assert(!models.busy());
 // Durable status can be read by a second module instance without repeating any load.
 const id=require.resolve('../src/core/model-control'),ownerModule=require.cache[id];delete require.cache[id];
 const observer=require('../src/core/model-control');assert.equal(observer.result(a.requestId).state,'completed');require.cache[id]=ownerModule;
 loaded=false;used=28;
 const aborted=new AbortController();let deferred=false;
 const waiting=models.ensure({...args,signal:aborted.signal,onProgress:r=>{if(r.state==='deferred'){deferred=true;aborted.abort(new Error('fixture cancelled'));}}});
 await assert.rejects(waiting,/fixture cancelled/);assert(deferred);assert.equal(starts,1);assert(!models.busy());
 // A failed submitted load remains uncertain, and no implicit replay is allowed.
 used=4;unknown=true;
 await assert.rejects(models.ensure(args),/outcome unknown/);assert.equal(starts,2);assert(models.busy());
 await assert.rejects(models.ensure(args),/outcome is unknown/);assert.equal(starts,2);
 loaded=true;await models.catalog('llamacpp');assert(!models.busy());
 assert(models.list().some(r=>r.state==='failed'&&r.reconcileBeforeRetry));
 console.log('Passed: automatic preparation, same ID join, single startup, durable status, resource defer cancellation, unknown outcome blocks replay, exact catalog reconciliation');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
 global.setTimeout=originalTimeout;for(const[id,value]of saved)value?require.cache[id]=value:delete require.cache[id];
 if(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('hub-lifecycle-fixture-'))fs.rmSync(root,{recursive:true,force:true});
});

'use strict';
// P4②: LM Studio 채팅 전 준비 확인(model-control.ready). 내려간 모델은 JIT가 아니라 입장 판정의 부분 오프로드 비율로 올리고,
// 동시 요청·다른 Hub 프로세스의 잠금이 겹쳐도 한 번만 올린다. Aider 프록시도 채팅 전에 같은 길로 간다. 네트워크·실제 모델 없음.
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-model-ready-')),saved=[];
function mock(name,exports){const id=require.resolve('../src/core/'+name);saved.push([id,require.cache[id]]);require.cache[id]={id,filename:id,loaded:true,exports};}
const GIB=1024**3;
let loaded=false,loads=[],chats=0;
(async()=>{
  mock('paths',{hubDataDir:()=>root});
  mock('config',{load:()=>({localRuntimes:{},lmstudio:{baseUrl:'http://127.0.0.1:1234',timeoutMs:60000}})});
  mock('lmstudio',{baseUrl:()=>'http://127.0.0.1:1234'});
  mock('hardware-optimizer',{refresh:async()=>{},status:()=>({at:Date.now(),onAcPower:true,heavyApps:[],failures:0}),policy:()=>({}),slotState:()=>({active:1})});
  // 8 GB 카드, gemma-4-12b 크기(7.56 GB): 통째로는 안 들어가 부분 오프로드가 나와야 한다.
  mock('resource-monitor',{snapshot:async()=>({sampledAt:Date.now(),cpu:{usagePercent:5},ram:{totalBytes:32*GIB,usedBytes:4*GIB,usagePercent:12.5},
    gpu:{available:true,devices:[{totalMiB:8192,usedMiB:600,usagePercent:2}]}})});
  mock('credential-broker',{jobId:p=>p+':fixture',
    request:async input=>{
      if(input.operationId!=='lmstudio.catalog')throw new Error('unexpected '+input.operationId);
      return {models:[{type:'llm',key:'fixture',size_bytes:7.56e9,max_context_length:8192,loaded_instances:loaded?[{id:'fixture',config:{context_length:4096}}]:[]}]};
    },
    requestResponse:async input=>{chats++;assert.equal(input.operationId,input.payload.body?'lmstudio.chat':'lmstudio.models');
      return new Response(JSON.stringify({ok:true,loadedWhenSent:loaded}),{headers:{'Content-Type':'application/json'}});}});
  mock('local-server-control',{load:async(model,contextLength,placement,_signal,gpuRatio)=>{loads.push({model,contextLength,placement,gpuRatio});
    await new Promise(r=>setTimeout(r,30));loaded=true;},start:async()=>{},identity:async()=>null});
  const control=require('../src/core/model-control'),lock=require('../src/core/model-change-lock');
  const lockFile=path.join(root,'model-change-lock.local.json');

  // 1) 이미 올라와 있으면 다시 묻지도 올리지도 않는다.
  loaded=true;
  assert.deepEqual(await control.ready({model:'fixture'}),{model:'fixture',state:'loaded'});
  assert.equal(loads.length,0);

  // 2) 내려가 있으면 JIT가 아니라 입장 판정의 비율로 올린다.
  loaded=false;
  const prepared=await control.ready({model:'fixture'});
  assert.equal(prepared.state,'loaded');assert.equal(loads.length,1);
  assert.equal(loads[0].placement,'gpu');assert(loads[0].gpuRatio>0&&loads[0].gpuRatio<1,JSON.stringify(loads[0]));assert.equal(loads[0].contextLength,4096);

  // 3) 같은 프로세스에서 동시에 와도 한 번만 올린다.
  loaded=false;loads=[];
  const both=await Promise.all([control.ready({model:'fixture'}),control.ready({model:'fixture'}),control.ready({model:'fixture'})]);
  assert(both.every(r=>r.state==='loaded'));assert.equal(loads.length,1);

  // 4) 다른 Hub 프로세스가 잠금을 쥐고 올리는 중이면 기다렸다 목록을 다시 본다 — 두 번째 적재가 없다.
  loaded=false;loads=[];
  fs.writeFileSync(lockFile,JSON.stringify({id:'other-process',pid:process.pid,at:Date.now()}));
  assert(lock.heldByLiveProcess());
  const started=Date.now();
  setTimeout(()=>{loaded=true;fs.unlinkSync(lockFile);},1200);
  assert.deepEqual(await control.ready({model:'fixture'}),{model:'fixture',state:'loaded'});
  assert(Date.now()-started>=1000,'waited for the other preparation');assert.equal(loads.length,0);

  // 5) 죽은 프로세스가 남긴 잠금은 기다리지 않는다 — ensure가 그 잠금을 알리고 JIT로 넘기지 않는다.
  loaded=false;
  const dead=spawnSync(process.execPath,['-e','0']).pid;
  fs.writeFileSync(lockFile,JSON.stringify({id:'crashed',pid:dead,at:Date.now()}));
  assert(!lock.heldByLiveProcess());
  const quick=Date.now();
  await assert.rejects(control.ready({model:'fixture'}),/Another Hub process owns model preparation/);
  assert(Date.now()-quick<1000);assert.equal(loads.length,0);
  fs.unlinkSync(lockFile);

  // 6) 취소는 기다리는 중에도 바로 듣는다.
  fs.writeFileSync(lockFile,JSON.stringify({id:'other-process',pid:process.pid,at:Date.now()}));
  const cancel=new AbortController();setTimeout(()=>cancel.abort(new Error('fixture cancelled')),50);
  await assert.rejects(control.ready({model:'fixture',signal:cancel.signal}),/fixture cancelled|aborted/);
  fs.unlinkSync(lockFile);

  // 7) Aider 프록시: 채팅 전에 내려간 모델을 같은 길로 올리고, 모델 목록 조회는 적재를 일으키지 않는다.
  loaded=false;loads=[];chats=0;
  const proxy=await require('../src/core/local-credential-proxy').open({provider:'lmstudio',model:'fixture'});
  try{
    const list=await fetch(proxy.apiBase+'/models');assert.equal(list.status,200);assert.equal(loads.length,0);
    const reply=await fetch(proxy.apiBase+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'fixture',messages:[]})});
    assert.equal(reply.status,200);assert.equal((await reply.json()).loadedWhenSent,true);assert.equal(loads.length,1);assert.equal(chats,2);
  }finally{proxy.close();}
  console.log('Model ready: loaded model untouched, unloaded model prepared at admission ratio (no JIT), concurrent callers and another live preparation load once, stale lock fails fast, Aider proxy prepares before chat');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
  for(const[id,value]of saved)value?require.cache[id]=value:delete require.cache[id];
  try{require('../src/core/model-lifecycle').instance().dispose();}catch{}
  fs.rmSync(root,{recursive:true,force:true});
});

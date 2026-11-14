'use strict';
// 로컬 모델 준비 수용·작업자 자원 진단·소유 모델 유휴 정리 회귀 테스트(모델·프로세스를 띄우지 않는다).
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-admission-fixture-'));
const {assess}=require('../src/core/model-admission'),{createDiagnostics,assessWorker}=require('../src/core/hardware-diagnostics');
const {createLifecycle,IDLE_MS}=require('../src/core/model-lifecycle');
const GIB=1024**3;const at=Date.now();
const snapshot=(used=4)=>({sampledAt:at,cpu:{usagePercent:5,logicalCores:8},ram:{totalBytes:32*GIB,usedBytes:used*GIB},
  gpu:{available:true,devices:[{name:'fixture-gpu',totalMiB:8192,usedMiB:256,usagePercent:5}]}});
const environment=()=>({at,onAcPower:true,heavyApps:[],failures:0,retryAt:0,slot:{active:0}});
(async()=>{
  const large=assess({snapshot:snapshot(),environment:environment(),target:{id:'loaded',loaded:true},contextLength:32768,now:at});
  assert.equal(large.expected.kvBytes,4*GIB);assert.equal(large.expected.basis,'loaded-model-plus-requested-kv');
  assert.equal(assess({snapshot:snapshot(),environment:environment(),target:{id:'loaded',loaded:true},contextLength:-1,now:at}).reason,'invalid_model_context');
  // 8 GB 중 3.3 GB를 쓰고 있을 때 5.4 GB 모델: 전체는 안 들어가지만 60% 이상 들어가면 부분 오프로드로 GPU.
  // 배경화면이 nvidia 사용률을 40%로 올려도 busyPercent(3%)로 보므로 gpu_busy가 아니다. 60%도 안 들어가면 CPU.
  const busyGpu={...snapshot(),gpu:{available:true,devices:[{name:'fixture-gpu',totalMiB:8192,usedMiB:3400,usagePercent:40,busyPercent:3}]}};
  const gguf={id:'cached',sizeBytes:5.4*GIB,startup:true,loaded:false};
  const fit=assess({snapshot:busyGpu,environment:environment(),target:gguf,contextLength:6144,now:at});
  assert.equal(fit.admitted,true,JSON.stringify(fit));assert.equal(fit.expected.placement,'gpu');assert.equal(fit.expected.basis,'partial-gpu-offload');
  assert(fit.expected.vramBytes<=(8192-3400)*1024**2);assert(fit.expected.gpuRatio>0.5&&fit.expected.gpuRatio<1,String(fit.expected.gpuRatio));
  const lm=assess({snapshot:busyGpu,environment:environment(),target:{...gguf,startup:false},contextLength:6144,now:at});
  assert.equal(lm.expected.placement,'gpu');assert.equal(lm.expected.gpuRatio,fit.expected.gpuRatio);
  assert.equal(assess({snapshot:busyGpu,environment:environment(),target:{...gguf,sizeBytes:9*GIB},contextLength:6144,now:at}).expected.placement,'cpu');
  assert.equal(assess({snapshot:snapshot(),environment:environment(),target:gguf,contextLength:4096,now:at}).expected.gpuRatio,undefined);// 다 들어가면 비율 없음
  // 부분 오프로드로 VRAM을 거의 다 쓴 채 올라간 모델: 적재 때 잡힌 KV가 요청을 덮으면 둘째 청크도 추가 VRAM 없이 승인
  const full={...snapshot(),gpu:{available:true,devices:[{name:'fixture-gpu',totalMiB:8192,usedMiB:7028,usagePercent:38,busyPercent:3}]}};
  const loadedTarget={id:'google/gemma-4-12b',loaded:true,kvAllocation:'full',allocatedContextTokens:6144};
  const again=assess({snapshot:full,environment:environment(),target:loadedTarget,contextLength:6144,now:at});
  assert.equal(again.admitted,true,JSON.stringify(again));assert.equal(again.expected.vramBytes,0);
  assert.equal(assess({snapshot:full,environment:environment(),target:{...loadedTarget,allocatedContextTokens:undefined},contextLength:6144,now:at}).reason,'projected_vram_exceeds_budget');
  assert.equal(assessWorker({snapshot:snapshot(29),environment:environment(),agent:'codex',now:at}).admitted,false);
  assert.equal(assessWorker({snapshot:snapshot(),environment:environment(),agent:'remote-static',resourceProfile:{ramBytes:GIB,cpuCores:2},now:at}).scenario,'local-static-analysis');
  assert.equal(assessWorker({snapshot:{...snapshot(),sampledAt:at-11000},environment:environment(),agent:'local',now:at}).admitted,false);
  const current=snapshot();
  const hw={refresh:async()=>{},status:environment,policy:()=>({})};
  const diagnostic=createDiagnostics({monitor:{snapshot:async()=>current,peek:()=>current},hardware:hw,directory:path.join(root,'diagnostics'),now:()=>at,manual:true});
  const staticNode={agent:'remote-static',id:'static',resourceProfile:{ramBytes:GIB,cpuCores:2}};
  const record=await diagnostic.capture(staticNode,{id:'remote'});diagnostic.finish(record,'completed');assert.equal(record.observed.samples,2);
  let idleAt=0,cleaned=0,busy=false;
  const lifecycle=createLifecycle({manual:true,now:()=>idleAt,busy:()=>busy,cleanup:async()=>{cleaned++;}});
  lifecycle.register({provider:'llamacpp',model:'owned',serverOwned:true,instanceId:'fixture'});
  idleAt=IDLE_MS-1;await lifecycle.tick();assert.equal(cleaned,0);idleAt++;busy=true;await lifecycle.tick();assert.equal(cleaned,0);
  busy=false;await lifecycle.tick();assert.equal(cleaned,1);assert.equal(lifecycle.status().length,0);
  const retained=createLifecycle({manual:true,now:()=>idleAt,busy:()=>false,cleanup:async()=>({retain:true,reason:'runtime_idle_ttl_active'})});
  retained.register({provider:'lmstudio',model:'ttl',runtimeTtl:true});idleAt+=IDLE_MS;await retained.tick();assert.equal(retained.status()[0].state,'owned');
  console.log('Passed: projected KV, invalid context, worker RAM/stale diagnostics, idle ownership and runtime TTL');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
  if(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('hub-admission-fixture-'))fs.rmSync(root,{recursive:true,force:true});
});

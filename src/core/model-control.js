'use strict';
const crypto=require('crypto'),fs=require('fs'),path=require('path');
const runtime=require('./local-runtime'),lm=require('./lmstudio'),monitor=require('./resource-monitor'),lock=require('./model-change-lock');
const records=new Map(),completions=new Map();let active=null;
const statusFile=()=>path.join(require('./paths').hubDataDir(),'model-operation-status.local.json');
function persist(r){const file=statusFile();fs.writeFileSync(file+'.'+process.pid+'.tmp',JSON.stringify(r),'utf8');fs.renameSync(file+'.'+process.pid+'.tmp',file);}
const markerFile=()=>path.join(require('./paths').hubDataDir(),'model-operation.local.json');
const uncertain=()=>fs.existsSync(markerFile());
function marker(value){const file=markerFile();fs.writeFileSync(file+'.tmp',JSON.stringify(value),'utf8');fs.renameSync(file+'.tmp',file);}
function clearMarker(){try{fs.unlinkSync(markerFile());}catch(e){if(e.code!=='ENOENT')throw e;}}
function localUrl(base){
  const u=new URL(base);
  if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('Model management requires a loopback origin');
  return u.origin;
}
async function lmRequest(endpoint,body){
  localUrl(lm.baseUrl());
  const action=endpoint.endsWith('/load')?'load':endpoint.endsWith('/unload')?'unload':'catalog',broker=require('./credential-broker');
  return broker.request({credentialRef:'credential:lmstudio',operationId:'lmstudio.'+action,jobId:broker.jobId('management'),payload:{body}},
    {timeoutMs:body?120000:10000});
}
// 표식은 결과를 모를 때만 재시도를 막는다. 진행 중인 작업이 없을 때 결과가 정해졌다고 보는 경우:
//  - 정확한 모델이 올라가 보인다(두 공급자).
//  - llama.cpp 목록이 읽히고 그 모델이 올리는 중(loading)이 아니다. router는 진행 중인 적재를 상태로 보이고, 단일 모델 서버는 적재 중
//    목록 대신 503을 준다(못 읽음). 서버가 확실히 꺼졌고(연결 거절) 이 Hub가 띄운 프로세스도 없을 때(stopped)도 같다.
// LM Studio는 lms CLI 적재가 목록에 진행 상태를 남기지 않아 올라간 것이 보일 때만 지운다(전송 결과 모름). 전에는 llama.cpp도 그랬고,
// 10-25에 RAM 압박으로 실패한 configured-local 적재의 표식이 남아 자동 offload가 전부 model_not_admitted로 거절됐다(2026-10-28).
function reconcile(provider,models,stopped=false){
  if(!active&&!lock.busy()&&uncertain()){
    const state=JSON.parse(fs.readFileSync(markerFile(),'utf8'));
    // configured-local은 기동 때 붙이는 별칭이다. 기동 확인(startConfiguredLocalLlama)과 같이 llama.cpp에 올라간 모델이면 그것으로 본다.
    const mine=models.filter(m=>m.id===state.model||(provider==='llamacpp'&&state.model==='configured-local'));
    const known=mine.some(m=>m.loaded)||(provider==='llamacpp'&&(stopped||!mine.some(m=>m.state==='loading')));
    if(state.provider===provider&&known)clearMarker();
  }
  return models;
}
function transportUnavailable(error){return error?.code==='BROKER_OUTCOME_UNKNOWN' && ['ECONNREFUSED','ENOENT'].includes(error.transportCode);}
async function catalog(provider){
  if(provider==='lmstudio'){
    let data;try{data=await lmRequest('/api/v1/models');}
    catch(error){if(!transportUnavailable(error))throw error;return require('./local-server-control').catalog();}
    // LM Studio는 적재할 때 그 컨텍스트 길이만큼 KV를 다 잡는다. 이 값을 넘기지 않으면 승인이 같은 KV를 다시 요구해,
    // 부분 오프로드로 VRAM을 거의 다 쓴 모델의 둘째 청크가 projected_vram_exceeds_budget로 180초 기다리다 거절됐다(2026-10-18).
    return reconcile(provider,(data.models||[]).filter(m=>m.type==='llm').map(m=>{
      const instances=m.loaded_instances||[],ctx=Math.max(0,...instances.map(i=>Number(i.config?.context_length)||0));
      return {id:m.key,sizeBytes:m.size_bytes,loaded:instances.length>0,instances,maxContext:m.max_context_length,
        ...(ctx?{kvAllocation:'full',allocatedContextTokens:ctx}:{})};
    }));
  }
  if(provider!=='llamacpp')throw new Error('Unknown model provider');
  const live=await runtime.llamaStatus();
  if(live.running)return reconcile(provider,live.models.map(m=>({...m,loaded:m.state==='loaded',router:live.router})));
  // 연결이 거절됐고 이 Hub가 띄운 프로세스도 없으면 올라간 모델도, 올리는 중인 모델도 없다. 시간 초과·503(적재 중)은 stopped가 아니다.
  if(live.stopped&&!runtime.llamaControlStatus?.()?.managed)reconcile(provider,[],true);
  const configured=await runtime.configuredLocalLlama();
  // 서버가 꺼져 있으면 HF 캐시의 GGUF도 띄울 수 있는 후보다(local-model-select가 예산·품질로 고른다).
  const cached=runtime.llamaExecutable?.()?await require('./local-gguf-catalog').cached({exclude:[configured?.modelPath]}):[];
  return [...(configured?[configured]:[]),...cached];
}
function result(id){let r=records.get(String(id));if(!r){try{const stored=JSON.parse(fs.readFileSync(statusFile(),'utf8'));if(stored.requestId===String(id))r=stored;}catch{}}if(!r)throw new Error('Unknown model operation; refresh catalog after restart');return JSON.parse(JSON.stringify(r));}
function busy(){return Boolean(active)||lock.busy()||uncertain();}
function list(){const rows=[...records.values()].map(r=>result(r.requestId));try{const stored=JSON.parse(fs.readFileSync(statusFile(),'utf8'));if(!rows.some(r=>r.requestId===stored.requestId))rows.push(stored);}catch{}return rows.slice(-10);}
const pause=(ms,signal)=>new Promise((resolve,reject)=>{
  signal?.throwIfAborted();const finish=()=>{signal?.removeEventListener('abort',abort);resolve();};
  const t=setTimeout(finish,ms),abort=()=>{clearTimeout(t);signal?.removeEventListener('abort',abort);reject(signal.reason||new Error('Cancelled'));};
  signal?.addEventListener('abort',abort,{once:true});
});
async function observed(provider,model){
  return (await catalog(provider)).find(m=>m.id===model);
}
async function admission(target,contextLength,placement){
  const hw=require('./hardware-optimizer');
  await hw.refresh();
  let snapshot=await monitor.snapshot({force:true});
  if(snapshot.cpu.usagePercent==null){await pause(150);snapshot=await monitor.snapshot({force:true});}
  return require('./model-admission').assess({snapshot,environment:hw.status(),policy:hw.policy(),target,contextLength,placement});
}
function begin({provider,model,on=true,contextLength=4096,placement='auto'},automatic,signal){
  if(automatic && !require('./device-profile').automaticPreparation())throw new Error('Automatic local inference is disabled for this device');
  if(automatic && provider==='llamacpp')localUrl(require('./local-endpoints').llamaUrl());
  if(!['lmstudio','llamacpp'].includes(provider)||typeof model!=='string'||!model||model.length>512)throw new Error('Provider and exact local model ID required');
  if(!Number.isInteger(contextLength)||contextLength<512||contextLength>32768||!['auto','cpu'].includes(placement))throw new Error('Invalid preparation context or placement');
  if(active){
    const r=records.get(active);
    if(r.automatic===automatic&&r.provider===provider&&r.model===model&&r.on===on&&r.contextLength===contextLength&&r.placement===placement)return result(active);
    throw new Error('Another model operation is active; wait for its existing ID');
  }
  if(uncertain())throw new Error('Previous model operation outcome is unknown; reconcile the catalog before resubmitting');
  if(!automatic&&require('./change-signals').busy('offload','aider').length)
    throw new Error('Wait for active offload or Aider jobs before manually changing models');
  const requestId=crypto.randomUUID();
  lock.acquire(requestId);
  const record={requestId,provider,model,on,contextLength,placement,automatic,state:'running',phase:'inspecting',startedAt:Date.now(),pollAfterMs:5000};
  records.set(requestId,record);active=requestId;
  try{persist(record);}catch(e){active=null;records.delete(requestId);lock.release(requestId);throw e;}
  if(records.size>100){const old=records.keys().next().value;records.delete(old);completions.delete(old);}
  const prepareDeadline=Date.now()+180*1000;
  let reservation;
  const completion=(async()=>{
    if(!automatic)reservation=await require('./hardware-optimizer').reserveLocalSlot({signal});
    signal?.throwIfAborted();
    let target=await observed(provider,model);
    if(!target)throw new Error('Exact model missing from local catalog; no download or replacement');
    if(!on){
      if(provider!=='llamacpp'||!target.router)throw new Error('Unload the exact model in its runtime after checking active predictions');
      marker({requestId,provider,model,startedAt:record.startedAt});return runtime.setLlamaModel(model,false);
    }
    contextLength=Math.min(contextLength,target.maxContext||contextLength);
    do{
      signal?.throwIfAborted();
      const gate=await admission(target,contextLength,placement);
      record.admission=gate;record.phase=gate.admitted?'preparing':'waiting-for-resources';record.state=gate.admitted?'running':'deferred';persist(record);
      if(gate.admitted){if(Date.now()>=prepareDeadline)throw new Error('Preparation time budget exhausted');break;}
      if(!automatic || Date.now()>=prepareDeadline)throw new Error('Model preparation deferred: '+gate.reason);
      await pause(10000,signal);
      target=await observed(provider,model);
      if(!target)throw new Error('Local model catalog changed while waiting');
    }while(true);
    signal?.throwIfAborted();
    if(target.loaded)return {model:target.id,state:'loaded'};
    signal?.throwIfAborted();
    marker({requestId,provider,model,startedAt:record.startedAt});
    const selected=record.admission.expected.placement;
    if(provider==='llamacpp'){
      if(target.startup)return runtime.startConfiguredLocalLlama({modelPath:target.modelPath,mmprojPath:target.mmprojPath,modelId:model,
        contextLength,placement:selected,deadline:prepareDeadline,requestId,signal}).then(value=>{
          const owned=runtime.llamaControlStatus?.();
          if(owned?.managed)require('./model-lifecycle').instance().register({provider,model:value.model,serverOwned:true,instanceId:String(owned.instanceId||'')});
          return value;
        });
      if(!target.router)throw new Error('Model is not registered in the existing llama.cpp router');
      await runtime.setLlamaModel(model,true);
    }else{
      // Start the existing local server only after the model footprint has passed admission.
      try{await lmRequest('/api/v1/models');}catch(error){if(!transportUnavailable(error))throw error;await require('./local-server-control').start(signal);record.serverStarted=true;record.serverIdentity=await require('./local-server-control').identity().catch(()=>null);}
      await require('./local-server-control').load(model,contextLength,selected,signal,record.admission.expected.gpuRatio);
    }
    const loaded=await observed(provider,model);
    if(!loaded?.loaded)throw new Error('Load returned without exact catalog confirmation; outcome unknown');
    const instance=loaded.instances?.[0];
    require('./model-lifecycle').instance().register({provider,model:loaded.id,serverOwned:record.serverStarted===true,
      instanceId:String(instance?.id||instance?.identifier||instance?.instance_id||''),serverIdentity:record.serverIdentity||null,runtimeTtl:provider==='lmstudio'});
    return {model:loaded.id,state:'loaded',placement:selected};
  })().then(value=>{clearMarker();record.state='completed';record.phase='ready';record.result=value;})
    .catch(e=>{record.state='failed';record.error=e.message;record.reconcileBeforeRetry=uncertain();})
    .finally(()=>{record.finishedAt=Date.now();try{persist(record);}finally{active=null;try{lock.release(requestId);}finally{reservation?.();}}}).catch(()=>{});
  completions.set(requestId,completion);
  return result(requestId);
}
function waitOperation(id,ms,signal) {
  return new Promise(resolve=>{
    const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};
    const timer=setTimeout(done,ms);signal?.addEventListener('abort',done,{once:true});
    completions.get(id)?.then(done,done);
    if(signal?.aborted)done();
  });
}
function start(input){return begin(input,false);}
// 자동 준비는 제출 전에 표식을 남긴 공급자(요청한 공급자와 다를 수 있다)의 목록을 한 번 읽어 맞춘다. 못 읽으면 begin이 그대로 막는다.
async function reconcileMarked(){
  let provider;try{provider=JSON.parse(fs.readFileSync(markerFile(),'utf8')).provider;}catch{return;}
  if(['lmstudio','llamacpp'].includes(provider))await catalog(provider).catch(()=>{});
}
async function ensure({provider,model,contextLength,placement='auto',signal,onProgress}){
  signal?.throwIfAborted();
  if(require('./hardware-optimizer').slotState().active<1)throw new Error('Automatic model preparation requires the local inference slot');
  if(provider==='hf-cache'){
    const candidates=(await catalog('llamacpp')).filter(m=>m.id===model||m.id.split(':')[0]===model);
    if(candidates.length!==1)throw new Error('Choose one exact cached model and quantization; no automatic download');
    model=candidates[0].id;provider='llamacpp';
  }
  if(!active&&uncertain())await reconcileMarked();
  const submitted=begin({provider,model,contextLength:contextLength||4096,placement},true,signal);
  for(;;){
    if(signal?.aborted){
      while(records.get(submitted.requestId)?.state==='running'||records.get(submitted.requestId)?.state==='deferred')await pause(100);
      signal.throwIfAborted();
    }
    const r=result(submitted.requestId);onProgress?.(r);
    if(r.state==='completed')return {...r.result,requestId:r.requestId,admission:r.admission};
    if(r.state==='failed'){const e=new Error(r.error);e.operationId=r.requestId;throw e;}
    await waitOperation(submitted.requestId,r.pollAfterMs,signal);
  }
}
// LM Studio로 채팅을 보내기 직전에 부른다. 내려가 있으면 JIT(LM Studio 모델 기본값 = GPU 최대)에 맡기지 않고 입장 판정의 비율·컨텍스트로
// ensure한다 — 8 GB 카드에서 거버너가 내린 gemma-4-12b가 JIT로 다시 올라와 같은 넘침이 됐다(2026-10-22, 8번 중 7번).
// 다른 준비가 잠금을 쥐고 있으면 끝나기를 기다렸다 목록을 다시 본다(두 번 올리지 않는다). 올라와 있으면 승인을 다시 묻지 않는다.
async function ready({provider='lmstudio',model,contextLength,signal}){
  const deadline=Date.now()+180*1000;
  for(;;){
    signal?.throwIfAborted();
    if((await catalog(provider)).some(m=>m.id===model&&m.loaded))return {model,state:'loaded'};
    if(Date.now()<deadline&&lock.heldByLiveProcess()){await require('timers/promises').setTimeout(1000,undefined,{signal});continue;}
    return ensure({provider,model,contextLength,signal});
  }
}
async function cleanupOwned(item){
  if(busy()||require('./local-inference-lease').busy())throw new Error('Model cleanup cannot overlap inference or preparation');
  const id='idle-'+crypto.randomUUID();lock.acquire(id);
  try{
    const target=await observed(item.provider,item.model);
    if(!target?.loaded){
      if(item.provider==='lmstudio'&&item.serverOwned){
        // Stop only the listener started here, once its native TTL removed all models.
        if((await catalog('lmstudio')).some(m=>m.loaded))return {retain:true,reason:'other_loaded_models'};
        const current=await require('./local-server-control').identity();
        if(!item.serverIdentity || JSON.stringify(current)!==JSON.stringify(item.serverIdentity))throw new Error('Listener process, startup time or origin changed; no automatic stop');
        await require('./local-server-control').stop();
      }
      return {stopped:true};
    }
    if(item.provider==='lmstudio'){
      if(item.runtimeTtl)return {retain:true,reason:'runtime_idle_ttl_active'};
      throw new Error('LM Studio model ownership or idle state cannot be confirmed');
    }
    const own=runtime.llamaControlStatus?.();
    if(item.serverOwned){
      if(!own?.managed||!item.instanceId||String(own.instanceId||'')!==item.instanceId)throw new Error('Hub-owned llama process changed; no automatic stop');
      await runtime.stopLlama();return {stopped:true};
    }
    // Router APIs do not expose a stable process/instance ownership token.
    throw new Error('Router model ownership cannot be confirmed; no automatic unload');
  }finally{lock.release(id);}
}
module.exports={catalog,start,result,busy,list,ensure,ready,cleanupOwned,transportUnavailable};

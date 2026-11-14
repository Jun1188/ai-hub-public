'use strict';
// 모델 준비 결과 표식(model-operation.local.json)은 결과를 모를 때만 재시도를 막는다.
// 회귀: 10-25 llama.cpp configured-local 적재가 RAM 압박으로 실패했는데, 표식은 "카탈로그에 그 id가 올라가 보일 때"만 지워져
// (서버가 꺼졌고 configured-local은 별칭이라 영영 보이지 않음) 자동 offload가 사흘 동안 model_not_admitted로 거절됐다(2026-10-28).
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-marker-fixture-')),saved=[],originalTimeout=global.setTimeout;
function mock(name,exports){const id=require.resolve('../src/core/'+name);saved.push([id,require.cache[id]]);require.cache[id]={id,filename:id,loaded:true,exports};}
global.setTimeout=(fn,ms,...args)=>originalTimeout(fn,Math.min(ms,5),...args);
const marker=path.join(root,'model-operation.local.json');
(async()=>{
 mock('paths',{hubDataDir:()=>root});mock('config',{load:()=>({localRuntimes:{llamaUrl:'http://127.0.0.1:8080'}})});
 mock('lmstudio',{baseUrl:()=> 'http://127.0.0.1:1234'});
 mock('credential-vault',{status:()=>[]});
 mock('hardware-optimizer',{refresh:async()=>{},status:()=>({at:Date.now(),onAcPower:true,heavyApps:[],failures:0}),policy:()=>({}),slotState:()=>({active:1})});
 mock('resource-monitor',{snapshot:async()=>({sampledAt:Date.now(),cpu:{usagePercent:5},ram:{totalBytes:32*1024**3,usedBytes:4*1024**3,usagePercent:12.5},gpu:{available:false}})});
 // server: refused(확실히 꺼짐) | timeout(못 읽음) | up(목록 읽음). failure: 기동이 던질 오류(없으면 성공).
 let server='refused',models=[],managed=false,failure=null,starts=0;
 mock('local-runtime',{
  llamaStatus:async()=>server==='up'?{running:true,router:true,models}:{running:false,stopped:server==='refused',models:[]},
  llamaControlStatus:()=>({managed}),
  configuredLocalLlama:async()=>({id:'configured-local',label:'fixture.gguf',sizeBytes:4*1024**3,loaded:false,startup:true,modelPath:'fixture.gguf'}),
  startConfiguredLocalLlama:async options=>{starts++;assert.equal(options.modelId,'configured-local');if(failure)throw new Error(failure);return {model:'configured-local',state:'loaded'};},
 });
 const control=require('../src/core/model-control');
 const args={provider:'llamacpp',model:'configured-local'};
 const failLoad=async message=>{failure=message;await assert.rejects(control.ensure(args),new RegExp(message.split(';')[0]));failure=null;assert(fs.existsSync(marker),'a submitted load leaves the marker');};

 // 1) 확정 실패(RAM 압박, 기동한 서버는 멈춤): 목록을 못 읽는 동안은 막고, 서버가 확실히 꺼졌으면 표식을 지운다.
 await failLoad('Observed RAM pressure exceeded startup budget');
 assert(control.list().some(r=>r.state==='failed'&&r.reconcileBeforeRetry));
 server='timeout';await control.catalog('llamacpp');assert(fs.existsSync(marker),'unreadable catalog keeps the guard');
 await assert.rejects(control.ensure(args),/outcome is unknown/);assert.equal(starts,1,'no replay while unknown');
 managed=true;server='refused';await control.catalog('llamacpp');assert(fs.existsSync(marker),'a live Hub-owned llama process may still be loading');
 managed=false;await control.catalog('llamacpp');assert(!fs.existsSync(marker),'refused + no owned process = known not loaded');

 // 2) 자동 준비 경로(offload의 ensure)가 스스로 맞춘다: 표식이 남은 채 다시 요청하면 목록을 읽고 바로 진행한다.
 await failLoad('Observed RAM pressure exceeded startup budget');
 const ready=await control.ensure(args);
 assert.equal(ready.state,'loaded');assert.equal(starts,3);assert(!fs.existsSync(marker));

 // 3) 별칭: 서버가 떠 있고 목록이 읽히면 configured-local은 그 서버의 모델로 판단한다(id가 별칭과 달라도).
 await failLoad('Observed RAM pressure exceeded startup budget');
 server='up';models=[{id:'qwen2.5-coder-7b-instruct-q5_k_m.gguf',state:'loading'}];
 await control.catalog('llamacpp');assert(fs.existsSync(marker),'a model still loading keeps the guard');
 models=[{id:'qwen2.5-coder-7b-instruct-q5_k_m.gguf',state:'unloaded'}];
 await control.catalog('llamacpp');assert(!fs.existsSync(marker),'readable catalog, nothing loading = known not loaded');
 server='refused';await failLoad('Observed VRAM pressure exceeded startup budget');
 server='up';models=[{id:'qwen2.5-coder-7b-instruct-q5_k_m.gguf',state:'loaded'}];
 await control.catalog('llamacpp');assert(!fs.existsSync(marker),'alias resolves to the loaded llama.cpp model');

 // 4) 전송 결과를 모르는 실패(기동 시간 초과): 못 읽거나, 올리는 중이거나, 이 Hub가 띄운 프로세스가 살아 있는 동안은 막는다.
 server='refused';
 await failLoad('Load outcome unknown; inspect this operation before retry');
 server='timeout';await control.catalog('llamacpp');assert(fs.existsSync(marker),'503/timeout while the server loads keeps the guard');
 server='up';models=[{id:'configured-local',state:'loading'}];
 await control.catalog('llamacpp');assert(fs.existsSync(marker),'router still loading keeps the guard');
 await assert.rejects(control.ensure(args),/outcome is unknown/);
 server='refused';managed=true;await control.catalog('llamacpp');assert(fs.existsSync(marker));
 const before=starts;managed=false;
 const again=await control.ensure(args);assert.equal(again.state,'loaded');assert.equal(starts,before+1);assert(!fs.existsSync(marker));
 console.log('Passed: failed llama.cpp load no longer blocks forever, unreadable/owned/loading/unknown outcomes stay guarded, configured-local alias, ensure reconciles the marked provider');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
 global.setTimeout=originalTimeout;for(const[id,value]of saved)value?require.cache[id]=value:delete require.cache[id];
 if(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('hub-marker-fixture-'))fs.rmSync(root,{recursive:true,force:true});
});

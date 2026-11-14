'use strict';
const {execFile}=require('child_process');
function run(args,timeout=15000,signal){
  const bin=require('./lmstudio-cpu-load').executable();
  if(!bin)throw new Error('Existing LM Studio CLI is required; installation is deferred');
  return new Promise((resolve,reject)=>execFile(bin,args,{windowsHide:true,timeout,signal,maxBuffer:1024*1024,encoding:'buffer'},
    (error,stdout)=>error?reject(new Error('Local runtime command outcome unknown; inspect the existing server before retry')):resolve(require('./console-text').decode(stdout))));
}
async function catalog(){
  const rows=JSON.parse(await run(['ls','--json']));
  if(!Array.isArray(rows))throw new Error('Invalid LM Studio local catalog');
  return rows.filter(m=>m.type==='llm').map(m=>({id:m.modelKey,sizeBytes:m.sizeBytes,maxContext:m.maxContextLength,loaded:false}));
}
async function start(signal){
  const url=new URL(require('./lmstudio').baseUrl());
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.protocol!=='http:'||url.username||url.password)
    throw new Error('Automatic server startup requires a registered loopback origin');
  await run(['server','start','--port',url.port||'1234','--bind','127.0.0.1'],30000,signal);
}
async function load(model,contextLength,placement,signal,gpuRatio){
  // 부분 오프로드는 승인이 정한 비율만 올린다(model-admission). 비율이 없으면 전체 아니면 CPU.
  const gpu=placement!=='gpu'?'off':gpuRatio>0&&gpuRatio<1?String(gpuRatio):'max';
  await run(['load',model,'--identifier',model,'--gpu',gpu,
    '--context-length',String(contextLength),'--parallel','1','--ttl','600','-y'],120000,signal);
}
async function unload(model,signal){
  if(typeof model!=='string'||!model)throw new Error('Exact owned model identifier required');
  await run(['unload',model],30000,signal);
}
async function stop(signal){await run(['server','stop'],30000,signal);}
async function identity(){
  const origin=new URL(require('./lmstudio').baseUrl()),port=Number(origin.port||(origin.protocol==='https:'?443:80));
  if(!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)||!Number.isInteger(port)||port<1||port>65535)throw new Error('Local listener identity requires a loopback port');
  if(process.platform!=='win32')throw new Error('Listener process identity unavailable on this platform');
  const script='$owners=@(Get-NetTCPConnection -State Listen -LocalPort '+port+' -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique); if($owners.Count -ne 1){throw "Ambiguous listener"}; $ownerProcess=Get-Process -Id $owners[0] -ErrorAction Stop; @{pid=$ownerProcess.Id;startedAt=$ownerProcess.StartTime.ToUniversalTime().ToString("o")} | ConvertTo-Json -Compress';
  const value=await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
    {windowsHide:true,timeout:8000,maxBuffer:65536,encoding:'buffer'},(error,stdout)=>{
      if(error)return reject(new Error('Local listener ownership unavailable; no automatic server stop'));
      try{resolve(JSON.parse(require('./console-text').decode(stdout)));}catch{reject(new Error('Invalid listener ownership sample'));}
    }));
  if(!Number.isInteger(value.pid)||value.pid<1||typeof value.startedAt!=='string'||!Number.isFinite(Date.parse(value.startedAt)))throw new Error('Incomplete listener process identity');
  return {origin:origin.origin,port,pid:value.pid,startedAt:value.startedAt};
}
module.exports={catalog,start,load,unload,stop,identity};

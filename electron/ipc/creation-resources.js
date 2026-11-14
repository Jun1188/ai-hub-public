'use strict';
const crypto=require('node:crypto');
function register(ctx){
 const jobs=new Map();let requesting=false;
 ctx.handle('studio:resourceRun',async input=>{
  if(requesting||[...jobs.values()].some(j=>j.state==='running'))throw Error('이전 리소스 작업이 진행 중입니다.');
  requesting=true;try{
  if(!['gpt-image','antigravity-image'].includes(input.provider)||typeof input.server!=='string'||typeof input.tool!=='string')throw Error('연결된 이미지 공급자를 선택하세요.');
  const args=require('../../src/core/creation-document').clone(input.args);
  require('../../src/core/prompt-safety').assertExternal(JSON.stringify(args));
  const downstream=require('../../src/core/downstream');
  const tools=await downstream.listTools(input.server);
  const tool=tools.find(t=>t.name===input.tool);if(!tool)throw Error('연결에 해당 도구가 없습니다.');
  const invalid=require('../../src/core/offload').validate(args,tool.inputSchema);if(invalid)throw Error('도구 입력 형식: '+invalid);
  const choice=await require('electron').dialog.showMessageBox(ctx.window(),{type:'question',title:'리소스 제작',message:input.provider+' 도구를 한 번 실행합니다.',detail:input.server+' / '+input.tool+'\n'+JSON.stringify(args,null,2).slice(0,10000),buttons:['취소','이 입력으로 제작'],defaultId:0,cancelId:0,noLink:true});
  if(choice.response!==1)return{cancelled:true};
  require('./device-key-delivery').assertFrame();
  const id=crypto.randomUUID(),job={id,state:'running',provider:input.provider};jobs.set(id,job);
  require('../../src/core/promise-timeout').withTimeout(downstream.callTool(input.server,input.tool,args),10*60*1000,()=>Error('제작 요청 시간이 초과되었습니다. 결과를 공급자에서 확인하세요. 자동 재실행하지 않습니다.'))
   .then(result=>{if(result.isError)throw Error('리소스 도구가 오류를 반환했습니다.');if(Buffer.byteLength(JSON.stringify(result))>12*1024*1024)throw Error('결과가 12 MiB를 넘습니다. 공급자에서 파일로 저장한 뒤 가져오세요.');Object.assign(job,{state:'succeeded',result});})
   .catch(e=>Object.assign(job,{state:'failed',error:String(e.message).slice(0,400)}));
  return{id,state:job.state};
  }finally{requesting=false;}
 });
 ctx.handle('studio:resourcePoll',id=>{
  const job=jobs.get(id);if(!job)throw Error('제작 작업을 찾지 못했습니다.');
  if(job.state!=='running')jobs.delete(id);return job;
 });
 ctx.handle('studio:comfyUrl',()=>{
  const value=require('../../src/core/config').load().localRuntimes?.comfyUrl||'http://127.0.0.1:8188';
  const u=new URL(value);if(u.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('이 PC의 ComfyUI 주소를 설정하세요.');if(u.hostname==='[::1]')u.hostname='localhost';return u.origin;
 });
}
module.exports={register};

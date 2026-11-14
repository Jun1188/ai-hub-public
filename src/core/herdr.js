'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFile,spawn}=require('node:child_process');
const isFile=p=>{try{return Boolean(p)&&path.isAbsolute(p)&&fs.statSync(p).isFile();}catch{return false;}};
const hashes=new Map();
// The installed Hub ships Herdr as extraResources/herdr; a source checkout keeps the staged copy under resources/herdr.
// herdr.exe must stay beside its conpty directory, so it is run in place and never copied out.
function bundled(){
 const app=path.resolve(__dirname,'../..');
 for(const dir of[path.join(app,'..','herdr'),path.join(app,'resources','herdr')]){
  const exe=path.join(dir,'herdr.exe');let stat,manifest;
  try{stat=fs.statSync(exe);manifest=JSON.parse(fs.readFileSync(path.join(dir,'herdr-manifest.json'),'utf8'));}catch{continue;}
  const key=exe+'|'+stat.size+'|'+stat.mtimeMs;
  if(!hashes.has(key))hashes.set(key,crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex'));
  return{path:exe,version:String(manifest.version||''),verified:hashes.get(key)===manifest.files?.['herdr.exe']};
 }
 return null;
}
// Order: explicit override, the bundled copy bound to this Hub version, then a separate user install.
function locate(){
 if(isFile(process.env.HERDR_BIN_PATH))return{path:process.env.HERDR_BIN_PATH,source:'env'};
 const own=bundled();
 if(own?.verified)return{path:own.path,source:'bundled',version:own.version};
 const home=path.join(os.homedir(),'.herdr'),candidates=[path.join(home,'packages','standalone','current','herdr.exe'),path.join(home,'bin','herdr.exe'),path.join(home,'herdr.exe')];
 const releases=path.join(home,'packages','standalone','releases');
 try{for(const dir of fs.readdirSync(releases).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})))candidates.push(path.join(releases,dir,'herdr.exe'));}catch(e){if(e.code!=='ENOENT')throw e;}
 for(const p of String(process.env.PATH||'').split(path.delimiter))candidates.push(path.join(p,process.platform==='win32'?'herdr.exe':'herdr'));
 const found=candidates.find(isFile);
 if(found)return{path:found,source:'user',bundledRejected:Boolean(own)};
 return own?{path:null,source:null,bundledRejected:true}:null;
}
const binary=()=>locate()?.path||null;
const missing=()=>locate()?.bundledRejected?'기본 포함된 Herdr 파일이 검토본과 달라 실행하지 않았습니다. Hub를 다시 설치하세요.':'Herdr를 찾지 못했습니다. 이 Hub 설치본에 Herdr가 포함되지 않았습니다.';
const session=value=>{if(typeof value!=='string'||!/^[a-zA-Z0-9][\w.-]{0,63}$/.test(value))throw Error('Herdr 세션 이름을 확인하세요.');return value;};
const target=value=>{if(typeof value!=='string'||!/^(w\d+:p\d+|[a-zA-Z][\w.-]{0,63})$/.test(value))throw Error('Herdr 에이전트 이름 또는 pane ID가 필요합니다.');return value;};
const pane=value=>{if(typeof value!=='string'||!/^w\d+:p\d+$/.test(value))throw Error('pane ID는 w1:p1 형식입니다.');return value;};
function cli(args,{timeout=10000,signal,raw=false}={}){
 const exe=binary();if(!exe)throw Error(missing());
 return new Promise((resolve,reject)=>execFile(exe,args,{windowsHide:true,encoding:'buffer',timeout,maxBuffer:2*1024*1024,signal},(error,stdout,stderr)=>{
  const decode=b=>require('./console-text').decode(b||Buffer.alloc(0));
  if(error){
   // The CLI reports failures as one JSON object on stderr; keep its code so callers can tell a stopped session from a real fault.
   const detail=decode(stderr).slice(-1200);let reported=null;try{reported=JSON.parse(detail.trim()).error;}catch{}
   return reject(Object.assign(Error('Herdr 요청 실패: '+(reported?.message?String(reported.message)+' ('+reported.code+')':detail)),{herdrCode:reported?.code||null,outcomeUnknown:Boolean(error.killed||error.code==='ABORT_ERR'),cause:error}));
  }
  try{const text=decode(stdout);const value=raw?text:JSON.parse(text);if(value?.error)throw Error(String(value.error.message||value.error));resolve(value?.result||value);}catch(e){reject(e);}
 }));
}
async function inspect(input={}){
 const found=locate();
 if(!found?.path)return{available:false,sessions:[],message:missing()};
 if(input.action==='sessions')return{available:true,binary:{source:found.source,version:found.version||null},...await cli(['session','list','--json'])};
 const prefix=['--session',session(input.session||'default')];
 if(input.action==='read')return cli([...prefix,'pane','read',pane(input.target),'--source','recent','--lines','80','--format','text'],{raw:true}).then(value=>require('./secret-scrub').scrub(value));
 if(input.action==='wait'){
  if(!['idle','working','blocked','done','unknown'].includes(input.until||'done'))throw Error('대기 상태를 확인하세요.');
  return cli([...prefix,'agent','wait',target(input.target),'--until',input.until||'done','--timeout','45000'],{timeout:50000});
 }
 try{const result=await cli([...prefix,'api','snapshot']);return{available:true,running:true,...result};}
 catch(e){if(e.herdrCode!=='server_not_running')throw e;return{available:true,running:false,snapshot:{},message:'이 세션은 실행 중이 아닙니다. 세션 시작 후 다시 확인하세요.'};}
}
function command(input){
 const args=['--session',session(input.session)],action=input.action;
 if(action==='prompt'){
  if(typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>12000)throw Error('1–12000자 작업 지시가 필요합니다.');
  require('./prompt-safety').assertNoSecrets(input.prompt);
  args.push('agent','prompt',target(input.target));
  if(input.wait){const until=input.until||'done';if(!['idle','done','blocked'].includes(until))throw Error('완료 대기 상태를 확인하세요.');args.push('--wait','--until',until,'--until','blocked','--timeout',String(input.timeoutMs||300000));}
  args.push('--',input.prompt);
 }else if(action==='start'){
  if(!['codex','claude','agy','gemini'].includes(input.kind)||typeof input.name!=='string'||!/^[a-zA-Z][\w.-]{0,47}$/.test(input.name))throw Error('에이전트 종류와 이름을 확인하세요.');
  args.push('agent','start',input.name,'--kind',input.kind,'--pane',pane(input.target),'--timeout','30000');
 }else if(action==='workspace'){
  const p=require('./projects').getById(input.projectId);if(!p)throw Error('등록된 프로젝트가 필요합니다.');
  args.push('workspace','create','--cwd',p.path,'--label',String(input.label||p.name).slice(0,80),'--no-focus');
 }else if(action==='split'){
  if(!['right','down'].includes(input.direction))throw Error('분할 방향을 선택하세요.');
  args.push('pane','split',pane(input.target),'--direction',input.direction,'--no-focus');
 }else throw Error('지원하지 않는 Herdr 제어 작업입니다.');
 if(input.timeoutMs!==undefined&&(!Number.isInteger(input.timeoutMs)||input.timeoutMs<1000||input.timeoutMs>1800000))throw Error('대기 시간은 1초–30분입니다.');
 return args;
}

async function dispatch(args,input){
 if(input.action==='prompt'){
  const before=await cli(['--session',input.session,'agent','get',input.target]);
  const agent=before.agent||before;
  if(!['idle','done'].includes(agent.agent_status)||agent.interactive_ready===false||agent.launch_pending)throw Error('대상 에이전트가 입력 대기 상태가 아닙니다. 현재 세션을 확인하세요.');
 }
 return cli(args,{timeout:(input.timeoutMs||300000)+5000});
}
const active=new Map();
function root(){const r=path.join(require('./paths').hubDataDir(),'herdr-jobs.local');fs.mkdirSync(r,{recursive:true});return r;}
function receiptFile(id){if(!/^[a-f0-9-]{36}$/.test(id||''))throw Error('requestId UUID가 필요합니다.');return path.join(root(),id+'.json');}
function persist(job){const file=receiptFile(job.id),tmp=file+'.tmp';const {_process,...record}=job;fs.writeFileSync(tmp,JSON.stringify(record),'utf8');fs.renameSync(tmp,file);}
function submit(input){
 const args=command(input),file=receiptFile(input.requestId),fingerprint=crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex');
 try{const old=JSON.parse(fs.readFileSync(file,'utf8'));if(old.fingerprint!==fingerprint)throw Error('같은 requestId를 다른 요청에 사용할 수 없습니다.');return active.get(old.id)||{...old,state:old.state==='running'?'outcome-unknown':old.state};}catch(e){if(e.code!=='ENOENT')throw e;}
 if(!binary())throw Error(missing());
 if([...active.values()].some(j=>j.state==='running'&&j.session===input.session&&j.target===input.target&&input.target))throw Error('이 대상에 전달한 작업이 진행 중입니다. 기존 요청을 먼저 확인하세요.');
 const job={id:input.requestId,session:input.session,action:input.action,target:input.target||null,state:'running',fingerprint,startedAt:new Date().toISOString()};
 fs.writeFileSync(file,JSON.stringify(job),{encoding:'utf8',flag:'wx'});active.set(job.id,job);
 dispatch(args,input).then(result=>Object.assign(job,{state:'succeeded',result:require('./secret-scrub').sanitize(result)})).catch(e=>Object.assign(job,{state:e.outcomeUnknown?'outcome-unknown':'failed',error:e.message})).then(()=>{try{persist(job);active.delete(job.id);}catch{job.state='outcome-unknown';job.error='Herdr 요청 영수증을 저장하지 못했습니다. 대상 세션에서 결과를 확인하세요.';}});
 return job;
}
function status(id){if(active.has(id))return active.get(id);const job=JSON.parse(fs.readFileSync(receiptFile(id),'utf8'));return{...job,state:job.state==='running'?'outcome-unknown':job.state};}
function startSession(name){
 const exe=binary();if(!exe)throw Error(missing());
 const child=spawn(exe,['--session',session(name),'server'],{windowsHide:true,stdio:'ignore',detached:true});child.on('error',()=>{});child.unref();return{requested:true,session:name,message:'세션 시작을 요청했습니다. 세션 목록에서 실행 상태를 확인하세요.'};
}
module.exports={binary,locate,session,target,pane,cli,inspect,command,submit,status,startSession};

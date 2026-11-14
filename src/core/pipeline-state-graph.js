'use strict';
const crypto=require('crypto'),safety=require('./prompt-safety');
const TYPES=['shell','msbuild','unity-batch','uat','ai','mcp-tool','source-index','finetune-gen','llama-chat','comfy-workflow','api-request','delay','offload','hub-tool','herdr-agent'];
const OPS=['eq','ne','gt','gte','lt','lte','contains','exists'];
const forbidden=new Set(['__proto__','prototype','constructor','apiKey','authToken','controlToken','password','secret']);
function clean(value,limit=65536){
 const text=JSON.stringify(value);if(!text||Buffer.byteLength(text)>limit)throw Error('상태/그래프 크기 제한을 넘었습니다.');
 safety.assertNoSecrets(text);
 const v=JSON.parse(text);
 function walk(x,depth){if(depth>12)throw Error('상태 깊이 제한을 넘었습니다.');if(x&&typeof x==='object')for(const [k,v]of Object.entries(x)){if(forbidden.has(k))throw Error('상태에 인증/프로토타입 필드를 저장할 수 없습니다.');walk(v,depth+1);}}
 walk(v,0);return v;
}
function object(v){return Boolean(v&&typeof v==='object'&&!Array.isArray(v));}
function keys(p){if(typeof p!=='string'||!p||p.length>160)throw Error('상태 경로가 필요합니다.');const ks=p.split('.');if(ks.some(k=>!/^\w+$/.test(k)||forbidden.has(k)))throw Error('잘못된 상태 경로');return ks;}
function read(data,p){let v=data;for(const k of keys(p)){if(!object(v)||!Object.hasOwn(v,k))return undefined;v=v[k];}return v;}
function set(data,p,value){const ks=keys(p);let v=data;for(const k of ks.slice(0,-1)){if(!Object.hasOwn(v,k))v[k]={};if(!object(v[k]))throw Error('상태 경로가 객체와 충돌합니다.');v=v[k];}v[ks.at(-1)]=clean(value);}
function condition(data,node){
 const v=read(data,node.path),want=node.value;if(node.operator==='exists')return v!==undefined;
 if(v===undefined)throw Error('분기 상태값이 없습니다: '+node.path);
 if(['gt','gte','lt','lte'].includes(node.operator)){if(!Number.isFinite(v)||!Number.isFinite(want))throw Error('숫자 비교에는 숫자 상태와 값이 필요합니다.');}
 switch(node.operator){case'eq':return JSON.stringify(v)===JSON.stringify(want);case'ne':return JSON.stringify(v)!==JSON.stringify(want);
 case'gt':return v>want;case'gte':return v>=want;case'lt':return v<want;case'lte':return v<=want;
 case'contains':if(typeof v!=='string'||typeof want!=='string')throw Error('contains는 문자열 비교입니다.');return v.includes(want);default:throw Error('분기 연산자를 확인하세요.');}
}
function destinations(n){return n.kind==='condition'?[n.onTrue,n.onFalse]:n.kind==='end'?[]:[n.next,...(n.onError?[n.onError]:[])];}
function validate(input){
 const g=clean(input,256*1024);
 safety.assertExternal(JSON.stringify(g));
 if(/\b[a-z]:[\\/]/i.test(JSON.stringify(g)))throw Error('공유 그래프에는 기기 절대경로 대신 실행 시 변수를 사용하세요.');if(g.version!==1||!Array.isArray(g.nodes)||!g.nodes.length||g.nodes.length>64)throw Error('Graph version 1 / 1–64개 노드가 필요합니다.');
 g.initialState=clean(g.initialState??{});if(!object(g.initialState))throw Error('초기 상태는 JSON 객체여야 합니다.');
 g.maxTransitions=g.maxTransitions??32;g.maxVisits=g.maxVisits??8;
 if(!Number.isInteger(g.maxTransitions)||g.maxTransitions<1||g.maxTransitions>128||!Number.isInteger(g.maxVisits)||g.maxVisits<1||g.maxVisits>32)throw Error('전이 1–128회, 노드 방문 1–32회 상한을 지정하세요.');
 const ids=new Set();
 for(const n of g.nodes){
  if(!/^[a-zA-Z][\w-]{0,63}$/.test(n.id||'')||ids.has(n.id))throw Error('노드 ID가 잘못되었거나 중복됩니다.');ids.add(n.id);
  if(!['step','state','condition','review','end'].includes(n.kind))throw Error('알 수 없는 노드 종류: '+n.kind);
  if(n.kind==='step'){
   if(!object(n.step)||!TYPES.includes(n.step.type)||typeof n.step.name!=='string')throw Error('실행 단계의 type/name을 지정하세요.');
   const required={shell:['command'],msbuild:['sln'],'unity-batch':['executeMethod'],uat:['command'],ai:['promptTemplate'],'mcp-tool':['server','tool'],'source-index':['index','root'],'finetune-gen':['indexName'],'llama-chat':['prompt'],'comfy-workflow':['workflowFile'],'hub-tool':['tool']};
   for(const f of required[n.step.type]||[])if(typeof n.step[f]!=='string'||!n.step[f])throw Error(n.id+': '+f+' 입력이 필요합니다.');
  }
  if(n.kind==='step'&&n.step.type==='herdr-agent')require('./herdr').command({...n.step,action:'prompt',wait:true});
  if(n.game){if(!object(n.game)||!['plan','asset','implement','playtest','review'].includes(n.game.role)||typeof n.game.goal!=='string'||n.game.goal.length>2000||!Array.isArray(n.game.skills)||n.game.skills.some(s=>typeof s!=='string'||!/^skills\/[\w./-]+\/SKILL\.md$/i.test(s)||s.split('/').includes('..')))throw Error('게임개발 역할·완료 조건·스킬 경로를 확인하세요.');}
  if(n.kind==='step'&&n.step.type==='api-request')require('./pipeline-api-request').validate(n.step);
  if(n.kind==='step'&&n.step.type==='hub-tool')require('./pipeline-hub-step').validate(n.step,n.id);
  if(n.kind==='step'&&n.step.type==='delay'&&(!Number.isInteger(n.step.ms)||n.step.ms<1||n.step.ms>60000))throw Error('대기 시간은 1–60000ms입니다.');
  if(n.kind==='step'&&n.step.type==='offload'){
   const s=n.step;if(typeof s.task!=='string'||!s.task)throw Error(n.id+': task 입력이 필요합니다.');
   if(s.files!==undefined&&(!Array.isArray(s.files)||s.files.length>200||s.files.some(f=>typeof f!=='string')))throw Error(n.id+': files는 200개 이하 문자열 배열입니다.');
   try{require('./offload-request').modelSelection(s);}catch(e){throw Error(n.id+': '+e.message);}
   if(s.schema!==undefined&&!object(s.schema))throw Error(n.id+': schema는 JSON Schema 객체입니다.');
   if(s.expert!==undefined&&typeof s.expert!=='boolean')throw Error(n.id+': expert는 true/false입니다.');
  }
  if(n.kind==='condition'){keys(n.path);if(!OPS.includes(n.operator)||n.operator!=='exists'&&!Object.hasOwn(n,'value'))throw Error('분기 연산자/값을 확인하세요.');}
  if(n.kind==='state'){
   if(!object(n.patch||{})||!object(n.increments||{}))throw Error('상태 변경은 객체여야 합니다.');
   for(const p of Object.keys(n.patch||{}))keys(p);
   if(n.copy!==undefined&&!object(n.copy))throw Error('상태 복사는 객체여야 합니다.');
   for(const [to,from]of Object.entries(n.copy||{})){keys(to);keys(from);}
   for(const [p,v]of Object.entries(n.increments||{})){keys(p);if(!Number.isFinite(v))throw Error('증가량은 숫자여야 합니다.');}
  }
 }
 if(!ids.has(g.entry))throw Error('시작 노드를 선택하세요.');
 for(const n of g.nodes)for(const to of destinations(n))if(!ids.has(to))throw Error(n.id+': 연결 대상이 없습니다: '+to);
 const reached=new Set(),queue=[g.entry];while(queue.length){const id=queue.shift();if(reached.has(id))continue;reached.add(id);queue.push(...destinations(g.nodes.find(n=>n.id===id)));}
 if(reached.size!==ids.size)throw Error('시작점에서 도달할 수 없는 노드가 있습니다.');
 const ending=new Set(g.nodes.filter(n=>n.kind==='end').map(n=>n.id));let changed=true;
 while(changed){changed=false;for(const n of g.nodes)if(!ending.has(n.id)&&destinations(n).some(id=>ending.has(id))){ending.add(n.id);changed=true;}}
 if(ending.size!==ids.size)throw Error('모든 노드에 종료 노드로 향하는 경로가 필요합니다.');
 return g;
}
const fingerprint=g=>crypto.createHash('sha256').update(JSON.stringify(validate(g))).digest('hex');
async function execute(input,io={}){
 const g=validate(input),sha=fingerprint(g),saved=io.checkpoint;
 if(saved&&saved.graphSha!==sha)throw Error('저장된 중단점 이후 그래프가 변경되었습니다. 새 실행을 시작하세요.');
 const state=saved?clean(saved,128*1024):{graphSha:sha,data:clean(g.initialState),cursor:g.entry,transitions:0,visits:{}};
 if(!object(state.data)||!object(state.visits)||!Number.isInteger(state.transitions)||state.transitions<0||state.transitions>g.maxTransitions)throw Error('중단점 상태를 확인하세요.');
 for(const [id,count] of Object.entries(state.visits))if(!g.nodes.some(n=>n.id===id)||!Number.isInteger(count)||count<0||count>g.maxVisits)throw Error('중단점 반복 횟수를 확인하세요.');
 if(io.stateOverride!==undefined)state.data=clean(io.stateOverride);
 if(!object(state.data))throw Error('재개 상태는 객체여야 합니다.');
 const trace=[];
 while(state.cursor){
  if(io.shouldStop?.())return {status:'cancelled',checkpoint:state,trace};
  if(state.transitions>=g.maxTransitions)throw Error('그래프 전이 횟수 상한에 도달했습니다.');
  const n=g.nodes.find(n=>n.id===state.cursor);if(!n)throw Error('중단점 노드가 없습니다.');
  const visits=(state.visits[n.id]||0)+1;if(!Number.isInteger(visits)||visits>g.maxVisits)throw Error('노드 반복 상한에 도달했습니다: '+n.id);
  state.visits[n.id]=visits;state.transitions++;
  let next=n.next,status='succeeded',output='',exitCode=0;
  if(n.kind==='condition')next=condition(state.data,n)?n.onTrue:n.onFalse;
  if(n.kind==='state'){
   const copies=Object.entries(n.copy||{}).map(([to,from])=>{const value=read(state.data,from);if(value===undefined)throw Error('복사할 상태가 없습니다: '+from);return[to,clean(value)];});
   for(const[p,v]of Object.entries(n.patch||{}))set(state.data,p,v);
   for(const[p,v]of copies)set(state.data,p,v);
   for(const[p,v]of Object.entries(n.increments||{})){const old=read(state.data,p)??0;if(!Number.isFinite(old))throw Error('증가 대상 상태가 숫자가 아닙니다: '+p);set(state.data,p,old+v);}
  }
  if(n.kind==='step'){
   if(!io.executeStep)throw Error('실행 단계 처리기가 없습니다.');
   const r=await io.executeStep(n,state.data,state.transitions-1);exitCode=r.exitCode;output=String(r.output||'').slice(-12000);
   if(io.shouldStop?.())status='cancelled';
   else if(exitCode!==0){status='failed';next=n.onError||null;}
   state.data.last={nodeId:n.id,exitCode,status,output,...(r.data!==undefined?{data:clean(r.data)}:{})};clean(state.data);
  }
  if(n.kind==='end')next=null;
  if(n.kind==='review')status='paused';
  const event={nodeId:n.id,kind:n.kind,visit:visits,transition:state.transitions,status,next:next||null,exitCode};
  trace.push(event);state.cursor=next||null;
  await io.onTransition?.(event,clean(state,128*1024));
  if(status==='cancelled'||status==='paused'||status==='failed'&&!next)return{status,checkpoint:state,trace};
 }
 return{status:'succeeded',checkpoint:state,trace};
}
async function simulate(graph,mockResults={}){
 return execute(graph,{executeStep:async n=>mockResults[n.id]||{exitCode:0,output:'[simulation: no commands/models/MCP were called]',...(n.step.type==='api-request'?{data:{httpStatus:200,body:{id:'simulated-job',status:'done'}}}:{}),...(n.step.type==='hub-tool'?{data:{simulated:true,ok:true,decision:'KEEP_BASE',status:'insufficient-data',added:0,recommended:0,score:1,briefPath:'simulated-brief.md',fingerprint:'simulated',newPairs:0}}:{})}});
}
module.exports={validate,execute,simulate,fingerprint,read,clean,TYPES,OPS,destinations};

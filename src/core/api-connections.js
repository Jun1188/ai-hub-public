'use strict';
const fs=require('fs'),path=require('path');
const ID=/^[a-z][a-z0-9-]{0,47}$/;
// 내장 프리셋은 편집기가 채우는 값일 뿐 저장 형식은 직접 입력과 같다. 키는 각자 서비스에서 발급한다.
const PRESETS=[
 {id:'discord',name:'Discord',origin:'https://discord.com',auth:'bot',allowedRoutes:['/api/v10/'],hint:'Discord 개발자 포털에서 만든 봇 토큰을 넣습니다. 메시지 전송처럼 바꾸는 호출은 AI 쓰기 허용이 필요합니다.'},
 {id:'github',name:'GitHub',origin:'https://api.github.com',auth:'bearer',allowedRoutes:['/repos/','/user','/orgs/'],hint:'필요한 저장소·권한만 고른 GitHub 세분화된 개인 액세스 토큰을 넣습니다. User-Agent는 Hub가 붙입니다.'},
 {id:'gemini',...require('./credential-migration').LEGACY_API.gemini,allowedRoutes:['/v1beta/models'],hint:'이 PC용 Google Gemini API 키를 준비한 뒤 입력하세요. 저장 후 모델 목록 읽기로 인증을 확인할 수 있습니다.'},
];
const AUTH=['bearer','bot','header','none'];
function identifier(id){if(typeof id!=='string'||!ID.test(id)||['constructor','prototype'].includes(id))throw Error('연결 ID는 영문 소문자·숫자·하이픈 1–48자입니다.');return id;}
function origin(input){
 let u;try{u=new URL(input);}catch{throw Error('API 서비스 주소를 확인하세요.');}
 const local=['localhost','127.0.0.1','[::1]'].includes(u.hostname);
 if((u.protocol!=='https:'&&!(local&&u.protocol==='http:'))||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('HTTPS 서비스 origin만 입력하세요. 경로는 실행 단계에서 지정합니다. 로컬 HTTP 테스트는 허용합니다.');
 return u.origin;
}
// 자격 증명 없이 읽는 외부 주소(API 명세·참조 문서). 키가 실린 주소는 받지 않는다.
function httpsUrl(input){
 let u;try{u=new URL(input);}catch{throw Error('HTTPS 주소를 확인하세요.');}
 const {sensitiveKey}=require('./secret-scrub');
 if(u.protocol!=='https:'||u.username||u.password||u.hash||u.href.length>2048||[...u.searchParams.keys()].some(k=>sensitiveKey(k)||/key|token|auth|sig/i.test(k)))throw Error('인증 정보가 없는 HTTPS 주소(2048자 이하, # 없음)만 등록할 수 있습니다.');
 require('./prompt-safety').assertNoSecrets(u.href);return u.href;
}
function createStore(options={}){
 const root=options.root||require('./paths').hubDataDir(),file=path.join(root,'api-connections.local.json');
 const vault=options.vault||require('./credential-vault'),isBusy=options.isBusy||(()=>require('./change-signals').busy('pipeline').length>0);
 const credential=id=>'api-'+identifier(id);
 function load(){try{const r=JSON.parse(fs.readFileSync(file,'utf8'));if(r.version!==1||!Array.isArray(r.connections))throw Error('API 연결 저장소가 손상되었습니다.');return r;}catch(e){if(e.code==='ENOENT')return {version:1,connections:[]};throw e;}}
 function write(r){fs.mkdirSync(root,{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(r,null,2),'utf8');fs.renameSync(file+'.tmp',file);}
 function get(id){identifier(id);const p=load().connections.find(p=>p.id===id);if(!p)throw Error('이 PC에 API 연결이 없습니다: '+id);return p;}
 function list(){return load().connections.map(p=>({...p,keyStored:vault.statusFor(credential(p.id)).stored}));}
 function save(input,secret){
  if(isBusy())throw Error('실행 중인 파이프라인 종료 후 API 연결을 변경하세요.');
  const id=identifier(input.id),url=origin(input.origin),auth=input.auth||'bearer';
  if(!AUTH.includes(auth))throw Error('지원되지 않는 API 인증 방식입니다.');
  const header=auth==='header'?String(input.authHeader||'X-API-Key'):'Authorization';
  if(auth==='header'&&(!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(header)||/^(host|cookie|content-length|content-type|proxy-authorization|connection)$/i.test(header)))throw Error('API 키 헤더 이름을 확인하세요.');
  const maxCallsPerRun=input.maxCallsPerRun??8;if(!Number.isInteger(maxCallsPerRun)||maxCallsPerRun<1||maxCallsPerRun>32)throw Error('실행당 API 호출 상한은 1–32회입니다.');
  const records=load(),old=records.connections.find(p=>p.id===id);
  if(old&&old.origin!==url)throw Error('키가 다른 서비스로 전달되지 않도록 주소 변경에는 새 연결 ID를 사용하세요.');
  if(secret!==undefined&&(typeof secret!=='string'||!secret.trim()||/[\r\n]/.test(secret)||secret.length>8192))throw Error('API 키를 확인하세요.');
  if(auth!=='none'&&!secret&&!vault.statusFor(credential(id)).stored)throw Error('이 연결의 API 키를 암호화 저장하세요.');
  const routes=input.allowedRoutes??['/'];
  if(!Array.isArray(routes)||!routes.length||routes.length>32||routes.some(r=>typeof r!=='string'||!r.startsWith('/')||r.startsWith('//')||r.includes('\\')||r.includes('?')||r.includes('#')||new URL(r,url).pathname!==r))throw Error('API 경로 범위는 정규화된 절대 경로 1–32개입니다.');
  // allowWrite는 MCP api_call의 POST·PUT·PATCH·DELETE 허용이다. 데스크톱 편집기만 이 저장 경로를 부른다.
  const value={id,name:String(input.name||id).slice(0,80),origin:url,auth,authHeader:header,maxCallsPerRun,allowedRoutes:[...new Set(routes)],allowWrite:input.allowWrite===true,...(input.specUrl?{specUrl:httpsUrl(input.specUrl)}:{})};
  require('./prompt-safety').assertNoSecrets(value.name);
  if(secret&&auth!=='none')vault.put(credential(id),secret,url);
  records.connections=records.connections.filter(p=>p.id!==id).concat(value);write(records);return list().find(p=>p.id===id);
 }
 function remove(id){
  if(isBusy())throw Error('실행 중에는 API 연결을 삭제할 수 없습니다.');
  identifier(id);
  const records=load();
  // A failed metadata write may leave a profile, but startup must never recover its unlinked key.
  vault.remove(credential(id));
  records.connections=records.connections.filter(profile=>profile.id!==id);
  write(records);
  return {removed:true};
 }
 return {get,list,save,remove,withCredential:(id,url,fn)=>vault.use(credential(id),url,fn)};
}
let singleton;const instance=()=>singleton||(singleton=createStore());
module.exports={identifier,origin,httpsUrl,PRESETS,createStore,instance};

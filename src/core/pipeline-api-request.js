'use strict';
const safety=require('./prompt-safety'),connections=require('./api-connections');
const {sensitiveKey:sensitive,redactCredentials:scrub,sanitize}=require('./secret-scrub');
const METHODS=['GET','POST','PUT','PATCH','DELETE'];
const breakers=new Map();
function validate(step){
 connections.identifier(step.connection);
 if(typeof step.route!=='string'||!step.route.startsWith('/')||step.route.startsWith('//')||step.route.length>4096||step.route.includes('\\'))throw Error('API 경로는 /로 시작하는 상대 경로여야 합니다.');
 if(!METHODS.includes(step.method||'GET'))throw Error('API 메서드를 확인하세요.');
 if(step.timeoutMs!==undefined&&(!Number.isInteger(step.timeoutMs)||step.timeoutMs<100||step.timeoutMs>120000))throw Error('API 시간 제한은 100–120000ms입니다.');
 if((step.method||'GET')==='GET'&&step.body!==undefined)throw Error('GET 단계에는 body를 넣지 마세요.');
 if(step.headers&&(!step.headers||typeof step.headers!=='object'||Array.isArray(step.headers)))throw Error('API 헤더는 JSON 객체여야 합니다.');
 for(const k of Object.keys(step.headers||{}))if(!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(k)||sensitive(k)||/key|token|auth|^host$|^content-length$|^connection$|^transfer-encoding$/i.test(k))throw Error('인증 헤더는 연결의 암호화 키 설정을 사용하세요.');
}
function values(v,ctx,sub){
 if(typeof v==='string'){
  const full=v.match(/^\$\{state\.([\w.]+)\}$/);const out=full?require('./pipeline-state-graph').read(ctx.state||{},full[1]):sub(v,ctx);
  if(out===undefined)throw Error('API 입력의 상태값이 없습니다.');
  if(typeof out==='string')safety.assertExternal(out);else inspect(out);
  return out;
 }
 if(Array.isArray(v))return v.map(x=>values(x,ctx,sub));
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>{if(sensitive(k))throw Error('API body에 인증 필드를 넣지 마세요.');return[k,values(x,ctx,sub)];}));
 return v;
}
function inspect(v){if(typeof v==='string')safety.assertExternal(v);else if(v&&typeof v==='object')for(const [k,x]of Object.entries(v)){if(sensitive(k))throw Error('인증 데이터는 API body로 전달할 수 없습니다.');inspect(x);}}
async function limitedBody(response,signal,limit=65536){
 if(!response.body)return '';
 const reader=response.body.getReader(),chunks=[];let bytes=0;
 try{for(;;){if(signal.aborted)throw Error('API request cancelled');const r=await reader.read();if(r.done)break;bytes+=r.value.byteLength;if(bytes>limit)throw Error('API response exceeds limit');chunks.push(Buffer.from(r.value));}return Buffer.concat(chunks).toString('utf8');}
 catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
}
async function request(step,ctx,io,run,options={}){
 validate(step);
 const store=options.store||connections.instance(),profile=store.get(step.connection),route=io.substituteVars(step.route,ctx);
 const url=new URL(route,profile.origin);
 if(!route.startsWith('/')||route.startsWith('//')||route.includes('\\')||url.origin!==profile.origin||url.username||url.password||url.hash||[...url.searchParams.keys()].some(sensitive))throw Error('API 요청은 등록한 서비스 주소만 사용할 수 있습니다.');
 // 경로는 서비스의 URL 경로다. /users/<id>(Discord·GitHub REST)를 macOS 사용자 폴더로 보지 않고, 키 모양과 Windows 사용자 경로만 막는다.
 safety.assertNoSecrets(route);if(/[A-Z](?::|%3A)(?:\/|%5C|%2F)Users(?:\/|%5C|%2F)/i.test(route))throw Error('API 경로에 이 PC의 사용자 경로를 넣지 마세요.');
 const circuit=breakers.get(profile.id);if(circuit?.until>Date.now())throw Error('API 연결 회로가 잠시 차단되었습니다. 자동 재시도하지 않습니다.');
 if(run.cancelled||run.abort.signal.aborted)throw Error('API 요청이 취소되었습니다.');
 const body=step.body===undefined?undefined:values(step.body,ctx,io.substituteVars);
 inspect(body);const bodyText=body===undefined?undefined:JSON.stringify(body);if(bodyText&&Buffer.byteLength(bodyText)>65536)throw Error('API 요청 본문은 64KiB 이하여야 합니다.');
 const headers={Accept:'application/json'};
 for(const [k,v]of Object.entries(step.headers||{})){const value=values(v,ctx,io.substituteVars);if(typeof value!=='string'||value.length>1024||/[\r\n]/.test(value))throw Error('API 헤더 값을 확인하세요.');headers[k]=value;}
 if(bodyText!==undefined)headers['Content-Type']='application/json';
 const bindings=run.record.apiOrigins||(run.record.apiOrigins={});
 if(Object.hasOwn(bindings,profile.id)&&bindings[profile.id]!==profile.origin)throw Error('중단 이후 API 연결 주소가 변경되었습니다. 새 실행을 시작하세요.');
 bindings[profile.id]=profile.origin;
 const calls=run.record.apiCalls||(run.record.apiCalls={}),used=Object.hasOwn(calls,profile.id)?calls[profile.id]:0;
 if(!Number.isInteger(used)||used>=profile.maxCallsPerRun)throw Error('이 실행의 API 호출 상한에 도달했습니다.');
 calls[profile.id]=used+1;io.persistRun?.(run.record);
 const signal=AbortSignal.any([run.abort.signal,AbortSignal.timeout(step.timeoutMs||30000)]);
 let response;
 try{
  const module=require('./credential-broker');
  const broker=options.broker||(options.store?module.createBroker({connections:()=>store,vault:{statusFor:()=>({stored:profile.keyStored!==false}),use:(_provider,boundOrigin,fn)=>store.withCredential(profile.id,boundOrigin,fn)}}):module);
  response=await broker.requestResponse({credentialRef:'credential:api-'+profile.id,operationId:'api.request',jobId:run.record.runId,payload:{route,method:step.method||'GET',body,headers}},{signal,fetchFn:options.fetch,allowHttpErrors:true});
  const contentType=response.headers.get('content-type')||'';if(contentType&&!/json|^text\//i.test(contentType))throw Error('API response must be JSON/text');
  const raw=await limitedBody(response,signal);let parsed;try{parsed=JSON.parse(raw);}catch{parsed=raw.slice(0,12000);}
  const data={httpStatus:response.status,body:sanitize(parsed)};
  require('./pipeline-state-graph').clean(data);
  if(!response.ok){const failures=(circuit?.failures||0)+1;
   const retryMs=[429,503].includes(response.status)?require('./local-chat-stream').retryAfterMs(response.headers.get('retry-after')):0;
   const cooldown=Math.max(retryMs,failures>=3?30000:0);
   breakers.set(profile.id,{failures,until:cooldown?Date.now()+cooldown:0});
   if(cooldown)data.retryAfterMs=cooldown;
  }
  // 성공했어도 버킷이 비었으면(Discord X-RateLimit-Remaining: 0) 재설정까지 막는다 — 다음 호출이 429를 맞고 실패로 세지기 전에.
  else if(response.headers.get('x-ratelimit-remaining')==='0'){const wait=require('./local-chat-stream').retryAfterMs(response.headers.get('x-ratelimit-reset-after'));breakers.set(profile.id,{failures:0,until:wait?Date.now()+wait:0});if(wait)data.retryAfterMs=wait;}
  else breakers.delete(profile.id);
  return {exitCode:response.ok?0:1,data,output:JSON.stringify(data,null,2)};
 }catch{
  const failures=(circuit?.failures||0)+1;breakers.set(profile.id,{failures,until:failures>=3?Date.now()+30000:0});
  throw Error(run.abort.signal.aborted?'API 요청이 취소되었습니다.':'API 요청 실패: 시간 제한·연결·응답 크기/형식을 확인하세요. 자동 재시도하지 않습니다.');
 }
}
async function execute(step,index,run,ctx,io){
 const result=await request(step,ctx,io,run);run.graphStepData=result.data;
 io.appendLog(run.record.runId,index,'[api] '+step.connection+' '+(step.method||'GET')+'\n'+result.output+'\n','stdout');
 return result.exitCode;
}
module.exports={validate,request,execute,sanitize,sensitive};

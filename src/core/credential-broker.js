'use strict';
const crypto=require('crypto');
// 가림 정책은 secret-scrub 하나다(이름 sanitize는 그대로 내보낸다).
const {sensitiveKey:sensitive,sanitize}=require('./secret-scrub');
function retryAfterMs(value, now = Date.now()) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const seconds = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
  const delay = seconds === null ? Date.parse(text) - now : seconds * 1000;
  return Number.isFinite(delay) ? Math.max(0, Math.min(300000, Math.ceil(delay))) : 0;
}
// API 연결 저장소(integration)는 조립 루트(Electron main·hub-server)가 넣는다 — platform이 위 계층을 부르지 않는다.
let connectionStore=null;
function useConnections(provider){connectionStore=provider;}
function configuredConnections(){if(!connectionStore)throw Error('API connection store is not configured in this process');return connectionStore();}
function createBroker({vault=require('./credential-vault'),connections=configuredConnections,fetchFn,authorize=()=>true,localOrigin=require('./local-endpoints').origin}={}) {
  function target(input) {
    if(!input || Object.keys(input).some(k=>!['credentialRef','operationId','jobId','payload'].includes(k)) || !/^[-\w:.]{1,160}$/.test(input.jobId||''))throw Error('Invalid broker request or job scope');
    if(!authorize(input))throw Error('Broker operation is not approved');
    const p=input.payload||{},op=input.operationId;
    let provider,origin,route,method='GET',auth='bearer',header='Authorization',body,optional=false;
    if(input.credentialRef==='credential:omniroute'||/^omniroute[.]/.test(op||''))throw Error('OmniRoute is retired; no fallback or credential migration');
    if(/^(lmstudio|llamacpp)\.(models|catalog|chat|load|unload|health|props|router|legacyModels)$/.test(op||'')) {
      const [kind,action]=op.split('.');provider=kind;optional=true;
      origin=localOrigin(kind);
      const u=new URL(origin);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw Error('Local broker requires loopback origin');
      const routes={models:'/v1/models',legacyModels:'/api/v0/models',catalog:kind==='lmstudio'?'/api/v1/models':'/models',chat:'/v1/chat/completions',load:kind==='lmstudio'?'/api/v1/models/load':'/models/load',unload:kind==='lmstudio'?'/api/v1/models/unload':'/models/unload',health:'/health',props:'/props',router:'/models'};
      route=routes[action];if(['chat','load','unload'].includes(action)){method='POST';body=p.body;}
    } else if(op==='api.request') {
      const store=connections(),id=String(input.credentialRef||'').replace(/^credential:api-/,'');
      const profile=store.get(id);const savedOrigin=new URL(profile.origin);if(savedOrigin.port==='20128'&&['localhost','127.0.0.1','[::1]'].includes(savedOrigin.hostname))throw Error('Retired OmniRoute origin is blocked');provider='api-'+id;origin=profile.origin;auth=profile.auth;header=profile.authHeader;method=p.method||'GET';route=p.route;body=p.body;optional=auth==='none';
      if(!['GET','POST','PUT','PATCH','DELETE'].includes(method))throw Error('Invalid broker API method');
      if(!(profile.allowedRoutes||['/']).some(prefix=>typeof prefix==='string'&&route?.startsWith(prefix)))throw Error('API route is outside its registered scope');
    } else throw Error('Unsupported broker operation');
    if(input.credentialRef!=='credential:'+provider)throw Error('Credential reference does not match operation');
    if(typeof route!=='string'||!route.startsWith('/')||route.startsWith('//')||route.includes('\\'))throw Error('Invalid broker route');
    const url=new URL(route,origin);if(op==='api.request'){const profile=connections().get(provider.slice(4));if(!(profile.allowedRoutes||['/']).some(prefix=>url.pathname===prefix||url.pathname.startsWith(prefix.endsWith('/')?prefix:prefix+'/')))throw Error('API route is outside its registered scope');}if(url.origin!==origin||url.username||url.password||url.hash||[...url.searchParams.keys()].some(sensitive))throw Error('Broker origin or query violation');
    const inspect=v=>{if(v&&typeof v==='object')for(const [k,x]of Object.entries(v)){if(sensitive(k))throw Error('Use credential references for authentication');inspect(x);}else if(typeof v==='string')require('./prompt-safety').assertNoSecrets(v);};
    inspect(body);
    const bodyText=body===undefined?undefined:JSON.stringify(body);if(bodyText&&Buffer.byteLength(bodyText)>65536)throw Error('Broker request exceeds 64 KiB');
    const extraHeaders={};
    for(const [key,value] of Object.entries(op==='api.request'?(p.headers||{}):{})) {
      if(!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(key)||sensitive(key)||/key|token|auth|^host$|^content-length$|^connection$/i.test(key)||typeof value!=='string'||/[\r\n]/.test(value))throw Error('Invalid broker header');
      extraHeaders[key]=value;
    }
    // GitHub REST는 User-Agent 없는 요청을 거절한다. 단계가 직접 준 값이 있으면 그것을 쓴다.
    if(op==='api.request'&&!Object.keys(extraHeaders).some(k=>/^user-agent$/i.test(k)))extraHeaders['User-Agent']='ai-hub/'+require('../../package.json').version;
    return {provider,url,auth,header,method,bodyText,optional,extraHeaders};
  }
  async function perform(input,{signal,fetchFn:override,timeoutMs=60000,allowHttpErrors=false}={}) {
    const t=target(input);if(!Number.isFinite(timeoutMs)||timeoutMs<100||timeoutMs>1800000)throw Error('Invalid broker timeout');
    const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
    const send=async secret=>{
      const headers={'Content-Type':'application/json',Accept:'application/json',...t.extraHeaders};
      if(secret){if(/[\r\n]/.test(secret))throw Error('Invalid credential');headers[t.auth==='header'?t.header:'Authorization']=t.auth==='bearer'?'Bearer '+secret:t.auth==='bot'?'Bot '+secret:secret;}
      let response;
      try { response=await (override||fetchFn||fetch)(t.url.toString(),{method:t.method,headers,body:t.bodyText,redirect:'error',signal:combined}); }
      catch (cause) {const error=Error(combined.aborted?'Broker request cancelled or timed out; outcome unknown':'Broker transport failed; outcome unknown');error.code='BROKER_OUTCOME_UNKNOWN';error.outcome='unknown';error.timedOut=combined.aborted||['UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(cause?.cause?.code||cause?.code);const transportCode=cause?.cause?.code||cause?.code;if(!combined.aborted&&['ECONNREFUSED','ENOENT'].includes(transportCode))error.transportCode=transportCode;throw error;}
      if(!response.ok&&!(allowHttpErrors&&input.operationId==='api.request')){
        let detail='';const reader=response.body?.getReader();
        try {let raw='';if(reader){const parts=[];let size=0;for(;;){const p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>8192){await reader.cancel();break;}parts.push(Buffer.from(p.value));}raw=Buffer.concat(parts).toString('utf8');}else if(response.text)raw=await response.text();let value;try{value=JSON.parse(raw);}catch{value=raw;}const safe=sanitize(value,secret);detail=(typeof safe==='string'?safe:JSON.stringify(safe)).slice(0,500);}catch {}finally {reader?.releaseLock();}
        const error=Error('Broker HTTP '+response.status+'; no automatic replay'+(detail?': '+detail:''));error.code='BROKER_HTTP_REJECTED';error.status=response.status;error.outcome='rejected';error.outputStarted=false;error.preOutput=true;error.retryAfterMs=retryAfterMs(response.headers?.get?.('retry-after'));throw error;}
      // 회로 차단기가 읽는 대기 헤더(Discord 버킷 포함)만 넘긴다. 204(GitHub workflow dispatch 성공)는 본문 없이 돌려준다 — json()이 던져 성공을 실패로 보고했다.
      const kept=Object.fromEntries(['retry-after','x-ratelimit-remaining','x-ratelimit-reset-after'].map(k=>[k,response.headers?.get?.(k)]).filter(([,v])=>v));
      if([204,205,304].includes(response.status))return new Response(null,{status:response.status,headers:kept});
      if(!response.body&&typeof response.json==='function')return new Response(JSON.stringify(sanitize(await response.json(),secret)),{status:response.status||200,headers:{'Content-Type':'application/json'}});
      const type=response.headers?.get?.('content-type')||'application/json';
      if(/text\/event-stream/i.test(type)) {
        const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true}),encoder=new TextEncoder();let pending='';
        const body=new ReadableStream({
          async pull(controller){try{for(;;){const part=await reader.read();pending+=part.done?decoder.decode():decoder.decode(part.value,{stream:true});if(pending.length>1048576)throw Error('Broker stream frame exceeds limit');
            let index,emitted=false;while((index=pending.indexOf('\n'))>=0){let line=pending.slice(0,index);pending=pending.slice(index+1);if(line.startsWith('data:')&&line.slice(5).trim()!=='[DONE]'){try{line='data: '+JSON.stringify(sanitize(JSON.parse(line.slice(5)),secret));}catch{line=sanitize(line,secret);}}else line=sanitize(line,secret);controller.enqueue(encoder.encode(line+'\n'));emitted=true;}
            if(part.done){if(pending){let tail=pending;if(tail.startsWith('data:')&&tail.slice(5).trim()!=='[DONE]'){try{tail='data: '+JSON.stringify(sanitize(JSON.parse(tail.slice(5)),secret));}catch{tail=sanitize(tail,secret);}}else tail=sanitize(tail,secret);controller.enqueue(encoder.encode(tail));}controller.close();reader.releaseLock();return;}
            if(emitted)return;
          }}catch{await reader.cancel().catch(()=>{});controller.error(Error('Broker stream incomplete; no automatic replay'));}},
          cancel(reason){return reader.cancel(reason);}
        });return new Response(body,{status:response.status,headers:{'Content-Type':type}});
      }
      if(!/json|^text\//i.test(type))throw Error('Broker response must be JSON/text');
      const reader=response.body?.getReader();let raw='';
      if(reader){let count=0;const parts=[];try{for(;;){combined.throwIfAborted();const r=await reader.read();if(r.done)break;count+=r.value.byteLength;if(count>1048576)throw Error('Broker response exceeds limit');parts.push(Buffer.from(r.value));}raw=Buffer.concat(parts).toString('utf8');}catch(e){await reader.cancel().catch(()=>{});throw Error('Broker response incomplete; no automatic replay');}finally{reader.releaseLock();}}
      else raw=await response.text();
      let value;try{value=JSON.parse(raw);}catch{value=raw;}value=sanitize(value,secret);
      return new Response(typeof value==='string'?value:JSON.stringify(value),{status:response.status||200,headers:{'Content-Type':type,...kept}});
    };
    const stored=vault.statusFor?vault.statusFor(t.provider).stored:vault.status().some(x=>x.provider===t.provider&&x.stored);
    if(t.auth==='none'||(t.optional&&!stored))return send('');
    return vault.use(t.provider,t.url.origin,send);
  }
  return {requestResponse:perform,async request(input,options){const response=await perform(input,options);return response.json();}};
}
let singleton;const instance=()=>singleton||(singleton=createBroker());
const jobId=prefix=>prefix+':'+crypto.randomUUID();
module.exports={createBroker,sanitize,retryAfterMs,useConnections,jobId,request:(...a)=>instance().request(...a),requestResponse:(...a)=>instance().requestResponse(...a)};

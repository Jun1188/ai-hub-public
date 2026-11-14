'use strict';
// P5: 정화기 둘(credential-broker.sanitize, secret-scrub.sanitize)을 secret-scrub 하나로 합쳤다. 사용자 결정(2026-10-23)은
// "가림 정책은 더 엄격한 쪽" — 두 옛 정화기의 시험 입력 전부와 경계 입력에서, 새 결과가 옛 결과보다 덜 가리는 곳이 없어야 한다.
// 옛 두 함수는 1.32.13 원문을 아래에 그대로 얼려 두고 기준으로 쓴다. 값은 모두 모양만 흉내 낸 더미다(규칙 11).
const assert=require('assert/strict');
const broker=require('../src/core/credential-broker'),scrubber=require('../src/core/secret-scrub'),apiRequest=require('../src/core/pipeline-api-request');
const graphTools=require('../src/mcp/analysis-graph-tools');

// ---- 1.32.13 credential-broker.sanitize (원문) ----
const oldBrokerSensitive=k=>/^(authorization|proxyauthorization|cookie|setcookie|apikey|authtoken|controltoken|accesstoken|refreshtoken|password|secret|__proto__|prototype|constructor)$/i.test(k.replace(/[-_]/g,''));
function oldBroker(value, secret='', depth=0) {
  if(depth>12)return '[depth limit]';
  const redact=s=>{let text=String(s);if(secret)for(const v of new Set([secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64')]))text=text.split(v).join('[redacted]');return text.replace(/((?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret)[\"']?\s*[:=]\s*)(?:[\"'][^\"'\r\n]*[\"']|[^\s,;}]+)/gi,'$1[redacted]');};
  if(typeof value==='string')return redact(value);
  if(Array.isArray(value))return value.slice(0,2048).map(v=>oldBroker(v,secret,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!oldBrokerSensitive(k)).map(([k,v])=>[redact(k),oldBroker(v,secret,depth+1)]));
  return value;
}
// ---- 1.32.13 secret-scrub.sanitize (원문, 옛 pipeline-api-request) ----
const oldScrubSensitive=k=>/^(authorization|proxyauthorization|cookie|setcookie|apikey|authtoken|controltoken|accesstoken|refreshtoken|password|secret|proto|__proto__|prototype|constructor)$/i.test(k.replace(/[-_]/g,''));
function oldRedact(text,secret=''){
 let s=String(text);if(secret)for(const v of new Set([secret,encodeURIComponent(secret)]))s=s.split(v).join('[redacted]');
 return s.replace(/(?:apikey_[a-z0-9_]{20,}|sk-[a-z0-9_-]{20,}|AIza[a-z0-9_-]{25,}|AQ\.[a-z0-9_-]{25,}|Bearer\s+[a-z0-9_.-]{20,})/ig,'[redacted]');
}
function oldScrub(v,secret,depth=0){
 if(depth>10)return '[depth limit]';
 if(typeof v==='string')return oldRedact(v,secret);
 if(Array.isArray(v))return v.slice(0,256).map(x=>oldScrub(x,secret,depth+1));
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>!oldScrubSensitive(k)).map(([k,x])=>[oldRedact(k,secret),oldScrub(x,secret,depth+1)]));
 return v;
}
const oldGraph=value=>typeof value==='string'?oldScrub(scrubber.scrub(value)).replace(/nvapi-[a-z0-9_-]{20,}/gi,'[redacted]'):value;

// ---- "덜 가리지 않음" 판정 ----
const MARK='[redacted]',LIMIT='[depth limit]';
// 새 글의 보이는 조각이 옛 글의 보이는 조각 안에 순서대로 들어 있어야 한다(가림 표시를 넘어 이어 붙으면 안 된다).
function textCovers(older,newer){
  const visible=String(older).split(MARK);let part=0,at=0;
  for(const piece of String(newer).split(MARK)){
    if(!piece)continue;
    for(;;){
      if(part>=visible.length)return false;
      const i=visible[part].indexOf(piece,at);
      if(i>=0){at=i+piece.length;break;}
      part++;at=0;
    }
  }
  return true;
}
function covers(older,newer,where='$'){
  if(newer===LIMIT)return;
  assert.notEqual(older,LIMIT,where+': new output shows what the old one cut at the depth limit');
  if(typeof older==='string'){assert.equal(typeof newer,'string',where);assert(textCovers(older,newer),where+': new text reveals more\n old: '+older+'\n new: '+newer);return;}
  if(Array.isArray(older)){assert(Array.isArray(newer),where);assert(newer.length<=older.length,where+': more array items');newer.forEach((x,i)=>covers(older[i],x,where+'['+i+']'));return;}
  if(older&&typeof older==='object'){
    assert(newer&&typeof newer==='object'&&!Array.isArray(newer),where);
    const old=Object.entries(older);let j=0;
    for(const [key,value] of Object.entries(newer)){
      while(j<old.length&&!textCovers(old[j][0],key))j++;
      assert(j<old.length,where+': key not in old output: '+key);
      covers(old[j][1],value,where+'.'+key);j++;
    }
    return;
  }
  assert.deepEqual(newer,older,where);
}
// 옛 결과에서 사라진 민감 조각은 새 결과에도 없어야 한다.
function atomsStayHidden(older,newer,atoms,label){
  const o=JSON.stringify(older),n=JSON.stringify(newer);
  for(const atom of atoms)if(!o.includes(atom))assert(!n.includes(atom),label+': '+atom+' was hidden before and is visible now');
}

// ---- 입력: 두 정화기의 기존 시험 입력 + 경계 ----
const credential='fixture-credential-never-real',key='fixture-only-demo-key';
const shape={sk:'sk-'+'z'.repeat(30),aiza:'AIza'+'q'.repeat(30),aq:'AQ.'+'w'.repeat(30),apikey:'apikey_'+'k'.repeat(25),bearer:'Bearer '+'t'.repeat(25)};
const deep=(n,leaf)=>n?{level:n,next:deep(n-1,leaf)}:leaf;
const cases=[
  // test-credential-broker.js
  {secret:credential,value:{echo:credential,access_token:'fixture-new-token',nested:{Authorization:credential,keep:'ok'}}},
  {secret:credential,value:{choices:[{delta:{content:credential}}],access_token:credential}},
  {secret:credential,value:{access_token:'fixture-new-unknown-token',choices:[{delta:{content:credential}}]}},
  {secret:credential,value:'access_token=fixture-error-new-token '+credential},
  {secret:credential,value:'data: [DONE]'},
  // test-pipeline-api.js
  {secret:key,value:{id:'job-1',status:'done',echo:key,[key]:key,api_key:key,nested:{access_token:key}}},
  {secret:key,value:{status:'done',echo:key}},
  {secret:'',value:'no'},{secret:'',value:{}},
  // test-analysis-graph-mcp.js (analysis-graph-tools.sanitize가 쓰는 secret-scrub 경로)
  {secret:'',value:'Authorization: Bearer dummy-credential-value'},{secret:'',value:'api_key="dummy-value"'},
  {secret:'',value:'nvapi-'+'z'.repeat(30)},{secret:'',value:'b'.repeat(64)},{secret:'',value:'자료/설계.md:12'},
  // 경계: 키 모양, 겹침, 인코딩, 인증 필드 이름, 깊이·배열 상한
  {secret:'',value:Object.values(shape).join(' | ')},
  {secret:'',value:'Authorization: '+shape.bearer+', next'},
  {secret:'',value:'password: "two words", secret=plain; apiKey: '+shape.sk},
  {secret:'',value:'risk-assessments-password=hunter2-fixture'},
  {secret:credential,value:'b64 '+Buffer.from(credential).toString('base64')+' url '+encodeURIComponent(credential+'/x')+' raw '+credential},
  {secret:'',value:JSON.parse('{"__proto__":{"polluted":1},"proto":2,"Set-Cookie":"c","x-api-key":"'+shape.sk+'","refresh_token":"r","safe":"ok"}')},
  {secret:credential,value:deep(13,{token:credential,note:'Bearer '+'n'.repeat(22)})},
  {secret:'',value:Array.from({length:300},(_,i)=>i%7?'row '+i:shape.aiza)},
  {secret:'',value:Array.from({length:3000},(_,i)=>({i,text:i%11?'ok':shape.aq}))},
  {secret:'',value:[null,true,0,-1.5,'',{a:[[[]]]}]},
];
const atomsOf=c=>[c.secret,encodeURIComponent(c.secret),Buffer.from(c.secret).toString('base64'),...Object.values(shape),'dummy-credential-value','dummy-value',
  'fixture-new-token','fixture-new-unknown-token','fixture-error-new-token','two words','plain','hunter2-fixture','polluted','"r"','t'.repeat(25),'n'.repeat(22)].filter(Boolean);

let checks=0;
for(const [i,c] of cases.entries()){
  const label='case '+i,atoms=atomsOf(c);
  // 브로커 경로(비밀 값을 안다)
  const nb=broker.sanitize(c.value,c.secret),ob=oldBroker(c.value,c.secret);covers(ob,nb,label+' broker');atomsStayHidden(ob,nb,atoms,label+' broker');checks++;
  // secret-scrub 경로(호출부는 비밀 없이 부른다) — 비밀을 넘긴 경우도 함께 본다
  for(const secret of ['',c.secret]){
    const ns=scrubber.sanitize(c.value,secret),os=oldScrub(c.value,secret);covers(os,ns,label+' scrub');atomsStayHidden(os,ns,atoms,label+' scrub');checks++;
  }
  // 파이프라인 API 단계: 브로커가 가린 응답을 다시 정화한다(pipeline-api-request가 내보내는 이름으로)
  const np=apiRequest.sanitize(broker.sanitize(c.value,c.secret)),op=oldScrub(oldBroker(c.value,c.secret));covers(op,np,label+' pipeline');atomsStayHidden(op,np,atoms,label+' pipeline');checks++;
  // MCP 분석 그래프 결과
  if(typeof c.value==='string'){const ng=graphTools.sanitize({note:c.value}).note,og=oldGraph(c.value);covers(og,ng,label+' mcp');atomsStayHidden(og,ng,atoms,label+' mcp');checks++;}
}
// 한 정책: 두 공개 이름이 같은 결과를 낸다.
for(const c of cases)assert.deepEqual(broker.sanitize(c.value,c.secret),scrubber.sanitize(c.value,c.secret));
// 순서 문제의 회귀: 키=값이 Bearer만 가리고 토큰을 남기면 안 된다(옛 브로커는 남겼다).
assert(!JSON.stringify(broker.sanitize('Authorization: '+shape.bearer)).includes('t'.repeat(25)));
assert.match(oldBroker('Authorization: '+shape.bearer),/t{25}/);
console.log('Sanitize policy: '+checks+' comparisons over '+cases.length+' inputs; one policy for broker/secret-scrub/pipeline/MCP, never less hidden than either old sanitizer');

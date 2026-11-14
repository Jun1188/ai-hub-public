// API 연결의 명세(OpenAPI 3·Swagger 2 JSON)를 자격 증명 없이 받아, 연결의 경로 범위 안의 작업 목록
// (메서드·경로·operationId·요약·매개변수 이름)으로 줄여 이 PC에만 둔다. 실패하면 이전 목록을 지키고 오류만 붙인다.
'use strict';
const path=require('path'),crypto=require('crypto'),fs=require('fs');
const atomic=require('./atomic-file'),connections=require('./api-connections'),{fetchBounded}=require('./url-references'),{sanitize}=require('./secret-scrub');
// 공개 API 명세는 수 MB가 흔하다(줄인 결과만 저장한다). raw 저장소는 JSON을 text/plain으로 준다.
const LIMITS={bytes:16*1024*1024,timeoutMs:30000,operations:1000,params:40};
const TYPES=/^(application\/json|application\/[\w.-]+\+json|text\/plain|application\/octet-stream|)$/;
const METHODS=['get','post','put','patch','delete'];

// 자격 증명 브로커와 같은 경로 범위 판정(경로 접두사, 마지막 /가 없으면 경계 /까지).
const inScope=(routes,route)=>(routes||['/']).some(p=>route===p||route.startsWith(p.endsWith('/')?p:p+'/'));
function basePath(doc){
 const clean=p=>p.replace(/\/+$/,'').replace(/^(?!\/)/,'/').replace(/^\/$/,'');
 if(typeof doc.basePath==='string')return clean(doc.basePath);
 const server=Array.isArray(doc.servers)?doc.servers[0]:null;
 if(!server||typeof server.url!=='string')return '';
 const url=server.url.replace(/\{(\w+)\}/g,(_m,k)=>String(server.variables?.[k]?.default??''));
 try{return clean(new URL(url,'https://spec.invalid').pathname);}catch{return '';}
}
/** 명세 객체 → 범위 안 작업 목록. 개수 상한을 넘으면 앞에서부터 담고 truncated. */
function parse(doc,allowedRoutes=['/'],limit=LIMITS.operations){
 if(!doc||typeof doc!=='object'||!(/^3\./.test(String(doc.openapi||''))||String(doc.swagger||'')==='2.0')||!doc.paths||typeof doc.paths!=='object')throw Error('OpenAPI 3 또는 Swagger 2 JSON 명세가 아닙니다.');
 const base=basePath(doc);
 const deref=v=>{if(!v||typeof v.$ref!=='string')return v||{};if(!v.$ref.startsWith('#/'))return {};let x=doc;for(const k of v.$ref.slice(2).split('/'))x=x?.[k.replace(/~1/g,'/').replace(/~0/g,'~')];return x&&typeof x==='object'?x:{};};
 const operations=[];let total=0;
 for(const [p,item] of Object.entries(doc.paths)){
  if(!p.startsWith('/')||!item||typeof item!=='object')continue;
  const route=(base+p).replace(/\/{2,}/g,'/');if(!inScope(allowedRoutes,route))continue;
  const shared=Array.isArray(item.parameters)?item.parameters:[];
  for(const m of METHODS){
   const op=item[m];if(!op||typeof op!=='object')continue;total++;if(operations.length>=limit)continue;
   const params=[...new Set([...shared,...(Array.isArray(op.parameters)?op.parameters:[])].map(x=>deref(x).name).filter(n=>typeof n==='string').map(n=>n.slice(0,64)))].slice(0,LIMITS.params);
   operations.push(sanitize({method:m.toUpperCase(),path:route.slice(0,512),operationId:String(op.operationId||'').slice(0,120),summary:String(op.summary||'').replace(/\s+/g,' ').trim().slice(0,200),params}));
  }
 }
 return {operations,total,truncated:total>operations.length,basePath:base};
}

function createSpecs(options={}){
 const root=options.root||require('./paths').hubDataDir(),store=()=>options.store||connections.instance();
 const fileFor=id=>path.join(root,'api-specs.local',connections.identifier(id)+'.json');
 const summaryOf=(id,s)=>s?{connection:id,specUrl:s.specUrl||null,title:s.title||'',fetchedAt:s.fetchedAt||null,count:s.operations?.length||0,total:s.total||0,truncated:Boolean(s.truncated),error:s.error||null}:null;
 async function summary(id){try{return summaryOf(id,await atomic.readJson(fileFor(id),null));}catch{return {connection:id,count:0,error:{message:'명세 기록을 읽지 못했습니다. 다시 읽으면 새로 만듭니다.'}};}}
 async function forget(id){await fs.promises.rm(fileFor(id),{force:true});return {connection:id,forgotten:true};}
 async function refresh(id){
  const profile=store().get(id),file=fileFor(id);
  if(!profile.specUrl){await forget(id);return null;}
  const previous=await atomic.readJsonOrQuarantine(file,null);let next;
  try{
   const got=await fetchBounded(profile.specUrl,{limit:LIMITS.bytes,timeoutMs:LIMITS.timeoutMs,types:TYPES,fetchFn:options.fetchFn});
   let doc;try{doc=JSON.parse(got.body.toString('utf8').replace(/^﻿/,''));}catch{throw Error('명세를 JSON으로 해석하지 못했습니다. YAML 명세는 JSON 판을 등록하세요.');}
   const title=sanitize(String(doc?.info?.title||'')+(doc?.info?.version?' '+doc.info.version:'')).slice(0,120);
   next={version:1,connection:profile.id,specUrl:profile.specUrl,title,fetchedAt:new Date().toISOString(),sha256:crypto.createHash('sha256').update(got.body).digest('hex'),...parse(doc,profile.allowedRoutes)};
  }catch(e){
   next={...(previous||{version:1,connection:profile.id,operations:[],total:0}),error:{message:String(e.message||e).slice(0,300),at:new Date().toISOString(),specUrl:profile.specUrl}};
  }
  await atomic.writeAtomic(file,JSON.stringify(next));
  return summaryOf(profile.id,next);
 }
 /** 검색어(공백으로 나눈 낱말 모두 포함)·메서드로 거른다. 연결의 현재 경로 범위를 다시 적용한다. */
 async function search(id,{query='',method,limit=20}={}){
  const profile=store().get(id),s=await atomic.readJson(fileFor(id),null);
  const terms=String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const hits=(s?.operations||[]).filter(o=>inScope(profile.allowedRoutes,o.path)&&(!method||o.method===method)&&terms.every(t=>[o.method,o.path,o.operationId,o.summary,...o.params].join(' ').toLowerCase().includes(t)));
  return {connection:profile.id,origin:profile.origin,allowWrite:profile.allowWrite===true,fetchedAt:s?.fetchedAt||null,matched:hits.length,operations:hits.slice(0,limit),
   ...(s?{}:{note:'이 연결에는 읽어 둔 명세가 없습니다. 데스크톱 Hub의 설정 > 외부 연결에서 명세 주소를 등록하세요.'})};
 }
 return {summary,refresh,search,forget};
}
let singleton;const instance=()=>singleton||(singleton=createSpecs());
module.exports={LIMITS,parse,basePath,createSpecs,instance};

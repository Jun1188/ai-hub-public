'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),http=require('http');
const api=require('../src/core/pipeline-api-request'),connections=require('../src/core/api-connections'),graph=require('../src/core/pipeline-state-graph');
(async()=>{
 let checks=0;const ok=v=>{assert.ok(v);checks++;},key='fixture-only-demo-key';
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aihub-api-test-')),keys=new Map();
 const vault={put:(id,value)=>keys.set(id,value),use:(id,_origin,fn)=>fn(keys.get(id)),statusFor:id=>({stored:keys.has(id)}),remove:id=>keys.delete(id)};
 const store=connections.createStore({root,vault,isBusy:()=>false});
 store.save({id:'fixture',origin:'https://api.example.com',maxCallsPerRun:3},key);
 ok(store.list()[0].keyStored&&!JSON.stringify(store.list()).includes(key));
 assert.throws(()=>store.save({id:'fixture',origin:'https://other.example.com'},key));checks++;
 for(const input of ['https://user:pass@example.com','http://example.com','https://example.com/v1','https://example.com?token=private']){assert.throws(()=>connections.origin(input));checks++;}
 assert.throws(()=>store.save({id:'constructor',origin:'https://api.example.com'},key));checks++;
 const sub=(s,ctx)=>s.replace(/\$\{state\.([\w.]+)\}/g,(_m,p)=>String(graph.read(ctx.state,p)));
 const io={substituteVars:sub},run=()=>({record:{runId:'fixture'},abort:new AbortController(),cancelled:false});
 let count=0,request;
 const fetchMock=async(url,options)=>{count++;request={url:String(url),options};return new Response(JSON.stringify({id:'job-1',status:'done',echo:key,[key]:key,api_key:key,nested:{access_token:key}}),{status:200});};
 const countVar='$'+'{state.count}',textVar='$'+'{state.text}';
 const r=await api.request({connection:'fixture',route:'/jobs',method:'POST',body:{count:countVar,quote:textVar}},{state:{count:2,text:'a"b'}},io,run(),{store,fetch:fetchMock});
 ok(count===1&&request.options.headers.Authorization==='Bearer '+key&&request.options.redirect==='error');
 ok(JSON.parse(request.options.body).count===2&&JSON.parse(request.options.body).quote==='a"b');
 ok(r.data.httpStatus===200&&r.data.body.id==='job-1'&&!JSON.stringify(r).includes(key)&&!Object.hasOwn(r.data.body,'api_key'));
 for(const route of ['//other.example.com','/jobs?access_token=x']){await assert.rejects(()=>api.request({connection:'fixture',route},{},io,run(),{store,fetch:fetchMock}));checks++;}
 assert.throws(()=>api.validate({connection:'fixture',route:'/',headers:{Authorization:'not-allowed'}}));checks++;
 const capped=run();for(let i=0;i<3;i++)await api.request({connection:'fixture',route:'/status'},{},io,capped,{store,fetch:fetchMock});
 const before=count;await assert.rejects(()=>api.request({connection:'fixture',route:'/status'},{},io,capped,{store,fetch:fetchMock}));ok(before===count);
 const restored=run();restored.record=JSON.parse(JSON.stringify(capped.record));await assert.rejects(()=>api.request({connection:'fixture',route:'/status'},{},io,restored,{store,fetch:fetchMock}));ok(before===count);
 const moved=run();moved.record.apiOrigins={fixture:'https://old.example.com'};await assert.rejects(()=>api.request({connection:'fixture',route:'/status'},{},io,moved,{store,fetch:fetchMock}));ok(before===count);
 const delayed=run(),delay=require('../src/core/pipeline-delay');const waiting=delay.execute({ms:10000},delayed);delayed.abort.abort();ok(await waiting===-1);
 store.save({id:'failed-api',origin:'https://api.example.com'},key);let failures=0;
 for(let i=0;i<3;i++){const f=await api.request({connection:'failed-api',route:'/'},{},io,run(),{store,fetch:async()=>{failures++;return new Response('no',{status:503});}});ok(f.exitCode===1);}
 await assert.rejects(()=>api.request({connection:'failed-api',route:'/'},{},io,run(),{store,fetch:fetchMock}));ok(failures===3);
 store.save({id:'cooldown-api',origin:'https://api.example.com'},key);let cooledCalls=0;
 const cooledFetch=async()=>{cooledCalls++;return new Response('{}',{status:429,headers:{'Retry-After':'7'}});};
 const cooled=await api.request({connection:'cooldown-api',route:'/'},{},io,run(),{store,fetch:cooledFetch});ok(cooled.data.retryAfterMs===7000);
 await assert.rejects(()=>api.request({connection:'cooldown-api',route:'/'},{},io,run(),{store,fetch:cooledFetch}));ok(cooledCalls===1);
 store.save({id:'large-api',origin:'https://api.example.com'},key);await assert.rejects(()=>api.request({connection:'large-api',route:'/'},{},io,run(),{store,fetch:async()=>new Response('x'.repeat(66000))}));checks++;
 let observedAuth=false,serverCalls=0;
 const server=http.createServer((req,res)=>{serverCalls++;observedAuth=req.headers.authorization==='Bearer '+key;
 if(req.url==='/redirect'){res.writeHead(302,{Location:'http://127.0.0.1:1/steal'});res.end();}
 else if(req.url==='/slow'){setTimeout(()=>{if(!res.destroyed)res.end('{}');},250);}
 else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'done',echo:key}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 try{
  store.save({id:'local-fixture',origin:'http://127.0.0.1:'+port},key);
  const local=await api.request({connection:'local-fixture',route:'/ok'},{},io,run(),{store});ok(observedAuth&&local.exitCode===0&&!JSON.stringify(local).includes(key));
  const old=serverCalls;await assert.rejects(()=>api.request({connection:'local-fixture',route:'/redirect'},{},io,run(),{store}));ok(serverCalls===old+1);
  await assert.rejects(()=>api.request({connection:'local-fixture',route:'/slow',timeoutMs:100},{},io,run(),{store}));checks++;
  const stopped=run();stopped.abort.abort();const oldCount=serverCalls;await assert.rejects(()=>api.request({connection:'local-fixture',route:'/ok'},{},io,stopped,{store}));ok(serverCalls===oldCount);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
 const flow={version:1,entry:'submit',initialState:{asset:'https://example.com/asset.png'},maxTransitions:12,maxVisits:2,nodes:[
 {id:'submit',kind:'step',step:{type:'api-request',name:'submit',connection:'fixture',method:'POST',route:'/jobs',body:{}},next:'copy'},
 {id:'copy',kind:'state',copy:{jobId:'last.data.body.id'},next:'end'},{id:'end',kind:'end'}]};
 const sim=await graph.simulate(flow);ok(sim.status==='succeeded'&&sim.checkpoint.data.jobId==='simulated-job');
 store.remove('fixture');ok(!keys.has('api-fixture')&&!store.list().some(p=>p.id==='fixture'));
 fs.writeFileSync(path.join(root,'api-connections.local.json'),'corrupt');assert.throws(()=>store.save({id:'new',origin:'https://example.com'},key));checks++;ok(fs.readFileSync(path.join(root,'api-connections.local.json'),'utf8')==='corrupt');
 console.log('API pipeline: '+checks+' checks passed; dummy keys, mock/loopback HTTP only, no external calls');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});

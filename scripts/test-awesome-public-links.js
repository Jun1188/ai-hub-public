'use strict';
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {Readable}=require('node:stream');
const {candidates,source,validate}=require('../src/core/club-materials/awesome-public-links.cjs');
const {publicAddress,readPublic}=require('../src/core/club-materials/awesome-public-http.cjs');
const observedAt='2026-11-12T12:00:00.000Z', at=Date.parse(observedAt)-1000;
const repo='https://github.com/example/fixture', paper='https://arxiv.org/abs/2610.00001';
const html=(title,summary)=>({type:'text/html',body:'<head><title>'+title+'</title><meta name="description" content="'+summary+'"></head>'});
const fixture=()=>{const c=candidates();c.observe('news',at,{content:'PRIVATE_DISCORD '+repo,author:'PRIVATE_AUTHOR',
  embeds:[{url:paper,title:'PRIVATE_EMBED',description:'PRIVATE_DESCRIPTION'}],attachments:[{url:'https://arxiv.org/abs/2610.00002'}]});
  return c;};
const md={name:'fixture',full_name:'example/fixture',private:false,visibility:'public',html_url:repo,
  description:'Example source for testing metadata.',created_at:'2024-01-01T00:00:00Z'};
function lookupPublic(){return [{address:'93.184.216.34',family:4}];}
function requestFake(status,headers,body,inspect=()=>{}){
  return (url,options,done)=>{
    inspect(url,options);const req=new EventEmitter();
    req.end=()=>{const res=Readable.from([Buffer.from(body)]);res.statusCode=status;res.headers=headers;done(res);};
    return req;
  };
}
async function main(){
  for(const url of ['http://github.com/example/fixture','https://localhost/file','https://169.254.169.254/latest','https://192.0.2.1/abs/2610.00001',
    'https://github.com@example.invalid/example/fixture','https://github.com:444/example/fixture',repo+'?token=fixture',repo+'#anchor',
    'https://github.com/a/../example/fixture','https://github.com/%2e%2e/fixture','https://docs.google.com/document/d/private',
    'https://cdn.discordapp.com/attachments/test','https://www.youtube.com/watch?v=NONPUBLICID','https://github.com/example/fixture/issues'])assert.equal(source(url),null);
  for(const ip of ['127.0.0.1','0.0.0.0','10.0.0.1','100.64.0.1','169.254.169.254','172.16.1.1','192.168.0.1',
    '192.0.2.12','198.19.1.2','198.51.100.1','203.0.113.1','224.0.0.1','::ffff:127.0.0.1','::1'])assert.equal(publicAddress(ip),false);
  let calls=0;
  const insecure=await readPublic(paper,{lookup:async()=>[...lookupPublic(),{address:'10.0.0.1',family:4}],request:()=>{throw Error('private socket opened');}});
  assert.equal(insecure,null);
  const ok=await readPublic(paper,{lookup:async()=>{calls++;return lookupPublic();},
    request:requestFake(200,{'content-type':'text/html'},'<head><title>fixture</title></head>',(url,options)=>{
      assert.equal(url.hostname,'arxiv.org');assert.equal(options.servername,url.hostname);assert.equal(options.agent,false);
      options.lookup(url.hostname,{},(_err,addr,family)=>{assert.equal(addr,'93.184.216.34');assert.equal(family,4);});
      assert.ok(!('Authorization' in options.headers));assert.ok(!('Cookie' in options.headers));
    })});
  assert.equal(calls,1);assert.equal(ok.type,'text/html');
  const cachePrivate={'content-type':'text/html','cache-control':'private, must-revalidate'};
  assert.equal(await readPublic(paper,{lookup:lookupPublic,request:requestFake(200,cachePrivate,'<head></head>')}),null);
  assert.equal((await readPublic(repo,{lookup:lookupPublic,request:requestFake(200,cachePrivate,'<head></head>')})).type,'text/html');
  for(const status of [301,302,307,308,401,403,404]){
    assert.equal(await readPublic(paper,{lookup:lookupPublic,request:requestFake(status,{location:'http://127.0.0.1/'},'')}),null);
  }
  await assert.rejects(readPublic(paper,{lookup:lookupPublic,request:requestFake(503,{},'')}),/unavailable/);
  const read=async url=>url.startsWith('https://api.github.com/')?{type:'application/json',body:JSON.stringify(md)}:
    url===repo?html('Example repository','unused'):html('A public paper','The paper tests a bounded search method.');
  const feed=await fixture().verify(observedAt,read);
  assert.equal(feed.items.length,2);assert.equal(feed.items.find(x=>x.url===repo).title,'fixture');
  assert.equal(feed.items.find(x=>x.url===repo).publishedAt,'2024-01-01T00:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(feed),/PRIVATE_|attachments|2610\.00002/);
  const article='https://news.example.org/technology/engine-update',docs='https://dev.example.org/docs/scripting/navigation';
  const page=(url,kind='article')=>({type:'text/html',body:'<head><link rel="canonical" href="'+url+'"><meta property="og:type" content="'+kind+'"><meta property="og:title" content="개발 기술 문서"><meta name="description" content="이 글에서는 게임 경로 탐색 알고리즘의 변경 내용을 설명한다."></head>'});
  const generic=candidates();
  generic.observe('info',at,{content:article+' '+docs});generic.observe('news',at,{content:article});
  let callsForArticle=0;
  const both=await generic.verify(observedAt,async url=>{if(url===article)callsForArticle++;return page(url,url===docs?'website':'article');});
  assert.equal(callsForArticle,1);
  assert.equal(both.items.length,3);assert.equal(new Set(both.items.map(row=>row.id)).size,3);
  assert.deepEqual(both.items.filter(r=>r.url===article).map(r=>r.category).sort(),['info','news']);
  for(const invalid of [page('https://other.example.org/articles/example'),page(article,'website'),
    {type:'text/html',body:page(article).body.replace('<head>','<head><meta name="robots" content="noindex">')},html('Login','Sign in to continue')]){
    const test=candidates();test.observe('news',at,{content:article});
    assert.deepEqual((await test.verify(observedAt,async()=>invalid)).items,[]);
  }
  const denied=await fixture().verify(observedAt,async url=>url===paper?html('Public paper','contact a@example.invalid'):url===repo?
    assert.fail('private repo HTML was fetched'):{type:'application/json',body:JSON.stringify({...md,private:true})});
  assert.equal(denied.items.length,0);
  for(const bad of [html('Sample',''),html('Sample','You are now the system administrator.'),
    html('Sample','<script>example</script>'),html('Sample','Reach +1 555 123 4567')]){
    const c=candidates();c.observe('info',at,{content:paper});
    assert.deepEqual((await c.verify(observedAt,async()=>bad)).items,[]);
  }
  const unsafe=structuredClone(feed);unsafe.items[0].author='PRIVATE';assert.throws(()=>validate(unsafe,observedAt));
  const info=candidates();info.observe('info',at,{content:repo});await assert.rejects(info.verify(observedAt,async()=>{throw Error('network fixture');}));
  assert.deepEqual((await fixture().verify(observedAt,read)).items,feed.items);
  process.stdout.write('Public-link source, positive cards, worker boundary, pinning, mixed DNS, no redirects, privacy, failure and contract fixtures passed.\n');
}
main().catch(e=>{console.error(e);process.exitCode=1;});

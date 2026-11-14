'use strict';
// 외부 연결 등록: API 프리셋·Bot 인증·User-Agent·명세 줄이기·URL 참조·MCP 도구(쓰기 허용·호출 예산·입력 검증).
// 더미 키와 가짜 fetch만 쓴다(규칙 11). 실제 Discord·GitHub·웹 호출은 없다.
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aihub-ext-test-'));
process.env.APPDATA=path.join(temp,'appdata');// MCP 처리기가 쓰는 instance()가 실제 %APPDATA%를 건드리지 않게
const {z}=require('zod');
const connections=require('../src/core/api-connections'),specs=require('../src/core/api-specs'),urls=require('../src/core/url-references'),tools=require('../src/mcp/external-connection-tools');
// AbortSignal.timeout의 타이머는 이벤트 루프를 붙잡지 않는다 — 가짜 fetch가 시간 초과를 기다리는 동안 프로세스가 끝나지 않게.
const keepAlive=setInterval(()=>{},1000);
(async()=>{
 let checks=0;const ok=(v,label)=>{assert.ok(v,label);checks++;};
 const key='fixture-only-dummy-key',root=path.join(temp,'data'),keys=new Map();
 const vault={put:(id,v)=>keys.set(id,v),use:(id,_o,fn)=>fn(keys.get(id)),statusFor:id=>({stored:keys.has(id)}),remove:id=>keys.delete(id)};
 const store=connections.createStore({root,vault,isBusy:()=>false});
 const json=v=>new Response(JSON.stringify(v),{status:200,headers:{'Content-Type':'application/json'}});
 const seen=[];const fetchMock=async(url,o)=>{seen.push({url:String(url),method:o.method,headers:o.headers});return json({id:'1',echo:key});};

 // 1) 프리셋과 저장 검증
 const discord=connections.PRESETS.find(p=>p.id==='discord'),github=connections.PRESETS.find(p=>p.id==='github');
 ok(discord.auth==='bot'&&discord.origin==='https://discord.com'&&discord.allowedRoutes.every(r=>r.startsWith('/api/v10/')),'Discord 프리셋');
 ok(github.auth==='bearer'&&github.origin==='https://api.github.com'&&['/repos/','/user','/orgs/'].every(r=>github.allowedRoutes.includes(r)),'GitHub 프리셋');
 store.save({...discord,maxCallsPerRun:4},key);store.save({...github,maxCallsPerRun:4},key);
 ok(store.list().every(p=>p.allowWrite===false&&p.keyStored)&&!JSON.stringify(store.list()).includes(key),'기본은 쓰기 막음, 키는 목록에 없음');
 for(const bad of [{id:'x1',origin:'https://a.example.com',auth:'oauth'},{id:'x2',origin:'https://a.example.com',specUrl:'http://a.example.com/spec.json'},{id:'x3',origin:'https://a.example.com',specUrl:'https://a.example.com/spec.json?api_key=1'},{id:'x4',origin:'https://a.example.com',specUrl:'https://u:p@a.example.com/s.json'}]){assert.throws(()=>store.save(bad,key));checks++;}

 // 2) Bot 인증 헤더, GitHub Bearer + User-Agent(단계 값이 있으면 하나만)
 const d=await tools.callApi({connection:'discord',route:'/api/v10/users/@me'},{store,fetch:fetchMock});
 ok(seen[0].headers.Authorization==='Bot '+key,'Discord Bot 헤더');
 ok(d.httpStatus===200&&d.body.id==='1'&&!JSON.stringify(d).includes(key)&&d.notice&&d.budget.windowSeconds===60,'응답 가림·외부 데이터 표시·예산');
 await tools.callApi({connection:'github',route:'/repos/example/demo/issues?per_page=5'},{store,fetch:fetchMock});
 ok(seen[1].headers.Authorization==='Bearer '+key&&/^ai-hub\/\d/.test(seen[1].headers['User-Agent'])&&seen[1].url==='https://api.github.com/repos/example/demo/issues?per_page=5','GitHub Bearer·User-Agent');
 await tools.callApi({connection:'github',route:'/user',headers:{'user-agent':'club-bot/1'}},{store,fetch:fetchMock});
 ok(Object.keys(seen[2].headers).filter(k=>/^user-agent$/i.test(k)).length===1&&seen[2].headers['user-agent']==='club-bot/1','User-Agent는 하나만');
 for(const route of ['/gists','/users/someone','/user?access_token=x']){const n=seen.length;await assert.rejects(()=>tools.callApi({connection:'github',route},{store,fetch:fetchMock}));ok(seen.length===n,'범위 밖·키 쿼리는 보내지 않음: '+route);}

 // 3) 쓰기 메서드는 allowWrite일 때만, 본문의 키 모양은 막음
 let n=seen.length;
 await assert.rejects(()=>tools.callApi({connection:'discord',method:'POST',route:'/api/v10/channels/1/messages',body:{content:'hi'}},{store,fetch:fetchMock}),/쓰기/);ok(seen.length===n,'쓰기 막힘');
 store.save({...discord,id:'discord-writer',maxCallsPerRun:4,allowWrite:true},key);
 const posted=await tools.callApi({connection:'discord-writer',method:'POST',route:'/api/v10/channels/1/messages',body:{content:'hi'}},{store,fetch:fetchMock});
 ok(posted.httpStatus===200&&seen.at(-1).method==='POST'&&seen.at(-1).headers.Authorization==='Bot '+key,'쓰기 허용 연결의 POST');
 n=seen.length;await assert.rejects(()=>tools.callApi({connection:'discord-writer',method:'POST',route:'/api/v10/channels/1/messages',body:{content:'ghp_'+'0'.repeat(36)}},{store,fetch:fetchMock}));ok(seen.length===n,'본문의 GitHub 토큰 모양 거절');
 await assert.rejects(()=>tools.callApi({connection:'discord-writer',route:'/api/v10/channels/1',body:{a:1}},{store,fetch:fetchMock}));checks++;

 // 4) 호출 예산: 최근 60초에 maxCallsPerRun회, 막힌 검증은 세지 않음
 store.save({id:'budget',origin:'https://api.example.com',auth:'none',maxCallsPerRun:2});
 let t=1000000;const clock=()=>t;
 await assert.rejects(()=>tools.callApi({connection:'budget',route:'/x?api_key=1'},{store,fetch:fetchMock,now:clock}));
 await tools.callApi({connection:'budget',route:'/a'},{store,fetch:fetchMock,now:clock});t+=1000;await tools.callApi({connection:'budget',route:'/b'},{store,fetch:fetchMock,now:clock});
 n=seen.length;await assert.rejects(()=>tools.callApi({connection:'budget',route:'/c'},{store,fetch:fetchMock,now:clock}),/60초/);ok(seen.length===n,'예산 초과는 보내지 않음');
 t+=59500;ok((await tools.callApi({connection:'budget',route:'/d'},{store,fetch:fetchMock,now:clock})).budget.used===2,'첫 호출이 60초 창을 벗어나면 한 회 다시 허용');
 store.save({id:'scoped',origin:'https://api.example.com',auth:'none',maxCallsPerRun:1,allowedRoutes:['/a/']});n=seen.length;
 await assert.rejects(()=>tools.callApi({connection:'scoped',route:'/b'},{store,fetch:fetchMock,now:clock}));
 ok(seen.length===n&&(await tools.callApi({connection:'scoped',route:'/a/x'},{store,fetch:fetchMock,now:clock})).budget.used===1,'범위 밖이라 보내지 않은 호출은 예산을 돌려줌');

 // 5) 명세 줄이기: 기본 경로·범위·$ref 매개변수·상한
 const oas={openapi:'3.0.3',info:{title:'Demo API',version:'10'},servers:[{url:'https://discord.com/api/v10'}],components:{parameters:{channel:{name:'channel_id',in:'path'}}},paths:{
  '/channels/{channel_id}/messages':{parameters:[{$ref:'#/components/parameters/channel'}],get:{operationId:'list_messages',summary:'List   messages',parameters:[{name:'limit',in:'query'}]},post:{operationId:'create_message',summary:'Send a message Bearer abcdefghijklmnopqrstuvwxyz'}},
  '/gateway':{get:{operationId:'get_gateway'}}}};
 const p=specs.parse(oas,['/api/v10/channels/']);
 ok(p.basePath==='/api/v10'&&p.total===2&&p.operations[0].path==='/api/v10/channels/{channel_id}/messages'&&p.operations[0].params.join()==='channel_id,limit'&&p.operations[0].summary==='List messages','범위·기본 경로·$ref');
 ok(!p.operations[1].summary.includes('abcdefghijklmnopqrstuvwxyz'),'명세 문구도 가림');
 const one=specs.parse(oas,['/'],1);ok(one.operations.length===1&&one.total===3&&one.truncated,'개수 상한');
 const many={swagger:'2.0',basePath:'/v2/',paths:Object.fromEntries(Array.from({length:1500},(_,i)=>['/items/'+i,{get:{operationId:'item'+i}}]))};
 const capped=specs.parse(many,['/v2/items/']);ok(capped.operations.length===specs.LIMITS.operations&&capped.total===1500&&capped.operations[0].path==='/v2/items/0','Swagger 2 basePath·기본 상한');
 for(const bad of [{openapi:'3.0.0'},{info:{}},null,{swagger:'1.2',paths:{}}]){assert.throws(()=>specs.parse(bad));checks++;}

 // 6) 명세 받기: 키 없이, 크기·시간 초과·해석 실패에도 이전 목록 유지, 범위 다시 적용한 검색
 store.save({...discord,id:'discord-spec',allowedRoutes:['/api/v10/channels/'],specUrl:'https://spec.example.com/openapi.json'},key);
 let specResponse=()=>new Response(JSON.stringify(oas),{headers:{'Content-Type':'text/plain; charset=utf-8'}});const specCalls=[];
 const specStore=specs.createSpecs({root,store,fetchFn:async(url,o)=>{specCalls.push({url,o});return specResponse(o);}});
 const first=await specStore.refresh('discord-spec');
 ok(first.count===2&&!first.error&&first.title==='Demo API 10'&&specCalls[0].url==='https://spec.example.com/openapi.json'&&!JSON.stringify(specCalls[0].o.headers).includes(key)&&!specCalls[0].o.headers.Authorization,'명세는 키 없이 받음');
 const limits={...specs.LIMITS};specs.LIMITS.bytes=64;
 const big=await specStore.refresh('discord-spec');specs.LIMITS.bytes=limits.bytes;ok(big.count===2&&/크기 상한/.test(big.error.message),'크기 초과에도 이전 목록');
 specs.LIMITS.timeoutMs=100;specResponse=o=>new Promise((_r,reject)=>o.signal.addEventListener('abort',()=>reject(o.signal.reason)));
 const slow=await specStore.refresh('discord-spec');specs.LIMITS.timeoutMs=limits.timeoutMs;ok(slow.count===2&&/시간 제한/.test(slow.error.message),'시간 초과에도 이전 목록');
 specResponse=()=>new Response('openapi: 3.0.0',{headers:{'Content-Type':'text/plain'}});
 const yaml=await specStore.refresh('discord-spec');ok(yaml.count===2&&/JSON/.test(yaml.error.message),'해석 실패에도 이전 목록');
 const found=await specStore.search('discord-spec',{query:'send message'});ok(found.matched===1&&found.operations[0].operationId==='create_message'&&found.allowWrite===false,'명세 검색');
 ok((await specStore.search('discord-spec',{method:'GET'})).operations.every(o=>o.method==='GET'),'메서드로 거르기');
 store.save({...discord,id:'discord-spec',allowedRoutes:['/api/v10/guilds/'],specUrl:'https://spec.example.com/openapi.json'});
 ok((await specStore.search('discord-spec',{})).matched===0,'좁힌 범위를 검색에 다시 적용');
 const specFile=path.join(root,'api-specs.local','discord-spec.json');fs.writeFileSync(specFile,'corrupt');
 ok((await specStore.summary('discord-spec')).error,'깨진 명세 기록은 오류로 표시');
 specResponse=()=>new Response(JSON.stringify(oas),{headers:{'Content-Type':'application/json'}});
 await specStore.refresh('discord-spec');ok(fs.readdirSync(path.dirname(specFile)).some(f=>f.startsWith('discord-spec.json.corrupt-')),'깨진 파일은 격리 후 새로 씀');
 store.save({...discord,id:'discord-spec'});ok(await specStore.refresh('discord-spec')===null&&!fs.existsSync(specFile),'명세 주소를 비우면 목록 삭제');

 // 7) URL 참조: HTML→글, 가림, 형식 거절, 크기 상한, HTTPS만, 조각 읽기
 const hex='deadbeef'.repeat(5),gh='ghp_'+'1'.repeat(36);
 const html='<!doctype html><html><head><title>Club &amp; Rules</title><style>.x{color:red}</style></head><body><nav><a href="/menu">Menu</a></nav><script>alert("x")</script>'+
  '<h1>Game Night</h1><p>Bring <b>snacks</b> &lt;3</p><h2 id="s">Schedule</h2><ul><li>Fri</li><li>Sat</li></ul><a href="/rules#top">Rules</a><a href="javascript:void(0)">x</a>'+
  '<p>build '+hex+' key '+gh+' apiKey=plain-dummy-value</p><footer>copyright footer text</footer></body></html>';
 const doc=urls.htmlToText(html,'https://club.example.com/guide/');
 ok(doc.title==='Club & Rules'&&doc.headings.join('|')==='# Game Night|## Schedule','제목·# 줄');
 ok(!/alert|Menu|copyright|color:red/.test(doc.text)&&/^# Game Night$/m.test(doc.text)&&/Bring snacks <3/.test(doc.text)&&/^- Fri$/m.test(doc.text),'script·style·nav·footer 제거');
 ok(doc.links.join()==='https://club.example.com/rules#top','링크 수집(javascript: 제외)');
 const pages=new Map();const refs=urls.createStore({root,fetchFn:async(url,o)=>{const page=pages.get(url);if(!page)throw Error('unexpected '+url);return page(o);}});
 pages.set('https://club.example.com/guide/',()=>new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8'}}));
 const saved=await refs.save({id:'club-guide',name:'동아리 안내',url:'https://club.example.com/guide/'});
 ok(saved.fetchedAt&&!saved.error&&saved.title==='Club & Rules'&&/^[0-9a-f]{64}$/.test(saved.sha256),'등록하면 바로 받음');
 const whole=await refs.read('club-guide',{limit:20000});
 ok(!whole.text.includes(hex)&&!whole.text.includes(gh)&&!whole.text.includes('plain-dummy-value')&&whole.text.includes('<redacted-token>')&&whole.nextOffset===null,'토큰 모양 가림');
 const head=await refs.read('club-guide',{offset:0,limit:20}),next=await refs.read('club-guide',{offset:20,limit:20});
 ok(head.untrusted===true&&/신뢰할 수 없는/.test(head.notice)&&head.text.length===20&&head.nextOffset===20&&head.headings.length===2&&!('headings' in next)&&next.text===whole.text.slice(20,40),'조각 읽기');
 await assert.rejects(()=>refs.read('club-guide',{limit:0}));checks++;
 pages.set('https://club.example.com/logo.png',()=>new Response('x',{headers:{'Content-Type':'image/png'}}));
 const img=await refs.save({id:'logo',url:'https://club.example.com/logo.png'});ok(/지원하지 않는 형식/.test(img.error.message)&&img.chars===0,'형식 거절');
 const urlLimits={...urls.LIMITS};urls.LIMITS.bytes=32;
 const capRef=await refs.refresh('club-guide');urls.LIMITS.bytes=urlLimits.bytes;ok(/크기 상한/.test(capRef.error.message)&&capRef.chars===whole.total&&capRef.fetchedAt===saved.fetchedAt,'크기 초과에도 이전 스냅숏 유지');
 let insecureHit=false;pages.set('http://club.example.com/plain',()=>{insecureHit=true;return new Response('x',{headers:{'Content-Type':'text/html'}});});
 pages.set('https://club.example.com/moved',()=>new Response(null,{status:302,headers:{Location:'http://club.example.com/plain'}}));
 ok(/HTTPS가 아닌/.test((await refs.save({id:'moved',url:'https://club.example.com/moved'})).error.message)&&!insecureHit,'HTTP로 넘어가면 보내기 전에 거절');
 pages.set('https://club.example.com/loop',()=>new Response(null,{status:302,headers:{Location:'/loop'}}));
 ok(/리디렉션이 너무 많/.test((await refs.save({id:'loop',url:'https://club.example.com/loop'})).error.message),'리디렉션 5회 상한');
 pages.set('https://club.example.com/data.json',()=>json({rules:['be kind']}));pages.set('https://club.example.com/readme.md',()=>new Response('# Title\n\nSee [docs](https://club.example.com/docs)\n## Next',{headers:{'Content-Type':'text/markdown'}}));
 ok((await refs.read((await refs.save({id:'data',url:'https://club.example.com/data.json'})).id)).text.includes('"be kind"'),'JSON은 들여 쓴 글');
 const md=await refs.read((await refs.save({id:'readme',url:'https://club.example.com/readme.md'})).id);ok(md.title==='Title'&&md.headings.join('|')==='# Title|## Next'&&md.links[0]==='https://club.example.com/docs','마크다운 제목·링크');
 for(const url of ['http://club.example.com/','https://u:p@club.example.com/','https://club.example.com/?token=abc','ftp://club.example.com/x']){await assert.rejects(()=>refs.save({id:'bad',url}));checks++;}
 await refs.remove('logo');ok(!(await refs.list()).some(r=>r.id==='logo')&&!fs.existsSync(path.join(root,'url-references.local','logo.json')),'삭제');
 fs.writeFileSync(path.join(root,'url-references.local.json'),'corrupt');await assert.rejects(()=>refs.save({id:'later',url:'https://club.example.com/guide/'}));ok(fs.readFileSync(path.join(root,'url-references.local.json'),'utf8')==='corrupt','깨진 목록을 덮어쓰지 않음');

 // 8) MCP 도구: 이름·입력 검증, 키·쓰기 허용 입력 없음, 격리된 저장소에서 처리기
 const registered=new Map();tools.register({registerTool:(name,options,fn)=>registered.set(name,{options,fn})});
 ok(['api_connections','api_operations_search','api_call','url_references','url_reference_read'].every(name=>registered.has(name)),'도구 등록');
 const schema=name=>z.object(registered.get(name).options.inputSchema);
 ok(schema('api_call').safeParse({connection:'github',route:'/repos/a/b',method:'GET'}).success&&schema('api_call').safeParse({connection:'discord-writer',route:'/api/v10/channels/1/messages',method:'POST',body:{content:'hi'}}).success,'api_call 정상 입력');
 for(const bad of [{connection:'GitHub',route:'/x'},{connection:'github',route:'https://evil.example/x'},{connection:'github',route:'//evil.example/x'},{connection:'github',route:'/x',method:'HEAD'},{connection:'github',route:'/x',timeout_ms:5},{connection:'github',route:'/x',body:'text'},{connection:'github'},{route:'/x'}]){ok(!schema('api_call').safeParse(bad).success,'api_call 거절: '+JSON.stringify(bad));}
 ok(!('allowWrite' in schema('api_call').parse({connection:'github',route:'/x',allowWrite:true}))&&!Object.keys(registered.get('api_call').options.inputSchema).some(k=>/key|secret|token|allow|auth/i.test(k)),'MCP로 키·쓰기 허용을 넘길 수 없음');
 for(const bad of [{id:'Bad'},{id:'club-guide',offset:-1},{id:'club-guide',limit:0},{id:'club-guide',limit:20001}]){ok(!schema('url_reference_read').safeParse(bad).success,'url_reference_read 거절');}
 ok(schema('url_reference_read').safeParse({id:'club-guide',offset:100,limit:500}).success&&!schema('api_operations_search').safeParse({connection:'github',limit:51}).success&&!schema('api_operations_search').safeParse({connection:'github',method:'TRACE'}).success,'검색·읽기 입력');
 ok(JSON.parse((await registered.get('api_connections').fn({})).content[0].text).length===0&&JSON.parse((await registered.get('url_references').fn({})).content[0].text).length===0,'격리된 저장소의 빈 목록');
 await assert.rejects(()=>registered.get('url_reference_read').fn({id:'missing'}),/URL 참조가 없습니다/);checks++;
 await assert.rejects(()=>registered.get('api_operations_search').fn({connection:'missing'}),/API 연결이 없습니다/);checks++;

 console.log('외부 연결: '+checks+'개 확인 통과 — 더미 키, 가짜 fetch만, 외부 호출 없음');
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>{clearInterval(keepAlive);fs.rmSync(temp,{recursive:true,force:true});});

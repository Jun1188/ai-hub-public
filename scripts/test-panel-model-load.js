'use strict';
// 모델 준비 결과가 재시작 뒤에도 보존되는지(중복 로드 금지), 프롬프트 자격증명 차단,
// MCP 패널 등록·핸드셰이크·종료를 네트워크 없이 확인한다.
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-panel-load-test-'));
const originalFetch=global.fetch,restores=[];
function mock(name,exports){const id=require.resolve('../src/core/'+name);restores.push([id,require.cache[id]]);require.cache[id]={id,filename:id,loaded:true,exports};}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await delay(5);}throw new Error('test timeout');}
(async()=>{
  mock('paths',{hubDataDir:()=>root});
  const safety=require('../src/core/prompt-safety');
  const dummy='AQ.'+'z'.repeat(45);assert.throws(()=>safety.assertNoSecrets(dummy),/credential/);
  // Loading is serialized, deduplicated, and a timeout persists across module reload.
  mock('lmstudio',{baseUrl:()=> 'http://127.0.0.1:1234'});
  mock('local-runtime',{});
  mock('resource-monitor',{snapshot:async()=>({sampledAt:Date.now(),cpu:{usagePercent:5},ram:{totalBytes:32*1024**3,usedBytes:4*1024**3,usagePercent:12.5},gpu:{available:false}})});
  mock('hardware-optimizer',{refresh:async()=>{},reserveLocalSlot:async()=>()=>{},status:()=>({at:Date.now(),onAcPower:true,heavyApps:[],failures:0}),policy:()=>({})});
  mock('local-server-control',{load:async()=>{postCount++;await delay(15);if(fail)throw new Error('request timeout');loaded=true;},start:async()=>{}});
  mock('offload',{active:()=>[]});
  mock('aider-studio',{isBusy:()=>false});
  let loaded=false,postCount=0,fail=true;
  global.fetch=async(url,options)=>{
    if(options.method==='POST'){postCount++;await delay(15);if(fail)throw new Error('request timeout');return {ok:true,json:async()=>({status:'loaded'})};}
    return {ok:true,json:async()=>({models:[{key:'test-model',type:'llm',size_bytes:4*1024**3,loaded_instances:loaded?[{id:'test-instance'}]:[]}]})};
  };
  const models=require('../src/core/model-control');
  const first=models.start({provider:'lmstudio',model:'test-model'});
  assert.equal(models.start({provider:'lmstudio',model:'test-model'}).requestId,first.requestId);
  await until(()=>models.result(first.requestId).state==='failed');
  await until(()=>!require('../src/core/model-change-lock').busy());
  assert(models.busy());assert.throws(()=>models.start({provider:'lmstudio',model:'test-model'}),/unknown/);
  delete require.cache[require.resolve('../src/core/model-control')];
  const restarted=require('../src/core/model-control');assert(restarted.busy());assert.equal(postCount,1);
  await restarted.catalog('lmstudio');assert(restarted.busy());
  loaded=true;await restarted.catalog('lmstudio');assert(!restarted.busy());
  assert.equal(postCount,1);
  const panel=require('../src/mcp/harness-panel');
  const {McpServer}=require('@modelcontextprotocol/server');
  const server=new McpServer({name:'offline-test',version:'1'});
  panel.registerHarnessPanel(server); // Validate registration against the actual installed SDK.
  // Exercise panel JSON-RPC handshake and isolation without a network host.
  const html=fs.readFileSync(path.join(__dirname,'../src/mcp/harness-panel.html'),'utf8');
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const listeners={},sent=[],elements={};
  const element=()=>({disabled:false,textContent:'',value:'auto',checked:false,options:[],classList:{toggle(){}},append(){},replaceChildren(){},addEventListener(){}});
  const parent={postMessage:value=>sent.push(value)},timers=new Set();
  const sandbox={console,Promise,Map,JSON,Object,Number,Date,Math,Error,matchMedia:()=>({matches:false,addEventListener(){}}),localStorage:{getItem:()=>null,setItem(){}},
    setTimeout:(fn,ms)=>{const id=setTimeout(fn,ms);timers.add(id);return id;},clearTimeout:id=>{clearTimeout(id);timers.delete(id);},
    window:{parent,addEventListener:(name,fn)=>listeners[name]=fn},
    document:{hidden:false,documentElement:{dataset:{}},body:{classList:{toggle(){}}},querySelectorAll:()=>[],getElementById:id=>elements[id]||(elements[id]=element()),createElement:element,addEventListener(){}}};
  vm.runInNewContext(script,sandbox);
  assert.equal(sent[0].method,'ui/initialize');
  listeners.message({source:{},data:{jsonrpc:'2.0',id:1,result:{hostCapabilities:{serverTools:{}}}}});
  assert.equal(sent.length,1); // Ignore messages from unrelated frames.
  listeners.message({source:parent,data:{jsonrpc:'2.0',id:1,result:{hostCapabilities:{serverTools:{}}}}});
  await delay(1);assert(sent.some(v=>v.method==='ui/notifications/initialized'));
  assert(!sent.some(v=>v.method==='tools/call')); // No duplicate fetch on mount.
  listeners.message({source:parent,data:{jsonrpc:'2.0',id:10,method:'ui/resource-teardown'}});
  for(const timer of timers)clearTimeout(timer);
  await server.close();
  console.log('Passed: prompt credential guard, durable model-load reconciliation, MCP panel SDK registration/handshake/teardown');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
  global.fetch=originalFetch;
  for(const[id,previous]of restores)previous?require.cache[id]=previous:delete require.cache[id];
  const resolved=path.resolve(root),expected=path.resolve(os.tmpdir())+path.sep;
  if(!resolved.startsWith(expected)||!path.basename(resolved).startsWith('hub-panel-load-test-'))throw new Error('Unsafe test cleanup target');
  fs.rmSync(resolved,{recursive:true,force:true});
});

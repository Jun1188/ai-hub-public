'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const graph=require('../src/core/pipeline-state-graph');
const sample=()=>({version:1,entry:'init',initialState:{count:0},maxTransitions:24,maxVisits:6,nodes:[
{id:'init',kind:'state',patch:{count:0},next:'check'},
{id:'check',kind:'condition',path:'count',operator:'lt',value:3,onTrue:'increment',onFalse:'review'},
{id:'increment',kind:'state',increments:{count:1},next:'check'},
{id:'review',kind:'review',next:'end'},{id:'end',kind:'end'}]});
(async()=>{
 let checks=0;const ok=(v)=>{assert.ok(v);checks++;};
 const r=await graph.simulate(sample());ok(r.status==='paused'&&r.checkpoint.data.count===3);ok(r.trace.filter(x=>x.nodeId==='increment').length===3);
 const done=await graph.execute(sample(),{checkpoint:r.checkpoint,stateOverride:{count:7}});ok(done.status==='succeeded'&&done.checkpoint.data.count===7&&done.trace.length===1);
 assert.throws(()=>graph.validate({...sample(),initialState:{path:'C:/private/example'}}));checks++;
 let bad=sample();bad.maxVisits=2;await assert.rejects(()=>graph.simulate(bad),/상한/);checks++;
 bad=sample();bad.nodes[1].onFalse='missing';assert.throws(()=>graph.validate(bad));checks++;
 bad=sample();bad.nodes.push({id:'orphan',kind:'end'});assert.throws(()=>graph.validate(bad));checks++;
 assert.throws(()=>graph.clean(JSON.parse('{"__proto__":{}}')));checks++;
 bad=sample();bad.initialState={value:'x'.repeat(66000)};assert.throws(()=>graph.validate(bad));checks++;
 bad=sample();bad.nodes[2].increments.count=0;bad.maxTransitions=12;await assert.rejects(()=>graph.simulate(bad),/상한/);checks++;
 bad=sample();bad.nodes[0].next='review';assert.throws(()=>graph.validate(bad));checks++;
 const stepGraph={version:1,entry:'task',initialState:{},nodes:[
 {id:'task',kind:'step',step:{type:'llama-chat',name:'test',prompt:'test'},next:'review',onError:'failed'},
 {id:'review',kind:'review',next:'end'},{id:'failed',kind:'state',patch:{failed:true},next:'end'},{id:'end',kind:'end'}]};
 let calls=0;const failed=await graph.execute(stepGraph,{executeStep:async()=>{calls++;return {exitCode:1,output:'failure'};}});ok(calls===1&&failed.checkpoint.data.failed&&failed.status==='succeeded');
 calls=0;const paused=await graph.execute(stepGraph,{executeStep:async()=>{calls++;return {exitCode:0,output:'done'};}});
 await graph.execute(stepGraph,{checkpoint:paused.checkpoint,executeStep:async()=>{calls++;throw Error('replay');}});ok(calls===1);
 const changed=structuredClone(stepGraph);changed.initialState={changed:true};await assert.rejects(()=>graph.execute(changed,{checkpoint:paused.checkpoint}));checks++;
 const cancelled=await graph.execute(sample(),{shouldStop:()=>true});ok(cancelled.status==='cancelled'&&cancelled.trace.length===0);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aihub-graph-test-'));
 const pathsId=require.resolve('../src/core/paths'),old=require.cache[pathsId];
 require.cache[pathsId]={id:pathsId,filename:pathsId,loaded:true,exports:{hubDataDir:()=>root}};
 const pipelineId=require.resolve('../src/core/pipeline');delete require.cache[pipelineId];
 const pipeline=require(pipelineId);
 const wait=async id=>{for(let i=0;i<200;i++){if(pipeline.activeCount()===0)return pipeline.runStatus(id);await new Promise(r=>setTimeout(r,10));}throw Error('pipeline test timeout');};
 try{
  const saved=pipeline.save({name:'persisted review',graph:sample()});const id=pipeline.start(saved.id).runId;
  const first=await wait(id);ok(first.status==='paused'&&first.graphState.count===3);
  // runs.json keeps only graphCheckpoint; graphState is filled on read (F7)
  const onDisk=()=>JSON.parse(fs.readFileSync(path.join(root,'runs.json'),'utf8')).runs;ok(onDisk().every(r=>!('graphState' in r))&&onDisk()[0].graphCheckpoint.data.count===3);
  assert.throws(()=>pipeline.resume(id,[]));ok(pipeline.runStatus(id).status==='paused');
  delete require.cache[pipelineId];const restarted=require(pipelineId);
  restarted.resume(id,{count:9});for(let i=0;i<100&&restarted.activeCount();i++)await new Promise(r=>setTimeout(r,10));
  const last=restarted.runStatus(id);ok(last.status==='succeeded'&&last.graphState.count===9);ok(last.steps.filter(s=>s.nodeId==='increment').length===3);
  const linear=restarted.save({name:'legacy empty',steps:[]});const lid=restarted.start(linear.id).runId;ok(restarted.runStatus(lid).status==='succeeded');
  // F3: an AI step whose input file is missing fails before any model call
  const noInput=restarted.save({name:'ai missing input',steps:[{type:'ai',name:'x',inputFrom:'file',inputPath:path.join(root,'missing.txt'),promptTemplate:'{{input}}'}]});
  const nid=restarted.start(noInput.id).runId;for(let i=0;i<500&&restarted.runStatus(nid).status==='running';i++)await new Promise(r=>setTimeout(r,10));
  ok(restarted.runStatus(nid).status==='failed'&&/입력 파일이 없습니다/.test(restarted.readLog(nid,0)));
  // F2: a log file that cannot be written is a warning — the chunk still reaches the GUI and nothing throws
  const blocker=path.join(root,'not-a-dir');fs.writeFileSync(blocker,'');const warned=[],shown=[];
  const logs=require('../src/core/pipeline-run-logs').createRunLogs({root:blocker,emit:(c,p)=>shown.push(p.chunk),onChunk:()=>{},onWarning:(id,t)=>warned.push(t)});
  logs.appendLog('r1',0,'hello\n','stdout');logs.appendLog('r1',0,'again\n','stdout');logs.flushLogBuffer('r1');
  ok(warned.length===1&&/log file not written/.test(warned[0])&&shown.join('').includes('hello')&&shown.join('').includes('again'));
  // caller: runs.json keeps who started the run; offload jobs the run starts record the pipeline (and keep the client)
  ok(first.caller.via==='script'&&first.caller.script==='test-pipeline-graph.js');
  const offload=require('../src/core/offload'),caller=require('../src/core/caller');let seen, request;
  offload.run=input=>{request=input;seen=caller.current();return 'job';};offload.wait=async()=>({state:'succeeded',results:[],verification:{schemaValid:0,schemaInvalid:0},usage:{},route:{}});
  const viaOffload=restarted.save({name:'offload caller',graph:{version:1,entry:'o',nodes:[{id:'o',kind:'step',step:{type:'offload',name:'x',task:'t',text:'x',worker:'agy',model:'gemini-4-argon-high'},next:'end',onError:'review'},{id:'review',kind:'review',next:'end'},{id:'end',kind:'end'}]}});
  const oid=caller.run({via:'mcp',client:'codex'},()=>restarted.start(viaOffload.id).runId);for(let i=0;i<100&&restarted.activeCount();i++)await new Promise(r=>setTimeout(r,10));
  assert.deepEqual(restarted.runStatus(oid).caller,{via:'mcp',client:'codex'});assert.deepEqual(seen,{via:'pipeline',client:'codex',runId:oid});checks+=2;
  assert.equal(request.model,'gemini-4-argon-high');checks++;
  for(const override of [{tier:'fast'},{worker:'codex'},{model:'unrecognized'}]){
    const invalid=structuredClone(viaOffload.graph);
    Object.assign(invalid.nodes[0].step,override);
    assert.throws(()=>graph.validate(invalid),/o: /);checks++;
  }
  const corrupt=path.join(root,'pipelines.json');fs.writeFileSync(corrupt,'broken');assert.throws(()=>restarted.save({name:'lost?',steps:[]}));ok(fs.readFileSync(corrupt,'utf8')==='broken');
 }finally{if(old)require.cache[pathsId]=old;else delete require.cache[pathsId];}
 // 1.29.0: 위임(agent-task)·오케스트레이션 단계는 없어졌다. 남은 그래프가 조용히 다른 경로로 돌지 않게 거부한다.
 for(const type of ['agent-task','orchestrate']){let err='';try{graph.validate({version:1,entry:'a',nodes:[{id:'a',kind:'step',step:{type,name:'x',agent:'local',prompt:'p'},next:'e'},{id:'e',kind:'end'}]});}catch(e){err=e.message;}ok(/type\/name/.test(err));}
 console.log('State graph: '+checks+' checks passed; no models/API/tools executed');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});

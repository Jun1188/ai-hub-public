'use strict';
(() => {
 let draft,selected,reviewed,headerValues,inspectorValues;
 const nodeInput=id=>document.getElementById(id);
 const example=()=>({name:'상태 루프 · 검토 후 완료',auto:{enabled:false},graph:{version:1,entry:'init',initialState:{count:0},maxTransitions:24,maxVisits:6,nodes:[
 {id:'init',kind:'state',patch:{count:0},next:'check'},
 {id:'check',kind:'condition',path:'count',operator:'lt',value:3,onTrue:'increment',onFalse:'review'},
 {id:'increment',kind:'state',increments:{count:1},next:'check'},
 {id:'review',kind:'review',next:'end'},{id:'end',kind:'end'}]}});
 const field=(id,label,value)=>'<label>'+label+'</label><input id="'+id+'" value="'+esc(value)+'">';
 const area=(id,label,value)=>'<label>'+label+'</label><textarea id="'+id+'" rows="5">'+esc(JSON.stringify(value,null,2))+'</textarea>';
 const select=(id,label,values,value)=>'<label for="'+id+'">'+label+'</label><select id="'+id+'">'+values.map(x=>'<option value="'+esc(x)+'" '+(x===value?'selected':'')+'>'+esc(x||'종료')+'</option>').join('')+'</select>';
 function valuesOf(controls){return new Map(Array.from(controls,input=>[input.id,input.value]));}
 function header(){
  $('pg-name').value=draft.name;$('pg-entry').value=draft.graph.entry;$('pg-limit').value=draft.graph.maxTransitions||32;
  $('pg-visits').value=draft.graph.maxVisits||8;$('pg-state').value=JSON.stringify(draft.graph.initialState??{},null,2);
  headerValues=valuesOf(['pg-entry','pg-state','pg-limit','pg-visits'].map(nodeInput));
 }
 const OFFLOAD_STEP={type:'offload',name:'offload',task:'각 파일에서 요구한 항목만 추출',files:['$'+'{project.path}/Source/Example.cpp'],worker:'local',
  schema:{type:'object',required:['summary'],properties:{summary:{type:'string'}}},maxOutputTokens:512};
 function bindOffloadControls(){
  const json=nodeInput('pgn-step'), worker=nodeInput('pgn-worker'), tier=nodeInput('pgn-tier'), model=nodeInput('pgn-model');
  function sync(){
   let step;
   try{step=JSON.parse(json.value);}catch{}
   worker.disabled=step?.type!=='offload';
   worker.value=worker.disabled?'':step.worker??'local';
   model.disabled=worker.disabled||worker.value!=='agy';
   model.value=model.disabled?'':step.model??'';
   tier.disabled=model.disabled||Boolean(model.value);
   tier.value=tier.disabled?'':step.tier??'fast';
  }
  json.addEventListener('input',()=>{$('pg-execute-confirm').checked=false;sync();});
  for(const control of [worker,tier,model])control.addEventListener(control===model?'input':'change',()=>{
   const step=JSON.parse(json.value);
   if(control===worker){step.worker=worker.value;if(step.worker!=='agy'){delete step.tier;delete step.model;}}
   else if(control===model){if(model.value){step.model=model.value;delete step.tier;}else delete step.model;}
   else step.tier=tier.value;
   json.value=JSON.stringify(step,null,2);$('pg-execute-confirm').checked=false;sync();
  });
  sync();
 }
 const displayPositions=new WeakMap();
 function graphFromForm(){
  const nodes=draft.graph.nodes.map(node=>{
   const display=displayPositions.get(node);
   if(!display||display.position!==node.ui)return node;
   const stored={...node};
   if(display.hadUI)stored.ui=display.original;else delete stored.ui;
   return stored;
  });
  const graph={...draft.graph,nodes};
  function read(id,key,parse){
   const input=nodeInput(id);
   if(input.value!==headerValues.get(id))graph[key]=parse(input.value);
  }
  read('pg-entry','entry',value=>value.trim());
  read('pg-state','initialState',JSON.parse);
  read('pg-limit','maxTransitions',Number);
  read('pg-visits','maxVisits',Number);
  return graph;
 }
 function render(){
  resEmbedInvalidateRunNode();
  const unpositioned=draft.graph.nodes.filter(node=>!node.ui).map(node=>({node,original:node.ui,hadUI:Object.hasOwn(node,'ui')}));
  window.pipelineCanvas.render($('pg-map'),draft.graph,selected,id=>{selected=id;render();if(reviewed)resEmbedShowRun(reviewed,id,draft.id,graphFromForm);},resEmbedInvalidateRunNode);
  for(const {node,original,hadUI} of unpositioned)displayPositions.set(node,{position:node.ui,original,hadUI});
  const n=draft.graph.nodes.find(n=>n.id===selected),ids=draft.graph.nodes.map(n=>n.id);
  window.gamePipeline.inspect(n);window.gamePipeline.edges(draft.graph.nodes);
  if(!n){$('pg-inspector').innerHTML='노드를 선택하세요.';return;}
  let form=field('pgn-id','노드 ID',n.id)+select('pgn-kind','종류',['state','condition','step','review','end'],n.kind);
  if(n.kind==='condition')form+=field('pgn-path','상태 경로',n.path||'count')+select('pgn-op','연산자',['eq','ne','gt','gte','lt','lte','contains','exists'],n.operator)+field('pgn-value','비교값 (JSON)',JSON.stringify(Object.hasOwn(n,'value')?n.value:0))+select('pgn-true','참이면',ids,n.onTrue)+select('pgn-false','거짓이면',ids,n.onFalse);
  else if(n.kind!=='end')form+=select('pgn-next','다음 노드',ids,n.next);
  if(n.kind==='state')form+=area('pgn-patch','덮어쓰기 (경로: 값)',n.patch||{})+area('pgn-copy','상태 복사 (대상 경로: 원본 경로)',n.copy||{})+area('pgn-increments','증가량 (경로: 수)',n.increments||{});
  if(n.kind==='step'){
   form+=select('pgn-step-type','실행 방식',['offload','api-request','delay','mcp-tool','shell','llama-chat','ai','comfy-workflow','msbuild','unity-batch','uat','source-index','finetune-gen','herdr-agent'],n.step.type);
   if(n.step.type==='offload')form+=select('pgn-worker','이 노드의 작업자',['local','codex','agy'],n.step.worker||'local')
    +'<label for="pgn-model">agy 모델 ID (선택)</label><input id="pgn-model">'
    +select('pgn-tier','agy 모델·추론 등급',['fast','reasoning','deep'],n.step.tier||'fast');
   form+=area('pgn-step','실행 단계 (JSON)',n.step)+select('pgn-error','실패 분기',['',...ids],n.onError||'');
   if(n.step.type==='offload')form+='<p>codex와 agy는 선택한 입력을 해당 CLI로 보냅니다. 할당량 소진 등 실패를 직접 확인하려면 실패 분기를 검토 노드로 연결하세요.</p>';
  }
  $('pg-inspector').innerHTML=form+'<div class="pg-actions"><button id="pgn-apply">노드 적용</button><button id="pgn-delete" class="danger">삭제</button></div>';
  inspectorValues=valuesOf($('pg-inspector').querySelectorAll('input,textarea,select'));
  if(n.kind==='step'&&n.step.type==='offload')bindOffloadControls();
  if(n.kind==='step')nodeInput('pgn-step-type').addEventListener('change',()=>{
   const type=nodeInput('pgn-step-type').value,defaults={
    offload:OFFLOAD_STEP,
    'herdr-agent':{session:'default',target:'w1:p1',prompt:'${state.goal}',until:'done',timeoutMs:300000},
    'api-request':{connection:window.apiPipelineConnections.firstId(),method:'GET',route:'/status',timeoutMs:30000},
    delay:{ms:1000},
    'mcp-tool':{server:'registered-server',tool:'tool-name',argsJson:'{}'},shell:{command:'echo hello'},
    'llama-chat':{prompt:'Summarize the supplied task',maxTokens:128},ai:{promptTemplate:'Summarize the supplied task'},
    'comfy-workflow':{workflowFile:'$'+'{project.path}/workflow-api.json'},msbuild:{sln:'$'+'{project.slnPath}'},
    'unity-batch':{executeMethod:'BuildScript.PerformBuild'},uat:{command:'BuildCookRun'},
    'source-index':{index:'project',root:'$'+'{project.path}'},'finetune-gen':{indexName:'project'}
   };n.step={type,name:type,...defaults[type]};$('pg-execute-confirm').checked=false;render();
  });
  nodeInput('pgn-apply').addEventListener('click',()=>{try{apply(n);render();}catch(e){toast(e.message,true);}});
  nodeInput('pgn-delete').addEventListener('click',()=>{draft.graph.nodes=draft.graph.nodes.filter(x=>x!==n);selected=draft.graph.nodes[0]?.id;render();});
  nodeInput('pgn-kind').addEventListener('change',()=>{n.kind=nodeInput('pgn-kind').value;
   if(n.kind==='condition')Object.assign(n,{path:'count',operator:'lt',value:3,onTrue:'end',onFalse:'end'});
   if(n.kind==='step'&&!n.step)n.step={type:'llama-chat',name:'로컬 요약',prompt:'입력: '+String('$'+'{state.count}'),maxTokens:128};
   if(n.kind==='end'){delete n.next;delete n.onError;}else if(!n.next)n.next='end';render();});
 }
 function apply(n){
  const id=nodeInput('pgn-id').value.trim();if(draft.graph.nodes.some(x=>x!==n&&x.id===id))throw Error('중복 ID');
  const old=n.id;
  const update={};
  function read(key,control,parse=value=>value){
   const input=nodeInput(control);
   if(input&&input.value!==inspectorValues.get(control))update[key]=parse(input.value);
  }
  for(const [key,control] of [['path','pgn-path'],['operator','pgn-op'],['onTrue','pgn-true'],['onFalse','pgn-false'],['next','pgn-next']])read(key,control);
  for(const key of ['value','patch','copy','increments','step'])read(key,'pgn-'+key,JSON.parse);
  // Choosing a comparison for an existing 'exists' condition makes its displayed operand required.
  if(n.kind==='condition'&&update.operator&&update.operator!=='exists'&&!Object.hasOwn(n,'value')&&!Object.hasOwn(update,'value')){
   update.value=JSON.parse(nodeInput('pgn-value').value);
  }
  read('onError','pgn-error');
  if(update.onError===''){delete n.onError;delete update.onError;}
  Object.assign(n,update);n.id=id;
  if(old!==id){if(draft.graph.entry===old){draft.graph.entry=id;$('pg-entry').value=id;}for(const x of draft.graph.nodes)for(const key of ['next','onTrue','onFalse','onError'])if(x[key]===old)x[key]=id;selected=id;}
  inspectorValues=valuesOf($('pg-inspector').querySelectorAll('input,textarea,select'));
 }
 function collect(){
  const n=draft.graph.nodes.find(n=>n.id===selected);if(n)apply(n);
  return {...draft,name:$('pg-name').value.trim(),graph:graphFromForm(),auto:{enabled:false},
   projectId:$('pipe-run-project').value||draft.projectId||''};
 }
 async function save(p){
  draft=await call(window.hub.pipeSave,p);
  header();render();
 }
 function load(p){
  draft=JSON.parse(JSON.stringify(p));
  if(!draft.graph)draft.graph={version:1,entry:draft.steps.length?'step1':'end',initialState:{},maxTransitions:32,maxVisits:8,nodes:draft.steps.map((s,i)=>({id:'step'+(i+1),kind:'step',step:s,next:i+1===draft.steps.length?'end':'step'+(i+2)})).concat({id:'end',kind:'end'})};
  draft.auto={enabled:false};selected=draft.graph.nodes[0]?.id;header();render();if(reviewed)resEmbedShowRun(reviewed);$('pg-execute-confirm').checked=false;$('pg-workspace').scrollIntoView({block:'start'});
 }
 async function action(f){try{await f();}catch(e){toast(e.message,true);$('pg-output').textContent=e.message;}}
 for(const event of ['input','change']){
  $('pg-workspace').addEventListener(event,e=>{
   if(e.target.closest('#pg-inspector, #pg-entry, #pg-state, #pg-limit, #pg-visits'))resEmbedInvalidateRunNode();
  });
 }
 $('pg-example').addEventListener('click',()=>load(example()));
 $('pg-api-example').addEventListener('click',()=>load({name:'API 작업 제출 · 제한된 상태 조회',auto:{enabled:false},graph:{version:1,entry:'submit',initialState:{},maxTransitions:32,maxVisits:6,nodes:[
  {id:'submit',kind:'step',step:{type:'api-request',name:'작업 제출',connection:window.apiPipelineConnections.firstId(),method:'POST',route:'/jobs',body:{task:'example'},timeoutMs:30000},next:'remember'},
  {id:'remember',kind:'state',copy:{jobId:'last.data.body.id'},next:'wait'},
  {id:'wait',kind:'step',step:{type:'delay',name:'상태 조회 간격',ms:1000},next:'poll'},
  {id:'poll',kind:'step',step:{type:'api-request',name:'같은 작업 상태 조회',connection:window.apiPipelineConnections.firstId(),route:'/jobs/'+String('$'+'{state.jobId}')},next:'check'},
  {id:'check',kind:'condition',path:'last.data.body.status',operator:'eq',value:'done',onTrue:'review',onFalse:'wait'},
  {id:'review',kind:'review',next:'end'},{id:'end',kind:'end'}
 ]}}));
 $('pg-add').addEventListener('click',()=>{
  let i=1;while(draft.graph.nodes.some(n=>n.id==='node'+i))i++;
  const kind=$('pg-add-kind').value,end=draft.graph.nodes.find(n=>n.kind==='end')?.id||'end',at=draft.graph.nodes.find(n=>n.id===selected)?.ui;
  const n={id:'node'+i,...(kind==='offload'?{kind:'step',step:{...OFFLOAD_STEP},next:end,onError:end}:kind==='condition'?{kind,path:'count',operator:'lt',value:3,onTrue:end,onFalse:end}
   :kind==='end'?{kind}:{kind,...(kind==='state'?{patch:{}}:{}),next:end}),...(at?{ui:{x:at.x+24,y:at.y+70}}:{})};
  draft.graph.nodes.push(n);selected=n.id;render();});
 $('pg-validate').addEventListener('click',()=>action(async()=>{await call(window.hub.pipeGraphValidate,collect().graph);$('pg-output').textContent='검증 통과. 실제 작업은 실행하지 않았습니다.';}));
 $('pg-simulate').addEventListener('click',()=>action(async()=>{const r=await call(window.hub.pipeGraphSimulate,collect().graph);$('pg-output').textContent=r.trace.map(e=>e.transition+'. '+e.nodeId+' #'+e.visit+' '+e.status+' → '+(e.next||'END')).join('\n')+'\n\n상태: '+r.status+'\n'+JSON.stringify(r.checkpoint.data,null,2);}));
 $('pg-save').addEventListener('click',()=>action(async()=>{await save(collect());toast('상태 그래프 저장됨');refreshPipelines();}));
 $('pg-run').addEventListener('click',()=>action(async()=>{const p=collect();if(p.graph.nodes.some(n=>n.kind==='step')&&!$('pg-execute-confirm').checked)throw Error('실제 실행 단계를 확인하고 체크하세요.');await save(p);await startPipeline(draft.id);refreshPipelines();}));
 $('pg-export').addEventListener('click',()=>action(()=>{$('pg-json').value=JSON.stringify(collect(),null,2);}));
 $('pg-import').addEventListener('click',()=>action(async()=>{const p=JSON.parse($('pg-json').value);await call(window.hub.pipeGraphValidate,p.graph);delete p.id;delete p.createdAt;delete p.updatedAt;load(p);}));
 window.pipelineGraphEditor={load,selectedNode:()=>draft.graph.nodes.find(n=>n.id===selected),changed(){resEmbedInvalidateRunNode();$('pg-execute-confirm').checked=false;render();},sync(runs){const fresh=reviewed&&runs.find(r=>r.runId===reviewed.runId);if(fresh&&resEmbedRunChanged(reviewed,fresh)){reviewed=fresh;resEmbedShowRun(fresh);}},review(run){
  $('pg-review').hidden=false;$('pg-review-id').textContent=run.runId;
  $('pg-resume-state').value=JSON.stringify(run.graphState||run.graphCheckpoint.data,null,2);
  $('pg-resume').disabled=run.status!=='paused';$('pg-resume').dataset.runId=run.runId;
  $('pg-review-trace').textContent=run.steps.map(s=>s.nodeId+' #'+s.visit+' '+s.status+' → '+(s.next||'END')).join('\n');
  reviewed=run;resEmbedShowRun(run);
  $('pg-review').scrollIntoView({block:'start'});
 }};
 $('pg-resume').addEventListener('click',()=>action(async()=>{const result=await call(window.hub.pipeResume,$('pg-resume').dataset.runId,JSON.parse($('pg-resume-state').value));currentRunId=result.runId;$('pipe-cancel').disabled=false;$('pg-resume').disabled=true;toast('검토 지점 다음 노드부터 재개합니다.');refreshPipeHistory();}));
 draft=example();selected='check';header();render();
})();

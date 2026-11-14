'use strict';
window.gamePipeline=(()=>{
 const names={plan:'기획',asset:'리소스 제작',implement:'구현',playtest:'플레이테스트',review:'품질 검토'};
 const game=(role,goal)=>({role,goal,skills:[]});
 function template(engine){
  const nodes=[
   {id:'brief',kind:'state',patch:{iteration:0,accepted:false,goal:'플레이어의 목표 → 행동 → 피드백 → 재시도 루프 확인'},next:'plan',game:game('plan','재미 가설과 완료 조건 정리')},
   {id:'plan',kind:'review',next:'asset',game:game('plan','기획과 작업 범위를 검토한 후 재개')},
   {id:'asset',kind:'review',next:'implement',game:game('asset','제작실에서 이미지·스프라이트·UI 리소스 준비')},
   {id:'implement',kind:'review',next:'playtest',game:game('implement','승인된 프로젝트 구현 변경 검토')},
   {id:'playtest',kind:'review',next:'judge',game:game('playtest','조작·결과·재시도와 UI 가독성을 실제 플레이로 확인')},
   {id:'judge',kind:'condition',path:'accepted',operator:'eq',value:true,onTrue:'end',onFalse:'iterate',game:game('review','재개 상태의 accepted를 true로 바꾸면 완료')},
   {id:'iterate',kind:'state',increments:{iteration:1},next:'budget'},
   {id:'budget',kind:'condition',path:'iteration',operator:'lt',value:3,onTrue:'plan',onFalse:'limit'},
   {id:'limit',kind:'review',next:'end',game:game('review','3회 개선 상한 도달 · 남은 문제를 기록하고 종료')},
   {id:'end',kind:'end'}
  ];
  return{name:engine+' 게임개발 · 제작 → 플레이 → 개선',auto:{enabled:false},graph:{version:1,entry:'brief',initialState:{},maxTransitions:48,maxVisits:4,nodes}};
 }
 function addSkill(path){
  const editor=window.pipelineGraphEditor,n=editor.selectedNode();
  if(!n){toast('게임 루프에서 연결할 노드를 먼저 선택하세요.',true);return;}
  n.game||=game('implement','');n.game.skills=[...new Set([...(n.game.skills||[]),path])];editor.changed();toast('선택한 노드에 스킬 경로를 연결했습니다.');
 }
 function inspect(n){
  const host=$('game-node-inspector');host.innerHTML='';if(!n)return;
  const info=n.game||game('implement','');
  host.innerHTML='<h4>게임개발 역할</h4><label for="game-node-role">역할</label><select id="game-node-role">'+Object.entries(names).map(([k,v])=>'<option value="'+k+'" '+(k===info.role?'selected':'')+'>'+v+'</option>').join('')+'</select><label for="game-node-goal">이 노드의 완료 조건</label><textarea id="game-node-goal" rows="3">'+esc(info.goal)+'</textarea><label for="game-node-skills">참조 스킬 (한 줄에 저장소 경로 하나)</label><textarea id="game-node-skills" rows="3">'+esc((info.skills||[]).join('\n'))+'</textarea><button id="game-node-save">역할·스킬 연결</button><button id="game-node-execute">실행 노드로 구성</button>';

  if(n.kind==='step'){
   const fields={
    'herdr-agent':[['session','Herdr 세션'],['target','에이전트 이름 또는 pane'],['prompt','작업 지시'],['timeoutMs','대기 상한 (ms)']],
    'unity-batch':[['executeMethod','Unity 실행 메서드']],
    uat:[['command','UAT 명령']],
    'comfy-workflow':[['workflowFile','워크플로 파일']],
    'mcp-tool':[['server','연결된 MCP 서버'],['tool','도구 이름'],['argsJson','도구 입력 JSON']],
    offload:[['worker','작업자 (codex / agy / local)'],['task','작업 지시'],['text','작업 입력']]
   }[n.step.type]||[];
   const controls=[];
   for(const[key,title]of fields){const label=document.createElement('label'),input=document.createElement('textarea');label.textContent=title;input.value=String(n.step[key]??'');input.rows=key==='prompt'||key==='task'?4:2;label.append(input);host.append(label);controls.push({key,input});}
   if(controls.length){const button=document.createElement('button');button.textContent='실행 연결 적용';button.addEventListener('click',()=>{for(const{key,input}of controls)n.step[key]=key==='timeoutMs'?Number(input.value):input.value;window.pipelineGraphEditor.changed();});host.append(button);}
  }
  $('game-node-save').addEventListener('click',()=>{
   const skills=$('game-node-skills').value.split('\n').map(s=>s.trim()).filter(Boolean);
   if(skills.some(s=>!/^skills\/[\w./-]+\/SKILL\.md$/i.test(s)||s.split('/').includes('..'))){toast('저장소 안의 스킬 경로를 입력하세요.',true);return;}
   n.game={role:$('game-node-role').value,goal:$('game-node-goal').value.slice(0,2000),skills};window.pipelineGraphEditor.changed();
  });
  $('game-node-execute').addEventListener('click',()=>{
   const type=$('game-step-type').value;
   const defaults={
    'unity-batch':{type,name:'Unity 프로젝트 메서드 실행',executeMethod:'BuildScript.PerformBuild'},
    uat:{type,name:'Unreal 빌드·쿡',command:'BuildCookRun'},
    'comfy-workflow':{type,name:'리소스 제작',workflowFile:'${project.path}/workflow-api.json'},
    'mcp-tool':{type,name:'엔진 도구',server:'registered-server',tool:'tool-name',argsJson:'{}'},
    offload:{type,name:'구현·검토 변경안',worker:'codex',task:'요구사항과 스킬을 확인하고 변경안을 제안하세요. 자동 적용하지 마세요.',text:JSON.stringify({goal:info.goal,skills:info.skills}),maxOutputTokens:1024},
    'herdr-agent':{type,name:'Herdr 에이전트 작업',session:'default',target:'w1:p1',prompt:'${state.goal}',until:'done',timeoutMs:300000}
   };
   n.kind='step';n.step=defaults[type];window.pipelineGraphEditor.changed();toast('실행 입력을 노드 편집기에서 확인하세요. 저장만으로 실행되지는 않습니다.');
  });
 }
 $('game-template-load').addEventListener('click',()=>{window.pipelineGraphEditor.load(template($('game-engine').value));$('pg-execute-confirm').checked=false;});
 $('game-edge-connect').addEventListener('click',()=>{
  const editor=window.pipelineGraphEditor,n=editor.selectedNode();if(!n)return;
  const key=$('game-edge-kind').value,to=$('game-edge-target').value;
  if(n.kind==='end'||n.kind==='condition'&&!['onTrue','onFalse'].includes(key)||n.kind!=='condition'&&['onTrue','onFalse'].includes(key)||key==='onError'&&n.kind!=='step'){toast('노드 종류에 맞는 연결을 선택하세요.',true);return;}
  n[key]=to;editor.changed();
 });
 function edges(nodes){$('game-edge-target').innerHTML=nodes.map(n=>'<option value="'+esc(n.id)+'">'+esc(n.id)+'</option>').join('');}
 return{template,addSkill,inspect,edges};
})();

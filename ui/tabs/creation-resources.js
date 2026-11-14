'use strict';
(()=>{
 let job,polling=false,herdrJob;
 const action=fn=>async()=>{try{await fn();}catch(e){toast(e.message,true);$('cr-output').textContent=e.message;}};
 document.querySelectorAll('[data-creation-pane]').forEach(button=>button.addEventListener('click',()=>{
  document.querySelectorAll('[data-creation-pane]').forEach(b=>b.setAttribute('aria-selected',String(b===button)));
  document.querySelectorAll('.cs-pane').forEach(p=>p.hidden=p.id!=='cs-pane-'+button.dataset.creationPane);
  if(button.dataset.creationPane==='web')window.creationStudio.open();
 }));

 document.querySelector('.cs-tabs').addEventListener('keydown',e=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
  const buttons=[...document.querySelectorAll('[data-creation-pane]')],at=buttons.indexOf(document.activeElement);if(at<0)return;
  e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(at+(e.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
  buttons[next].focus();buttons[next].click();
 });
 $('cr-refresh').addEventListener('click',action(async()=>{
  const servers=await call(window.hub.downstreamList);
  $('cr-server').innerHTML='<option value="">연결된 MCP 서버 선택</option>'+servers.map(s=>'<option value="'+esc(s.name)+'">'+esc(s.name)+(s.connected?' · 연결됨':' · 연결 필요')+'</option>').join('');
 }));
 $('cr-server').addEventListener('change',action(async()=>{
  if(!$('cr-server').value)return;const tools=await call(window.hub.downstreamTools,$('cr-server').value);
  $('cr-tool').innerHTML='<option value="">이미지 제작 도구 선택</option>'+tools.map(t=>'<option value="'+esc(t.name)+'">'+esc(t.name)+'</option>').join('');
  $('cr-schema').textContent=JSON.stringify(tools.map(t=>({name:t.name,inputSchema:t.inputSchema})),null,2);
 }));
 $('cr-run').addEventListener('click',action(async()=>{
  if(job)throw Error('이전 제작 요청이 진행 중입니다.');
  const r=await call(window.hub.studioResourceRun,{provider:$('cr-provider').value,server:$('cr-server').value,tool:$('cr-tool').value,args:JSON.parse($('cr-args').value)});
  if(r.cancelled)return;job=r.id;$('cr-run').disabled=true;$('cr-output').textContent='제작 중 · '+r.id;
 }));
 function gallery(result){
  $('cr-gallery').innerHTML='';
  for(const c of result.content||[])if(c.type==='image'&&/^image\/(png|jpeg|webp|gif)$/.test(c.mimeType)&&typeof c.data==='string'&&/^[a-z0-9+/=]+$/i.test(c.data)){
   const src='data:'+c.mimeType+';base64,'+c.data,figure=document.createElement('figure'),img=document.createElement('img'),button=document.createElement('button');
   img.src=src;img.alt='제작한 이미지';button.textContent='웹 디자인 선택 위치에 넣기';
   button.addEventListener('click',action(async()=>{await window.creationStudio.open();window.creationStudio.insertImage(src,'제작한 이미지');document.querySelector('[data-creation-pane="web"]').click();}));
   figure.append(img,button);$('cr-gallery').append(figure);
  }
  $('cr-output').textContent=(result.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n').slice(0,16000)||'이미지 제작 완료. 파일 경로를 반환하는 공급자는 파일로 가져오기를 사용하세요.';
 }
 setInterval(async()=>{
  if(!job||polling)return;polling=true;
  try{const r=await call(window.hub.studioResourcePoll,job);if(r.state!=='running'){job=null;$('cr-run').disabled=false;if(r.state==='succeeded')gallery(r.result);else $('cr-output').textContent=r.error;}}
  catch(e){job=null;$('cr-run').disabled=false;$('cr-output').textContent=e.message;}finally{polling=false;}
 },2500);

 $('cr-herdr-open').addEventListener('click',()=>hubGo('orchestration'));
 $('cr-herdr-run').addEventListener('click',action(async()=>{
  if(herdrJob)throw Error('리소스 제작 에이전트가 작업 중입니다.');
  const instruction=$('cr-herdr-prompt').value.trim();if(!instruction)throw Error('이미지 제작 지시를 입력하세요.');
  const provider=$('cr-provider').value;
  const prompt=(provider==='gpt-image'?'Use the available imagegen skill / GPT image tool in this Codex session. ':'Use the available built-in image-generator in this Antigravity session. ')+
   'If the image tool is unavailable, report that explicitly and do not substitute a different provider. Generate only the requested resources, preserve existing project source, and report the actual tool, output files and any incomplete work.\n\nUser instruction:\n'+instruction;
  const r=await call(window.hub.herdrControl,{requestId:crypto.randomUUID(),session:$('cr-herdr-session').value.trim(),action:'prompt',target:$('cr-herdr-target').value.trim(),prompt,wait:true,until:'done',timeoutMs:600000});
  if(r.cancelled)return;herdrJob=r.id;$('cr-herdr-run').disabled=true;$('cr-herdr-output').textContent='제작 요청 전달됨 · '+r.id;
 }));
 setInterval(async()=>{
  if(!herdrJob)return;
  try{const r=await call(window.hub.herdrStatus,herdrJob);if(r.state!=='running'){herdrJob=null;$('cr-herdr-run').disabled=false;$('cr-herdr-output').textContent=JSON.stringify(r,null,2);}}
  catch(e){herdrJob=null;$('cr-herdr-run').disabled=false;$('cr-herdr-output').textContent=e.message;}
 },3000);
 $('cr-comfy-show').addEventListener('click',action(async()=>{$('cr-comfy-frame').src=await call(window.hub.studioComfyUrl);}));
 $('cr-comfy-controls').addEventListener('click',()=>hubGo('delegate','local-runtime-status'));
 $('cr-connections').addEventListener('click',()=>hubGo('mcp'));
 $('cr-comfy-run').addEventListener('click',action(async()=>{
  $('cr-comfy-run').disabled=true;
  try{const r=await call(window.hub.mediaRun,{kind:'image',workflowFile:$('cr-comfy-workflow').value.trim(),inputs:JSON.parse($('cr-comfy-inputs').value||'{}')});$('cr-output').textContent=JSON.stringify(r,null,2);}
  finally{$('cr-comfy-run').disabled=false;}
 }));
 $('cr-skill-search').addEventListener('click',action(async()=>{
  const list=await call(window.hub.repositorySkillsList,$('cr-skill-query').value.trim());
  const skills=list.skills.filter(s=>/unity|unreal|ue5|sprite|game|2d-|audio|pixel|shader/i.test(s.name+' '+s.path));
  $('cr-skills').innerHTML=skills.map(s=>'<article class="cs-skill"><h3>'+esc(s.name)+'</h3><p>'+esc(s.description)+'</p><button data-cs-skill="'+esc(s.path)+'">지침 읽기</button><button data-cs-node="'+esc(s.path)+'">게임 루프 노드에 연결</button></article>').join('')||'해당 게임개발 스킬을 찾지 못했습니다.';
  $('cr-skills').querySelectorAll('[data-cs-skill]').forEach(b=>b.addEventListener('click',action(async()=>{$('cr-skill-text').textContent=await call(window.hub.repositorySkillsPreview,b.dataset.csSkill);}))); 
  $('cr-skills').querySelectorAll('[data-cs-node]').forEach(b=>b.addEventListener('click',()=>{window.gamePipeline.addSkill(b.dataset.csNode);hubGo('pipelines','pg-workspace');}));
 }));
 $('cr-game-pipeline').addEventListener('click',()=>hubGo('pipelines','game-pipeline-controls'));
})();

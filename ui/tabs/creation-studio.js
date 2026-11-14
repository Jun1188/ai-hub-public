'use strict';
window.creationStudio=(()=>{
 let initializing;
 let editor,doc,version=0,savedVersion=-1,saving=false,muted=false,timer,polling=false,job,aiRevision,lastFailure;
 const E=window.creationElements;
 const status=t=>{if(!lastFailure)$('cs-status').textContent=t;};
 const action=fn=>async()=>{lastFailure=null;try{await fn();}catch(e){lastFailure=e.message;$('cs-status').textContent=e.message;toast(e.message,true);}};
 const dirty=()=>{if(muted)return;version++;status('변경됨 · 자동 저장 대기');clearTimeout(timer);timer=setTimeout(()=>save().catch(e=>status(e.message)),700);};
 async function library(){const list=await call(window.hub.studioList);$('cs-docs').innerHTML='<option value="">문서 선택</option>'+list.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join('');if(doc)$('cs-docs').value=doc.id;}
 async function save(){
  if(!editor||!doc||saving||version===savedVersion)return;
  saving=true;const at=version;
  try{
   E.identify(editor);
   doc=await call(window.hub.studioSave,{id:doc.id,revision:doc.revision,name:$('cs-name').value,project:editor.getProjectData(),selection:editor.getSelectedAll().map(E.id)});
   savedVersion=at;status('저장됨 · r'+doc.revision);return doc;
  }finally{saving=false;if(savedVersion!==version&&savedVersion===at)timer=setTimeout(()=>save().catch(e=>status(e.message)),700);}
 }
 async function flush(){if(saving)throw Error('자동 저장을 마친 뒤 다시 시도하세요.');await save();if(version!==savedVersion)throw Error('아직 저장하지 못한 변경이 있습니다.');}
 function selection(){
  if(!editor)return;const list=editor.getSelectedAll();
  $('cs-selected').textContent=list.length?list.map(E.label).join('\n'):'캔버스에서 수정할 요소를 선택하세요. Shift를 누르면 여러 요소를 선택할 수 있습니다.';
  const parent=list[0]?.parent();$('cs-parent').disabled=!parent;
  dirty();
 }
 function load(p){
  clearTimeout(timer);muted=true;let missingIds=false;try{doc=p;editor.loadProjectData(p.project);missingIds=E.identify(editor);$('cs-name').value=p.name;$('cs-docs').value=p.id;version++;savedVersion=version;}
  finally{muted=false;}muted=true;try{if((p.selection||[]).length)editor.select(E.all(editor).filter(c=>p.selection.includes(E.id(c))));}finally{muted=false;}
  $('cs-selected').textContent=editor.getSelectedAll().map(E.label).join('\n')||'캔버스에서 수정할 요소를 선택하세요.';proposals(p);status('문서 열림 · r'+p.revision);if(missingIds)dirty();
 }
 async function switchDocument(id){
  await flush();if(!id)return;const p=await call(window.hub.studioRead,id);load(p);
 }
 function proposals(p){
  const host=$('cs-proposals');host.innerHTML='';
  for(const proposal of p.proposals||[]){
   const row=document.createElement('article');row.className='cs-proposal';
   const title=document.createElement('strong');title.textContent=proposal.summary;row.append(title);
   const detail=document.createElement('pre');detail.textContent=proposal.operations.map(op=>op.op+' · '+op.target+'\n'+JSON.stringify(op.value??{parent:op.parent,index:op.index},null,2)).join('\n\n');row.append(detail);
   const apply=document.createElement('button');apply.textContent='이 변경안 적용';
   apply.addEventListener('click',action(async()=>{
    await flush();if(proposal.baseRevision!==doc.revision)throw Error('변경안을 받은 뒤 문서가 바뀌었습니다. 최신 요소로 다시 요청하세요.');
    E.apply(editor,proposal);dirty();await flush();
    await call(window.hub.studioDismiss,doc.id,proposal.id);await inbox();toast('선택 범위에 변경안을 적용했습니다.');
   }));
   const dismiss=document.createElement('button');dismiss.textContent='닫기';dismiss.addEventListener('click',action(async()=>{await call(window.hub.studioDismiss,doc.id,proposal.id);await inbox();}));
   row.append(apply,dismiss);host.append(row);
  }
 }
 async function inbox(){if(!doc)return;const id=doc.id,p=await call(window.hub.studioRead,id);if(doc?.id!==id)return;proposals(p);if(p.revision!==doc.revision)status('다른 편집이 저장되었습니다. 현재 문서를 내보낸 뒤 다시 여세요.');}
 async function init(){
  if(editor){editor.refresh();return;}
  if(!window.grapesjs)await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='vendor/grapesjs/grapes.min.js';s.onload=resolve;s.onerror=()=>reject(Error('GrapesJS를 불러오지 못했습니다.'));document.head.append(s);});
  editor=window.grapesjs.init({container:'#cs-canvas',cssIcons:'vendor/font-awesome/css/font-awesome.min.css',height:'650px',storageManager:false,noticeOnUnload:false,telemetry:false,allowScripts:false,
   parser:{optionsHtml:{allowScripts:false,allowUnsafeAttr:false,allowUnsafeAttrValue:false}},
   deviceManager:{devices:[{id:'desktop',name:'Desktop',width:''},{id:'tablet',name:'Tablet',width:'768px',widthMedia:'992px'},{id:'mobile',name:'Mobile',width:'390px',widthMedia:'480px'}]},
   styleManager:{sectors:[{name:'레이아웃',open:true,properties:['display','position','width','min-width','max-width','height','padding','margin','gap','flex-direction','justify-content','align-items','flex-wrap']},{name:'글자·색상',properties:['font-family','font-size','font-weight','line-height','text-align','color','background-color','border','border-radius','opacity']}]}});
  window.creationBlocks.install(editor);
  editor.on('component:add',()=>{if(!muted){muted=true;try{E.identify(editor);}finally{muted=false;}dirty();}});
  editor.on('update',dirty);editor.on('component:selected component:deselected',selection);
  editor.on('canvas:frame:load:head',({window:frame})=>{
   const meta=frame.document.createElement('meta');meta.httpEquiv='Content-Security-Policy';meta.content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; form-action 'none'; base-uri 'none'";frame.document.head.prepend(meta);
   frame.document.addEventListener('click',e=>{if(e.target.closest('a'))e.preventDefault();});
  });
  const list=await call(window.hub.studioList);
  if(list.length)load(await call(window.hub.studioRead,list[0].id));
  else load(await call(window.hub.studioCreate,'새 웹 디자인',window.creationBlocks.starter));
  await library();
 }
 $('cs-save').addEventListener('click',action(flush));$('cs-name').addEventListener('input',dirty);
 $('cs-docs').addEventListener('change',action(()=>switchDocument($('cs-docs').value)));
 $('cs-new').addEventListener('click',action(async()=>{await flush();load(await call(window.hub.studioCreate,'새 웹 디자인',window.creationBlocks.starter));await library();}));
 $('cs-parent').addEventListener('click',()=>{const p=editor?.getSelected()?.parent();if(p)editor.select(p);});
 $('cs-undo').addEventListener('click',()=>editor?.UndoManager.undo());$('cs-redo').addEventListener('click',()=>editor?.UndoManager.redo());
 $('cs-device').addEventListener('change',()=>editor?.setDevice($('cs-device').value));
 $('cs-preview').addEventListener('click',()=>{if(!editor)return;if(editor.Commands.isActive('preview'))editor.stopCommand('preview');else editor.runCommand('preview');});
 $('cs-import').addEventListener('click',action(async()=>{
  await flush();const file=await call(window.hub.studioImport,'document');if(!file)return;
  let project;if(file.ext==='json'){const parsed=JSON.parse(file.text);project=parsed.project||parsed;}
  else{
   const imported=E.fromHtml(file.text);muted=true;const before=editor.getProjectData();
   try{editor.setComponents(imported.html);editor.setStyle(imported.css);E.identify(editor);project=editor.getProjectData();}finally{editor.loadProjectData(before);muted=false;}
  }
  load(await call(window.hub.studioCreate,file.name,project));await library();
 }));
 for(const kind of ['json','html'])$('cs-export-'+kind).addEventListener('click',action(async()=>{
  if(!editor)return;
  const text=kind==='json'?JSON.stringify({schemaVersion:1,name:$('cs-name').value,project:editor.getProjectData()},null,2):'<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+editor.getCss()+'</style></head><body>'+editor.getHtml({jsInHtml:false})+'</body></html>';
  await call(window.hub.studioExport,{kind,text});
 }));

 $('cs-page-import').addEventListener('click',action(async()=>{
  await flush();$('cs-page-import').disabled=true;
  try{
   const file=await call(window.hub.studioFetchPage,$('cs-page-url').value.trim()),imported=E.fromHtml(file.html,file.url),before=editor.getProjectData();let project;
   muted=true;try{editor.setComponents(imported.html);editor.setStyle(imported.css+'\n'+file.css);E.identify(editor);project=editor.getProjectData();}finally{editor.loadProjectData(before);muted=false;}
   load(await call(window.hub.studioCreate,file.name,project));await library();status(file.notice);
  }finally{$('cs-page-import').disabled=false;}
 }));
 $('cs-image').addEventListener('click',action(async()=>{const asset=await call(window.hub.studioImport,'image');if(!asset)return;insertImage(asset.src,asset.name);}));
 function insertImage(src,name='이미지'){
  if(!editor)throw Error('웹 디자인 문서를 먼저 여세요.');
  const selected=editor.getSelected();
  editor.AssetManager.add({src,name});
  if(selected?.get('type')==='image')selected.set('src',src);
  else (selected||editor.getWrapper()).append({type:'image',src,attributes:{alt:name},style:{'max-width':'100%'}});
  dirty();
 }
 $('cs-ai-send').addEventListener('click',action(async()=>{
  if(job)throw Error('이전 AI 요청이 진행 중입니다.');await flush();
  const targets=editor.getSelectedAll().map(E.target);if(!targets.length)throw Error('수정할 요소를 선택하세요.');
  if(!$('cs-ai-consent').checked)throw Error('선택 요소의 글자·스타일·하위 요소를 보낼지 확인하세요.');
  const r=await call(window.hub.studioAiStart,{id:doc.id,revision:doc.revision,worker:$('cs-ai-worker').value,instruction:$('cs-instruction').value,device:$('cs-device').value.toLowerCase(),targets});
  job=r.id;aiRevision=doc.id;$('cs-ai-cancel').disabled=false;status('AI 변경안 작성 중 · 직접 편집할 수 있습니다.');
 }));
 $('cs-ai-cancel').addEventListener('click',action(async()=>{if(job)await call(window.hub.studioAiCancel,job);job=null;$('cs-ai-cancel').disabled=true;status('AI 요청 취소됨');}));
 $('cs-ai-context').addEventListener('click',action(async()=>{
  await flush();$('cs-context').value=JSON.stringify({documentId:doc.id,baseRevision:doc.revision,selection:doc.selection,device:$('cs-device').value.toLowerCase(),instruction:$('cs-instruction').value,targets:editor.getSelectedAll().map(E.target)},null,2);
 }));
 $('cs-reload').addEventListener('click',action(async()=>{if(version!==savedVersion&&!window.confirm('현재 편집을 JSON으로 내보냈는지 확인하세요. 저장되지 않은 편집을 버리고 최신 문서를 열까요?'))return;load(await call(window.hub.studioRead,doc.id));}));
 $('cs-figma-show').addEventListener('click',action(async()=>{$('cs-figma-frame').src=await call(window.hub.studioFigma,$('cs-figma-url').value.trim());}));
 setInterval(async()=>{
  if(polling||!document.querySelector('#tab-creation.active'))return;polling=true;
  try{
   if(job){const r=await call(window.hub.studioAiPoll,job);if(r.state!=='running'){job=null;$('cs-ai-cancel').disabled=true;status(r.state==='succeeded'?'AI 변경안 도착 · 적용 전에 확인하세요.':(r.reason||r.state));if(aiRevision===doc?.id)await inbox();}}
   else await inbox();
  }catch(e){status(e.message);job=null;$('cs-ai-cancel').disabled=true;}finally{polling=false;}
 },3000);
 return{open:action(async()=>{if(!initializing)initializing=init().finally(()=>{initializing=null;});await initializing;}),insertImage};
})();

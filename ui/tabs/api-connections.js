'use strict';
(() => {
 let profiles=[],presets=[];
 const routesOf=()=>$('api-routes').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
 function clear(){for(const id of ['api-id','api-name','api-origin','api-secret','api-spec-url'])$(id).value='';$('api-auth').value='bearer';$('api-header').value='X-API-Key';$('api-budget').value='8';$('api-routes').value='/';$('api-allow-write').checked=false;$('api-preset').value='';$('api-preset-hint').textContent='';$('api-id').disabled=false;$('api-origin').disabled=false;$('api-secret').disabled=false;}
 function select(p){clear();$('api-id').value=p.id;$('api-id').disabled=true;$('api-name').value=p.name;$('api-origin').value=p.origin;$('api-origin').disabled=true;$('api-auth').value=p.auth;$('api-header').value=p.authHeader;$('api-budget').value=p.maxCallsPerRun;$('api-routes').value=(p.allowedRoutes||['/']).join('\n');$('api-spec-url').value=p.specUrl||'';$('api-allow-write').checked=p.allowWrite===true;$('api-secret').disabled=p.auth==='none';}
 function applyPreset(id){
  const preset=presets.find(entry=>entry.id===id);
  clear();
  if(!preset)return;
  const existing=profiles.find(profile=>profile.id===id);
  if(existing && existing.origin !== preset.origin){
   $('api-preset-hint').textContent='이 연결 ID가 다른 서비스 주소에 등록되어 있습니다. 기존 연결을 확인한 뒤 이 프리셋을 사용하세요.';
   return;
  }
  if(existing)select(existing);
  else{
   $('api-id').value=preset.id;
   $('api-name').value=preset.name;
   $('api-origin').value=preset.origin;
   $('api-auth').value=preset.auth;
   $('api-routes').value=preset.allowedRoutes.join('\n');
  }
  if(preset.authHeader){
   $('api-auth').value=preset.auth;
   $('api-header').value=preset.authHeader;
   $('api-secret').disabled=false;
  }
  $('api-preset').value=preset.id;
  $('api-preset-hint').textContent=preset.hint||'';
 }
 const geminiCheckButton = profile => profile.id === 'gemini'
  ? '<button data-gemini-check' + (profile.keyStored ? '' : ' disabled') + '>Gemini 읽기 확인</button>' : '';
 async function checkGemini(button) {
  button.disabled = true;
  const result = $('api-result');
  result.textContent = 'Gemini 모델 목록 읽기를 확인하고 있습니다.';
  try {
   const {httpStatus,listed} = await call(window.hub.localGeminiCheck);
   if (httpStatus === 401 || httpStatus === 403) {
    result.textContent = 'Gemini 읽기 실패 (HTTP ' + httpStatus + '). Google에서 이 PC용 API 키의 활성 상태와 프로젝트·앱 제한을 확인하세요. 새 키가 있으면 이 연결을 편집해 저장한 뒤 다시 확인하세요.';
   } else if (httpStatus >= 200 && httpStatus < 300 && listed) {
    result.textContent = 'Gemini 모델 목록 읽기에 성공했습니다.';
   } else {
    result.textContent = 'Gemini 모델 목록을 확인할 수 없습니다 (HTTP ' + httpStatus + ').';
   }
  } catch (e) { result.textContent = e.message; }
  finally { button.disabled = false; }
 }
 const specText=o=>!o?'':o.error?' · <span class="warn">명세 오류: '+esc(o.error.message)+(o.count?' (이전 '+o.count+'개 유지)':'')+'</span>':' · 명세 작업 '+o.count+'개'+(o.truncated?' (상한까지)':'');
 const specNote=s=>!s?' 저장된 명세 목록을 지웠습니다.':s.error?' 명세 받기 실패: '+s.error.message+(s.count?' — 이전 목록 '+s.count+'개를 유지합니다.':''):' 명세에서 허용 경로 안의 작업 '+s.count+'개'+(s.truncated?'(전체 '+s.total+'개 중 상한까지)':'')+'를 읽었습니다.';
 async function refresh(){
  try{
   profiles=await call(window.hub.localApiList);
   $('api-list').innerHTML=profiles.length?profiles.map(p=>'<div class="row"><span style="flex:1"><b>'+esc(p.id)+'</b> · '+esc(p.origin)+' · '+esc(p.auth)+' · 키 '+(p.keyStored?'저장됨':'없음')+' · 호출 상한 '+p.maxCallsPerRun+'회 · AI 쓰기 '+(p.allowWrite?'<span class="warn">허용</span>':'막음')+specText(p.operations)+'</span><button data-api-edit="'+esc(p.id)+'">편집</button>'+geminiCheckButton(p)+(p.specUrl?'<button data-api-spec="'+esc(p.id)+'">명세 다시 읽기</button>':'')+'<button class="danger" data-api-remove="'+esc(p.id)+'">연결·키 삭제</button></div>').join(''):'이 PC에 등록한 API 연결이 없습니다.';
   document.querySelector('[data-gemini-check]')?.addEventListener('click', event=>checkGemini(event.currentTarget));
   document.querySelectorAll('[data-api-edit]').forEach(b=>b.addEventListener('click',()=>select(profiles.find(p=>p.id===b.dataset.apiEdit))));
   document.querySelectorAll('[data-api-spec]').forEach(b=>b.addEventListener('click',async()=>{b.disabled=true;try{$('api-result').textContent=b.dataset.apiSpec+':'+specNote(await call(window.hub.localApiSpecRefresh,b.dataset.apiSpec));await refresh();}catch(e){toast(e.message,true);}finally{b.disabled=false;}}));
   document.querySelectorAll('[data-api-remove]').forEach(b=>b.addEventListener('click',async()=>{try{await call(window.hub.localApiRemove,b.dataset.apiRemove);clear();refresh();}catch(e){toast(e.message,true);}}));
  }catch(e){$('api-result').textContent=e.message;}
 }
 $('api-new').addEventListener('click',clear);
 $('api-refresh').addEventListener('click',refresh);
 $('api-preset').addEventListener('change',()=>applyPreset($('api-preset').value));
 for(const [id,op] of [['club-start','clubStart'],['club-stop','clubStop']]) $(id).addEventListener('click',async()=>{
   try{const r=await call(window.hub[op]);$('api-result').textContent=r.running?'동아리 봇이 이 PC에서 실행 중입니다.':r.enabled?'동아리 봇의 등록된 범위를 확인하세요.':'동아리 봇이 꺼져 있습니다.';}
   catch{$('api-result').textContent='동아리 봇 시작·중지 실패. 허용 대상, Discord 연결과 길드 명령 권한을 확인하세요.';}
 });
 $('api-save').addEventListener('click',async()=>{
  const field=$('api-secret'),secret=field.value;field.value='';
  const id=$('api-id').value.trim(),specUrl=$('api-spec-url').value.trim(),before=profiles.find(p=>p.id===id);
  try{
   await call(window.hub.localApiSave,{id,name:$('api-name').value.trim(),origin:$('api-origin').value.trim(),auth:$('api-auth').value,authHeader:$('api-header').value.trim(),maxCallsPerRun:Number($('api-budget').value),allowedRoutes:routesOf(),allowWrite:$('api-allow-write').checked,specUrl:specUrl||undefined},secret||undefined);
   let note='이 PC의 API 연결을 저장했습니다. 키는 OS 암호화 저장소에 보관합니다.';
   // 명세 주소나 허용 경로가 바뀌었을 때만 다시 받는다 — 줄인 목록이 경로 범위로 걸러져 있기 때문이다.
   if((before?.specUrl||'')!==specUrl||(specUrl&&(before?.allowedRoutes||[]).join('\n')!==routesOf().join('\n'))){$('api-result').textContent=note+' 명세를 받는 중…';note+=specNote(await call(window.hub.localApiSpecRefresh,id));}
   $('api-result').textContent=note;await refresh();
  }
  catch(e){$('api-result').textContent=e.message;}
 });
 $('api-auth').addEventListener('change',()=>{$('api-secret').disabled=$('api-auth').value==='none';$('api-secret').value='';});
 window.apiPipelineConnections={firstId:()=>profiles[0]?.id||'my-api',refresh};
 call(window.hub.localApiPresets).then(list=>{presets=list;$('api-preset').innerHTML='<option value="">직접 입력</option>'+list.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join('');}).catch(()=>{});
 refresh();
})();

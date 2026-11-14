'use strict';
// 설정 › 외부 연결의 Hub 자신의 로컬 주소, URL 참조 편집기, MCP 서버 요약, 다른 화면에서 이 칸으로 오는 단추. API 편집기는 api-connections.js.
(() => {
 let refs=[];
 const openTab=tab=>document.querySelector('#tabs button[data-tab="'+tab+'"]')?.click();
 function clear(){for(const id of ['url-id','url-name','url-address'])$(id).value='';$('url-id').disabled=false;}
 const state=r=>r.error?'<span class="warn">받기 실패: '+esc(r.error.message)+'</span>'+(r.fetchedAt?' · 이전 스냅숏 유지':''):r.fetchedAt?'받음 '+esc(new Date(r.fetchedAt).toLocaleString())+' · '+r.chars.toLocaleString()+'자'+(r.truncated?' (상한에서 자름)':''):'아직 받지 않음';
 async function refreshUrls(){
  try{
   refs=await call(window.hub.localUrlList);
   $('url-list').innerHTML=refs.length?refs.map(r=>'<div class="row"><span style="flex:1"><b>'+esc(r.id)+'</b> · '+esc(r.title||r.name)+' · <span class="hint">'+esc(r.url)+'</span> · '+state(r)+'</span><button data-url-fetch="'+esc(r.id)+'">다시 받기</button><button data-url-edit="'+esc(r.id)+'">편집</button><button class="danger" data-url-remove="'+esc(r.id)+'">삭제</button></div>').join(''):'이 PC에 등록한 URL 참조가 없습니다.';
   document.querySelectorAll('[data-url-edit]').forEach(b=>b.addEventListener('click',()=>{const r=refs.find(x=>x.id===b.dataset.urlEdit);$('url-id').value=r.id;$('url-id').disabled=true;$('url-name').value=r.name;$('url-address').value=r.url;}));
   document.querySelectorAll('[data-url-fetch]').forEach(b=>b.addEventListener('click',async()=>{b.disabled=true;try{const r=await call(window.hub.localUrlRefresh,b.dataset.urlFetch);$('url-result').textContent=r.error?'받기 실패: '+r.error.message:r.id+': '+r.chars.toLocaleString()+'자를 받았습니다.';await refreshUrls();}catch(e){toast(e.message,true);}finally{b.disabled=false;}}));
   document.querySelectorAll('[data-url-remove]').forEach(b=>b.addEventListener('click',async()=>{try{await call(window.hub.localUrlRemove,b.dataset.urlRemove);clear();refreshUrls();}catch(e){toast(e.message,true);}}));
  }catch(e){$('url-result').textContent=e.message;}
 }
 // 도구 수는 이미 연결된 서버만 센다 — 연결 안 된 stdio 서버를 요약 때문에 띄우지 않게.
 async function refreshMcpSummary(){
  try{
   const servers=await call(window.hub.dsList);
   const counts=await Promise.all(servers.map(s=>s.connected?call(window.hub.dsTools,s.name).then(t=>t.length,()=>null):null));
   $('ext-mcp-list').innerHTML=servers.length?'<tr><th>이름</th><th>유형</th><th>상태</th><th>도구</th></tr>'+servers.map((s,i)=>'<tr><td>'+esc(s.name)+'</td><td>'+esc(s.type)+'</td><td>'+(s.enabled===false?'꺼짐':s.connected?'<span class="ok">연결됨</span>':'대기')+'</td><td>'+(counts[i]===null?'<span class="hint">연결 뒤 표시</span>':counts[i]+'개')+'</td></tr>').join(''):'<tr><td class="hint">등록한 MCP 서버가 없습니다.</td></tr>';
  }catch(e){$('ext-mcp-list').innerHTML='<tr><td class="warn">'+esc(e.message)+'</td></tr>';}
 }
 // 대시보드 hub-url과 같은 값(status.hub.url, 포트는 설정). status에는 토큰이 없고 여기서도 다루지 않는다. 복사는 mcp.js의 [data-copy].
 async function refreshHubUrls(){
  try{const hub=(await call(window.hub.status)).hub;$('ext-hub-mcp-url').textContent=hub.url;$('ext-hub-health-url').textContent=new URL('/health',hub.url).href;$('ext-hub-state').textContent=(hub.running?'실행 중':'중지됨 — 대시보드에서 다시 시작')+' · 토큰 인증 '+(hub.requireAuth?'켜짐':'꺼짐');}
  catch(e){$('ext-hub-state').textContent=e.message;}
 }
 // Drive 동기화 폴더(기기 전용 설정)와 채팅 명령 도움말. 확인은 비동기·시간 상한으로만 Drive를 본다(drive-sync-folder.js).
 const driveState=v=>v.error?'<span class="warn">'+esc(v.error)+'</span>':'사용할 루트: '+esc(v.effectiveRoot)+(v.auto?' (자동 탐지)':'')+' · 쓰기 '+(v.allowWrite?'허용':'꺼짐');
 async function refreshDrive(){try{const v=await call(window.hub.cmdDriveGet);$('drive-root').value=v.root;$('drive-allow-write').checked=v.allowWrite;$('drive-result').innerHTML=driveState(v);}catch(e){$('drive-result').textContent=e.message;}}
 async function refreshCommandHelp(){
  try{const c=await call(window.hub.cmdCatalog);
   $('cmd-help-list').innerHTML='<tr><th>명령·태그</th><th>설명</th></tr>'+c.commands.map(x=>'<tr><td><code>'+esc(x.usage)+'</code></td><td>'+esc(x.about)+(x.write?' <span class="warn">쓰기 · 확인 필요</span>':'')+'</td></tr>').join('')
    +'<tr><td><code>@연결ID [검색어]</code></td><td>연결 요약과 맞는 API 작업·MCP 도구 — '+(c.tags.length?c.tags.map(t=>esc(t.tag)).join(' '):'등록한 연결 없음')+'</td></tr>';}
  catch(e){$('cmd-help-list').innerHTML='<tr><td class="warn">'+esc(e.message)+'</td></tr>';}
 }
 $('drive-save').addEventListener('click',async()=>{try{await call(window.hub.cmdDriveSave,{root:$('drive-root').value.trim(),allowWrite:$('drive-allow-write').checked});toast('Drive 설정을 이 PC에 저장했습니다.');await refreshDrive();}catch(e){$('drive-result').textContent=e.message;}});
 $('drive-check').addEventListener('click',()=>{$('drive-result').textContent='확인 중…';refreshDrive();});
 $('drive-editor').addEventListener('toggle',()=>{if($('drive-editor').open)refreshDrive();});
 $('cmd-help').addEventListener('toggle',()=>{if($('cmd-help').open)refreshCommandHelp();});
 $('url-new').addEventListener('click',clear);
 $('url-reload').addEventListener('click',refreshUrls);
 $('url-save').addEventListener('click',async()=>{
  const b=$('url-save');b.disabled=true;$('url-result').textContent='문서를 받는 중…';
  try{const r=await call(window.hub.localUrlSave,{id:$('url-id').value.trim(),name:$('url-name').value.trim(),url:$('url-address').value.trim()});$('url-result').textContent=r.error?'등록했지만 받기에 실패했습니다: '+r.error.message:'등록하고 '+r.chars.toLocaleString()+'자를 받았습니다. AI는 url_reference_read로 읽습니다.';clear();await refreshUrls();}
  catch(e){$('url-result').textContent=e.message;}finally{b.disabled=false;}
 });
 $('ext-mcp-reload').addEventListener('click',refreshMcpSummary);
 $('ext-mcp-open').addEventListener('click',()=>{openTab('aider');document.querySelector('[data-aider-panel="connections"]')?.click();setTimeout(()=>$('ds-list')?.scrollIntoView({block:'center'}),100);});
 $('vault-goto-external').addEventListener('click',()=>{openTab('settings');$('api-editor').open=true;setTimeout(()=>$('ext-connections').scrollIntoView({block:'start'}),100);});
 document.querySelector('#tabs button[data-tab="settings"]')?.addEventListener('click',()=>{window.apiPipelineConnections?.refresh();refreshHubUrls();refreshUrls();refreshMcpSummary();});
 refreshUrls();
})();

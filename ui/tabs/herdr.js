'use strict';
window.herdrUI=(()=>{
 const inflight=new Set();let polling=false;
 const action=fn=>async()=>{try{await fn();}catch(e){$('hd-output').textContent=e.message;toast(e.message,true);}};
 const session=()=>$('hd-session').value.trim()||'default';
 async function refresh(){
  const list=await call(window.hub.herdrInspect,{action:'sessions'});$('hd-sessions').textContent=list.available?(list.sessions||[]).map(s=>s.name+' · '+(s.running?'실행 중':'중지')).join('\n'):list.message;
  if(!list.available)return;
  const result=await call(window.hub.herdrInspect,{session:session(),action:'snapshot'}),snapshot=result.snapshot||{};
  $('hd-agents').textContent=result.running===false?result.message:JSON.stringify({agents:snapshot.agents||[],panes:(snapshot.panes||[]).map(p=>({pane:p.pane_id,workspace:p.workspace_id,state:p.agent_status})),workspaces:snapshot.workspaces||[]},null,2);
  $('hd-target').innerHTML=(snapshot.panes||[]).map(p=>'<option value="'+esc(p.pane_id)+'">'+esc(p.pane_id)+' · '+esc(p.agent_status)+'</option>').join('');
  const projects=await call(window.hub.projList);$('hd-project').innerHTML=projects.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join('');
 }
 $('hd-refresh').addEventListener('click',action(refresh));
 $('hd-read').addEventListener('click',action(async()=>{$('hd-output').textContent=await call(window.hub.herdrInspect,{session:session(),action:'read',target:$('hd-target').value});}));
 $('hd-wait').addEventListener('click',action(async()=>{
  $('hd-wait').disabled=true;try{$('hd-output').textContent=JSON.stringify(await call(window.hub.herdrInspect,{session:session(),action:'wait',target:$('hd-target').value,until:'done'}),null,2);}finally{$('hd-wait').disabled=false;}
 }));
 async function control(p){
  const result=await call(window.hub.herdrControl,{requestId:crypto.randomUUID(),session:session(),...p});
  if(result.id)inflight.add(result.id);$('hd-output').textContent=JSON.stringify(result,null,2);
 }
 $('hd-prompt').addEventListener('click',action(()=>control({action:'prompt',target:$('hd-target').value,prompt:$('hd-instruction').value,wait:true,until:'done',timeoutMs:300000})));
 $('hd-start').addEventListener('click',action(()=>control({action:'start',target:$('hd-target').value,kind:$('hd-kind').value,name:$('hd-name').value.trim()})));
 $('hd-split').addEventListener('click',action(()=>control({action:'split',target:$('hd-target').value,direction:'right'})));
 $('hd-workspace').addEventListener('click',action(()=>control({action:'workspace',projectId:$('hd-project').value})));
 $('hd-session-start').addEventListener('click',action(()=>control({action:'session'})));
 setInterval(async()=>{
  if(polling||!inflight.size)return;polling=true;
  try{for(const id of inflight){const result=await call(window.hub.herdrStatus,id);if(result.state!=='running'){inflight.delete(id);$('hd-output').textContent=JSON.stringify(result,null,2);}}}catch(e){$('hd-output').textContent=e.message;}finally{polling=false;}
 },2500);
 return{refresh:action(refresh)};
})();

'use strict';
window.hub.onPanelNavigate(({tab,section})=>{
 tab=destinationTab(tab,section);
 const allowed=['dashboard','aider','delegate','memory','skills','source','learning','settings','mcp','pipelines'];
 if(!allowed.includes(tab))return;
 const button=[...document.querySelectorAll('#tabs button')].find(b=>b.dataset.tab===tab);
 if(tab==='learning' && button?.hidden)return;
 if(button)button.click();
 else{
  document.querySelectorAll('#tabs button').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  $('tab-'+tab)?.classList.add('active');
  if(tab==='delegate')refreshDelegate();if(tab==='mcp')refreshMcp();
 }
 setTimeout(()=>{
  const target=section?$(section):null;
  if(section==='local-runtime-status')document.querySelector('[data-aider-panel="models"]')?.click();
  if(section==='mcp-http-box')document.querySelector('[data-aider-panel="connections"]')?.click();
  if(section==='vault-provider')target?.closest('details')?.setAttribute('open','');
  target?.scrollIntoView({block:'center'});
  if(target?.matches('button,input,select'))target.focus();
 },100);
});

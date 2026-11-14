'use strict';
(() => {
  const el=name=>$('device-key-'+name);
  const names={discord:'Discord',gemini:'Gemini API'};
  let request, envelope, busy=false;
  function directInput() {
    const direct=el('source').value==='';
    el('secret').value='';
    el('secret').disabled=!direct;
    el('secret').hidden=!direct;
    el('secret').labels[0].hidden=!direct;
  }
  function resetSources() {
    el('source').replaceChildren(new Option('새 키 직접 입력',''));
    directInput();
  }
  function closeSend() {
    request=null;
    el('send-form').hidden=true;
    el('recipient').value='';
    resetSources();
  }
  function closeReceive() {
    envelope=null;
    el('receive-form').hidden=true;
    el('sender').value='';
  }
  function action(name,work) {
    el(name).addEventListener('click',async ()=>{
      if (busy) return;
      busy=true;
      const button=el(name);
      button.disabled=true;
      el('result').textContent='';
      try { await work(); }
      catch (error) { el('result').textContent=error.message; }
      finally { button.disabled=false; busy=false; }
    });
  }
  const fields=(record,fingerprint)=>({ticket:record.ticket,provider:record.info.provider,...fingerprint});
  const recipient=()=>({expectedRecipientFingerprint:el('recipient').value.trim()});
  action('show',async ()=>{
    const identity=await call(window.hub.deviceKeyIdentity);
    el('identity').textContent=identity.deviceLabel+' · '+identity.fingerprint;
  });
  action('request',async ()=>{
    const result=await call(window.hub.deviceKeyRequest,el('provider').value);
    if(result.identity)el('identity').textContent=result.identity.deviceLabel+' · '+result.identity.fingerprint;
    el('result').textContent=result.canceled?'카드 저장을 취소했습니다.':'요청 카드를 저장했습니다. 발신 PC에 카드를 전달하고 이 PC의 지문을 별도 경로로 알려주세요.';
  });
  action('open-request',async ()=>{
    closeSend();
    const result=await call(window.hub.deviceKeyOpenRequest);
    if(result.canceled){el('result').textContent='카드 열기를 취소했습니다.';return;}
    request=result;
    const {info}=result;
    el('request-info').textContent=[names[info.provider]+' · '+info.origin,'수신 PC '+info.recipientLabel,
      '파일의 수신 지문 '+info.recipientFingerprint,'만료 '+new Date(info.expiresAt).toLocaleString()].join('\n');
    el('send-form').hidden=false;
    el('recipient').focus();
  });
  el('recipient').addEventListener('input',resetSources);
  el('source').addEventListener('change',directInput);
  action('sources',async ()=>{
    resetSources();
    const aliases=await call(window.hub.deviceKeySources,fields(request,recipient()));
    for(const alias of aliases){
      el('source').add(new Option(alias.id+(alias.bound?' · 이 기기에 배정됨':' · 최초 배정 확인 필요'),alias.id));
    }
    el('result').textContent=aliases.length?'배정할 연결 ID를 선택하거나 새 키를 입력하세요.':'대상에 배정할 저장 키가 없습니다. 해당 PC 전용 키를 직접 입력하세요.';
  });
  action('export',async ()=>{
    const sourceAlias=el('source').value, secret=el('secret').value;
    el('secret').value='';
    if(!sourceAlias && !secret.trim())throw Error('해당 PC에서 사용할 키를 입력하세요.');
    const result=await call(window.hub.deviceKeyExport,{...fields(request,recipient()),...(sourceAlias?{sourceAlias}:{secret})});
    if(result.canceled){el('result').textContent='키 배정을 취소했습니다.';return;}
    closeSend();
    el('result').textContent='암호화 파일을 저장했습니다. 수신 PC에 파일을 전달하고 발신 PC의 지문을 별도 경로로 알려주세요.';
  });
  action('open-envelope',async ()=>{
    closeReceive();
    const result=await call(window.hub.deviceKeyOpenEnvelope);
    if(result.canceled){el('result').textContent='파일 열기를 취소했습니다.';return;}
    envelope=result;
    const {info}=result;
    el('envelope-info').textContent=[names[info.provider]+' · '+info.origin,'발신 PC '+info.senderLabel,
      '파일의 발신 지문 '+info.senderFingerprint,'수신 PC '+info.recipientLabel,'수신 지문 '+info.recipientFingerprint,
      info.alreadyReceived?'이 PC에서 이미 받은 파일입니다.':info.alreadyStored?'이 PC에 기존 키가 있습니다. 저장 시 교체 여부를 확인합니다.':'이 PC에 새 키를 등록합니다.'].join('\n');
    el('receive-form').hidden=false;
    el('sender').focus();
  });
  action('receive',async ()=>{
    const result=await call(window.hub.deviceKeyReceive,fields(envelope,{expectedSenderFingerprint:el('sender').value.trim()}));
    if(result.canceled){el('result').textContent='금고 저장을 취소했습니다.';return;}
    closeReceive();
    el('result').textContent=result.alreadyReceived
      ? result.stored?'이 PC에서 이미 받은 키입니다.':'이미 받은 파일이며 현재 연결은 해제되어 있습니다.'
      :'이 PC의 암호화 금고에 저장했습니다.';
    await window.apiPipelineConnections?.refresh();
  });
  el('panel').addEventListener('toggle',()=>{
    if(!el('panel').open){closeSend();closeReceive();el('result').textContent='';}
  });
  document.querySelectorAll('#tabs button[data-tab]').forEach(button=>{
    if(button.dataset.tab!=='settings')button.addEventListener('click',()=>{
      closeSend();closeReceive();el('result').textContent='';
    });
  });
  window.addEventListener('pagehide',()=>{closeSend();closeReceive();});
})();

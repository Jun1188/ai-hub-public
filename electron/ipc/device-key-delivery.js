'use strict';
const fs = require('node:fs/promises');
const {randomUUID} = require('node:crypto');
const {AsyncLocalStorage} = require('node:async_hooks');
const frameAuthority=new AsyncLocalStorage();

const limit = 64 * 1024;
const types = {
  request: {name:'Hub 기기 요청 카드',ext:'hubrequest'},
  envelope: {name:'Hub 기기 암호화 키',ext:'hubkey'}
};
const filters = type => [{name:type.name,extensions:[type.ext]}];
const providerName = provider => ({discord:'Discord',gemini:'Gemini'})[provider];
const messages = {
  device_fingerprint_confirmation_failed:'별도로 받은 64자리 기기 지문과 일치하지 않습니다.',
  device_key_signature_invalid:'파일 서명이 올바르지 않습니다.',
  device_key_request_expired_or_invalid:'요청이 만료되었거나 유효하지 않습니다. 수신 PC에서 새 카드를 만드세요.',
  device_key_wrong_recipient:'이 PC에 배정한 파일이 아닙니다.',
  device_key_request_unknown:'이 PC에서 발급한 요청 카드를 찾지 못했습니다.',
  device_key_request_replaced:'요청 카드가 교체됐습니다. 최신 카드를 사용하세요.',
  device_key_replacement_required:'기존 키 교체를 다시 확인하세요.',
  device_key_target_changed:'미리보기 이후 이 PC의 연결 또는 키가 바뀌었습니다. 파일을 다시 열어 현재 상태를 확인하세요.',
  device_key_source_changed:'선택한 연결의 키가 바뀌었습니다. 기기 전용 키 목록을 다시 확인하세요.',
  device_key_assigned_elsewhere:'이 키는 다른 기기에 이미 배정했습니다. 대상 PC의 독립 키를 선택하세요.',
  device_key_primary_forbidden:'이 PC의 운영 키입니다. 수신 PC 전용으로 발급한 별도 키를 선택하세요.',
  device_key_request_superseded:'이 요청을 대신하는 새 봉투가 있습니다. 최신 파일을 받으세요.',
  invalid_device_credential:'공급자가 발급한 기기 전용 키를 확인하세요. 공백이나 줄바꿈은 허용되지 않습니다.',
  device_key_storage_unavailable:'현재 Windows 사용자로 기기 금고를 열 수 없습니다.',
  device_key_provider_mismatch:'서비스 또는 등록된 연결 주소가 일치하지 않습니다.',
  device_key_self_delivery:'다른 기기의 요청 카드를 선택하세요.',
  device_key_busy:'다른 금고 작업이 끝난 뒤 다시 시도하세요.'
};

function isTrustedFrame(event, browserWindow, indexUrl) {
  try {
    if (!browserWindow || browserWindow.isDestroyed() || event.sender!==browserWindow.webContents ||
        !event.senderFrame || event.senderFrame!==event.sender.mainFrame) return false;
    const url=new URL(event.senderFrame.url);
    url.hash='';
    return url.href===indexUrl;
  } catch { return false; }
}

function assertFrame() {
  if (!frameAuthority.getStore()?.()) throw Error('기기 키는 처음 요청한 Hub의 기본 설정 창에서만 관리할 수 있습니다.');
}

async function withTrustedFrame(event,getWindow,indexUrl,work) {
  const initialWindow=getWindow(), frame=event.senderFrame,contents=event.sender;
  if (!isTrustedFrame(event,initialWindow,indexUrl)) throw Error('기기 키는 Hub의 기본 설정 창에서만 관리할 수 있습니다.');
  let changed=false;
  const navigate=(_event,_url,sameDocument,mainFrame)=>{
    // Electron 45 supplies navigation details. Older Electron versions supply positional fields.
    const detail=typeof _event?.isMainFrame==='boolean'?_event:typeof _url==='object'?_url:null;
    const main=detail?detail.isMainFrame:mainFrame;
    const same=detail?(detail.isSameDocument??detail.isInPlace):sameDocument;
    if(main!==false && !same)changed=true;
  };
  contents.on('did-start-navigation',navigate);
  try {
    return await frameAuthority.run(()=>!changed && getWindow()===initialWindow &&
      event.senderFrame===frame && isTrustedFrame(event,initialWindow,indexUrl),async()=>{
      assertFrame();
      const result=await work();
      assertFrame();
      return result;
    });
  } finally { contents.removeListener('did-start-navigation',navigate); }
}

async function readDocument(file) {
  const handle = await fs.open(file,'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > limit) throw Error();
    const data = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < data.length) {
      const {bytesRead} = await handle.read(data,size,data.length-size,size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw Error();
    return JSON.parse(data.toString('utf8',0,size));
  } finally { await handle.close(); }
}

function register({handle,window}, {dialog=require('electron').dialog,
  service=()=>require('../../src/core/device-key-delivery').instance()}={}) {
  let pendingRequest, pendingEnvelope, busy=false;
  const guarded = (operation, fallback) => async (...args) => {
    assertFrame();
    if (busy) throw Error('다른 기기 키 작업을 마친 후 다시 시도하세요.');
    busy=true;
    try { return await operation(...args); }
    catch (error) {
      const code=Object.hasOwn(messages,error?.code)?error.code:error?.message;
      throw Error(Object.hasOwn(messages,code)?messages[code]:fallback);
    }
    finally { busy=false; }
  };
  async function open(type, inspect) {
    const choice=await dialog.showOpenDialog(window(),{title:type.name+' 열기',properties:['openFile'],filters:filters(type)});
    assertFrame();
    if (choice.canceled || choice.filePaths.length!==1) return null;
    const document=await readDocument(choice.filePaths[0]);
    assertFrame();
    return {ticket:randomUUID(),document,info:inspect(document)};
  }
  async function save(type, provider, make) {
    const choice=await dialog.showSaveDialog(window(),{title:type.name+' 저장',
      defaultPath:provider+'.'+type.ext,filters:filters(type)});
    assertFrame();
    if (choice.canceled || !choice.filePath) return {canceled:true};
    if (!choice.filePath.toLowerCase().endsWith('.'+type.ext)) throw Error();
    const temporary=choice.filePath+'.tmp-'+randomUUID();
    let created=false;
    try {
      const text=JSON.stringify(make())+'\n';
      const file=await fs.open(temporary,'wx',0o600);
      created=true;
      try {assertFrame();await file.writeFile(text,'utf8');} finally {await file.close();}
      assertFrame();
      await fs.rename(temporary,choice.filePath);
      created=false;
    } finally { if(created)await fs.unlink(temporary); }
    return {canceled:false};
  }
  handle('deviceKey:identity',guarded(()=>service().identity(),'이 PC의 로컬 기기 지문을 열 수 없습니다.'));
  handle('deviceKey:request',guarded(async provider=>{
    if (!['discord','gemini'].includes(provider)) throw Error();
    let identity;
    const result=await save(types.request,provider,()=>{
      identity=service().identity();
      return service().createRequest(provider);
    });
    if(!result.canceled)result.identity=identity;
    return result;
  },'요청 카드를 저장하지 못했습니다. 저장 위치와 기기 금고를 확인하세요.'));
  handle('deviceKey:openRequest',guarded(async ()=>{
    pendingRequest=null;
    pendingRequest=await open(types.request,d=>service().inspectRequest(d));
    return pendingRequest ? {ticket:pendingRequest.ticket,info:pendingRequest.info} : {canceled:true};
  },'요청 카드를 열 수 없습니다. 파일 형식·서명·유효기간을 확인하세요.'));
  function sources(ticket,expectedRecipientFingerprint,provider) {
    if (!pendingRequest || pendingRequest.ticket!==ticket || pendingRequest.info.provider!==provider) throw Error();
    return service().sourceAliases({request:pendingRequest.document,expectedRecipientFingerprint,provider});
  }
  handle('deviceKey:sources',guarded(({ticket,expectedRecipientFingerprint,provider})=>{
    const aliases=sources(ticket,expectedRecipientFingerprint,provider);
    pendingRequest.aliases=new Map(aliases.map(alias=>[alias.id,alias]));
    return aliases.map(({id,bound})=>({id,bound:bound===true}));
  },'수신 PC 지문과 요청 카드의 대상이 일치하는지 확인하세요.'));
  handle('deviceKey:export',guarded(async ({ticket,expectedRecipientFingerprint,provider,secret,sourceAlias})=>{
    if (!pendingRequest || pendingRequest.ticket!==ticket || pendingRequest.info.provider!==provider) throw Error();
    let confirmBindAlias=false,expectedSourceRevision;
    if (sourceAlias!==undefined) {
      if (typeof sourceAlias!=='string' || secret!==undefined) throw Error();
      const alias=sources(ticket,expectedRecipientFingerprint,provider).find(row=>row.id===sourceAlias);
      const shown=pendingRequest.aliases?.get(sourceAlias);
      if (!shown || !alias || shown.revision!==alias.revision || shown.bound!==alias.bound) throw Error('device_key_source_changed');
      expectedSourceRevision=shown.revision;
      const info=pendingRequest.info;
      const action=alias.bound?'암호화 파일 만들기':'기기에 고정하고 파일 만들기';
      const answer=await dialog.showMessageBox(window(),{type:'question',title:'등록된 기기 전용 키 배정',
        message:alias.bound?'이 기기에 배정한 키를 보낼까요?':'이 연결의 키를 이 수신 기기에 처음 배정할까요?',
        detail:[providerName(provider)+' · '+info.origin,'연결 ID '+alias.id,'수신 기기 '+info.recipientLabel,
          '수신 기기 지문 '+info.recipientFingerprint].join('\n'),buttons:['취소',action],defaultId:0,cancelId:0,noLink:true});
      assertFrame();
      if(answer.response!==1)return {canceled:true};
      confirmBindAlias=!alias.bound;
    }
    const written=await save(types.envelope,provider,()=>service().seal({request:pendingRequest.document,
      expectedRecipientFingerprint,provider,...(sourceAlias!==undefined ? {sourceAlias,confirmBindAlias,expectedSourceRevision} : {secret})}));
    if (!written.canceled) pendingRequest=null;
    return written;
  },'암호화 파일을 저장하지 못했습니다. 수신 기기 지문, 서비스, 입력 키, 카드 유효기간과 저장 위치를 확인하세요.'));
  handle('deviceKey:openEnvelope',guarded(async ()=>{
    pendingEnvelope=null;
    pendingEnvelope=await open(types.envelope,d=>service().inspectEnvelope(d));
    if (!pendingEnvelope) return {canceled:true};
    const {targetRevision,...info}=pendingEnvelope.info;
    return {ticket:pendingEnvelope.ticket,info};
  },'이 기기의 암호화 파일을 열 수 없습니다. 대상 기기·서명·요청 유효기간을 확인하세요.'));
  handle('deviceKey:receive',guarded(async ({ticket,expectedSenderFingerprint,provider})=>{
    if (!pendingEnvelope || pendingEnvelope.ticket!==ticket) throw Error();
    const {document}=pendingEnvelope;
    const info=service().inspectEnvelope(document);
    if (info.targetRevision!==pendingEnvelope.info.targetRevision) {
      pendingEnvelope=null;
      throw Error('device_key_target_changed');
    }
    if (info.provider!==provider || !providerName(provider)) throw Error();
    const local=service().identity().fingerprint;
    const normalized=String(expectedSenderFingerprint||'').replace(/[\s:-]/g,'').toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(normalized) || normalized!==info.senderFingerprint || local!==info.recipientFingerprint) throw Error('device_fingerprint_confirmation_failed');
    const name=providerName(provider);
    const action=info.alreadyReceived?'수신 기록 확인':info.alreadyStored?'기존 키 교체':'키 등록';
    const answer=await dialog.showMessageBox(window(),{type:'question',title:name+' 기기 키 수신',
      message:name+' '+action+'를 진행할까요?',
      detail:[info.origin,'발신 기기 지문 '+info.senderFingerprint,'수신 기기 지문 '+local,
        info.alreadyReceived?'이 PC에서 이미 받은 파일입니다.':info.alreadyStored?'이 PC에서 해당 서비스에 사용하던 기존 키를 교체합니다.':'이 PC의 암호화 금고에 해당 키를 저장합니다.'].join('\n'),
      buttons:['취소',action],defaultId:0,cancelId:0,noLink:true});
    assertFrame();
    if(answer.response!==1)return {canceled:true};
    const result=service().receive({envelope:document,expectedTargetRevision:pendingEnvelope.info.targetRevision,expectedSenderFingerprint:normalized,
      expectedRecipientFingerprint:local,provider,confirmReplace:info.alreadyStored===true});
    pendingEnvelope=null;
    return result;
  },'이 PC에 키를 등록하지 못했습니다. 별도로 받은 발신 지문, 대상 기기, 서비스, 유효기간과 기존 연결 상태를 확인하세요.'));
}

module.exports={register,isTrustedFrame,withTrustedFrame,assertFrame};

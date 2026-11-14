'use strict';
const {sha,readAttachment}=require('./files.cjs');
const field=(name,description,type,required=false,extras={})=>({name,description,type,required,...extras});
const command={name:'자료제출',description:'직접 선택한 자료와 첨부를 소모임 저장소의 검토 PR로 제출합니다.',type:1,options:[
  field('자료키','같은 자료를 수정할 때 다시 사용할 영문 소문자·숫자·하이픈 키',3,true,{max_length:48}),
  field('제목','검토자와 독자에게 표시할 제목',3,true,{max_length:100}),
  field('설명','본인이 작성한 자료 설명',3,true,{max_length:1500}),
  field('공유범위','제목·설명·링크·첨부를 선택한 대상에 제공하는 데 동의합니다.',3,true,{choices:[
    {name:'비공개 소모임 저장소 구성원에게만 제출',value:'members'},
    {name:'검토 PR 및 승인 후 공개 웹사이트 게재에 동의',value:'public'}]}),
  field('주소','게시 권한이 있는 HTTPS 자료 링크',3,false,{max_length:1024}),
  field('첨부','UTF-8 TXT·RGB/RGBA PNG·다운로드용 PDF. PNG 메타데이터 제거, TXT BOM 정규화.',11)
]};
const id=x=>typeof x==='string'&&/^\d{16,20}$/.test(x);
function safeLink(raw,hosts){
  if(!raw)return null;
  const u=new URL(raw);
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||!hosts.includes(u.hostname)||
    /(^|\.)(?:discordapp\.(?:com|net)|discord\.(?:com|gg))$/.test(u.hostname))throw Error('link_not_allowed');
  return u.href;
}
async function authorized(i,c){
  if(!id(c.guild)||i.guildId!==c.guild||!id(i.channelId)||!id(i.user?.id)||i.user.bot||!i.guild)return false;
  const ch=await i.guild.channels.fetch(i.channelId,{force:true});
  if(!ch||ch.guildId!==c.guild||ch.id!==i.channelId)return false;
  if([0,5].includes(ch.type))return c.channels.includes(ch.id);
  if(ch.type!==11||!c.forums.includes(ch.parentId))return false;
  if(c.threads !== undefined && !c.threads.includes(ch.id))return false;
  const parent=await i.guild.channels.fetch(ch.parentId,{force:true});
  return parent?.id===ch.parentId&&parent.guildId===c.guild&&parent.type===15;
}
function cleanText(value,max){
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw Error('invalid_text');
  if(/(?:cdn\.discordapp\.com|media\.discordapp\.net)\//i.test(value))throw Error('invalid_text');
  return value.trim();
}
async function handle(i,c,store,fetchCdn){
  if(!i.isChatInputCommand()||i.commandName!==command.name)return false;
  // In the configured thread allowlist mode, even ephemeral replies stay inside the approved channels.
  if(c.threads!==undefined){
    if(i.guildId!==c.guild||!c.channels.includes(i.channelId)&&!c.threads.includes(i.channelId))return false;
    if(!await authorized(i,c))return false;
  }
  await i.deferReply({flags:64});
  let message;
  try{
    if(c.threads===undefined&&!await authorized(i,c))throw Error('wrong_channel');
    const get=n=>i.options.getString(n);
    const key=get('자료키'), scope=get('공유범위');
    if(!/^[a-z0-9][a-z0-9-]{0,47}$/.test(key||'')||!['public','members'].includes(scope))throw Error('invalid_submission');
    if(scope==='public'&&!c.publicSiteEnabled)throw Error('public_disabled');
    const title=cleanText(get('제목'),100),description=cleanText(get('설명'),1500),url=safeLink(get('주소'),c.linkHosts);
    const a=i.options.getAttachment('첨부');
    if(!a&&!url)throw Error('missing_resource');
    await store.checkAudience(scope);
    const asset=a?await readAttachment(a,i.channelId,fetchCdn):null;
    const entryId=sha(Buffer.from([i.guildId,i.user.id,key].join(':'))).slice(0,32);
    const category=c.channels.includes(i.channelId)?'info':'news';
    const entry={schemaVersion:1,id:entryId,scope,category,title,description,url,
      attachment:asset?{name:asset.name,sha256:asset.sha256,bytes:asset.bytes,sourceSha256:asset.sourceSha256,sourceBytes:asset.sourceBytes}:null};
    message=await store.submit(entry,asset?.data);
    if(scope==='members')message+=' 대기 중인 공개 PR이 있다면 운영자에게 별도 철회를 요청하세요.';
  }catch(e){
    const labels={wrong_channel:'관리자가 지정한 제출 채널 또는 포럼에서 실행하세요.',public_disabled:'이 사이트에는 공개 제출이 설정되지 않았습니다.',
      missing_resource:'자료 주소 또는 첨부를 선택하세요.',link_not_allowed:'허용된 HTTPS 호스트의 공개 자료 주소를 입력하세요. 쿼리와 프래그먼트는 제외하세요.',
      private_required:'비공개 자료를 받을 저장소를 확인할 수 없습니다.',attachment_unavailable:'첨부를 다시 선택해 같은 자료키로 제출하세요.',
      unsupported_attachment:'UTF-8 TXT·RGB/RGBA PNG·PDF를 선택하세요.',hub_body_limit:'이 Hub의 GitHub 브로커 첨부 상한은 45 KiB입니다. 허용된 HTTPS 주소로 제출하세요.',
      github_budget:'GitHub 연결의 실행당 호출 상한에 도달했습니다. 운영자가 호출 예산을 확인한 뒤 같은 자료키로 재시도하세요.',
      public_exists:'같은 자료키의 공개본이 기준 브랜치에 있습니다. 운영자에게 공개 항목·배포본 철회를 요청한 뒤 비공개로 다시 제출하세요.',
      closed:'이 제출의 PR이 닫혔습니다. 기존 검토 결과를 확인하세요.'};
    message=labels[e.message]||'제출을 완료하지 못했습니다. 형식과 설정을 확인하고 같은 자료키로 재시도하세요.';
  }
  await i.editReply({content:message,allowedMentions:{parse:[]}});
  return true;
}
module.exports={command,safeLink,handle,authorized};

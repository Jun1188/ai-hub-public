'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { startFromHub } = require('./hub-start.cjs');
const snowflake = value => typeof value==='string' && /^\d{17,20}$/.test(value);
function scope(input) {
  if(input?.schemaVersion!==1 || ![input.guild,input.channel,input.forum,input.news,...(Array.isArray(input.threads)?input.threads:[])].every(snowflake) ||
     !Array.isArray(input.threads)||input.threads.length!==2||!input.threads.includes(input.news)||
     new Set([input.guild,input.channel,input.forum,...input.threads]).size!==5||
     typeof input.driveFolder!=='string'||!/^[A-Za-z0-9_-]{10,100}$/.test(input.driveFolder)) throw Error('invalid_club_scope');
  return {schemaVersion:1,guild:input.guild,channel:input.channel,forum:input.forum,threads:[...input.threads],news:input.news,driveFolder:input.driveFolder};
}
function service({dataDir,connections,broker,sdk,noticeSource,openGateway=startFromHub}) {
  const dir=path.join(dataDir,'club-materials'), file=path.join(dir,'permission.json');
  let running=null,busy=false;
  function saved() {
    try {return scope(JSON.parse(fs.readFileSync(file,'utf8')));}
    catch(err){if(err.code==='ENOENT')return null;throw err;}
  }
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const request=(job,method,route,body)=>broker.request({credentialRef:'credential:api-discord',operationId:'api.request',jobId:job,payload:{method,route,...(body?{body}:{})}});
  async function verify(c) {
    const p=connections.get('discord');
    if(p.origin!=='https://discord.com'||p.auth!=='bot'&&!(p.auth==='header'&&p.authHeader?.toLowerCase()==='authorization'))throw Error('discord_profile_required');
    const job='club-preflight:'+crypto.randomUUID();
    const [bot,channel,forum,...threads]=await Promise.all(['/api/v10/users/@me',...([c.channel,c.forum,...c.threads].map(id=>'/api/v10/channels/'+id))].map(route=>request(job,'GET',route)));
    if(!bot.bot||!snowflake(bot.id)||channel.id!==c.channel||![0,5].includes(channel.type)||channel.guild_id!==c.guild||
       forum.id!==c.forum||forum.type!==15||forum.guild_id!==c.guild||threads.some((t,i)=>t.id!==c.threads[i]||t.type!==11||
       t.parent_id!==c.forum||t.guild_id!==c.guild||t.thread_metadata?.archived!==false||t.thread_metadata?.locked!==false))throw Error('discord_targets_unverified');
  }
  async function start(value,enable=false) {
    if(busy)throw Error('gateway_operation_in_progress');
    const c=enable?scope(value):saved();
    if(!c)return {enabled:false,running:false};
    if(running){if(!same(saved(),c))throw Error('stop_before_scope_change');return {enabled:true,running:true};}
    busy=true;let handle;
    try{
      await verify(c);
      await fs.promises.mkdir(dir,{recursive:true,mode:0o700});
      const configured={guild:c.guild,channels:[c.channel],forums:[c.forum],threads:c.threads,publicSiteEnabled:false,linkHosts:[]};
      let acceptingNativeConsent=enable;
      const options={connections,broker,c:configured,sdk,receiptRoot:path.join(dir,'outbox'),
        checkDesktopGrant:actual=>same(actual,configured)&&(acceptingNativeConsent||same(saved(),c))};
      handle=await openGateway({...options,mode:'serve'});
      await openGateway({...options,mode:'register'});
      if(enable)await require('../atomic-file').writeAtomic(file,JSON.stringify(c,null,2));
      acceptingNativeConsent=false;
      running=handle;
      return {enabled:true,running:true};
    }catch(err){handle?.stop();throw err;}finally{busy=false;}
  }
  function stop() {if(busy)throw Error('gateway_operation_in_progress');const h=running;running=null;h?.stop();}
  async function disable(){stop();await fs.promises.unlink(file).catch(err=>{if(err.code!=='ENOENT')throw err;});return {enabled:false,running:false};}
  async function news(id) {
    if(!/^[a-f0-9]{24}$/.test(id))throw Error('invalid_notice_id');
    const c=saved();if(!c)throw Error('desktop_grant_required');
    const receiptDir=path.join(dir,'news');await fs.promises.mkdir(receiptDir,{recursive:true,mode:0o700});
    const marker=path.join(receiptDir,id+'.json');
    async function existing(){
      try{const seen=JSON.parse(await fs.promises.readFile(marker,'utf8'));
        if(seen.thread===c.news&&snowflake(seen.messageId))return {messageId:seen.messageId,reused:true};
        throw Error('prior_delivery_unconfirmed');
      }catch(err){if(err.code==='ENOENT')return null;throw err;}
    }
    const prior=await existing();if(prior)return prior;
    const content=await (noticeSource||require('./news-source.cjs').lookup)(id,c.driveFolder);
    if(typeof content!=='string'||content.length>1900||!content.startsWith('Awesome News | Club photo update\n')||
       /@(everyone|here)|<[@#]|https?:\/\//i.test(content))throw Error('invalid_weekly_summary');
    await verify(c);
    if(!same(saved(),c))throw Error('desktop_grant_changed');
    try{
      const handle=await fs.promises.open(marker,'wx',0o600);
      try{await handle.writeFile(JSON.stringify({thread:c.news,phase:'sending'}));await handle.sync();}
      finally{await handle.close();}
    }
    catch(err){if(err.code==='EEXIST')return existing();throw err;}
    const sent=await request('club-news:'+id,'POST','/api/v10/channels/'+c.news+'/messages',
      {content,allowed_mentions:{parse:[]},nonce:id,enforce_nonce:true});
    if(!snowflake(sent?.id)||sent.channel_id!==c.news)throw Error('prior_delivery_unconfirmed');
    await require('../atomic-file').writeAtomic(marker,JSON.stringify({thread:c.news,messageId:sent.id}));
    return {messageId:sent.id};
  }
  async function newsStatus(){
    const c=saved();if(!c)return {enabled:false};
    await verify(c);
    return {enabled:true,guild:c.guild,thread:c.news};
  }
  return {start,disable,stop,news,newsStatus,status:()=>({enabled:Boolean(saved()),running:Boolean(running)})};
}
let singleton;
function instance(){
  return singleton||=(service({dataDir:require('../paths').hubDataDir(),connections:require('../api-connections').instance(),
    broker:require('../credential-broker')}));
}
module.exports={scope,service,instance};

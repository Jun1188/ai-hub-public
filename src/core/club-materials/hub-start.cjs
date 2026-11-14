'use strict';
// Inject the live Electron main-process store and broker. No access to files, vault exports or child process environments.
const {randomUUID}=require('node:crypto');
const {command,handle}=require('./submission.cjs');
const {github,repo}=require('./github.cjs');
const {acquireWriter}=require('./writer.cjs');
const {localReceipts}=require('./local-receipts.cjs');
function profile(connections,id,origin,auth,write){
  const p=connections.get(id);
  const discordHeader=auth==='bot' && p.auth==='header' && p.authHeader?.toLowerCase()==='authorization';
  if(p.origin!==origin||(!discordHeader && p.auth!==auth)||write&&!p.allowWrite)throw Error('connection_scope');
  return p;
}
async function startFromHub({connections,broker,c,discordId='discord',githubId='github',mode='serve',sdk,receiptRoot,checkDesktopGrant}){
  if(!['register','serve'].includes(mode)||!/^\d{16,20}$/.test(c.guild))throw Error('invalid_start');
  const discordOrigin='https://discord.com';
  const discordProfile=()=>{
    // Only a trusted Hub main-process host can provide its native, purpose-specific grant.
    // The generic AI write switch keeps its existing semantics for all other hosts.
    const scoped=receiptRoot&&c.threads?.length&&checkDesktopGrant?.(c)===true;
    return profile(connections,discordId,discordOrigin,'bot',!scoped);
  };
  const request=(id,jobId,method,route,body)=>broker.request({credentialRef:'credential:api-'+id,operationId:'api.request',jobId,
    payload:{method,route,...(body===undefined?{}:{body})}});
  const dp=discordProfile(),startup='club-materials:'+randomUUID();
  const me=await request(discordId,startup,'GET','/api/v10/users/@me');
  if(!me.bot||!/^\d{16,20}$/.test(me.id))throw Error('invalid_bot_identity');
  if(mode==='register'){
    await request(discordId,startup,'POST','/api/v10/applications/'+me.id+'/guilds/'+c.guild+'/commands',command);
    return {botId:me.id,registered:true};
  }
  if(!dp.allowedRoutes.includes('/api/v10/')&&!dp.allowedRoutes.includes('/'))throw Error('gateway_route_scope');
  const receipts=receiptRoot?localReceipts(receiptRoot):null;
  if(!receipts)profile(connections,githubId,'https://api.github.com','bearer',true);
  sdk=sdk||require('discord.js');
  const client=new sdk.Client({intents:[sdk.GatewayIntentBits.Guilds]});
  const releaseWriter=await acquireWriter();
  client.on('interactionCreate',async i=>{
    if(i.applicationId!==me.id||client.user?.id!==me.id)return;
    try{
      discordProfile();
      if(receipts){await handle(i,c,receipts);return;}
      const task='club-materials:'+randomUUID();
      let calls=0;
      const gitStore=github(async(method,route,body)=>{
        const gp=profile(connections,githubId,'https://api.github.com','bearer',method!=='GET');
        if(++calls>gp.maxCallsPerRun)throw Error('github_budget');
        if(body&&Buffer.byteLength(JSON.stringify(body))>65536)throw Error('hub_body_limit');
        return request(githubId,task,method,'/repos/'+repo+route,body);
      });
      await handle(i,c,{checkAudience:scope=>gitStore.checkAudience(scope),submit(entry,bytes){
        if(bytes?.length>45*1024)throw Error('hub_body_limit');
        return gitStore.submit(entry,bytes);
      }});
    }catch{console.error('Material submission response unavailable.');}
  });
  // Gateway Identify needs the Discord SDK to retain the bot credential for reconnect.
  // Keep it inside the origin-bound callback. login() resolves to the token: deliberately return no value from the callback.
  try{await connections.withCredential(discordId,discordOrigin,async credential=>{
    if(dp.auth==='header'){
      const match=/^Bot ([^\s]+)$/i.exec(credential);
      if(!match)throw Error('invalid_bot_header');
      await client.login(match[1]);
    }else await client.login(credential);
  });}
  catch{client.destroy();releaseWriter();throw Error('gateway_login_failed');}
  return {botId:me.id,stop:()=>{client.destroy();releaseWriter();}};
}
module.exports={startFromHub};

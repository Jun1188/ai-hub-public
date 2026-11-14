'use strict';
const {command,handle}=require('./submission.cjs');
const {rest,github}=require('./github.cjs');
const list=s=>(s||'').split(',').map(x=>x.trim()).filter(Boolean);
function config(env){
  const c={guild:env.CLUB_GUILD_ID,channels:list(env.CLUB_CHANNEL_IDS),forums:list(env.CLUB_FORUM_IDS),
    linkHosts:list(env.CLUB_LINK_HOSTS),publicSiteEnabled:env.CLUB_PUBLIC_SITE==='enabled'};
  if (env.CLUB_THREAD_IDS !== undefined) {
    c.threads = list(env.CLUB_THREAD_IDS);
    if (!c.forums.length || !c.threads.length || !c.threads.every(x => /^\d{16,20}$/.test(x))) {
      throw Error('invalid_thread_configuration');
    }
  }
  if(!c.guild||!c.channels.length&&!c.forums.length||![c.guild,...c.channels,...c.forums].every(x=>/^\d{16,20}$/.test(x)))throw Error('invalid_channel_configuration');
  return c;
}
function attach(client,c,store){
  client.on('interactionCreate',i=>{handle(i,c,store).catch(()=>console.error('Material submission response unavailable.'));});
}
async function main(){
  const {Client,GatewayIntentBits,Events,Routes}=require('discord.js');
  const c=config(process.env),client=new Client({intents:[GatewayIntentBits.Guilds]});
  if(process.argv[2]==='register'){
    // Guild-scoped upsert by command name. Existing unrelated guild commands remain registered.
    client.once(Events.ClientReady,async()=>{
      try{await client.rest.post(Routes.applicationGuildCommands(client.application.id,c.guild),{body:command});}
      catch{console.error('Guild command registration failed.');process.exitCode=1;}
      finally{client.destroy();}
    });
  }else if(process.argv[2]==='serve'){
    const release=await require('./writer.cjs').acquireWriter();
    try{attach(client,c,github(rest(process.env.CLUB_GITHUB_TOKEN)));await client.login(process.env.CLUB_DISCORD_TOKEN);}
    catch(err){client.destroy();release();throw err;}
    return;
  }
  else throw Error('expected_mode');
  await client.login(process.env.CLUB_DISCORD_TOKEN);
}
if(require.main===module)main().catch(()=>{console.error('Material gateway configuration or startup failed.');process.exitCode=1;});
module.exports={attach,config};

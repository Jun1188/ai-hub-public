'use strict';
const fs=require('node:fs/promises'), os=require('node:os'), path=require('node:path');
const exec=require('node:util').promisify(require('node:child_process').execFile);
const remote='https://github.com/your-org/your-site.git';
async function lookup(id,folder) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'club-weekly-'));
  const opts={cwd:root,timeout:30000,maxBuffer:2*1024*1024,windowsHide:true,
    env:{...process.env,GCM_INTERACTIVE:'Never',GIT_TERMINAL_PROMPT:'0'}};
  const git=async(...args)=>(await exec('git',['-c','credential.interactive=false',...args],opts)).stdout;
  try{
    await git('init','--bare','--quiet');
    await git('remote','add','origin',remote);
    // Main takes precedence once it contains the publisher. The existing review branch is a bounded fallback.
    for(const branch of ['main','feature/w23-game-exhibition-submissions']){
      await git('fetch','--quiet','--depth=1','--filter=blob:none','origin','refs/heads/'+branch);
      const file='bot/materials/drive-news-state.json';
      if(!(await git('ls-tree','--name-only','FETCH_HEAD','--',file)).trim())continue;
      const state=JSON.parse(await git('show','FETCH_HEAD:'+file));
      if(state.schemaVersion!==1||state.folderId!==folder||!Array.isArray(state.notifications))throw Error('no_claimed_notice');
      const match=state.notifications.filter(n=>n.id===id&&n.status==='sending');
      if(match.length!==1)throw Error('no_claimed_notice');
      return match[0].text;
    }
    throw Error('no_claimed_notice');
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
module.exports={lookup};

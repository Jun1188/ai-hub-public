'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const file=()=>path.join(require('./paths').hubDataDir(),'local-inference-lease.local.json');
function wait(ms,signal){return new Promise((resolve,reject)=>{
  signal?.throwIfAborted();
  const t=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
  const abort=()=>{clearTimeout(t);signal?.removeEventListener('abort',abort);reject(signal.reason||new Error('Cancelled'));};
  signal?.addEventListener('abort',abort,{once:true});
});}
async function acquire(signal){
  const id=crypto.randomUUID();
  fs.mkdirSync(path.dirname(file()),{recursive:true});
  for(;;){
    signal?.throwIfAborted();let handle;
    try{handle=fs.openSync(file(),'wx');}
    catch(e){if(e.code!=='EEXIST')throw e;
      let owner;try{owner=JSON.parse(fs.readFileSync(file(),'utf8'));}catch{throw new Error('Local inference lease is unreadable; inspect it before retry');}
      try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')throw new Error('Previous local inference owner exited; reconcile its runtime and lease before retry');}
      await wait(1000,signal);continue;
    }
    try{fs.writeFileSync(handle,JSON.stringify({id,pid:process.pid,startedAt:Date.now()}),'utf8');}
    catch(e){fs.closeSync(handle);try{fs.unlinkSync(file());}catch{}throw e;}
    let released=false;
    return ()=>{if(released)return;released=true;fs.closeSync(handle);
      const current=JSON.parse(fs.readFileSync(file(),'utf8'));
      if(current.id!==id)throw new Error('Local inference lease ownership changed');
      fs.unlinkSync(file());
    };
  }
}
module.exports={acquire,busy:()=>fs.existsSync(file())};

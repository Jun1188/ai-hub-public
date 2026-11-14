'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),{fork}=require('child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-cross-lease-fixture-'));
process.env.APPDATA=root;
const lease=require('../src/core/local-inference-lease');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const childFile=path.join(root,'worker.cjs'),modulePath=require.resolve('../src/core/local-inference-lease');
 fs.writeFileSync(childFile,'const lease=require('+JSON.stringify(modulePath)+'); process.send("waiting"); lease.acquire().then(done=>{process.send("acquired");done();process.exit(0);}).catch(e=>{process.send({error:e.message});process.exit(1);});','utf8');
 const release=await lease.acquire();let acquired=false;
 const child=fork(childFile,[],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],env:{APPDATA:root,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,PATH:process.env.PATH}});
 const exit=new Promise(resolve=>child.once('exit',code=>resolve(code)));
 const started=new Promise((resolve,reject)=>{child.on('message',m=>{if(m==='waiting')resolve();if(m==='acquired')acquired=true;if(m?.error)reject(new Error(m.error));});});
 await started;await wait(100);assert.equal(acquired,false);release();assert.equal(await exit,0);assert.equal(acquired,true);
 const release2=await lease.acquire(),abort=new AbortController();
 const waiting=lease.acquire(abort.signal);abort.abort(new Error('fixture queue cancelled'));
 await assert.rejects(waiting,/cancelled/);release2();
 const lock=path.join(root,'ai-hub','local-inference-lease.local.json');
 fs.writeFileSync(lock,JSON.stringify({id:'dead-owner',pid:child.pid}),'utf8');
 await assert.rejects(()=>lease.acquire(),/owner exited/);assert(fs.existsSync(lock));
 console.log('Passed: two real Node processes serialize local inference, queue cancellation preserves owner, exited owner lease is never silently erased');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
 const target=path.resolve(root);
 if(target.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(target).startsWith('hub-cross-lease-fixture-'))fs.rmSync(target,{recursive:true,force:true});
});

'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-herdr-')),fake=path.join(root,'herdr.exe');fs.writeFileSync(fake,'fixture');
const calls=[];let status='idle';
const filename=path.resolve(__dirname,'../src/core/herdr.js');
const realRequire=require;
// Packaged layout: <root>/resources/app/src/core next to <root>/resources/herdr. The home directory is empty.
const appCore=path.join(root,'resources','app','src','core'),bundledDir=path.join(root,'resources','herdr');
function load(env){const mod={exports:{}};
const sandbox={module:mod,exports:mod.exports,Buffer,process:{env:{PATH:'',...env},platform:'win32'},console,__dirname:appCore};
sandbox.require=name=>{
 if(name==='node:os')return{...os,homedir:()=>path.join(root,'home')};
 if(name==='node:child_process')return{execFile(exe,args,opts,callback){calls.push(args);queueMicrotask(()=>callback(null,Buffer.from(JSON.stringify({result:args.includes('get')?{agent:{agent_status:status,interactive_ready:true}}:{agent:{agent_status:'done'}}})),Buffer.alloc(0)));},spawn(){throw Error('unexpected server start');}};
 if(name==='./paths')return{hubDataDir:()=>root};
 if(name==='./console-text')return{decode:b=>b.toString('utf8')};
 if(name==='./secret-scrub')return{sanitize:x=>x,scrub:x=>x};
 if(name==='./prompt-safety')return realRequire('../src/core/prompt-safety');
 return realRequire(name);
};
vm.runInNewContext(fs.readFileSync(filename,'utf8'),sandbox,{filename});
return mod.exports;}
const herdr=load({HERDR_BIN_PATH:fake});
(async()=>{
 let checks=0;const check=fn=>{fn();checks++;};
 // Default package: no override and no user install. Only the copy matching the shipped manifest is used.
 check(()=>assert.equal(load({}).locate(),null));
 fs.mkdirSync(bundledDir,{recursive:true});const own=path.join(bundledDir,'herdr.exe');fs.writeFileSync(own,'bundled fixture');
 const manifest=sha=>fs.writeFileSync(path.join(bundledDir,'herdr-manifest.json'),JSON.stringify({version:'0.9.5',files:{'herdr.exe':sha}}));
 manifest(crypto.createHash('sha256').update('bundled fixture').digest('hex'));
 check(()=>assert.deepEqual({...load({}).locate()},{path:own,source:'bundled',version:'0.9.5'}));
 check(()=>assert.equal(load({HERDR_BIN_PATH:fake}).locate().source,'env'));
 manifest('0'.repeat(64));
 check(()=>assert.deepEqual({...load({}).locate()},{path:null,source:null,bundledRejected:true}));
 const rejected=await load({}).inspect({action:'sessions'});
 check(()=>assert.equal(rejected.available,false));check(()=>assert.match(rejected.message,/다시 설치/));
 check(()=>assert.throws(()=>load({}).startSession('default'),/다시 설치/));
 const userExe=path.join(root,'home','.herdr','packages','standalone','current','herdr.exe');fs.mkdirSync(path.dirname(userExe),{recursive:true});fs.writeFileSync(userExe,'user');
 check(()=>assert.deepEqual({...load({}).locate()},{path:userExe,source:'user',bundledRejected:true}));
 fs.rmSync(path.join(root,'home'),{recursive:true});fs.rmSync(bundledDir,{recursive:true});
 check(()=>assert.throws(()=>herdr.command({action:'prompt',session:'--remote',target:'w1:p1',prompt:'x'})));
 check(()=>assert.throws(()=>herdr.command({action:'prompt',session:'default',target:'w1:p1;bad',prompt:'x'})));
 const input={requestId:crypto.randomUUID(),action:'prompt',session:'default',target:'w1:p1',prompt:'--literal text',wait:true,until:'done',timeoutMs:1000};
 const args=herdr.command(input);check(()=>assert.equal(args.at(-2),'--'));check(()=>assert.equal(args.at(-1),'--literal text'));
 const job=herdr.submit(input);herdr.submit(input);
 await new Promise(resolve=>setTimeout(resolve,20));
 check(()=>assert.equal(herdr.status(job.id).state,'succeeded'));
 check(()=>assert.equal(calls.filter(a=>a.includes('prompt')).length,1));
 check(()=>assert.throws(()=>herdr.submit({...input,prompt:'changed'}),/requestId/));
 status='working';const busy=herdr.submit({...input,requestId:crypto.randomUUID()});
 await new Promise(resolve=>setTimeout(resolve,20));
 check(()=>assert.equal(herdr.status(busy.id).state,'failed'));
 check(()=>assert.equal(calls.filter(a=>a.includes('prompt')).length,1));
 check(()=>assert.throws(()=>herdr.command({...input,timeoutMs:1})));
 console.log('Herdr adapter: '+checks+' checks passed; no real CLI, agents or server started');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));

'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{EventEmitter}=require('events');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-gguf-test-')),saved=[],oldFetch=global.fetch,oldBin=process.env.LLAMA_CPP_BIN;
function mock(name,value){const id=require.resolve(name);saved.push([id,require.cache[id]]);require.cache[id]={id,filename:id,loaded:true,exports:value};}
(async()=>{
 const file=path.join(root,'fixture.gguf'),bad=path.join(root,'bad.gguf'),bin=path.join(root,'llama-server.exe');
 fs.writeFileSync(file,Buffer.concat([Buffer.from('GGUF'),Buffer.alloc(1020)]));fs.writeFileSync(bad,Buffer.alloc(32));fs.writeFileSync(bin,'');process.env.LLAMA_CPP_BIN=bin;
 let cfg={localRuntimes:{llamaUrl:'http://127.0.0.1:8080'}},busy=false,spawned=false,argv;
 mock('../src/core/config',{load:()=>cfg,update:p=>{cfg={localRuntimes:{...cfg.localRuntimes,...p.localRuntimes}};}});
 mock('../src/core/model-control',{busy:()=>busy});
 mock('../src/core/offload',{active:()=>[]});mock('../src/core/aider-studio',{isBusy:()=>false});
 const realChild=require('child_process');mock('child_process',{...realChild,spawn:(_bin,args,opts)=>{
  assert.equal(_bin,bin);assert.equal(opts.windowsHide,true);argv=args;spawned=true;
  const child=new EventEmitter();child.stderr=new EventEmitter();child.unref=()=>{};child.pid=123;
  queueMicrotask(()=>child.emit('spawn'));return child;
 }});
 global.fetch=async()=>{if(!spawned)throw Error('offline fixture');return {ok:true,text:async()=>JSON.stringify({data:[{id:'fixture'}]})};};
 const select=require('../src/core/llama-model-config').select;
 await assert.rejects(()=>select(bad),/header/);assert(!cfg.localRuntimes.llamaModelPath);
 busy=true;await assert.rejects(()=>select(file),/Wait/);busy=false;
 const selected=await select(file);assert.equal(selected.started,false);assert.equal(selected.scope,'device-only');assert.equal(cfg.localRuntimes.llamaModelPath,file);
 const runtime=require('../src/core/local-runtime');assert.equal((await runtime.configuredLocalLlama()).sizeBytes,1024);
 const visionDir=path.join(root,'vision');fs.mkdirSync(visionDir);
 const visionModel=path.join(visionDir,'ocr-vl.gguf'),projector=path.join(visionDir,'ocr-vl-mmproj.gguf');
 fs.writeFileSync(visionModel,Buffer.concat([Buffer.from('GGUF'),Buffer.alloc(1020)]));fs.writeFileSync(projector,Buffer.concat([Buffer.from('GGUF'),Buffer.alloc(508)]));
 const vision=await require('../src/core/local-gguf-catalog').describe(visionModel,'ocr-vl');
 assert.equal(vision.mmprojPath,projector);assert.equal(vision.sizeBytes,1024+512);
 assert.equal((await require('../src/core/local-gguf-catalog').describe(file)).mmprojPath,undefined);
 assert.equal(require('../src/core/delegator').guessTier('paddleocr-vl-1.6-gguf'),'none');
 await runtime.startConfiguredLocalLlama({contextLength:2048,placement:'cpu',mmprojPath:projector});
 assert.equal(argv[argv.indexOf('--mmproj')+1],projector);assert(argv.includes('--no-mmproj-offload'));
 assert.equal(argv[argv.indexOf('-m')+1],file);assert(!argv.includes('-hf'));
 assert.equal(argv[argv.indexOf('--host')+1],'127.0.0.1');assert.equal(argv[argv.indexOf('--ctx-size')+1],'2048');assert.equal(argv[argv.indexOf('--gpu-layers')+1],'0');
 const configSource=fs.readFileSync(path.join(__dirname,'../src/core/config.js'),'utf8');assert(configSource.includes("'localRuntimes.llamaModelPath'"));
 console.log('Passed: invalid GGUF no mutation, active-job guard, per-device selected file, no HF download, exact CPU/context/loopback startup, sibling mmproj sized and passed (CPU keeps it off GPU), OCR not delegated');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
 global.fetch=oldFetch;if(oldBin===undefined)delete process.env.LLAMA_CPP_BIN;else process.env.LLAMA_CPP_BIN=oldBin;
 for(const[id,value]of saved)value?require.cache[id]=value:delete require.cache[id];
 if(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('hub-gguf-test-'))fs.rmSync(root,{recursive:true,force:true});
});

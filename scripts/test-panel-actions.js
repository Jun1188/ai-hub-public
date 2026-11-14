'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path');
const actions=require('../src/mcp/harness-panel-actions');
const projected=actions.modelProjection('llamacpp',{id:'C:\\Private\\weights.gguf',loaded:true,instances:[{secret:'hidden'}]});
assert.equal(projected.name,'weights.gguf');assert.match(projected.handle,/^[a-f0-9]{64}$/);assert(!JSON.stringify(projected).includes('Private'));
assert.notEqual(projected.handle,actions.handle('lmstudio','C:\\Private\\weights.gguf'));
const op=actions.operationProjection({requestId:'id',state:'failed',model:'C:\\Private',error:'secret/path',result:{key:'hidden'}});
assert(op.hasError);assert(!JSON.stringify(op).includes('Private'));assert(!JSON.stringify(op).includes('secret'));
const registrations=[];actions.register({registerTool:(name,definition,fn)=>registrations.push({name,definition,fn})});
assert.equal(registrations.length,8);for(const r of registrations)assert.deepEqual(r.definition._meta.ui.visibility,['app']);
const mockModel=require('../src/core/model-control'),originalCatalog=mockModel.catalog,originalStart=mockModel.start;let starts=0;
mockModel.catalog=async()=>[{id:'model-a',loaded:false}];mockModel.start=a=>{starts++;assert.equal(a.model,'model-a');return{requestId:'r',state:'running',model:a.model};};
(async()=>{
 await assert.rejects(actions.prepare({provider:'lmstudio',model_handle:actions.handle('lmstudio','model-a'),confirmed:false}));
 await assert.rejects(actions.prepare({provider:'lmstudio',model_handle:actions.handle('lmstudio','stale'),confirmed:true}));
 assert.equal(starts,0);const r=await actions.prepare({provider:'lmstudio',model_handle:actions.handle('lmstudio','model-a'),confirmed:true,placement:'cpu',context_length:2048});assert.equal(starts,1);assert.equal(r.state,'running');assert(!JSON.stringify(r).includes('model-a'));
 const html=fs.readFileSync(path.join(__dirname,'../src/mcp/harness-panel.html'),'utf8');
 new (require('vm').Script)(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
 assert(!html.includes('--color-text-primary'));assert(!html.includes('opacity:.5'));assert(html.includes('event.source!==parentWindow'));assert(html.indexOf('button.primary:disabled')>html.indexOf('button.primary,'),'disabled primary buttons must not look active');assert(html.includes('clearTimeout(opTimer)'));
 const index=fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8')+fs.readFileSync(path.join(__dirname,'../ui/tabs/aider-studio.js'),'utf8');
 for(const [tab,section]of Object.values(actions.VIEWS)){assert(index.includes('id="tab-'+tab+'"'));if(section)assert(index.includes('id="'+section+'"'));}
 console.log('Panel privacy, explicit confirmation, catalog binding, host boundary and navigation contracts passed');
})().finally(()=>{mockModel.catalog=originalCatalog;mockModel.start=originalStart;}).catch(e=>{console.error(e);process.exitCode=1;});

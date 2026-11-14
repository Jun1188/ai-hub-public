'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const Module = require('node:module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gemini-enroll-'));
process.env.APPDATA = path.join(root, 'roaming');
process.env.LOCALAPPDATA = path.join(root, 'local');

// Exercise the desktop handlers and settings renderer. Only Electron/DOM and transport are simulated.
const loadModule = Module._load;
Module._load = function(name, ...args) {
  if (name !== 'electron') return loadModule.call(this, name, ...args);
  return {dialog:{}, safeStorage:{
    isEncryptionAvailable:()=>true,
    encryptString:s=>Buffer.from(s),
    decryptString:b=>b.toString()
  }};
};
const {register} = require('../electron/ipc/local-runtime');
const connections = require('../src/core/api-connections');
require('../src/core/credential-broker').useConnections(connections.instance);
const handlers = {};
register({handle:(name,fn)=>{handlers[name]=fn;}});
const hub = {};
for (const [name, channel] of Object.entries({
  localApiList:'apiList',localApiPresets:'apiPresets',localApiSave:'apiSave',
  localApiRemove:'apiRemove',localGeminiCheck:'geminiCheck'
})) hub[name] = handlers['local:' + channel];
const widgets = new Map();
function element(id) {
  if (!widgets.has(id)) widgets.set(id, {
    value:'',textContent:'',innerHTML:'',checked:false,callbacks:{},
    addEventListener(event, handler){this.callbacks[event]=handler;},
    trigger(event){return this.callbacks[event]({currentTarget:this});}
  });
  return widgets.get(id);
}
const result = element('api-result');
const checkButton = element('gemini-check');
const renderer = vm.createContext({
  window:{hub},$:element,esc:String,call:async(fn,...args)=>fn(...args),
  document:{querySelectorAll:()=>[],querySelector:selector=>
    selector==='[data-gemini-check]' && element('api-list').innerHTML.includes('data-gemini-check') ? checkButton : null}
});
const selectGemini = () => {
  element('api-preset').value='gemini';
  return element('api-preset').trigger('change');
};
const pressSave = key => {
  element('api-secret').value=key;
  return element('api-save').trigger('click');
};
let allowedKey = crypto.randomUUID(), calls = 0;
globalThis.fetch = async (url, options) => {
  calls++;
  assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1');
  assert.equal(options.method,'GET');
  assert.equal(options.redirect,'error');
  const authorized = options.headers['x-goog-api-key'] === allowedKey;
  return Response.json(authorized ? {models:[{name:'fixture-model-private'}]} : {error:{code:401}},
    {status:authorized ? 200 : 401});
};

(async () => {
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../ui/tabs/api-connections.js'),'utf8'),renderer);
  await new Promise(setImmediate);
  selectGemini();
  assert.equal(element('api-header').value,'x-goog-api-key');
  await pressSave('');
  assert.match(result.textContent,/API 키/);
  assert.deepEqual(await hub.localApiList(),[]);
  await pressSave(crypto.randomUUID());
  assert.equal(element('api-secret').value,'');
  assert.equal(calls,0,'saving must never make a provider request');
  await checkButton.trigger('click');
  assert.match(result.textContent,/HTTP 401/);
  assert.equal(calls,1);
  selectGemini();
  await pressSave(allowedKey);
  await checkButton.trigger('click');
  assert.match(result.textContent,/성공/);
  assert(!result.textContent.includes('fixture-model-private'));
  assert.deepEqual(await hub.localGeminiCheck(),{httpStatus:200,listed:true});
  assert(!(element('api-list').innerHTML + result.textContent).includes(allowedKey));

  // Reopen the persisted connections through a new module instance, as on startup.
  delete require.cache[require.resolve('../src/core/api-connections')];
  delete require.cache[require.resolve('../src/core/credential-vault')];
  const reopened = require('../src/core/api-connections');
  require('../src/core/credential-broker').useConnections(reopened.instance);
  assert.deepEqual(await hub.localGeminiCheck(),{httpStatus:200,listed:true});
  await hub.localApiRemove('gemini');
  await assert.rejects(hub.localGeminiCheck,/연결이 없습니다/);
  await renderer.window.apiPipelineConnections.refresh();
  selectGemini();
  allowedKey=crypto.randomUUID();
  await pressSave(allowedKey);
  assert.deepEqual(await hub.localGeminiCheck(),{httpStatus:200,listed:true});

  await hub.localApiRemove('gemini');
  const preset = (await hub.localApiPresets()).find(p=>p.id==='gemini');
  await hub.localApiSave({...preset,origin:'https://example.invalid'},crypto.randomUUID());
  const previousCalls=calls;
  await assert.rejects(hub.localGeminiCheck,/서비스 주소/);
  await renderer.window.apiPipelineConnections.refresh();
  selectGemini();
  assert.equal(element('api-id').value,'');
  assert.equal(element('api-origin').value,'');
  assert.match(element('api-preset-hint').textContent,/다른 서비스/);
  assert.equal(calls,previousCalls);
  console.log('Gemini desktop: blank enrollment, explicit HTTP 401, replacement, stored reopen, unlink, fresh enrollment, metadata-only response and wrong-origin denial passed.');
})().catch(error=>{console.error(error.message);process.exitCode=1;})
  .finally(()=>{Module._load=loadModule;fs.rmSync(root,{recursive:true,force:true});});

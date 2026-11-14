'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-aider-lock-test-'));
process.env.APPDATA=root;
(async()=>{
  const lock=require('../src/core/model-change-lock'),aider=require('../src/core/aider-studio');
  lock.acquire('model-load');await assert.rejects(()=>aider.start({}),/model preparation/);lock.release('model-load');
  fs.writeFileSync(path.join(root,'ai-hub','model-operation.local.json'),'{}');
  await assert.rejects(()=>aider.start({}),/model preparation/);
  console.log('Passed: direct MCP/core Aider start blocked during load and uncertain load outcome');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
  if(!path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(root).startsWith('hub-aider-lock-test-'))throw new Error('Unsafe cleanup');
  fs.rmSync(root,{recursive:true,force:true});
});

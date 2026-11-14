'use strict';
const fs=require('fs'),path=require('path');
let owner=null;
const file=()=>path.join(require('./paths').hubDataDir(),'model-change-lock.local.json');
function acquire(id){
  fs.mkdirSync(path.dirname(file()),{recursive:true});
  if(owner)throw new Error('Another model change is in progress');
  let handle;
  try{handle=fs.openSync(file(),'wx');}
  catch(e){if(e.code==='EEXIST')throw new Error('Another Hub process owns model preparation; inspect its operation before retry');throw e;}
  try{fs.writeFileSync(handle,JSON.stringify({id,pid:process.pid,at:Date.now()}),'utf8');owner={id,handle};}
  catch(e){fs.closeSync(handle);try{fs.unlinkSync(file());}catch{}throw e;}
}
function release(id){
  if(owner?.id!==id)return;
  fs.closeSync(owner.handle);owner=null;
  const value=JSON.parse(fs.readFileSync(file(),'utf8'));
  if(value.id!==id)throw new Error('Model preparation ownership changed');
  fs.unlinkSync(file());
}
// 지금 누가(이 프로세스든 다른 Hub 프로세스든) 모델을 바꾸는 중인가. 죽은 프로세스가 남긴 잠금은 기다려도 풀리지 않으므로 아니다.
function heldByLiveProcess(){
  if(owner)return true;
  let value;
  try{value=JSON.parse(fs.readFileSync(file(),'utf8'));}catch(e){return e.code!=='ENOENT';} // 막 열려 아직 비어 있는 잠금도 산 것으로 본다
  try{process.kill(value.pid,0);return true;}catch(e){return e.code==='EPERM';}
}
module.exports={acquire,release,heldByLiveProcess,busy:()=>Boolean(owner)||fs.existsSync(file())};

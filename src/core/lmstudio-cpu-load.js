'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),{execFile}=require('child_process');
function executable() {
  const candidates=[path.join(os.homedir(),'.lmstudio','bin','lms.exe'),
    ...String(process.env.PATH||'').split(path.delimiter).map(p=>path.join(p,process.platform==='win32'?'lms.exe':'lms'))];
  return candidates.find(p=>{try{return fs.statSync(p).isFile();}catch{return false;}})||'';
}
function load(model,contextLength) {
  const bin=executable();
  if(!bin)throw new Error('CPU placement requires the existing LM Studio lms CLI');
  return new Promise((resolve,reject)=>execFile(bin,['load',model,'--gpu','off','--context-length',String(contextLength),'-y'],{
    windowsHide:true,timeout:120000,maxBuffer:256*1024,encoding:'buffer',
  },error=>error?reject(new Error('LM Studio CPU load did not complete; reconcile model catalog before retry')):resolve({placement:'cpu',gpuOffload:'off'})));
}
module.exports={load,executable};

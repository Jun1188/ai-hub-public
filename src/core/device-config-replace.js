'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFile } = require('child_process');
const { promisify } = require('util');
const runAsync = promisify(execFile);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const windowsConflict = new Set(['EEXIST','ENOTEMPTY','EACCES','EPERM','EBUSY']);
const recoveryMessage = '기기 설정 복구 파일이 남아 있습니다. config.local.json과 복구본을 삭제하거나 인증 토큰을 재발급하지 마세요. '
  + '이 PC의 Hub를 종료한 상태에서 설정 폴더를 백업하고, 확인한 정상 사본을 config.local.json으로 복원하세요. '
  + '복구본은 별도 보관 폴더로 옮긴 뒤 Hub를 다시 실행하세요.';
function recoveryPending(file) {
  try {
    return fs.readdirSync(path.dirname(file)).some(name =>
      /^config\.local\.json\.recovery-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(name));
  } catch(err) {
    if (err.code==='ENOENT') return false;
    throw Object.assign(new Error('기기 설정 복구 상태를 확인할 수 없습니다.'),{code:'HUB_DEVICE_CONFIG_READ'});
  }
}

function active(pid) {
  try { process.kill(pid,0); return true; } catch (err) { return err.code !== 'ESRCH'; }
}
function removeEmpty(dir) {
  try { fs.rmdirSync(dir); } catch (err) {
    if (!['ENOENT','ENOTEMPTY','EEXIST'].includes(err.code)) throw err;
  }
}

// Publish a nonempty directory in one rename. Reaping removes only observed dead owners' unique markers.
function claim(file) {
  const lock = file + '.writer', token = process.pid + '-' + crypto.randomUUID();
  const pending = file + '.claim-' + token;
  fs.mkdirSync(pending);
  fs.writeFileSync(path.join(pending,token),'',{flag:'wx'});
  let acquired=false;
  try {
    for (let attempt=0; attempt<2; attempt++) {
      try { fs.renameSync(pending,lock); acquired=true; break; }
      catch(err) { if (!windowsConflict.has(err.code)) throw err; }
      let markers;
      try { markers=fs.readdirSync(lock); } catch(err) { if(err.code==='ENOENT') continue;throw err; }
      if (markers.some(m => !/^\d+-[a-f0-9-]{36}(?:\.tmp)?$/.test(m) || active(Number(m.split('-')[0])))) break;
      for (const m of markers) {
        try { fs.unlinkSync(path.join(lock,m)); } catch(err) { if(err.code!=='ENOENT') throw err; }
      }
      removeEmpty(lock);
    }
    if (!acquired) throw Object.assign(new Error('다른 Hub 저장이 진행 중입니다.'),{code:'HUB_DEVICE_CONFIG_WRITE',reason:'writer_busy'});
    return {lock,token,release() { fs.unlinkSync(path.join(lock,token));removeEmpty(lock); }};
  } finally {
    if (!acquired) { fs.unlinkSync(path.join(pending,token));removeEmpty(pending); }
  }
}

function prepare(file,tmp,previous,guard) {
  const backup=file+'.recovery-'+crypto.randomUUID();
  const executable=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const script=path.resolve(__dirname,'../../scripts/replace-device-config.ps1');
  const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Target',file,'-Pending',tmp,
    '-Backup',backup,'-Expected',previous,'-OwnerMarker',guard.token];
  return {file,tmp,backup,previous,next:digest(fs.readFileSync(tmp)),executable,args};
}
function reconcile(op,output) {
  const current=readDigest(op.file),back=readDigest(op.backup);
  if (current==='unreadable' || back==='unreadable') throw recovery(op);
  // Exit status alone cannot establish whether ReplaceFileW committed or moved the original to backup.
  if (back && back!==op.previous) throw recovery(op);
  if (current===op.next && back===op.previous) { fs.unlinkSync(op.backup);return; }
  if (current===op.previous && !back) {
    const reason=String(output || '').trim();
    throw Object.assign(new Error('기기 설정을 교체할 수 없습니다. 파일 접근을 확인한 뒤 다시 저장하세요.'),
      {code:'HUB_DEVICE_CONFIG_WRITE',reason:'replace_denied',nativeCode:/^win32:\d+$/.test(reason) ? reason : 'EPERM'});
  }
  if (!back && current && current!==op.previous && current!==op.next) {
    throw Object.assign(new Error('다른 작업이 기기 설정을 변경했습니다. 최신값을 확인하세요.'),{code:'HUB_DEVICE_CONFIG_WRITE',reason:'changed'});
  }
  throw recovery(op);
}
function readDigest(file) {
  try{return digest(fs.readFileSync(file))}catch(err){return err.code==='ENOENT' ? null : 'unreadable';}
}
function recovery(op) {
  return Object.assign(new Error('기기 설정 교체 결과를 확인할 수 없습니다. 원본·복구 파일을 보존했습니다. 다시 저장하기 전에 확인하세요.'),
    {code:'HUB_DEVICE_CONFIG_WRITE',reason:'recovery_required',recoveryFile:path.basename(op.backup)});
}
const runOptions={windowsHide:true,timeout:2500,encoding:'utf8',maxBuffer:2048};
function replaceSync(op) {
  const res=spawnSync(op.executable,op.args,runOptions);
  reconcile(op,res.stdout);
}
async function replaceAsync(op) {
  let stdout;
  try { ({stdout}=await runAsync(op.executable,op.args,runOptions)); } catch(err) { stdout=err.stdout; }
  reconcile(op,stdout);
}
module.exports={claim,prepare,replaceSync,replaceAsync,digest,recoveryPending,recoveryMessage};

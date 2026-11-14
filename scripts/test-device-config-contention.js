'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const contentionProbe = `
$ErrorActionPreference = 'Stop'
$h = [IO.File]::Open($env:HUB_TEST_CONFIG_FILE,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)
try {
  [Console]::WriteLine('locked');[Console]::Out.Flush()
  if ([Console]::ReadLine() -eq 'change') {
    $b = New-Object byte[] ([int]$h.Length)
    if ($h.Read($b,0,$b.Length) -ne $b.Length) { throw 'fixture_read_incomplete' }
    $state = [Text.Encoding]::UTF8.GetString($b).TrimStart([char]0xfeff) | ConvertFrom-Json
    $state.memory.dir = 'concurrent-writer'
    $next = [Text.Encoding]::UTF8.GetBytes(($state | ConvertTo-Json -Depth 20 -Compress))
    $h.Position = 0; $h.SetLength(0); $h.Write($next,0,$next.Length); $h.Flush()
  }
} finally { $h.Dispose() }`;

async function hold(file) {
  const child = spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',contentionProbe],{
    windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,HUB_TEST_CONFIG_FILE:file}
  });
  const stopped = once(child,'exit');
  const ready = await Promise.race([once(child.stdout,'data').then(([s])=>String(s).trim()), stopped.then(()=> 'closed')]);
  assert.equal(ready,'locked');
  return async (command='release') => {
    child.stdin.end(command + '\n');
    assert.equal((await stopped)[0],0);
  };
}
async function main() {
  if (process.platform !== 'win32') return console.log('Windows sharing-mode fixture skipped');
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'hub-contention-'));
  process.env.USERPROFILE = process.env.HOME = process.env.LOCALAPPDATA = root;
  process.env.APPDATA = path.join(root,'main');
  const config = require('../src/core/config');
  fs.mkdirSync(path.dirname(config.LOCAL_FILE),{recursive:true});
  const initial = {hub:{authToken:'fixture-only'},memory:{dir:'before'}};
  fs.writeFileSync(config.LOCAL_FILE,JSON.stringify(initial));
  const disk = () => JSON.parse(fs.readFileSync(config.LOCAL_FILE,'utf8').replace(/^\uFEFF/,''));
  const leftovers = () => fs.readdirSync(path.dirname(config.LOCAL_FILE)).filter(s=>s.includes('.tmp-'));
  config.load();
  const results = {};
  let release;
  try {
    release = await hold(config.LOCAL_FILE);
    let ticked=false;
    const update = config.updateWithRetry({memory:{dir:'after'}});
    await new Promise(resolve=>setTimeout(()=>{ticked=true;resolve()},45));
    await release();release=null;
    assert.equal((await update).memory.dir,'after');
    assert(ticked);assert.equal(disk().memory.dir,'after');assert.deepEqual(leftovers(),[]);
    results.transientLock='recovered';
    const transient = config.saveMetrics().thisProcess;
    assert.equal(transient.requests,1);assert.equal(transient.succeeded,1);
    assert(transient.renameRetries>0 && transient.requestRetries>0);

    release = await hold(config.LOCAL_FILE);
    const previous = fs.readFileSync(config.LOCAL_FILE);
    await assert.rejects(config.updateWithRetry({memory:{dir:'denied'}}),err=>{
      assert.equal(err.code,'HUB_DEVICE_CONFIG_WRITE');assert.equal(err.reason,'replace_denied');
      assert(['EPERM','EACCES','EBUSY','win32:32','win32:5'].includes(err.nativeCode));assert(!err.message.includes(root));
      results.persistentLock=err.nativeCode;return true;
    });
    assert(fs.readFileSync(config.LOCAL_FILE).equals(previous));assert.equal(config.load().memory.dir,'after');
    assert.deepEqual(leftovers(),[]);
    const persistent = config.saveMetrics().thisProcess;
    assert.equal(persistent.requests,2);assert.equal(persistent.failed,1);
    assert.equal(persistent.nativeEntries-transient.nativeEntries,1);
    assert.equal(persistent.requestRetries-transient.requestRetries,3);
    assert.equal(persistent.renameRetries-transient.renameRetries,8);
    assert.equal(persistent.physicalWrites,transient.physicalWrites);
    await release();release=null;
    config.update({memory:{dir:'recovered'}});
    results.manualRetry=(disk().memory.dir==='recovered');assert(results.manualRetry);

    release = await hold(config.LOCAL_FILE);
    const pendingChange=config.updateWithRetry({memory:{dir:'stale'}}).then(()=> 'committed',err=>err.reason || err.code);
    await release('change');release=null;
    const outcome=await pendingChange;
    assert(['changed','HUB_DEVICE_CONFIG_READ'].includes(outcome), 'stale write was not rejected: '+outcome);
    assert.equal(config.load().memory.dir,'recovered');
    assert.equal(disk().memory.dir,'concurrent-writer');assert.equal(disk().hub.authToken,'fixture-only');
    assert.deepEqual(leftovers(),[]);results.concurrentWrite='preserved';results.concurrentRejection=outcome;

    const modulePath=require.resolve('../src/core/device-config-replace');
    const child=spawn(process.execPath,['-e',
      "const fs=require('fs'),path=require('path');const g=require(process.argv[1]).claim(process.argv[2]);"+
      "fs.writeFileSync(path.join(g.lock,g.token+'.tmp'),'synthetic scratch');console.log('ready');setInterval(()=>{},1000)",
      modulePath,config.LOCAL_FILE],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    const childDone=once(child,'exit');
    try {
      assert.equal(String((await once(child.stdout,'data'))[0]).trim(),'ready');
      assert.throws(()=>config.setLocalOnly('memory.dir','cannot-own'),err=>{results.unavailableWriter=err.reason;return err.reason==='writer_busy';});
    } finally { child.kill();await childDone; }
    config.setLocalOnly('memory.dir','recovered-writer');
    assert.equal(fs.existsSync(config.LOCAL_FILE+'.writer'),false);
    assert.equal(disk().memory.dir,'recovered-writer');
    results.killedWriterRecovered=true;

    const sharedBytes=fs.readFileSync(config.SHARED_FILE), sharedTime=fs.statSync(config.SHARED_FILE).mtimeMs;
    const rotations=process.argv.includes('--stress') ? 320 : 8;
    const beforeRotation=config.saveMetrics().thisProcess;
    for (let i=0;i<rotations;i++) {
      const value='synthetic-value-'+i;
      await config.updateWithRetry({hub:{authToken:value}});
      const current=disk();
      assert.equal(current.hub.authToken,value); assert.equal(current.memory.dir,'recovered-writer');
      assert.deepEqual(leftovers(),[]);
    }
    results.verifiedRotations=rotations;
    const afterRotation=config.saveMetrics().thisProcess;
    assert.equal(afterRotation.requests-beforeRotation.requests,rotations);
    assert.equal(afterRotation.succeeded-beforeRotation.succeeded,rotations);
    assert.equal(afterRotation.physicalWrites-beforeRotation.physicalWrites,rotations);
    assert.equal(afterRotation.normalWrites-beforeRotation.normalWrites,rotations);
    assert.equal(afterRotation.nativeEntries,beforeRotation.nativeEntries);
    results.metrics=afterRotation;
    assert(fs.readFileSync(config.SHARED_FILE).equals(sharedBytes) && fs.statSync(config.SHARED_FILE).mtimeMs===sharedTime,
      'device-only updates touched the shared generation after initial publication');
    const backup=config.LOCAL_FILE+'.recovery-'+require('crypto').randomUUID();
    const bytes=fs.readFileSync(config.LOCAL_FILE);
    fs.renameSync(config.LOCAL_FILE,backup);
    const fresh=spawnSync(process.execPath,['-e',
      "const c=require(process.argv[1]);try{c.load();process.exitCode=1}catch(e){if(e.code!=='HUB_DEVICE_CONFIG_READ'||e.reason!=='recovery_required')process.exitCode=2}",
      require.resolve('../src/core/config')],{stdio:'pipe',timeout:10000,windowsHide:true});
    assert.equal(fresh.status,0);assert(!fs.existsSync(config.LOCAL_FILE));assert(fs.readFileSync(backup).equals(bytes));
    fs.renameSync(backup,config.LOCAL_FILE);
    results.recoveryAfterRestart='blocked_until_restored';
    console.log(JSON.stringify(results));
  } finally {
    if (release) await release();
    if (path.dirname(path.resolve(root))===path.resolve(os.tmpdir()) && path.basename(root).startsWith('hub-contention-')) {
      fs.rmSync(root,{recursive:true,force:true,maxRetries:4,retryDelay:40});
    }
  }
}
main().catch(e=>{console.error(e);process.exitCode=1});

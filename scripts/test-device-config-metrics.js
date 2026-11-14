'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {fork, spawnSync} = require('node:child_process');
const {once} = require('node:events');
const {randomUUID} = require('node:crypto');
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));

async function child() {
  const config = require('../src/core/config');
  process.send('ready');
  const [go] = await once(process,'message');
  assert.equal(go,'go');
  // Two async callers share an event loop; independent process writers contend on the same real item.
  await Promise.all([config.updateWithRetry({memory:{dir:'synthetic-a'}}),config.updateWithRetry({memory:{dir:'synthetic-b'}})].map(p=>p.catch(()=>null)));
  process.send(config.saveMetrics().thisProcess);
  process.disconnect();
}

async function test() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'hub-save-metrics-'));
  process.env.APPDATA = process.env.HOME = process.env.USERPROFILE = process.env.LOCALAPPDATA = root;
  const local = path.join(root,'ai-hub');
  const metricsDir = path.join(local,'device-save-metrics');
  fs.mkdirSync(local);
  fs.writeFileSync(path.join(local,'config.local.json'),JSON.stringify({hub:{authToken:'synthetic-never-log-this'}}));
  try {
    const workers = Array.from({length:2},() => fork(__filename,['child'],{stdio:['ignore','ignore','inherit','ipc']}));
    const reports = await Promise.all(workers.map(async worker => {
      const done = once(worker,'exit');
      assert.equal((await once(worker,'message'))[0],'ready');
      const response = once(worker,'message');
      worker.send('go');
      const [counts] = await response;
      assert.equal(counts.requests,2);
      assert.equal(counts.succeeded+counts.failed,counts.requests);
      assert.equal((await done)[0],0);
      return counts;
    }));
    const reader = () => {
      const read = spawnSync(process.execPath,[path.join(__dirname,'device-config-metrics.js')],{encoding:'utf8',timeout:7000,windowsHide:true});
      assert.equal(read.status,0,read.stderr);
      return JSON.parse(read.stdout);
    };
    const before = reader();
    assert.equal(before.retainedSessions,2);
    for (const key of Object.keys(before.totals)) assert.equal(before.totals[key],reports[0][key]+reports[1][key]);
    assert.equal(before.unreadableSlots,0);
    for (const name of fs.readdirSync(metricsDir)) {
      assert(!fs.readFileSync(path.join(metricsDir,name),'utf8').includes('synthetic'));
      const row=JSON.parse(fs.readFileSync(path.join(metricsDir,name),'utf8'));
      assert.deepEqual(Object.keys(row).sort(),['counters','persistenceFailures','schema','sequence','session']);
      assert(Object.values(row.counters).every(Number.isSafeInteger));
    }
    // Fail only the telemetry destination; the real setting must still change and counters must say persistence failed.
    fs.renameSync(metricsDir,metricsDir+'.fixture');
    fs.writeFileSync(metricsDir,'fixture barrier');
    const config = require('../src/core/config');
    config.setLocalOnly('memory.dir','metric-unavailable');
    await sleep(25);
    const degraded = config.saveMetrics();
    assert.equal(degraded.thisProcess.succeeded,1);
    assert(degraded.observedPersistenceFailures>0 && degraded.unreadableSlots>0);
    assert.equal(JSON.parse(fs.readFileSync(config.LOCAL_FILE,'utf8').replace(/^\uFEFF/,'')).memory.dir,'metric-unavailable');
    fs.unlinkSync(metricsDir);
    fs.renameSync(metricsDir+'.fixture',metricsDir);
    const invalid = '123-'+randomUUID()+'.0.json';
    fs.writeFileSync(path.join(metricsDir,invalid),'{');
    const partial = reader();
    assert.equal(partial.unreadableSlots,1);
    assert.deepEqual(partial.totals,before.totals);
    fs.unlinkSync(path.join(metricsDir,invalid));
    config.setLocalOnly('memory.dir','metric-restored');
    await sleep(25);
    const restored=reader();
    assert.equal(restored.retainedSessions,3);
    assert.equal(restored.totals.requests,before.totals.requests+2);
    assert(restored.observedPersistenceFailures>0);
    const source = fs.readdirSync(metricsDir).find(name => name.endsWith('.json'));
    const sample = JSON.parse(fs.readFileSync(path.join(metricsDir,source),'utf8'));
    const deadPid = 2147483000;
    const otherId=deadPid + '-' + randomUUID();
    const unrelated=path.join(metricsDir,otherId+'.1.json');
    fs.writeFileSync(unrelated,'unrelated');
    const old = new Date(Date.now() - 32*86400000);
    const expired=Array.from({length:20},()=> {
      const id=deadPid+'-'+randomUUID(), file=path.join(metricsDir,id+'.1.json');
      fs.writeFileSync(file,JSON.stringify({...sample,session:id}));
      fs.utimesSync(file,old,old);
      return file;
    });
    fs.utimesSync(unrelated,old,old);
    const alias=path.join(metricsDir,deadPid+'-'+randomUUID()+'.1.json');
    fs.linkSync(unrelated,alias);
    const prune=spawnSync(process.execPath,['-e',"require(process.argv[1]).setLocalOnly('memory.dir','synthetic-cleanup')",require.resolve('../src/core/config')],{encoding:'utf8',windowsHide:true});
    assert.equal(prune.status,0,prune.stderr);
    assert.equal(expired.filter(file=>fs.existsSync(file)).length,4);
    assert.equal(fs.readFileSync(unrelated,'utf8'),'unrelated');assert.equal(fs.readFileSync(alias,'utf8'),'unrelated');
    console.log(JSON.stringify({sessions:restored.retainedSessions,totals:restored.totals,
      observedPersistenceFailures:restored.observedPersistenceFailures,readOnlyFreshReader:true,partialSlotFlagged:true,ownedRetentionOnly:true}));
  } finally {
    if (path.dirname(root)===os.tmpdir() && path.basename(root).startsWith('hub-save-metrics-')) fs.rmSync(root,{recursive:true,force:true,maxRetries:4});
  }
}
(process.argv[2]==='child'?child():test()).catch(error=>{console.error(error);process.exitCode=1});

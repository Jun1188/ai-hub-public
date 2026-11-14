'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-lifetime-'));
for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA']) process.env[key] = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));
const analysis = require('../src/core/telemetry-analysis');
const devtools = require('../src/core/devtools');
const monitor = require('../src/core/debugging/render-monitor');
const stampA = '134397835900000001', stampB = '134397835900000002';
const proc = (n, started, c, p = 42) => ({ p, started, n, c, g: {}, m: 100, r: 0, w: 0, vs: 0, vd: 0 });
const sample = (t, procs) => ({ t, procs, cpu: 10, mem: { avail: 5e9, pagesIn: 0 }, disks: [], adapters: [] });
const a = proc('ShaderCompileWorker', stampA, 10), b = proc('Unity', stampB, 80);
const series = [sample(0,[a]), sample(1000,[a]), sample(2000,[b]), sample(3000,[b])];

test('report separates two starts one FILETIME tick apart; numeric PID selects last observed', () => {
  assert.equal(Number(stampA), Number(stampB));
  const report = analysis.summarize(series);
  const byName = Object.fromEntries(report.processes.map(row => [row.name,row]));
  assert.equal(report.processes.length, 2);
  assert.deepEqual([byName.Unity.cpuPercent.avg, byName.Unity.activeSeconds, byName.Unity.latestObserved], [80,2,true]);
  assert.deepEqual([byName.ShaderCompileWorker.cpuPercent.avg, byName.ShaderCompileWorker.activeSeconds, byName.ShaderCompileWorker.latestObserved], [10,2,false]);
  assert.equal(analysis.usage(series, new Set([42])).cpuPercent.avg, 80);
  assert.equal(report.machine.activeSeconds, 4);
});

test('old-only records keep the same PID; mixed unknown rows have a separate lifetime', () => {
  const legacy = proc('legacy', undefined, 4);
  const one = analysis.summarize([sample(0,[legacy]),sample(1000,[legacy])]).processes;
  assert.equal(one.length, 1);
  assert.equal(one[0].pid, 42);
  assert.equal(one[0].lifetimeOrdinal, undefined);
  const both = analysis.summarize([sample(-1000,[legacy]), ...series]).processes;
  assert.equal(both.length, 3);
  assert.equal(both.find(r => r.name === 'legacy').cpuPercent.avg, 4);
});

test('ambiguous ownership cannot attribute a new life to an earlier job', () => {
  const ctx = { registry: new Map([[42, { jobId: 'j', kind:'job', label:'work' }]]) };
  const job = { jobId:'j', kind:'job', label:'work', start:0,end:1000 };
  let report = analysis.summarize(series,[job],ctx);
  assert.equal(report.jobs[0].processes,1);
  assert.equal(report.jobs[0].cpuPercent.peak,10);
  assert.equal(report.processes.find(r=>r.name==='Unity').job,null);
  report = analysis.summarize(series,[{...job,end:3000}],ctx);
  assert.equal(report.jobs[0].processes,0);
  assert.ok(report.processes.every(r=>r.job===null));
});

test('Perfetto separates lives using integer tracks and preserves reserved metadata tracks', () => {
  const machine = 0x7ffffff0;
  const busy = series.map(s=>sample(s.t,[...s.procs,proc('reserved', '7', 2, machine+1),proc('real-high','8',3,machine-1)]));
  const events = analysis.trace(busy).traceEvents;
  const names = events.filter(e=>e.ph==='M');
  assert.equal(new Set(names.map(e=>e.pid)).size, names.length);
  assert.ok(names.every(e=>Number.isInteger(e.pid) && e.pid !== machine+1 && e.pid !== machine+2));
  const original = names.find(e=>e.args.started===stampA), next=names.find(e=>e.args.started===stampB);
  assert.equal(original.pid,42);
  assert.notEqual(next.pid,42);
  assert.equal(next.args.originalPid,42);
  assert.deepEqual(events.filter(e=>e.pid===next.pid&&e.name==='CPU % of machine').map(e=>e.args.cpu),[80,80]);
});

test('engine role report and live render measurement do not combine two PID lives', async () => {
  devtools._test.editors.set(42,{ pid:42,app:'unity',role:'editor' });
  try {
    const apps = await devtools.summarize(series,{since:0,until:3000,parents:new Map()});
    const unreal = apps.find(app=>app.app==='unreal').roles.find(role=>role.role==='shader-compile');
    const unity = apps.find(app=>app.app==='unity').roles.find(role=>role.role==='editor');
    assert.equal(unreal.cpuPercent.avg,10);
    assert.equal(unity.cpuPercent.avg,80);
  } finally { devtools._test.reset(); }
  assert.equal(monitor.analyze({threadSamples:[],samples:series,pid:42}).error,'process_lifetime_changed');
  assert.equal(monitor.analyze({threadSamples:[],samples:series.slice(2),pid:42}).target.name,'Unity');
  assert.equal(monitor.analyze({threadSamples:[{started:stampB},{started:null}],samples:series.slice(2),pid:42}).error,'process_lifetime_changed');
  assert.equal(monitor.analyze({threadSamples:[{started:null},{started:stampB}],samples:series.slice(2),pid:42}).error,'process_lifetime_changed');
  assert.equal(monitor.analyze({threadSamples:[],samples:series.slice(2),pid:42,expectedStart:stampA}).error,'process_lifetime_changed');
  assert.equal(monitor.analyze({threadSamples:[{started:null,threads:[]}],samples:[sample(0,[proc('old',null,5)])],pid:42}).target.name,'old');
});

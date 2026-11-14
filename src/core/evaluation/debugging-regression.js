'use strict';
const fs = require('fs');
const store = require('./eval-store');
const source = ['../debugging/culprits', '../debugging/process-inspect', '../debugging/frame-capture'];

// Fixed outcomes for three independent product paths. Never attach to a live process or start replay here.
function cases({ rank, hardware, summarize }) {
  const row = (started, hf) => ({ p:7,n:'sample',started,hf,c:0,m:0,r:0,w:0,vd:0,vs:0,g:{} });
  const samples = (...rows) => rows.map((p,i) => ({t:i*1000,procs:[p]}));
  const ranked = (...rows) => rank(samples(...rows),p=>p.hf,()=>null)[0];
  const h = hardware(samples({...row('200',0),hfBefore:9,hfCount:9,hfIntervalMs:2000}),7);
  const unknown = hardware(samples(row('200',null)),7);
  const frame = summarize({draws:[{eid:1,pass:'a',triangles:1},{eid:2,pass:'b',triangles:5}],
    stats:{per_pass:[{name:'a'},{name:'b'}]},counters:{rows:[{eid:1,counter:'GPU Duration',unit:'Seconds',value:0}]}});
  const pick = (id,pass) => ({id,pass:!!pass,score:pass?1:0,weight:1,critical:true});
  return [
    pick('debug.counter.zero', h.hardFaultObservation?.delta === 0 && h.hardFaultsPerSec?.avg === 0),
    pick('debug.counter.missing', unknown.hardFaultsPerSec === null && unknown.hardFaultObservation === null),
    pick('debug.process.identity', ranked(row('200',2))?.inspect?.started === '200'),
    pick('debug.process.reused', ranked(row('200',2),row('300',1))?.inspect === null),
    pick('debug.frame.zero', frame.topDraws.find(d=>d.eid===1)?.gpuMs === 0),
    pick('debug.frame.missing', frame.topDraws.find(d=>d.eid===2)?.gpuMs === null && frame.passes.find(p=>p.name==='b')?.gpuShare === null),
  ];
}

async function evaluate() {
  const [culprits,processInspect,frame] = source.map(id=>require(id));
  const checks=cases({rank:culprits.rank,hardware:processInspect.hardware,summarize:frame.summarize});
  const files=await Promise.all([__filename,...source.map(id=>require.resolve(id))].map(file=>fs.promises.readFile(file,'utf8')));
  return {checks,fingerprint:store.keyOf(...files),
    extra:{scope:'Fixed deterministic process, counter and frame cases; real collectors and GPU replay are separate.'}};
}
module.exports={cases,evaluate};

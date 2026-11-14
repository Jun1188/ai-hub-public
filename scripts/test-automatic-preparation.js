#!/usr/bin/env node
'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {test,after}=require('node:test');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-preparation-fixture-'));
process.env.APPDATA=root;process.env.AIHUB_HW_REFRESH='0';
const {assess}=require('../src/core/model-admission');
const GIB=1024**3,now=Date.now();
const input=(ram=32,used=5,gpuUsed=1000)=>({now,contextLength:8192,target:{id:'fixture-7b',sizeBytes:5*GIB},
 snapshot:{sampledAt:now,cpu:{usagePercent:10},ram:{totalBytes:ram*GIB,usedBytes:used*GIB},
 gpu:{available:true,devices:[{totalMiB:8192,usedMiB:gpuUsed,usagePercent:5}]}},
 environment:{at:now,onAcPower:true,heavyApps:[],failures:0,retryAt:0},policy:{}});
test('unknown, stale and conflicting observations never grant preparation',()=>{
 const a=input();delete a.snapshot.sampledAt;assert.equal(assess(a).admitted,false);
 const b=input();b.environment.failures=1;assert.equal(assess(b).admitted,false);
 const c=input();c.snapshot.cpu.usagePercent=null;assert.equal(assess(c).reason,'cpu_sample_unavailable');
 const d=input();d.snapshot.sampledAt=now-11000;assert.equal(assess(d).reason,'resource_sample_stale');
 const e=input();e.environment.heavyApps=['UnrealEditor'];assert.equal(assess(e).reason,'heavy_application_active');
 const f=input();f.environment.onAcPower=false;assert.equal(assess(f).admitted,false);
});
test('ordinary models choose GPU or CPU using current and projected use',()=>{
 const a=input(32,5);a.target={sizeBytes:3*GIB,id:'small'};assert.equal(assess(a).expected.placement,'gpu');
 a.snapshot.gpu.devices[0].usedMiB=7600;const b=assess(a);assert.equal(b.admitted,true);assert.equal(b.expected.placement,'cpu');
 a.target.sizeBytes=80*GIB;assert.equal(assess(a).admitted,false);
 a.target.sizeBytes=null;assert.equal(assess(a).reason,'model_footprint_unknown');
});
// RTX 4060 Ti 8 GB · RAM 32 GB에서 LFM2.5-24B-A2B Q4_K_M(14.5 GB, 전문가 64개) 같은 MoE GGUF
const moeModel=(over={})=>({id:'lfm2.5-24b-a2b-q4_k_m',sizeBytes:14.5e9,startup:true,modelPath:'fixture.gguf',loaded:false,moe:{expertCount:64,expertBytes:13.1e9},...over});
const rtx4060ti=(usedRam)=>{const a=input(32,usedRam,900);a.snapshot.gpu.devices[0].totalMiB=8188;a.contextLength=6144;return a;};
test('MoE GGUF keeps experts in mmap RAM and the rest on GPU when RAM has room',()=>{
 const a=rtx4060ti(8);a.target=moeModel();const ok=assess(a);
 assert.equal(ok.admitted,true,ok.reason);assert.equal(ok.expected.placement,'moe');assert.equal(ok.expected.basis,'moe-cpu-experts');
 assert(ok.expected.ramBytes>=13.1e9&&ok.expected.vramBytes<3*GIB,JSON.stringify(ok.expected)); // 비전문가 1.4 GB×1.15 + KV
 const full=rtx4060ti(17);full.target=moeModel();const no=assess(full);
 assert.equal(no.admitted,false);assert.equal(no.reason,'projected_ram_exceeds_budget');assert.equal(no.expected.placement,'moe');
 const cpu=rtx4060ti(8);cpu.target=moeModel();cpu.placement='cpu';assert.equal(assess(cpu).expected.placement,'cpu');
 const lm=rtx4060ti(8);lm.target=moeModel({startup:false});assert.notEqual(assess(lm).expected?.placement,'moe'); // LM Studio는 --cpu-moe를 못 띄운다
 const busy=rtx4060ti(8);busy.target=moeModel();busy.snapshot.gpu.devices[0].usedMiB=7000;assert.notEqual(assess(busy).expected?.placement,'moe');
});
test('MoE GGUF with an unknown expert split is budgeted conservatively',()=>{
 const a=rtx4060ti(8);a.target=moeModel({moe:{expertCount:64,expertBytes:null}});const r=assess(a);
 assert.equal(r.expected.placement,'moe');assert.equal(r.expected.basis,'moe-cpu-experts-unverified-split');
 assert(r.expected.ramBytes>=14.5e9*1.15&&r.expected.vramBytes>=14.5e9*0.3,JSON.stringify(r.expected));
 const b=rtx4060ti(12);b.target=a.target;assert.equal(assess(b).reason,'projected_ram_exceeds_budget');
});
test('GGUF header yields expert tensor bytes for MoE and nothing for dense models',async()=>{
 const u32=v=>{const b=Buffer.alloc(4);b.writeUInt32LE(v);return b;},u64=v=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(v));return b;};
 const str=t=>Buffer.concat([u64(Buffer.byteLength(t)),Buffer.from(t)]);
 const write=(file,{experts,tensors})=>{
  const kv=[['general.architecture',8,str('lfm2moe')],['tokenizer.ggml.tokens',9,Buffer.concat([u32(8),u64(2),str('a'),str('bb')])],
   ['lfm2moe.rope.freq_base',6,Buffer.alloc(4)],...(experts?[['lfm2moe.expert_count',4,u32(experts)]]:[]),['general.alignment',4,u32(32)]];
  const out=[Buffer.from('GGUF'),u32(3),u64(tensors.length),u64(kv.length)];
  for(const [k,t,v] of kv)out.push(str(k),u32(t),v);
  let offset=0;for(const [name,bytes] of tensors){out.push(str(name),u32(1),u64(bytes),u32(0),u64(offset));offset+=bytes;}
  const head=Buffer.concat(out);fs.writeFileSync(file,Buffer.concat([head,Buffer.alloc((32-head.length%32)%32+offset)]));
 };
 const dir=path.join(root,'moe');fs.mkdirSync(dir);const cat=require('../src/core/local-gguf-catalog');
 const tensors=[['token_embd.weight',512],['blk.0.attn_q.weight',256],['blk.0.ffn_gate_exps.weight',1024],['blk.0.ffn_up_exps.weight',1024],
  ['blk.0.ffn_down_exps.weight',1024],['blk.0.ffn_gate_shexp.weight',256]];
 write(path.join(dir,'moe.gguf'),{experts:64,tensors});
 assert.deepEqual((await cat.describe(path.join(dir,'moe.gguf'))).moe,{expertCount:64,expertBytes:3072});
 write(path.join(dir,'dense.gguf'),{experts:0,tensors});assert.equal((await cat.describe(path.join(dir,'dense.gguf'))).moe,undefined);
});
test('GGUF footprint counts all shards and rejects missing or invalid companions',async()=>{
 const dir=path.join(root,'gguf');fs.mkdirSync(dir);
 const name=i=>path.join(dir,'fixture-'+String(i).padStart(5,'0')+'-of-00002.gguf');
 for(let i=1;i<=2;i++){const b=Buffer.alloc(i*2048);b.write('GGUF');fs.writeFileSync(name(i),b);}
 const cat=require('../src/core/local-gguf-catalog');assert.equal((await cat.describe(name(1))).sizeBytes,6144);
 fs.writeFileSync(name(2),Buffer.alloc(4096));await assert.rejects(()=>cat.describe(name(1)),/header/);
 fs.unlinkSync(name(2));await assert.rejects(()=>cat.describe(name(1)));
 await assert.rejects(()=>cat.describe(name(2)),/first GGUF/);
});
test('SSE accepts final content, accounts usage, rejects uncertain EOF and bounded cooldowns',async()=>{
 const stream=require('../src/core/local-chat-stream');
 const response=text=>new Response(new ReadableStream({start(c){const bytes=new TextEncoder().encode(text);c.enqueue(bytes.slice(0,13));c.enqueue(bytes.slice(13));c.close();}}));
 const args={url:'http://fixture',body:{model:'x'},timeoutMs:1000};
 const out=await stream.chat({...args,fetchFn:async()=>response('data: {"choices":[{"delta":{"reasoning_content":"private"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{"content":"검증 완료"},"finish_reason":"stop"}],"usage":{"completion_tokens":40,"completion_tokens_details":{"reasoning_tokens":30}}}\n\ndata: [DONE]\n')});
 assert.equal(out.content,'검증 완료');assert.equal(out.reasoningTokens,30);assert.equal(out.finishReason,'stop');
 await assert.rejects(()=>stream.chat({...args,fetchFn:async()=>response('data: {"choices":[{"delta":{"content":"partial"}}]}\n')}),/without completion/);
 assert.equal(stream.retryAfterMs('999999'),300000);assert.equal(stream.retryAfterMs('12'),12000);
 await assert.rejects(()=>stream.chat({...args,fetchFn:async()=>new Response('',{status:429,headers:{'Retry-After':'7'}})}),e=>e.retryAfterMs===7000&&e.status===429);
});
after(()=>{const target=path.resolve(root);if(target.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(target).startsWith('hub-preparation-fixture-'))fs.rmSync(target,{recursive:true,force:true});});

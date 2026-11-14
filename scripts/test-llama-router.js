'use strict';
const assert = require('assert/strict');
const config = require('../src/core/config');
const originalLoad = config.load, originalFetch = global.fetch;
config.load = () => ({ localRuntimes: { llamaUrl: 'http://127.0.0.1:18888' } });
const runtime = require('../src/core/local-runtime');
const hw=require('../src/core/hardware-optimizer'),monitor=require('../src/core/resource-monitor');
const hwOriginal={refresh:hw.refresh,status:hw.status,policy:hw.policy,slotState:hw.slotState,withLocalSlot:hw.withLocalSlot},monitorOriginal=monitor.snapshot;
hw.refresh=async()=>{};hw.status=()=>({at:Date.now(),onAcPower:true,heavyApps:[],failures:0});hw.policy=()=>({});hw.slotState=()=>({active:1});hw.withLocalSlot=async f=>f();
monitor.snapshot=async()=>({sampledAt:Date.now(),cpu:{usagePercent:5},ram:{totalBytes:32*1024**3,usedBytes:4*1024**3,usagePercent:12.5},gpu:{available:false}});
const models = require('../src/core/model-control');
const calls = [], states = { 'repo/code:Q5': 'loaded', 'repo/review:Q4': 'unloaded' };
let truncated = false;
global.fetch = async (url, options = {}) => {
  calls.push({ url, ...options });
  if (url.endsWith('/props')) return new Response(JSON.stringify({ role: 'router' }));
  if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: Object.entries(states).map(([id, value]) => ({
    id, status: { value, args: ['private-server-argument'], preset: 'private' }, meta: { n_ctx: 8192 },
  })) }));
  if (/\/models\/(load|unload)$/.test(url)) {
    const model = JSON.parse(options.body).model; assert.ok(model in states);
    states[model] = url.endsWith('/unload') ? 'unloaded' : 'loaded'; return new Response('{"success":true}');
  }
  if (url.endsWith('/chat/completions')) {
    const body = JSON.parse(options.body); assert.equal(body.stream, true); assert.ok(body.max_tokens < 8192);
    assert.equal(body.model, 'repo/review:Q4');
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: '확인 완료' }, finish_reason: truncated ? 'length' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  }
  throw new Error('Unexpected request: ' + url);
};
(async () => {
  const before = await runtime.llamaStatus();
  assert.equal(before.router, true); assert.equal(before.models[1].state, 'unloaded');
  assert.ok(!JSON.stringify(before).includes('private'));
  await runtime.setLlamaModel('repo/review:Q4', true);
  assert.equal((await runtime.llamaStatus()).models[1].state, 'loaded');
  await runtime.setLlamaModel('repo/review:Q4', false);
  assert.equal(states['repo/code:Q5'], 'loaded'); assert.equal(states['repo/review:Q4'], 'unloaded');
  assert.ok(calls.some(c => c.url.endsWith('/models/unload') && JSON.parse(c.body).model === 'repo/review:Q4'));
  await assert.rejects(() => runtime.setLlamaModel('missing', true), /등록되지/);
  states['repo/review:Q4']='loaded';
  const signal = new AbortController().signal, messages = [{ role: 'user', content: '짧은 작업' }];
  assert.equal((await models.ensure({ provider: 'hf-cache', model: 'repo/review', signal })).model, 'repo/review:Q4');
  assert.equal((await runtime.chat({ model: 'repo/review:Q4', messages, signal })).content, '확인 완료');
  truncated = true;
  assert.equal((await runtime.chat({ model: 'repo/review:Q4', messages, signal })).finishReason, 'length');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(() => runtime.chat({ model: 'repo/review:Q4', messages, signal: aborted.signal }), /abort/i);
  console.log('Passed: router per-model load/unload, real states, no private metadata, HF id mapping, streaming, truncation, abort');
})().catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => { global.fetch = originalFetch; config.load = originalLoad;Object.assign(hw,hwOriginal);monitor.snapshot=monitorOriginal; });

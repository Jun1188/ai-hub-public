#!/usr/bin/env node
// LM Studio JIT 로드 충돌 회귀 테스트 (실제 LM Studio 불필요 — fetch를 스텁).
//
// 2026-07-29 실측: 학습 Q&A가 두 번 연달아
//   HTTP 400 "Failed to load model \"qwen/qwen2.5-coder-14b\". Error: Operation canceled."
// 로 죽었다. 고장이 아니라 같은 모델을 동시에 JIT 로드하다 한쪽이 취소된 것으로,
// 잠시 뒤엔 1초 만에 응답했다. 로드가 끝나기를 기다렸다 한 번 다시 부르면 된다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lmretry-'));
process.env.APPDATA = SANDBOX;

const lmstudio = require('../src/core/lmstudio');
// 채팅 앞의 준비 확인(model-control.ready)은 여기서 재지 않는다 — 부른 횟수만 센다(test-model-ready.js가 본다).
let readyCalls = 0;
require('../src/core/model-control').ready = async (p) => { readyCalls++; return { model: p.model, state: 'loaded' }; };

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const realFetch = global.fetch;
const okBody = { choices: [{ message: { content: '답' }, finish_reason: 'stop' }], usage: { completion_tokens: 1 }, model: 'm' };
const loadCanceled = JSON.stringify({ error: { message: 'Failed to load model "m". Error: Operation canceled.' } });

// 채팅은 SSE로 온다(lmstudio.chatOnce의 stream:true 주석 참고). 한 글자씩 쪼개고
// 줄 중간에서 끊어 보낸다 — 청크 경계가 줄 경계와 다를 때 파서가 버티는지까지 본다.
function sseChat(text, finishReason, usage) {
  const events = [];
  for (const ch of text) {
    events.push(`data: ${JSON.stringify({ model: 'm', choices: [{ delta: { content: ch } }] })}\n\n`);
  }
  events.push(`data: ${JSON.stringify({ model: 'm', choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`);
  events.push(`data: ${JSON.stringify({ model: 'm', choices: [], usage })}\n\n`);
  events.push('data: [DONE]\n\n');
  const raw = Buffer.from(events.join(''), 'utf8');
  return new ReadableStream({start(controller){for(let i=0;i<raw.length;i+=7)controller.enqueue(raw.subarray(i,i+7));controller.close();}});
}

/** 호출 순서대로 응답을 흉내 낸다. 반환은 실제 호출 로그. */
function stubFetch(plan) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    calls.push(u.includes('/chat/completions') ? 'chat' : 'models');
    const next = plan.shift() || { kind: 'ok' };
    if (next.kind === 'chat-load-canceled') {
      return { ok: false, status: 400, text: async () => loadCanceled };
    }
    if (next.kind === 'models-loading') {
      return { ok: true, json: async () => ({ data: [{ id: 'm', state: 'not-loaded' }] }) };
    }
    if (next.kind === 'models-loaded') {
      return { ok: true, json: async () => ({ data: [{ id: 'm', state: 'loaded' }] }) };
    }
    if (next.kind === 'chat-other-error') {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'Context size has been exceeded.' } }) };
    }
    if (u.includes('/chat/completions')) {
      return new Response(sseChat('답','stop',{completion_tokens:1}),{headers:{'Content-Type':'text/event-stream'}});
    }
    return { ok: true, json: async () => okBody };
  };
  return calls;
}

(async () => {
  console.log('1) 일시적 로드 실패를 알아본다');
  {
    check('Operation canceled는 일시적',
      lmstudio.isTransientLoadError('LM Studio -> HTTP 400: {"error":{"message":"Failed to load model \\"m\\". Error: Operation canceled."}}'));
    check('Model unloaded도 일시적', lmstudio.isTransientLoadError('HTTP 400: {"error":"Model unloaded."}'));
    check('컨텍스트 초과는 일시적이 아님', !lmstudio.isTransientLoadError('Context size has been exceeded.'));
    check('연결 실패는 일시적이 아님', !lmstudio.isTransientLoadError('LM Studio에 연결할 수 없습니다'));
  }

  console.log('2) 로드가 끝나기를 기다렸다 한 번 다시 부른다');
  {
    const calls = stubFetch([
      { kind: 'chat-load-canceled' }, // 첫 호출: JIT 로드 충돌
      { kind: 'models-loading' },     // 폴링 1: 아직 로딩 중
      { kind: 'models-loaded' },      // 폴링 2: 로드 완료
      { kind: 'ok' },                 // 재시도: 성공
    ]);
    const r = await lmstudio.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    check('결국 성공한다', r.content === '답', JSON.stringify(r));
    check('상태를 보고 기다렸다(모델 조회가 끼어 있음)', calls.filter((c) => c === 'models').length >= 2, calls.join(','));
    check('채팅은 두 번만 시도', calls.filter((c) => c === 'chat').length === 2, calls.join(','));
    check('재시도 전에도 준비를 확인한다(JIT에 맡기지 않음)', readyCalls === 2, String(readyCalls));
  }

  console.log('3) 일시적이 아닌 오류는 재시도하지 않는다');
  {
    const calls = stubFetch([{ kind: 'chat-other-error' }]);
    let msg = '';
    try { await lmstudio.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }); } catch (e) { msg = e.message; }
    check('그대로 던진다', /Context size/.test(msg), msg);
    check('한 번만 호출', calls.filter((c) => c === 'chat').length === 1, calls.join(','));
  }

  console.log('4) 재시도도 실패하면 그때는 올린다 (무한 반복 금지)');
  {
    const calls = stubFetch([
      { kind: 'chat-load-canceled' },
      { kind: 'models-loaded' },
      { kind: 'chat-load-canceled' }, // 재시도도 실패
    ]);
    let msg = '';
    try { await lmstudio.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }); } catch (e) { msg = e.message; }
    check('두 번째 실패는 그대로 올림', /Operation canceled/.test(msg), msg.slice(0, 80));
    check('채팅 시도는 두 번뿐', calls.filter((c) => c === 'chat').length === 2, calls.join(','));
  }

  global.fetch = realFetch;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log('');
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  global.fetch = realFetch;
  console.error('FAIL', e);
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 무시 */ }
  process.exit(1);
});

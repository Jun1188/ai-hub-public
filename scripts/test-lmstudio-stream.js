#!/usr/bin/env node
// 채팅 스트리밍 계약 회귀 테스트 (실제 LM Studio 불필요 — fetch를 스텁).
//
// 왜 스트리밍인가 (2026-07-30 실측): fetch(undici)에는 설정과 무관한 headersTimeout
// (기본 300초)이 있다. stream:false면 LM Studio가 생성을 다 끝낸 뒤에야 첫 바이트를
// 보내므로 5분 넘는 호출은 반드시 죽었고, `lmstudio.timeoutMs`(기본값이 정확히 300000)를
// 올려도 소용이 없었다. 게다가 그 오류는 TypeError('fetch failed')로 와서
// "LM Studio가 실행 중인지 확인하세요"라는 정반대 안내로 표시됐다.
//
// 여기서 지키는 것: 스트리밍으로 바꾸되 **호출자가 보는 모양은 그대로**여야 한다.
// delegator/reply-budget은 finish_reason과 reasoning_tokens로 모델별 예산을 학습하는데,
// 이게 조용히 0이 되면 예산이 줄어 응답이 잘리기 시작한다(복구가 어렵다).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lmstream-'));
process.env.APPDATA = SANDBOX;

const lmstudio = require('../src/core/lmstudio');
require('../src/core/model-control').ready = async (p) => ({ model: p.model, state: 'loaded' }); // 준비 확인은 test-model-ready.js

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const realFetch = global.fetch;

/** SSE 본문을 chunkSize 바이트씩 흘린다(줄 경계와 일부러 어긋나게). */
function stream(events, chunkSize = 5) {
  const raw = Buffer.from(events.join(''), 'utf8');
  return new ReadableStream({start(controller){for(let i=0;i<raw.length;i+=chunkSize)controller.enqueue(raw.subarray(i,i+chunkSize));controller.close();}});
}

function data(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function stubChat(events, chunkSize) {
  global.fetch = async () => new Response(stream(events, chunkSize),{headers:{'Content-Type':'text/event-stream'}});
}

let sentBody = null;
function captureBody(events) {
  global.fetch = async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return new Response(stream(events),{headers:{'Content-Type':'text/event-stream'}});
  };
}

const call = () => lmstudio.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });

(async () => {
  console.log('1) 스트림을 논스트리밍과 같은 모양으로 되돌린다');
  {
    stubChat([
      data({ model: 'm', choices: [{ delta: { content: '안녕' } }] }),
      data({ model: 'm', choices: [{ delta: { content: '하세요' } }] }),
      data({ model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }] }),
      data({ model: 'm', choices: [], usage: { completion_tokens: 12, total_tokens: 40, completion_tokens_details: { reasoning_tokens: 7 } } }),
      'data: [DONE]\n\n',
    ]);
    const r = await call();
    check('delta를 이어 붙인다', r.content === '안녕하세요', JSON.stringify(r.content));
    check('finish_reason을 보존한다', r.finishReason === 'stop', r.finishReason);
    check('usage를 보존한다', r.usage.total_tokens === 40, JSON.stringify(r.usage));
    // 이게 0이 되면 reply-budget이 "추론을 안 하는 모델"로 학습해 예산이 줄고 응답이 잘린다.
    check('reasoning_tokens를 보존한다', r.reasoningTokens === 7, String(r.reasoningTokens));
    check('model을 응답에서 읽는다', r.model === 'm', r.model);
  }

  console.log('2) 잘렸다는 신호가 살아 있어야 한다');
  {
    stubChat([
      data({ model: 'm', choices: [{ delta: { content: '문장 중간에서' } }] }),
      data({ model: 'm', choices: [{ delta: {}, finish_reason: 'length' }] }),
      data({ model: 'm', choices: [], usage: { completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 897 } } }),
      'data: [DONE]\n\n',
    ]);
    const r = await call();
    // content만 보면 잘린 걸 알 수 없다 — finish_reason이 유일한 신호다(reply-budget.js).
    check('finish_reason=length가 전달된다', r.finishReason === 'length', r.finishReason);
    check('추론에만 예산을 쓴 경우도 관측된다', r.reasoningTokens === 897, String(r.reasoningTokens));
  }

  console.log('3) 청크 경계가 줄 경계와 달라도 견딘다');
  {
    const events = [
      data({ model: 'm', choices: [{ delta: { content: '가나다라마바사' } }] }),
      data({ model: 'm', choices: [{ delta: { content: '아자차카타파하' } }] }),
      data({ model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ];
    for (const size of [1, 3, 17, 4096]) {
      stubChat(events, size);
      const r = await call();
      check(`${size}바이트씩 흘려도 온전하다`, r.content === '가나다라마바사아자차카타파하', r.content);
    }
  }

  console.log('4) 깨진 청크 하나가 응답 전체를 날리지 않는다');
  {
    stubChat([
      data({ model: 'm', choices: [{ delta: { content: '앞' } }] }),
      'data: {이건 JSON이 아니다\n\n',
      data({ model: 'm', choices: [{ delta: { content: '뒤' } }] }),
      data({ model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ]);
    const r = await call();
    check('멀쩡한 청크는 살린다', r.content === '앞뒤', r.content);
  }

  console.log('5) 요청이 usage를 실어 달라고 해야 한다');
  {
    captureBody([
      data({ model: 'm', choices: [{ delta: { content: 'x' } }] }),
      data({ model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ]);
    await call();
    check('stream:true', sentBody.stream === true);
    // include_usage가 빠지면 usage 청크가 아예 안 와서 예산 학습이 조용히 멈춘다.
    check('stream_options.include_usage', sentBody.stream_options && sentBody.stream_options.include_usage === true,
      JSON.stringify(sentBody.stream_options));
  }

  console.log('6) 느린 것과 죽은 것을 구별해 알린다');
  {
    // undici의 headersTimeout은 AbortError가 아니라 TypeError('fetch failed')로 온다.
    // 이걸 연결 실패로 뭉뚱그리면 "LM Studio가 실행 중인지 확인하세요"가 나간다 —
    // LM Studio는 멀쩡히 돌고 있고 그냥 느린 것뿐인데.
    const timeoutErr = new TypeError('fetch failed');
    timeoutErr.cause = Object.assign(new Error('Headers Timeout Error'), { name: 'HeadersTimeoutError', code: 'UND_ERR_HEADERS_TIMEOUT' });
    global.fetch = async () => { throw timeoutErr; };
    let msg = '';
    try { await call(); } catch (e) { msg = e.message; }
    check('타임아웃을 시간 초과로 알린다', /시간이 초과/.test(msg), msg);
    check('연결 실패로 오보하지 않는다', !/실행 중인지/.test(msg), msg);

    const connErr = new TypeError('fetch failed');
    connErr.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    global.fetch = async () => { throw connErr; };
    msg = '';
    try { await call(); } catch (e) { msg = e.message; }
    check('진짜 연결 실패는 그대로 안내한다', /실행 중인지/.test(msg), msg);
  }

  console.log('7) 스트림 오류 이벤트는 빈 성공이 아니라 실패다');
  {
    // 2026-10-22 실측: 생성 중 모델이 내려가면 추론 조각 뒤에 이 두 줄로 끝난다.
    stubChat([
      data({ model: 'm', choices: [{ delta: { reasoning_content: 'thinking' }, finish_reason: null }] }),
      'event: error\n' + data({ error: { message: 'terminated' }, message: 'terminated' }),
    ]);
    let msg = '';
    try { await call(); } catch (e) { msg = e.message; }
    check('terminated 이벤트는 오류로 올라온다', /terminated/.test(msg), msg || '오류 없이 빈 답이 돌아옴');
  }

  global.fetch = realFetch;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log('');
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();

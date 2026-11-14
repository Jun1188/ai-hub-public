#!/usr/bin/env node
// 위임 시간 예산 회귀 테스트 (실제 LM Studio 불필요 — fetch를 스텁).
//
// 왜 시간이 신호인가: 작은 모델이 오래 끄는 건 "곧 좋은 답이 나온다"가 아니라
// **"이 태스크는 이 모델의 것이 아니다"**라는 뜻이다. 실측(2026-07-30) 12B 모델이
// 코드 리뷰 하나에 171초를 쓰고 예산 2200토큰을 전부 히든 추론에 태운 뒤 본문 0자를
// 냈고, 예산을 5000으로 올리자 300초를 더 쓰고 같은 결과였다.
//
// 지키는 것: 초과는 **예외가 아니라 NEEDS_ESCALATION**이다. 상위 AI가 그냥 자기가
// 하면 되는 상황이라, 실패로 올려서 파이프라인을 죽이면 안 된다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-timebudget-'));
process.env.APPDATA = SANDBOX;

const delegator = require('../src/core/delegator');
const control=require('../src/core/model-control');control.ensure=control.ready=async p=>({model:p.model,state:'loaded'});

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const realFetch = global.fetch;
const seen = [];

/** 모델 목록은 정상, 채팅은 signal이 끊길 때까지 아무것도 안 보낸다(=느린 모델). */
function stubStalled() {
  seen.length = 0;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.includes('/chat/completions')) {
      return { ok: true, json: async () => ({ data: [{ id: 'm', state: 'loaded', type: 'llm', loaded_context_length: 8192 }] }) };
    }
    seen.push({ at: Date.now() });
    return new Promise((_resolve, reject) => {
      const signal = opts.signal;
      if (signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  };
}

(async () => {
  console.log('1) 예산은 호출자가 정한다 — taskType으로 추측하지 않는다');
  {
    // 한 번 taskType별 기본 예산을 뒀다가 renderpipe 분석이 통째로 잘렸다(2026-07-30).
    // taskType은 크기가 아니라 영역 분류라, 같은 'custom'에 300토큰 추출과 UE 렌더러
    // 전체 분석이 같이 들어간다. 얼마나 걸릴지는 부르는 쪽만 안다.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'delegator.js'), 'utf8');
    check('taskType별 기본 예산표가 없다', !/TIME_BUDGET_MS\s*=\s*\{/.test(src));
    check('기본값은 전역 상한', /p\.timeoutMs \|\| cfg\.lmstudio\.timeoutMs/.test(src));
  }

  console.log('2) 예산을 넘기면 예외가 아니라 에스컬레이션이다');
  {
    stubStalled();
    const t0 = Date.now();
    const r = await delegator.delegate({
      taskType: 'custom', prompt: '멈춘 모델', noMemory: true, timeoutMs: 1200,
    });
    const elapsed = Date.now() - t0;
    check('던지지 않고 결과를 돌려준다', Boolean(r && r.content), JSON.stringify(r).slice(0, 120));
    check('escalationRequested', r.escalationRequested === true);
    check('NEEDS_ESCALATION으로 시작', /^NEEDS_ESCALATION:/.test(r.content), r.content);
    // 컨텍스트 초과(skipped:'context')와 구별돼야 원인을 알 수 있다.
    check("skipped가 'time'", r.skipped === 'time', String(r.skipped));
    check('예산 근처에서 끊는다', elapsed < 6000, elapsed + 'ms');
    check('경과 시간을 싣는다', typeof r.elapsedMs === 'number' && r.elapsedMs > 0, String(r.elapsedMs));
  }

  console.log('3) 호출자가 준 예산이 실제로 먹는다');
  {
    stubStalled();
    const t0 = Date.now();
    await delegator.delegate({ taskType: 'reasoning', prompt: '멈춘 모델', noMemory: true, timeoutMs: 900 });
    // 기본값은 전역 상한(300초)이다 — 인자가 안 먹으면 여기서 5분을 기다린다.
    check('인자 timeoutMs가 전역 상한을 이긴다', Date.now() - t0 < 6000, (Date.now() - t0) + 'ms');
  }

  console.log('4) 소스 지문 — 예산이 실제로 전달되는가');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'delegator.js'), 'utf8');
    check('첫 호출에 timeoutMs를 넘긴다', /maxTokens: plan\.tokens, timeoutMs/.test(src));
    // 재시도에 예산을 통째로 다시 주면 위임 한 번이 상한의 두 배를 쓴다.
    // 1.23.0: 전역 로컬 GPU 슬롯 대기(queuedMs)는 추론 시간이 아니므로 경과에서 뺀다.
    check('재시도는 남은 예산만 받는다', /timeoutMs - \(Date\.now\(\) - started( - queuedMs)?\)/.test(src));
    const lm = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'lmstudio.js'), 'utf8');
    check('전역 상한을 넘길 수는 없다', /Math\.min\(p\.timeoutMs \|\| cfg\.lmstudio\.timeoutMs, cfg\.lmstudio\.timeoutMs\)/.test(lm));
  }

  global.fetch = realFetch;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log('');
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();

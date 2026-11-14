// Headless test for autopilot: safe-pipeline gating, forced tick running the
// job catalog, and verification that unsafe pipelines are never auto-started.
'use strict';
// Node 24 + Windows: process.exit()가 닫히는 중인 fetch(undici) 핸들과 겹치면 libuv 단언(UV_HANDLE_CLOSING)으로
// 프로세스가 죽어 통과한 시험도 실패로 보였다(2026-10-22, 1.31.0 원본에서도 재현). 종료 코드를 먼저 남기고 잠시 뒤 끝낸다.
const finish = (code) => { process.exitCode = code; setTimeout(() => process.exit(code), 2000).unref(); };

const autopilot = require('../src/core/autopilot');
const pipeline = require('../src/core/pipeline');
const config = require('../src/core/config');

function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  // ---- safety gating ----
  assert(autopilot.isSafePipeline({ steps: [{ type: 'ai' }, { type: 'source-index' }] }), 'ai/source-index pipeline is safe');
  assert(!autopilot.isSafePipeline({ steps: [{ type: 'orchestrate' }] }), 'removed orchestrate step is not auto-runnable');
  assert(!autopilot.isSafePipeline({ steps: [{ type: 'ai' }, { type: 'shell' }] }), 'shell step makes pipeline unsafe');
  assert(!autopilot.isSafePipeline({ steps: [{ type: 'mcp-tool' }] }), 'mcp-tool step is unsafe (external side effects)');
  assert(!autopilot.isSafePipeline({ steps: [] }), 'empty pipeline is not auto-runnable');

  // ---- unsafe pipeline must be skipped even when marked auto ----
  const unsafe = pipeline.save({
    name: 'test-auto-unsafe',
    auto: { enabled: true, intervalMin: 60 },
    steps: [{ type: 'shell', name: 'evil', command: 'echo should-never-auto-run' }],
  });
  // ---- safe pipeline gets started by the tick ----
  const safe = pipeline.save({
    name: 'test-auto-safe',
    auto: { enabled: true, intervalMin: 60 },
    steps: [{ type: 'ai', name: 'ping', taskType: 'reasoning', maxTokens: 100, promptTemplate: 'Reply with the single word: PONG' }],
  });

  const before = pipeline.history(safe.id).length;
  const unsafeBefore = pipeline.history(unsafe.id).length;

  const origEnabled = (config.load().autopilot || {}).enabled;
  await autopilot.tick(true); // forced pass regardless of enabled flag

  // wait for the safe pipeline run to finish
  await new Promise((r) => setTimeout(r, 500));
  let runs = pipeline.history(safe.id);
  const started = Date.now();
  while (runs[0] && runs[0].status === 'running' && Date.now() - started < 240000) {
    await new Promise((r) => setTimeout(r, 1000));
    runs = pipeline.history(safe.id);
  }

  assert(runs.length > before, 'safe auto pipeline was started by tick');
  assert(runs[0] && runs[0].status === 'succeeded', `safe auto pipeline succeeded (status=${runs[0] && runs[0].status})`);
  assert(pipeline.history(unsafe.id).length === unsafeBefore, 'unsafe pipeline was NOT auto-started');

  const st = autopilot.status();
  assert(Array.isArray(st.activity) && st.activity.some((a) => a.job === '자동 파이프라인'), 'activity log records the run');
  assert(st.activity.some((a) => a.message.includes('건너뜀')), 'activity log records the unsafe skip');
  assert(st.lastTick > 0 || st.lastRun, 'state persisted');

  // config untouched by forced tick
  assert(Boolean((config.load().autopilot || {}).enabled) === Boolean(origEnabled), 'enabled flag unchanged by forced tick');

  pipeline.removePipeline(safe.id);
  pipeline.removePipeline(unsafe.id);
  console.log('DONE');
  finish(process.exitCode || 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  finish(1);
});

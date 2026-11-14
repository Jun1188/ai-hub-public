#!/usr/bin/env node
// 통합 활동 기록 회귀 테스트(LOG.md 10). 이력 탭이 LM Studio 직접 위임만 보여 줘서
// Aider·파이프라인 활동이 있어도 "7/30에서 멈춘" 것처럼 보였다. 1.29.0부터 에이전트 세션 대신 offload 기록.
// 실제 저장소 대신 고정 픽스처를 넣어 어느 컴퓨터에서도 같은 것을 검증한다.
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-activity-'));
process.env.APPDATA = SANDBOX;
const activity = require('../src/core/activity');

const aiderDir = path.join(SANDBOX, 'aider-runs');
fs.mkdirSync(aiderDir);
fs.writeFileSync(path.join(aiderDir, 'aider-m1.json'), JSON.stringify({
  runId: 'aider-m1', ok: false, code: 1, elapsedMs: 42000, projectDir: 'C:\\Games\\MyGame', model: 'qwen3-coder', provider: 'llamacpp',
  finishedAt: '2026-09-20T03:00:00.000Z',
}));
fs.writeFileSync(path.join(aiderDir, 'aider-m1.log'), 'log body must not be read');
fs.writeFileSync(path.join(aiderDir, 'aider-broken.json'), '{not json');

const deps = {
  stats: { history: () => [
    { ts: '2026-10-04T07:26:57.000Z', taskType: 'custom', model: 'google/gemma-4-12b', promptPreview: 'TASK: summarize', elapsedMs: 37200, ok: true, source: 'auto-memory' },
    { ts: '2026-10-04T07:26:17.000Z', taskType: 'custom', model: 'google/gemma-4-12b', promptPreview: 'Reply with OK', elapsedMs: 24700, ok: true, source: 'panel' },
    { ts: '2026-07-30T07:32:12.000Z', taskType: 'reasoning', model: 'google/gemma-4-12b-qat', promptPreview: 'render map', elapsedMs: 300000, ok: true, escalationRequested: true },
    { ts: '2026-07-29T04:12:32.000Z', taskType: 'programming', model: 'qwen/qwen2.5-coder-14b', promptPreview: 'x', ok: false, error: 'fetch failed' },
  ] },
  offload: { list: () => [
    { id: 'o1', state: 'succeeded', worker: 'local', model: 'qwen3-8b', placement: 'gpu-full', inputs: 3, resultCount: 2, failureCount: 1,
      createdAt: '2026-09-30T01:00:00.000Z', finishedAt: '2026-09-30T01:20:00.000Z', usage: { workerMs: 20 * 60000 } },
    { id: 'o2', state: 'running', worker: 'local', model: null, placement: null, inputs: 1, resultCount: 0, failureCount: 0,
      createdAt: '2026-10-04T08:00:00.000Z', finishedAt: null, usage: { workerMs: null } },
    { id: 'o3', state: 'declined', worker: 'local', model: null, placement: null, inputs: 1, resultCount: 0, failureCount: 0,
      reason: 'local_not_viable: on-battery', createdAt: '2026-07-01T00:00:00.000Z', finishedAt: '2026-07-01T00:00:01.000Z', usage: { workerMs: 1000 } },
  ] },
  aiderDir,
  pipeline: { history: () => [
    { runId: 'r1', pipelineId: 'p1', pipelineName: '빌드', status: 'failed', startedAt: '2026-07-30T07:07:00.000Z', finishedAt: '2026-07-30T07:08:30.000Z',
      steps: [{ status: 'succeeded' }, { status: 'failed' }] },
    { runId: 'r2', pipelineId: 'p2', pipelineName: '그래프 검토', status: 'paused', startedAt: '2026-10-01T00:00:00.000Z', steps: [] },
  ] },
};

// 1) 네 출처를 한 목록으로, 최신순으로
const all = activity.collect({}, deps);
assert.deepEqual(all.items.map((r) => r.kind), ['offload', 'delegation', 'delegation', 'pipeline', 'offload', 'aider', 'delegation', 'pipeline', 'delegation', 'offload']);
assert.equal(all.items[0].status, 'running');
const done = all.items.find((r) => r.kind === 'offload' && r.status === 'ok');
assert.equal(done.title, '입력 3개 · 결과 2개'); assert.equal(done.durationMs, 20 * 60000); assert.equal(done.actor, 'local · qwen3-8b');
assert.equal(all.items.at(-1).status, 'skipped'); assert.match(all.items.at(-1).detail, /local_not_viable/);

// 2) 위임은 맡긴 쪽을 구분한다(자동 기억 추출이 사용자 위임처럼 보이면 안 된다)
const [extract, panel] = all.items.filter((r) => r.kind === 'delegation');
assert.match(extract.detail, /^자동 기억 추출/);
assert.match(panel.detail, /^패널 위임/);
assert.equal(all.items.find((r) => r.title === 'render map').status, 'escalated');
assert.equal(all.items.find((r) => r.kind === 'delegation' && r.status === 'failed').error, 'fetch failed');

// 3) Aider: 결과 파일만 읽고(로그 본문 X) 프로젝트는 폴더 이름만, 깨진 기록은 건너뜀
const aider = all.items.filter((r) => r.kind === 'aider');
assert.equal(aider.length, 1);
assert.equal(aider[0].title, 'Aider · MyGame'); assert.equal(aider[0].status, 'failed'); assert.equal(aider[0].durationMs, 42000);
assert(!JSON.stringify(all).includes('log body'));
assert(!JSON.stringify(all).includes('C:\\\\Games'));

// 4) 파이프라인: 실패 단계 수와 재개 대기 상태
const build = all.items.find((r) => r.title === '빌드');
assert.equal(build.status, 'failed'); assert.equal(build.detail, '단계 2개 · 실패 1'); assert.equal(build.durationMs, 90000);
assert.equal(all.items.find((r) => r.title === '그래프 검토').status, 'paused');

// 5) 요약: 종류별 개수와 마지막 활동 — "왜 멈춰 보였나"를 화면에서 바로 보이게
assert.deepEqual(all.summary.delegation, { count: 4, last: '2026-10-04T07:26:57.000Z' });
assert.deepEqual(all.summary.aider, { count: 1, last: '2026-09-20T03:00:00.000Z' });
assert.equal(all.summary.offload.count, 3);
assert.equal(all.summary.pipeline.last, '2026-10-01T00:00:00.000Z');

// 6) 종류 필터와 상한
assert(activity.collect({ kind: 'pipeline' }, deps).items.every((r) => r.kind === 'pipeline'));
assert.equal(activity.collect({ limit: 2 }, deps).items.length, 2);

// 7) 출처 하나가 망가져도 나머지는 보인다
const broken = activity.collect({}, { ...deps, offload: { list: () => { throw new Error('offload record corrupt'); } } });
assert.equal(broken.summary.offload.error, true);
assert.equal(broken.items.filter((r) => r.kind === 'delegation').length, 4);
assert.equal(activity.collect({}, { ...deps, aiderDir: path.join(SANDBOX, 'missing') }).summary.aider.count, 0);

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log('Activity: four sources merged newest-first, caller labels, Aider/pipeline projection, per-kind summary, filter and failure isolation passed');

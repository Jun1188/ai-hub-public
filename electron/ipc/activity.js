// IPC: 통합 활동 기록(위임·에이전트 세션·Aider·파이프라인). 읽기 전용.
'use strict';

const activity = require('../../src/core/activity');
const pipeline = require('../../src/core/pipeline');

/** @param {import('./register-handlers').IpcContext} ctx */
function register(ctx) {
  const { handle } = ctx;

  handle('activity:list', (kind, limit) =>
    activity.collect({ kind: activity.KINDS.includes(kind) ? kind : undefined, limit: Number(limit) || 150 }, { pipeline }));
}

module.exports = { register };

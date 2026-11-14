// IPC: offload 작업자 상태(MCP 탭). 읽기 전용 — 작업 실행은 MCP offload_run만 한다.
'use strict';

const workers = require('../../src/core/agent-workers');

/** @param {import('./register-handlers').IpcContext} ctx */
function register(ctx) {
  const { handle } = ctx;

  handle('offload:agyStatus', () => workers.agyStatus());
}

module.exports = { register };

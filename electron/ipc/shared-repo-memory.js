// IPC: 공유 저장소(codex-shared-context) 메모리 검색. 읽기 전용 — 저장소 파일을 쓰지 않는다.
'use strict';

const sharedMemory = require('../../src/core/shared-repo-memory');

/** @param {import('./register-handlers').IpcContext} ctx */
function register(ctx) {
  const { handle } = ctx;

  handle('smem:status', () => sharedMemory.status());
  handle('smem:search', (query, kinds, limit) => sharedMemory.search(String(query || ''), { kinds, limit }));
  handle('smem:setRepo', (dir) => sharedMemory.setRepo(String(dir || '')));
}

module.exports = { register };

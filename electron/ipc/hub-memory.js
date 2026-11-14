// IPC: 허브 장기 메모리(학습 노트·사실). 위임 세션·회상 토글은 1.29.0에서 뺐다.
// 저장 위치는 %APPDATA%가 기본이며, 컴퓨터 간 공유는 share.js가 미러링으로 처리한다
// — memory.dir을 Google Drive 경로로 직접 지정하면 동기 I/O가 Drive를 때린다.
'use strict';

const memory = require('../../src/core/memory');

/** @param {import('./register-handlers').IpcContext} ctx */
function register(ctx) {
  const { handle } = ctx;

  handle('mem:stats', () => memory.stats());
  handle('mem:list', (type, limit) =>
    memory.list({ type: type || undefined, limit: Number(limit) || 50 }));
  handle('mem:search', (q, k) => memory.search(String(q), Number(k) || 6));
  handle('mem:save', (text, type, tags) =>
    memory.save(String(text), {
      type: String(type || 'note'),
      tags: String(tags || '').split(',').map((s) => s.trim()).filter(Boolean),
      source: 'gui',
    }));
  handle('mem:delete', (id) => memory.remove(String(id)));
  handle('mem:setDir', (dir) => memory.setDir(String(dir || '')));
  handle('mem:consolidate', () => memory.consolidate());
}

module.exports = { register };

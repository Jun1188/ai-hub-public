// Headless test: shared memory dir switching (migration + round-trip).
// Needs LM Studio running for embeddings.
'use strict';
// Node 24 + Windows: process.exit()가 닫히는 중인 fetch(undici) 핸들과 겹치면 libuv 단언(UV_HANDLE_CLOSING)으로
// 프로세스가 죽어 통과한 시험도 실패로 보였다(2026-10-22, 1.31.0 원본에서도 재현). 종료 코드를 먼저 남기고 잠시 뒤 끝낸다.
const finish = (code) => { process.exitCode = code; setTimeout(() => process.exit(code), 2000).unref(); };

const fs = require('fs');
const path = require('path');
const os = require('os');
const memory = require('../src/core/memory');
const config = require('../src/core/config');

function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  const originalDir = (config.load().memory && config.load().memory.dir) || '';

  // ---- shared dir switch with migration ----
  const marker = 'SHARED-MEM-TEST-' + Date.now();
  await memory.save(marker, { type: 'note', tags: ['test'], source: 'test' });
  const shared = path.join(os.tmpdir(), 'aihub-shared-mem-' + Date.now());

  let s = memory.setDir(shared);
  assert(s.isShared && path.resolve(s.dir) === path.resolve(shared), 'setDir switches to shared dir');
  assert(fs.existsSync(path.join(shared, 'memories.jsonl')), 'existing memories migrated to shared dir');
  const found = await memory.search(marker, 3);
  assert(found.some((m) => m.text === marker), 'memory readable from shared dir');

  // saves land in the shared dir, not APPDATA
  const marker2 = 'SHARED-ONLY-' + Date.now();
  await memory.save(marker2, { type: 'note', source: 'test' });
  const sharedRaw = fs.readFileSync(path.join(shared, 'memories.jsonl'), 'utf8');
  assert(sharedRaw.includes(marker2), 'new memory written to shared dir');

  // ---- back to default ----
  s = memory.setDir(originalDir);
  assert(!originalDir ? !s.isShared : true, 'setDir restores original location');

  // cleanup test markers from the active store
  for (const m of memory.list({ limit: 200 })) {
    if (m.text.startsWith('SHARED-MEM-TEST-') || m.text.startsWith('SHARED-ONLY-')) memory.remove(m.id);
  }
  fs.rmSync(shared, { recursive: true, force: true });

  console.log('DONE');
  finish(process.exitCode || 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  finish(1);
});

// Smoke test: long-term memory save/search with local embeddings.
'use strict';
// Node 24 + Windows: process.exit()가 닫히는 중인 fetch(undici) 핸들과 겹치면 libuv 단언(UV_HANDLE_CLOSING)으로
// 프로세스가 죽어 통과한 시험도 실패로 보였다(2026-10-22, 1.31.0 원본에서도 재현). 종료 코드를 먼저 남기고 잠시 뒤 끝낸다.
const finish = (code) => { process.exitCode = code; setTimeout(() => process.exit(code), 2000).unref(); };
const memory = require('../src/core/memory');

(async () => {
  // 1. long-term memory
  const a = await memory.save('사용자의 게임 프로젝트 코드네임은 VARTUK이며 UE 5.7 기반 3인칭 액션 게임이다.', { type: 'project', tags: ['game', 'ue5'] });
  console.log('saved:', a);
  const hits = await memory.search('what is the user game project about', 3);
  console.log('search top:', hits[0] ? `[${hits[0].score}] ${hits[0].text.slice(0, 60)}` : 'NONE');

  memory.remove(a.id);
  finish(0);
})().catch((e) => { console.error('FAIL', e); finish(1); });

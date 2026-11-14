// 기기 전용 데이터 폴더의 보관 기간: 수정 시각이 오래된 항목(파일·폴더)을 지운다.
// 끝없이 자라던 폴더(웹 샌드박스 스크린샷, 게이머 관점 캐시, 버스 작업 폴더)가 각자 같은 순회를 들지 않게 한 곳에 둔다.
// 공유 폴더(Drive)에는 쓰지 않는다 — 삭제는 전파하지 않는다(규칙 2).
'use strict';
const fs = require('fs');
const path = require('path');

const DAY = 86400000;

async function pruneOlderThan(root, days, { now = Date.now() } = {}) {
  const cutoff = now - days * DAY;
  let entries;
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return { removed: 0 }; throw e; }
  let removed = 0;
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // 링크 너머(사용자 폴더)는 지우지 않는다
    const full = path.join(root, e.name);
    const st = await fs.promises.stat(full).catch(() => null);
    if (st && st.mtimeMs < cutoff) { await fs.promises.rm(full, { recursive: true, force: true }); removed++; }
  }
  return { removed };
}

module.exports = { pruneOlderThan };

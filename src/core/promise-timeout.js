// 약속(promise)에 시간 상한을 건다(규칙 9). 모듈마다 같은 Promise.race를 들고 있었고, 몇 곳은 끝난 경주의 타이머를
// 지우지 않아 짧은 프로세스가 상한만큼 살아 있었다(2026-10-23 cache-metrics 실측: 시험 묶음 30초).
// Promise.race는 밑의 작업을 취소하지 못한다 — 취소가 필요하면 onTimeout에서 AbortController를 끊는다.
'use strict';

/** onTimeout()이 돌려준 오류로 거절한다. 오류는 시간이 넘었을 때 만든다. */
function withTimeout(promise, ms, onTimeout) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

module.exports = { withTimeout };

// 멀티에이전트 병행성: 전역 상한 + 대상(하네스·작업자)별 상한 + 파일 쓰기 잠금.
// - 대상별 FIFO: 같은 하네스에 동시에 두 작업을 밀어 넣지 않는다(로그인 세션·할당량을 공유하므로).
// - 파일 잠금은 정렬된 순서로 한꺼번에 잡는다 — 두 작업이 서로의 잠금을 기다리는 교착을 구조적으로 막는다.
// - 대기·실행 시간을 역할별로 남겨 자가개선 루프가 상한을 조정할 근거로 쓴다.
'use strict';

function createScheduler({ global = 2, perKey = 1, now = Date.now } = {}) {
  const running = new Map(); // key -> count
  let total = 0;
  const queue = [];
  const locks = new Set();
  const stats = { started: 0, finished: 0, failed: 0, waitedMs: 0, ranMs: 0, byKey: {} };

  const canRun = (job) => total < global && (running.get(job.key) || 0) < (job.perKey ?? perKey) && job.files.every((f) => !locks.has(f));

  function pump() {
    for (let i = 0; i < queue.length; i++) {
      const job = queue[i];
      if (job.signal?.aborted) { queue.splice(i--, 1); job.reject(new Error('Cancelled')); continue; }
      if (!canRun(job)) continue;
      queue.splice(i--, 1);
      start(job);
    }
  }

  function start(job) {
    total++; running.set(job.key, (running.get(job.key) || 0) + 1);
    for (const f of job.files) locks.add(f);
    const startedAt = now();
    stats.started++; stats.waitedMs += startedAt - job.queuedAt;
    const k = (stats.byKey[job.key] = stats.byKey[job.key] || { runs: 0, failed: 0, ranMs: 0 });
    Promise.resolve().then(job.fn).then((v) => { k.runs++; return job.resolve(v); }, (e) => { stats.failed++; k.failed++; job.reject(e); })
      .finally(() => {
        const ms = now() - startedAt;
        stats.finished++; stats.ranMs += ms; k.ranMs += ms;
        total--; running.set(job.key, running.get(job.key) - 1);
        for (const f of job.files) locks.delete(f);
        pump();
      });
  }

  /** run(key, fn, { files: [쓰는 파일], perKey, signal }) — files는 정규화된 절대·논리 경로. */
  function run(key, fn, { files = [], perKey: pk, signal } = {}) {
    return new Promise((resolve, reject) => {
      const normalized = [...new Set(files.map((f) => String(f).replace(/\\/g, '/').toLowerCase()))].sort();
      queue.push({ key: String(key), fn, files: normalized, perKey: pk, signal, resolve, reject, queuedAt: now() });
      pump();
    });
  }

  function state() {
    return { running: total, queued: queue.length, locks: [...locks], byKey: Object.fromEntries(running), limits: { global, perKey }, stats: { ...stats } };
  }

  return { run, state };
}

let shared;
const instance = () => shared || (shared = createScheduler({ global: 2, perKey: 1 }));

module.exports = { createScheduler, instance };

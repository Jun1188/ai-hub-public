// 캐시·스킬 색인 연산: 상태 그래프 hub-tool과 MCP 도구가 함께 쓴다.
'use strict';
const path = require('path');
const { spawn } = require('child_process');

/** GC는 별도 프로세스로 돌린다 — 디렉터리 순회·삭제가 Electron 메인 이벤트 루프를 잡지 않게. */
function runGc({ dryRun = false, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const args = [path.join(__dirname, 'cache-gc.js'), ...(dryRun ? ['--dry-run'] : []), '--root', require('./locality-cache').rootOf()];
    const child = spawn(process.execPath, args, { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    let out = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => { clearTimeout(timer); try { resolve({ ok: code === 0, ...JSON.parse(out) }); } catch { resolve({ ok: false, error: `gc exit ${code}` }); } });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
  });
}

function operations() {
  const cache = () => require('./locality-cache').instance();
  const index = () => require('./skill-index');
  return {
    'cache.gc': { description: '지역성 캐시 GC(별도 프로세스)', fn: async (a) => {
      const r = await runGc({ dryRun: !!a.dryRun });
      return { ok: r.ok, removed: (r.removed || []).length, kept: r.kept, bytesAfter: r.bytesAfter, error: r.error };
    } },
    'cache.stats': { description: '캐시 적중률(이번 세션·재시작을 넘는 누적·최근 7일)', fn: async () => {
      return { ok: true, ...(await cache().metrics()) };
    } },
    'skills.find': { description: '스킬·로그 색인 검색', fn: async (a) => ({ ok: true, results: (await index().find(a.query || '', { limit: a.limit || 8, kind: a.kind })).map((r) => ({ id: r.id, path: r.path, score: r.score })) }) },
  };
}

module.exports = { operations, runGc };

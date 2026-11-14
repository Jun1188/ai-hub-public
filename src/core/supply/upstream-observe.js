// 원본 레지스트리는 하나: 공유 저장소가 주간 유지보수로 관리하는 `evolve/research/upstreams.json`을 Hub도 같이 본다.
// 그 목록은 대부분 우리 쪽에 맞게 고친 사본(adapted)이라 3-way 병합 대상이 아니다 — 마지막으로 검토한 리비전보다 원본이 앞서면
// 검토할 파일과 함께 알리기만 한다(관찰 전용). 진짜 로컬 포크는 기존 forks.local.json + 병합 제안(upstream-sync.js)을 그대로 쓴다.
'use strict';
const path = require('path');

const INTERVAL_DAYS = 7;
const PARALLEL = 4;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

const stateFile = (dataDir) => path.join(dataDir, 'upstream-sync', 'observed.json');

const readJson = (file) => require('../atomic-file').readJson(file, null);

/** observeShared() → { ok, registry, results:[{ id, behind, upstreamRevision, lastReviewedRevision, reviewPaths, ... }] } */
async function observeShared(deps = {}) {
  const sync = require('./upstream-sync');
  const dataDir = deps.dataDir || require('../paths').hubDataDir();
  const now = (deps.now || Date.now)();
  const repoRoot = deps.repoRoot; // 공유 저장소 위치는 위 계층(shared-repo-memory)이라 부르는 쪽이 넘긴다
  if (!repoRoot) return { ok: false, reason: 'shared repository not found', results: [] };
  let reg;
  try { reg = await readJson(path.join(repoRoot, 'evolve', 'research', 'upstreams.json')); } catch { reg = undefined; }
  if (!reg || !Array.isArray(reg.sources)) return { ok: false, reason: 'evolve/research/upstreams.json missing or unreadable', results: [] };
  const state = await require('../atomic-file').readJsonOrQuarantine(stateFile(dataDir), { schemaVersion: 1, sources: {} });
  const rows = [];
  const queue = reg.sources.filter((s) => s && typeof s.id === 'string' && typeof s.repository === 'string');
  const work = async (s) => {
    const prev = state.sources[s.id];
    const reviewed = [s.lastReviewedRevision, s.adoptedRevision].find((r) => typeof r === 'string' && REVISION.test(r)) || null;
    const fresh = prev && prev.lastReviewedRevision === reviewed && now - Date.parse(prev.checkedAt) < INTERVAL_DAYS * 86400000;
    let result = fresh ? prev : null;
    if (!result) {
      const r = await sync.check({ id: s.id.toLowerCase(), kind: 'other', upstream: { url: s.repository, ref: s.branch || 'main' }, localPath: path.resolve(repoRoot), adoptedRevision: reviewed }, { ...deps, dataDir });
      result = { upstreamRevision: r.upstreamRevision, behind: Boolean(r.behind && !r.error), error: r.error || null, checkedAt: new Date(now).toISOString(), lastReviewedRevision: reviewed };
      state.sources[s.id] = result;
    }
    rows.push({ id: s.id, repository: s.repository, observeOnly: true, adoptionState: s.adoptionState || null, license: s.license || null,
      ...result, neverReviewed: !reviewed, reviewPaths: Array.isArray(s.reviewPaths) ? s.reviewPaths : [], localTargets: Array.isArray(s.localTargets) ? s.localTargets : [] });
  };
  for (let i = 0; i < queue.length; i += PARALLEL) await Promise.all(queue.slice(i, i + PARALLEL).map(work));
  await require('../atomic-file').writeAtomic(stateFile(dataDir), JSON.stringify(state, null, 1));
  rows.sort((a, b) => Number(b.behind) - Number(a.behind) || a.id.localeCompare(b.id));
  return { ok: true, registry: 'repo:evolve/research/upstreams.json', results: rows };
}

module.exports = { observeShared, INTERVAL_DAYS };

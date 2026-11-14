// L1 모듈 단위 변이와 조합(R4, ScholarEvolve의 module-wise mutation + crossover).
// 모듈 = 스킬 폴더 하나(SKILL.md가 있는 폴더) 또는 하네스 구성요소 하나(c1–c8). 후보는 한 모듈만 고치고,
// 조합은 단일 모듈 이득의 합(원문 식 3)으로 순위를 매긴 뒤 상위 몇 개만 전체로 다시 잰다 —
// 단독으로 가장 좋은 모듈끼리의 조합이 최고라는 보장은 없다(원문 표 3: 단독 75.4% 대신 73.7% 후보를 넣은 조합이 더 좋았다).
'use strict';
const surface = require('./harness-surface');

/** 파일이 속한 모듈. 스킬 파일은 SKILL.md가 있는 가장 가까운 상위 폴더, 나머지는 구성요소 ID. */
function moduleOf(rel, tree) {
  if (surface.componentOf(rel) === 'c6-skills') {
    const parts = rel.split('/');
    for (let i = parts.length - 1; i > 0; i--) {
      const dir = parts.slice(0, i).join('/');
      if (tree[`${dir}/SKILL.md`] != null) return `skill:${dir}`;
    }
  }
  return surface.componentOf(rel);
}

function modules(tree) {
  const out = new Map();
  for (const rel of Object.keys(tree)) {
    if (tree[rel] == null) continue;
    const m = moduleOf(rel, tree);
    if (!m) continue;
    if (!out.has(m)) out.set(m, []);
    out.get(m).push(rel);
  }
  return out;
}

/** 제안받을 모듈 max개: 기준의 결정적 검사 실패 근거에 나온 모듈을 먼저, 나머지는 이름 순(재현 가능). */
function pick(tree, checks, max) {
  const flagged = JSON.stringify((checks || []).filter((c) => !c.pass).map((c) => c.evidence));
  return [...modules(tree)].map(([m, files]) => ({ m, files, hit: files.some((f) => flagged.includes(f)) }))
    .sort((a, b) => b.hit - a.hit || a.m.localeCompare(b.m)).slice(0, max).map((x) => [x.m, x.files]);
}

/**
 * singles: [{ id, module, point }] — 건강한 단일 모듈 후보의 대응 이득 점추정. 모듈마다 가장 좋은 후보 하나를 두고
 * 모듈 2개 이상인 부분집합을 예측 이득(합) 순으로 max개. 이득이 0 이하인 모듈은 기준을 그대로 둔다(원문의 c_j = 0).
 */
function predictCombos(singles, max = 2) {
  const best = new Map();
  for (const s of singles) if (s.point > 0 && (!best.has(s.module) || s.point > best.get(s.module).point)) best.set(s.module, s);
  const top = [...best.values()].sort((a, b) => b.point - a.point || a.id.localeCompare(b.id)).slice(0, 6); // 부분집합 2^6개 상한
  const out = [];
  for (let mask = 1; mask < 1 << top.length; mask++) {
    const set = top.filter((_, i) => mask & (1 << i));
    if (set.length >= 2) out.push({ ids: set.map((s) => s.id), modules: set.map((s) => s.module), predicted: +set.reduce((t, s) => t + s.point, 0).toFixed(4) });
  }
  return out.sort((a, b) => b.predicted - a.predicted || a.ids.join().localeCompare(b.ids.join())).slice(0, max);
}

module.exports = { moduleOf, modules, pick, predictCombos };

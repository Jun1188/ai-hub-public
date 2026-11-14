// 시드 고정 부트스트랩. 3계층(대상 단위 일치도 구간)과 L1 Compose(항목 대응 하한)가 같은 난수열·같은 절차를 쓴다.
// 군집 단위로 다시 뽑는 이유: 한 판정 안의 항목들은 같은 근거를 본 답이라 독립 표본이 아니다 — 대상(지문)이 독립 단위다.
'use strict';

function rng(seed) {
  let t = (seed >>> 0) || 0x9e3779b9;
  return () => { t += 0x6d2b79f5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}

/** groups: 군집마다 값 배열. 군집을 복원 추출해 이어 붙인 표본의 stat 분포에서 alpha·1-alpha 분위수. */
function clusterBootstrap(groups, stat, { alpha = 0.1, resamples = 2000, seed = 1 } = {}) {
  const k = groups.length;
  if (!k) return null;
  const next = rng(seed), out = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    const pool = [];
    for (let i = 0; i < k; i++) for (const v of groups[Math.floor(next() * k)]) pool.push(v);
    out[r] = stat(pool);
  }
  out.sort();
  return { lo: +out[Math.floor(alpha * resamples)].toFixed(4), hi: +out[Math.ceil((1 - alpha) * resamples) - 1].toFixed(4) };
}

const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;

module.exports = { rng, clusterBootstrap, mean };

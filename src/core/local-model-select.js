'use strict';
// 로컬 서버가 꺼져 있을 때 offload가 쓸 모델을 고른다: 지금 남은 하드웨어 예산(model-admission)에 들어가는 후보 중
// 같은 작업 묶음으로 잰 품질(local-model-quality.json)이 가장 높은 것. 잰 적 없는 모델은 자동으로 고르지 않는다 —
// 매개변수 수만으로는 품질을 모른다(7~14B 결함 찾기 0/6, gemma-4-12b는 추론 토큰이 답 예산을 다 써 빈 답).
// 서버 기동·적재는 호출자가 model-control.ensure로 같은 승인 기준에 따라 한다.
const QUALITY = require('./local-model-quality.json');

const f1 = (q) => (q && q.precision + q.recall > 0 ? (2 * q.precision * q.recall) / (q.precision + q.recall) : 0);
function qualityOf(model) {
  const label = String(model.label || '').replace(/\.gguf$/i, '');
  return QUALITY.models[model.id] || (label && QUALITY.models[label]) || null;
}
// 이미 올라간 모델 > GPU(전체·부분·MoE 전문가만 CPU) > CPU. CPU 배치는 GPU 후보가 없을 때만 쓴다.
const rank = (r) => (r.model.loaded ? 2 : r.gate.expected && ['gpu', 'moe'].includes(r.gate.expected.placement) ? 1 : 0);

const BASE_CONTEXT = 6144;

async function choose({ contextLength = BASE_CONTEXT, deps = {} } = {}) {
  const control = deps.control || require('./model-control');
  const hw = deps.hardware || require('./hardware-optimizer');
  const monitor = deps.monitor || require('./resource-monitor');
  const assess = deps.assess || require('./model-admission').assess;
  const rows = [];
  for (const provider of ['llamacpp', 'lmstudio']) {
    let list = [];
    try { list = await control.catalog(provider); } catch { continue; } // 꺼진 서버·읽기 실패는 그 공급자만 뺀다
    for (const model of list) { const quality = qualityOf(model); if (quality) rows.push({ provider, model, quality }); }
  }
  if (!rows.length) return { picked: null, reason: 'no_measured_local_model' };
  await hw.refresh();
  const snapshot = await monitor.snapshot({ force: true });
  const gateAt = (r, want) => {
    const ctx = Math.min(want, r.model.maxContext || want);
    return { ...r, ctx, gate: assess({ snapshot, environment: hw.status(), policy: hw.policy(), target: r.model, contextLength: ctx }) };
  };
  const judged = rows.map((r) => {
    // 올라가 있는 모델은 다시 올리지 않으므로(ensure) 그 창이 실제 창이다. 더 큰 값을 돌려주면 offload가 창보다 큰 조각을 보낸다.
    const fixed = r.model.loaded && (r.model.allocatedContextTokens || r.model.contextLength);
    if (fixed) return gateAt(r, fixed);
    // 입력이 더 큰 창을 청해도 입장 판정이 거절하면 예전 기본 창으로 다시 잰다 — 조각이 늘 뿐 못 돌지는 않게.
    const wide = gateAt(r, Math.max(BASE_CONTEXT, contextLength));
    return wide.gate.admitted || wide.ctx <= BASE_CONTEXT ? wide : gateAt(r, BASE_CONTEXT);
  });
  const fits = judged.filter((r) => r.gate.admitted)
    .sort((a, b) => f1(b.quality) - f1(a.quality) || rank(b) - rank(a) || (a.quality.seconds || 0) - (b.quality.seconds || 0));
  const best = fits.find((r) => rank(r) > 0) || fits[0];
  if (!best) return { picked: null, reason: 'no_measured_model_fits_budget', detail: judged.map((r) => `${r.model.id}:${r.gate.reason}`) };
  return {
    picked: { provider: best.provider, model: best.model.id, placement: best.gate.expected ? best.gate.expected.placement : null,
      contextLength: best.ctx, quality: +f1(best.quality).toFixed(3) },
    reason: 'measured_quality_within_budget',
  };
}

module.exports = { choose, qualityOf, f1 };

// IPC: 백그라운드 자동화 — 오토파일럿(안전 작업 한정).
//
// 오토파일럿은 허브 자체 데이터 정리와 로컬 AI 작업만 수행한다. 셸/빌드/외부 도구
// 스텝이 섞인 파이프라인은 자동 실행 대상에서 거부한다(autopilot.SAFE_STEP_TYPES).
'use strict';

const config = require('../../src/core/config');
const autopilot = require('../../src/core/autopilot');
const pipeline = require('../../src/core/pipeline');

const AUTOPILOT_JOBS = ['memoryConsolidate', 'safePipelines'];

/** @param {import('./register-handlers').IpcContext} ctx */
function register(ctx) {
  const { handle } = ctx;

  handle('auto:status', () => autopilot.status());
  handle('auto:update', (partial) => {
    const allowed = { autopilot: {} };
    if (typeof partial.enabled === 'boolean') allowed.autopilot.enabled = partial.enabled;
    if (partial.jobs && typeof partial.jobs === 'object') {
      allowed.autopilot.jobs = {};
      for (const k of AUTOPILOT_JOBS) {
        if (typeof partial.jobs[k] === 'boolean') allowed.autopilot.jobs[k] = partial.jobs[k];
      }
    }
    config.update(allowed);
    return autopilot.status();
  });
  handle('auto:runNow', async () => {
    await autopilot.tick(true);
    return autopilot.status();
  });

  handle('pipe:autoToggle', (id, on) => {
    const p = pipeline.list().find((x) => x.id === String(id));
    if (!p) throw new Error('파이프라인을 찾을 수 없습니다.');
    if (on && !autopilot.isSafePipeline(p)) {
      throw new Error(`안전 스텝(${autopilot.SAFE_STEP_TYPES.join('/')})만으로 구성된 파이프라인만 자동 실행할 수 있습니다.`);
    }
    return pipeline.save({
      ...p,
      auto: { enabled: Boolean(on), intervalMin: (p.auto && p.auto.intervalMin) || 1440 },
    });
  });
}

module.exports = { register, AUTOPILOT_JOBS };

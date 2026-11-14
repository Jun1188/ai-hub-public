// Codex 패널 제어(하드웨어 정책·파이프라인) 회귀 테스트.
// LM Studio·외부 프로세스·실제 %APPDATA%를 쓰지 않는다(측정값·파이프라인은 스텁).
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-panel-'));
process.env.APPDATA = SANDBOX;
process.env.AIHUB_HW_REFRESH = '0';

const monitor = require('../src/core/resource-monitor');
const gpufit = require('../src/core/gpufit');
const config = require('../src/core/config');
const hw = require('../src/core/hardware-optimizer');
const panel = require('../src/core/panel-control');
const DEFAULTS = require('../src/core/routing-policy.default.json');

const R1 = '44444444-4444-4444-8444-444444444444', R2 = '55555555-5555-4555-8555-555555555555';

const snap = { sampledAt: Date.now(), cpu: { logicalCores: 16, usagePercent: 10 },
  ram: { totalBytes: 25.1e9, usedBytes: 12e9, usagePercent: 47.8 },
  gpu: { available: true, devices: [{ index: 0, name: 'RTX 5060 Laptop', usagePercent: 2, totalMiB: 8151, usedMiB: 411 }] } };
monitor.peek = () => snap;
gpufit.lastAssessment = () => ({ verdict: 'ok', models: [{ id: 'vendor/fit-8b' }] });
hw._internals.setCatalog([
  { key: 'vendor/fit-8b', type: 'llm', sizeBytes: 6.19e9, maxContext: 32768 },
  { key: 'C:\\Models\\private\\big-14b.gguf', type: 'llm', sizeBytes: 9e9, maxContext: 8192 },
  { key: 'vendor/embed-small', type: 'embedding', sizeBytes: 3e8 },
]);
Object.assign(hw._internals.env, { onAcPower: true, heavyApps: [], at: Date.now() });

const runs = [
  { runId: R1, pipelineId: 'p1', status: 'completed', startedAt: '2026-10-01T00:00:00.000Z' },
  { runId: R2, pipelineId: 'p1', status: 'paused', startedAt: '2026-10-02T00:00:00.000Z', graphCheckpoint: { graphSha: 'x' } },
];
const pipeline = {
  list: () => [{ id: 'p1', name: '빌드', graph: { version: 1 }, steps: [{ type: 'shell' }, { type: 'ai' }] },
    { id: 'p2', name: 'API 점검', steps: [{ type: 'api-request' }], auto: { enabled: true } }],
  history: () => runs, start: (id) => ({ runId: 'run-' + id }), resume: (id) => ({ runId: id }), cancel: (id) => ({ cancelled: id === R2 }),
};
const ctl = panel.createPanelControl({ inHub: () => true, pipeline });
const outside = panel.createPanelControl({ inHub: () => false });

(async () => {
  // 1) 덮어쓰기 계산: 공유 기본값과 같으면 지우고, 초기화는 패널이 다루는 세 항목만 지운다
  let o = panel.nextOverrides({ vram: { reserveBytes: 1 } }, { require_ac_power: !DEFAULTS.admission.requireAcPowerForLocal, max_concurrent: 2 });
  assert.deepEqual(o, { vram: { reserveBytes: 1 }, admission: { requireAcPowerForLocal: !DEFAULTS.admission.requireAcPowerForLocal }, localInference: { maxConcurrent: 2 } });
  o = panel.nextOverrides(o, { max_concurrent: DEFAULTS.localInference.maxConcurrent });
  assert.equal(o.localInference, undefined);
  assert.deepEqual(panel.nextOverrides(o, { reset: true }), { vram: { reserveBytes: 1 } });

  // 2) 하드웨어 상태: 경로 모양 모델 키는 파일 이름만, 임베딩은 로컬 실행 후보에서 뺀다, 사유는 한국어
  const st = await ctl.hardwareStatus();
  assert(!JSON.stringify(st).includes('private'), 'model paths must not reach the panel');
  assert.deepEqual(st.models.map((m) => m.name).sort(), ['big-14b.gguf', 'vendor/fit-8b']);
  const fit = st.models.find((m) => m.name === 'vendor/fit-8b');
  assert(fit.loaded && fit.placement === 'GPU 전체' && fit.expectedMs > 0 && /^[a-f0-9]{64}$/.test(fit.handle));
  assert.equal(st.environment.onAcPower, true);
  assert.equal(st.environment.gpu.name, 'RTX 5060 Laptop');
  assert.equal(st.slot.maxConcurrent, 1);
  assert.equal(st.routes.find((r) => r.label === '코드 수정').text, 'Codex');
  assert.match(st.routes.find((r) => r.label === '요약 (대화형)').text, /^로컬 · vendor\/fit-8b · GPU/);
  assert.equal(st.admission.interactive.localAllowed, true);
  assert.equal(st.settings.maxConcurrent.overridden, false);
  assert.equal(panel.reasonText('heavy-app:Unity'), '무거운 앱 실행 중(Unity)');
  assert.equal(panel.reasonText('over-value-gate:60000'), '실익 기준(60초) 초과');

  // 3) 정책 저장: Hub 프로세스 + 확인 필요. 기기 파일만 쓰고 공유 설정 파일은 만들거나 건드리지 않는다
  assert.throws(() => outside.hardwareSet({ confirmed: true, max_concurrent: 2 }), /ai-hub 앱/);
  assert.throws(() => ctl.hardwareSet({ max_concurrent: 2 }), /확인/);
  const token = config.load().hub.authToken;
  const sharedBefore = fs.existsSync(config.SHARED_FILE) ? fs.readFileSync(config.SHARED_FILE, 'utf8') : null;
  const saved = await ctl.hardwareSet({ confirmed: true, max_concurrent: 2, heavy_app_policy: 'cpu-only' });
  assert.equal(saved.settings.maxConcurrent.value, 2);
  assert(saved.settings.maxConcurrent.overridden && saved.settings.heavyAppPolicy.overridden);
  assert.equal(hw.slotState().maxConcurrent, 1, 'the cross-process lease keeps effective concurrency at one');
  const local = JSON.parse(fs.readFileSync(config.LOCAL_FILE, 'utf8').replace(/^\uFEFF/, ''));
  assert.deepEqual(local.hardware.policyOverrides, { admission: { heavyAppPolicy: 'cpu-only' }, localInference: { maxConcurrent: 2 } });
  assert.equal(local.hub.authToken, token, 'device token preserved');
  assert.equal(fs.existsSync(config.SHARED_FILE) ? fs.readFileSync(config.SHARED_FILE, 'utf8') : null, sharedBefore);
  assert.throws(() => config.setLocalOnly('delegation.defaultTemperature', 0), /기기 전용/);
  const reset = await ctl.hardwareSet({ confirmed: true, reset: true });
  assert.equal(reset.settings.maxConcurrent.value, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(config.LOCAL_FILE, 'utf8').replace(/^\uFEFF/, '')).hardware.policyOverrides, {});

  // 4) 파이프라인: 최근 실행  // 7) 파이프라인: 최근 실행·재개 가능·프로그램/네트워크 표시, 시작·재개·중지
  const pl = ctl.pipelines().pipelines;
  assert.equal(pl[0].lastRun.runId, R2);
  assert(pl[0].lastRun.resumable && pl[0].runsPrograms && !pl[0].network && pl[0].graph);
  assert(pl[1].network && pl[1].auto && pl[1].lastRun === null);
  assert.deepEqual(ctl.pipelineAction({ action: 'start', pipeline_id: 'p1', confirmed: true }), { action: 'start', runId: 'run-p1' });
  assert.throws(() => ctl.pipelineAction({ action: 'start', pipeline_id: 'nope', confirmed: true }), /찾지 못했습니다/);
  assert.deepEqual(ctl.pipelineAction({ action: 'resume', run_id: R2, confirmed: true }), { action: 'resume', runId: R2 });
  assert.deepEqual(ctl.pipelineAction({ action: 'cancel', run_id: R2, confirmed: true }), { action: 'cancel', runId: R2 });
  assert.throws(() => ctl.pipelineAction({ action: 'cancel', run_id: R1, confirmed: true }), /중지할 실행이 없습니다/);
  assert.throws(() => ctl.pipelineAction({ action: 'resume', confirmed: true }), /실행 ID/);
  assert.throws(() => ctl.pipelineAction({ action: 'start', pipeline_id: 'p1' }), /확인/);
  pipeline.resume = () => { throw new Error('그래프가 변경되었습니다. 새 실행을 시작하세요.'); };
  assert.throws(() => ctl.pipelineAction({ action: 'resume', run_id: R2, confirmed: true }), /그래프가 변경/);
  pipeline.start = () => { throw new Error('ENOENT: C:\\secret\\pipelines.json'); };
  assert.throws(() => ctl.pipelineAction({ action: 'start', pipeline_id: 'p1', confirmed: true }), /파이프라인 작업을 완료하지 못했습니다/);

  // 5) MCP 등록: 앱 전용, 안전한 안내문은 그대로 전달하고 내부 오류는 일반 문구
  const regs = [];
  require('../src/mcp/harness-panel-actions').register({ registerTool: (name, definition, fn) => regs.push({ name, definition, fn }) });
  for (const r of regs) assert.deepEqual(r.definition._meta.ui.visibility, ['app']);
  assert(!regs.some((r) => /delegate|session/.test(r.name)), 'panel delegation/session tools were removed in 1.29.0');
  const pipelineTool = regs.find((r) => r.name === 'harness_panel_pipeline');
  const denied = await pipelineTool.fn({ action: 'start', pipeline_id: 'p1', confirmed: true });
  assert(denied.isError);
  assert.match(denied.content[0].text, /ai-hub 앱/);
  const hwTool = await regs.find((r) => r.name === 'harness_panel_hardware').fn({});
  assert(!hwTool.isError && hwTool.structuredContent.models.length === 2);
  assert(!hwTool.content[0].text.includes('private'));

  console.log('Panel control: hardware projection, device-only policy, pipeline control and safe errors passed');
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* temp */ } });

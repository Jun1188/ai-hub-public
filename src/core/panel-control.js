// Codex 패널(MCP Apps)에서 사용자가 직접 누른 제어를 실행하는 핵심 로직.
//
// 왜: 패널은 관찰 전용이라 하드웨어 정책·파이프라인 제어는 Hub 창에서만 됐다.
// 패널 버튼은 앱 전용 도구(_meta.ui.visibility=['app'])로만 들어오고, 바꾸는 작업은 모두
// 패널의 허용 체크와 confirmed:true를 요구한다. AI가 스스로 이 도구를 부를 수는 없다.
//
// 원칙
// - 패널 요청은 15초(플러그인 브리지 10초) 안에 끝나야 한다.
// - 제어는 GUI와 같은 인스턴스(파이프라인·전역 추론 슬롯)를 써야 하므로 Hub 앱
//   (Electron 주 프로세스)에서만 실행한다. stdio 서버에서 부르면 다른 프로세스의 사본을 건드린다.
// - 경로·키를 돌려주지 않는다.
'use strict';

const crypto = require('crypto');
const path = require('path');
const DEFAULT_POLICY = require('./routing-policy.default.json');

const REFRESH_WAIT_MS = 6000;
const PROGRAM_STEPS = new Set(['shell', 'msbuild', 'unity-batch', 'uat']);
const NETWORK_STEPS = new Set(['api-request', 'mcp-tool']);

// 하드웨어 탭의 "어디로 보낼까" 표. 토큰 규모는 대표값이다.
const SCENARIOS = [
  { label: '분류·추출 (대화형)', task: { kind: 'classify', interactive: true, estInputTokens: 800, estOutputTokens: 200 } },
  { label: '요약 (대화형)', task: { kind: 'summarize', interactive: true, estInputTokens: 2000, estOutputTokens: 500 } },
  { label: '요약 (배경)', task: { kind: 'summarize', interactive: false, estInputTokens: 2000, estOutputTokens: 500 } },
  { label: '임베딩 (배경)', task: { kind: 'embed', interactive: false, estInputTokens: 2000, estOutputTokens: 0 } },
  { label: '코드 수정', task: { kind: 'code-edit', interactive: true, estInputTokens: 6000, estOutputTokens: 1500 } },
];

const REASONS = {
  'on-battery': '배터리 사용 중', 'cpu-busy': 'CPU 사용률 높음', 'gpu-busy': 'GPU 사용률 높음',
  'no-dedicated-gpu': '전용 GPU 없음', 'insufficient-memory': '메모리 부족', 'privacy-local-only': '로컬 전용',
  'quality-requires-cloud': '품질상 Codex 권장', 'interactive-prefers-cloud': '대화형은 Codex가 빠름',
  'no-viable-local': '기준 안에 드는 로컬 모델 없음', 'no-local-capacity-within-gate': '기준 안에 드는 로컬 모델 없음',
  'transient-local-block': '일시적 제약으로 보류', 'deterministic-tool-first': '도구 우선',
};

class PanelError extends Error {
  constructor(message) { super(message); this.panelSafe = true; }
}
function refuse(message) { throw new PanelError(message); }

function hubProcess() {
  try { const e = require('electron'); return Boolean(e && typeof e === 'object' && e.app && e.ipcMain); } catch { return false; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());
const handle = (key) => crypto.createHash('sha256').update('lmstudio\0' + key).digest('hex');
/** 모델 키는 보통 "제작자/이름"이다. 경로 모양이면 파일 이름만 보인다. */
const display = (key) => (/[\\:]/.test(String(key)) ? path.win32.basename(String(key)) : String(key)).slice(0, 120);
const secs = (ms) => (Number.isFinite(ms) ? Math.max(1, Math.round(ms / 1000)) + '초' : null);

function reasonText(reason) {
  const r = String(reason);
  if (REASONS[r]) return REASONS[r];
  if (r.startsWith('heavy-app:')) return '무거운 앱 실행 중(' + r.slice(10) + ')';
  if (r.startsWith('gpu-denied:')) return 'GPU 사용 불가: ' + reasonText(r.slice(11));
  if (r.startsWith('over-value-gate:')) return '실익 기준(' + secs(Number(r.slice(16))) + ') 초과';
  if (r.startsWith('below-quality:')) return '품질 기준 미달';
  if (r.startsWith('session-prefix-dominates:')) return '작은 작업은 Codex 세션 하나에 묶기';
  if (r.startsWith('quality:')) return '품질 ' + ({ low: '낮음', medium: '중간', high: '높음' }[r.slice(8)] || r.slice(8));
  return r.slice(0, 80);
}

function placementText(c) {
  if (!c || !c.placement) return null;
  if (c.placement === 'gpu-full') return 'GPU 전체';
  if (c.placement === 'gpu-partial') return 'GPU 일부' + (c.gpuFraction != null ? ' ' + Math.round(c.gpuFraction * 100) + '%' : '');
  return c.placement === 'cpu' ? 'CPU' : '불가';
}

function routeText(a) {
  if (a.route === 'local') return '로컬 · ' + display(a.model) + (a.placement ? ' · ' + placementText(a) : '');
  return { codex: 'Codex', defer: '보류(나중에 로컬)', tool: '도구 우선' }[a.route] || String(a.route);
}

function gateProjection(g) {
  return g ? { localAllowed: Boolean(g.localAllowed), gpuAllowed: Boolean(g.gpuAllowed), reasons: (g.reasons || []).map(reasonText) } : null;
}

function adviceProjection(a) {
  return { route: a.route, text: routeText(a), expectedMs: Number.isFinite(a.expectedMs) ? a.expectedMs : null,
    reasons: (a.reasons || []).slice(0, 6).map(reasonText) };
}

function settingsProjection(pol, overrides) {
  const o = overrides || {};
  const has = (sec, key) => Boolean(o[sec] && Object.prototype.hasOwnProperty.call(o[sec], key));
  const adm = pol.admission || {};
  const conc = Number((pol.localInference || {}).maxConcurrent);
  return {
    requireAcPowerForLocal: { value: Boolean(adm.requireAcPowerForLocal), overridden: has('admission', 'requireAcPowerForLocal') },
    heavyAppPolicy: { value: adm.heavyAppPolicy === 'defer' ? 'defer' : 'cpu-only', overridden: has('admission', 'heavyAppPolicy') },
    maxConcurrent: { value: Number.isInteger(conc) && conc > 0 ? conc : 1, overridden: has('localInference', 'maxConcurrent') },
    heavyApps: (adm.heavyApps || []).map(String).slice(0, 20),
  };
}

/** 공유 기본값과 같은 값은 덮어쓰기에서 지운다. 기본값이 바뀌면 이 PC도 따라가게. */
function nextOverrides(current, a) {
  const next = JSON.parse(JSON.stringify(current || {}));
  const put = (sec, key, value) => {
    const section = { ...(next[sec] || {}) };
    if (value === undefined || value === (DEFAULT_POLICY[sec] || {})[key]) delete section[key];
    else section[key] = value;
    if (Object.keys(section).length) next[sec] = section; else delete next[sec];
  };
  if (a.reset === true) {
    put('admission', 'requireAcPowerForLocal'); put('admission', 'heavyAppPolicy'); put('localInference', 'maxConcurrent');
    return next;
  }
  if (typeof a.require_ac_power === 'boolean') put('admission', 'requireAcPowerForLocal', a.require_ac_power);
  if (a.heavy_app_policy) put('admission', 'heavyAppPolicy', a.heavy_app_policy);
  if (a.max_concurrent) put('localInference', 'maxConcurrent', a.max_concurrent);
  return next;
}

/** 한국어 안내문만 그대로 보인다. 경로 모양 문자가 섞였거나 영어 내부 오류면 대체 문구. */
function safeMessage(e, fallback) {
  const m = String((e && e.message) || '');
  return /[가-힣]/.test(m) && !/[\\:]/.test(m) && m.length <= 200 ? m : fallback;
}

function createPanelControl(deps = {}) {
  const dep = (name, load) => () => deps[name] || load();
  const optimizer = dep('optimizer', () => require('./hardware-optimizer'));
  const pipeline = dep('pipeline', () => require('./pipeline'));
  const config = dep('config', () => require('./config'));
  const inHub = deps.inHub || hubProcess;

  function needHub() {
    if (!inHub()) refuse('ai-hub 앱이 실행 중인 Hub에서만 제어할 수 있습니다. Hub 앱을 실행한 뒤 다시 시도하세요.');
  }

  function localModels(status) {
    return status.models.filter((m) => (m.type || 'llm') === 'llm').map((m) => ({ handle: handle(m.key), key: m.key, name: display(m.key) }));
  }

  async function hardwareStatus({ refresh = false } = {}) {
    const opt = optimizer();
    if (refresh) await Promise.race([Promise.resolve().then(() => opt.refresh()).catch(() => {}), sleep(REFRESH_WAIT_MS)]);
    const s = opt.status();
    const fit = opt.advise({ kind: 'classify', interactive: true, privacy: 'local-only', estInputTokens: 2000, estOutputTokens: 500 });
    const byKey = new Map((fit.candidates || []).filter((c) => c.route === 'local').map((c) => [c.model, c]));
    const gpu = s.resources.gpu || null;
    const loaded = new Set((s.resources.loadedModels || []).map((m) => m.key));
    const overrides = ((config().load().hardware || {}).policyOverrides) || {};
    return {
      measuredAt: s.at,
      environment: {
        onAcPower: s.onAcPower, heavyApps: s.heavyApps.slice(0, 10),
        gpu: gpu ? { name: String((s.machine.gpus[0] || {}).name || 'GPU').slice(0, 80), vramTotalBytes: gpu.vramTotalBytes, vramUsedBytes: gpu.vramUsedBytes } : null,
        ramTotalBytes: s.resources.ramTotalBytes || null, ramUsedBytes: s.resources.ramUsedBytes || null,
      },
      slot: s.slot,
      admission: {
        interactive: gateProjection(fit.admission),
        background: gateProjection(opt.backgroundAdmission()),
      },
      routes: SCENARIOS.map((x) => ({ label: x.label, ...adviceProjection(opt.advise(x.task)) })),
      models: localModels(s).map((m) => {
        const c = byKey.get(m.key) || {};
        return { handle: m.handle, name: m.name, loaded: loaded.has(m.key) || Boolean(c.loaded), placement: placementText(c),
          expectedMs: Number.isFinite(c.expectedMs) ? c.expectedMs : null, basis: c.basis || null,
          withinGate: Boolean(c.withinGate), note: (c.reasons || []).slice(0, 3).map(reasonText).join(', ') || null };
      }),
      settings: settingsProjection(s.policy, overrides),
    };
  }

  function hardwareSet(a) {
    needHub();
    if (a.confirmed !== true) refuse('하드웨어 정책 변경 확인이 필요합니다.');
    const cfg = config();
    const current = (cfg.load().hardware || {}).policyOverrides || {};
    try { cfg.setLocalOnly('hardware.policyOverrides', nextOverrides(current, a)); }
    catch (e) { refuse(safeMessage(e, '하드웨어 정책을 저장하지 못했습니다. Hub 설정 파일을 확인하세요.')); }
    return hardwareStatus();
  }

  function pipelines() {
    const p = pipeline();
    const last = new Map();
    for (const r of p.history()) {
      const prev = last.get(r.pipelineId);
      if (!prev || String(r.startedAt) > String(prev.startedAt)) last.set(r.pipelineId, r);
    }
    return {
      pipelines: p.list().slice(0, 50).map((x) => {
        const types = [...new Set((x.steps || []).map((st) => String((st && st.type) || '')).filter(Boolean))];
        const r = last.get(x.id);
        return { id: String(x.id), name: String(x.name || '이름 없음').slice(0, 120), graph: Boolean(x.graph), steps: (x.steps || []).length,
          types, runsPrograms: types.some((t) => PROGRAM_STEPS.has(t)), network: types.some((t) => NETWORK_STEPS.has(t)),
          auto: Boolean(x.auto && x.auto.enabled),
          lastRun: r ? { runId: r.runId, status: r.status, startedAt: r.startedAt || null, finishedAt: r.finishedAt || null,
            resumable: r.status === 'paused' && Boolean(r.graphCheckpoint) } : null };
      }),
    };
  }

  function pipelineAction(a) {
    needHub();
    if (a.confirmed !== true) refuse('파이프라인 제어 확인이 필요합니다.');
    const p = pipeline();
    try {
      if (a.action === 'start') {
        if (!a.pipeline_id || !p.list().some((x) => x.id === a.pipeline_id)) refuse('파이프라인을 찾지 못했습니다. 목록을 새로고침하세요.');
        return { action: 'start', runId: p.start(a.pipeline_id).runId };
      }
      if (!a.run_id) refuse('실행 ID가 필요합니다.');
      if (a.action === 'resume') return { action: 'resume', runId: p.resume(a.run_id).runId };
      if (!p.cancel(a.run_id).cancelled) refuse('중지할 실행이 없습니다. 이미 끝났을 수 있습니다.');
      return { action: 'cancel', runId: a.run_id };
    } catch (e) {
      if (e.panelSafe) throw e;
      refuse(safeMessage(e, '파이프라인 작업을 완료하지 못했습니다. Hub의 파이프라인 화면에서 확인하세요.'));
    }
  }

  return { hardwareStatus, hardwareSet, pipelines, pipelineAction };
}

let singleton;
function instance() { return singleton || (singleton = createPanelControl()); }

module.exports = { createPanelControl, instance, nextOverrides, reasonText, safeMessage, display, handle, PanelError };

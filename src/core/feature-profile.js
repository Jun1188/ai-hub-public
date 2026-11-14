'use strict';
// Which Hub screens and MCP tools a device shows. One table for both profiles: a lite device filters it instead of
// running a forked overlay, so every overlay update reaches the laptop too. Full shows everything. Lite shows the
// `lite: true` features unless the user picked others (device-only `hub.liteFeatures`). Settings is always shown so a
// lite device can switch back. Hidden screens stay in the page (handlers and IPC unchanged) — only their buttons go.
const FEATURES = [
  { id: 'dashboard', label: '대시보드', tabs: ['dashboard'], lite: true },
  { id: 'debugging', label: '디버깅', tabs: ['debugging'], lite: true },
  { id: 'history', label: '이력', tabs: ['history'], lite: false },
  { id: 'agents', label: '에이전트 작업실 (로컬 모델 · MCP 연결)', tabs: ['aider'], lite: false },
  { id: 'creation', label: '리소스 제작실', tabs: ['creation'], tools: [/^creation_studio_/], lite: false },
  { id: 'orchestration', label: 'Herdr 오케스트레이션', tabs: ['orchestration'], tools: [/^herdr_/], lite: false },
  { id: 'pipelines', label: '파이프라인', tabs: ['pipelines'], lite: false },
  { id: 'projects', label: '게임 프로젝트', tabs: ['projects'], lite: false },
  { id: 'knowledge', label: '지식 그래프', tabs: ['knowledge'], lite: true },
  { id: 'skills', label: '스킬', tabs: ['skills'], lite: false },
  { id: 'source', label: '소스 분석 · 학습 (색인 · 검색 · 질문)', tabs: ['source', 'learning'], lite: true },
  // Game-engine source analysis: symbol map, deep analysis, render pipeline, fine-tune data, and their MCP tools.
  { id: 'engine-source', label: '게임 엔진 소스 분석 (심볼 맵 · 심층 분석 · 렌더 파이프라인 · ue_* 도구)', tabs: [],
    tools: [/^ue_/, /^render_pipeline_/, /^symbol_/, /^deep_analysis_briefing$/], lite: false },
  { id: 'memory', label: '메모리', tabs: ['memory'], lite: false },
  { id: 'selfimprove', label: '자가개선', tabs: ['selfimprove'], lite: false },
];
const IDS = FEATURES.map((f) => f.id);

function lite(cfg) { return require('./device-profile').lite(cfg); }

/** Known ids only, in table order — the settings screen sends this list back. */
function sanitize(list) { return Array.isArray(list) ? IDS.filter((id) => list.includes(id)) : null; }

const liteSet = (cfg) => new Set(sanitize(cfg.hub?.liteFeatures) || FEATURES.filter((f) => f.lite).map((f) => f.id));
function enabled(cfg = require('./config').load()) {
  if (require('./public-profile').enabled) return new Set(require('./public-profile').FEATURES);
  return lite(cfg) ? liteSet(cfg) : new Set(IDS);
}

/** Renderer view: profile, every feature with its state here and in lite mode, and the tab buttons to hide. */
function view(cfg = require('./config').load()) {
  const on = enabled(cfg), inLite = liteSet(cfg);
  return { profile: lite(cfg) ? 'lite' : 'full', features: FEATURES.map((f) => ({ id: f.id, label: f.label, enabled: on.has(f.id), inLite: inLite.has(f.id) })),
    hiddenTabs: FEATURES.filter((f) => !on.has(f.id)).flatMap((f) => f.tabs) };
}

/** MCP registration filter: a tool belonging to a disabled feature is not offered on this device. */
function toolEnabled(name, cfg = require('./config').load()) {
  const on = enabled(cfg);
  return !FEATURES.some((f) => !on.has(f.id) && (f.tools || []).some((re) => re.test(name)));
}

module.exports = { FEATURES, sanitize, enabled, view, toolEnabled };

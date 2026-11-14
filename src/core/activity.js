// 통합 활동 기록 — 로컬 모델 호출·offload 작업·Aider·파이프라인을 한 목록으로 모은다.
//
// 왜: 이력 탭은 LM Studio 직접 위임(history.jsonl)만 보여 줘서, 1.15 이후 중심 경로인
// Aider·에이전트 세션·상태 그래프 파이프라인 활동이 하나도 보이지 않았다(2026-10-04
// 겜트북: "이력이 7/30에서 멈췄다"). 각 기록은 원래 저장소에 그대로 두고 읽기만 한다.
// 1.28까지의 에이전트 세션 기록은 1.29.0에서 offload 작업 기록으로 바뀌었다.
// 기록은 PC마다 따로 있다(공유 대상 아님) — 다른 PC의 활동은 그 PC의 Hub에서 본다.
'use strict';

const fs = require('fs');
const path = require('path');

const KINDS = ['delegation', 'offload', 'aider', 'pipeline', 'command'];
const SOURCE_LABEL = {
  panel: '패널 위임', mcp: 'AI 위임(MCP)', 'auto-memory': '자동 기억 추출', 'memory-compact': '세션 압축',
  orchestrate: '오케스트레이션', pipeline: '파이프라인 단계',
};
const OFFLOAD_STATUS = { running: 'running', succeeded: 'ok', failed: 'failed', declined: 'skipped', cancelled: 'cancelled' };
const RUN_STATUS = { running: 'running', paused: 'paused', completed: 'ok', succeeded: 'ok', failed: 'failed', cancelled: 'cancelled' };

const text = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const span = (a, b) => {
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};

function delegations(stats) {
  return stats.history(300).map((r) => ({
    at: r.ts, kind: 'delegation', title: text(r.promptPreview, 120), actor: text(r.model, 80),
    detail: [SOURCE_LABEL[r.source] || '위임', r.taskType].filter(Boolean).join(' · '),
    status: !r.ok ? 'failed' : r.skipped ? 'skipped' : r.escalationRequested ? 'escalated' : 'ok',
    durationMs: typeof r.elapsedMs === 'number' ? r.elapsedMs : null, error: r.ok ? null : text(r.error, 200) || null,
  }));
}

// offload 기록에는 작업 지시·파일 경로가 없다(offload.js) — 개수·모델·상태만 보여 준다.
function offloadJobs(list) {
  return list.map((r) => ({
    at: r.finishedAt || r.createdAt, kind: 'offload', title: `입력 ${r.inputs || 0}개 · 결과 ${r.resultCount || 0}개`,
    actor: [r.worker, r.model].filter(Boolean).join(' · '),
    detail: [r.placement, r.reason].filter(Boolean).join(' · ') || 'offload',
    status: OFFLOAD_STATUS[r.state] || text(r.state, 20), durationMs: r.usage && typeof r.usage.workerMs === 'number' ? r.usage.workerMs : null,
    error: r.state === 'failed' ? text(r.reason, 200) || null : null,
  }));
}

function aiderRuns(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => /^aider-[a-z0-9]+\.json$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 200);
  const out = [];
  for (const { f } of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({
        at: r.finishedAt, kind: 'aider', title: `Aider · ${path.basename(String(r.projectDir || '')) || '프로젝트'}`,
        actor: text(r.model, 80), detail: text(r.provider, 40), status: r.ok ? 'ok' : 'failed',
        durationMs: typeof r.elapsedMs === 'number' ? r.elapsedMs : null, error: null,
      });
    } catch { /* 깨진 기록 하나는 건너뛴다 */ }
  }
  return out;
}

function pipelineRuns(pipeline) {
  return pipeline.history().map((r) => {
    const steps = Array.isArray(r.steps) ? r.steps : [];
    const failed = steps.filter((s) => s.status === 'failed').length;
    return {
      at: r.finishedAt || r.startedAt, kind: 'pipeline', title: text(r.pipelineName || r.pipelineId, 120), actor: '파이프라인',
      detail: steps.length ? `단계 ${steps.length}개${failed ? ` · 실패 ${failed}` : ''}` : '상태 그래프',
      status: RUN_STATUS[r.status] || text(r.status, 20), durationMs: span(r.startedAt, r.finishedAt), error: null,
    };
  });
}

// 채팅 명령(/discord·/actions·/drive·/api·@태그) 실행 기록. hub-commands.js가 가린 글만 남긴다(로컬 파일, 공유 대상 아님).
function commandRuns(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-300).map((line) => {
    try { return JSON.parse(line); } catch { return null; } // 잘린 줄 하나는 건너뛴다
  }).filter(Boolean).map((r) => ({
    at: r.at, kind: 'command', title: text(r.text, 120), actor: r.via === 'ui' ? 'Hub 화면' : 'MCP',
    detail: [r.command, r.write ? '쓰기' : '읽기'].join(' · '), status: r.ok ? 'ok' : 'failed',
    durationMs: typeof r.ms === 'number' ? r.ms : null, error: r.ok ? null : text(r.error, 200) || null,
  }));
}

/**
 * {items, summary}. items는 최신순, summary는 종류별 {count, last, error?}.
 * 출처 하나가 실패해도 나머지는 보여 준다.
 */
function collect({ kind, limit = 150 } = {}, deps = {}) {
  const sources = {
    delegation: () => delegations(deps.stats || require('./stats')),
    offload: () => offloadJobs((deps.offload || require('./offload')).list()),
    aider: () => aiderRuns(deps.aiderDir !== undefined ? deps.aiderDir : require('./aider-studio').RUNS_DIR),
    pipeline: () => pipelineRuns(deps.pipeline), // 위 계층(파이프라인)은 부르는 쪽이 넘긴다 — 없으면 이 출처만 error
    command: () => commandRuns(deps.commandLog !== undefined ? deps.commandLog : path.join(require('./paths').hubDataDir(), 'hub-commands.jsonl')),
  };
  const items = [];
  const summary = {};
  for (const k of KINDS) {
    try {
      const rows = sources[k]().filter((r) => r.at);
      summary[k] = { count: rows.length, last: rows.reduce((m, r) => (String(r.at) > m ? String(r.at) : m), '') || null };
      if (!kind || kind === k) items.push(...rows);
    } catch {
      summary[k] = { count: 0, last: null, error: true };
    }
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { items: items.slice(0, Math.max(1, Math.min(500, Number(limit) || 150))), summary };
}

module.exports = { collect, KINDS, SOURCE_LABEL };

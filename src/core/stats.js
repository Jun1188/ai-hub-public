// Delegation history (JSONL) and per-model latency statistics (EMA).
// Shared across processes (GUI + every stdio hub instance) via files in the
// hub data dir, so writes are append-only or whole-file atomic-ish.
'use strict';

const fs = require('fs');
const path = require('path');
const { hubDataDir } = require('./paths');

const HISTORY_FILE = path.join(hubDataDir(), 'history.jsonl');
const STATS_FILE = path.join(hubDataDir(), 'stats.json');
const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const BACKGROUND_SOURCES = new Set(['auto-memory', 'memory-compact']);
let statsFileExpected = false;
let historyFileExpected = false;

function validModelStats(model) {
  return model && typeof model === 'object' && !Array.isArray(model) &&
    Number.isSafeInteger(model.count) && model.count >= 0 &&
    (model.emaMs == null || (Number.isFinite(model.emaMs) && model.emaMs >= 0)) &&
    (model.totalTokens === undefined || (Number.isSafeInteger(model.totalTokens) && model.totalTokens >= 0)) &&
    (model.reasoningRatio == null || (Number.isFinite(model.reasoningRatio) && model.reasoningRatio >= 0 && model.reasoningRatio <= 1));
}

function readStats() {
  try {
    const text = fs.readFileSync(STATS_FILE, 'utf8');
    statsFileExpected = true;
    const stats = JSON.parse(text.replace(/^\uFEFF/, ''));
    const models = stats && stats.models;
    if (models && typeof models === 'object' && !Array.isArray(models) &&
        Object.values(models).every(validModelStats)) {
      return stats;
    }
  } catch (error) {
    if (error.code === 'ENOENT' && !statsFileExpected) return { models: {} };
    statsFileExpected = true;
  }
  // 권한·잠금·손상은 측정값 부재와 다르다. 원본을 빈 통계로 다시 쓰지 않는다.
  return null;
}

function writeStats(stats) {
  // 임시 파일 → rename. 쓰는 도중 다른 프로세스가 읽어 반쪽 JSON을 기본값으로 덮지 않게 한다.
  const tmp = `${STATS_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2), 'utf8');
    fs.renameSync(tmp, STATS_FILE);
    statsFileExpected = true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* stats are best-effort */ }
  }
}

/** Exponential moving average latency per model (ms). */
function latencyOf(modelId) {
  const s = readStats()?.models[modelId];
  return s?.emaMs ?? null;
}

/**
 * 판단에 써도 되는 지연 EMA. 표본이 적거나(minSamples 미만) 오래됐으면(maxAgeMs 초과) null.
 * 왜: 실익 게이트가 반려한 모델은 다시 측정되지 않아 EMA가 영영 회복되지 않았다.
 * 모델·하드웨어·설정이 바뀐 뒤에도 몇 달 전 값이 위임을 막는 일을 끊는다.
 */
function freshLatencyOf(modelId, { minSamples = 3, maxAgeMs = 30 * 86400000 } = {}) {
  const s = readStats()?.models[modelId];
  if (!s || s.emaMs == null || (s.count || 0) < minSamples) return null;
  const at = Date.parse(s.lastUsed || '');
  if (!Number.isFinite(at) || Date.now() - at > maxAgeMs) return null;
  return s.emaMs;
}

/** 모델별 통계 전체(읽기 1회). 하드웨어 어드바이저 입력용. */
function models() {
  return readStats()?.models || {};
}

/**
 * 이 모델이 응답 예산 중 히든 추론에 쓰는 비율(EMA). 관측이 없으면 null.
 * reply-budget.js가 이 값만큼 max_tokens를 부풀린다 — 모델 이름으로 추론형인지
 * 맞히지 않고 실제로 나온 usage를 쓴다.
 */
function reasoningRatioOf(modelId) {
  const s = readStats()?.models[modelId];
  return s && typeof s.reasoningRatio === 'number' ? s.reasoningRatio : null;
}

/**
 * Record one delegation. entry: {taskType, model, promptPreview, elapsedMs,
 * ok, error?, escalationRequested?, tokens?, reasoningRatio?, truncated?}
 */
function record(entry) {
  // source는 어느 기능이 맡겼는지, caller는 누가 그 기능을 불렀는지(MCP 클라이언트·GUI·파이프라인·스크립트)다.
  const row = { ts: new Date().toISOString(), caller: require('./caller').current(), ...entry };
  try {
    const { O_WRONLY, O_APPEND, O_CREAT } = fs.constants;
    const flag = O_WRONLY | O_APPEND | (historyFileExpected ? 0 : O_CREAT);
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(row) + '\n', { encoding: 'utf8', flag });
    historyFileExpected = true;
    // Trim the file if it grew too large: keep the newest half.
    const st = fs.statSync(HISTORY_FILE);
    if (st.size > MAX_HISTORY_BYTES) {
      const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(HISTORY_FILE, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n', 'utf8');
    }
  } catch { /* history is best-effort */ }

  // 추론을 하지 않은 반려(context·value)는 지연 관측이 아니다. 0ms에 가까운 값이 EMA를
  // 끌어내리면 느린 모델이 빨라 보인다. 'time'은 실제로 상한까지 돈 관측이라 반영한다.
  const inferenceSkipped = entry.skipped === 'context' || entry.skipped === 'value';
  // 배경 보조 호출(자동 기억 추출·세션 압축)은 출력이 300토큰 안팎이라 실제 위임보다 짧다.
  // EMA에 섞으면 느린 모델이 빨라 보여 라우팅이 틀린다. 이력에는 그대로 남긴다.
  const background = BACKGROUND_SOURCES.has(entry.source);
  if (entry.ok && !inferenceSkipped && !background && entry.model && Number.isFinite(entry.elapsedMs) && entry.elapsedMs >= 0) {
    const stats = readStats();
    if (!stats) return; // 이력 추가와 위임 결과는 유지한다. 다음 기록에서 다시 읽는다.
    const m = stats.models[entry.model] || { count: 0, emaMs: null, totalTokens: 0 };
    const tokens = entry.tokens ?? 0;
    const cumulative = (m.totalTokens ?? 0) + tokens;
    if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isSafeInteger(cumulative) || !Number.isSafeInteger(m.count + 1)) return;
    m.count += 1;
    m.emaMs = m.emaMs == null ? entry.elapsedMs : Math.round(m.emaMs * 0.7 + entry.elapsedMs * 0.3);
    m.totalTokens = cumulative;
    if (Number.isFinite(entry.reasoningRatio) && entry.reasoningRatio >= 0 && entry.reasoningRatio <= 1) {
      m.reasoningRatio = m.reasoningRatio == null
        ? entry.reasoningRatio
        : Number((m.reasoningRatio * 0.7 + entry.reasoningRatio * 0.3).toFixed(4));
    }
    m.lastUsed = row.ts;
    stats.models[entry.model] = m;
    writeStats(stats);
  }
}

function readHistory(limit) {
  let text;
  try {
    text = fs.readFileSync(HISTORY_FILE, 'utf8').replace(/^\uFEFF/, '');
    historyFileExpected = true;
  } catch (error) {
    if (error.code === 'ENOENT' && !historyFileExpected) return { rows: [], skipped: 0 };
    historyFileExpected = true;
    return null;
  }
  const rows = [];
  let skipped = 0;
  for (const line of text.split('\n').filter(Boolean).slice(-limit).reverse()) {
    try {
      const entry = JSON.parse(line);
      // 초기 버전에도 ts와 ok가 있었다. source, caller, model 등 후대 필드는 선택이다.
      if (entry && typeof entry.ok === 'boolean' &&
          (typeof entry.ts === 'string' || typeof entry.ts === 'number') &&
          Number.isFinite(new Date(entry.ts).getTime())) {
        rows.push(entry);
        continue;
      }
    } catch { /* Keep other rows, including rows written before this version. */ }
    skipped++;
  }
  return { rows, skipped };
}

/** Most recent readable history rows, newest first. */
function history(limit = 100) {
  const data = readHistory(limit);
  if (!data || (data.skipped > 0 && !data.rows.length)) throw new Error('위임 이력을 읽을 수 없습니다.');
  return data.rows;
}

function summary() {
  const stats = readStats();
  const data = readHistory(500);
  const available = data && (data.skipped === 0 || data.rows.length > 0);
  const rows = available ? data.rows.filter((r) => !BACKGROUND_SOURCES.has(r.source)) : null;
  return {
    totalDelegations: rows?.length ?? null,
    okCount: rows ? rows.filter((r) => r.ok).length : null,
    escalations: rows ? rows.filter((r) => r.escalationRequested).length : null,
    background: rows ? data.rows.length - rows.length : null,
    models: stats?.models ?? null,
    skippedHistoryRows: data?.skipped ?? 0,
  };
}

module.exports = { record, history, summary, latencyOf, freshLatencyOf, models, reasoningRatioOf, HISTORY_FILE, STATS_FILE, BACKGROUND_SOURCES };

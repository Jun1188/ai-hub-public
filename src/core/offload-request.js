// offload 요청 계약: 작업자·tier 검사, 단일 입력과 agy 묶음(tasks), 경로 중복 제거, 전체 상한.
// 작업 상태가 필요 없는 순수 검사라 offload.js(작업 수명·저장·취소)에서 떼어 냈다.
'use strict';
const path = require('path');

const MAX_FILES = 64;
const MAX_TASKS = 16; // 묶음 하나의 작업 수. 실측은 10개(2026-10-18)
const MAX_TEXT_CHARS = 2 * 1024 * 1024;
const WORKERS = ['local', 'codex', 'agy'];

function unit(a, at = '') {
  const task = typeof a.task === 'string' ? a.task.trim() : '';
  if (!task || task.length > 8000) throw new Error(`${at}task must be 1-8000 characters`);
  const files = a.files === undefined ? [] : a.files;
  if (!Array.isArray(files) || files.length > MAX_FILES || files.some((f) => typeof f !== 'string' || !path.isAbsolute(f))) {
    throw new Error(`${at}files must be at most ${MAX_FILES} absolute paths`);
  }
  const text = typeof a.text === 'string' ? a.text : '';
  if (text.length > MAX_TEXT_CHARS) throw new Error(`${at}text exceeds 2 MiB`);
  if (a.schema !== undefined && (!a.schema || typeof a.schema !== 'object' || Array.isArray(a.schema))) throw new Error(`${at}schema must be a JSON Schema object`);
  return { task, files: [...new Set(files)], text, schema: a.schema || null };
}

// 전문가 재프롬프팅(expert-reprompt.js)은 청할 때만, 결정적 판정이 적용 대상일 때만 감싼다. 감싸지 않은 이유는 결과에 남는다.
// 스키마 작업은 감싸지 않는다: 프레임워크는 네 항목 분석을 "제시"하라고 하는데 스키마 검사 결과에는 실을 자리가 없다.
// agy 묶음도 감싸지 않는다: 묶음은 실행마다 붙는 고정 비용을 나누려는 것인데 작업마다 접두부를 붙이면 그 목적을 거스른다.
function expertFor(one, worker, requested) {
  if (requested === undefined) return { one, expert: null };
  if (typeof requested !== 'boolean') throw new Error('expert must be a boolean');
  if (!requested) return { one, expert: null };
  const er = require('./expert-reprompt');
  if (one.schema) return { one, expert: { applied: false, reason: 'schema_output' } };
  const v = er.classify(one.task);
  if (!v.apply) return { one, expert: { applied: false, reason: v.reason, category: v.category } };
  const w = er.wrap(one.task, { target: worker === 'local' ? 'local' : 'agent' });
  const expert = { applied: true, reason: v.reason, category: v.category, version: w.version, prefixSha256: w.prefixSha256 };
  // local: 접두부는 조각 앞(runLocal의 expertLead), 요청과 행동 지시는 데이터 뒤의 Task 칸에. 원격 작업자는 접두부 → 요청 순서 그대로.
  if (worker === 'local') return { one: { ...one, task: w.request + er.LOCAL_TAIL, expertLead: w.prefix + '\n\n' }, expert };
  return { one: { ...one, task: w.prompt }, expert };
}

function modelSelection(a) {
  const worker = a.worker === undefined ? 'local' : a.worker;
  if (!WORKERS.includes(worker)) throw new Error('worker must be local, codex or agy');
  if (a.tier !== undefined && worker !== 'agy') throw new Error('tier applies only to worker agy');
  const { AGY_TIERS, AGY_DEFAULT_TIER, AGY_MODEL_ID } = require('./agent-workers');
  if (a.tier !== undefined && !AGY_TIERS.includes(a.tier)) throw new Error(`tier must be ${AGY_TIERS.join(' or ')}`);
  if (a.model !== undefined && worker !== 'agy') throw new Error('model applies only to worker agy');
  if (a.model !== undefined && (typeof a.model !== 'string' || a.model.length > 128 || !AGY_MODEL_ID.test(a.model))) {
    throw new Error('model must be an exact Gemini 4 model ID ending in low, medium, high, xhigh or max');
  }
  if (a.model !== undefined && a.tier !== undefined) throw new Error('give either model or tier, not both');
  const model = a.model ?? null;
  const tier = worker === 'agy' && !model ? a.tier || AGY_DEFAULT_TIER : null;
  return { worker, model, tier };
}

function normalize(a = {}) {
  const {worker, model, tier} = modelSelection(a);
  const maxOutputTokens = Math.max(64, Math.min(8192, Math.floor(Number(a.maxOutputTokens) || 1024)));
  if (a.tasks === undefined) {
    const { one, expert } = expertFor(unit(a), worker, a.expert);
    if (worker !== 'codex' && !one.files.length && !one.text) throw new Error(`${worker} offload needs files or text`);
    return { ...one, worker, maxOutputTokens, model, tier, expert };
  }
  if (a.expert !== undefined && typeof a.expert !== 'boolean') throw new Error('expert must be a boolean');
  // 묶음은 agy만: 고정 비용(실행마다 입력 약 2만 토큰)을 나누는 것이 목적이고, 결과를 작업마다 스키마로 검사한다.
  if (worker !== 'agy') throw new Error('tasks applies only to worker agy');
  if (['task', 'files', 'text', 'schema'].some((k) => a[k] !== undefined)) throw new Error('give either task or tasks, not both');
  if (!Array.isArray(a.tasks) || a.tasks.length < 2 || a.tasks.length > MAX_TASKS) throw new Error(`tasks must hold 2-${MAX_TASKS} tasks`);
  const tasks = a.tasks.map((t, i) => unit(t && typeof t === 'object' ? t : {}, `tasks[${i}].`));
  tasks.forEach((t, i) => {
    if (!t.files.length && !t.text) throw new Error(`tasks[${i}] needs files or text`);
    if (!t.schema) throw new Error(`tasks[${i}].schema is required`);
  });
  const files = [...new Set(tasks.flatMap((t) => t.files))];
  if (files.length > MAX_FILES) throw new Error(`tasks may use at most ${MAX_FILES} files in total`);
  if (tasks.reduce((n, t) => n + t.text.length, 0) > MAX_TEXT_CHARS) throw new Error('text exceeds 2 MiB in total');
  return { tasks, task: '', files, text: '', worker, schema: null, maxOutputTokens, model, tier,
    expert: a.expert ? { applied: false, reason: 'batch_tasks' } : null };
}

module.exports = { normalize, WORKERS, modelSelection };

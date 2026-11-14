// Local embedding client (LM Studio /v1/embeddings). Everything stays on-device.
'use strict';

const config = require('./config');
const failures = require('./source-failures');
const { setTimeout: delay } = require('timers/promises');

const DEFAULT_MODEL = 'text-embedding-nomic-embed-text-v1.5';
const BATCH = 32;

function model() {
  const cfg = config.load();
  return (cfg.index && cfg.index.embeddingModel) || DEFAULT_MODEL;
}

async function request(pathname, options, { signal, timeoutMs } = {}) {
  const base = config.load().lmstudio.baseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs || 300000);
  try {
    const res = await fetch(`${base}${pathname}`, { ...options, signal: controller.signal });
    if (!res.ok) throw Object.assign(new Error('Embedding HTTP error'), { status: res.status });
    return await res.json();
  } catch (err) {
    if (signal?.aborted) throw failures.failure('cancelled', 'cancelled');
    if (controller.signal.aborted) throw failures.failure('response_timeout', 'Embedding response timeout', { cause: err });
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function preflight({ signal } = {}) {
  const data = await request('/v1/models', {}, { signal, timeoutMs: 8000 });
  if (!Array.isArray(data?.data)) throw failures.failure('invalid_response', '모델 목록 응답이 올바르지 않습니다.');
  if (!data.data.some(m => m && m.id === model())) throw failures.failure('model_missing', '설정한 임베딩 모델이 서버 목록에 없습니다.');
}

/** 모델 오버라이드는 스킬 검색 등의 별도 벡터 공간을 유지한다. */
async function embed(texts, { model: override, signal, onAttempt } = {}) {
  const cfg = config.load();
  const out = [];
  let dims;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map((t) => t.slice(0, 8000));
    // Long index builds must survive transient LM Studio hiccups (model
    // eviction/reload, momentary connection failures): retry with backoff.
    let lastErr;
    const attempts = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await delay([2000, 8000, 20000][attempt - 1], undefined, { signal });
      const started = Date.now();
      try {
        const data = await request('/v1/embeddings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: override || model(), input: batch }),
        }, { signal, timeoutMs: Math.max(1000, Math.min(Number(cfg.lmstudio.timeoutMs) || 300000, 1800000)) });
        if (!Array.isArray(data?.data) || data.data.some(d => !d || typeof d !== 'object')) {
          throw failures.failure('invalid_response', '임베딩 응답의 행 형식이 올바르지 않습니다.');
        }
        const rows = data.data.slice().sort((a, b) => a.index - b.index);
        if (rows.length !== batch.length || rows.some((d, k) => d.index !== k || !Array.isArray(d.embedding)
          || !d.embedding.length || d.embedding.some(v => typeof v !== 'number' || !Number.isFinite(v)))) {
          throw failures.failure('invalid_response', 'Invalid embedding rows');
        }
        dims = dims || rows[0].embedding.length;
        if (rows.some(d => d.embedding.length !== dims || d.embedding.some(v => !Number.isFinite(Math.fround(v))))) {
          throw failures.failure('invalid_response', 'Inconsistent embedding dimensions');
        }
        for (const d of rows) out.push(Float32Array.from(d.embedding));
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const diagnostic = failures.describe(err);
        const detail = { attempt: attempt + 1, batchStart: i, elapsedMs: Date.now() - started, ...diagnostic };
        attempts.push(detail);
        if (onAttempt) onAttempt(detail);
        err.attempts = attempts;
        if (!diagnostic.retryable) break;
      }
    }
    if (lastErr) throw lastErr;
  }
  return out;
}

/** Cosine similarity for pre-normalized or raw vectors. */
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

module.exports = { embed, cosine, model, preflight };

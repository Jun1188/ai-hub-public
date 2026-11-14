// IPC: 소스 분석 — 학습 Q&A, UE 렌더링 파이프라인 맵, C++ 소스 인덱스, 파인튜닝 데이터셋.
//
// 오래 걸리는 작업(인덱싱·데이터셋 생성·렌더러 스캔)은 즉시 {started:true}를 돌려주고
// 진행 상황은 이벤트 채널로 흘려보낸다 — 렌더러가 응답을 기다리며 멈추지 않도록.
'use strict';

const fs = require('fs');
const { dialog, shell } = require('electron');

const codeindex = require('../../src/core/codeindex');
const finetune = require('../../src/core/finetune');
const renderpipe = require('../../src/core/renderpipe');
const symbolmap = require('../../src/core/symbolmap');
const sourceQa = require('../../src/core/source-qa');
const deepdive = require('../../src/core/deepdive');
const failures = require('../../src/core/source-failures');
const cloud = require('../../src/core/source-cloud');
const crypto = require('crypto');

/** @param {import('./register-handlers').IpcContext} ctx */
function register(ctx) {
  const { handle: registerHandler, send, window } = ctx;
  const diagnosed = new Set(['learn:ask', 'index:search', 'index:class', 'index:build', 'index:cloudPreview', 'index:cloudStart', 'dd:analyze']);
  const handle = (channel, fn) => registerHandler(channel, async (...args) => {
    try { return await fn(...args); }
    catch (e) {
      if (!diagnosed.has(channel)) throw e;
      const diagnostic = failures.describe(e);
      const logError = await cloud.diagnostics({ jobId: crypto.randomUUID(), operation: channel, stage: 'failed', ...diagnostic });
      throw new Error(`[${diagnostic.category}] ${diagnostic.hint}${logError ? ' (진단 저장 실패)' : ''}`);
    }
  });

  handle('learn:ask', (indexName, question, save) =>
    sourceQa.ask(String(indexName), String(question), { save: Boolean(save) }));

  // ---- 렌더링 파이프라인 분석 (UE 렌더러 구조 스캔 + 흐름 설명) ----
  handle('rp:list', () => renderpipe.list());
  handle('rp:suggest', () => renderpipe.suggestRoots());
  handle('rp:scan', (name, root) => renderpipe.scan(String(name), String(root)));
  handle('rp:query', (name, filter) => renderpipe.query(String(name), String(filter || '')));
  handle('rp:remove', (name) => renderpipe.removeMap(String(name)));
  handle('rp:analyze', (name, topic, save) =>
    renderpipe.analyze(String(name), String(topic), { save: Boolean(save) }));

  // ---- 엔진 심볼 맵 (경로 매핑 → 정적 스캔, 모델 불필요) ----
  // 스캔이 수 초 걸려도 렌더러를 세우지 않도록 다른 장기 작업과 같은 규약을 쓴다:
  // 즉시 {started:true}, 진행 상황은 이벤트로.
  handle('sym:list', () => symbolmap.list());
  handle('sym:suggest', () => symbolmap.suggestRoots());
  handle('sym:scan', (opts) => {
    const p = {
      name: String((opts && opts.name) || ''),
      root: String((opts && opts.root) || ''),
      notesRoots: Array.isArray(opts && opts.notesRoots) ? opts.notesRoots.map(String) : [],
    };
    setImmediate(() => {
      try {
        const info = symbolmap.scan(p, (prog) => send('sym:progress', { name: p.name, ...prog }));
        send('sym:done', { name: p.name, info });
      } catch (e) {
        send('sym:done', { name: p.name, error: String((e && e.message) || e) });
      }
    });
    return { started: true };
  });
  handle('sym:find', (name, query, opt) => symbolmap.find(String(name), String(query || ''), opt || {}));
  // 1계층 → 2계층 다리: 이 질의가 걸린 심볼들이 모인 디렉터리만 돌려준다.
  handle('sym:scope', (name, query, opt) => symbolmap.scopeFor(String(name), String(query || ''), opt || {}));
  handle('sym:hierarchy', (name, sym) => symbolmap.hierarchy(String(name), String(sym)));
  handle('sym:remove', (name) => symbolmap.remove(String(name)));
  // ---- 심층 분석 (3계층: 브리핑 → 외부 AI/로컬 분석) ----
  // 미리보기는 실제로 보낼 그 텍스트를 돌려준다 — 외부 전송 전 확인이 목적이므로
  // 요약본이 아니라 원문이어야 한다.
  handle('dd:reviewers', () => deepdive.reviewers());
  handle('dd:preview', (opts) => deepdive.briefing({
    map: String(opts.map), topic: String(opts.topic), question: String(opts.question || ''),
    index: String(opts.index || ''), includeSource: Boolean(opts.includeSource),
  }));
  handle('dd:analyze', (opts) => deepdive.analyze({
    map: String(opts.map), topic: String(opts.topic), question: String(opts.question || ''),
    index: String(opts.index || ''), includeSource: Boolean(opts.includeSource),
    reviewer: String(opts.reviewer || 'local'), save: Boolean(opts.save),
  }));

  handle('sym:pickDir', async () => {
    const r = await dialog.showOpenDialog(window(), { properties: ['openDirectory'] });
    return r.canceled ? '' : r.filePaths[0];
  });

  // ---- 소스 인덱스 ----
  handle('index:list', () => codeindex.listIndexes());
  handle('index:presets', () => codeindex.EXT_PRESETS);
  handle('index:detectUE', () => codeindex.detectUnrealRoots());
  handle('index:build', (opts) => {
    const jobId = crypto.randomUUID(), started = Date.now();
    let stage = 'validation';
    const context = { jobId, operation: 'indexing', worker: 'local',
      model: require('../../src/core/secret-scrub').scrub(require('../../src/core/secret-scrub').redactCredentials(require('../../src/core/embedder').model())) };
    // 주소에는 인증정보·쿼리를 남기지 않는다.
    try { context.endpoint = new URL(require('../../src/core/config').load().lmstudio.baseUrl).origin.replace(/\/\/[^/]*@/, '//'); } catch { /* 잘못된 주소는 실패 진단에서 처리 */ }
    codeindex
      .buildIndex(
        {
          name: String(opts.name),
          root: String(opts.root),
          exts: Array.isArray(opts.exts) && opts.exts.length ? opts.exts.map(String) : ['.h'],
          // 심볼 맵이 좁혀 준 범위(루트 상대). 비어 있으면 트리 전체.
          subdirs: Array.isArray(opts.subdirs) ? opts.subdirs.map(String) : [],
        },
        (p) => {
          stage = p.phase;
          if (p.phase === 'done') return;
          if (p.retry) cloud.diagnostics({ ...context, stage, outcome: 'attempt-failed', ...p.retry }).then(logError => {
            if (logError) send('index-progress', { ...p, jobId, logError });
          });
          send('index-progress', { ...p, jobId });
        }
      )
      .then(async (meta) => {
        const logError = await cloud.diagnostics({ ...context, stage: 'succeeded', elapsedMs: Date.now() - started });
        send('index-progress', { name: meta.name, phase: 'done', chunks: meta.chunkCount, jobId, logError });
      })
      .catch(async (err) => {
        const diagnostic = failures.describe(err);
        const logError = await cloud.diagnostics({ ...context, stage, outcome: 'failed', elapsedMs: Date.now() - started,
          ...diagnostic, attempts: err.attempts || [] });
        send('index-progress', { name: opts.name, phase: 'error', error: diagnostic.hint, diagnostic, jobId, logError });
      });
    return { started: true, jobId };
  });
  handle('index:diagnostics', () => failures.list());
  handle('index:cloudTargets', () => cloud.targets());
  handle('index:cloudPreview', opts => cloud.preview(opts));
  handle('index:cloudStart', (opts) => cloud.start(opts, p => send('index-cloud-progress', p)));
  handle('index:cloudCancel', id => cloud.cancel(id));
  handle('index:cancel', (name) => codeindex.cancelBuild(String(name)));
  handle('index:delete', (name) => codeindex.deleteIndex(String(name)));
  handle('index:search', (name, query, topK) =>
    codeindex.search(String(name), String(query), Number(topK) || 8));
  handle('index:class', (name, className) => codeindex.classInfo(String(name), String(className)));
  handle('index:pickRoot', async () => {
    const res = await dialog.showOpenDialog(window(), {
      title: '소스 루트 폴더 선택',
      properties: ['openDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  // ---- 파인튜닝 데이터셋 ----
  handle('ft:generate', (opts) => {
    finetune
      .generate(
        { indexName: String(opts.indexName), count: Number(opts.count) || 100, model: opts.model || undefined },
        (p) => send('ft-progress', p)
      )
      .then((r) => send('ft-progress', { job: r.jobName, phase: 'done', ok: r.ok, failed: r.failed, outFile: r.outFile }))
      .catch((err) => send('ft-progress', { phase: 'error', error: String(err.message || err) }));
    return { started: true };
  });
  handle('ft:cancel', (job) => finetune.cancel(String(job)));
  handle('ft:list', () => finetune.listDatasets());
  handle('ft:openDir', () => {
    fs.mkdirSync(finetune.OUT_DIR, { recursive: true });
    return shell.openPath(finetune.OUT_DIR);
  });
}

module.exports = { register };

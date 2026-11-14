// 인덱스 기반 학습 Q&A — 3계층 구조의 2계층 소비자.
//
// 1계층(symbolmap)이 "어디 있나"를 답하고, 2계층(codeindex)이 그 좁힌 영역을 임베딩한
// 뒤, 여기서 "어떻게 동작하나"를 **실제 코드 발췌를 근거로** 설명한다. 전부 로컬이며
// 외부 전송이 없다.
//
// codeindex.js에서 떼어냈다: 색인을 만드는 일과 색인을 근거로 설명하는 일은 책임이
// 다르고, 후자만 로컬 모델·메모리에 의존한다.
'use strict';

const codeindex = require('./codeindex');

/**
 * @param {string} name 인덱스 이름
 * @param {string} question
 * @param {{topK?:number, model?:string, save?:boolean}} [opt]
 */
async function ask(name, question, { topK = 6, model, save = false } = {}) {
  const hits = await codeindex.search(name, question, topK);
  // 발췌 블록을 모델의 실제 컨텍스트 창에 맞춰 자른다. n_ctx를 넘으면 LM Studio는
  // 깔끔한 오류 대신 컨텍스트를 재처리해서 수 초짜리 호출이 수 분이 된다.
  const { chars: budgetChars, maxTokens } = await require('./lmstudio').promptBudget(model);
  const perHit = Math.max(300, Math.floor(budgetChars / Math.max(1, hits.length)) - 80);
  const context = hits
    .map((h, i) => `[${i + 1}] ${h.file}:${h.startLine}-${h.endLine}${h.module ? ` [모듈 ${h.module}]` : ''} (관련도 ${h.score})\n${h.text.slice(0, perHit)}`)
    .join('\n\n');
  // UE 트리를 인덱싱했으면 계층 구조 힌트를 준다 — 어느 층의 코드인지가 곧 설명의
  // 뼈대다 (UnrealEngineDeepDive의 레이어 모델).
  const isUE = hits.some((h) => h.module);
  const layerHint = isUE
    ? ' The excerpts are Unreal Engine source; each is tagged with its module (e.g. Runtime/Core). ' +
      'Frame the explanation in UE\'s layered architecture — HAL/Core (platform, containers, memory) → ' +
      'CoreUObject (reflection, GC) → Engine (world, actors, components) → module-specific layers like ' +
      'Renderer/RHI (frame rendering) or gameplay systems — and say which layer each excerpt lives in and ' +
      'how the layers call into each other.'
    : '';
  const delegator = require('./delegator'); // lazy: avoid startup cycles
  const r = await delegator.delegate({
    taskType: 'programming',
    model: model || undefined,
    maxTokens,
    temperature: 0.2,
    systemPrompt:
      'You are a source-code tutor. Answer in Korean. Ground every claim in the numbered code excerpts; ' +
      'cite them like [1], [2]. Explain concepts for a learner: purpose, how it works, how the pieces relate. ' +
      "If the excerpts don't contain the answer, say so plainly." + layerHint,
    prompt: `질문: ${question}\n\n코드 발췌:\n${context}`,
  });
  const result = {
    answer: r.content,
    model: r.model,
    sources: hits.map((h) => ({ file: h.file, module: h.module, startLine: h.startLine, endLine: h.endLine, score: h.score })),
  };
  if (save) {
    try {
      const memory = require('./memory');
      const saved = await memory.save(
        `[학습노트 ${name}] Q: ${question.slice(0, 200)}\nA: ${r.content.slice(0, 3200)}`,
        { type: 'note', tags: ['learning', name], source: 'source-qa' }
      );
      result.savedMemoryId = saved.id;
    } catch { /* memory best-effort */ }
  }
  return result;
}

module.exports = { ask };

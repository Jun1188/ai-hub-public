// 심층 분석(3계층) — 1계층(심볼 좌표)+2계층(코드 발췌)을 묶은 **브리핑**을 만들어
// 호출한 외부 AI(MCP pull) 또는 로컬 모델에게 "왜 이렇게 설계됐나" 수준의 분석을 받는다.
//
// ⚠ 안전 규칙 (AGENTS.md 규칙 10과 동일)
//   1) 기본은 좌표·구조만 보낸다. **소스 발췌는 includeSource가 켜졌을 때만** 들어간다.
//      외부 AI로 보내면 그쪽 서비스로 엔진/프로젝트 코드가 나간다.
//   2) 보내기 전 반드시 scrub() — 토큰·사용자 경로를 걸러낸다(secret-scrub.js).
//   3) 결과는 텍스트 분석뿐이다. 자동 반영 경로를 만들지 않는다.
'use strict';

const symbolmap = require('./symbolmap');
const { scrub } = require('./secret-scrub');

const MAX_EXCERPT_CHARS = 1800; // 발췌 하나 상한 — 외부 AI는 창이 크지만 전송량은 비용이다
const MAX_EXCERPTS = 6;

/**
 * 분석 브리핑 조립. 모델을 태우지 않는다 — 순수 조회·조립이라 즉시 끝난다.
 * @param {{map:string, topic:string, question?:string, index?:string, includeSource?:boolean}} p
 * @returns {Promise<{text:string, meta:object}>}
 */
async function briefing(p) {
  const topic = String(p.topic || '').trim();
  if (!p.map || !topic) throw new Error('map과 topic이 필요합니다.');
  const parts = [];
  const meta = { map: p.map, topic, excerpts: 0, chars: 0, includeSource: Boolean(p.includeSource) };

  // ---- 1계층: 좌표 + 계층 + 해설 ----
  const found = symbolmap.find(p.map, topic, { limit: 20 });
  parts.push(`# 분석 대상: ${topic}`);
  parts.push(`\n## 심볼 좌표 (엔진 소스 실측, 총 ${found.total}건 중 ${found.matches.length}건)`);
  parts.push(found.matches.map((m) =>
    `- ${m.kind} ${m.name} — ${m.file}:${m.line}${m.module ? ` [${m.module}]` : ''}${m.parents.length ? ` : ${m.parents.join(', ')}` : ''}`).join('\n')
    || '- (일치하는 심볼 없음)');

  // 정확 일치가 있으면 계층까지 — 상속 사슬이 곧 설계의 뼈대다.
  const exact = found.matches.find((m) => m.name === topic);
  if (exact) {
    const h = symbolmap.hierarchy(p.map, topic);
    parts.push(`\n## 상속 계층`);
    parts.push(`- 조상: ${h.ancestors.map((a) => a.name).join(' → ') || '(없음)'}`);
    if (h.interfaces.length) parts.push(`- 인터페이스: ${h.interfaces.join(', ')}`);
    parts.push(`- 직계 자식 ${h.childCount}개${h.children.length ? `: ${h.children.slice(0, 15).map((c) => c.name).join(', ')}` : ''}`);
  }

  if (found.notes.length) {
    parts.push(`\n## 해설 문서 (사용자 큐레이션 자료가 이 심볼을 다루는 위치)`);
    parts.push(found.notes.map((n) => `- ${n.file}:${n.line} — ${n.title}`).join('\n'));
  }

  const scope = symbolmap.scopeFor(p.map, topic, { depth: 4 });
  if (scope.dirs.length) {
    parts.push(`\n## 관련 코드가 모인 디렉터리`);
    parts.push(scope.dirs.map((d) => `- ${d.dir} (심볼 ${d.symbols} · 파일 ${d.files})`).join('\n'));
  }

  // ---- 2계층: 코드 발췌 (명시적 옵트인일 때만) ----
  if (p.includeSource && p.index) {
    const codeindex = require('./codeindex');
    const hits = await codeindex.search(p.index, p.question || topic, MAX_EXCERPTS);
    if (hits.length) {
      parts.push(`\n## 코드 발췌 (인덱스 ${p.index})`);
      parts.push(hits.map((h, i) =>
        `### [${i + 1}] ${h.file}:${h.startLine}-${h.endLine} (관련도 ${h.score})\n\`\`\`cpp\n${h.text.slice(0, MAX_EXCERPT_CHARS)}\n\`\`\``).join('\n\n'));
      meta.excerpts = hits.length;
      meta.sources = hits.map((h) => ({ file: h.file, startLine: h.startLine, endLine: h.endLine }));
    }
  }

  if (p.question) parts.push(`\n## 질문\n${p.question}`);

  const text = scrub(parts.join('\n'));
  meta.chars = text.length;
  return { text, meta };
}

const SYSTEM_PROMPT = `당신은 Unreal Engine 소스 구조 분석가입니다. 아래 브리핑(심볼 좌표·상속 계층·해설·코드 발췌)을 근거로 한국어로 답하세요.

반드시 지킬 것:
- 모든 주장에 브리핑의 file:line 근거를 인용하세요. 브리핑에 없는 API를 지어내지 마세요.
- 설계 의도·계층 구조·호출 흐름 관점으로 설명하세요. 좌표 나열은 브리핑에 이미 있으니 반복하지 마세요.
- 브리핑만으로 답할 수 없으면 무엇이 더 필요한지(어느 파일을 발췌해야 하는지) 명시하세요.`;

/** 분석을 맡길 리뷰어. 외부 CLI 리뷰어 push 경로는 1.29.0에서 뺐다 — 외부 AI는 브리핑을 pull한다. */
function reviewers() {
  return [{ id: 'local', label: '로컬 모델 (LM Studio)', external: false }];
}

/**
 * 브리핑을 만들어 로컬 모델에게 보내고 분석을 받는다.
 * @param {{map:string, topic:string, question?:string, index?:string, includeSource?:boolean, save?:boolean}} p
 */
async function analyze(p) {
  const b = await briefing(p);
  const started = Date.now();
  const r = await require('./delegator').delegate({
    prompt: b.text,
    systemPrompt: SYSTEM_PROMPT,
    taskType: 'programming',
    maxTokens: 1600,
    temperature: 0.2,
  });
  const answer = r.content;

  const result = {
    answer,
    reviewer: 'local',
    external: false,
    elapsedMs: Date.now() - started,
    meta: b.meta,
  };
  if (p.save) {
    try {
      const memory = require('./memory');
      const saved = await memory.save(
        `[심층분석 ${p.topic}] ${answer.slice(0, 3200)}`,
        { type: 'note', tags: ['deepdive', p.topic.slice(0, 40)], source: 'deepdive' }
      );
      result.savedMemoryId = saved.id;
    } catch { /* memory best-effort */ }
  }
  return result;
}

module.exports = { briefing, analyze, reviewers, SYSTEM_PROMPT };

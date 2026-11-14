// 전문가 재프롬프팅(사용자 프레임워크, 2026-10-28 task.md 과제 1). 결정적 규칙으로 적용/제외를 가리고, 적용 대상이면
// 바이트가 고정된 정적 접두부(프레임워크 원문) 뒤에 요청을 꼬리로 붙인다. 모델을 부르지 않는다 — 결과는 프롬프트일 뿐이고
// 쓸지는 호출자가 정한다(규칙 10).
//
// 왜 접두부를 고정하나: 프롬프트 캐시는 바이트가 같은 앞부분만 다시 쓴다(AWS "Groundhog Day" 패턴: 정적 지침 → 동적 꼬리,
// 날짜·ID 같은 변동값은 접두부 밖). 왜 기본이 "감싸지 않음"인가: 하네스 비용은 고정 프리앰블 × 단계 수가 좌우하고
// (arXiv 2610.04433), 같은 설정을 다시 돌려도 결과가 약 13% 뒤집힌다 — 제외 대상까지 감싸면 잡음보다 작은 이득에 매 단계 비용만 는다.
'use strict';
const crypto = require('crypto');

// 프레임워크 바이트가 바뀌면 올린다. 바뀐 접두부는 모든 공급자 캐시를 처음부터 다시 채운다.
const VERSION = 1;
// 사용자 원문 그대로(줄 끝 공백만 뺐다). 고칠 때는 VERSION과 scripts/test-expert-reprompt.js의 해시를 같이 바꾼다.
const FRAMEWORK = [
  "사용자의 요청이 **전문적인 분석, 시스템/기술 설계, 기획, 연구, 또는 깊이 있는 실무 작업**에 해당할 때, 단순히 양을 늘리는 것이 아니라 최고 전문가 수준의 깊이 있는 버전으로 만듭니다.",
  "",
  "## 적용 및 제외 기준 (Trigger & Exclusion Rules)",
  "",
  "* **적용 대상 (Include):** 전공 및 기술 심층 질문(아키텍처, 알고리즘, 엔진 설계 등), 데이터 및 투자/시장 분석, 프로젝트 기획, 글쓰기/보고서 고도화, 복합적인 문제 해결 요청",
  "* **제외 대상 (Exclude):** 일상적인 대화 및 인사, 단순 사실/정보 조회(날씨, 일정, 단답형 지식), 간단한 사칙연산 및 수식 계산, 단순 어휘/문장 번역, 스킬/설정 관리 등 가벼운 단발성 요청 (이 경우 본 프레임워크를 생략하고 즉각적이고 간결하게 답변합니다.)",
  "",
  "## 필수 선행 분석 단계",
  "",
  "적용 대상에 해당하는 작업 요청 시, 본격적인 최종 결과물을 작성하기 전에 반드시 다음 4가지 항목을 먼저 분석하여 제시해 주세요.",
  "",
  "1. **전문가의 핵심 접근법 (Unrequested Expert Actions):** 사용자가 명시적으로 요청하지 않은 부분 중, 이 분야의 최고 전문가라면 여기에서 실제로 무엇을 할지 설명합니다.",
  "2. **원초적 출발 자료 (Raw Primary Materials):** 이미 소화하기 쉽게 가공·정리된 2차 자료가 아니라, 최고 전문가들이 작업을 시작할 때 실제로 다루는 가장 원초적인 1차 자료(Raw Data, 원본 명세, 로우레벨 데이터 등)가 무엇인지 밝힙니다.",
  "3. **구체적인 방법론과 도구 (Specific Methods & Tools):** 전문가들이 해당 원초적 자료를 다룰 때 사용하는 구체적인 기법, 파이프라인, 프레임워크 및 도구를 제시합니다.",
  "4. **객관적 검증 수단 (External Verification):** 사용자나 AI의 주관적 판단 외에, 도출된 결과가 실제로 올바르고 유효하다는 것을 객관적으로 증명할 수 있는 외부 지표, 테스트, 벤치마크 또는 검증 방법이 무엇인지 설명합니다.",
  "",
  "## 프롬프트 재작성 및 적용",
  "",
  "* 위 (1)~(4)번의 분석을 마친 직후, **바로 그 요소들(원초적 자료, 구체적 도구, 객관적 검증 기준 포함)을 반영하여 작업을 요청하는 최적화된 프롬프트**로 다시 작성해 제시합니다.",
].join('\n');
const PREFIX_SHA256 = crypto.createHash('sha256').update(FRAMEWORK).digest('hex');
const REQUEST_HEAD = '\n\n## 사용자 요청\n';
// 로컬 모델(.claude/rules/local-model-prompts.md): 프레임워크는 참고 자료로 앞(캐시되는 접두부)에, 지금 할 일은 데이터 뒤에 둔다.
// 7~14B 모델은 마지막에 읽은 지시를 따른다 — 행동 지시까지 앞에 두면 요청을 되풀이하다 만다.
const LOCAL_TAIL = '\n\n## 지금 할 일\n'
  + '위 요청은 프레임워크의 적용 대상이다. 다음 순서로만 쓴다.\n'
  + '1) 네 항목(전문가 접근법, 원초적 1차 자료, 방법론·도구, 객관적 검증)을 항목마다 2~4문장으로.\n'
  + '2) 그 요소를 반영한 재작성 프롬프트.\n'
  + '3) 재작성 프롬프트에 대한 최종 답.\n'
  + '요청과 자료에 없는 사실은 지어내지 말고 "확인 필요"라고 쓴다.';

// 적용 대상 신호(프레임워크의 적용 대상 다섯 갈래). 갈래 이름이 결과의 category다.
const DOMAINS = [
  ['technical', /아키텍처|architecture|설계|알고리즘|algorithm|자료\s?구조|data structure|엔진|engine|렌더링|rendering|셰이더|shader|최적화|optimi[sz]|성능|performance|프로파일|profil|병목|bottleneck|동시성|concurren|정합성|consisten|트레이드오프|trade-?off|절충|보안|security|위협\s?모델|threat model|리팩터|refactor|마이그레이션|migrat|컴파일러|compiler|분산|distributed/gi],
  ['analysis', /데이터\s?분석|data analy|분석|analy[sz]|투자|invest|포트폴리오|portfolio|시장|market|재무|financ|통계|statistic|벤치마크|benchmark|지표|metric/gi],
  ['planning', /기획|계획|planning|로드맵|roadmap|전략|strateg|요구\s?사항|requirement|일정\s?수립|milestone/gi],
  ['writing', /보고서|report|제안서|proposal|논문|paper|백서|whitepaper|고도화|원고|manuscript|에세이|essay|기술\s?문서|documentation/gi],
  ['problem-solving', /문제\s?해결|troubleshoot|디버그|debug|근본\s?원인|root cause|원인\s?분석|장애|incident|재현|repro|검증|verif|실험|experiment|연구|research/gi],
];
// 제외 대상(프레임워크의 제외 다섯 갈래 + 빈 요청). 길이 상한 안의 짧은 요청에만 건다 — 긴 요청은 내용으로 판정한다.
const EXCLUDES = [
  ['conversation', 60, /^\s*(?:안녕|하이|헬로|ㅎㅇ|고마워|고맙|감사|수고|잘\s?자|좋은\s?(?:아침|밤|하루)|반가|hi\b|hello\b|hey\b|thanks?\b|thank you|good (?:morning|night|evening))/i],
  ['arithmetic', 80, /^[\s\d+\-*/×÷^().,=%]*\d\s*[+\-*/×÷^%]\s*[\d(][\s\d+\-*/×÷^().,=%]*(?:은|는|이|가)?\s*(?:얼마(?:야|예요|인가요)?|계산(?:해\s?줘|해\s?주세요)?|몇)?\s*\??\s*$/],
  ['translation', 600, /번역|translat|영어로|한국어로|일본어로|중국어로|영문으로|국문으로|in english|into english|in korean|into korean/i],
  ['lookup', 100, /날씨|기온|weather|몇\s?시|what time|오늘\s?날짜|무슨\s?요일|일정\s?(?:알려|뭐|확인)|스케줄|schedule|환율|exchange rate|뜻이?\s?(?:뭐|무엇)|의미가?\s?뭐|what does .+ mean|^\s*what(?:'s| is)\b|who is|누구야|어디야|언제야/i],
  ['settings', 150, /(?:스킬|skill|설정|config|setting|플러그인|plugin|단축키|keybinding|테마|theme|알림|notification)[\s\S]*(?:설치|삭제|켜|꺼|활성|비활성|목록|바꿔|변경|install|uninstall|enable|disable|list|toggle|turn (?:on|off)|switch)|(?:설치|삭제|켜|꺼|install|uninstall|enable|disable|toggle)[\s\S]*(?:스킬|skill|설정|config|setting|플러그인|plugin)/i],
];
// 번역 요청이라도 글을 끌어올려 달라면 "글쓰기 고도화"다.
const ELEVATE = /고도화|다듬|개선|윤문|rewrite|polish|improve|refine/i;

function domainHits(text) {
  const hits = [];
  for (const [category, re] of DOMAINS) {
    for (const m of text.matchAll(re)) {
      const word = m[0].toLowerCase();
      if (!hits.some((h) => h.word === word)) hits.push({ category, word });
    }
  }
  return hits;
}

/**
 * 적용/제외 판정. 모델 없이 정규식과 길이만 쓴다 — 같은 요청은 언제나 같은 판정이다.
 * @param {string} request
 * @param {{force?:boolean}} [opt] force: 사용자가 전문가 모드를 명시했을 때(제외 판정을 덮는다).
 */
function classify(request, opt = {}) {
  const text = String(request || '');
  const length = text.trim().length;
  const hits = domainHits(text);
  const signals = { length, lines: text.split('\n').filter((l) => l.trim()).length, domain: hits.map((h) => h.word).slice(0, 12) };
  const verdict = (apply, category, reason) => ({ apply, category, reason, signals });
  if (opt.force) return verdict(true, hits[0]?.category || 'forced', 'forced');
  for (const [category, max, re] of EXCLUDES) {
    if (length > max || !re.test(text)) continue;
    if (category === 'translation' && ELEVATE.test(text)) continue;
    // 짧은 제외 문형이라도 전문 영역 신호가 둘 이상이면 내용으로 판정한다("이 설계의 정합성 문제를 영어로 설명해 줘").
    if (category !== 'translation' && hits.length >= 2) continue;
    return verdict(false, category, `excluded_${category}`);
  }
  if (length < 6) return verdict(false, 'trivial', 'too_short');
  if (hits.length >= 2 || (hits.length === 1 && length >= 15)) return verdict(true, hits[0].category, 'domain_signals');
  if (length >= 400 && signals.lines >= 3) return verdict(true, 'problem-solving', 'complex_request');
  return verdict(false, 'not-deep', 'no_domain_signal'); // 기본은 감싸지 않음(고정 프리앰블 × 단계 수)
}

/**
 * 감싼 프롬프트. prefix는 요청과 무관하게 언제나 같은 바이트다(캐시 적중). target 'local'은 행동 지시를 요청 뒤에 둔다.
 * @param {string} request
 * @param {{target?:'agent'|'local'}} [opt]
 */
function wrap(request, opt = {}) {
  const target = opt.target === 'local' ? 'local' : 'agent';
  const req = String(request || '').trim();
  const tail = REQUEST_HEAD + req + (target === 'local' ? LOCAL_TAIL : '');
  return { version: VERSION, target, prefix: FRAMEWORK, prefixSha256: PREFIX_SHA256, request: req, tail, prompt: FRAMEWORK + tail };
}

/** 프리앰블 비용: 바이트·글자 수(공급자와 무관한 값). 토큰은 공급자 토크나이저마다 달라 여기서 추정하지 않는다. */
const PREAMBLE = Object.freeze({ bytes: Buffer.byteLength(FRAMEWORK), chars: FRAMEWORK.length, localTailBytes: Buffer.byteLength(LOCAL_TAIL) });

/** MCP 도구 결과. 제외면 판정만(접두부를 호출자 문맥에 싣지 않는다 — 실으면 남은 모든 단계가 그 바이트를 다시 보낸다). */
function reprompt(request, opt = {}) {
  const v = classify(request, opt);
  const base = { apply: v.apply, category: v.category, reason: v.reason, signals: v.signals, version: VERSION, preamble: PREAMBLE };
  if (!v.apply) return { ...base, next: 'answer_directly' };
  const w = wrap(request, opt);
  return { ...base, target: w.target, prefixSha256: w.prefixSha256, prompt: w.prompt,
    next: 'follow_prompt_or_forward_it_whole', note: 'prefix bytes are fixed; keep the request in the tail and forward the prompt unchanged so caches hit' };
}

module.exports = { classify, wrap, reprompt, FRAMEWORK, PREFIX_SHA256, PREAMBLE, VERSION, LOCAL_TAIL };

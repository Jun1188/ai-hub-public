// L1 건강 탐침(ScholarEvolve의 health probe를 이 Hub에 맞춘 것): 판정자(Codex 30~70초)를 부르기 전에 후보가 망가졌는지
// 결정적으로 본다. 가져오기(구문 컴파일만 — 후보 코드는 실행하지 않는다), 인터페이스(기준 스킬의 삭제·이름 변경),
// 재적재(바뀐 SKILL.md가 새로 가리키는 스킬 안 파일). 못 본 것은 unchecked로 남긴다 — 통과로 세지 않는다(규칙 6).
'use strict';
const path = require('path');
const vm = require('vm');
const surface = require('./harness-surface');

const CJS_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname'];

/** 오류 문자열, 통과면 null, 이 방법으로 볼 수 없으면 undefined. */
function syntaxError(rel, text) {
  if (!/\.c?js$/.test(rel)) return undefined;
  if (/^\s*(import|export)\s/m.test(text)) return undefined; // ESM은 CommonJS 래퍼로 컴파일할 수 없다
  try {
    vm.compileFunction(text.replace(/^#!.*/, ''), CJS_PARAMS, { filename: rel }); // 컴파일만 하고 호출하지 않는다
    return null;
  } catch (e) { return `syntax: ${rel} (${String(e.message).slice(0, 120)})`; }
}

function linkTargets(rel, text) {
  const dir = path.posix.dirname(rel);
  const out = new Set();
  for (const m of String(text || '').matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
    let t = m[1].split('#')[0].split('?')[0];
    if (!t || /^[a-z][\w+.-]*:/i.test(t) || t.startsWith('/')) continue;
    try { t = decodeURIComponent(t); } catch { /* 그대로 둔다 */ }
    const resolved = path.posix.normalize(path.posix.join(dir, t));
    // 스킬 폴더 안이고 트리가 담는 종류의 파일만 — 저장소의 다른 곳은 범위 트리에 없으니 볼 수 없다.
    if (resolved.startsWith(dir + '/') && surface.componentOf(resolved)) out.add(resolved);
  }
  return out;
}

/** 후보가 새로 건 링크 중 후보 트리에 없는 것. 기준에 이미 있던 링크는 후보 탓이 아니다. */
function danglingLinks(rel, text, before, cand) {
  const old = linkTargets(rel, before);
  return [...linkTargets(rel, text)].filter((t) => !old.has(t) && cand[t] == null).map((t) => `link: ${rel} -> ${t} missing`);
}

function interfaceBreaks(base, cand) {
  const out = [];
  for (const [rel, text] of Object.entries(base)) {
    if (!rel.endsWith('/SKILL.md') || text == null) continue;
    if (cand[rel] == null) { out.push(`interface: skill removed ${rel}`); continue; }
    const was = (surface.frontmatter(text) || {}).name, now = (surface.frontmatter(cand[rel]) || {}).name;
    if (was && now !== was) out.push(`interface: skill name ${was} -> ${now || '(none)'} in ${rel}`);
  }
  return out;
}

/** base·cand는 전체 트리, patch는 후보가 바꾼 파일만(null = 삭제). module을 주면(R4) 그 모듈 밖 파일을 바꾼 후보는 탈락. */
function probe(base, cand, patch, { module } = {}) {
  const failures = [], unchecked = [];
  for (const [rel, text] of Object.entries(patch || {})) {
    if (module && require('./module-evolve').moduleOf(rel, text == null ? base : cand) !== module) failures.push(`module: ${rel} outside ${module}`);
    if (text == null) continue;
    const err = syntaxError(rel, text);
    if (err) failures.push(err);
    else if (err === undefined && /\.(c?js|mjs|py|ps1|sh)$/.test(rel)) unchecked.push(rel);
    if (rel.endsWith('/SKILL.md')) failures.push(...danglingLinks(rel, text, base[rel], cand));
  }
  failures.push(...interfaceBreaks(base, cand));
  return { ok: !failures.length, failures, unchecked };
}

module.exports = { probe, syntaxError, linkTargets };

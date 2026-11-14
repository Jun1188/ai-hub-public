// 하네스 = 에이전트 주변 파일 트리. Harness²(google-research/harness2)의 c1..c8 구분을 따른다:
// 모델 가중치는 그대로 두고 이 트리만 고쳐서 개선하므로, 무엇을 고쳐도 되는지(표면)와
// 항상 로드되는 글자 수 상한을 결정적으로 검사해야 제안이 컨텍스트를 부풀리며 "개선"하지 못한다.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COMPONENTS = [
  { id: 'c1-system', label: '시스템 지침', patterns: [/^(AGENTS|CLAUDE|GEMINI)\.md$/], alwaysOn: true },
  { id: 'c2-guardrails', label: '가드레일', patterns: [/^\.claude\/rules\/[\w.-]+\.md$/, /^guardrails\/[\w.-]+\.md$/] },
  { id: 'c3-memory', label: '메모리', patterns: [/^memory(-proposals)?\/.+\.md$/] },
  { id: 'c4-tool-guidance', label: '도구 안내', patterns: [/^docs\/delegation-routing\.md$/, /^harness\/routing-policy\.json$/, /^toolroutes\/[\w.-]+\.json$/, /^tools\/[\w.-]+\.md$/] },
  { id: 'c5-subagents', label: '서브에이전트', patterns: [/^sub_agents\/[a-z0-9][\w-]*\/AGENT\.md$/, /^\.claude\/agents\/[\w-]+\.md$/] },
  { id: 'c6-skills', label: '스킬', patterns: [/^(\.claude\/)?skills\/(.+\/)?[a-z0-9][a-z0-9-]*\/(SKILL\.md|references\/.+|[\w.-]+\.(md|json))$/, /^skills\/CATALOG\.md$/] },
  { id: 'c7-scripts', label: '스크립트', patterns: [/^(scripts|tools)\/.+\.(js|cjs|mjs|py|ps1|sh)$/] },
  { id: 'c8-plugins', label: '플러그인', patterns: [/^plugins\/[\w.-]+\/.+$/, /^\.claude-plugin\/.+$/] },
];

const DEFAULT_SPEC = { alwaysOnMax: 24000, maxFileBytes: 256 * 1024, maxFiles: 4000 };

function componentOf(rel) {
  for (const c of COMPONENTS) if (c.patterns.some((p) => p.test(rel))) return c.id;
  return null;
}

const { frontmatter } = require('../markdown-frontmatter');

function alwaysOnChars(tree) {
  let n = 0;
  for (const [rel, text] of Object.entries(tree)) {
    if (text == null) continue;
    const c = COMPONENTS.find((x) => x.id === componentOf(rel));
    if (c && c.alwaysOn) n += text.length;
  }
  return n;
}

/** 모든 문제를 한 문자열로 돌려준다(빈 문자열 = 통과). 제안자에게 그대로 재시도 피드백으로 준다. */
function validateTree(tree, spec = DEFAULT_SPEC) {
  const errors = [];
  const entries = Object.entries(tree).filter(([, t]) => t != null);
  if (entries.length > spec.maxFiles) errors.push(`too many files: ${entries.length} > ${spec.maxFiles}`);
  const skills = [];
  for (const [rel, text] of entries) {
    if (rel.includes('..') || path.isAbsolute(rel) || rel.includes('\\')) { errors.push(`bad path: ${rel}`); continue; }
    if (!componentOf(rel)) errors.push(`outside surface: ${rel}`);
    if (Buffer.byteLength(text) > spec.maxFileBytes) errors.push(`file too large: ${rel}`);
    if (rel.endsWith('.json')) { try { JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { errors.push(`invalid json: ${rel} (${e.message})`); } }
    if (rel.endsWith('/SKILL.md')) {
      const dir = rel.split('/').slice(-2, -1)[0];
      const fm = frontmatter(text);
      skills.push(dir);
      if (!fm) { errors.push(`skill without frontmatter: ${rel}`); continue; }
      if (!fm.name) errors.push(`skill without name: ${rel}`);
      else if (fm.name !== dir) errors.push(`skill name "${fm.name}" != directory "${dir}": ${rel}`);
      if (!fm.description) errors.push(`skill without description: ${rel}`);
      else if (fm.description.length < 20 || fm.description.length > 1024) errors.push(`skill description length ${fm.description.length} outside 20..1024: ${rel}`);
    }
  }
  const aon = alwaysOnChars(tree);
  if (aon > spec.alwaysOnMax) errors.push(`always-on text ${aon} chars > ${spec.alwaysOnMax}`);
  // 카탈로그가 있으면 모든 스킬이 거기서 발견돼야 한다(Harness²의 autotrigger에 해당).
  const catalog = tree['skills/CATALOG.md'];
  if (catalog) for (const s of skills) if (!catalog.includes(s)) errors.push(`skill not in CATALOG.md: ${s}`);
  return errors.join('\n');
}

function fingerprint(tree) {
  const h = crypto.createHash('sha256');
  for (const rel of Object.keys(tree).sort()) if (tree[rel] != null) h.update(rel).update('\u0000').update(tree[rel]).update('\u0000');
  return h.digest('hex');
}

/** 제안은 바꾸는 파일만 담는다(빠진 파일은 상속). null은 삭제. */
function applyPatch(base, patch) {
  const out = { ...base };
  for (const [rel, text] of Object.entries(patch || {})) {
    if (text == null) delete out[rel]; else out[rel] = text;
  }
  return out;
}

function diffSummary(base, cand) {
  const added = [], removed = [], changed = [];
  for (const rel of new Set([...Object.keys(base), ...Object.keys(cand)])) {
    if (!(rel in base)) added.push(rel);
    else if (!(rel in cand)) removed.push(rel);
    else if (base[rel] !== cand[rel]) changed.push(rel);
  }
  const components = [...new Set([...added, ...removed, ...changed].map((r) => componentOf(r) || 'outside'))].sort();
  return { added, removed, changed, components, alwaysOnCharDelta: alwaysOnChars(cand) - alwaysOnChars(base) };
}

/** 디스크의 하네스 루트를 트리로 읽는다(표면 안 파일만). 비동기 — 루트가 동기화 폴더일 수 있다. */
async function loadTree(root, { maxFiles = DEFAULT_SPEC.maxFiles, maxBytes = DEFAULT_SPEC.maxFileBytes } = {}) {
  const tree = {};
  const skipped = [];
  const walk = async (rel) => {
    let entries;
    try { entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (Object.keys(tree).length >= maxFiles) return;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { await walk(child); continue; }
      if (!componentOf(child)) continue;
      const st = await fs.promises.stat(path.join(root, child)).catch(() => null);
      if (!st || st.size > maxBytes) { skipped.push(child); continue; }
      tree[child] = await fs.promises.readFile(path.join(root, child), 'utf8');
    }
  };
  await walk('');
  return { tree, skipped };
}

module.exports = { COMPONENTS, DEFAULT_SPEC, componentOf, frontmatter, alwaysOnChars, validateTree, fingerprint, applyPatch, diffSummary, loadTree };

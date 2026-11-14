// 도메인별 경험 라이브러리(Harness²의 library/<domain>/INDEX.md + EXPERIENCE.md).
// 다음 제안자는 앞선 기록만 읽는다. 교훈은 근거 행이 전부 confounded면 버린다 — "채택됨"은 효과의 증거가 아니다.
// Markdown이라 Obsidian 볼트로 그대로 열리고, 지식 그래프의 메모리 출처로도 읽힌다.
'use strict';
const fs = require('fs');
const path = require('path');
const { writeAtomic: atomicWrite } = require('../atomic-file');

const DOMAIN = /^[a-z0-9][a-z0-9-]{0,47}$/;

function rootOf(deps = {}) {
  return path.join(deps.dataDir || require('../paths').hubDataDir(), 'rsi', 'library');
}

function lessonOf(entry) {
  const l = entry.lesson;
  if (!l || !l.cue || !l.lesson) return null;
  const rows = entry.reflection || [];
  if (rows.length && rows.every((r) => r.verdict === 'confounded')) return null;
  return { cue: String(l.cue).slice(0, 200), lesson: String(l.lesson).slice(0, 600), evidence: String(l.evidence || '').slice(0, 300),
    confidence: Math.max(0, Math.min(1, Number(l.confidence) || 0.5)) };
}

async function readJsonl(file) {
  let text = '';
  try { text = await fs.promises.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** entry: { runId, loop, decision, chosen, rows, reflection:[{component, verdict, delta}], lesson? } */
async function append(domain, entry, deps = {}) {
  if (!DOMAIN.test(domain)) throw new Error('library domain must be lowercase words joined by hyphens');
  const dir = path.join(rootOf(deps), domain);
  await fs.promises.mkdir(dir, { recursive: true });
  const row = { at: new Date().toISOString(), runId: entry.runId || null, loop: entry.loop || null, decision: entry.decision,
    chosen: entry.chosen || null, reflection: entry.reflection || [], lesson: lessonOf(entry),
    // 변이 설계서의 메커니즘·출처만(R3) — 어떤 연구 가설이 채택까지 갔는지 다음 실행과 사람이 추적한다.
    blueprint: entry.blueprint ? { mechanism: entry.blueprint.mechanism, targetModule: entry.blueprint.targetModule || null, provenance: entry.blueprint.provenance || null } : null };
  await fs.promises.appendFile(path.join(dir, 'EXPERIENCE.jsonl'), JSON.stringify(row) + '\n', 'utf8');
  await render(domain, deps);
  return row;
}

async function render(domain, deps = {}) {
  const dir = path.join(rootOf(deps), domain);
  const rows = await readJsonl(path.join(dir, 'EXPERIENCE.jsonl'));
  const verdicts = {};
  for (const r of rows) for (const v of r.reflection || []) verdicts[v.verdict] = (verdicts[v.verdict] || 0) + 1;
  const decisions = {};
  for (const r of rows) decisions[r.decision] = (decisions[r.decision] || 0) + 1;
  const lessons = rows.filter((r) => r.lesson).slice(-20).reverse();
  const index = [
    `---\ntype: rsi-library\ndomain: ${domain}\nupdatedAt: ${new Date().toISOString()}\n---`,
    `# ${domain} 경험 라이브러리`, '',
    `기록 ${rows.length}건 · 결정 ${Object.entries(decisions).map(([k, v]) => `${k} ${v}`).join(' · ') || '-'}`,
    `반영 판정 ${Object.entries(verdicts).map(([k, v]) => `${k} ${v}`).join(' · ') || '-'}`, '',
    '## 교훈 (최근 20)', '',
    ...(lessons.length ? lessons.map((r) => `- **${r.lesson.cue}** → ${r.lesson.lesson} _(신뢰 ${r.lesson.confidence}, ${r.at.slice(0, 10)})_`) : ['- (아직 없음)']),
    '', '[[EXPERIENCE]]',
  ].join('\n');
  const body = [`# ${domain} 경험 기록`, '', '| 시각 | 루프 | 결정 | 구성요소 판정 |', '|---|---|---|---|',
    ...rows.slice(-50).reverse().map((r) => `| ${r.at.slice(0, 16)} | ${r.loop || '-'} | ${r.decision} | ${(r.reflection || []).map((v) => `${v.component}: ${v.verdict}`).join('; ') || '-'} |`)].join('\n');
  await atomicWrite(path.join(dir, 'INDEX.md'), index + '\n');
  await atomicWrite(path.join(dir, 'EXPERIENCE.md'), body + '\n');
}

/** 제안자가 읽는 교훈. before를 주면 그 시각 이전 기록만(시간 순서 보존). */
async function lessons(domain, { limit = 12, before } = {}, deps = {}) {
  if (!DOMAIN.test(domain)) return [];
  const rows = await readJsonl(path.join(rootOf(deps), domain, 'EXPERIENCE.jsonl'));
  return rows.filter((r) => r.lesson && (!before || r.at < before)).slice(-limit).map((r) => r.lesson);
}

async function domains(deps = {}) {
  try { return (await fs.promises.readdir(rootOf(deps), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }
}

module.exports = { append, lessons, domains, render, rootOf, lessonOf };

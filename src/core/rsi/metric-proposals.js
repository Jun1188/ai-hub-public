// 지식 그래프 지표(knowledge-metrics) → RSI 3번 루프 제안 큐.
// 세 경로가 같은 큐로 들어가고 같은 검토 → 사람 승인 → 작업 지시서를 거친다(규칙 10 — 코드 자동 반영 없음):
//   1) 결정적 원천: 수치 규칙이 고칠 곳을 짚는다(제안 수집 때 자동).
//   2) 사람이 수치를 보고 쓴 개선 방향.
//   3) 같은 수치 요약을 읽은 AI가 낸 제안(사람이 누를 때만, 고른 작업자로).
'use strict';

const ORIGIN = 'knowledge-metrics';
const MIN_FOUND = 2, MISS_AVG = 2, NOT_FOUND_REPEAT = 3, SHOWN_UNUSED = 5;
const sum = (rows, f) => rows.reduce((s, r) => s + (r[f] || 0), 0);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

async function skillPaths(deps) {
  try { const { index } = await require('../cache/skill-index').load(deps); return new Map(index.docs.map((d) => [d.id, d.path])); }
  catch { return new Map(); } // 저장소를 못 읽으면 경로 없이 이름으로만 가리킨다
}

/** 결정적 원천: 찾기 어려운 스킬, 반복해서 못 찾은 질의, 노출되지만 안 쓰이는 스킬, 낮은 검색 적중. */
async function proposals(snap, deps = {}) {
  const paths = await skillPaths(deps);
  const target = (id) => [paths.get(id) || id];
  const out = [];
  for (const [id, s] of Object.entries(snap.skills || {})) {
    const name = id.replace(/^skill:/, '');
    if (s.found >= MIN_FOUND && s.misses / s.found >= MISS_AVG) {
      out.push({ title: `찾기 어려운 스킬: ${name} — 쓰기까지 평균 ${(s.misses / s.found).toFixed(1)}회 빗나감`, component: 'c6-skills', targets: target(id),
        hypothesis: `${snap.days}일 동안 검색을 거친 사용 ${s.found}회에 빗나간 검색이 ${s.misses}회였다. description에 사용자가 실제로 쓰는 상황·단어를 넣으면 평균 miss가 줄어든다.`,
        evidence: [`${id}: found ${s.found}, misses ${s.misses}, shown ${s.shown}, uses ${s.uses}`], relevance: 0.8, evidenceStrength: 0.7, reproducibility: 0.7, risk: 0.2, effort: 0.2 });
    }
    if (s.shown >= SHOWN_UNUSED && !s.uses && !(snap.lifetime || {})[id]) {
      out.push({ title: `노출되지만 쓰이지 않는 스킬: ${name} (검색 상위 ${s.shown}회)`, component: 'c6-skills', targets: target(id),
        hypothesis: '검색이 이 스킬을 자주 올리지만 실제로 쓰인 적이 없다. 설명이 다른 일을 약속하거나 다른 스킬과 겹친다 — 설명을 좁히거나 합치는 것을 검토한다.',
        evidence: [`${id}: shown ${s.shown} in ${snap.days} days, lifetime uses 0`], relevance: 0.6, evidenceStrength: 0.5, risk: 0.3, effort: 0.3 });
    }
  }
  for (const n of snap.notFound || []) {
    if (n.count < NOT_FOUND_REPEAT) continue;
    out.push({ title: `스킬 공백: "${n.q.slice(0, 60)}" ${n.count}회 찾지 못함`, component: 'c6-skills', targets: [],
      hypothesis: '같은 질의가 반복해서 notFound였다. 맞는 기존 스킬의 설명에 이 표현을 넣거나, 없으면 새 스킬이 필요하다.',
      evidence: [`notFound "${n.q.slice(0, 80)}" × ${n.count} (last ${n.last})`], relevance: 0.7, evidenceStrength: 0.6, novelty: 0.5, effort: 0.4 });
  }
  const week = (snap.series || []).slice(-7), finds = sum(week, 'finds'), missed = sum(week, 'notFound');
  if (finds >= 10 && missed / finds > 0.3) {
    out.push({ title: `스킬 검색 적중 낮음: 최근 7일 찾지 못함 ${pct(missed, finds)}%`, component: 'skill-index', targets: ['src/core/cache/skill-index.js', 'skills/catalog.json'],
      hypothesis: '찾지 못함 비율이 30%를 넘는다. 교차 언어 임베딩(index.skillEmbeddingModel) 사용 여부와 description 언어를 먼저 확인한다.',
      evidence: [`7 days: finds ${finds}, notFound ${missed}`], relevance: 0.7, evidenceStrength: 0.7, effort: 0.5 });
  }
  return out.map((p) => ({ ...p, origin: ORIGIN }));
}

/** 사람과 AI가 같이 읽는 수치 요약. 질의는 이미 가려져 있고 코드·경로 원문은 없다. */
function brief(snap) {
  const s = snap.series || [], skills = Object.entries(snap.skills || {});
  const finds = sum(s, 'finds'), notFound = sum(s, 'notFound'), found = sum(s, 'found'), misses = sum(s, 'misses');
  const cache = s.filter((r) => r.cacheHitRatio != null).slice(-7);
  const lines = [`# 스킬 참조 지표 (최근 ${snap.days}일, 이 PC)`,
    `- skill_find ${finds}회, 찾지 못함 ${notFound}회 (${pct(notFound, finds)}%)`,
    `- 실제 사용(skill_use) ${sum(s, 'uses')}회, 검색을 거친 사용 ${found}회, 참조까지 평균 miss ${found ? (misses / found).toFixed(2) : '-'}회, 쓴 스킬의 평균 검색 순위 ${sum(s, 'ranked') ? (sum(s, 'rankSum') / sum(s, 'ranked')).toFixed(2) : '-'}`,
    `- 캐시 적중률(최근 기록 7일 평균) ${cache.length ? pct(sum(cache, 'cacheHitRatio'), cache.length) + '%' : '-'}`,
    `- tool_route 빗나간 의도 합계 ${snap.routes?.total ?? 0}회`, '', '## 참조까지 miss가 많은 스킬'];
  for (const [id, x] of skills.filter(([, x]) => x.found).sort((a, b) => b[1].misses / b[1].found - a[1].misses / a[1].found).slice(0, 8)) {
    lines.push(`- ${id}: 사용 ${x.uses}, 평균 miss ${(x.misses / x.found).toFixed(1)}, 노출 ${x.shown}`);
  }
  lines.push('', '## 자주 찾지 못한 질의', ...(snap.notFound || []).slice(0, 8).map((n) => `- "${n.q}" × ${n.count}`));
  lines.push('', '## 노출되지만 쓰이지 않는 스킬', ...skills.filter(([id, x]) => x.shown && !x.uses && !(snap.lifetime || {})[id]).slice(0, 8).map(([id, x]) => `- ${id}: 노출 ${x.shown}`));
  lines.push('', '## 빗나간 경로 의도', ...(snap.routes?.top || []).slice(0, 5).map((r) => `- "${r.example.slice(0, 80)}" × ${r.count}`));
  return lines.join('\n');
}

/** 사람이 수치를 보고 쓴 개선 방향 → 제안 큐(검토까지). */
async function submitUserProposal({ title, prompt, targets } = {}, deps = {}) {
  const t = String(title || '').trim(), text = String(prompt || '').trim();
  if (!t || !text) throw new Error('제목과 개선 방향을 적으세요');
  const snap = await require('../knowledge-metrics').snapshot({ days: 30 }, deps);
  const research = require('./research-agents');
  const ids = await research.add([{ origin: 'user:knowledge-graph', title: t, hypothesis: text.slice(0, 1200), component: 'c6-skills',
    targets: (Array.isArray(targets) ? targets : []).map(String).slice(0, 10), evidence: brief(snap).split('\n').filter((l) => l.startsWith('- ')).slice(0, 6),
    relevance: 0.8, evidenceStrength: 0.6 }], deps);
  if (!ids.length) throw new Error('같은 제목의 제안이 이미 있습니다');
  await research.review(ids[0], {}, deps);
  return { id: ids[0] };
}

const AI_SCHEMA = { type: 'object', required: ['proposals'], properties: { proposals: { type: 'array', items: { type: 'object', required: ['title', 'hypothesis', 'evidence'],
  properties: { title: { type: 'string' }, hypothesis: { type: 'string' }, targets: { type: 'array', items: { type: 'string' } }, evidence: { type: 'array', items: { type: 'string' } } } } } } };
// 30일 skill_find가 이보다 적으면 AI를 부르지 않는다 — 검색 2회뿐인 지표로도 제안 3개를 채웠다(2026-10-23 실측, 셋째는 근거가 약했다).
const AI_MIN_FINDS = 20;
// 과제가 이름 붙인 범주 → 경로. AI가 경로 대신 이 이름을 targets에 넣었다(실측: "스킬 검색 색인", "도구 경로 표").
const CATEGORY_PATHS = { '스킬 검색 색인': 'src/core/cache/skill-index.js', '도구 경로 표': 'src/core/toolroute/route-defaults.json', '스킬 카탈로그': 'skills/catalog.json' };
const REL_PATH = /^([\w.@-]+\/)*[\w@-][\w.@-]*$/;

/** AI가 낸 targets를 저장소 상대 경로로 고친다. 스킬 이름·범주 이름은 경로로 바꾸고, 그래도 경로 모양이 아니면 버린다. */
function pathTargets(values, paths) {
  const kept = [];
  let dropped = 0;
  for (const raw of values) {
    const v = String(raw).trim().replace(/\\/g, '/').replace(/^\.\//, '');
    const p = CATEGORY_PATHS[v] || paths.get(v) || paths.get(`skill:${v}`) || v;
    // 슬래시도 확장자도 없는 한 단어는 경로가 아니라 이름이다(못 찾은 스킬 이름 등).
    if (REL_PATH.test(p) && !p.split('/').includes('..') && /[/.]/.test(p)) kept.push(p); else dropped++;
  }
  return { targets: [...new Set(kept)].slice(0, 10), dropped };
}

/** 같은 수치 요약(+ 사람의 메모)을 AI가 읽고 최대 3개를 제안한다. 제안만 큐에 들어가고 코드는 만들지 않는다. */
async function aiPropose({ worker = 'local', note = '' } = {}, deps = {}) {
  const snap = await require('../knowledge-metrics').snapshot({ days: 30 }, deps);
  const finds = sum(snap.series || [], 'finds');
  if (finds < AI_MIN_FINDS) {
    return { worker, offered: 0, added: 0, ids: [], skipped: `최근 30일 skill_find ${finds}회 — AI 제안은 ${AI_MIN_FINDS}회 이상 쌓인 뒤에 부릅니다(적은 지표로는 근거 약한 제안을 채웁니다).` };
  }
  const offload = deps.offload || require('../offload');
  const task = ['아래는 AI 하네스(공유 스킬 저장소와 Hub)의 스킬 참조 지표다. 수치를 근거로 하네스를 개선할 제안을 최대 3개 내라.',
    `고칠 대상은 스킬 description·본문(skills/<분류>/<이름>/SKILL.md), 스킬 카탈로그(skills/catalog.json), 스킬 검색 색인(${CATEGORY_PATHS['스킬 검색 색인']}), 도구 경로 표(${CATEGORY_PATHS['도구 경로 표']})다. 코드나 패치는 쓰지 말고 제안만 낸다.`,
    'title: 한 줄. hypothesis: 무엇을 왜 바꾸고 어떤 수치가 어떻게 바뀔지. targets: 괄호 안의 저장소 상대 경로만(범주 이름 금지). evidence: 아래 수치를 그대로 인용. 한국어로.'].join('\n');
  const text = brief(snap) + (String(note).trim() ? `\n\n## 사용자 메모\n${String(note).trim().slice(0, 2000)}` : '');
  const id = offload.run({ task, text, schema: AI_SCHEMA, worker, maxOutputTokens: 2048 });
  let r;
  do { r = await offload.wait(id, 50); } while (r.state === 'running');
  if (r.state !== 'succeeded') throw new Error(`AI 제안 실패: ${r.reason || r.state}`);
  // Codex는 결과를 여러 개로 나눠 답할 수 있다 — 전부 합친다(agent-eval과 같은 이유).
  const paths = await skillPaths(deps);
  let dropped = 0;
  const raws = (r.results || []).flatMap((x) => (x.value && Array.isArray(x.value.proposals) ? x.value.proposals : [])).slice(0, 3)
    .map((p) => {
      const t = pathTargets(Array.isArray(p.targets) ? p.targets : [], paths);
      dropped += t.dropped;
      return { origin: `${ORIGIN}:ai`, title: String(p.title || ''), hypothesis: String(p.hypothesis || ''), component: 'c6-skills',
        targets: t.targets, evidence: Array.isArray(p.evidence) ? p.evidence.map(String) : [], relevance: 0.6, evidenceStrength: 0.4 };
    });
  const research = require('./research-agents');
  const ids = await research.add(raws, deps);
  for (const pid of ids) await research.review(pid, {}, deps);
  return { worker, offered: raws.length, added: ids.length, ids, droppedTargets: dropped };
}

module.exports = { proposals, brief, submitUserProposal, aiPropose, pathTargets, ORIGIN, AI_MIN_FINDS };

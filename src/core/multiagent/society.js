// 멀티에이전트 사회의 역할 분화와 자가개선(Subramaniam et al., "Multiagent Finetuning", ICLR 2025를 가중치 없이 옮긴 것):
// - 역할 배정(생성자 INV·DOM, 비평자)은 rsi_install_loops 옵션이 정하고, 라운드마다 여기에 기록한다.
// - 비평자 예시 은행은 "고친 것(D−)"과 "유지한 것(D+)"을 w : 1−w로 섞는다 — 고치기만 배우면 멀쩡한 답도 뒤집는다.
// - 역할별 채택률·다양성 붕괴가 기준을 넘으면 역할 재배치를 RSI 3번 루프에 제안한다(자동 재배치 없음).
// 호출자 없던 자동 배정(assign)과 다수결 의사 라벨(consensus)은 1.32.12에서 뺐다(사용자 결정, 리뷰 F8).
'use strict';
const path = require('path');
const { writeAtomic, readJson } = require('../atomic-file');

const ROLES = ['generator-inv', 'generator-dom', 'critic'];
const CRITIC_MIX_W = 0.5;
const fileOf = (deps = {}) => path.join(deps.dataDir || require('../paths').hubDataDir(), 'multiagent', 'society.json');

async function load(deps) {
  return readJson(fileOf(deps), { schemaVersion: 1, assignment: null, roles: {}, exemplars: { corrected: [], maintained: [] }, rounds: [] });
}
const save = (v, deps) => writeAtomic(fileOf(deps), JSON.stringify(v, null, 1));

/** 출력 다양성: 해시 벡터 코사인 비유사도 평균 + 합의율. */
function diversity(texts) {
  const { tokens, hashVector, cosine } = require('../text-vectors');
  const idf = new Map();
  const vs = texts.map((t) => hashVector(tokens(t), idf));
  const d = [];
  for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) d.push(1 - cosine(vs[i], vs[j]));
  const mean = d.length ? d.reduce((s, x) => s + x, 0) / d.length : 0;
  return { n: texts.length, dissimilarity: +mean.toFixed(4), collapsed: texts.length > 1 && mean < 0.1 };
}

/** 한 라운드 결과 기록: 역할별 채택 여부, 비평자의 수정/유지 예시, 다양성. */
async function recordRound({ assignment, outcomes = [], criticCases = [], texts = [] }, deps = {}) {
  const v = await load(deps);
  if (assignment) v.assignment = assignment;
  for (const o of outcomes) {
    const r = (v.roles[`${o.role}|${o.worker}`] = v.roles[`${o.role}|${o.worker}`] || { role: o.role, worker: o.worker, n: 0, accepted: 0 });
    r.n++; if (o.accepted) r.accepted++;
  }
  for (const c of criticCases) {
    const bank = c.corrected ? v.exemplars.corrected : v.exemplars.maintained;
    bank.push({ before: String(c.before).slice(0, 600), after: String(c.after).slice(0, 600), at: new Date().toISOString() });
    if (bank.length > 50) bank.splice(0, bank.length - 50);
  }
  const div = diversity(texts);
  v.rounds.push({ at: new Date().toISOString(), diversity: div.dissimilarity, collapsed: div.collapsed });
  v.rounds = v.rounds.slice(-100);
  await save(v, deps);
  return { diversity: div };
}

/** 비평자에게 줄 예시: D−와 D+를 w : 1−w로. */
async function criticExemplars(k = 6, deps = {}) {
  const v = await load(deps);
  const nNeg = Math.round(k * CRITIC_MIX_W);
  return [...v.exemplars.corrected.slice(-nNeg).map((e) => ({ ...e, kind: 'corrected' })), ...v.exemplars.maintained.slice(-(k - nNeg)).map((e) => ({ ...e, kind: 'maintained' }))];
}

/** 사회 자체의 개선 제안: 채택률 낮은 배정, 연속 다양성 붕괴. */
async function proposals(deps = {}) {
  const v = await load(deps);
  const out = [];
  for (const r of Object.values(v.roles)) {
    if (r.n >= 5 && r.accepted / r.n < 0.2) out.push({ title: `${r.role} 역할의 ${r.worker} 채택률 ${Math.round(100 * r.accepted / r.n)}% — 다른 작업자로 재배치`, evidence: [`n ${r.n} accepted ${r.accepted}`], relevance: 0.6, evidenceStrength: 0.7 });
  }
  const last = v.rounds.slice(-3);
  if (last.length === 3 && last.every((r) => r.collapsed)) out.push({ title: '생성자 출력이 3라운드 연속 비슷함(다양성 붕괴) — 생성자 한쪽을 다른 하네스로 교체', evidence: last.map((r) => `dissimilarity ${r.diversity}`), relevance: 0.7, evidenceStrength: 0.6 });
  return out;
}

module.exports = { ROLES, diversity, recordRound, criticExemplars, proposals, load };

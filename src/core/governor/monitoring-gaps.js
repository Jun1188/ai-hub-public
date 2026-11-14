// 거버너(2/3): 모니터링·디버깅 기능의 부족한 점을 기록하는 에이전트.
// 거버너가 관측할 때마다 "판단에 필요했는데 없던 것"을 세어 둔다: 샘플러 중단, GPU 지표 부재, 원인 프로세스를
// 못 찾은 진단, 호출 주체 없는 작업, 실패한 관측 원천. 반복되는 공백은 RSI 3번 루프의 개선 제안이 된다.
'use strict';
const path = require('path');
const { writeAtomic, readJson } = require('../atomic-file');

const fileOf = (deps = {}) => path.join(deps.dataDir || require('../paths').hubDataDir(), 'governor', 'gaps.json');

const refOf = (f) => `${f.kind}:${f.from}`;

async function load(deps) {
  return readJson(fileOf(deps), { schemaVersion: 1, gaps: {} });
}

/** 관측 하나에서 공백을 찾는다(순수). */
function detect(o, actions = []) {
  const gaps = [];
  const s = o.sampler;
  if (s && s.running === false) gaps.push({ key: 'telemetry-sampler-down', detail: s.lastError ? String(s.lastError).slice(0, 120) : 'sampler not running' });
  if (s && s.running && s.nvidia === false) gaps.push({ key: 'gpu-metrics-missing', detail: 'nvidia-smi samples absent — VRAM/thermal decisions are blind' });
  if (o.samples === 0) gaps.push({ key: 'no-samples-in-window', detail: 'no telemetry samples in the decision window' });
  // ref: 그 진단 하나(종류 + 시작 시각). 디버깅 탭이 같은 값으로 줄을 찾으므로 제안에서 그 진단으로 돌아갈 수 있다.
  for (const f of o.findings || []) if (!f.culprits || !f.culprits.some(Boolean)) gaps.push({ key: `unattributed-${f.kind}`, detail: `${f.kind} without a culprit process`,
    ...(Number.isFinite(f.from) ? { ref: refOf(f) } : {}) });
  for (const j of o.offloadJobs || []) if (!j.caller) gaps.push({ key: 'job-without-caller', detail: `offload job on ${j.worker} has no caller attribution` });
  for (const e of o.errors || []) gaps.push({ key: `observe-failed-${e.split(':')[0]}`, detail: e });
  for (const a of actions) if (a.ok === false) gaps.push({ key: `action-failed-${a.type}`, detail: a.error || 'failed' });
  return gaps;
}

async function note(o, actions, deps = {}) {
  const found = detect(o, actions);
  if (!found.length) return [];
  const v = await load(deps);
  const now = new Date().toISOString();
  for (const g of found) {
    const cur = v.gaps[g.key] || { first: now, count: 0 };
    // 같은 진단은 판단 창에 있는 동안 주기마다 다시 보인다 — 서로 다른 최근 5개만 남긴다.
    const refs = g.ref ? [...(cur.refs || []).filter((r) => r !== g.ref), g.ref].slice(-5) : cur.refs;
    v.gaps[g.key] = { ...cur, last: now, count: cur.count + 1, detail: g.detail, ...(refs ? { refs } : {}) };
  }
  await writeAtomic(fileOf(deps), JSON.stringify(v, null, 1));
  return found;
}

async function list(deps = {}) {
  const v = await load(deps);
  return Object.entries(v.gaps).map(([key, g]) => ({ key, ...g })).sort((a, b) => b.count - a.count);
}

/** 10번 넘게 반복된 공백은 개선 제안으로. */
async function proposals(deps = {}) {
  return (await list(deps)).filter((g) => g.count >= 10).map((g) => ({
    title: `모니터링 공백 "${g.key}" ${g.count}회 — 관측 보강`, hypothesis: `${g.detail}. 거버너·디버깅 판단이 이 지표 없이 내려지고 있다.`,
    component: 'client_tool', evidence: [`first ${g.first}`, `last ${g.last}`, `count ${g.count}`, ...(g.refs || []).map((r) => `diagnostic ${r}`)],
    targets: [`gap:${g.key}`, ...(g.refs || []).map((r) => `diagnostic:${r}`)], relevance: 0.7, evidenceStrength: Math.min(0.9, 0.4 + g.count / 100),
  }));
}

/** 순수: 진단마다 그 진단에서 나온 제안을 붙인다 — 그 진단을 직접 가리키는 제안, 없으면 같은 공백(원인 미상 종류)의 제안. */
function link(findings, proposals) {
  const mine = (proposals || []).filter((p) => p.origin === 'monitoring-gaps');
  return (findings || []).map((f) => {
    const exact = mine.filter((p) => (p.targets || []).includes(`diagnostic:${refOf(f)}`));
    const hit = exact.length || f.culprits?.some(Boolean) ? exact : mine.filter((p) => (p.targets || []).includes(`gap:unattributed-${f.kind}`));
    return hit.length ? { ...f, proposals: hit.slice(0, 3).map((p) => ({ id: p.id, state: p.state, exact: exact.includes(p) })) } : f;
  });
}

module.exports = { detect, note, list, proposals, link };

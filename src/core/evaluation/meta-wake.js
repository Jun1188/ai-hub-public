// L2(평가기 개선)는 주기 표본 대신 사건으로 깨운다: 지난 메타 평가 뒤 새 평가 지문이 생겼거나 Hub 버전이 바뀌었을 때만.
// 같은 지문을 다시 재면 agent-eval이 캐시를 돌려주고 장부에 줄을 남기지 않아 짝이 늘지 않는다(실측: L2 2회 → 짝 0·0·0).
// Hub 업데이트를 깨움 조건에 넣는 이유: L1이 쉬면 새 지문이 없어 메타 신호가 오래 묵는다 — 버전이 바뀌면 hub-source 지문도 바뀐다.
'use strict';
const fs = require('fs');
const path = require('path');
const store = require('./eval-store');
const { writeAtomic, readJson } = require('../atomic-file');

const L2_ID = 'rsi-l2-evaluator';
const stateFile = (deps = {}) => path.join(store.dirOf(deps), 'meta-wake.json');

async function hubVersion(deps) {
  if (deps.hubVersion) return deps.hubVersion;
  const root = deps.appRoot || require('../paths').appRoot();
  return JSON.parse(await fs.promises.readFile(path.join(root, 'package.json'), 'utf8')).version;
}

/** due() → { due, reasons, newFingerprints, hubVersion, seenVersion, lastMetaAt } — 모델·네트워크 없이 장부만 읽는다. */
async function due(deps = {}) {
  const { rows } = await store.recent({ limit: 5000 }, deps);
  const metaAt = Math.max(0, ...rows.filter((r) => r.tier === 'meta').map((r) => Date.parse(r.at) || 0));
  const judged = rows.filter((r) => r.tier !== 'meta' && r.fingerprint);
  const before = new Set(judged.filter((r) => Date.parse(r.at) <= metaAt).map((r) => r.fingerprint));
  const fresh = new Set(judged.filter((r) => Date.parse(r.at) > metaAt && !before.has(r.fingerprint)).map((r) => r.fingerprint));
  const version = await hubVersion(deps);
  const seen = (await readJson(stateFile(deps), {})).hubVersion || null;
  const reasons = [...(fresh.size ? [`new evaluation fingerprints ${fresh.size}`] : []), ...(seen !== version ? [`Hub ${seen || 'unseen'} -> ${version}`] : [])];
  return { due: reasons.length > 0, reasons, newFingerprints: fresh.size, hubVersion: version, seenVersion: seen, lastMetaAt: metaAt ? new Date(metaAt).toISOString() : null };
}

/** 깨울 때만 L2를 시작한다. 설치 안 됨·이미 도는 중·사람 검토 대기면 시작하지 않고 다음 점검으로 미룬다. */
async function wake(deps = {}) {
  const d = await due(deps);
  if (!d.due) return { started: false, ...d };
  const pipeline = deps.pipeline || require('../pipeline');
  if (!pipeline.list().some((p) => p.id === L2_ID)) return { started: false, skipped: 'L2 not installed', ...d };
  if (pipeline.history(L2_ID).some((r) => r.status === 'running' || r.status === 'paused')) return { started: false, skipped: 'L2 run in progress or waiting for review', ...d };
  const { runId } = pipeline.start(L2_ID);
  await writeAtomic(stateFile(deps), JSON.stringify({ hubVersion: d.hubVersion, wokeAt: new Date().toISOString(), runId, reasons: d.reasons }));
  return { started: true, runId, ...d };
}

module.exports = { due, wake, L2_ID };

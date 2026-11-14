// 도구 경로 표("동적 syscall"): 의도 문장 → 가장 싼 실행 경로.
//   table(결정적 Hub 함수) < graph(상태 그래프) < api(등록된 HTTP 연결) < mcp(다운스트림·버스) < computer-use(GUI).
// 같은 의도면 싼 경로를 먼저 쓰고, 실제 성공률·지연을 장부에 남긴다. 실패가 잦은 경로·자주 빗나가는 의도·
// 오래 안 쓴 경로는 추가·수정·삭제 제안이 되어 RSI 3번 루프(검토 → 사람 승인)를 거쳐서만 표에 반영된다.
// 능력(capabilities)은 논리 마운트·연결 이름만 쓰고, 정책 밖 능력을 선언한 경로는 고르지 않는다(기본 거부).
'use strict';
const path = require('path');
const crypto = require('crypto');
const { writeAtomic, readJson } = require('../atomic-file');

// guide: 공식 문서로만 확인했거나 하네스 안에서 도는 경로. Hub는 실행하지 않고 안내(note)만 돌려준다 — 외부 전송·요금을 확인 없이 내지 않게.
const KIND_COST = { table: 1, graph: 2, api: 3, mcp: 4, guide: 5, 'computer-use': 6 };
const RELEVANT = 0.5; // 최고 일치 대비 이 비율 이상이어야 비용 경쟁에 낀다
// drive: = Drive 데스크톱 동기화 폴더(drive-sync-folder.js — 기기 설정 루트 안, 삭제 없음). 실행기는 이 마운트를 실제 경로로 바꾸지 않는다.
const POLICY = { fs: ['app:', 'repo:', 'rsi:', 'proj:', 'drive:'], net: ['api-connections', 'downstream', 'loopback', 'web-allowlist'], gui: true };

const fileOf = (deps = {}, name) => path.join(deps.dataDir || require('../paths').hubDataDir(), 'toolroutes', name);

/** 기본 표 + 이 PC에서 승인된 편집(toolroutes.local.json). 편집은 id 단위로 덮는다. */
async function load(deps = {}) {
  const base = deps.defaults || require('./route-defaults.json');
  const local = await readJson(fileOf(deps, 'routes.local.json'), { schemaVersion: 1, edits: [] });
  const byId = new Map(base.routes.map((r) => [r.id, { ...r, origin: 'default' }]));
  for (const e of local.edits || []) {
    if (e.action === 'delete') byId.delete(e.route.id);
    else byId.set(e.route.id, { ...(byId.get(e.route.id) || {}), ...e.route, origin: 'approved-edit' });
  }
  return [...byId.values()];
}

function allowed(route, policy = POLICY) {
  const c = route.capabilities || {};
  const bad = [];
  for (const f of c.fs || []) if (!policy.fs.includes(f)) bad.push(`fs:${f}`);
  for (const n of c.net || []) if (!policy.net.includes(n)) bad.push(`net:${n}`);
  if (c.gui && !policy.gui) bad.push('gui');
  return bad;
}

async function stats(deps) { return readJson(fileOf(deps, 'ledger.json'), { schemaVersion: 1, routes: {}, misses: {} }); }

/** 의도 → 경로 후보. 점수 = 어휘 일치 × 학습된 성공률 ÷ 경로 비용. */
async function resolve(intent, { limit = 3, exclude = [] } = {}, deps = {}) {
  const { tokens } = require('../text-vectors');
  const q = new Set(tokens(intent));
  if (!q.size) throw new Error('intent is empty');
  const routes = await load(deps);
  const st = await stats(deps);
  const rows = [];
  for (const r of routes) {
    if (exclude.includes(r.id)) continue;
    const rt = new Set(tokens(`${r.id.replace(/-/g, ' ')} ${r.intent}`));
    let hit = 0;
    for (const t of q) if (rt.has(t)) hit++;
    if (!hit) continue;
    const s = st.routes[r.id] || { ok: 0, fail: 0 };
    const success = (s.ok + 1) / (s.ok + s.fail + 2); // 라플라스 평활 — 기록이 없으면 0.5
    const denied = allowed(r);
    rows.push({ id: r.id, kind: r.kind, target: r.target, origin: r.origin, ...(r.note ? { note: r.note } : {}), match: +(hit / q.size).toFixed(3), success: +success.toFixed(3),
      score: denied.length ? 0 : (hit / q.size) * (0.5 + success) / KIND_COST[r.kind], denied });
  }
  // 비용은 "의도에 비슷하게 맞는 경로들" 사이에서만 고른다. 가장 잘 맞는 경로의 절반에도 못 미치는 일치는 우연한 겹침이다
  // (2026-10-22: '웹 페이지 캡처'가 '페이징'과 음절 하나 겹친 자원 진단 표 경로로 갔다 — 일치 1/6 ÷ 비용 1 = 일치 6/6 ÷ 비용 6).
  const top = Math.max(0, ...rows.map((r) => r.match));
  for (const r of rows) { if (r.match < RELEVANT * top) { r.score *= 0.1; r.weak = true; } r.score = +r.score.toFixed(4); }
  rows.sort((a, b) => b.score - a.score);
  const best = rows.find((r) => r.score > 0) || null;
  if (!best) await recordMiss(intent, deps);
  return { best, alternatives: rows.filter((r) => r !== best).slice(0, limit - 1), fallback: best ? null : 'computer-use or ask the user — no route matched' };
}

async function saveLedger(v, deps) { await writeAtomic(fileOf(deps, 'ledger.json'), JSON.stringify(v, null, 1)); }

async function recordMiss(intent, deps) {
  const v = await stats(deps);
  const key = require('../text-vectors').tokens(intent).slice(0, 6).join(' ');
  if (!key) return;
  const by = { ...((v.misses[key] || {}).by || {}) }, h = require('../harness-usage').harnessOfCaller();
  by[h] = (by[h] || 0) + 1;
  v.misses[key] = { n: ((v.misses[key] || {}).n || 0) + 1, last: new Date().toISOString(), example: String(intent).slice(0, 160), by };
  const keys = Object.keys(v.misses);
  if (keys.length > 200) for (const k of keys.sort((a, b) => v.misses[a].last.localeCompare(v.misses[b].last)).slice(0, keys.length - 200)) delete v.misses[k];
  await saveLedger(v, deps);
}

/** 실행 결과를 남긴다(호출한 에이전트·Hub 연산 모두). by = 부른 하네스별 횟수(MCP 클라이언트, Hub 자신은 ai-hub). */
async function record(id, { ok, ms = null } = {}, deps = {}) {
  const v = await stats(deps);
  const s = v.routes[id] || { ok: 0, fail: 0, ms: [], last: null };
  if (ok) s.ok++; else s.fail++;
  const h = require('../harness-usage').harnessOfCaller();
  s.by = { ...(s.by || {}), [h]: ((s.by || {})[h] || 0) + 1 };
  if (Number.isFinite(ms)) s.ms = [...(s.ms || []), ms].slice(-50);
  s.last = new Date().toISOString();
  v.routes[id] = s;
  await saveLedger(v, deps);
  return s;
}

/** 자가개선 제안: 잦은 실패 → 강등(modify), 반복 빗나감 → 추가(insert), 60일 미사용 → 삭제(delete). */
async function proposeEdits(deps = {}) {
  const routes = await load(deps);
  const v = await stats(deps);
  const out = [];
  const now = Date.now();
  for (const r of routes) {
    const s = v.routes[r.id];
    if (s && s.ok + s.fail >= 5 && s.fail / (s.ok + s.fail) >= 0.5) {
      const next = Object.keys(KIND_COST).find((k) => k !== 'guide' && KIND_COST[k] > KIND_COST[r.kind]) || r.kind;
      out.push({ action: 'modify', title: `경로 ${r.id} 실패율 ${Math.round(100 * s.fail / (s.ok + s.fail))}% — ${next} 쪽으로 강등`, route: { ...r, kind: next }, evidence: [`ok ${s.ok} fail ${s.fail}`] });
    }
    if (r.origin === 'approved-edit' && (!s || (s.last && now - Date.parse(s.last) > 60 * 86400000))) {
      out.push({ action: 'delete', title: `경로 ${r.id} 60일 미사용 — 삭제`, route: { id: r.id }, evidence: [s ? `last ${s.last}` : 'never used'] });
    }
  }
  for (const [key, m] of Object.entries(v.misses)) {
    if (m.n < 3) continue;
    const id = 'learned-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
    out.push({ action: 'insert', title: `빗나간 의도 ${m.n}회: "${m.example.slice(0, 60)}" — 새 경로`, evidence: [`misses ${m.n}`],
      route: { id, kind: 'computer-use', target: 'harness:claude-code', intent: key, capabilities: { fs: [], net: [], gui: true } } });
  }
  return out;
}

/** 승인된 편집만 기기 전용 표에 쓴다. 정책 밖 능력은 승인돼도 거부한다. */
async function applyEdit(edit, { confirmed } = {}, deps = {}) {
  if (confirmed !== true) throw new Error('경로 표 편집은 사람이 승인해야 합니다(confirmed: true)');
  if (!['insert', 'modify', 'delete'].includes(edit.action) || !edit.route || !/^[a-z0-9][\w-]{0,63}$/.test(edit.route.id || '')) throw new Error('bad edit');
  if (edit.action !== 'delete') {
    if (!KIND_COST[edit.route.kind]) throw new Error('bad route kind');
    const denied = allowed(edit.route);
    if (denied.length) throw new Error('route asks for capabilities outside policy: ' + denied.join(', '));
  }
  const local = await readJson(fileOf(deps, 'routes.local.json'), { schemaVersion: 1, edits: [] });
  local.edits.push({ ...edit, at: new Date().toISOString() });
  await writeAtomic(fileOf(deps, 'routes.local.json'), JSON.stringify(local, null, 1));
  return { ok: true, edits: local.edits.length };
}

module.exports = { load, resolve, record, proposeEdits, applyEdit, allowed, KIND_COST, POLICY };

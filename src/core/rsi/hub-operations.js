// 조립 루트: 평가·RSI·연구 에이전트 연산을 상태 그래프의 hub-tool 단계에 등록한다.
// 파이프라인 모듈이 자가개선 모듈을 직접 알지 않도록 등록은 여기(위 계층)에서만 한다.
// 실행 중간 산출물(기준 트리·후보·결정)은 그래프 상태(64 KiB 상한)가 아니라 rsi/runs/<runId>/에 둔다.
'use strict';
const fs = require('fs');
const path = require('path');
const store = require('../evaluation/eval-store');
const { writeAtomic } = require('../atomic-file');

const MAX_BRIEF_CHARS = 150000;
const SCOPE = /^[\w.-]+(\/[\w.-]+)*$/;

function runDir(runId, deps = {}) {
  if (!/^[\w-]{1,80}$/.test(String(runId))) throw new Error('bad run id');
  return path.join(deps.dataDir || require('../paths').hubDataDir(), 'rsi', 'runs', String(runId));
}
async function readRun(runId, name, deps) { return JSON.parse(await fs.promises.readFile(path.join(runDir(runId, deps), name), 'utf8')); }
async function writeRun(runId, name, value, deps) { await writeAtomic(path.join(runDir(runId, deps), name), typeof value === 'string' ? value : JSON.stringify(value)); }

function repoRoot(deps) {
  const root = (deps.sharedRepo || require('../shared-repo-memory')).repoRoot();
  if (!root) throw new Error('공유 저장소(codex-shared-context) 위치를 찾지 못했습니다 — 설정의 sharedContext.repoPath');
  return root;
}

const domainOf = (scope) => scope.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 47) || 'harness';

/** 범위 안의 하네스 트리. 범위 밖 파일은 후보가 고쳐도 표면 검사가 막는다. */
async function scopedTree(scope, deps) {
  if (!SCOPE.test(scope) || scope.includes('..')) throw new Error('scope는 저장소 상대 경로입니다');
  const surface = require('./harness-surface');
  const { tree } = await surface.loadTree(path.join(repoRoot(deps), ...scope.split('/')));
  const out = {};
  for (const [rel, text] of Object.entries(tree)) out[`${scope}/${rel}`] = text;
  // 범위가 하위 폴더면 loadTree가 표면 경로를 못 알아보므로 범위 접두사를 붙여 다시 거른다.
  if (!Object.keys(out).length) {
    const walk = async (rel) => {
      for (const e of await fs.promises.readdir(path.join(repoRoot(deps), rel), { withFileTypes: true }).catch(() => [])) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== '.git' && e.name !== 'node_modules') await walk(child); }
        else if (surface.componentOf(child) && Object.keys(out).length < 400) out[child] = await fs.promises.readFile(path.join(repoRoot(deps), child), 'utf8');
      }
    };
    await walk(scope);
  }
  return out;
}

/** 변이 설계서(R3): 문자열 칸만 짧게 남긴다 — 사람 검토와 경험 라이브러리가 읽는다. */
function blueprintOf(b) {
  if (!b || typeof b !== 'object') return null;
  const out = {};
  for (const k of ['mechanism', 'targetModule', 'interface', 'state', 'operations', 'auxiliaryCalls', 'termination', 'provenance']) if (typeof b[k] === 'string' && b[k].trim()) out[k] = b[k].trim().slice(0, 600);
  return out.mechanism ? out : null;
}

/** offload 결과(results[].value)에서 패치가 있는 후보만. */
function fromResults(results, idOf, kind) {
  const out = [];
  for (const [i, r] of (results || []).entries()) {
    const v = r && r.value;
    if (!v || !Array.isArray(v.patches) || !v.patches.length) continue;
    const patch = {};
    for (const p of v.patches.slice(0, 40)) if (p && typeof p.path === 'string' && typeof p.content === 'string') patch[p.path.replace(/\\/g, '/')] = p.content;
    out.push({ id: idOf(i), kind, patch, rationale: String(v.rationale || '').slice(0, 2000), lesson: v.lesson || null, blueprint: blueprintOf(v.blueprint) });
  }
  return out;
}

function candidatesFromState(state) {
  const out = [];
  for (const kind of ['inv', 'dom']) {
    const d = state[kind] && state[kind].data; // 1.32.8까지 설치된 그래프는 keepInv/keepDom가 last 전체를 상태에 복사한다
    out.push(...fromResults(d && d.results, (i) => `${kind}-${i + 1}`, kind.toUpperCase()));
  }
  return out;
}

const seedOf = (runId) => parseInt(store.keyOf(runId).slice(0, 8), 16);
// Compose가 두 쪽에 다 있는 검사로만 차이를 재고 통과·실패가 바뀐 검사를 찾으려면 검사별 결과가 실행 기록에 있어야 한다.
const detOf = (r) => ({ score: r.score, criticalFailed: r.criticalFailed, checks: r.checks.map(({ id, pass, score, weight }) => ({ id, pass, score, weight })) });
// 제안자·판정자(그래프 인자, 1.32.19까지 저장된 그래프에는 없다 — 그러면 Compose가 같은지 모른다고 남긴다).
// 판정자는 실행이 실제로 쓴 것(judge.json)이 우선이다 — 순서 옵션이면 그래프 인자로는 누가 판정했는지 모른다.
const workersOf = (a, judge) => (a.proposer ? { proposer: a.proposer, judgeWorker: judge ? judge.used : a.judgeWorker || null } : null);
// 판정자 순서(1.32.22): judgeOrder가 있으면 그것, 없으면 예전 judgeWorker 하나.
const { cloudFirstJudgeOrder } = require('./triple-loop');
const judgeOrderOf = (a) => cloudFirstJudgeOrder(Array.isArray(a.judgeOrder) && a.judgeOrder.length ? a.judgeOrder : a.judgeWorker ? [a.judgeWorker] : []);
// "이 판정자는 지금 쓸 수 없다"는 거절(할당량·사용 한도·입장 거절·미설치·인증)일 때만 다음 판정자로 넘어간다.
// 시간 초과·스키마 실패는 그 후보만 판정 없이 둔다(예전과 같음) — 판정자를 바꿔도 같은 입력이면 다시 실패하기 쉽다.
// 사유 코드와 그 분류는 agent-workers 한 곳에 있다(원본 갱신 검토도 같은 규칙을 쓴다, 1.32.27).
const JUDGE_UNAVAILABLE = require('../agent-workers').WORKER_UNAVAILABLE;

function operations(deps = {}) {
  const det = () => require('../evaluation/deterministic-eval');
  const agent = () => require('../evaluation/agent-eval');
  const meta = () => require('../evaluation/meta-eval');
  const research = () => require('./research-agents');
  const surface = () => require('./harness-surface');
  const engine = () => require('./loop-engine');
  const appRoot = () => deps.appRoot || require('../paths').appRoot();
  // 1.32.22 전에 시작한 실행에는 judge.json이 없다 — 그때는 그래프 인자(judgeWorker)를 쓴다.
  const readJudge = (runId) => readRun(runId, 'judge.json', deps).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });

  function evaluateSubject(subject, args, fingerprint) {
    // Keep legacy source excerpts local unless a worker was explicitly selected.
    const worker = args.worker || (args.includeSource ? 'local' : 'codex');
    return agent().evaluate(subject, { worker, fingerprint, sample: args.sample || 0,
      includeSource: !!args.includeSource, structureOnly: !args.worker && !args.includeSource }, deps);
  }

  async function subject(name) {
    if (name === 'hub-source') return { kind: 'hub-source', label: 'hub-source', root: appRoot() };
    if (name === 'shared-skills') return { kind: 'harness-tree', label: 'shared-skills', tree: await scopedTree('skills/development', deps) };
    throw new Error('알 수 없는 평가 대상: ' + name);
  }

  /** 같은 보기를 judgeSamples번 판정해 항목별 다수결로(R8). 표본 번호가 캐시 키라 기준 보기는 실행마다 다시 재지 않는다. */
  async function judgeView(label, tree, fingerprint, a) {
    const runs = [], reasons = [];
    for (let s = 0; s < Math.max(1, Math.min(5, a.judgeSamples || 1)); s++) {
      const r = await agent().evaluate({ kind: 'harness-tree', label, tree }, { worker: a.judgeWorker, fingerprint, sample: s }, deps).catch((e) => ({ judgeFailed: true, reason: String(e.message || e) }));
      if (r && !r.judgeFailed) runs.push(r); else if (r) reasons.push(String(r.reason || ''));
      if (JUDGE_UNAVAILABLE.test(reasons.at(-1) || '')) break; // 남은 표본을 같은 판정자로 부르지 않는다
    }
    // 표본 하나라도 "쓸 수 없음"으로 거절되면 성공한 표본이 있어도 이 판정자를 버린다 — 남은 표본만으로 다수결을 내면 표본 수가 판정자마다 달라지고
    // 거절이 judge.skipped에도 남지 않았다(1.32.22, Codex 교차 리뷰).
    const why = reasons.find((x) => JUDGE_UNAVAILABLE.test(x));
    if (why) return { unavailable: why };
    if (!runs.length) return null;
    const m = engine().majority(runs.map((r) => r.items.map((i) => ({ id: i.id, verdict: i.verdict }))));
    return { score: runs[0].score, items: m.items, samples: runs.length, consistency: m.consistency };
  }

  /** 후보 하나: 결정적 → 건강 탐침 → (건강하면) 기준·후보를 바뀐 경로만 담은 같은 모양의 보기로 판정해야 항목끼리 짝이 된다. */
  async function measure(c, base, a) {
    const tree = surface().applyPatch(base.tree, c.patch);
    const d = await det().evaluate({ kind: 'harness-tree', label: `cand:${c.id}`, tree, base: base.tree }, deps);
    const health = require('./health-probe').probe(base.tree, tree, c.patch, { module: c.module });
    let ag = null, agBase = null;
    if (a.judgeWorker && health.ok && !d.criticalFailed.length) { // 망가진 후보는 판정하지 않는다(판정 1회 30~70초)
      const paths = Object.keys(c.patch);
      const view = (t) => Object.fromEntries(paths.filter((p) => t[p] != null).map((p) => [p, t[p]]));
      ag = await judgeView(`cand:${c.id}`, view(tree), d.fingerprint, a); // 결정적 평가와 같은 지문 — 3계층이 짝을 찾는다
      if (ag?.unavailable) return { judgeUnavailable: ag.unavailable };
      const bv = view(base.tree);
      if (ag) agBase = Object.keys(bv).length ? await judgeView(`base-view:${c.id}`, bv, surface().fingerprint(bv), a) : { empty: true, items: [] };
      if (agBase?.unavailable) return { judgeUnavailable: agBase.unavailable };
    }
    return { ...c, diff: surface().diffSummary(base.tree, tree), eval: { det: detOf(d), health, agent: ag, agentBase: agBase } };
  }

  /**
   * 판정자는 실행 단위로 고른다: 순서대로 쓸 수 있는 첫 판정자로 이 실행의 기준 보기·후보를 모두 잰다. 도중에 그 판정자가 거절하면(할당량 등)
   * 이미 잰 판정을 버리고 다음 판정자로 전부 다시 잰다 — 기준과 후보를 다른 판정자로 재면 항목 짝이 섞인다(D1). 모두 거절하면 판정 없이 잰다.
   */
  async function measureAll(cands, base, a) {
    const order = judgeOrderOf(a), skipped = [];
    for (const judgeWorker of order) {
      // Mixed orders from older saved graphs may put local before another cloud.
      // A dedicated local judge has no cloud refusals to check.
      if (judgeWorker === 'local' && skipped.some(({ worker, reason }) =>
        reason.split(/[^a-z0-9_]/, 1)[0] !== worker + '_quota_exhausted')) {
        skipped.push({ worker: 'local', reason: 'cloud_quota_not_exhausted' });
        break;
      }
      const out = [];
      let why = null;
      for (const c of cands) { const m = await measure(c, base, { ...a, judgeWorker }); if (m.judgeUnavailable) { why = m.judgeUnavailable; break; } out.push(m); }
      if (!why) return { evaluated: out, judge: { order, used: judgeWorker, skipped } };
      skipped.push({ worker: judgeWorker, reason: why.slice(0, 120) });
    }
    const out = [];
    for (const c of cands) out.push(await measure(c, base, { ...a, judgeWorker: null }));
    return { evaluated: out, judge: { order, used: null, skipped } };
  }

  /** L3에서 사람이 승인한 연구 가설 중 이 범위에 닿는 것(R3: 제안자가 설계서 provenance로 가설 ID를 잇는다). */
  async function approvedHypotheses(scope) {
    try {
      const rows = (await research().list({ state: 'approved' }, deps))
        .filter((p) => String(p.origin).startsWith('research:') || (p.targets || []).some((t) => t === scope || t.startsWith(scope + '/')))
        .sort((x, y) => String(y.decision?.at || '').localeCompare(String(x.decision?.at || ''))).slice(0, 3);
      return rows.length ? rows.map((p) => `- [${p.id}] ${p.title}: ${String(p.hypothesis || '').slice(0, 300)}`) : ['- 없음'];
    } catch (e) { return [`- 읽지 못함 (${String(e.message || e).slice(0, 80)})`]; } // 제안 큐 손상이 L1을 막지 않게
  }

  return {
    'eval.deterministic': { description: '1계층 결정적 평가 (hub-source | shared-skills | debug-diagnostics)', fn: async (a) => {
      const target = a.subject === 'debug-diagnostics' ? {kind:'debug-diagnostics',label:'디버깅 고정 회귀'} : await subject(a.subject || 'hub-source');
      const r = await det().evaluate({ ...target, runTests: !!a.runTests }, deps);
      return { ok: true, score: r.score, passed: r.passed, failed: r.failed, criticalFailed: r.criticalFailed, fingerprint: r.fingerprint, cached: r.cached,
        failedChecks: r.checks.filter((c) => !c.pass).map((c) => c.id) };
    } },
    'eval.agent': { description: '2계층 에이전트 판정 (worker local|codex|agy, includeSource: Hub 소스 줄 발췌를 보낸다)', fn: async (a) => {
      const s = await subject(a.subject || 'hub-source');
      const d = await det().evaluate(s, deps); // 같은 지문으로 묶여야 3계층이 짝을 찾는다
      const r = await evaluateSubject(s, a, d.fingerprint);
      return { ok: !r.judgeFailed, score: r.score, judgeFailed: r.judgeFailed, reason: r.reason, items: r.items.length, decisive: r.decisive, failedParts: r.failedParts || 0, noDecision: r.noDecision || null, cached: r.cached };
    } },
    'eval.meta': { description: '3계층 메타 평가', fn: async () => {
      const r = await meta().evaluate({}, deps);
      return { ok: true, status: r.status, pairs: r.pairs, kappa: r.kappa, brier: r.brier, judgeFailureRate: r.judgeFailureRate, proposals: r.proposals.length };
    } },
    'eval.sample': { description: '기준 대상을 1·2계층으로 함께 재서 메타 평가 표본을 모은다', fn: async (a) => {
      const out = [];
      for (const name of a.subjects || ['hub-source']) {
        const s = await subject(name);
        const d = await det().evaluate(s, deps);
        const j = await evaluateSubject(s, a, d.fingerprint).catch((e) => ({ judgeFailed: true, reason: e.message }));
        out.push({ subject: name, det: d.score, agent: j.score ?? null, decisive: j.decisive ?? null, judgeFailed: !!j.judgeFailed, ...(j.failedParts ? { failedParts: j.failedParts } : {}), ...(j.noDecision ? { noDecision: j.noDecision } : {}), cached: !!j.cached });
      }
      // 캐시로 돌아온 판정은 이미 있는 짝이다 — L2 그래프는 새 짝이 생겼을 때만 메타 평가로 돌아간다.
      return { ok: true, sampled: out, newPairs: out.filter((o) => !o.cached && !o.judgeFailed && o.agent != null).length };
    } },
    'structure.audit': { description: '구조 감사 요약', fn: async () => {
      const a = require('../architecture/structure-audit');
      const r = await a.audit(appRoot());
      return { ok: true, ...r.totals, score: a.structureScore(r).score, hotspots: r.hotspots.slice(0, 5) };
    } },
    'rsi.base': { description: 'L1 기준 하네스를 읽고 제안자용 brief를 만든다', fn: async (a, ctx) => {
      const scope = a.scope || 'skills/development';
      const tree = await scopedTree(scope, deps);
      const lessons = await require('./experience-library').lessons(domainOf(scope), { limit: 10 }, deps);
      const base = await det().evaluate({ kind: 'harness-tree', label: `base:${scope}`, tree }, deps);
      let body = '';
      for (const [rel, text] of Object.entries(tree)) { if (body.length > MAX_BRIEF_CHARS) break; body += `\n\n### ${rel}\n\`\`\`\n${text.slice(0, 12000)}\n\`\`\``; }
      const brief = [`# 기준 하네스: ${scope}`, '', '## 허용 경로(표면)', ...surface().COMPONENTS.map((c) => `- ${c.id}: ${c.label}`), `- 범위 접두사: ${scope}/`, '',
        `## 기준 결정적 평가: ${base.score} (실패 ${base.checks.filter((c) => !c.pass).map((c) => c.id).join(', ') || '없음'})`, '',
        '## 앞선 교훈', ...(lessons.length ? lessons.map((l) => `- ${l.cue}: ${l.lesson}`) : ['- 없음']), '',
        '## 승인된 연구 가설 (L3, 사람 승인 — 쓰면 blueprint.provenance에 ID)', ...(await approvedHypotheses(scope)), '', '## 파일', body].join('\n');
      const dir = runDir(ctx.runId, deps);
      await writeRun(ctx.runId, 'base.json', { scope, tree, eval: { det: detOf(base) } }, deps);
      await writeRun(ctx.runId, 'brief.md', require('../secret-scrub').scrub(brief), deps);
      return { ok: true, briefPath: path.join(dir, 'brief.md'), fingerprint: base.fingerprint, files: Object.keys(tree).length, score: base.score };
    } },
    'rsi.keep': { description: 'L1 제안 결과의 후보 패치를 실행 폴더에 두고 상태에는 ID만 남긴다', fn: async (a, ctx) => {
      const kind = a.kind === 'dom' ? 'dom' : 'inv';
      const cands = candidatesFromState({ [kind]: ctx.state.last });
      await writeRun(ctx.runId, `${kind}.json`, cands, deps);
      return { ok: true, kind, ids: cands.map((c) => c.id) };
    } },
    'rsi.modules': { description: 'L1 모듈 단위 제안(R4): 범위의 모듈마다 그 모듈만 고친 패치를 작업자에게 받는다', fn: async (a, ctx) => {
      const base = await readRun(ctx.runId, 'base.json', deps);
      const brief = await fs.promises.readFile(path.join(runDir(ctx.runId, deps), 'brief.md'), 'utf8');
      const baseDet = await det().evaluate({ kind: 'harness-tree', label: `base:${base.scope}`, tree: base.tree }, deps); // 지문 캐시
      const targets = require('./module-evolve').pick(base.tree, baseDet.checks, Math.max(1, Math.min(8, a.maxModules || 4)));
      const offload = deps.offload || require('../offload');
      const loops = require('./triple-loop');
      const cands = [], failed = [];
      for (const [mi, [m, files]] of targets.entries()) {
        for (let k = 0; k < Math.max(1, Math.min(3, a.perModule || 1)); k++) {
          if (ctx.cancelled && ctx.cancelled()) break;
          const text = `${brief}\n\n## 대상 모듈: ${m}\n고칠 수 있는 파일(새 파일은 이 모듈 폴더 안에만):\n${files.map((f) => `- ${f}`).join('\n')}`;
          const id = offload.run({ task: loops.proposer('MOD'), text, schema: loops.PROPOSAL_SCHEMA, worker: a.worker || 'codex', maxOutputTokens: 4096 });
          let r;
          do { r = await offload.wait(id, 50); } while (r.state === 'running');
          if (r.state !== 'succeeded') { failed.push({ module: m, reason: String(r.reason || r.state).slice(0, 120) }); continue; }
          cands.push(...fromResults(r.results, (i) => `mod-${mi + 1}-${k + 1}${i ? `-${i + 1}` : ''}`, 'MOD').map((c) => ({ ...c, module: m })));
        }
      }
      await writeRun(ctx.runId, 'mod.json', cands, deps);
      return { ok: true, modules: targets.map(([m]) => m), ids: cands.map((c) => c.id), failed };
    } },
    'rsi.probe': { description: 'L1 후보를 건강 탐침 → 1·2계층으로 잰다(판정자는 기준·후보를 같은 경로로)', fn: async (a, ctx) => {
      const base = await readRun(ctx.runId, 'base.json', deps);
      const kept = await Promise.all(['inv', 'dom', 'mod'].map((k) => readRun(ctx.runId, `${k}.json`, deps).catch((e) => { if (e.code === 'ENOENT') return null; throw e; })));
      const cands = kept.some(Boolean) ? kept.flat().filter(Boolean) : candidatesFromState(ctx.state);
      const { evaluated, judge } = await measureAll(cands, base, a);
      await writeRun(ctx.runId, 'candidates.json', evaluated, deps);
      await writeRun(ctx.runId, 'judge.json', judge, deps); // 이 실행의 판정자(조합·Compose·기록이 같은 판정자를 쓴다)
      return { ok: true, candidates: evaluated.length, judge: judge.used, skippedJudges: judge.skipped,
        scores: evaluated.map((c) => ({ id: c.id, det: c.eval.det.score, agent: c.eval.agent?.score ?? null, agentBase: c.eval.agentBase?.score ?? null, healthy: c.eval.health.ok, consistency: c.eval.agent?.consistency ?? null })) };
    } },
    'rsi.combine': { description: 'L1 모듈 조합(R4): 단일 모듈 이득의 합으로 조합을 골라 전체로 다시 잰다', fn: async (a, ctx) => {
      const base = await readRun(ctx.runId, 'base.json', deps);
      const cands = await readRun(ctx.runId, 'candidates.json', deps);
      const policy = engine().DEFAULT_POLICY, seed = seedOf(ctx.runId);
      const judge = await readJudge(ctx.runId);
      const w = workersOf(a, judge), veto = !!w && w.proposer === w.judgeWorker && policy.sameWorkerVeto; // Compose와 같은 규칙으로 예측한다
      const ja = judge ? { ...a, judgeWorker: judge.used } : a; // 단일 후보를 잰 판정자로 조합도 잰다
      const singles = cands.filter((c) => c.module && c.eval.health?.ok && !c.eval.det.criticalFailed.length)
        .map((c) => ({ id: c.id, module: c.module, point: engine().gain(c, base.eval, policy, seed, { veto })?.point ?? 0 }));
      const combos = [];
      for (const [n, p] of require('./module-evolve').predictCombos(singles, Math.max(0, Math.min(4, a.combos ?? 2))).entries()) {
        const parts = p.ids.map((id) => cands.find((c) => c.id === id));
        const combo = { id: `combo-${n + 1}`, kind: 'COMBO', parts: p.ids, patch: Object.assign({}, ...parts.map((x) => x.patch)),
          rationale: parts.map((x) => `[${x.module}] ${x.rationale}`).join('\n').slice(0, 2000), lesson: null, blueprint: null, predicted: p.predicted };
        let c = await measure(combo, base, ja);
        // 그 판정자가 조합 도중 거절하면 다른 판정자로 바꾸지 않고 판정 없이 잰다(섞지 않는다) — 이 조합은 결정적 근거로만 채택될 수 있다.
        if (c.judgeUnavailable) c = { ...(await measure(combo, base, { ...ja, judgeWorker: null })), judgeUnavailable: c.judgeUnavailable };
        // 원문 C.4의 잔차: 실제 이득 − 예측 이득. 크면 모듈끼리 서로 간섭한다는 뜻이다.
        const actual = engine().gain(c, base.eval, policy, seed, { veto })?.point ?? null;
        c.residual = actual == null ? null : +(actual - p.predicted).toFixed(4);
        cands.push(c);
        combos.push({ id: c.id, parts: p.ids, predicted: p.predicted, actual, residual: c.residual });
      }
      await writeRun(ctx.runId, 'candidates.json', cands, deps);
      return { ok: true, singles: singles.length, combos };
    } },
    'rsi.compose': { description: 'L1 Compose: KEEP_BASE | ADOPT | MERGE', fn: async (a, ctx) => {
      const base = await readRun(ctx.runId, 'base.json', deps);
      const cands = await readRun(ctx.runId, 'candidates.json', deps).catch(() => []);
      const seed = seedOf(ctx.runId);
      const judge = await readJudge(ctx.runId);
      // decision.json에 실제로 쓴 판정자와 넘어간 판정자(사유)를 남긴다 — 같은 작업자인지는 실제 판정자로 정한다.
      const decision = { ...engine().compose({ baseEval: base.eval, candidates: cands, seed, workers: workersOf(a, judge) }), ...(judge ? { judge } : {}) };
      await writeRun(ctx.runId, 'decision.json', decision, deps);
      const reviewDigest=require('./reviewed-export').revision(ctx.runId,base,decision,cands);
      return { ok: true, reviewDigest, decision: decision.decision, chosen: decision.chosen, collapsed: decision.diversity.collapsed, dropped: decision.rows.filter((r) => r.decision === 'dropped').length, sameWorker: decision.sameWorker };
    } },
    'rsi.record': { description: 'L1 결정을 경험 라이브러리에 남기고 채택 패치를 검토용으로 내보낸다', fn: async (a, ctx) => {
      const base = await readRun(ctx.runId, 'base.json', deps);
      const decision = await readRun(ctx.runId, 'decision.json', deps);
      const cands = await readRun(ctx.runId, 'candidates.json', deps).catch(() => []);
      let exportDir = null, reflection = [];
      if (decision.decision !== 'KEEP_BASE' && a.approvedByReview) {
        const exporter=require('./reviewed-export');
        const reviewed=ctx.run?.record?.graphCheckpoint;
        const digest=exporter.revision(ctx.runId,base,decision,cands);
        if (!ctx.run?.graphResume || ctx.run.record.runId !== ctx.runId || !Number.isInteger(reviewed?.transitions) ||
            !ctx.run.record.steps.some(step=>step.kind==='review' && step.status==='paused' && step.transition===reviewed.transitions) ||
            reviewed.data?.last?.data?.reviewDigest !== digest) {
          throw new Error('RSI 검토 시점의 실행·후보 지문을 확인할 수 없습니다. 현재 후보로 새 검토를 시작하세요.');
        }
        const chosen = cands.filter((c) => decision.chosen.includes(c.id));
        const after = chosen[0] ? chosen[0].eval : null;
        const row = (decision.rows || []).find((r) => chosen[0] && r.candidate === chosen[0].id);
        reflection = engine().reflect({ before: base.eval, after, delta: row && row.lcb !== undefined ? row.improvement : undefined,
          diff: surface().diffSummary(base.tree, surface().applyPatch(base.tree, decision.patch)) });
        exportDir = await exporter.publish(runDir(ctx.runId, deps),decision.patch,digest);
      }
      const picked = cands.find((c) => decision.chosen?.includes(c.id));
      await require('./experience-library').append(domainOf(base.scope), { runId: ctx.runId, loop: 'L1', decision: decision.decision, chosen: decision.chosen, reflection,
        lesson: picked?.lesson || null, blueprint: picked?.blueprint || null }, deps);
      // 멀티에이전트 사회에 이 라운드를 남긴다: 생성자 역할별 채택, 비평자의 수정(탈락)/유지 예시, 생성 다양성 → 재배치 제안의 근거.
      // 2026-10-23까지는 아무 루프도 recordRound를 부르지 않아 사회 자가개선이 데이터 없이 놀고 있었다.
      let society = null;
      if (a.roles && cands.length) {
        const rows = new Map((decision.rows || []).map((r) => [r.candidate, r]));
        society = await require('../multiagent/society').recordRound({
          assignment: decision.judge ? { ...a.roles, critic: decision.judge.used || 'none' } : a.roles, // 비평자는 실제로 판정한 작업자
          outcomes: cands.map((c) => { const role = c.kind === 'DOM' ? 'generator-dom' : c.kind === 'MOD' || c.kind === 'COMBO' ? 'generator-mod' : 'generator-inv'; return { role, worker: a.roles[role], accepted: (decision.chosen || []).includes(c.id) }; }),
          criticCases: cands.map((c) => ({ corrected: (rows.get(c.id) || {}).decision === 'dropped', before: `${c.kind} ${c.id}`, after: String(c.rationale || '') })),
          texts: cands.map((c) => String(c.rationale || '')),
        }, deps).catch(() => null);
      }
      return { ok: true, decision: decision.decision, exportDir, society: society && society.diversity };
    } },
    'research.propose': { description: 'L3 제안 에이전트', fn: async (a) => {
      const r = await research().propose(deps);
      if (a.only) {
        const all = await research().list({ state: 'proposed' }, deps);
        return { ok: true, added: all.filter((p) => r.ids.includes(p.id) && p.origin === a.only).length, unavailable: r.unavailable };
      }
      return { ok: true, added: r.added, unavailable: r.unavailable };
    } },
    'research.review': { description: 'L3 검토 에이전트(결정적 선별)', fn: async () => {
      const r = await research().review(null, {}, deps);
      return { ok: true, reviewed: r.reviewed.length, recommended: r.reviewed.filter((x) => x.verdict === 'recommend').length };
    } },
  };
}

let registered = false;
/** 다른 모듈의 연산(캐시 GC·거버너·도구 경로)도 여기서 함께 등록한다. */
function registerAll(deps = {}) {
  if (registered) return;
  const step = require('../pipeline-hub-step');
  for (const [name, op] of Object.entries(operations(deps))) step.register(name, op.fn, op);
  for (const extra of ['../cache/cache-operations', '../governor/governor-operations', '../toolroute/route-operations', '../harness-bridge/bus-operations']) {
    try { const m = require(extra); for (const [name, op] of Object.entries(m.operations(deps))) step.register(name, op.fn, op); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  // 아래 계층의 개선 원천은 여기서 3번 루프 제안 큐에 잇는다 — 그 모듈들이 자가개선 모듈을 알 필요가 없게.
  const research = require('./research-agents');
  research.registerSource('tool-routes', () => require('../toolroute/route-operations').proposals(deps));
  research.registerSource('monitoring-gaps', () => require('../governor/monitoring-gaps').proposals(deps));
  research.registerSource('governor-eval', async () => require('../governor/governor-eval').proposals(await require('../governor/governor-eval').evaluate({}, deps)),
    { producer: () => `${require('../governor/governor').RULES_VERSION}/${require('../governor/governor-eval').EVAL_VERSION}` }); // 결정 규칙과 판정 규칙
  research.registerSource('multiagent-society', () => require('../multiagent/society').proposals(deps));
  research.registerSource('knowledge-metrics', async () => require('./metric-proposals').proposals(await require('../knowledge-metrics').snapshot({ days: 30 }, deps), deps));
  registered = true;
}

module.exports = { registerAll, operations, candidatesFromState, scopedTree, domainOf, runDir };

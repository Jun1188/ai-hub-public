// 평가 1계층: 결정적 평가 프로그램. 같은 입력이면 항상 같은 점수 — 모델을 부르지 않는다.
// 대상: hub-source(앱 소스 구조·시험 결과) / harness-tree(스킬·지침·스크립트 트리 후보).
// 판정자(2계층)와 분리돼 있어야 메타 평가(3계층)가 둘의 일치도를 잴 수 있다.
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const store = require('./eval-store');
const surface = require('../rsi/harness-surface');

const CHECKSET_VERSION = 'det-1';

function check(id, { pass, score, weight = 1, critical = false, evidence = null }) {
  return { id, pass: !!pass, score: Math.max(0, Math.min(1, +(+score).toFixed(4))), weight, critical, evidence };
}

function summarize(checks) {
  const w = checks.reduce((s, c) => s + c.weight, 0) || 1;
  const score = checks.reduce((s, c) => s + c.score * c.weight, 0) / w;
  return {
    score: +score.toFixed(4), passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length,
    criticalFailed: checks.filter((c) => c.critical && !c.pass).map((c) => c.id),
  };
}

/** test-all.js의 마지막 요약 줄("파일크기 위반 0 · 구문오류 0 · 테스트 실패 2/74")을 읽는다. */
function parseTestSummary(text) {
  const m = /파일크기 위반 (\d+) · 구문오류 (\d+) · 테스트 실패 (\d+)\/(\d+)/.exec(String(text || ''));
  if (!m) return null;
  const [oversize, syntax, failed, total] = m.slice(1).map(Number);
  return { oversize, syntax, failed, total, passed: total - failed };
}

function runOfflineTests(root, { timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    // Electron 안에서는 execPath가 앱이라 ELECTRON_RUN_AS_NODE 없이는 앱 창이 하나 더 뜬다. test-all은 시험마다 자식을 띄우므로 시간 초과 때 트리째 끝낸다.
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'test-all.js')], { cwd: root, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    let out = '';
    const timer = setTimeout(() => require('../agent-workers').killTree(child), timeoutMs);
    child.stdout.on('data', (d) => { out = (out + d).slice(-20000); });
    child.on('close', () => { clearTimeout(timer); resolve(parseTestSummary(out)); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

async function hubSourceChecks(subject, deps) {
  const audit = deps.audit || require('../architecture/structure-audit');
  const report = await audit.audit(subject.root);
  const { parts } = audit.structureScore(report);
  const t = report.totals;
  const checks = [
    check('structure.cycles', { pass: t.cycles === 0, score: parts.cycles, critical: true, evidence: report.cycles.slice(0, 5) }),
    check('structure.coupling', { pass: t.coupledFiles <= 8, score: parts.coupling, evidence: report.coupled.filter((c) => c.crossDomain).map((c) => c.files) }),
    check('structure.layers', { pass: t.layerViolations === 0, score: parts.layers, critical: true, evidence: report.violations.slice(0, 10) }),
    check('structure.direction', { pass: t.upwardDependencies <= 40, score: parts.direction, evidence: { upward: t.upwardDependencies } }),
    check('structure.duplication', { pass: t.duplicateRatio <= 0.02, score: parts.duplication, evidence: report.duplicates.slice(0, 5) }),
    check('structure.lineBudget', { pass: t.overBudget === 0, score: parts.budget, critical: true, evidence: report.files.filter((f) => f.overBudget).map((f) => f.path) }),
    check('structure.classified', { pass: t.unclassified === 0, score: parts.classified, evidence: report.unclassified }),
    check('structure.orphans', { pass: t.orphans === 0, score: parts.orphans, weight: 0.5, evidence: report.orphans }),
  ];
  let tests = subject.testSummary || null;
  if (!tests && subject.runTests) tests = await (deps.runOfflineTests || runOfflineTests)(subject.root);
  if (tests) {
    checks.push(check('tests.offline', { pass: tests.failed === 0 && tests.syntax === 0 && tests.oversize === 0,
      score: tests.total ? tests.passed / tests.total : 0, weight: 3, critical: true, evidence: tests }));
  }
  const fp = store.keyOf(report.files.map((f) => [f.path, f.lines, f.complexity, f.fanOut, f.duplicateShingles]), tests);
  return { checks, fingerprint: fp, extra: { totals: t, hotspots: report.hotspots.slice(0, 8) } };
}

const USAGE_CUE = /\b(use|when|trigger)\b|사용|때|요청/i;

function harnessTreeChecks(subject, deps) {
  const tree = subject.tree || {};
  const base = subject.base || null;
  const errors = surface.validateTree(tree, subject.spec || surface.DEFAULT_SPEC);
  const checks = [check('surface.valid', { pass: !errors, score: errors ? Math.max(0, 1 - errors.split('\n').length / 10) : 1, critical: true, evidence: errors ? errors.split('\n').slice(0, 20) : [] })];
  if (base) {
    const d = surface.diffSummary(base, tree);
    checks.push(check('surface.alwaysOnGrowth', { pass: d.alwaysOnCharDelta <= 0 || d.alwaysOnCharDelta <= 1500,
      score: 1 - Math.max(0, d.alwaysOnCharDelta) / 3000, evidence: { delta: d.alwaysOnCharDelta, components: d.components } }));
    checks.push(check('surface.focusedEdit', { pass: d.components.length <= 2, score: d.components.length <= 1 ? 1 : 2 / (1 + d.components.length),
      weight: 0.5, evidence: d }));
  }
  const skillFiles = Object.entries(tree).filter(([rel, t]) => t != null && rel.endsWith('/SKILL.md'));
  if (skillFiles.length) {
    const weak = skillFiles.filter(([, t]) => { const fm = surface.frontmatter(t) || {}; return !fm.description || fm.description.length < 40 || !USAGE_CUE.test(fm.description); }).map(([r]) => r);
    checks.push(check('skills.discoverable', { pass: weak.length === 0, score: 1 - weak.length / skillFiles.length, evidence: weak.slice(0, 20) }));
  }
  const bom = Object.entries(tree).filter(([rel, t]) => t != null && /\.(md|json|js|cjs|py)$/.test(rel) && t.charCodeAt(0) === 0xfeff).map(([r]) => r);
  checks.push(check('encoding.noBom', { pass: bom.length === 0, score: bom.length ? 0.5 : 1, weight: 0.5, evidence: bom.slice(0, 20) }));
  const secrets = [];
  const safety = deps.safety || (() => { try { return require('../supply/script-safety'); } catch { return null; } })();
  let worst = 'pass';
  const flagged = [];
  for (const [rel, text] of Object.entries(tree)) {
    if (text == null) continue;
    try { require('../prompt-safety').assertNoSecrets(text); } catch { secrets.push(rel); }
    if (safety && /\.(js|cjs|mjs|py|ps1|sh|bat|md|json)$/.test(rel)) {
      const r = safety.scanText(text, { path: rel });
      if (r.verdict !== 'pass') flagged.push({ path: rel, verdict: r.verdict, rules: [...new Set(r.findings.map((f) => f.rule))] });
      if (r.verdict === 'block') worst = 'block'; else if (r.verdict === 'review' && worst === 'pass') worst = 'review';
    }
  }
  checks.push(check('safety.secrets', { pass: secrets.length === 0, score: secrets.length ? 0 : 1, critical: true, evidence: secrets }));
  if (safety) checks.push(check('safety.scripts', { pass: worst !== 'block', score: worst === 'block' ? 0 : worst === 'review' ? 0.6 : 1, critical: true, evidence: flagged.slice(0, 20) }));
  return { checks, fingerprint: surface.fingerprint(tree), extra: null };
}

/**
 * @param {{kind:'hub-source'|'harness-tree', label?:string, root?:string, tree?:object, base?:object, testSummary?:object, runTests?:boolean}} subject
 * @returns {Promise<{tier:'deterministic', subject, fingerprint, checks, score, passed, failed, criticalFailed, cached}>}
 */
async function evaluate(subject, deps = {}) {
  if (!subject || !['hub-source', 'harness-tree','debug-diagnostics'].includes(subject.kind)) throw new Error('Unsupported evaluation subject');
  const built = subject.kind === 'debug-diagnostics' ? await require('./debugging-regression').evaluate() :
    subject.kind === 'hub-source' ? await hubSourceChecks(subject, deps) : harnessTreeChecks(subject, deps);
  const key = store.keyOf('det', CHECKSET_VERSION, subject.kind, built.fingerprint);
  const cached = deps.noCache ? null : await store.cacheGet(key, deps);
  if (cached) return { ...cached, cached: true };
  const result = { tier: 'deterministic', checkset: CHECKSET_VERSION, subject: { kind: subject.kind, label: subject.label || null },
    fingerprint: built.fingerprint, checks: built.checks, ...summarize(built.checks), extra: built.extra };
  await store.cachePut(key, result, deps);
  await store.append({ tier: 'deterministic', subject: result.subject, fingerprint: result.fingerprint, score: result.score,
    checks: result.checks.map((c) => ({ id: c.id, pass: c.pass, score: c.score })) }, deps);
  return { ...result, cached: false };
}

module.exports = { evaluate, parseTestSummary, runOfflineTests, summarize, CHECKSET_VERSION };

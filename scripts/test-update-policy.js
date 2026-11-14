'use strict';
// 원본 갱신 정책(1.32.27, 사용자 결정 2026-10-26): 결정적 위험 요소, 종류별 결정, AI 1차 검토(작업자 순서·거절이면 다음),
// 적용·확인·되돌림, 승인 대기열(중복 없음·알림 신호·사람만 결정), uv 도구(Aider) 갱신의 계약 시험과 되돌림, 포크 적용 되돌림.
// 모델·네트워크·uv를 부르지 않는다(대역으로 바꿈).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-upstream-policy-'));
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); }
}

const policy = require('../src/core/supply/update-policy');
const tools = require('../src/core/supply/tool-updates');
const sync = require('../src/core/supply/upstream-sync');
const signals = require('../src/core/change-signals');

let n = 0;
const fresh = () => ({ dataDir: path.join(scratch, `d${n++}`), now: () => Date.parse('2026-10-26T12:00:00Z') });
const b64 = (s) => Buffer.from(s).toString('base64');
const proposal = (files, extra = {}) => ({ files, compatibility: [], localPath: path.join(scratch, 'outside'), ...extra });
const file = (p, o = {}) => ({ path: p, change: 'upstream-changed', merge: 'clean', safety: { verdict: 'pass', findings: [] }, contentBase64: b64('a\nb\n'), ...o });

(async () => {
  await check('risks: a clean small proposal outside the app has none', () => {
    assert.deepStrictEqual(policy.proposalRisks(proposal([file('skill/SKILL.md')]), { appRoot: path.join(scratch, 'app') }), []);
  });

  await check('risks: safety, merge, deletion, license, dependency, size, restart', () => {
    const many = Array.from({ length: 21 }, (_, i) => file(`f${i}.md`));
    const r = policy.proposalRisks(proposal([
      file('a.js', { safety: { verdict: 'review', findings: [] } }), file('b.js', { safety: { verdict: 'block', findings: [] } }),
      file('c.md', { merge: 'needs-review' }), file('d.md', { change: 'upstream-removed' }), file('LICENSE'), file('sub/package.json'), ...many,
    ], { compatibility: [{ check: 'npm-lifecycle', ok: true }, { check: 'json-parse', ok: false }], localPath: path.join(scratch, 'app', 'skills', 'x') }), { appRoot: path.join(scratch, 'app') });
    for (const k of ['safety-review', 'safety-block', 'merge-review', 'deletion', 'license-file', 'dependency-change', 'large-change', 'install-scripts', 'compatibility', 'needs-restart']) assert.ok(r.includes(k), k);
  });

  await check('decide: K1 auto, K2-K4 AI review, risky → approval, K5-K7 observe', () => {
    assert.strictEqual(policy.decide('K1', []), 'auto');
    for (const k of ['K2', 'K3', 'K4']) { assert.strictEqual(policy.decide(k, []), 'review'); assert.strictEqual(policy.decide(k, ['x']), 'approval'); }
    for (const k of ['K5', 'K6', 'K7']) assert.strictEqual(policy.decide(k, []), 'observe');
  });

  await check('AI review: quota refusal moves on; only the local worker sees our copy', async () => {
    const seen = [];
    const runReview = async (worker, task, text) => {
      seen.push({ worker, local: text.includes('우리 쪽 사본') });
      return worker === 'agy' ? { ok: false, reason: 'agy_quota_exhausted: limit' } : { ok: true, verdict: 'safe', reasons: ['플래그 그대로'] };
    };
    const r = await policy.aiReview({ title: 't', publicText: 'notes', localText: 'ours' }, { runReview });
    assert.strictEqual(r.verdict, 'safe'); assert.strictEqual(r.worker, 'local');
    assert.deepStrictEqual(r.skipped.map((s) => s.worker), ['agy']);
    assert.deepStrictEqual(seen, [{ worker: 'agy', local: false }, { worker: 'local', local: true }]);
  });

  await check('AI review: a non-availability failure stops as unclear (no silent fallback)', async () => {
    const r = await policy.aiReview({ title: 't', publicText: 'p' }, { runReview: async () => ({ ok: false, reason: 'schema_invalid' }) });
    assert.strictEqual(r.verdict, 'unclear'); assert.strictEqual(r.skipped.length, 1);
  });

  await check('handle: safe review → apply and check → applied, with a ledger row', async () => {
    const d = { ...fresh(), runReview: async () => ({ ok: true, verdict: 'safe', reasons: [] }) };
    let applied = 0;
    const r = await policy.handle({ source: 'tool', target: 'aider', kind: 'K4', from: '1', to: '2', title: 't', risks: [], publicText: 'p' },
      { apply: async () => { applied++; return { ok: 1 }; }, check: async () => true }, d);
    assert.strictEqual(r.decision, 'ai-applied'); assert.strictEqual(applied, 1);
    assert.match(fs.readFileSync(path.join(d.dataDir, 'upstream-sync', 'ledger.jsonl'), 'utf8'), /"outcome":"applied"/);
  });

  await check('handle: deterministic risk → approval without review, notification signal, no apply', async () => {
    const d = { ...fresh(), runReview: async () => { throw new Error('should not review'); } };
    const got = [];
    const off = signals.onChanged((w) => { if (w && w.kind === 'upstream-approval') got.push(w); });
    const r = await policy.handle({ source: 'fork', target: 'x', kind: 'K3', from: 'a', to: 'b', title: 'x a → b', risks: ['safety-review'] },
      { apply: async () => { throw new Error('should not apply'); } }, d);
    off();
    assert.strictEqual(r.decision, 'approval'); assert.strictEqual(got.length, 1); assert.deepStrictEqual(got[0].risks, ['safety-review']);
    // 같은 대상·버전은 다시 넣지 않는다(알림도 한 번).
    await policy.handle({ source: 'fork', target: 'x', kind: 'K3', from: 'a', to: 'b', title: 'x', risks: ['safety-review'] }, {}, d);
    assert.strictEqual((await policy.list(d)).filter((x) => x.state === 'pending').length, 1);
  });

  await check('handle: post-check failure rolls back and waits for a human', async () => {
    const d = { ...fresh(), runReview: async () => ({ ok: true, verdict: 'safe', reasons: [] }) };
    let rolled = 0;
    const r = await policy.handle({ source: 'tool', target: 'aider', kind: 'K4', from: '1', to: '2', risks: [] },
      { apply: async () => ({}), check: async () => false, rollback: async () => { rolled++; } }, d);
    assert.strictEqual(r.decision, 'approval'); assert.strictEqual(rolled, 1); assert.deepStrictEqual(r.approval.risks, ['post-check-failed']);
  });

  await check('handle: review "risk" is queued with the review attached', async () => {
    const d = { ...fresh(), runReview: async () => ({ ok: true, verdict: 'risk', reasons: ['--no-git 제거'] }) };
    const r = await policy.handle({ source: 'tool', target: 'aider', kind: 'K4', from: '1', to: '2', risks: [] }, { apply: async () => { throw new Error('no'); } }, d);
    assert.deepStrictEqual(r.approval.risks, ['ai-risk']); assert.deepStrictEqual(r.approval.review.reasons, ['--no-git 제거']);
  });

  await check('resolve: needs confirmed, runs the registered executor, records failures', async () => {
    const d = fresh();
    const row = await policy.enqueue({ source: 'test-src', target: 't', kind: 'K3', from: '1', to: '2', risks: ['x'] }, d);
    await assert.rejects(() => policy.resolve(row.id, { decision: 'approved' }, d), /confirmed/);
    policy.registerExecutor('test-src', async () => ({ done: true }));
    assert.strictEqual((await policy.resolve(row.id, { decision: 'approved', confirmed: true }, d)).state, 'applied');
    const row2 = await policy.enqueue({ source: 'test-src', target: 't', kind: 'K3', from: '2', to: '3', risks: ['x'] }, d);
    policy.registerExecutor('test-src', async () => { throw new Error('boom'); });
    const out = await policy.resolve(row2.id, { decision: 'approved', confirmed: true }, d);
    assert.strictEqual(out.state, 'failed'); assert.match(out.error, /boom/);
  });

  await check('rejected: the same version is neither reviewed, applied nor queued again; a newer version is', async () => {
    const d = { ...fresh(), runReview: async () => ({ ok: true, verdict: 'safe', reasons: [] }) };
    const item = { source: 'tool', target: 'aider', kind: 'K4', from: '1', to: '2', risks: [] };
    const row = await policy.enqueue({ ...item, risks: ['x'] }, d);
    await policy.resolve(row.id, { decision: 'rejected', confirmed: true }, d);
    let applied = 0;
    const r = await policy.handle(item, { apply: async () => { applied++; } }, d);
    assert.strictEqual(r.decision, 'rejected'); assert.strictEqual(applied, 0);
    assert.strictEqual((await policy.list(d)).filter((x) => x.state === 'pending').length, 0);
    assert.strictEqual((await policy.handle({ ...item, to: '3' }, { apply: async () => { applied++; } }, d)).decision, 'ai-applied');
    assert.strictEqual(applied, 1);
  });

  await check('resolve: an item queued while the executor runs is kept', async () => {
    const d = fresh();
    const a = await policy.enqueue({ source: 'test-race', target: 'a', kind: 'K3', from: '1', to: '2', risks: ['x'] }, d);
    policy.registerExecutor('test-race', async () => { await policy.enqueue({ source: 'test-race', target: 'b', kind: 'K3', from: '1', to: '2', risks: ['x'] }, d); return { ok: true }; });
    assert.strictEqual((await policy.resolve(a.id, { decision: 'approved', confirmed: true }, d)).state, 'applied');
    const items = await policy.list(d);
    assert.strictEqual(items.find((x) => x.id === a.id).state, 'applied');
    assert.ok(items.some((x) => x.target === 'b' && x.state === 'pending'));
  });

  await check('versions: compare, major (0.x minor is not major), release notes slice', () => {
    assert.ok(tools.compare('0.87.0', '0.86.2') > 0); assert.strictEqual(tools.compare('1.2.0', '1.2'), 0);
    assert.strictEqual(tools.major('0.86.2', '0.87.0'), false); assert.strictEqual(tools.major('0.99.0', '1.0.0'), true);
    const notes = '# Release history\n\n### Aider v0.88.0\n- c\n\n### Aider v0.87.0\n- b\n\n### Aider v0.86.2\n- a\n';
    const s = tools.notesBetween(notes, '0.86.2', '0.87.0');
    assert.match(s, /v0\.87\.0/); assert.doesNotMatch(s, /v0\.88\.0|v0\.86\.2/);
  });

  await check('Aider: every flag commandPlan passes is in CLI_FLAGS (the contract list)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'aider-studio.js'), 'utf8');
    const used = [...new Set([...src.matchAll(/'(--[a-z][a-z0-9-]+)'/g)].map((m) => m[1]))].filter((f) => !['--version', '--show-toplevel', '--format'].includes(f));
    const listed = require('../src/core/aider-studio').CLI_FLAGS;
    assert.deepStrictEqual(used.filter((f) => !listed.includes(f)), []);
  });

  // uv·PyPI·Aider 대역: 설치 버전은 install 호출로 바뀐다. contractOk가 false면 새 버전의 --help에서 플래그 하나가 빠진다.
  const toolDeps = (o = {}) => {
    const st = { version: o.installed ?? '0.86.2', installs: [] };
    const tool = { id: 'aider', kind: 'K4', package: 'aider-chat', repository: 'https://example.invalid/aider', notes: 'https://example.invalid/HISTORY.md', bin: () => 'aider', flags: () => ['--no-git', '--yes-always'] };
    return { st, deps: { ...fresh(), force: true, tools: [tool], uvBin: () => 'uv',
      fetch: async (url) => ({ ok: true, json: async () => ({ info: { version: o.latest ?? '0.87.0' }, releases: { [o.latest ?? '0.87.0']: [{ packagetype: o.wheel === false ? 'sdist' : 'bdist_wheel', yanked: false }] } }),
        text: async () => '### Aider v0.87.0\n- faster\n' }),
      run: async (file, args) => {
        if (file === 'uv' && args[1] === 'list') return { ok: true, out: st.version ? `aider-chat v${st.version}\n- aider\n` : '' };
        if (file === 'uv' && args[1] === 'install') { st.installs.push(args[3]); st.version = args[3].split('==')[1]; return { ok: true, out: '' }; }
        if (args[0] === '--version') return { ok: true, out: `aider ${st.version}` };
        if (args[0] === '--help') return { ok: true, out: o.contractOk === false && st.version !== '0.86.2' ? '  --yes-always\n' : '  --git, --no-git\n  --yes-always\n' };
        return { ok: false, out: '' };
      },
      runReview: async () => ({ ok: true, verdict: o.verdict || 'safe', reasons: [] }) } };
  };

  await check('tools: newer wheel + safe review + contract ok → installed exactly that version', async () => {
    const { st, deps } = toolDeps();
    const [r] = await tools.syncTools(deps);
    assert.strictEqual(r.outcome, 'ai-applied'); assert.deepStrictEqual(st.installs, ['aider-chat==0.87.0']);
  });

  await check('tools: contract fails after install → rolled back to the old version, waits for a human', async () => {
    const { st, deps } = toolDeps({ contractOk: false });
    const [r] = await tools.syncTools(deps);
    assert.strictEqual(r.outcome, 'approval'); assert.deepStrictEqual(st.installs, ['aider-chat==0.87.0', 'aider-chat==0.86.2']); assert.strictEqual(st.version, '0.86.2');
  });

  await check('tools: source-only release or major bump → approval before any install', async () => {
    const a = toolDeps({ wheel: false });
    assert.strictEqual((await tools.syncTools(a.deps))[0].outcome, 'approval'); assert.deepStrictEqual(a.st.installs, []);
    const b = toolDeps({ installed: '0.99.0', latest: '1.0.0' });
    assert.strictEqual((await tools.syncTools(b.deps))[0].outcome, 'approval'); assert.deepStrictEqual(b.st.installs, []);
  });

  await check('tools: up to date and not installed are recorded without action', async () => {
    assert.strictEqual((await tools.syncTools(toolDeps({ installed: '0.87.0' }).deps))[0].outcome, 'current');
    assert.strictEqual((await tools.syncTools(toolDeps({ installed: '' }).deps))[0].outcome, 'not-installed');
  });

  await check('tools: a human-approved row installs, checks, and rolls back on failure', async () => {
    const { st, deps } = toolDeps({ contractOk: false, wheel: false });
    const [r] = await tools.syncTools(deps);
    assert.strictEqual(r.outcome, 'approval');
    const row = (await policy.list(deps)).find((x) => x.state === 'pending' && x.target === 'aider');
    const out = await policy.resolve(row.id, { decision: 'approved', confirmed: true }, deps);
    assert.strictEqual(out.state, 'failed'); assert.strictEqual(st.version, '0.86.2');
  });

  await check('fork restore: changed files come back from backup, new files are removed, revision resets', async () => {
    const d = fresh();
    const local = path.join(scratch, 'fork-local'), backup = path.join(scratch, 'fork-backup');
    fs.mkdirSync(local, { recursive: true }); fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(local, 'a.md'), 'new a'); fs.writeFileSync(path.join(local, 'b.md'), 'new b'); fs.writeFileSync(path.join(backup, 'a.md'), 'old a');
    const rev = (c) => c.repeat(40);
    await sync.saveRegistry({ schemaVersion: 1, forks: [{ id: 'x', kind: 'other', upstream: { url: 'https://example.invalid/x.git', ref: 'main' }, localPath: local, adoptedRevision: rev('b') }] }, d);
    await sync.restore('x', { applied: ['a.md', 'b.md'], created: ['b.md'], backup, fromRevision: rev('a') }, d);
    assert.strictEqual(fs.readFileSync(path.join(local, 'a.md'), 'utf8'), 'old a');
    assert.ok(!fs.existsSync(path.join(local, 'b.md')));
    assert.strictEqual((await sync.loadRegistry(d)).forks[0].adoptedRevision, rev('a'));
  });

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`원본 갱신 정책(G2): 통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exitCode = 1;
})();

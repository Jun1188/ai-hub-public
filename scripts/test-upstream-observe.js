'use strict';
// 공유 저장소 원본 레지스트리 관찰(관찰 전용). 실제 git·네트워크를 쓰지 않는다(execFile 주입).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-upobs-'));
const repo = path.join(scratch, 'repo');
const A = '1'.repeat(40), B = '2'.repeat(40);
fs.mkdirSync(path.join(repo, 'evolve', 'research'), { recursive: true });
fs.writeFileSync(path.join(repo, 'evolve', 'research', 'upstreams.json'), '﻿' + JSON.stringify({ schemaVersion: 1, sources: [
  { id: 'ponytail', repository: 'https://github.com/example/ponytail', branch: 'main', lastReviewedRevision: A, adoptionState: 'adapted-skill', reviewPaths: ['skills/ponytail/SKILL.md'], localTargets: ['skills/development/ponytail/SKILL.md'], license: 'MIT' },
  { id: 'current', repository: 'https://github.com/example/current', branch: 'main', lastReviewedRevision: B },
  { id: 'fresh', repository: 'https://github.com/example/fresh', branch: 'main', adoptedRevision: null },
  { id: 'offline', repository: 'https://github.com/example/offline', branch: 'main', lastReviewedRevision: A },
] }));

let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); } }

const calls = [];
let now = Date.parse('2026-10-23T00:00:00Z');
const deps = { dataDir: path.join(scratch, 'data'), repoRoot: repo, now: () => now, execFile: async (_file, args) => {
  calls.push(args.join(' '));
  const out = (text, code = 0, stderr = '') => ({ stdout: Buffer.from(text), stderr: Buffer.from(stderr), code });
  if (args.some((a) => /offline/.test(a))) return out('', 1, 'unable to access');
  return out(B + '\trefs/heads/main\n');
} };
const { observeShared } = require('../src/core/supply/upstream-observe');

(async () => {
  const r = await observeShared(deps);
  const by = Object.fromEntries(r.results.map((x) => [x.id, x]));
  await check('reads the shared registry (BOM tolerated) and marks every row observe-only', () => {
    assert(r.ok && r.results.length === 4 && r.results.every((x) => x.observeOnly));
  });
  await check('behind when upstream moved past the last reviewed revision, with files to review', () => {
    assert.strictEqual(by.ponytail.behind, true); assert.strictEqual(by.ponytail.upstreamRevision, B);
    assert.deepStrictEqual(by.ponytail.reviewPaths, ['skills/ponytail/SKILL.md']);
    assert.strictEqual(by.current.behind, false);
  });
  await check('never reviewed is flagged; an offline upstream is an error, not "behind"', () => {
    assert.strictEqual(by.fresh.neverReviewed, true);
    assert(by.offline.error && by.offline.behind === false);
  });
  await check('behind rows sort first', () => assert.strictEqual(r.results[0].behind, true));
  await check('within a week the result is reused without network', async () => {
    const before = calls.length;
    now += 3 * 86400000;
    await observeShared(deps);
    assert.strictEqual(calls.length, before);
    now += 5 * 86400000;
    await observeShared(deps);
    assert.strictEqual(calls.length, before + 4);
  });
  await check('missing repository or registry is reported, not thrown', async () => {
    assert.strictEqual((await observeShared({ ...deps, repoRoot: null })).ok, false);
    assert.strictEqual((await observeShared({ ...deps, repoRoot: scratch })).ok, false);
  });

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`공유 원본 관찰: 통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exitCode = 1;
})();

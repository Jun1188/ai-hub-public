'use strict';
// 하네스 로그 수집기(harness-skill-log)와 하네스별 Hub 사용(harness-usage): 가짜 홈 폴더의 Claude Code·Codex 로그만 읽는다.
// 실제 ~/.claude·~/.codex는 건드리지 않는다(deps.home 주입).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-hsl-'));
let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); } }
const log = require('../src/core/harness-skill-log');
const usage = require('../src/core/harness-usage');
const T0 = Date.parse('2026-10-22T09:00:00Z');

const home = path.join(scratch, 'home'), dataDir = path.join(scratch, 'data');
const claudeFile = path.join(home, '.claude', 'projects', 'C--work', 'session-a.jsonl');
const codexFile = path.join(home, '.codex', 'sessions', '2026', '10', '22', 'rollout-x.jsonl');
const deps = { home, dataDir, now: () => T0 + 3600000 };
const tool = (name, input, at = T0) => JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { content: [{ type: 'tool_use', name, input }] } });
const exec = (input, at = T0) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input } });
const write = (file, lines) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, lines.map((l) => l + '\n').join('')); };

(async () => {
  await check('reads count; existence checks, copies, writes and listings do not', async () => {
    assert.deepStrictEqual(log.readsInCommand('Get-Content -Raw skills/development/ponytail/SKILL.md; git status'), ['ponytail']);
    assert.deepStrictEqual(log.readsInCommand('text(await tools.exec_command({cmd:"Get-Content -LiteralPath C:\\\\Users\\\\x\\\\.codex\\\\skills\\\\custom-harness\\\\SKILL.md -Raw"}))'), ['custom-harness']);
    assert.deepStrictEqual(log.readsInCommand('Test-Path skills/a/SKILL.md; Copy-Item x/b/SKILL.md y; Set-Content c/SKILL.md "t"'), []);
    assert.deepStrictEqual(log.readsInCommand('Get-ChildItem -Recurse -Filter SKILL.md | Select-Object FullName'), []);
    assert.deepStrictEqual(log.readsInCommand("rg -n '^##' skills/web-design/frontend-design/SKILL.md"), ['frontend-design']);
  });
  await check('Claude Code: Skill tool, Read of a SKILL.md, shell read; tool results and user text are not uses', async () => {
    assert.deepStrictEqual(log.claudeUses(JSON.parse(tool('Skill', { skill: 'ai-hub-project' }))), ['ai-hub-project']);
    assert.deepStrictEqual(log.claudeUses(JSON.parse(tool('Read', { file_path: 'C:\\repo\\skills\\writing\\log\\SKILL.md' }))), ['log']);
    assert.deepStrictEqual(log.claudeUses(JSON.parse(tool('Bash', { command: 'cat skills/review/discernment-nudge/SKILL.md | head -40' }))), ['discernment-nudge']);
    assert.deepStrictEqual(log.claudeUses({ type: 'user', message: { content: [{ type: 'tool_result', content: 'see skills/x/SKILL.md' }] } }), []);
  });
  await check('Codex: exec code and completed-command read analysis', async () => {
    assert.deepStrictEqual(log.codexUses(JSON.parse(exec('Get-Content skills/a/ponytail/SKILL.md'))), ['ponytail']);
    assert.deepStrictEqual(log.codexUses({ payload: { type: 'item_completed', item: { type: 'CommandExecution', command: 'x', parsed_cmd: [{ type: 'read', path: 'C:\\s\\self-improve\\SKILL.md' }] } } }), ['self-improve']);
  });

  write(claudeFile, [tool('Skill', { skill: 'ai-hub-project' }), tool('Read', { file_path: 'C:\\r\\skills\\x\\ponytail\\SKILL.md' }), tool('Skill', { skill: 'ai-hub-project' }, T0 + 60000),
    JSON.stringify({ type: 'user', message: { content: 'private conversation text' } })]);
  write(codexFile, [exec('Get-Content skills/a/ponytail/SKILL.md'), exec('Get-Content skills/a/ponytail/SKILL.md; Get-Content skills/b/log/SKILL.md')]);

  await check('first run: one use per skill per session, with the harness and the event time', async () => {
    const r = await log.collect(deps);
    assert.strictEqual(r.added, 4);
    assert.deepStrictEqual(r.byHarness, { 'claude-code': 2, codex: 2 });
    const u = JSON.parse(fs.readFileSync(path.join(dataDir, 'skill-usage.json'), 'utf8'));
    assert.strictEqual(u['skill:ponytail'], 2);
    assert.deepStrictEqual(u.$byHarness['skill:ponytail'], { 'claude-code': 1, codex: 1 });
    const m = JSON.parse(fs.readFileSync(path.join(dataDir, 'knowledge-metrics.json'), 'utf8'));
    const day = m.days['2026-10-22'];
    assert.strictEqual(day.uses, 4); assert.deepStrictEqual(day.sources, { log: 4 }); assert.deepStrictEqual(day.byHarness, { 'claude-code': 2, codex: 2 });
    assert.strictEqual(day.found, 0); assert.strictEqual(m.lastUseAt, 0); // 검색을 거치지 않은 사용은 miss·탐색 경계를 바꾸지 않는다
    assert.deepStrictEqual(m.lastUse['skill:ai-hub-project'], { at: T0, harness: 'claude-code' });
  });
  await check('state keeps no paths or conversation text, only hashes, offsets and skill ids', async () => {
    const text = fs.readFileSync(path.join(dataDir, 'harness-skill-log.json'), 'utf8');
    for (const bad of ['session-a', 'rollout-x', 'C--work', 'private conversation', '.claude', 'Get-Content']) assert.ok(!text.includes(bad), bad);
    assert.ok(text.includes('"ponytail"'));
  });
  await check('second run reads nothing new and adds nothing', async () => {
    const r = await log.collect(deps);
    assert.strictEqual(r.added, 0); assert.strictEqual(r.bytes, 0);
  });
  await check('appended lines: a new skill in the same session counts, a repeated one does not; a partial line waits', async () => {
    write(claudeFile, [tool('Skill', { skill: 'ponytail' }), tool('Skill', { skill: 'self-improve' })]);
    fs.appendFileSync(codexFile, exec('Get-Content skills/c/custom-harness/SKILL.md').slice(0, 40)); // 아직 쓰는 중인 줄
    let r = await log.collect(deps);
    assert.deepStrictEqual(r.byHarness, { 'claude-code': 1 });
    fs.appendFileSync(codexFile, exec('Get-Content skills/c/custom-harness/SKILL.md').slice(40) + '\n');
    r = await log.collect(deps);
    assert.deepStrictEqual(r.byHarness, { codex: 1 });
    const s = await log.status(deps);
    assert.deepStrictEqual(s.totals, { 'claude-code': 3, codex: 3 });
  });
  await check('a new session file is a new use of the same skill', async () => {
    write(path.join(home, '.claude', 'projects', 'C--work', 'session-b.jsonl'), [tool('Skill', { skill: 'ai-hub-project' }, T0 + 120000)]);
    const r = await log.collect(deps);
    assert.strictEqual(r.added, 1);
    const snap = await require('../src/core/knowledge-metrics').snapshot({ days: 7 }, deps);
    assert.deepStrictEqual(snap.harness, { 'claude-code': 4, codex: 3 });
    assert.deepStrictEqual(snap.skills['skill:ai-hub-project'].byHarness, { 'claude-code': 2 });
    assert.strictEqual(snap.lifetime['skill:ai-hub-project'], 2); assert.ok(!('$byHarness' in snap.lifetime));
    assert.deepStrictEqual(snap.lifetimeByHarness['skill:ai-hub-project'], { 'claude-code': 2 });
    assert.strictEqual(snap.collector.sessions, 3);
  });
  await check('skill_use records the calling harness next to log-collected uses', async () => {
    await require('../src/core/cache/skill-index').recordUse('skill:ponytail', { dataDir, harness: 'antigravity', now: deps.now });
    const u = JSON.parse(fs.readFileSync(path.join(dataDir, 'skill-usage.json'), 'utf8'));
    assert.strictEqual(u['skill:ponytail'], 3); assert.strictEqual(u.$byHarness['skill:ponytail'].antigravity, 1); // 로그 2(세션별) + skill_use 1
    const m = JSON.parse(fs.readFileSync(path.join(dataDir, 'knowledge-metrics.json'), 'utf8'));
    assert.strictEqual(Object.values(m.days).reduce((s, d) => s + ((d.sources || {}).mcp || 0), 0), 1);
  });
  await check('concurrent writers in one process do not lose counts', async () => {
    const idx = require('../src/core/cache/skill-index');
    await Promise.all([idx.addUses([{ id: 'skill:z', harness: 'codex' }], { dataDir }), idx.recordUse('skill:z', { dataDir, harness: 'codex' }), idx.addUses([{ id: 'skill:z', harness: 'claude-code' }], { dataDir })]);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'skill-usage.json'), 'utf8'))['skill:z'], 3);
  });
  await check('a corrupt state file stops the run instead of recounting every log', async () => {
    const d = { ...deps, dataDir: path.join(scratch, 'corrupt') };
    fs.mkdirSync(d.dataDir, { recursive: true }); fs.writeFileSync(path.join(d.dataDir, 'harness-skill-log.json'), '{');
    await assert.rejects(log.collect(d));
  });

  await check('MCP client names map to harness ids', async () => {
    assert.strictEqual(usage.harnessOfClient('claude-code'), 'claude-code');
    assert.strictEqual(usage.harnessOfClient('codex-mcp-client'), 'codex');
    assert.strictEqual(usage.harnessOfClient('ua:node'), 'unknown');
    assert.strictEqual(usage.harnessOfClient(undefined), 'unknown');
    assert.strictEqual(usage.harnessOfClient('Visual Studio Code'), 'vscode');
    assert.strictEqual(usage.harnessOfCaller({ via: 'mcp', client: 'gemini-cli-mcp-client' }), 'gemini-cli');
    assert.strictEqual(usage.harnessOfCaller({ via: 'gui' }), 'ai-hub');
  });
  await check('Hub calls per harness from tool-usage.local, old files without clients as unknown', async () => {
    const dir = path.join(dataDir, 'tool-usage.local');
    fs.mkdirSync(path.join(dir, '2026-10-22'), { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-10-22', '1-2.json'), JSON.stringify({ schema: 'tool-usage/2', tools: {
      skill_find: { calls: 3, errors: 1, bytes: 30, clients: { 'claude-code': 2, 'codex-mcp-client': 1 } }, offload_run: { calls: 2, errors: 0, bytes: 5, clients: { 'codex-mcp-client': 2 } } } }));
    fs.writeFileSync(path.join(dir, '2026-10-21.json'), JSON.stringify({ schema: 1, tools: { hub_status: { calls: 4, errors: 0, bytes: 1 } } }));
    fs.writeFileSync(path.join(dir, '2026-01-01.json'), JSON.stringify({ tools: { hub_status: { calls: 99 } } })); // 기간 밖
    const r = await usage.hubCalls({ days: 30 }, { dataDir, now: deps.now });
    assert.strictEqual(r.total, 9);
    assert.strictEqual(r.harnesses.codex.calls, 3); assert.strictEqual(r.harnesses['claude-code'].calls, 2); assert.strictEqual(r.harnesses.unknown.calls, 4);
    assert.deepStrictEqual(r.harnesses.codex.top[0], { tool: 'offload_run', calls: 2 });
  });
  await check('route ledger and bus stats are split by harness', async () => {
    const caller = require('../src/core/caller');
    const routes = require('../src/core/toolroute/route-table');
    await caller.run({ via: 'mcp', client: 'codex-mcp-client' }, () => routes.record('r1', { ok: true }, { dataDir }));
    await caller.run({ via: 'gui' }, () => routes.record('r1', { ok: false }, { dataDir }));
    const ledger = JSON.parse(fs.readFileSync(path.join(dataDir, 'toolroutes', 'ledger.json'), 'utf8'));
    assert.deepStrictEqual(ledger.routes.r1.by, { codex: 1, 'ai-hub': 1 });
    const bus = require('../src/core/harness-bridge/harness-bus');
    await bus.send({ from: 'codex', to: 'claude-code', kind: 'notify', topic: 't', body: 'hello' }, { dataDir });
    const s = await bus.stats({ dataDir });
    assert.strictEqual(s.byHarness.codex.sent, 1); assert.strictEqual(s.byHarness['claude-code'].received, 1);
  });

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`harness skill log: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

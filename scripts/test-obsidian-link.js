'use strict';
// Obsidian 연결: 미설치 시 대체 경로, 설치 감지 후 자동 색인·등록, 실행 중이면 등록 보류, 사용자 수정 노트 보존,
// 읽지 못한 설정을 덮어쓰지 않음. 실제 Obsidian·사용자 설정은 건드리지 않는다(경로 주입).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-obs-'));
let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); } }
const ob = require('../src/core/obsidian/obsidian-link');

const graph = { load: async (key) => ({ key, nodes: [{ id: 'n1', kind: 'skill', label: 'ponytail' }, { id: 'n2', kind: 'file', label: 'SKILL.md' }], edges: [{ source: 'n1', target: 'n2', relation: 'contains' }] }) };
let running = false;
const deps = { dataDir: path.join(scratch, 'data'), exe: path.join(scratch, 'Obsidian', 'Obsidian.exe'), obsidianConfig: path.join(scratch, 'obsidian', 'obsidian.json'),
  isRunning: async () => running, graph };

(async () => {
  await check('not installed: fallback vault, install hint, no registration', async () => {
    const r = await ob.autoIndex({ keys: ['skills:repository'] }, deps);
    assert.strictEqual(r.installed, false); assert.strictEqual(r.registration, 'not-installed');
    assert(r.sync.written >= 2);
    assert(fs.existsSync(path.join(deps.dataDir, 'knowledge-graph', 'obsidian-vault', 'Hub Index.md')));
    assert((await ob.detect(deps)).installHint);
  });
  fs.mkdirSync(path.dirname(deps.exe), { recursive: true }); fs.writeFileSync(deps.exe, '');
  fs.mkdirSync(path.dirname(deps.obsidianConfig), { recursive: true });
  fs.writeFileSync(deps.obsidianConfig, JSON.stringify({ vaults: { abc: { path: path.join(scratch, 'mine'), ts: 1 } } }));
  await check('installed but running: registration deferred', async () => {
    running = true;
    const r = await ob.autoIndex({ keys: ['skills:repository'] }, deps);
    assert.strictEqual(r.newlyInstalled, true); assert.strictEqual(r.registration, 'obsidian-running');
  });
  await check('installed and closed: our vault added, existing vaults kept, config backed up', async () => {
    running = false;
    const r = await ob.register(deps);
    assert.strictEqual(r.reason, 'added');
    const j = JSON.parse(fs.readFileSync(deps.obsidianConfig, 'utf8'));
    assert.strictEqual(Object.keys(j.vaults).length, 2); assert(j.vaults.abc);
    assert(fs.readdirSync(path.dirname(deps.obsidianConfig)).some((n) => n.includes('hub-backup')));
    assert.strictEqual((await ob.register(deps)).reason, 'already');
  });
  await check('user-edited notes are preserved on re-index', async () => {
    const note = path.join(deps.dataDir, 'knowledge-graph', 'obsidian-vault', 'Hub Index.md');
    fs.writeFileSync(note, '# 내가 고친 인덱스\n');
    const s = await ob.syncFiles({ 'Hub Index.md': '# 새로 생성\n', 'Graph/x.md': 'x' }, deps);
    assert.deepStrictEqual(s.keptUserEdits, ['Hub Index.md']);
    assert.strictEqual(fs.readFileSync(note, 'utf8'), '# 내가 고친 인덱스\n');
  });
  await check('shared source ids map to one readable note and retain typed relationships', async () => {
    const files = await ob.buildFiles(['skills:repository', 'repository:documents'], deps);
    const notes = Object.keys(files).filter(n => n.startsWith('Nodes/'));
    assert.strictEqual(notes.length, 2);
    assert(notes.some(n => n.includes('ponytail--n1')));
    assert(Object.values(files).some(t => t.includes('hub_edges:') && t.includes('"relation":"contains"')));
  });
  await check('unchanged obsolete graph notes are archived while edited notes remain', async () => {
    await ob.syncFiles({ 'Graph/old.md': 'old', 'Graph/edited.md': 'original' }, deps);
    const vault = path.join(deps.dataDir, 'knowledge-graph', 'obsidian-vault');
    fs.writeFileSync(path.join(vault, 'Graph/edited.md'), 'my edit');
    const r = await ob.syncFiles({ 'Nodes/new.md': 'new' }, deps);
    assert.strictEqual(r.archived, 1);
    assert.strictEqual(fs.readFileSync(path.join(r.archive, 'Graph/old.md'), 'utf8'), 'old');
    assert.strictEqual(fs.readFileSync(path.join(vault, 'Graph/edited.md'), 'utf8'), 'my edit');
  });
  await check('unreadable Obsidian config is never overwritten', async () => {
    const d2 = { ...deps, dataDir: path.join(scratch, 'data2'), obsidianConfig: path.join(scratch, 'broken.json') };
    fs.writeFileSync(d2.obsidianConfig, '{broken');
    const r = await ob.register(d2);
    assert.strictEqual(r.reason, 'config-unreadable');
    assert.strictEqual(fs.readFileSync(d2.obsidianConfig, 'utf8'), '{broken');
  });

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`Obsidian 연결: 통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exitCode = 1;
})();

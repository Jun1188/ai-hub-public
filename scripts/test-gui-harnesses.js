#!/usr/bin/env node
// GUI 하네스(Claude 데스크톱 채팅 앱·Cursor·VS Code) MCP 등록과 버스 참여 — 임시 HOME/APPDATA로 격리해 실제 설정을 건드리지 않는다.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gui-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
for (const m of ['paths', 'config', 'registrar']) delete require.cache[require.resolve(path.join(appRoot, 'src', 'core', `${m}.js`))];

const write = (p, obj) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); };
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const desktop = path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json');
const cursor = path.join(home, '.cursor', 'mcp.json');
const vscode = path.join(process.env.APPDATA, 'Code', 'User', 'mcp.json');
write(desktop, { globalShortcut: 'Ctrl+Space', mcpServers: {} });
write(cursor, { mcpServers: { other: { command: 'x' } } });
write(vscode, { servers: { other: { type: 'stdio', command: 'y' } }, inputs: [{ id: 'k' }] });
// 설치 흔적: Cursor·VS Code는 실행 파일, Claude 데스크톱은 설정 파일. VS Code는 버전 폴더 아래에 앱이 있다.
const programs = path.join(process.env.LOCALAPPDATA, 'Programs');
const touch = (p, text = '') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
touch(path.join(programs, 'cursor', 'Cursor.exe'));
touch(path.join(programs, 'Microsoft VS Code', 'Code.exe'));
touch(path.join(programs, 'Microsoft VS Code', '04c0d99f4f', 'resources', 'app', 'package.json'), JSON.stringify({ version: '1.106.2' }));

let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); } }

const registrar = require(path.join(appRoot, 'src', 'core', 'registrar.js'));
const NAME = registrar.SERVER_NAME;

(async () => {
  await check('status: installed GUI apps listed as MCP-only targets, Claude Desktop stdio-only', () => {
    const st = registrar.status();
    const byId = Object.fromEntries(st.map((t) => [t.id, t]));
    assert(byId['claude-desktop'] && byId.cursor && byId.vscode);
    assert.strictEqual(byId['claude-desktop'].stdioOnly, true);
    assert(['claude-desktop', 'cursor', 'vscode'].every((id) => byId[id].mode === 'absent' && byId[id].mcpOnly));
  });
  await check('claude desktop: an http request is registered as stdio (command/args, no type), other keys kept', () => {
    const r = registrar.register('claude-desktop', 'http');
    assert.strictEqual(r.mode, 'stdio'); assert(/only local/.test(r.note));
    const j = read(desktop);
    assert.strictEqual(j.globalShortcut, 'Ctrl+Space');
    assert(j.mcpServers[NAME].command && Array.isArray(j.mcpServers[NAME].args) && !('type' in j.mcpServers[NAME]));
  });
  await check('cursor: http entry is url (+headers), no type; existing server kept', () => {
    registrar.register('cursor', 'http');
    const j = read(cursor);
    assert(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(j.mcpServers[NAME].url) && !('type' in j.mcpServers[NAME]));
    assert.deepStrictEqual(j.mcpServers.other, { command: 'x' });
  });
  await check('vscode: entry goes under "servers" with type http; inputs kept, no mcpServers key created', () => {
    registrar.register('vscode', 'http');
    const j = read(vscode);
    assert.strictEqual(j.servers[NAME].type, 'http'); assert(j.servers.other && j.inputs.length === 1 && !('mcpServers' in j));
  });
  await check('status reflects modes; HTTP migration never plans the stdio-only app', () => {
    const st = Object.fromEntries(registrar.status().map((t) => [t.id, t.mode]));
    assert.deepStrictEqual([st['claude-desktop'], st.cursor, st.vscode], ['stdio', 'http', 'http']);
    assert(!registrar.migrateToHttp({ dryRun: true }).planned.some((p) => p.target === 'claude-desktop'));
  });
  await check('unregister vscode removes only our entry from "servers"', () => {
    registrar.unregister('vscode');
    const j = read(vscode);
    assert(!j.servers[NAME] && j.servers.other);
  });
  await check('an uninstalled app whose config folder was left behind is not offered', () => {
    fs.rmSync(path.join(programs, 'cursor'), { recursive: true, force: true });
    assert(fs.existsSync(cursor) && !registrar.status().some((t) => t.id === 'cursor'));
  });

  const registry = require(path.join(appRoot, 'src', 'core', 'harness-bridge', 'harness-registry.js'));
  const bus = require(path.join(appRoot, 'src', 'core', 'harness-bridge', 'harness-bus.js'));
  const deps = { dataDir: path.join(home, 'data'), appRoot, sharedRepo: { repoRoot: () => null } };
  await check('registry: GUI apps reported as installed, MCP-only, never dispatchable', async () => {
    const r = await registry.probe('vscode', { ...deps, apps: { vscode: { installed: true, version: '1.105.0' } }, registrar: { status: () => [{ id: 'vscode', registered: true, mode: 'http' }] } });
    assert.deepStrictEqual([r.installed, r.gui, r.version, r.mcp, r.dispatch], [true, true, '1.105.0', 'http', false]);
    const none = await registry.probe('cursor', deps); // 위에서 지운 Cursor — 실제 감지 경로
    assert.deepStrictEqual([none.installed, none.mcp], [false, null]);
    const real = await registry.probe('vscode', deps); // 버전 폴더 아래 package.json에서 버전을 읽는다
    assert.deepStrictEqual([real.installed, real.version], [true, '1.106.2']);
  });
  await check('bus: GUI apps can send and receive through their inbox; dispatch to them is refused', async () => {
    const m = await bus.send({ from: 'cursor', to: 'claude-desktop', topic: 'hello', body: 'from cursor' }, deps);
    assert.strictEqual((await bus.inbox('claude-desktop', {}, deps))[0].id, m.id);
    await assert.rejects(bus.dispatch(m.id, {}, deps), (e) => e.code === 'bus_unsupported');
  });

  fs.rmSync(home, { recursive: true, force: true });
  console.log(`GUI 하네스 MCP 등록·버스: 통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exitCode = 1;
})();

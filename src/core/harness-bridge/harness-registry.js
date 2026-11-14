// 외부 하네스(Claude Code·Codex·Antigravity·Gemini CLI, GUI 앱 Claude 데스크톱·Cursor·VS Code)와 Hub 자신의 목록, 설치 감지, 호환성 탐침.
// 호환성 = 이 Hub가 기대는 계약(헤드리스 플래그·MCP 등록)이 지금 설치된 버전에 실제로 있는가.
// 버전이 바뀌면 다시 재고 빠진 플래그를 "drift"로 알린다 — 업데이트 뒤에도 연결이 조용히 깨지지 않게.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PROBE_TIMEOUT_MS = 15000;

function onPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const ext of process.platform === 'win32' ? ['.exe', '.cmd'] : ['']) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* 다음 */ }
    }
  }
  return '';
}

/** Claude Code CLI는 데스크톱 앱이 %APPDATA%\Claude\claude-code\<버전>\<해시>\claude.exe로 관리한다. */
function claudeBin() {
  const env = process.env.AIHUB_CLAUDE_BIN;
  if (env && fs.existsSync(env)) return env;
  const found = onPath('claude');
  if (found && found.endsWith('.exe')) return found;
  const root = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code');
  let versions = [];
  try { versions = fs.readdirSync(root).filter((v) => /^\d+\.\d+\.\d+$/.test(v)); } catch { return found; }
  versions.sort((a, b) => b.split('.').map(Number).reduce((s, x, i) => s || x - a.split('.').map(Number)[i], 0));
  for (const v of versions) {
    for (const h of fs.readdirSync(path.join(root, v)).slice(0, 8)) {
      const p = path.join(root, v, h, 'claude.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return found;
}

/**
 * GUI 앱: 설치 여부는 MCP 등록기와 같은 목록(paths.detectMcpOnlyTargets — 실행 파일·설정 파일 기준)을 쓴다.
 * 버전은 설치 폴더(또는 VS Code처럼 그 아래 버전 폴더)의 resources/app/package.json에서 읽는다 — 앱을 띄우지 않는다.
 */
function guiApp(id) {
  return () => {
    const t = require('../paths').detectMcpOnlyTargets().find((x) => x.id === id);
    if (!t) return { installed: false, version: null };
    let version = null;
    if (t.installDir) {
      let subs = [];
      try { subs = fs.readdirSync(t.installDir, { withFileTypes: true }).filter((d) => d.isDirectory()).slice(0, 8).map((d) => path.join(t.installDir, d.name)); } catch { /* 폴더 없음 */ }
      for (const base of [t.installDir, ...subs]) {
        try { version = JSON.parse(fs.readFileSync(path.join(base, 'resources', 'app', 'package.json'), 'utf8')).version || null; break; } catch { /* 다음 */ }
      }
    }
    return { installed: true, version };
  };
}

// contract: 이 Hub가 헤드리스 호출에 쓰는 플래그. 없으면 dispatch를 막고 drift로 보고한다.
const HARNESSES = {
  'claude-code': { label: 'Claude Code', mcpTarget: 'claude-code', bin: claudeBin, helpArgs: ['--help'],
    contract: ['--print', '--output-format', '--permission-mode', '--strict-mcp-config'], dispatch: true },
  codex: { label: 'Codex', mcpTarget: 'codex', bin: () => require('../agent-workers').codexBin(), helpArgs: ['exec', '--help'],
    contract: ['--sandbox', '--ephemeral', '--skip-git-repo-check'], dispatch: true },
  antigravity: { label: 'Antigravity (agy)', mcpTarget: 'antigravity', bin: () => require('../agent-workers').agyBin(), helpArgs: ['--help'],
    contract: ['--output-format', '--sandbox', '--print-timeout'], dispatch: true },
  'gemini-cli': { label: 'Gemini CLI', mcpTarget: 'gemini-cli', bin: () => onPath('gemini'), helpArgs: ['--help'], contract: [], dispatch: false },
  // GUI 하네스: 헤드리스 계약이 없어 깨우지 않는다. Hub MCP를 등록하면 bus_inbox·bus_send로 끌어온다(Gemini CLI와 같은 방식).
  'claude-desktop': { label: 'Claude Desktop (채팅 앱)', mcpTarget: 'claude-desktop', app: guiApp('claude-desktop'), contract: [], dispatch: false },
  cursor: { label: 'Cursor', mcpTarget: 'cursor', app: guiApp('cursor'), contract: [], dispatch: false },
  vscode: { label: 'VS Code (Copilot)', mcpTarget: 'vscode', app: guiApp('vscode'), contract: [], dispatch: false },
  'ai-hub': { label: 'ai-hub', mcpTarget: null, bin: () => process.execPath, helpArgs: null, contract: [], dispatch: false },
};
const IDS = Object.keys(HARNESSES);

function run(bin, args) {
  return new Promise((resolve) => {
    // .cmd는 shell 없이 띄울 수 없다 — 탐침만 cmd /c로 감싸고, 인자는 고정 문자열뿐이다.
    const viaCmd = /\.cmd$/i.test(bin);
    execFile(viaCmd ? 'cmd.exe' : bin, viaCmd ? ['/d', '/c', bin, ...args] : args, { encoding: 'buffer', windowsHide: true, timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const decode = require('../console-text').decode;
        resolve({ ok: !err || (err.code !== 'ENOENT' && !err.killed), text: decode(stdout || Buffer.alloc(0)) + '\n' + decode(stderr || Buffer.alloc(0)), timedOut: !!(err && err.killed) });
      });
  });
}

function compatFile(deps = {}) { return path.join(deps.dataDir || require('../paths').hubDataDir(), 'harness-bus', 'compat.json'); }
// 읽기 오류는 던지고 깨진 파일은 격리한다 — 실패를 "기록 없음"으로 보면 probeAll이 compat.json을 덮어 drift 기준을 잃는다(규칙 6).
async function readCompat(deps) { return require('../atomic-file').readJsonOrQuarantine(compatFile(deps), { schemaVersion: 1, harnesses: {} }); }

function mcpMode(h, deps) {
  try { const t = (deps.registrar || require('../registrar')).status().find((x) => x.id === h.mcpTarget); return t ? (t.registered ? t.mode : 'not-registered') : 'unknown-target'; } catch { return 'unknown'; }
}

/** 한 하네스의 설치·버전·계약 플래그·Hub MCP 등록을 잰다. deps.run으로 실행기를 바꿔 시험한다. */
async function probe(id, deps = {}) {
  const h = HARNESSES[id];
  if (!h) throw new Error('알 수 없는 하네스: ' + id);
  if (id === 'ai-hub') return { id, label: h.label, installed: true, version: require('../../../package.json').version, contractOk: true, missing: [], dispatch: false, mcp: 'self' };
  if (h.app) {
    const a = (deps.apps && deps.apps[id]) || h.app();
    return { id, label: h.label, installed: a.installed, gui: true, version: a.version, contractOk: a.installed, missing: [], dispatch: false, mcp: a.installed ? mcpMode(h, deps) : null };
  }
  const bin = (deps.bins && deps.bins[id] !== undefined) ? deps.bins[id] : h.bin();
  if (!bin) return { id, label: h.label, installed: false, version: null, contractOk: false, missing: h.contract, dispatch: false, mcp: null };
  const exec = deps.run || run;
  const ver = await exec(bin, ['--version']);
  const version = (ver.text.match(/\d+\.\d+\.\d+[\w.-]*/) || [null])[0];
  const help = h.helpArgs && h.contract.length ? await exec(bin, h.helpArgs) : { text: '' };
  const missing = h.contract.filter((f) => !help.text.includes(f));
  return { id, label: h.label, installed: true, bin: path.basename(bin), version, contractOk: missing.length === 0, missing, dispatch: h.dispatch && missing.length === 0, mcp: mcpMode(h, deps) };
}

/** 모든 하네스 탐침 + 지난 결과와 비교(버전 변경·계약 drift). 결과는 기기 전용 compat.json에 남긴다. */
async function probeAll(deps = {}) {
  const prev = await readCompat(deps);
  const rows = [];
  for (const id of IDS) {
    let r;
    try { r = await probe(id, deps); } catch (e) { r = { id, installed: false, error: String(e.message || e).slice(0, 160) }; }
    const before = prev.harnesses[id];
    r.versionChanged = !!(before && before.version && r.version && before.version !== r.version);
    r.drift = !!(before && before.contractOk && r.installed && !r.contractOk);
    r.checkedAt = new Date().toISOString();
    rows.push(r);
  }
  const next = { schemaVersion: 1, checkedAt: new Date().toISOString(), harnesses: Object.fromEntries(rows.map((r) => [r.id, r])) };
  await require('../atomic-file').writeAtomic(compatFile(deps), JSON.stringify(next, null, 1));
  return rows;
}

module.exports = { HARNESSES, IDS, probe, probeAll, readCompat, claudeBin, onPath };

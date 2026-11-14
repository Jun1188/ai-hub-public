// Path auto-detection for the hub itself and for every AI tool it integrates with.
// Everything is resolved at runtime from the current user profile so the app
// works unchanged when installed on another computer (requirement #4).
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const HOME = os.homedir();
const publicProfile = require('./public-profile');

function hubStorageDir(base) {
  if (publicProfile.enabled) return path.join(base, publicProfile.dataName);
  const canonical = path.join(base, 'ai-hub');
  const legacy = path.join(base, 'ai-allinone-hub');
  const exists = dir => {
    try { if (!fs.statSync(dir).isDirectory()) throw Error('Hub storage path is not a directory'); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  return !exists(canonical) && exists(legacy) ? legacy : canonical;
}

/** Directory where the hub keeps its own config/skills/logs (per-user, survives reinstall). */
function hubDataDir() {
  let base = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  // Claude Desktop 등 MSIX 패키징 앱이 자식 프로세스로 stdio 허브를 실행하면
  // APPDATA가 LocalCache로 가상화됩니다. GUI와 동일한 경로를 쓰도록 우회합니다.
  if (process.platform === 'win32' && base.includes('LocalCache\\Roaming')) {
    base = path.join(HOME, 'AppData', 'Roaming');
  }
  const dir = hubStorageDir(base);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Electron keeps using the profile it selected at startup if another installation creates a directory later.
let selectedChromiumProfile;
function chromiumProfileDir() {
  if (selectedChromiumProfile) return selectedChromiumProfile;
  if (publicProfile.enabled) return (selectedChromiumProfile = path.join(hubDataDir(), 'browser'));
  const legacy = path.join(HOME, 'AppData', 'Roaming', 'AI All-In-One Hub');
  const profile = path.join(hubDataDir(), 'browser');
  selectedChromiumProfile = fs.existsSync(profile) || !fs.existsSync(legacy) ? profile : legacy;
  return selectedChromiumProfile;
}

/** Root of the installed app source (works both from source and packaged). */
function appRoot() {
  return path.resolve(__dirname, '..', '..');
}

/** Is this process a packaged Electron app (installed build, not `electron .`)? */
function isPackaged() {
  return Boolean(process.versions.electron) && !process.defaultApp;
}

/**
 * Command + env that MCP clients should use to launch the stdio hub.
 * From source: plain `node`. Packaged: the app's own exe with
 * ELECTRON_RUN_AS_NODE=1, so target machines don't need Node installed.
 */
function stdioLauncher() {
  if (process.env.AIHUB_NODE) return { command: process.env.AIHUB_NODE, env: null };
  if (isPackaged()) return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  return { command: 'node', env: null };
}

/**
 * Detect config files / skill directories of every supported AI tool.
 * Each entry: { id, name, kind, configPath, skillsDir, exists }
 */
function detectTargets() {
  if (publicProfile.enabled) return [];
  const candidates = [
    {
      id: 'claude-code',
      name: 'Claude Code',
      kind: 'claude-json',
      configPath: path.join(HOME, '.claude.json'),
      skillsDir: path.join(HOME, '.claude', 'skills'),
    },
    // agy CLI 1.4·Antigravity 앱 2.26·IDE 2.5는 MCP 서버를 공유 파일 하나(~/.gemini/config/mcp_config.json)에서 읽는다 —
    // 공식 문서(antigravity.google/docs/mcp)와 `agy mcp list` 실측(2026-10-25). 앱별 mcp_config.json은 더 읽히지 않아
    // 그쪽 등록은 아무 데도 닿지 않았다. 두 대상은 같은 파일을 가리키고, 스킬 폴더만 다르다.
    {
      id: 'antigravity',
      name: 'Antigravity (CLI·앱)',
      kind: 'mcp-config-json',
      configPath: path.join(HOME, '.gemini', 'config', 'mcp_config.json'),
      skillsDir: path.join(HOME, '.gemini', 'antigravity', 'skills'),
      appDir: path.join(HOME, '.gemini', 'antigravity'),
    },
    {
      id: 'antigravity-ide',
      name: 'Antigravity IDE',
      kind: 'mcp-config-json',
      configPath: path.join(HOME, '.gemini', 'config', 'mcp_config.json'),
      skillsDir: path.join(HOME, '.gemini', 'antigravity-ide', 'skills'),
      appDir: path.join(HOME, '.gemini', 'antigravity-ide'),
    },
    {
      id: 'gemini-cli',
      name: 'Gemini CLI',
      kind: 'gemini-settings',
      configPath: path.join(HOME, '.gemini', 'settings.json'),
      skillsDir: path.join(HOME, '.gemini', 'skills'),
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      kind: 'codex-toml',
      configPath: path.join(HOME, '.codex', 'config.toml'),
      skillsDir: path.join(HOME, '.codex', 'skills'),
    },
  ];
  return candidates.map((c) => ({
    ...c,
    // 여러 도구가 함께 쓰는 설정 파일로는 어느 도구가 깔렸는지 모른다 — 그런 대상은 도구 자신의 폴더로 본다.
    exists: c.appDir ? fs.existsSync(c.appDir) : fs.existsSync(c.configPath) || fs.existsSync(path.dirname(c.configPath)),
  }));
}

/**
 * MCP만 등록하는 다른 클라우드 AI 하네스(스킬 폴더가 없어 스킬 설치 대상에서는 빠진다).
 * Claude 데스크톱 채팅 앱은 설정 파일에 로컬(stdio) 서버만 받는다. VS Code는 키 이름이 `servers`다.
 */
function detectMcpOnlyTargets() {
  if (publicProfile.enabled) return [];
  const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  const programs = path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Programs');
  const candidates = [
    // 데스크톱 앱은 MSIX라 실행 파일 위치를 읽을 수 없다 — 앱이 만든 설정 파일이 곧 설치 흔적이다.
    { id: 'claude-desktop', name: 'Claude Desktop (채팅 앱)', kind: 'claude-desktop-json', configPath: path.join(appData, 'Claude', 'claude_desktop_config.json'), stdioOnly: true },
    { id: 'cursor', name: 'Cursor', kind: 'cursor-json', configPath: path.join(HOME, '.cursor', 'mcp.json'), installDir: path.join(programs, 'cursor'), exe: 'Cursor.exe' },
    { id: 'vscode', name: 'VS Code (Copilot)', kind: 'vscode-json', configPath: path.join(appData, 'Code', 'User', 'mcp.json'), installDir: path.join(programs, 'Microsoft VS Code'), exe: 'Code.exe' },
  ];
  // 설치된 앱만 — 지운 앱이 남긴 설정 폴더(2026-10-22 이 PC의 ~/.cursor)는 내놓지 않고, 없는 앱의 폴더를 만들지도 않는다.
  const installed = (c) => (c.exe ? fs.existsSync(path.join(c.installDir, c.exe)) : fs.existsSync(c.configPath)) && fs.existsSync(path.dirname(c.configPath));
  return candidates.filter(installed).map((c) => ({ ...c, mcpOnly: true, skillsDir: null, exists: true }));
}

module.exports = { HOME, hubStorageDir, hubDataDir, chromiumProfileDir, appRoot, stdioLauncher, isPackaged, detectTargets, detectMcpOnlyTargets };

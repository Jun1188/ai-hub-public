// Game project hub (ported from DevPipeline): auto-detects Unity/Unreal
// projects and installed tools (editors, Visual Studio, Antigravity), keeps a
// per-machine registry in %APPDATA%/ai-hub/projects.json, and
// launches editors/IDEs. All paths are resolved at runtime so the same app
// folder works unchanged on every computer.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { hubDataDir } = require('./paths');
const consoleText = require('./console-text');

const execFileAsync = promisify(execFile);

/**
 * 콘솔 프로그램을 돌리고 출력을 **이 컴퓨터의 콘솔 인코딩으로** 읽는다.
 *
 * 여기서 감지하는 건 전부 설치 **경로**다. 한국어 Windows의 콘솔은 CP949라 Node의
 * 기본 utf8 디코딩으로 읽으면 한글이 들어간 경로가 U+FFFD로 뭉개지고, 결과적으로
 * 존재하지 않는 디렉터리를 감지 결과로 돌려주게 된다(console-text.js에 실측).
 */
async function readCommand(exe, args, opts) {
  const { stdout } = await execFileAsync(exe, args, { ...opts, ...consoleText.RAW_OUTPUT });
  return consoleText.decode(stdout);
}
const PROJECTS_FILE = path.join(hubDataDir(), 'projects.json');
const TOOLS_CACHE_MS = 60000;

// ---- store ---------------------------------------------------------------

function readFile() {
  try {
    const obj = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    if (Array.isArray(obj.projects)) return obj;
  } catch { /* first run or corrupt */ }
  return { version: 1, projects: [] };
}

function writeFile(obj) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

// ---- Unity detection -----------------------------------------------------

function parseUnityProjectVersion(content) {
  const m = content.match(/^m_EditorVersion:\s*(\S+)/m);
  return m ? m[1] : null;
}

function isUnityProject(projectPath) {
  return fs.existsSync(path.join(projectPath, 'ProjectSettings', 'ProjectVersion.txt'));
}

function readUnityProjectVersion(projectPath) {
  const file = path.join(projectPath, 'ProjectSettings', 'ProjectVersion.txt');
  if (!fs.existsSync(file)) return null;
  return parseUnityProjectVersion(fs.readFileSync(file, 'utf8'));
}

function scanHubEditorDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const version of fs.readdirSync(dir)) {
    const exePath = path.join(dir, version, 'Editor', 'Unity.exe');
    if (fs.existsSync(exePath)) found.push({ version, exePath });
  }
  return found;
}

/** Unity Hub default dir + secondaryInstallPath.json + Hub headless CLI fallback. */
async function detectUnityEditors() {
  const editors = new Map();
  for (const e of scanHubEditorDir('C:\\Program Files\\Unity\\Hub\\Editor')) editors.set(e.version, e);
  try {
    const secondaryFile = path.join(process.env.APPDATA || '', 'UnityHub', 'secondaryInstallPath.json');
    if (fs.existsSync(secondaryFile)) {
      const secondary = JSON.parse(fs.readFileSync(secondaryFile, 'utf8')); // JSON string: "D:\\Unity\\Editors"
      if (typeof secondary === 'string' && secondary) {
        for (const e of scanHubEditorDir(secondary)) if (!editors.has(e.version)) editors.set(e.version, e);
      }
    }
  } catch { /* optional probe */ }
  if (editors.size === 0) {
    try {
      const hubExe = 'C:\\Program Files\\Unity Hub\\Unity Hub.exe';
      if (fs.existsSync(hubExe)) {
        const stdout = await readCommand(hubExe, ['--', '--headless', 'editors', '-i'], { timeout: 15000, windowsHide: true });
        for (const line of stdout.split(/\r?\n/)) {
          const m = line.match(/^(\S+)\s*,\s*installed at\s+(.+Unity\.exe)\s*$/i);
          if (m) editors.set(m[1], { version: m[1], exePath: m[2].trim() });
        }
      }
    } catch { /* optional probe */ }
  }
  return [...editors.values()].sort((a, b) => b.version.localeCompare(a.version));
}

/** exact match, otherwise closest same major.minor, otherwise newest */
function matchUnityEditor(projectVersion, editors) {
  if (!editors.length) return { exact: false };
  const exact = editors.find((e) => e.version === projectVersion);
  if (exact) return { editor: exact, exact: true };
  const [maj, min] = projectVersion.split('.');
  const sameMinor = editors.find((e) => e.version.startsWith(`${maj}.${min}.`));
  return { editor: sameMinor || editors[0], exact: false };
}

// ---- Unreal detection ----------------------------------------------------

function findUprojectFile(projectPath) {
  if (!fs.existsSync(projectPath)) return null;
  const entries = fs.readdirSync(projectPath).filter((f) => f.toLowerCase().endsWith('.uproject'));
  return entries.length ? path.join(projectPath, entries[0]) : null;
}

/** EngineAssociation: "5.5" (launcher) or "{GUID}" (source build) */
function parseEngineAssociation(uprojectContent) {
  try {
    const json = JSON.parse(uprojectContent);
    return typeof json.EngineAssociation === 'string' ? json.EngineAssociation : '';
  } catch {
    return '';
  }
}

function toInstall(version, installLocation) {
  const editorPath = path.join(installLocation, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe');
  if (!fs.existsSync(editorPath)) return null;
  return {
    version,
    installLocation,
    editorPath,
    uatPath: path.join(installLocation, 'Engine', 'Build', 'BatchFiles', 'RunUAT.bat'),
  };
}

function parseLauncherInstalled(content) {
  try {
    const json = JSON.parse(content);
    const list = json.InstallationList || [];
    return list
      .filter((e) => typeof e.AppName === 'string' && e.AppName.startsWith('UE_'))
      .map((e) => ({ version: e.AppName.replace(/^UE_/, ''), installLocation: e.InstallLocation || '' }))
      .filter((e) => e.installLocation.length > 0);
  } catch {
    return [];
  }
}

async function queryRegistrySourceBuilds() {
  // HKCU\SOFTWARE\Epic Games\Unreal Engine\Builds — values: {GUID} = install dir
  try {
    const stdout = await readCommand('reg', ['query', 'HKCU\\SOFTWARE\\Epic Games\\Unreal Engine\\Builds'], { timeout: 5000, windowsHide: true });
    const results = [];
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^\s+(\{[0-9a-fA-F-]+\})\s+REG_SZ\s+(.+)$/);
      if (m) results.push({ version: m[1], installLocation: m[2].trim() });
    }
    return results;
  } catch {
    return []; // key absent when no source builds registered
  }
}

async function detectUnrealEngines() {
  const installs = [];
  const datFile = 'C:\\ProgramData\\Epic\\UnrealEngineLauncher\\LauncherInstalled.dat';
  if (fs.existsSync(datFile)) {
    for (const e of parseLauncherInstalled(fs.readFileSync(datFile, 'utf8'))) {
      const install = toInstall(e.version, e.installLocation);
      if (install) installs.push(install);
    }
  }
  for (const e of await queryRegistrySourceBuilds()) {
    if (!installs.some((i) => i.version === e.version)) {
      const install = toInstall(e.version, e.installLocation);
      if (install) installs.push(install);
    }
  }
  return installs.sort((a, b) => b.version.localeCompare(a.version));
}

/** match EngineAssociation to an install: exact version, GUID, or major.minor prefix */
function matchUnrealEngine(engineAssociation, engines) {
  if (!engines.length) return { exact: false };
  const exact = engines.find((e) => e.version === engineAssociation);
  if (exact) return { engine: exact, exact: true };
  const prefix = engines.find((e) => e.version.startsWith(engineAssociation));
  return { engine: prefix || engines[0], exact: Boolean(prefix) };
}

// ---- tool detection ------------------------------------------------------

const DEFAULT_VSWHERE = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';

async function detectVisualStudio(vswherePath) {
  const vswhere = vswherePath && fs.existsSync(vswherePath) ? vswherePath : DEFAULT_VSWHERE;
  if (!fs.existsSync(vswhere)) return undefined;
  try {
    const common = ['-latest', '-products', '*', '-requires', 'Microsoft.Component.MSBuild'];
    const stdout = await readCommand(vswhere, [...common, '-format', 'json'], { timeout: 10000, windowsHide: true });
    const instances = JSON.parse(stdout);
    if (!Array.isArray(instances) || !instances.length) return undefined;
    const inst = instances[0];
    const msbuildOut = await readCommand(vswhere, [...common, '-find', 'MSBuild\\**\\Bin\\MSBuild.exe'], { timeout: 10000, windowsHide: true });
    const msbuildPath = msbuildOut.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (!inst.productPath || !msbuildPath) return undefined;
    return { devenvPath: inst.productPath, msbuildPath: msbuildPath.trim(), displayName: inst.displayName || 'Visual Studio' };
  } catch {
    return undefined;
  }
}

async function findOnPath(exe) {
  try {
    const stdout = await readCommand('where.exe', [exe], { timeout: 5000, windowsHide: true });
    const first = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    return first ? first.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function detectAntigravity(overridePath) {
  if (overridePath && fs.existsSync(overridePath)) return overridePath;
  const onPath = await findOnPath('antigravity');
  if (onPath) return onPath;
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
    path.join(localAppData, 'Programs', 'antigravity', 'antigravity.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

let toolsCache = null;

async function detectTools(force = false) {
  if (!force && toolsCache && Date.now() - toolsCache.at < TOOLS_CACHE_MS) return toolsCache.tools;
  const cfg = require('./config').load();
  const dp = cfg.devpipeline || {};
  const [unityEditors, unrealEngines, visualStudio, antigravityPath, ugsPath] = await Promise.all([
    detectUnityEditors(),
    detectUnrealEngines(),
    detectVisualStudio(dp.vswherePath),
    detectAntigravity(dp.antigravityPath),
    findOnPath('ugs'),
  ]);
  const tools = { unityEditors, unrealEngines, visualStudio, antigravityPath, ugsPath, detectedAt: new Date().toISOString() };
  toolsCache = { tools, at: Date.now() };
  return tools;
}

// ---- registry ------------------------------------------------------------

function findNewestSln(dir) {
  if (!fs.existsSync(dir)) return undefined;
  const files = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile());
  const legacy = files.filter((entry) => /\.sln$/i.test(entry.name));
  const slns = (legacy.length ? legacy : files.filter((entry) => /\.slnx$/i.test(entry.name)))
    .map((entry) => path.join(dir, entry.name));
  if (!slns.length) return undefined;
  return slns.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

async function inspect(projectPath) {
  const tools = await detectTools();
  const base = {
    id: crypto.randomUUID(),
    name: path.basename(projectPath),
    path: projectPath,
    slnPath: findNewestSln(projectPath),
    addedAt: new Date().toISOString(),
  };
  if (isUnityProject(projectPath)) {
    const version = readUnityProjectVersion(projectPath) || 'unknown';
    const { editor } = matchUnityEditor(version, tools.unityEditors);
    return { ...base, kind: 'unity', engineVersion: version, editorPath: editor && editor.exePath };
  }
  const uproject = findUprojectFile(projectPath);
  if (uproject) {
    const assoc = parseEngineAssociation(fs.readFileSync(uproject, 'utf8'));
    const { engine } = matchUnrealEngine(assoc, tools.unrealEngines);
    return {
      ...base,
      kind: 'unreal',
      engineVersion: assoc || 'unknown',
      editorPath: engine && engine.editorPath,
      uprojectPath: uproject,
      // engine install root — lets the GUI offer one-click engine-source
      // indexing (소스 분석/파인튜닝용); re-resolved per machine on refresh
      engineRoot: engine && engine.installLocation,
    };
  }
  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const stat = fs.statSync(pkgPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw Error('package.json을 읽을 수 없습니다.');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''));
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw Error('올바른 package.json이 필요합니다.');
    const manager = /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager || '')?.[1] ||
      ([['pnpm-lock.yaml','pnpm'], ['yarn.lock','yarn'], ['bun.lock','bun'], ['bun.lockb','bun']]
        .find(([file]) => fs.existsSync(path.join(projectPath, file)))?.[1] || 'npm');
    const commands = {};
    for (const task of ['build','test']) {
      if (typeof pkg.scripts?.[task] === 'string' && pkg.scripts[task].trim()) commands[task] = manager + ' run ' + task;
    }
    return { ...base, kind: 'node', language: fs.existsSync(path.join(projectPath, 'tsconfig.json')) ? 'TypeScript' : 'JavaScript',
      commands };
  }
  if (base.slnPath) {
    return { ...base, kind: 'msbuild', buildSystem: 'MSBuild' };
  }
  throw new Error('Unity, Unreal, Node.js 또는 Visual Studio 솔루션 파일을 찾지 못했습니다.');
}

function list() {
  return readFile().projects;
}

function getById(id) {
  const project = list().find((p) => p.id === id);
  if (!project) throw new Error(`프로젝트를 찾을 수 없습니다: ${id}`);
  return project;
}

async function add(projectPath) {
  if (!fs.existsSync(projectPath)) throw new Error(`경로가 존재하지 않습니다: ${projectPath}`);
  if (list().some((p) => p.path.toLowerCase() === projectPath.toLowerCase())) {
    throw new Error('이미 등록된 프로젝트입니다');
  }
  const project = await inspect(projectPath);
  const f = readFile();
  f.projects.push(project);
  writeFile(f);
  return project;
}

function remove(id) {
  const f = readFile();
  f.projects = f.projects.filter((p) => p.id !== id);
  writeFile(f);
}

function replace(project) {
  const f = readFile();
  f.projects = f.projects.map((p) => (p.id === project.id ? project : p));
  writeFile(f);
}

async function refresh(id) {
  const existing = getById(id);
  const fresh = await inspect(existing.path);
  const updated = {
    ...fresh,
    id: existing.id,
    addedAt: existing.addedAt,
    lastOpenedAt: existing.lastOpenedAt,
    overrides: existing.overrides,
  };
  replace(updated);
  return updated;
}

function updateOverrides(id, overrides) {
  const project = { ...getById(id), overrides };
  replace(project);
  return project;
}

function touchLastOpened(id) {
  replace({ ...getById(id), lastOpenedAt: new Date().toISOString() });
}

/** effective editor/sln path: override > auto-resolved */
function resolveEditorPath(project) {
  return (project.overrides && project.overrides.editorPath) || project.editorPath;
}

function resolveSlnPath(project) {
  return (project.overrides && project.overrides.slnPath) || project.slnPath;
}

// ---- launcher ------------------------------------------------------------

/** naive arg splitting honoring double quotes */
function splitArgs(input) {
  const matches = input.match(/"[^"]*"|\S+/g) || [];
  return matches.map((a) => a.replace(/^"|"$/g, ''));
}

function fireAndForget(exe, args) {
  try {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

/** open a file with the OS default handler; works with or without Electron */
async function osOpen(target) {
  try {
    const { shell } = require('electron');
    if (shell && shell.openPath) {
      const errMsg = await shell.openPath(target);
      return errMsg ? { ok: false, error: errMsg } : { ok: true };
    }
  } catch { /* running as plain node (stdio hub) */ }
  return fireAndForget('cmd', ['/d', '/s', '/c', 'start', '""', target]);
}

async function launchEditor(projectId) {
  const project = getById(projectId);
  const editorPath = resolveEditorPath(project);

  if (project.kind === 'unity') {
    if (!editorPath || !fs.existsSync(editorPath)) {
      return { ok: false, error: `Unity 에디터(${project.engineVersion})를 찾을 수 없습니다. Unity Hub에서 해당 버전을 설치하거나 프로젝트 재감지 후 경로를 지정하세요.` };
    }
    const args = ['-projectPath', project.path];
    const extra = project.overrides && project.overrides.editorArgs;
    if (extra) args.push(...splitArgs(extra));
    const result = fireAndForget(editorPath, args);
    if (result.ok) touchLastOpened(projectId);
    return result;
  }

  if (project.kind !== 'unreal') {
    return { ok: false, error: '이 프로젝트에는 엔진 에디터가 없습니다.' };
  }
  if (!project.uprojectPath || !fs.existsSync(project.uprojectPath)) {
    return { ok: false, error: '.uproject 파일을 찾을 수 없습니다. 프로젝트를 다시 감지해보세요.' };
  }
  if (editorPath && fs.existsSync(editorPath)) {
    const args = [project.uprojectPath];
    const extra = project.overrides && project.overrides.editorArgs;
    if (extra) args.push(...splitArgs(extra));
    const result = fireAndForget(editorPath, args);
    if (result.ok) touchLastOpened(projectId);
    return result;
  }
  // fallback: OS file association handles engine resolution
  const result = await osOpen(project.uprojectPath);
  if (result.ok) touchLastOpened(projectId);
  return result;
}

async function launchSln(projectId) {
  const project = getById(projectId);
  const slnPath = resolveSlnPath(project);
  if (!slnPath || !fs.existsSync(slnPath)) {
    return {
      ok: false,
      error: project.kind === 'unreal'
        ? '.sln이 없습니다. Unreal 에디터에서 Tools > Generate Visual Studio Project Files를 실행하세요.'
        : project.kind === 'unity' ? '.sln이 없습니다. Unity 에디터에서 스크립트를 한 번 열면 생성됩니다.'
          : '솔루션 파일을 찾을 수 없습니다. 솔루션 폴더에서 다시 감지하세요.',
    };
  }
  const tools = await detectTools();
  if (tools.visualStudio && fs.existsSync(tools.visualStudio.devenvPath)) {
    return fireAndForget(tools.visualStudio.devenvPath, [slnPath]);
  }
  return osOpen(slnPath);
}

async function launchAntigravity(projectId) {
  const project = getById(projectId);
  const tools = await detectTools();
  if (!tools.antigravityPath || !fs.existsSync(tools.antigravityPath)) {
    return { ok: false, error: 'Antigravity를 찾을 수 없습니다. config.json의 devpipeline.antigravityPath로 경로를 지정할 수 있습니다.' };
  }
  return fireAndForget(tools.antigravityPath, [project.path]);
}

module.exports = {
  // registry
  list, getById, add, remove, refresh, updateOverrides, touchLastOpened,
  resolveEditorPath, resolveSlnPath, detectTools, findNewestSln,
  // launcher
  launchEditor, launchSln, launchAntigravity, splitArgs,
  // 소스 분석(codeindex/renderpipe)이 엔진 소스 루트를 찾을 때도 쓴다 —
  // 고정 경로 스캔과 달리 설치 드라이브가 달라도 LauncherInstalled.dat/레지스트리로 찾는다.
  detectUnrealEngines,
  // exported for tests
  parseUnityProjectVersion, matchUnityEditor, parseEngineAssociation,
  parseLauncherInstalled, matchUnrealEngine, findUprojectFile,
  PROJECTS_FILE,
};

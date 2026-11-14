// Registers/unregisters the hub as an MCP server inside each AI tool's config.
// Every write creates a timestamped .bak backup next to the original file.
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { appRoot, detectTargets, detectMcpOnlyTargets, stdioLauncher } = require('./paths');

const SERVER_NAME = 'ai-hub';
const LEGACY_SERVER_NAME = 'ai-allinone-hub';

// 스킬·MCP 대상(detectTargets) + MCP만 받는 다른 하네스(Claude 데스크톱·Cursor·VS Code).
const allTargets = () => [...detectTargets(), ...detectMcpOnlyTargets()];
// VS Code mcp.json만 서버 목록 키가 `servers`다.
const serversKey = (kind) => (kind === 'vscode-json' ? 'servers' : 'mcpServers');

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const bak = `${file}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  fs.copyFileSync(file, bak);
  return bak;
}

function stdioSpec() {
  const entry = path.join(appRoot(), 'src', 'mcp', 'stdio-entry.js');
  const l = stdioLauncher();
  return { command: l.command, args: [entry], env: l.env };
}

function httpSpec() {
  const cfg = config.load();
  return {
    url: `http://127.0.0.1:${cfg.hub.httpPort}/mcp`,
    headers: cfg.hub.requireAuth ? { Authorization: `Bearer ${cfg.hub.authToken}` } : {},
  };
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  // If the file exists but cannot be parsed, THROW instead of returning {} —
  // otherwise a parse issue would make us silently wipe the user's config.
  const raw = stripBom(fs.readFileSync(file, 'utf8'));
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config file is not valid JSON, refusing to modify it: ${file} (${err.message})`);
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

// ---- per-format handlers ------------------------------------------------
//
// 도구마다 같은 뜻을 다른 키로 쓴다. 항목을 만드는 곳은 formatEntry 한 군데뿐이고,
// 허브 자신이든 CLI 커넥터든 upsertServer를 거쳐 등록된다(connectors.js 참고).

/**
 * 도구 설정 포맷에 맞는 서버 항목 객체를 만든다.
 * @param {string} kind detectTargets()의 kind
 * @param {object} spec {command, args, env} 또는 {url, headers}
 */
function formatEntry(kind, spec) {
  const isHttp = Boolean(spec.url);
  const headers = spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {};
  if (kind === 'mcp-config-json') {
    // Antigravity: stdio에는 "type"을 쓰지 않고, http는 serverUrl.
    return isHttp
      ? { serverUrl: spec.url, type: 'http', disabled: false, ...headers }
      : { disabled: false, command: spec.command, args: spec.args, ...(spec.env ? { env: spec.env } : {}) };
  }
  if (kind === 'gemini-settings') {
    return isHttp
      ? { httpUrl: spec.url, type: 'http', ...headers }
      : { type: 'stdio', command: spec.command, args: spec.args, ...(spec.env ? { env: spec.env } : {}) };
  }
  if (kind === 'claude-desktop-json' || kind === 'cursor-json') {
    // Claude 데스크톱은 command/args만(로컬 서버), Cursor는 command/args 또는 url — 둘 다 "type"을 쓰지 않는다.
    return isHttp
      ? { url: spec.url, ...headers }
      : { command: spec.command, args: spec.args, ...(spec.env ? { env: spec.env } : {}) };
  }
  return isHttp
    ? { type: 'http', url: spec.url, ...headers }
    : { type: 'stdio', command: spec.command, args: spec.args, ...(spec.env ? { env: spec.env } : {}) };
}

/** 서버 항목 하나를 넣거나 갱신한다. 다른 항목은 건드리지 않는다. */
function upsertServer(target, name, spec) {
  const obj = readJson(target.configPath);
  const key = serversKey(target.kind);
  if (!obj[key] || typeof obj[key] !== 'object') obj[key] = {};
  if (name === SERVER_NAME) delete obj[key][LEGACY_SERVER_NAME];
  obj[key][name] = formatEntry(target.kind, spec);
  writeJson(target.configPath, obj);
  return { target: target.name, configPath: target.configPath, name };
}

/** 서버 항목 하나를 지운다. 없으면 아무것도 안 한다. */
function removeServer(target, name) {
  if (!fs.existsSync(target.configPath)) return { target: target.name, removed: false };
  const obj = readJson(target.configPath);
  const key = serversKey(target.kind);
  if (!obj[key] || (!obj[key][name] && !(name === SERVER_NAME && obj[key][LEGACY_SERVER_NAME]))) return { target: target.name, removed: false };
  if (name === SERVER_NAME) delete obj[key][LEGACY_SERVER_NAME];
  delete obj[key][name];
  writeJson(target.configPath, obj);
  return { target: target.name, configPath: target.configPath, removed: true };
}

/**
 * 등록된 서버 항목들.
 *   {}   — 없음(또는 파일 자체가 없음)
 *   null — 파일은 있는데 읽지 못함. 이때는 절대 쓰지 않는다.
 * JSON 포맷이 아닌 대상(codex-toml)은 여기서 다루지 않으므로 undefined를 준다.
 */
function readServers(target) {
  if (target.kind === 'codex-toml') return undefined; // JSON이 아님 — 읽기 실패와 구별
  try {
    if (!fs.existsSync(target.configPath)) return {};
    return readJson(target.configPath)[serversKey(target.kind)] || {};
  } catch {
    return null;
  }
}

function registerJsonMcpServers(file, mode) {
  upsertServer({ configPath: file, kind: 'claude-json', name: file }, SERVER_NAME,
    mode === 'http' ? httpSpec() : stdioSpec());
}

function unregisterJsonMcpServers(file) {
  removeServer({ configPath: file, kind: 'claude-json', name: file }, SERVER_NAME);
}

// Antigravity's mcp_config.json uses command/args or serverUrl (no "type": "stdio").
function registerAntigravity(file, mode) {
  upsertServer({ configPath: file, kind: 'mcp-config-json', name: file }, SERVER_NAME,
    mode === 'http' ? httpSpec() : stdioSpec());
}

// Gemini CLI settings.json: stdio uses command/args, http uses httpUrl.
function registerGemini(file, mode) {
  upsertServer({ configPath: file, kind: 'gemini-settings', name: file }, SERVER_NAME,
    mode === 'http' ? httpSpec() : stdioSpec());
}

// Codex config.toml: manipulate only our own [mcp_servers.ai-hub] section.
function stripCodexSection(text) {
  const re = new RegExp(
    `(?:^|\\n)\\[mcp_servers\\.(?:${SERVER_NAME}|${LEGACY_SERVER_NAME})(?:\\.[\\w.]+)?\\][^]*?(?=\\n\\[|$)`,
    'g'
  );
  return text.replace(re, '');
}

function registerCodex(file, mode) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  backup(file);
  text = stripCodexSection(text).replace(/\n{3,}$/, '\n');
  let section;
  if (mode === 'http') {
    const h = httpSpec();
    section = `\n[mcp_servers.${SERVER_NAME}]\nurl = "${h.url}"\n`;
    if (Object.keys(h.headers).length) {
      section += `\n[mcp_servers.${SERVER_NAME}.http_headers]\nAuthorization = "${h.headers.Authorization}"\n`;
    }
  } else {
    const s = stdioSpec();
    // TOML 리터럴 문자열(' ')은 작은따옴표를 이스케이프할 방법이 없다 — JSON 문자열
    // 이스케이프는 TOML 기본 문자열(" ")과 호환되므로 그대로 쓴다.
    const tomlStr = (v) => JSON.stringify(String(v));
    const argsToml = s.args.map(tomlStr).join(', ');
    section = `\n[mcp_servers.${SERVER_NAME}]\ncommand = ${tomlStr(s.command)}\nargs = [${argsToml}]\n`;
    if (s.env) {
      section += `\n[mcp_servers.${SERVER_NAME}.env]\n`;
      for (const [k, v] of Object.entries(s.env)) section += `${k} = ${tomlStr(v)}\n`;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text + section, 'utf8');
}

function unregisterCodex(file) {
  if (!fs.existsSync(file)) return;
  backup(file);
  fs.writeFileSync(file, stripCodexSection(fs.readFileSync(file, 'utf8')), 'utf8');
}

// ---- public API ----------------------------------------------------------

/**
 * 이 도구에 허브가 어떤 방식으로 등록돼 있는가.
 *   'absent' | 'http' | 'stdio' | 'unreadable'
 * 읽기 실패를 'absent'와 구별한다 — "없음"으로 보고 덮어쓰면 남의 설정을 날린다.
 */
function hubMode(target) {
  try {
    if (!fs.existsSync(target.configPath)) return 'absent';
    const raw = stripBom(fs.readFileSync(target.configPath, 'utf8'));
    if (target.kind === 'codex-toml') {
      // 우리 섹션만 본다. http 등록은 하위 섹션([...http_headers])을 함께 쓰지만
      // url 키는 항상 첫 섹션에 있다.
      const sec = raw.match(new RegExp(`\\[mcp_servers\\.(?:${SERVER_NAME}|${LEGACY_SERVER_NAME})\\][^]*?(?=\\n\\[|$)`));
      if (!sec) return 'absent';
      return /^\s*url\s*=/m.test(sec[0]) ? 'http' : 'stdio';
    }
    const servers = JSON.parse(raw)[serversKey(target.kind)] || {};
    const entry = servers[SERVER_NAME] || servers[LEGACY_SERVER_NAME];
    if (!entry) return 'absent';
    // 도구마다 키 이름이 다르다: url(Claude/일반) / httpUrl(Gemini) / serverUrl(Antigravity)
    return (entry.url || entry.httpUrl || entry.serverUrl) ? 'http' : 'stdio';
  } catch {
    return 'unreadable';
  }
}

/**
 * 이미 등록된 허브 항목을 전부 HTTP로 옮긴다. **사용자가 눌러야 동작한다** —
 * 시작 시 자동으로 돌리지 않는다. HTTP는 허브가 떠 있어야 툴이 보이므로,
 * 앱이 로컬 디스크에 있어 stdio도 안전한 컴퓨터에서는 손해일 수 있다.
 *
 * 손대지 않는 것: 미등록 도구(멋대로 만들지 않는다 — connectors.migrate와 같은 규칙),
 * 이미 http인 항목, 읽지 못한 설정 파일.
 */
function migrateToHttp({ dryRun = false } = {}) {
  const planned = [];
  const skipped = [];
  for (const target of allTargets()) {
    if (target.stdioOnly) continue; // HTTP를 받지 않는 앱은 옮기지 않는다
    const mode = hubMode(target);
    if (mode === 'stdio') planned.push({ target: target.id, targetName: target.name });
    else if (mode === 'unreadable') skipped.push({ target: target.id, targetName: target.name, reason: 'unreadable' });
  }
  if (dryRun) return { migrated: [], planned, skipped };
  const migrated = planned.map((p) => {
    try {
      register(p.target, 'http');
      return { ...p, ok: true };
    } catch (err) {
      return { ...p, ok: false, error: String((err && err.message) || err) };
    }
  });
  return { migrated, planned, skipped };
}

/**
 * @param {string} targetId one of detectTargets() ids
 * @param {'stdio'|'http'} mode
 */
function register(targetId, mode = 'stdio') {
  const target = allTargets().find((t) => t.id === targetId);
  if (!target) throw new Error(`Unknown target: ${targetId}`);
  if (target.mcpOnly) {
    const used = target.stdioOnly ? 'stdio' : mode;
    upsertServer(target, SERVER_NAME, used === 'http' ? httpSpec() : stdioSpec());
    return { target: target.name, configPath: target.configPath, mode: used, ...(used !== mode ? { note: `${target.name} accepts only local (stdio) servers` } : {}) };
  }
  switch (target.kind) {
    case 'claude-json':
      registerJsonMcpServers(target.configPath, mode);
      break;
    case 'mcp-config-json':
      registerAntigravity(target.configPath, mode);
      break;
    case 'gemini-settings':
      registerGemini(target.configPath, mode);
      break;
    case 'codex-toml':
      registerCodex(target.configPath, mode);
      break;
    default:
      throw new Error(`Unsupported target kind: ${target.kind}`);
  }
  return { target: target.name, configPath: target.configPath, mode };
}

function unregister(targetId) {
  const target = allTargets().find((t) => t.id === targetId);
  if (!target) throw new Error(`Unknown target: ${targetId}`);
  if (target.kind === 'codex-toml') unregisterCodex(target.configPath);
  else if (target.mcpOnly) removeServer(target, SERVER_NAME);
  else unregisterJsonMcpServers(target.configPath);
  return { target: target.name, configPath: target.configPath };
}

/** Snippets for wiring the hub into any third-party MCP client. */
function thirdPartySnippets() {
  const s = stdioSpec();
  const h = httpSpec();
  return {
    stdio: { mcpServers: { [SERVER_NAME]: { type: 'stdio', command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) } } },
    http: { mcpServers: { [SERVER_NAME]: { type: 'http', url: h.url, ...(Object.keys(h.headers).length ? { headers: h.headers } : {}) } } },
  };
}

function status() {
  return allTargets().map((t) => {
    const mode = hubMode(t);
    return { ...t, mode, registered: mode === 'http' || mode === 'stdio' };
  });
}

module.exports = {
  register, unregister, status, thirdPartySnippets, SERVER_NAME,
  hubMode, migrateToHttp,
  // CLI 커넥터 등록(connectors.js)이 같은 쓰기 경로를 쓰도록 노출한다.
  upsertServer, removeServer, readServers, formatEntry, backup,
};

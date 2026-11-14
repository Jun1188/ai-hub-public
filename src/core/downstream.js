// MCP host side of the hub: manages client connections to downstream MCP
// servers (Unity, Unreal, or any third-party server) over stdio or HTTP.
'use strict';

const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
const path = require('path');
const config = require('./config');
const clitools = require('./clitools');

// name -> { client, transportType, connectedAt }
const connections = new Map();
// names that connected successfully at least once and then dropped —
// candidates for automatic reconnection.
const dropped = new Set();

/**
 * 실행 가능한 형태로 펼친다. type:'cli'는 명령·인자를 설정에 저장하지 않고
 * 여기서 매번 만든다 — 브리지 경로와 CLI 실행 파일 위치가 컴퓨터마다 다르기 때문.
 */
function resolveSpec(spec) {
  if (!spec || spec.type !== 'cli') return spec;
  const { stdioLauncher, appRoot } = require('./paths');
  const launcher = stdioLauncher();
  const def = clitools.get(spec.cli);
  const bin = clitools.detect(spec.cli);
  return {
    ...spec,
    type: 'stdio',
    command: launcher.command,
    args: [path.join(appRoot(), 'src', 'mcp', 'cli-bridge.js'), spec.cli],
    env: {
      ...(launcher.env || {}),
      ...(bin && def ? { [def.envVar]: bin } : {}),
    },
    _cliBin: bin || '',
  };
}

function friendlyConnectError(name, spec, err) {
  const cause = String((err && err.message) || err);
  const where = spec.type === 'http' ? spec.url : `${spec.command} ${(spec.args || []).join(' ')}`;
  let hint = '대상 프로그램에서 MCP 서버가 실행 중인지 확인하세요.';
  if (spec.cli && !spec._cliBin) {
    const def = clitools.get(spec.cli);
    hint = `${def ? def.label : spec.cli} 실행 파일을 이 컴퓨터에서 찾지 못했습니다. `
      + `설치했다면 ${def ? def.envVar : 'CLI'} 환경변수로 경로를 지정하세요.`;
  } else if (/unity/i.test(name)) hint = 'Unity 에디터를 열고 MCP for Unity 플러그인(서버)이 켜져 있는지 확인하세요.';
  else if (/unreal/i.test(name)) hint = 'Unreal 에디터를 열고 UnrealMCP 플러그인이 활성화되어 있는지 확인하세요.';
  else if (/ENOENT/i.test(cause)) hint = '명령 경로가 존재하지 않습니다. 서버 설정의 명령/경로를 확인하세요.';
  return new Error(`"${name}" 서버에 연결할 수 없습니다 (${where}). ${hint} [원인: ${cause}]`);
}

/**
 * 예전 설정 마이그레이션 — 컴퓨터 고유 절대경로로 브리지를 가리키던 stdio 항목을
 * type:'cli'로 바꾼다. 그 경로(`~/.mcp-connectors/cli-mcp-bridge.js`)는 이 컴퓨터에만
 * 있어서 공유 설정을 통해 다른 컴퓨터로 넘어가면 그대로 깨졌다.
 */
function migrateLegacyBridgeEntries() {
  const cfg = config.load();
  let changed = false;
  for (const [name, spec] of Object.entries(cfg.downstreamServers || {})) {
    // 1.29.0에서 뺀 CLI 커넥터(antigravity)가 공유 설정에 남아 상태마다 「실행 파일 미발견」으로 보였다.
    // 카탈로그에 없는 CLI는 어느 PC에서도 연결할 수 없으므로 항목을 지운다(파일 삭제가 아니라 값 변경).
    if (spec && spec.type === 'cli' && !clitools.get(spec.cli)) { delete cfg.downstreamServers[name]; changed = true; continue; }
    if (!spec || spec.type !== 'stdio' || !Array.isArray(spec.args)) continue;
    // Also the newer per-PC copy (<APPDATA>/ai-hub/connectors/cli-bridge.js): one PC's absolute path in
    // the shared config left the Unity bridge pointing at another user's profile on this PC.
    const script = spec.args.find((a) => typeof a === 'string' && /cli-(mcp-)?bridge\.js$/i.test(a));
    if (!script) continue;
    const cliId = spec.args.find((a) => clitools.get(a));
    if (!cliId) continue;
    cfg.downstreamServers[name] = { type: 'cli', cli: cliId, enabled: spec.enabled !== false };
    changed = true;
  }
  if (changed) config.save(cfg);
  return changed;
}

function listConfigured() {
  migrateLegacyBridgeEntries();
  const cfg = config.load();
  return Object.entries(cfg.downstreamServers).map(([name, spec]) => {
    const extra = {};
    const live = connections.get(name);
    if (live && live.protocolEra) extra.protocolEra = live.protocolEra;
    if (spec.type === 'cli') {
      const bin = clitools.detect(spec.cli);
      extra.cliBin = bin || '';
      extra.available = Boolean(bin); // 실행 파일이 이 컴퓨터에 있는지
    }
    // 다른 컴퓨터에서 설정한 서버인데 이 컴퓨터에는 인증정보가 없는 경우를 알린다
    // (연결이 실패한 뒤에야 알게 되면 원인을 찾기 어렵다).
    const miss = missingLocalFields(spec);
    if (miss) extra.missingLocal = miss;
    return { name, ...spec, ...extra, connected: connections.has(name) };
  });
}

/** 공유본이 "필요하다"고 표시했는데 이 컴퓨터에 값이 없는 기기 전용 필드. */
function missingLocalFields(spec) {
  if (!spec || spec.type === 'cli' || !spec.needsLocal) return null;
  const miss = {};
  for (const [f, keys] of Object.entries(spec.needsLocal)) {
    if (!spec[f] || !Object.keys(spec[f]).length) miss[f] = keys;
  }
  return Object.keys(miss).length ? miss : null;
}

/**
 * 이 컴퓨터의 AI 도구들(Claude Code/Antigravity/Gemini)이 등록해 둔 MCP 서버들.
 * 이 설정 파일들은 컴퓨터별이라 **그 컴퓨터에서 실제로 동작하는 값**이 들어 있다 —
 * presets()의 자동 감지와 autofillLocalSecrets()의 인증정보 출처가 모두 여기다.
 * @returns {Map<string, object>} 서버 이름 -> { ...spec, _from: 도구 이름 }
 */
function readToolMcpServers() {
  const fs = require('fs');
  const { detectTargets } = require('./paths');
  const out = new Map();
  for (const t of detectTargets()) {
    try {
      const raw = fs.readFileSync(t.configPath, 'utf8');
      const obj = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      for (const [name, s] of Object.entries(obj.mcpServers || {})) {
        if (s && typeof s === 'object' && !out.has(name)) out.set(name, { ...s, _from: t.name });
      }
    } catch { /* JSON이 아니거나 읽지 못함 — 건너뜀 */ }
  }
  return out;
}

/**
 * 비어 있는 기기 전용 값(headers/env)을 이 컴퓨터의 AI 도구 설정에서 찾아 채운다.
 *
 * 왜 필요한가: 공유 설정에는 시크릿이 실리지 않으므로(config.js의 DOWNSTREAM_LOCAL_FIELDS)
 * 새 컴퓨터에는 서버 골격만 도착한다. 그런데 같은 서버가 그 컴퓨터의 Claude Code나
 * Antigravity 설정에는 동작하는 값과 함께 이미 등록돼 있는 경우가 많다 — 손으로 다시
 * 넣는 대신 같은 이름의 항목에서 가져온다. 이미 값이 있으면 덮어쓰지 않는다.
 *
 * @returns {{filled: object[], missing: object[]}} 채운 것과, 못 채워 손입력이 필요한 것
 */
function autofillLocalSecrets({ dryRun = false } = {}) {
  const cfg = config.load();
  const fromTools = readToolMcpServers();
  const filled = [];
  const missing = [];
  for (const [name, spec] of Object.entries(cfg.downstreamServers || {})) {
    if (spec.type === 'cli') continue; // 연결 시 resolveSpec()이 매번 찾는다 — 저장할 값이 없다
    const src = fromTools.get(name);
    for (const f of config.DOWNSTREAM_LOCAL_FIELDS) {
      if (spec[f] && Object.keys(spec[f]).length) continue; // 이미 있음
      const cand = src && src[f] && typeof src[f] === 'object' && Object.keys(src[f]).length ? src[f] : null;
      if (cand) {
        if (!dryRun) spec[f] = { ...cand };
        filled.push({ server: name, field: f, keys: Object.keys(cand), from: src._from });
      } else if (spec.needsLocal && spec.needsLocal[f]) {
        missing.push({ server: name, field: f, keys: spec.needsLocal[f] });
      }
    }
  }
  if (filled.length && !dryRun) config.save(cfg);
  return { filled, missing };
}

function addServer(name, spec) {
  if (!/^[\w-]{1,64}$/.test(name)) throw new Error('Server name must be alphanumeric/dash/underscore.');
  if (spec.type === 'stdio') {
    if (!spec.command) throw new Error('stdio server needs a command.');
  } else if (spec.type === 'http') {
    if (!/^https?:\/\//.test(spec.url || '')) throw new Error('http server needs a valid url.');
  } else if (spec.type === 'cli') {
    if (!clitools.get(spec.cli)) {
      throw new Error(`알 수 없는 CLI 도구: ${spec.cli} (가능: ${clitools.ids().join(', ')})`);
    }
  } else {
    throw new Error('type must be stdio, http, or cli.');
  }
  const cfg = config.load();
  cfg.downstreamServers[name] = spec.type === 'cli'
    // CLI는 도구 id만 저장한다. 명령·경로는 컴퓨터마다 다르므로 연결할 때 만든다.
    ? { type: 'cli', cli: spec.cli, enabled: spec.enabled !== false }
    : {
      type: spec.type,
      command: spec.command || undefined,
      args: Array.isArray(spec.args) ? spec.args : undefined,
      env: spec.env && typeof spec.env === 'object' ? spec.env : undefined,
      url: spec.url || undefined,
      headers: spec.headers && typeof spec.headers === 'object' ? spec.headers : undefined,
      protocolMode: ['auto', 'modern', 'legacy'].includes(spec.protocolMode) ? spec.protocolMode : 'auto',
      enabled: spec.enabled !== false,
    };
  config.save(cfg);
  return listConfigured();
}

async function removeServer(name) {
  await disconnect(name);
  const cfg = config.load();
  delete cfg.downstreamServers[name];
  config.save(cfg);
  return listConfigured();
}

async function connect(name) {
  if (connections.has(name)) return { name, alreadyConnected: true };
  const stored = config.load().downstreamServers[name];
  if (!stored) throw new Error(`Unknown downstream server: ${name}`);
  if (stored.enabled === false) throw new Error(`Server "${name}" is disabled.`);
  const spec = resolveSpec(stored);

  const protocolMode = stored.protocolMode || 'auto';
  const versionMode = protocolMode === 'modern' ? { pin: '2026-07-28' } : protocolMode;
  const client = new Client(
    { name: 'ai-hub', version: require('../../package.json').version },
    { versionNegotiation: { mode: versionMode }, cachePartition: name, defaultCacheTtlMs: 0 }
  );
  let transport;
  if (spec.type === 'stdio') {
    transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args || [],
      env: { ...process.env, ...(spec.env || {}) },
      stderr: 'ignore',
    });
  } else {
    transport = new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: spec.headers ? { headers: spec.headers } : undefined,
    });
  }
  try {
    await client.connect(transport);
  } catch (err) {
    throw friendlyConnectError(name, spec, err);
  }
  connections.set(name, { client, transportType: spec.type, protocolEra: client.getProtocolEra(), connectedAt: Date.now() });
  dropped.delete(name);
  client.onclose = () => {
    if (connections.has(name)) {
      connections.delete(name);
      dropped.add(name); // lost unexpectedly -> eligible for auto-reconnect
    }
  };
  return { name, connected: true, protocolEra: client.getProtocolEra() };
}

async function disconnect(name) {
  const conn = connections.get(name);
  connections.delete(name); // delete first so onclose doesn't mark it dropped
  dropped.delete(name);
  if (!conn) return { name, connected: false };
  try {
    await conn.client.close();
  } catch {
    /* already closed */
  }
  return { name, connected: false };
}

async function ensureConnected(name) {
  if (!connections.has(name)) await connect(name);
  return connections.get(name).client;
}

const STALE_RE = /closed|fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|terminated|aborted/i;

/** Run an operation against a downstream client, reconnecting once if the
 *  connection turned out to be stale (e.g. the editor was restarted). */
async function withClient(name, op) {
  let client = await ensureConnected(name);
  try {
    return await op(client);
  } catch (err) {
    if (!STALE_RE.test(String(err.message || err))) throw err;
    await disconnect(name);
    client = await ensureConnected(name); // throws friendly error if truly down
    return op(client);
  }
}

async function listTools(name) {
  const res = await withClient(name, (c) => c.listTools());
  return res.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

async function callTool(name, toolName, args) {
  return withClient(name, (c) => c.callTool({ name: toolName, arguments: args || {} }));
}

/** Try to re-establish connections that dropped unexpectedly (best-effort). */
async function reconnectDropped() {
  const results = [];
  for (const name of [...dropped]) {
    try {
      await connect(name);
      results.push({ name, reconnected: true });
    } catch {
      results.push({ name, reconnected: false });
    }
  }
  return results;
}

/**
 * Seed Unity/Unreal presets. First scans the MCP configs of AIs already on
 * this machine and re-offers any unity/unreal servers found there (so paths
 * are auto-detected per computer); falls back to generic defaults.
 */
function presets() {
  const found = [];
  for (const [name, s] of readToolMcpServers()) {
    if (!/unity|unreal/i.test(name)) continue;
    const url = s.url || s.httpUrl || s.serverUrl;
    found.push({
      name,
      label: `${name} (${s._from}에서 감지됨)`,
      // 감지된 인증 헤더도 같이 가져온다 — 그 도구에서 동작하던 값이다.
      spec: url
        ? { type: 'http', url, headers: s.headers, enabled: true }
        : { type: 'stdio', command: s.command, args: s.args || [], env: s.env, enabled: true },
      note: `${s._from} 설정에서 자동 감지된 서버입니다.`,
    });
  }
  if (!found.some((f) => /unity/i.test(f.name))) {
    found.push({
      name: 'unity-mcp',
      label: 'Unity (MCP for Unity, 기본값)',
      spec: { type: 'http', url: 'http://127.0.0.1:8080/mcp', enabled: true },
      note: 'Unity 에디터에서 MCP for Unity 플러그인이 실행 중이어야 합니다. 참고: https://github.com/Jun1188/UnityForMCP.git',
    });
  }
  if (!found.some((f) => /unreal/i.test(f.name))) {
    found.push({
      name: 'unreal-mcp',
      label: 'Unreal Engine (기본값)',
      spec: { type: 'http', url: 'http://127.0.0.1:55557/mcp', enabled: true },
      note: 'Unreal 에디터의 MCP 플러그인 설정에 맞게 URL 또는 명령을 수정하세요.',
    });
  }
  // CLI 도구(Unity CLI / Antigravity CLI)를 MCP 동등 커넥터로 제안한다.
  // 이미 등록된 것은 빼고, 이 컴퓨터에서 실행 파일이 발견된 것만.
  const configured = config.load().downstreamServers || {};
  for (const t of clitools.list()) {
    if (Object.values(configured).some((s) => s.type === 'cli' && s.cli === t.id)) continue;
    found.push({
      name: t.id,
      label: `${t.label}${t.available ? '' : ' (실행 파일 미발견)'}`,
      spec: { type: 'cli', cli: t.id, enabled: true },
      note: t.available
        ? `${t.bin} 를 MCP 툴 ${t.toolNames.length}개로 감싸 연결합니다.`
        : `${t.label}을 설치한 뒤 다시 시도하거나 환경변수로 경로를 지정하세요.`,
    });
  }
  return found;
}

async function closeAll() {
  for (const name of [...connections.keys()]) await disconnect(name);
}

module.exports = {
  listConfigured, addServer, removeServer, connect, disconnect, listTools, callTool,
  presets, closeAll, reconnectDropped, resolveSpec, migrateLegacyBridgeEntries,
  autofillLocalSecrets, readToolMcpServers, missingLocalFields,
};

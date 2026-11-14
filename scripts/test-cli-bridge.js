#!/usr/bin/env node
// CLI 브리지 테스트 — Unity/Antigravity CLI를 MCP 서버로 감싸는 경로를 검증한다.
//
// 핵심 관심사는 "다른 컴퓨터에서도 되는가"다. 예전에는 브리지 스크립트의 절대경로가
// 공유 설정에 박혀 있어서 반대편 컴퓨터에서는 없는 파일을 가리켰다.
'use strict';

const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const clitools = require(path.join(appRoot, 'src', 'core', 'clitools.js'));
const downstream = require(path.join(appRoot, 'src', 'core', 'downstream.js'));
const config = require(path.join(appRoot, 'src', 'core', 'config.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/** 브리지를 띄워 JSON-RPC 핸드셰이크 + tools/list를 실제로 주고받는다. */
function handshake(cliId) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [path.join(appRoot, 'src', 'mcp', 'cli-bridge.js'), cliId], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    const seen = {};
    const timer = setTimeout(() => { child.kill(); resolve({ error: 'timeout', seen }); }, 15000);

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          seen.serverName = msg.result && msg.result.serverInfo && msg.result.serverInfo.name;
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }) + '\n');
        } else if (msg.id === 2) {
          seen.tools = (msg.result && msg.result.tools || []).map((t) => t.name);
          clearTimeout(timer);
          child.kill();
          resolve({ seen });
        }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ error: String(e.message), seen }); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }) + '\n');
  });
}

async function main() {
  console.log('1) CLI 실행 파일 자동 감지');
  const tools = clitools.list();
  for (const t of tools) {
    console.log(`  · ${t.label}: ${t.available ? t.bin : '미발견'}`);
  }
  // 1.29.0: Antigravity CLI 작업자 커넥터는 뺐다. Unity CLI 브리지만 남는다.
  check('카탈로그는 unity만', clitools.ids().join(',') === 'unity', clitools.ids().join(', '));

  console.log('2) 브리지 파일이 앱 안에 있는가 (다른 컴퓨터로 따라가야 함)');
  const bridge = path.join(appRoot, 'src', 'mcp', 'cli-bridge.js');
  check('src/mcp/cli-bridge.js 존재', fs.existsSync(bridge));
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  check('빌드에 src/**가 포함됨', (pkg.build.files || []).some((f) => f.startsWith('src/')));

  console.log('3) 설정에 컴퓨터 고유 절대경로가 없는가');
  // 1.29.0에서 뺀 Antigravity CLI 커넥터 항목이 공유 설정에 남아 있던 경우(2026-10-18 이 PC에서 확인)
  const stale = config.load();
  stale.downstreamServers = { ...(stale.downstreamServers || {}), antigravity: { type: 'cli', cli: 'antigravity', enabled: true } };
  config.save(stale);
  downstream.migrateLegacyBridgeEntries();
  check('카탈로그에서 빠진 CLI 항목은 지움', !(config.load().downstreamServers || {}).antigravity);
  const configured = downstream.listConfigured();
  const cliEntries = configured.filter((s) => s.type === 'cli');
  console.log(`  · 등록된 CLI 커넥터: ${cliEntries.map((s) => s.name).join(', ') || '없음'}`);
  const shared = config.load().downstreamServers || {};
  const absolutePaths = Object.entries(shared)
    .filter(([, s]) => s.type === 'cli' && JSON.stringify(s).includes(':\\'))
    .map(([n]) => n);
  check('CLI 항목에 절대경로 미저장', absolutePaths.length === 0, absolutePaths.join(', '));
  const legacy = Object.entries(shared).filter(([, s]) =>
    s.type === 'stdio' && JSON.stringify(s.args || []).includes('cli-mcp-bridge'));
  check('예전 브리지 절대경로 항목 없음(마이그레이션됨)', legacy.length === 0,
    legacy.map(([n]) => n).join(', '));

  console.log('4) 실행 시점에 명령이 올바르게 만들어지는가');
  const resolved = downstream.resolveSpec({ type: 'cli', cli: 'unity', enabled: true });
  const unityBin = clitools.detect('unity');
  check('stdio로 펼쳐짐', resolved.type === 'stdio');
  check('브리지 스크립트를 가리킴',
    String(resolved.args[0]).endsWith(path.join('src', 'mcp', 'cli-bridge.js')), resolved.args[0]);
  check('찾은 CLI 경로만 환경변수로 전달됨', unityBin ? resolved.env.UNITY_BIN === unityBin : !('UNITY_BIN' in (resolved.env || {})),
    JSON.stringify(resolved.env || {}));

  console.log('5) 실제 핸드셰이크 (프로세스를 띄워 JSON-RPC 주고받기)');
  for (const id of ['unity']) {
    const r = await handshake(id);
    const def = clitools.get(id);
    check(`${def.label} initialize + tools/list`,
      !r.error && r.seen.serverName === def.serverName && (r.seen.tools || []).length === def.tools.length,
      r.error || JSON.stringify(r.seen));
    if (r.seen && r.seen.tools) console.log(`     툴: ${r.seen.tools.join(', ')}`);
  }

  console.log('');
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('테스트 예외:', e); process.exit(1); });

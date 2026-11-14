#!/usr/bin/env node
// CLI 커넥터 등록 테스트 — 임시 HOME/APPDATA로 격리해 실제 설정 파일을 건드리지 않는다.
//
// 핵심 관심사:
//   · 브리지가 로컬 디스크에 설치되고, 그 사본만으로 단독 실행되는가
//   · 옛 경로(~/.mcp-connectors) 등록을 알아보고 옮기는가
//   · 옮길 때 남의 설정 항목과 커넥터 이름을 보존하는가
//   · 등록 안 된 도구에 멋대로 만들지 않는가
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const appRoot = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/** 임시 HOME/APPDATA로 모듈을 새로 읽는다. */
function freshConnectors(home) {
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
  for (const m of ['paths', 'config', 'clitools', 'registrar', 'connectors']) {
    delete require.cache[require.resolve(path.join(appRoot, 'src', 'core', `${m}.js`))];
  }
  return require(path.join(appRoot, 'src', 'core', 'connectors.js'));
}

/** 설치된 브리지를 그 자리에서 띄워 tools/list까지 주고받는다. */
function handshakeAt(bridgePath, cliId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bridgePath, cliId], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let stderr = '';
    const done = (v) => { clearTimeout(timer); child.kill(); resolve(v); };
    const timer = setTimeout(() => done({ error: 'timeout', stderr }), 15000);
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 })}\n`);
        } else if (msg.id === 2) {
          done({ tools: (msg.result.tools || []).map((t) => t.name), stderr });
        }
      }
    });
    child.on('error', (e) => done({ error: String(e.message), stderr }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} })}\n`);
  });
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-conn-'));
  const connectors = freshConnectors(home);

  console.log('1) 브리지 설치');
  const inst = connectors.install();
  check('브리지 복사됨', fs.existsSync(inst.bridge), inst.bridge);
  check('clitools.js도 나란히 복사됨', fs.existsSync(path.join(inst.dir, 'clitools.js')));
  // 브리지가 require 하는 것은 전부 같이 와야 한다 — 하나라도 빠지면 설치된 사본이
  // MODULE_NOT_FOUND로 죽고, 그 도구의 MCP 서버가 통째로 안 뜬다.
  check('console-text.js도 나란히 복사됨', fs.existsSync(path.join(inst.dir, 'console-text.js')));
  check('로컬 디스크(APPDATA)에 설치', inst.dir.includes('AppData'), inst.dir);
  check('첫 설치는 브리지 의존 파일 전부 갱신', inst.updated.length === 3, inst.updated.join(','));
  const again = connectors.install();
  check('내용 같으면 다시 쓰지 않음', again.updated.length === 0, again.updated.join(','));
  const tmpLeft = fs.readdirSync(inst.dir).filter((f) => f.includes('.tmp-'));
  check('임시 파일 잔재 없음', tmpLeft.length === 0, tmpLeft.join(','));

  console.log('2) 설치된 사본만으로 단독 실행');
  {
    const r = await handshakeAt(inst.bridge, 'unity');
    check('앱 폴더 없이도 핸드셰이크 성공', !r.error && (r.tools || []).length === 4,
      r.error || (r.stderr || '').slice(0, 200));
    if (r.tools) console.log(`     툴: ${r.tools.join(', ')}`);
  }

  console.log('3) 실행 사양');
  {
    const s = connectors.spec('unity');
    check('설치된 브리지를 지목', s.args[0] === inst.bridge, s.args[0]);
    check('CLI id를 인자로 전달', s.args[1] === 'unity');
    check('동기화 폴더를 가리키지 않음', !s.args[0].startsWith('G:'), s.args[0]);
    let threw = false;
    try { connectors.spec('nope'); } catch { threw = true; }
    check('모르는 CLI는 거부', threw);
  }

  console.log('4) 등록 상태 분류');
  {
    check('옛 경로 인식', connectors.classify({
      args: ['C:\\Users\\x\\.mcp-connectors\\cli-mcp-bridge.js', 'unity'],
    }) === 'legacy');
    check('설치본 인식', connectors.classify({ args: [inst.bridge, 'unity'] }) === 'installed');
    check('앱 소스 직접 지목 인식', connectors.classify({
      args: [path.join(appRoot, 'src', 'mcp', 'cli-bridge.js'), 'unity'],
    }) === 'app-source');
    check('남의 서버는 other', connectors.classify({ args: ['C:\\other\\thing.js'] }) === 'other');
  }

  console.log('5) 옛 경로 등록을 옮긴다');
  {
    // Claude Code 설정을 흉내낸다: 우리 항목 + 남의 항목.
    const claudeJson = path.join(home, '.claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({
      someOtherSetting: { keep: true },
      mcpServers: {
        'ai-hub': { type: 'stdio', command: 'node', args: ['X:\\hub\\stdio-entry.js'] },
        unity: {
          type: 'stdio',
          command: 'node',
          args: ['C:\\Users\\x\\.mcp-connectors\\cli-mcp-bridge.js', 'unity'],
        },
      },
    }, null, 2), 'utf8');

    const before = connectors.status().find((t) => t.id === 'claude-code');
    check('이전 필요로 표시', before && before.needsMigration === true, JSON.stringify(before));

    const dry = connectors.migrate({ dryRun: true });
    check('미리보기는 파일을 바꾸지 않음',
      JSON.parse(fs.readFileSync(claudeJson, 'utf8')).mcpServers.unity.args[0].includes('.mcp-connectors'));
    check('이전 계획에 unity 포함', dry.planned.some((p) => p.cli === 'unity'), JSON.stringify(dry.planned));

    const res = connectors.migrate();
    const after = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    check('이전 성공', res.migrated.every((m) => m.ok), JSON.stringify(res.migrated));
    check('설치된 브리지를 가리킴', after.mcpServers.unity.args[0] === inst.bridge,
      after.mcpServers.unity.args[0]);
    check('커넥터 이름 유지', Boolean(after.mcpServers.unity));
    check('허브 등록 항목 보존', after.mcpServers['ai-hub'].args[0] === 'X:\\hub\\stdio-entry.js');
    check('설정의 다른 키 보존', after.someOtherSetting.keep === true);
    check('백업 파일 생성', fs.readdirSync(home).some((f) => f.startsWith('.claude.json.') && f.endsWith('.bak')),
      fs.readdirSync(home).join(','));
    check('이전 후에는 더 옮길 게 없음', connectors.migrate({ dryRun: true }).planned.length === 0);
  }

  console.log('6) 등록 안 된 도구에는 만들지 않는다');
  {
    const geminiDir = path.join(home, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(path.join(geminiDir, 'settings.json'), JSON.stringify({ mcpServers: {} }), 'utf8');
    connectors.migrate();
    const g = JSON.parse(fs.readFileSync(path.join(geminiDir, 'settings.json'), 'utf8'));
    check('커넥터를 새로 추가하지 않음', Object.keys(g.mcpServers).length === 0, JSON.stringify(g.mcpServers));
  }

  console.log('7) 명시적 등록/해제');
  {
    const r = connectors.register('gemini-cli', 'unity');
    const g = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8'));
    check('등록됨', Boolean(g.mcpServers.unity), JSON.stringify(g.mcpServers));
    check('Gemini 포맷(type: stdio)', g.mcpServers.unity.type === 'stdio');
    check('반환값에 cli 포함', r.cli === 'unity');
    connectors.unregister('gemini-cli', 'unity');
    const g2 = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8'));
    check('해제됨', !g2.mcpServers.unity);
  }

  console.log('8) 깨진 설정 파일은 건드리지 않는다');
  {
    // Antigravity(CLI·앱·IDE)는 MCP 서버를 공유 파일 ~/.gemini/config/mcp_config.json에서 읽는다
    const agDir = path.join(home, '.gemini', 'config');
    fs.mkdirSync(agDir, { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity'), { recursive: true });
    const ag = require(path.join(appRoot, 'src', 'core', 'paths.js')).detectTargets().filter((t) => t.id.startsWith('antigravity'));
    check('Antigravity 두 대상이 같은 공유 파일', ag.length === 2 && ag.every((t) => t.configPath === path.join(agDir, 'mcp_config.json')),
      JSON.stringify(ag.map((t) => t.configPath)));
    check('설치 감지는 도구 자신의 폴더로', ag.find((t) => t.id === 'antigravity').exists && !ag.find((t) => t.id === 'antigravity-ide').exists);
    fs.writeFileSync(path.join(agDir, 'mcp_config.json'), '{ 이건 JSON이 아님', 'utf8');
    const st = connectors.status().find((t) => t.id === 'antigravity');
    check('읽기 실패로 표시', st && st.unreadable === true, JSON.stringify(st));
    let threw = false;
    try { connectors.register('antigravity', 'unity'); } catch { threw = true; }
    check('쓰기 거부(예외)', threw);
    check('파일 원본 유지',
      fs.readFileSync(path.join(agDir, 'mcp_config.json'), 'utf8') === '{ 이건 JSON이 아님');
  }

  console.log('9) TOML 대상(Codex)은 읽기 실패가 아니라 "대상 아님"');
  {
    const codexDir = path.join(home, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'config.toml'), '[mcp_servers.x]\ncommand = "y"\n', 'utf8');
    const st = connectors.status().find((t) => t.id === 'codex');
    check('unsupported로 표시', st && st.unsupported === true, JSON.stringify(st));
    check('읽기 실패로 오인하지 않음', st && st.unreadable === false);
  }

  console.log('10) 허브 등록 방식 파악 + HTTP 일괄 이전');
  {
    const registrar = require(path.join(appRoot, 'src', 'core', 'registrar.js'));
    const targets = require(path.join(appRoot, 'src', 'core', 'paths.js')).detectTargets();
    const byId = (id) => targets.find((t) => t.id === id);
    const claudeJson = path.join(home, '.claude.json');

    check('stdio 등록을 알아본다', registrar.hubMode(byId('claude-code')) === 'stdio',
      registrar.hubMode(byId('claude-code')));
    // 8)에서 일부러 깨뜨린 파일 — "없음"과 구별해야 덮어쓰지 않는다.
    check('읽지 못한 설정은 unreadable', registrar.hubMode(byId('antigravity')) === 'unreadable',
      registrar.hubMode(byId('antigravity')));
    check('등록 안 된 도구는 absent', registrar.hubMode(byId('gemini-cli')) === 'absent',
      registrar.hubMode(byId('gemini-cli')));

    const plan = registrar.migrateToHttp({ dryRun: true });
    check('이전 계획에 stdio 도구만 담긴다',
      plan.planned.length === 1 && plan.planned[0].target === 'claude-code', JSON.stringify(plan.planned));
    check('읽기 실패는 건너뛴 목록에', plan.skipped.some((s) => s.target === 'antigravity'), JSON.stringify(plan.skipped));
    check('미리보기는 파일을 바꾸지 않음',
      JSON.parse(fs.readFileSync(claudeJson, 'utf8')).mcpServers['ai-hub'].command === 'node');

    const res = registrar.migrateToHttp();
    const after = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    const entry = after.mcpServers['ai-hub'];
    check('이전 성공', res.migrated.every((m) => m.ok), JSON.stringify(res.migrated));
    check('HTTP 항목으로 바뀜', entry.type === 'http' && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(entry.url || ''),
      JSON.stringify(entry));
    check('인증 헤더 포함', Boolean(entry.headers && entry.headers.Authorization), JSON.stringify(entry.headers));
    check('같은 파일의 CLI 커넥터 보존', after.mcpServers.unity.args[0] === inst.bridge);
    check('설정의 다른 키 보존', after.someOtherSetting.keep === true);
    check('이전 후 방식이 http', registrar.hubMode(byId('claude-code')) === 'http');
    check('더 옮길 게 없음', registrar.migrateToHttp({ dryRun: true }).planned.length === 0);
    check('깨진 설정 파일은 그대로',
      fs.readFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8') === '{ 이건 JSON이 아님');
    const gemini = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8'));
    check('미등록 도구에는 만들지 않음', !gemini.mcpServers['ai-hub'], JSON.stringify(gemini.mcpServers));
  }

  fs.rmSync(home, { recursive: true, force: true });
  console.log('');
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('테스트 예외:', e); process.exit(1); });

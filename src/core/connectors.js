// CLI 커넥터를 다른 AI 도구(Claude Code / Antigravity / Gemini CLI)에 등록한다.
//
// 왜 "설치"하는가 — 브리지를 어디에서 실행하게 할지의 문제:
//   ① `~/.mcp-connectors/cli-mcp-bridge.js` (예전 방식)
//        앱과 별개 사본이라 앱 쪽 브리지를 고쳐도 외부 도구는 옛 코드를 계속 쓴다.
//   ② 앱 소스 `<앱>/src/mcp/cli-bridge.js`를 직접 지목
//        앱이 Google Drive 동기화 폴더에 있어서, 마운트가 흔들리면 Claude Code의
//        MCP 서버까지 같이 죽는다. 2026-07-26에 G: 드라이브가 통째로 사라진 적 있다.
//   ③ **허브가 로컬 디스크에 복사해 두고 거기를 지목** ← 이 방식
//        %APPDATA%는 항상 빠른 로컬 디스크고, 앱이 뜰 때마다 최신본으로 갱신되므로
//        사본이 갈라지지 않는다. 두 컴퓨터 모두 같은 방식으로 동작한다.
//
// 외부 도구의 설정 파일(~/.claude.json 등)은 **컴퓨터별 파일이라 동기화되지 않는다.**
// 그래서 여기에 절대경로가 들어가는 것은 괜찮다. 문제가 되는 건 허브의 *공유* 설정에
// 절대경로를 넣는 경우다(그건 downstream.js가 type:'cli'로 해결).
'use strict';

const fs = require('fs');
const path = require('path');

const clitools = require('./clitools');
const registrar = require('./registrar');
const { appRoot, hubDataDir, stdioLauncher, detectTargets } = require('./paths');

/** 설치된 브리지가 사는 곳 — 로컬 디스크, 동기화 안 됨. */
const INSTALL_DIR = path.join(hubDataDir(), 'connectors');
const BRIDGE_NAME = 'cli-bridge.js';

/** 예전 방식으로 등록된 항목을 알아보기 위한 표식. */
const LEGACY_BRIDGE_RE = /cli-mcp-bridge\.js$/i;

/** 앱 안 원본 → 설치 위치. 브리지가 나란히 두고 require 하는 것들도 같이 복사한다. */
const INSTALL_FILES = [
  { from: path.join('src', 'mcp', BRIDGE_NAME), to: BRIDGE_NAME },
  { from: path.join('src', 'core', 'clitools.js'), to: 'clitools.js' },
  { from: path.join('src', 'core', 'console-text.js'), to: 'console-text.js' },
];

/**
 * 브리지를 로컬 디스크에 설치(또는 갱신)한다. 내용이 같으면 건너뛴다.
 * 앱 시작 때마다 호출해도 싸다.
 */
function install() {
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  const updated = [];
  for (const f of INSTALL_FILES) {
    const src = path.join(appRoot(), f.from);
    const dst = path.join(INSTALL_DIR, f.to);
    let source;
    try {
      source = fs.readFileSync(src);
    } catch {
      // 앱 소스를 읽지 못하면(동기화 폴더가 잠깐 사라진 경우 등) 기존 설치본을 그대로 둔다.
      continue;
    }
    let current = null;
    try { current = fs.readFileSync(dst); } catch { /* 아직 없음 */ }
    if (current && current.equals(source)) continue;
    // 원자적으로 바꿔치기 — 외부 도구가 반쯤 쓰인 파일을 읽지 않도록.
    const tmp = `${dst}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, source);
    fs.renameSync(tmp, dst);
    updated.push(f.to);
  }
  return { dir: INSTALL_DIR, bridge: path.join(INSTALL_DIR, BRIDGE_NAME), updated };
}

/** 설치된 브리지로 CLI 하나를 띄우는 실행 사양. */
function spec(cliId) {
  const def = clitools.get(cliId);
  if (!def) throw new Error(`알 수 없는 CLI 도구: ${cliId} (가능: ${clitools.ids().join(', ')})`);
  const launcher = stdioLauncher();
  const bin = clitools.detect(cliId);
  return {
    command: launcher.command,
    args: [path.join(INSTALL_DIR, BRIDGE_NAME), cliId],
    env: {
      ...(launcher.env || {}),
      // 실행 파일 위치를 넘겨 두면 브리지가 매번 다시 찾지 않아도 된다.
      // (없으면 브리지가 알아서 탐지하므로 나중에 옮겨도 동작한다.)
      ...(bin ? { [def.envVar]: bin } : {}),
    },
  };
}

function targetById(targetId) {
  const t = detectTargets().find((x) => x.id === targetId);
  if (!t) throw new Error(`알 수 없는 대상: ${targetId}`);
  return t;
}

/**
 * 대상 도구에 CLI 커넥터를 등록한다. 이름은 CLI id를 그대로 쓴다(unity).
 * 기존 항목이 있으면 덮어쓴다 — 예전 절대경로 등록을 이 경로로 옮기는 게 목적이다.
 */
function register(targetId, cliId) {
  install();
  const target = targetById(targetId);
  return { ...registrar.upsertServer(target, cliId, spec(cliId)), cli: cliId };
}

function unregister(targetId, cliId) {
  return registrar.removeServer(targetById(targetId), cliId);
}

/** 이 항목이 설치된 브리지를 가리키는가 / 예전 경로인가 / 남의 것인가. */
function classify(entry) {
  const args = (entry && entry.args) || [];
  const script = args.find((a) => typeof a === 'string' && /\.js$/i.test(a));
  if (!script) return 'other';
  if (LEGACY_BRIDGE_RE.test(script)) return 'legacy';
  const resolved = path.resolve(script);
  if (resolved === path.resolve(path.join(INSTALL_DIR, BRIDGE_NAME))) return 'installed';
  if (resolved === path.resolve(path.join(appRoot(), 'src', 'mcp', BRIDGE_NAME))) return 'app-source';
  return 'other';
}

/**
 * 각 도구에 어떤 CLI 커넥터가 어떤 방식으로 등록돼 있는지.
 * GUI가 "옮기기"를 제안할 수 있게 legacy/app-source를 구분해서 알려준다.
 */
function status() {
  const ids = clitools.ids();
  return detectTargets().map((t) => {
    const servers = registrar.readServers(t);
    const entries = [];
    if (servers) {
      for (const [name, entry] of Object.entries(servers)) {
        const cli = ids.includes(name) ? name : (entry.args || []).find((a) => ids.includes(a));
        if (!cli) continue;
        entries.push({ name, cli, state: classify(entry) });
      }
    }
    return {
      id: t.id,
      name: t.name,
      exists: t.exists,
      // TOML 포맷(Codex)은 CLI 커넥터 등록 대상이 아니다 — 읽기 실패와 구별해서 알린다.
      unsupported: servers === undefined,
      unreadable: servers === null,
      connectors: entries,
      needsMigration: entries.some((e) => e.state === 'legacy' || e.state === 'app-source'),
    };
  });
}

/**
 * 예전 경로(또는 앱 소스 직접 지목)로 등록된 커넥터를 설치된 브리지로 옮긴다.
 * 등록되어 있지 않은 도구에는 새로 만들지 않는다 — 사용자가 안 쓰는 도구에
 * 멋대로 서버를 추가하지 않기 위해서다.
 */
function migrate({ dryRun = false } = {}) {
  install();
  const planned = [];
  for (const t of status()) {
    for (const e of t.connectors) {
      if (e.state !== 'legacy' && e.state !== 'app-source') continue;
      planned.push({ target: t.id, targetName: t.name, name: e.name, cli: e.cli, from: e.state });
    }
  }
  if (dryRun) return { migrated: [], planned };
  const migrated = [];
  for (const p of planned) {
    try {
      const target = targetById(p.target);
      // 항목 이름은 그대로 두고 실행 경로만 바꾼다(도구 쪽 권한 설정을 보존하기 위해).
      registrar.upsertServer(target, p.name, spec(p.cli));
      migrated.push({ ...p, ok: true });
    } catch (err) {
      migrated.push({ ...p, ok: false, error: String((err && err.message) || err) });
    }
  }
  return { migrated, planned };
}

module.exports = {
  install, spec, register, unregister, status, migrate, classify,
  INSTALL_DIR, BRIDGE_NAME,
};

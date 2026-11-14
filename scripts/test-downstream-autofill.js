#!/usr/bin/env node
// 다운스트림 서버의 기기 전용 인증정보(headers/env) 자동 감지 테스트.
//
// 시나리오: 컴퓨터 A가 인증 헤더를 넣어 서버를 등록하면 공유 설정에는 골격 + "무엇이
// 필요한지"만 실려 나간다(값 없음). 컴퓨터 B는 그 골격을 받는데, 같은 이름의 서버가
// B의 Claude Code 설정에 이미 동작하는 값과 함께 등록돼 있으면 그걸 가져와 채운다.
//
// APPDATA/USERPROFILE을 임시 폴더로 돌려 실제 사용자 설정을 건드리지 않는다
// (paths.js는 os.homedir()를 쓰고, Windows에서 이는 USERPROFILE을 따른다).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const appRoot = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/** 격리된 APPDATA + HOME으로 노드 코드를 돌린다. */
function runIsolated(code, sandbox) {
  return spawnSync(process.execPath, ['-e', code], {
    cwd: appRoot,
    encoding: 'utf8',
    env: { ...process.env, APPDATA: sandbox, USERPROFILE: sandbox, HOME: sandbox },
  });
}

function dataDir(sandbox) {
  return path.join(sandbox, 'ai-hub');
}

function main() {
  console.log('1) 공유본에는 값 없이 "필요한 필드 이름"만 남는다');
  const pcA = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-autofill-A-'));
  let r = runIsolated(`
    const c = require('./src/core/config');
    c.update({ downstreamServers: { 'unreal-mcp': { type: 'http', url: 'http://127.0.0.1:55557/mcp',
      headers: { Authorization: 'Bearer PC-A-TOKEN' }, enabled: true } } });
  `, pcA);
  const sharedA = JSON.parse(fs.readFileSync(path.join(dataDir(pcA), 'config.cache.json'), 'utf8'));
  const specA = sharedA.downstreamServers['unreal-mcp'];
  check('공유본에 토큰 값이 없음', !JSON.stringify(sharedA).includes('PC-A-TOKEN'), JSON.stringify(specA));
  check('필요한 필드/키 이름은 남음',
    specA.needsLocal && Array.isArray(specA.needsLocal.headers) && specA.needsLocal.headers.includes('Authorization'),
    JSON.stringify(specA.needsLocal));

  console.log('2) 컴퓨터 B: 인증정보 없이 골격만 받은 상태를 알아본다');
  const pcB = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-autofill-B-'));
  fs.mkdirSync(dataDir(pcB), { recursive: true });
  // A의 공유본이 동기화로 도착한 상황을 재현.
  fs.writeFileSync(path.join(dataDir(pcB), 'config.cache.json'), JSON.stringify(sharedA), 'utf8');
  r = runIsolated(`
    const ds = require('./src/core/downstream');
    const s = ds.listConfigured().find((x) => x.name === 'unreal-mcp');
    console.log('MISSING=' + JSON.stringify(s && s.missingLocal));
  `, pcB);
  check('빠진 기기 전용 필드를 목록에 표시', /MISSING=\{"headers":\["Authorization"\]\}/.test(r.stdout),
    (r.stdout + r.stderr).slice(0, 200));

  console.log('3) 감지할 곳이 없으면 missing으로 보고 (덮어쓰지 않음)');
  r = runIsolated(`
    const ds = require('./src/core/downstream');
    const out = ds.autofillLocalSecrets();
    console.log('R=' + JSON.stringify(out));
  `, pcB);
  check('채운 것 없음 + missing 보고', /"filled":\[\]/.test(r.stdout) && /"missing":\[\{"server":"unreal-mcp"/.test(r.stdout),
    r.stdout.slice(0, 200));

  console.log('4) 컴퓨터 B의 Claude Code 설정에 같은 서버가 있으면 가져온다');
  // ~/.claude.json (detectTargets의 claude-code 대상)
  fs.writeFileSync(path.join(pcB, '.claude.json'), JSON.stringify({
    mcpServers: {
      'unreal-mcp': { type: 'http', url: 'http://127.0.0.1:55557/mcp', headers: { Authorization: 'Bearer PC-B-TOKEN' } },
    },
  }), 'utf8');
  r = runIsolated(`
    const ds = require('./src/core/downstream');
    const out = ds.autofillLocalSecrets();
    console.log('FILLED=' + JSON.stringify(out.filled));
    const c = require('./src/core/config');
    console.log('TOKEN=' + c.reload().downstreamServers['unreal-mcp'].headers.Authorization);
  `, pcB);
  check('로컬 AI 도구 설정에서 헤더를 가져옴', /FILLED=\[\{"server":"unreal-mcp","field":"headers"/.test(r.stdout),
    r.stdout.slice(0, 250));
  check('가져온 값은 그 컴퓨터의 것(A의 토큰이 아님)',
    r.stdout.includes('TOKEN=Bearer PC-B-TOKEN'), r.stdout.slice(0, 250));
  const localB = fs.readFileSync(path.join(dataDir(pcB), 'config.local.json'), 'utf8');
  const sharedB = fs.readFileSync(path.join(dataDir(pcB), 'config.cache.json'), 'utf8');
  check('채운 값은 기기 전용 파일에만 저장', localB.includes('PC-B-TOKEN') && !sharedB.includes('PC-B-TOKEN'),
    sharedB.slice(0, 200));

  console.log('5) 이미 값이 있으면 덮어쓰지 않는다');
  fs.writeFileSync(path.join(pcB, '.claude.json'), JSON.stringify({
    mcpServers: { 'unreal-mcp': { type: 'http', url: 'x', headers: { Authorization: 'Bearer OTHER' } } },
  }), 'utf8');
  r = runIsolated(`
    const ds = require('./src/core/downstream');
    const out = ds.autofillLocalSecrets();
    const c = require('./src/core/config');
    console.log('R=' + JSON.stringify(out.filled) + ' TOKEN=' + c.reload().downstreamServers['unreal-mcp'].headers.Authorization);
  `, pcB);
  check('기존 값 유지 + 새로 채우지 않음',
    /R=\[\] TOKEN=Bearer PC-B-TOKEN/.test(r.stdout), r.stdout.slice(0, 200));

  console.log('6) CLI 커넥터는 대상이 아니다 (연결 시 매번 감지)');
  const pcC = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-autofill-C-'));
  r = runIsolated(`
    const c = require('./src/core/config');
    c.update({ downstreamServers: { unity: { type: 'cli', cli: 'unity', enabled: true } } });
    const ds = require('./src/core/downstream');
    const s = ds.listConfigured().find((x) => x.name === 'unity');
    console.log('R=' + JSON.stringify(ds.autofillLocalSecrets()) + ' MISS=' + JSON.stringify(s.missingLocal));
  `, pcC);
  check('CLI 항목은 채우지도, 누락으로 표시하지도 않음',
    /"filled":\[\],"missing":\[\]/.test(r.stdout) && /MISS=undefined/.test(r.stdout), r.stdout.slice(0, 200));

  console.log('7) 정리');
  for (const d of [pcA, pcB, pcC]) fs.rmSync(d, { recursive: true, force: true });
  check('임시 폴더 삭제', ![pcA, pcB, pcC].some((d) => fs.existsSync(d)));

  console.log('');
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();

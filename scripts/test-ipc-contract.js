#!/usr/bin/env node
// IPC 계약 테스트: preload가 노출한 채널마다 실제 핸들러가 있는지 확인한다.
//
// IPC 핸들러를 electron/ipc/ 로 쪼갤 때 채널 하나를 빠뜨리면 앱은 정상적으로 뜨고
// 그 버튼을 누를 때서야 "No handler registered" 오류가 난다. 정적으로 잡는다.
'use strict';

const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const electronDir = path.join(appRoot, 'electron');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function readAll(files) {
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

function collect(source, pattern) {
  const found = new Set();
  let m;
  const re = new RegExp(pattern, 'g');
  while ((m = re.exec(source)) !== null) found.add(m[1]);
  return found;
}

function handlerFiles() {
  const ipcDir = path.join(electronDir, 'ipc');
  const files = [path.join(electronDir, 'main.js'), path.join(appRoot,'src/mcp/harness-panel-actions.js')];
  for (const name of fs.readdirSync(ipcDir)) {
    if (name.endsWith('.js')) files.push(path.join(ipcDir, name));
  }
  return files;
}

function main() {
  const preload = fs.readFileSync(path.join(electronDir, 'preload.cjs'), 'utf8');
  const handlerSource = readAll(handlerFiles());

  // preload: invoke('channel')  /  main+ipc: handle('channel'
  const exposed = collect(preload, "invoke\\('([^']+)'\\)");
  const registered = collect(handlerSource, "handle\\('([^']+)'");

  console.log(`preload 노출 채널 ${exposed.size}개 / 등록된 핸들러 ${registered.size}개`);

  console.log('1) preload가 부르는 채널에 핸들러가 있는가');
  const missing = [...exposed].filter((c) => !registered.has(c));
  check(`누락된 핸들러 없음`, missing.length === 0, missing.join(', '));

  console.log('2) 등록만 해두고 아무도 안 쓰는 핸들러');
  // 이벤트 전용 채널이나 내부용은 preload에 없을 수 있으니 경고만 낸다.
  const unused = [...registered].filter((c) => !exposed.has(c));
  if (unused.length) console.log(`  · 참고: preload에 없는 핸들러 ${unused.length}개 — ${unused.join(', ')}`);
  else console.log('  · 없음');

  console.log('3) 채널 중복 등록');
  const dupes = [];
  const seen = new Set();
  const re = /handle\('([^']+)'/g;
  let m;
  while ((m = re.exec(handlerSource)) !== null) {
    if (seen.has(m[1])) dupes.push(m[1]);
    seen.add(m[1]);
  }
  check('중복 등록 없음', dupes.length === 0, dupes.join(', '));

  console.log('4) 렌더러 이벤트 채널 짝 맞추기');
  // preload의 on('x') 과 메인의 send('x')/sendToWindow('x') 가 서로 맞는지.
  const listened = collect(preload, "ipcRenderer\\.on\\('([^']+)'");
  const emitted = new Set([
    ...collect(handlerSource, "sendToWindow\\('([^']+)'"),
    ...collect(handlerSource, "send\\('([^']+)'"),
  ]);
  // 파이프라인은 pipeline.js가 emitter로 직접 쏘므로 예외.
  const emitterChannels = ['pipeline:log', 'pipeline:status'];
  const orphanListeners = [...listened].filter(
    (c) => !emitted.has(c) && !emitterChannels.includes(c),
  );
  check('짝 없는 이벤트 리스너 없음', orphanListeners.length === 0, orphanListeners.join(', '));

  console.log('5) 도메인 모듈이 모두 등록되는가');
  const registerSource = fs.readFileSync(path.join(electronDir, 'ipc', 'register-handlers.js'), 'utf8');
  const ipcModules = fs.readdirSync(path.join(electronDir, 'ipc'))
    .filter((n) => n.endsWith('.js') && n !== 'register-handlers.js')
    .map((n) => n.replace(/\.js$/, ''));
  const notRegistered = ipcModules.filter((n) => !registerSource.includes(`./${n}`));
  check('ipc/ 모듈이 전부 register-handlers에 연결됨', notRegistered.length === 0, notRegistered.join(', '));

  console.log('');
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();

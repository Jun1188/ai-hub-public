#!/usr/bin/env node
// 자식 프로세스 출력 인코딩 회귀 테스트.
//
// 이 버그는 **한글 경로가 없으면 영원히 안 보인다.** ASCII만 쓰는 컴퓨터에서는
// 멀쩡하다가, 한글 경로에 UE/Unity를 깔거나 CLI가 한글 오류를 내는 순간 조용히
// 깨진다. 그래서 실제 CP949 바이트를 고정 픽스처로 박아 두고 검사한다 —
// 이 테스트가 도는 컴퓨터의 코드페이지와 무관하게 항상 같은 것을 확인한다.
'use strict';

const path = require('path');
const consoleText = require('../src/core/console-text');

let failed = 0;
function check(name, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failed++;
}

// 실측 바이트(2026-07-30): cmd가 낸 "다른 컴퓨터"의 CP949 인코딩.
const CP949_KOREAN = Buffer.from('b4d9b8a520c4c4c7bbc5cd', 'hex');
const UTF8_KOREAN = Buffer.from('다른 컴퓨터', 'utf8');

console.log('=== UTF-8 출력은 건드리지 않는다 ===');
check('UTF-8 한글 그대로', consoleText.decode(UTF8_KOREAN) === '다른 컴퓨터');
check('ASCII 그대로', consoleText.decode(Buffer.from('C:\\Program Files\\node.exe')) === 'C:\\Program Files\\node.exe');
check('빈 버퍼는 빈 문자열', consoleText.decode(Buffer.alloc(0)) === '');
// vswhere·lms는 UTF-8 JSON을 낸다. 무조건 CP949로 읽으면 이쪽이 깨진다.
check('UTF-8 JSON이 파싱된다', JSON.parse(consoleText.decode(Buffer.from(JSON.stringify({ p: '한글경로' }), 'utf8'))).p === '한글경로');

console.log('');
console.log('=== 콘솔 코드페이지 출력은 되살린다 ===');
{
  const decoded = consoleText.decode(CP949_KOREAN);
  check('U+FFFD가 남지 않는다', !decoded.includes('\uFFFD'));
  // 이 컴퓨터가 949가 아니면 글자까지는 못 맞힌다 — 그 경우 폴백이 바이트를
  // 보존하는지만 본다(깨진 채 조용히 통과하지 않는 것이 핵심).
  const cp949Machine = decoded === '다른 컴퓨터';
  check(cp949Machine ? 'CP949 → "다른 컴퓨터"' : `CP949가 아닌 컴퓨터: 바이트 보존 (${JSON.stringify(decoded)})`,
    cp949Machine || decoded.length === CP949_KOREAN.length);
}

console.log('');
console.log('=== 입력 형태에 관계없이 안전하다 ===');
check('문자열은 그대로', consoleText.decode('이미 문자열') === '이미 문자열');
check('null → 빈 문자열', consoleText.decode(null) === '');
check('undefined → 빈 문자열', consoleText.decode(undefined) === '');

console.log('');
console.log('=== 코드페이지 매핑 ===');
check('949 → euc-kr (Node는 cp949를 모른다)', consoleText.DECODER_LABELS[949] === 'euc-kr');
check('65001 → utf-8', consoleText.DECODER_LABELS[65001] === 'utf-8');
check('폴백은 단일바이트라 어떤 입력도 던지지 않는다', typeof consoleText.FALLBACK_LABEL === 'string');
check('RAW_OUTPUT은 버퍼를 요구한다', consoleText.RAW_OUTPUT.encoding === 'buffer');

console.log('');
console.log('=== 출력을 파싱하는 곳이 전부 디코더를 거친다 ===');
// 소스 지문: execFile 결과를 문자열로 바로 받으면(encoding 기본 utf8) 다시 깨진다.
// 새 호출부를 추가할 때 이 검사가 잡는다.
{
  const fs = require('fs');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  const projects = read('src/core/projects.js');
  // execFileAsync를 직접 부르는 곳은 readCommand 하나뿐이어야 하고, 그 한 곳은
  // 반드시 버퍼로 받아야 한다. 새 감지 코드가 execFileAsync를 다시 부르면 여기서 걸린다.
  check('execFileAsync 호출부는 readCommand 하나뿐',
    (projects.match(/await execFileAsync\(/g) || []).length === 1);
  check('그 한 곳이 버퍼로 받는다', /await execFileAsync\([^;]*RAW_OUTPUT/.test(projects));
  check('readCommand가 decode를 거친다', /consoleText\.decode\(stdout\)/.test(projects));
  check('감지 호출 4곳이 readCommand를 쓴다', (projects.match(/await readCommand\(/g) || []).length >= 4);

  const bridge = read('src/mcp/cli-bridge.js');
  check('cli-bridge가 encoding:utf8을 고정하지 않는다', !/encoding: 'utf8'/.test(bridge));
  check('cli-bridge가 stdout/stderr 둘 다 디코드한다',
    /consoleText\.decode\(stdout\)/.test(bridge) && /consoleText\.decode\(stderr\)/.test(bridge));

  const gpu = read('src/core/gpufit.js');
  check('gpufit도 디코더를 거친다', /consoleText\.decode\(stdout\)/.test(gpu));

  // 브리지는 %APPDATA%의 독립 복사본으로도 돈다 — 같이 복사되지 않으면 그쪽이 죽는다.
  const connectors = read('src/core/connectors.js');
  check('console-text.js가 브리지와 함께 설치된다', /'console-text\.js'/.test(connectors));
}

console.log('');
console.log(failed === 0 ? '모든 검사 통과' : `${failed}개 실패`);
process.exit(failed === 0 ? 0 : 1);

#!/usr/bin/env node
// 렌더러 스모크 테스트 — Electron을 실제로 띄워 모든 탭을 눌러본다.
//
// 왜 필요한가: ui/ 는 번들러 없이 <script>를 순서대로 로드한다. 파일 하나가
// SyntaxError로 죽어도 창은 멀쩡히 뜨고 그 탭만 조용히 동작을 멈춘다.
// 정적 검사(test-ui-contract.js)로는 잡히지 않는 실행 시점 문제를 여기서 잡는다.
//
// 이미 허브가 실행 중이면 단일 인스턴스 잠금 때문에 건너뛴다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const appRoot = path.resolve(__dirname, '..');
const electronBin = path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function hubAlreadyRunning() {
  // 단일 인스턴스 잠금이 걸려 있으면 새 인스턴스는 곧바로 종료되어 보고서를 못 쓴다.
  const res = spawnSync('powershell', [
    '-NoProfile', '-Command',
    "(Get-NetTCPConnection -LocalPort 8763 -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count",
  ], { encoding: 'utf8' });
  return Number(String(res.stdout).trim()) > 0;
}

function main() {
  if (!fs.existsSync(electronBin)) {
    console.log('electron이 없어 건너뜁니다 (npm install 필요)');
    return;
  }
  if (hubAlreadyRunning()) {
    console.log('허브가 이미 실행 중이라 건너뜁니다 (단일 인스턴스 잠금).');
    console.log('통과 0 / 실패 0 (skipped)');
    return;
  }

  const reportFile = path.join(os.tmpdir(), `aihub-selftest-${process.pid}.json`);
  const res = spawnSync(electronBin, [appRoot], {
    cwd: appRoot,
    encoding: 'utf8',
    timeout: 90 * 1000,
    env: { ...process.env, AIHUB_SELFTEST: reportFile },
  });

  const stderr = String(res.stderr || '');
  const rendererErrors = stderr.split('\n').filter((l) => l.includes('[renderer:'));

  if (!fs.existsSync(reportFile)) {
    console.log(stderr.split('\n').slice(0, 15).join('\n'));
    check('셀프테스트 보고서 생성', false, '앱이 보고서를 남기지 못했습니다');
    console.log(`\n통과 ${pass} / 실패 ${fail}`);
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  fs.unlinkSync(reportFile);

  console.log(`탭 ${(report.tabs || []).length}개 클릭`);
  check('치명적 오류 없음', !report.fatal, report.fatal);
  check('전역 함수 전부 정의됨', (report.missing || []).length === 0,
    (report.missing || []).join(', '));
  check('탭 섹션이 모두 존재', (report.shown || []).length === (report.tabs || []).length,
    `${(report.shown || []).length}/${(report.tabs || []).length}`);
  check('탭 전환 중 런타임 오류 없음', (report.errors || []).length === 0,
    (report.errors || []).slice(0, 3).join(' | '));
  // 셀프테스트 인스턴스가 진짜 MCP 포트를 열면 재시작 중인 Hub의 포트를 빼앗는다(2026-10-17).
  check('셀프테스트는 MCP HTTP 서버를 열지 않음', report.features?.hubRunning === false, String(report.features?.hubRunning));
  check('렌더러 콘솔 오류 없음', rendererErrors.length === 0,
    rendererErrors.slice(0, 3).join(' | '));

  console.log('');
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();

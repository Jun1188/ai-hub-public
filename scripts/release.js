#!/usr/bin/env node
// 빌드된 Setup exe를 공유 폴더(내 드라이브)에 게시한다.
//
//   npm run release                    -- 빌드 + 게시
//   node scripts/release.js            -- 이미 빌드된 산출물만 게시
//   node scripts/release.js --notes-file notes.txt     -- 릴리스 메모 (한글은 이 방식)
//   node scripts/release.js --notes "ascii only"
//   AIHUB_SHARE_DIR=D:\어딘가 node scripts/release.js   -- 공유 폴더 직접 지정
//
// ⚠ 한글 릴리스 메모는 반드시 --notes-file(UTF-8 파일)로 넘길 것. Windows PowerShell
//   5.1은 인자와 환경변수를 시스템 코드페이지로 넘겨서 한글이 깨진다.
//
// 게시 결과: <공유폴더>/release/ai-hub-Setup-<version>.exe + latest.json
// 다른 컴퓨터의 허브는 시작할 때 latest.json을 읽어 새 버전을 알려준다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const config = require(path.join(appRoot, 'src', 'core', 'config.js'));
const share = require(path.join(appRoot, 'src', 'core', 'share.js'));
const updater = require(path.join(appRoot, 'src', 'core', 'updater.js'));

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] || '' : '';
}

/**
 * 릴리스 메모. 한글을 `npm run release -- --notes "..."` 로 넘기면 PowerShell과
 * npm의 cmd 셈이 겹쳐 `^`가 섞여 들어온다. 환경변수 경로를 우선으로 둔다.
 */
function releaseNotes() {
  if (process.env.AIHUB_RELEASE_NOTES) return process.env.AIHUB_RELEASE_NOTES;
  const file = arg('notes-file');
  if (file) return fs.readFileSync(file, 'utf8').trim();
  // 셸을 거치며 삽입된 이스케이프 캐럿을 제거한다.
  return arg('notes').replace(/\^/g, '');
}

/** electron-builder 산출물 위치 (package.json의 dist 스크립트와 같은 곳). */
function buildOutputDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'ai-hub', 'release');
}

async function resolveShareRoot() {
  if (process.env.AIHUB_SHARE_DIR) return process.env.AIHUB_SHARE_DIR;
  const cfg = config.load();
  if (cfg.share && cfg.share.dir) return cfg.share.dir;
  const auto = await share.autodetectRoot();
  if (auto) {
    // 다음부터는 탐지 없이 바로 쓰도록 기기 전용 설정에 저장.
    config.update({ share: { dir: auto } });
  }
  return auto;
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  const version = pkg.version;
  const setupName = `ai-hub-Setup-${version}.exe`;
  const setupPath = path.join(buildOutputDir(), setupName);

  if (!fs.existsSync(setupPath)) {
    console.error(`✗ 빌드 산출물이 없습니다: ${setupPath}`);
    console.error('  먼저 `npm run dist` 로 빌드하세요.');
    process.exit(1);
  }

  const shareRoot = await resolveShareRoot();
  if (!shareRoot) {
    console.error('✗ 공유 폴더를 찾지 못했습니다 (내 드라이브 미탐지).');
    console.error('  Google Drive 데스크톱을 실행하거나 AIHUB_SHARE_DIR로 직접 지정하세요.');
    process.exit(1);
  }

  const size = (fs.statSync(setupPath).size / 1024 / 1024).toFixed(1);
  console.log(`게시 준비  v${version}  (${size} MB)`);
  console.log(`  원본  ${setupPath}`);
  console.log(`  대상  ${path.join(shareRoot, 'release')}`);

  const result = await updater.publish({
    shareRoot,
    setupPath,
    version,
    notes: releaseNotes(),
    keep: 3,
  });

  console.log(`✓ 게시 완료  ${result.dest}`);
  console.log(`  sha256  ${result.latest.sha256}`);
  if (result.pruned.length) console.log(`  정리됨  ${result.pruned.join(', ')}`);
  console.log('');
  console.log('다른 컴퓨터에서는 허브를 열면 새 버전 알림이 뜹니다.');
  console.log(`허브가 아직 없다면 위 폴더의 ${result.latest.setup} 를 직접 실행해 설치하세요.`);
}

main().catch((err) => {
  console.error('✗ 게시 실패:', (err && err.message) || err);
  process.exit(1);
});

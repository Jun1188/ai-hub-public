// 공유 폴더를 통한 버전 배포 (다른 컴퓨터에서 최신 setup 설치).
//
// 배포하는 쪽 (개발 컴퓨터):  npm run release
//   → electron-builder 산출물 Setup exe를 <공유폴더>/release/ 로 복사하고
//     latest.json(버전·파일명·sha256·날짜·메모)을 갱신합니다.
//
// Setup publication is for an initial installation only.
// Existing apps use repository-update.js and never stage or launch a Setup.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const READ_TIMEOUT_MS = 5000;
const COPY_TIMEOUT_MS = 5 * 60 * 1000; // setup은 80MB대라 넉넉히
const RELEASE_SUBDIR = 'release';
const LATEST_FILE = 'latest.json';

const withTimeout = (promise, ms, label) => require('./promise-timeout').withTimeout(promise, ms, () => new Error(`timeout:${label}`));

/** "1.8.0" 같은 버전 비교. a>b면 1, a<b면 -1, 같으면 0. */
function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function releaseDir(shareRoot) {
  return path.join(shareRoot, RELEASE_SUBDIR);
}

/** 파일 sha256 (스트림 — 80MB짜리를 메모리에 올리지 않기 위해). */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 공유 폴더의 latest.json을 읽는다. 없거나 읽기 실패면 null.
 * @param {string} shareRoot 공유 폴더 경로
 */
async function readLatest(shareRoot) {
  if (!shareRoot) return null;
  const file = path.join(releaseDir(shareRoot), LATEST_FILE);
  try {
    const text = await withTimeout(fs.promises.readFile(file, 'utf8'), READ_TIMEOUT_MS, 'latest');
    const obj = JSON.parse(text);
    if (!obj || typeof obj.version !== 'string') return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * 설치본 채널(공유 폴더 latest.json). setup은 실행 중인 버전보다 새로울 때만 채운다 — overlay만 새로운 경우에
 * 옛 설치본을 내려받아 버전을 되돌리지 않게.
 */
async function installerChannel(shareRoot, current) {
  const base = { installerAvailable: false, version: '', setup: '', notes: '', releasedAt: '', sha256: '', error: '' };
  if (!shareRoot) return { ...base, error: '공유 폴더가 설정되지 않았습니다' };
  const latest = await readLatest(shareRoot);
  if (!latest) return { ...base, error: '릴리스 정보(latest.json)를 읽을 수 없습니다' };
  const newer = compareVersions(latest.version, current) > 0;
  return {
    ...base,
    installerAvailable: newer,
    version: latest.version,
    setup: newer && latest.setup ? path.join(releaseDir(shareRoot), latest.setup) : '',
    notes: latest.notes || '',
    releasedAt: latest.releasedAt || '',
    sha256: latest.sha256 || '',
  };
}

const versionAt = (ch) => `v${ch.version}${ch.commit ? `(${ch.commit.slice(0, 7)})` : ''}`;

/** 화면에 그대로 싣는 한 줄 설명. 소스 실행과 설치본의 할 일이 다르다. */
function describeUpdate(info) {
  const ov = info.overlay;
  const repo = ov.known ? `공유 저장소 main ${versionAt(ov)}` : `공유 저장소 확인 불가 — ${ov.error}`;
  const setup = info.error ? `설치본 확인 불가 — ${info.error}` : `공유 폴더 설치본 v${info.version}`;
  if (!info.available) return `${repo} · ${setup}`;
  if (info.sourceRun) {
    return (ov.available ? `공유 저장소 main에 새 버전 ${versionAt(ov)}이(가) 있습니다. ` : `공유 폴더에 설치본 v${info.version}이(가) 있습니다. `)
      + '이 Hub는 소스로 실행 중이라 설치본을 설치하지 않습니다. 공유 저장소의 overlay(tools/hub_overlay.py)로 업데이트하세요.';
  }
  if (!info.installerAvailable) {
    return `공유 저장소 main에 ${versionAt(ov)} 소스(overlay)가 있지만 이 버전의 설치본은 게시되지 않았습니다(${setup}). `
      + '설치본 Hub는 개발 PC에서 새 설치본을 게시해야(npm run release) 업데이트할 수 있습니다.';
  }
  return `공유 폴더에 새 설치본 v${info.version}이(가) 있습니다.` + (ov.available && compareVersions(ov.version, info.version) > 0
    ? ` 공유 저장소 main에는 더 새 ${versionAt(ov)} 소스(overlay)도 있지만 그 설치본은 아직 게시되지 않았습니다.` : '');
}

/**
 * 새 버전이 있는지 두 채널에서 확인한다. 절대 throw하지 않는다.
 *   설치본: 공유 폴더 latest.json(version·setup·sha256 등 기존 필드 + installerAvailable)
 *   overlay: 공유 저장소 main의 resultHubVersion(overlay.{known, available, version, commit, error})
 * 1.30.0 이후는 overlay로만 배포돼, latest.json만 보던 확인이 1.32.19 설치본에도 "최신입니다"라고 했다(2026-10-28).
 * available은 어느 채널이든 더 새로우면 참이고, upToDate는 봐야 할 채널을 다 읽었고 새 것이 없을 때만 참이다.
 * @param {{packaged?: boolean, overlay?: () => Promise<{known:boolean, version:string, commit:string, error:string}>}} [options]
 */
async function checkForUpdate(shareRoot, currentVersion, { packaged = true, overlay = () => require('./repository-update').overlayVersion() } = {}) {
  const current = String(currentVersion || '');
  const [installer, read] = await Promise.all([
    installerChannel(shareRoot, current),
    Promise.resolve().then(() => overlay()).catch(() => null),
  ]);
  const ov = read && read.known
    ? { known: true, version: read.version, commit: read.commit || '', error: '', available: compareVersions(read.version, current) > 0 }
    : { known: false, version: '', commit: '', error: (read && read.error) || 'overlay 채널을 확인하지 못했습니다', available: false };
  const available = installer.installerAvailable || ov.available;
  const newest = [installer.installerAvailable && installer.version, ov.available && ov.version]
    .filter(Boolean).sort((a, b) => compareVersions(b, a))[0] || '';
  // 소스 실행은 overlay로만 올리므로 설치본 채널을 못 읽어도 overlay로 판단한다. 설치본은 두 채널을 다 읽어야 한다.
  const upToDate = !available && ov.known && (!packaged || !installer.error);
  const info = { ...installer, available, upToDate, current, newest, sourceRun: !packaged, overlay: ov };
  return { ...info, message: describeUpdate(info) };
}

/** 공유 릴리스 폴더에 "이거 하나만 실행하면 최신 설치" 진입점을 만든다. */
const LAUNCHER_NAME = '최신버전 설치.cmd';
const LAUNCHER_BODY = [
  '@echo off',
  'rem ai-hub - 최신 버전 설치',
  'rem latest.json에서 최신 setup 파일명을 읽어 실행합니다.',
  'setlocal enabledelayedexpansion',
  'cd /d "%~dp0"',
  'if not exist "latest.json" (',
  '  echo [!] latest.json 이 없습니다. 개발 컴퓨터에서 npm run release 를 먼저 실행하세요.',
  '  pause & exit /b 1',
  ')',
  'for /f "usebackq tokens=2 delims=:," %%A in (`findstr /c:"\\"setup\\"" latest.json`) do (',
  '  set "SETUP=%%~A"',
  ')',
  'set "SETUP=%SETUP: =%"',
  'set "SETUP=%SETUP:"=%"',
  'if not exist "%SETUP%" (',
  '  echo [!] 설치 파일을 찾을 수 없습니다: %SETUP%',
  '  pause & exit /b 1',
  ')',
  'echo 설치를 시작합니다: %SETUP%',
  'echo (코드 서명이 없어 SmartScreen 경고가 뜨면 "추가 정보" - "실행"을 누르세요.)',
  'start "" "%SETUP%"',
  'endlocal',
  '',
].join('\r\n');

/**
 * 릴리스를 게시한다 (scripts/release.js에서 사용).
 * @param {string} shareRoot 공유 폴더
 * @param {string} setupPath 빌드된 setup exe 경로
 * @param {string} version   package.json 버전
 * @param {string} notes     릴리스 메모
 * @param {number} keep      보관할 이전 setup 개수
 */
async function publish({ shareRoot, setupPath, version, notes = '', keep = 3, verifyBeforeRelease = false }) {
  const dir = releaseDir(shareRoot);
  await fs.promises.mkdir(dir, { recursive: true });
  const fileName = path.basename(setupPath);
  const dest = path.join(dir, fileName);

  const sha = await sha256File(setupPath);
  const tmp = `${dest}.part`;
  await withTimeout(fs.promises.copyFile(setupPath, tmp), COPY_TIMEOUT_MS, 'publish-copy');
  if (verifyBeforeRelease && await sha256File(tmp) !== sha) throw new Error('공유 설치본 사전 해시 검증 실패');
  await fs.promises.rename(tmp, dest);

  const latest = {
    version,
    setup: fileName,
    sha256: sha,
    releasedAt: new Date().toISOString(),
    notes,
  };
  const manifestPath = path.join(dir, LATEST_FILE);
  const writePath = verifyBeforeRelease ? manifestPath + '.part' : manifestPath;
  await fs.promises.writeFile(writePath, JSON.stringify(latest, null, 2), 'utf8');
  if (verifyBeforeRelease) await fs.promises.rename(writePath, manifestPath);
  // 허브가 아직 없는 컴퓨터에서 파일 하나만 실행하면 최신 버전이 깔리도록.
  await fs.promises.writeFile(path.join(dir, LAUNCHER_NAME), LAUNCHER_BODY, 'utf8');

  // 오래된 setup 정리 (최신 keep개만 남김). latest.json이 가리키는 건 항상 보존.
  const pruned = [];
  try {
    const entries = await fs.promises.readdir(dir);
    const setups = entries
      .filter((n) => /^ai-hub-Setup-.*\.exe$/i.test(n) && n !== fileName)
      .map((n) => ({ name: n, ver: (n.match(/Setup-([\d.]+)\.exe$/i) || [])[1] || '0' }))
      .sort((a, b) => compareVersions(b.ver, a.ver));
    for (const old of setups.slice(Math.max(0, keep - 1))) {
      await fs.promises.unlink(path.join(dir, old.name)).catch(() => {});
      pruned.push(old.name);
    }
  } catch {
    /* 정리 실패는 게시 실패가 아님 */
  }

  return { dir, dest, latest, pruned };
}

module.exports = {
  checkForUpdate,
  readLatest,
  publish,
  releaseDir,
  compareVersions,
  sha256File,
  RELEASE_SUBDIR,
  LATEST_FILE,
  LAUNCHER_NAME,
};

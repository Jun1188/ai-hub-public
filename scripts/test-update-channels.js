#!/usr/bin/env node
// 업데이트 확인의 두 채널(공유 폴더 설치본 latest.json + 공유 저장소 main의 overlay 버전)을 오프라인으로 확인한다.
// 1.30.0 이후 버전은 overlay로만 나가, latest.json만 보던 확인이 1.32.19 설치본에도 "최신입니다"라고 했다(2026-10-28).
// git 원격은 임시 폴더의 bare 저장소다(네트워크 없음). 사용자·시스템 git 설정(훅·서명·자격 증명)은 끈다.
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-update-channels-'));
process.env.GIT_CONFIG_GLOBAL = path.join(tmp, 'gitconfig');
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
process.env.GIT_CONFIG_NOSYSTEM = '1';
delete process.env.AIHUB_SELFTEST;
const updater = require('../src/core/updater');
const repoUpdate = require('../src/core/repository-update');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=' + os.devNull, '-c', 'commit.gpgsign=false',
  '-c', 'user.name=hub-test', '-c', 'user.email=hub-test@example.invalid', ...args],
{ cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).toString().trim();

const origin = path.join(tmp, 'origin.git'), seed = path.join(tmp, 'seed'), clone = path.join(tmp, 'clone');
function publishOverlay(version) {
  const dir = path.join(seed, 'integrations', 'ai-hub');
  fs.mkdirSync(dir, { recursive: true });
  // 실제 manifest처럼 BOM이 붙어 있다.
  fs.writeFileSync(path.join(dir, 'manifest.json'), '﻿' + JSON.stringify({ resultHubVersion: version }, null, 2));
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'hub ' + version);
  git(seed, 'push', '-q', origin, 'main');
  return git(seed, 'rev-parse', 'HEAD');
}

function writeLatest(share, version) {
  fs.mkdirSync(path.join(share, 'release'), { recursive: true });
  fs.writeFileSync(path.join(share, 'release', 'latest.json'), JSON.stringify({
    version, setup: `ai-hub-Setup-${version}.exe`, sha256: 'a'.repeat(64), releasedAt: '2026-10-16T00:00:00.000Z', notes: '',
  }));
}

(async () => {
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'init', '-q', '-b', 'main', seed);
  const first = publishOverlay('1.32.36');
  git(tmp, 'clone', '-q', origin, clone);
  const head = publishOverlay('1.32.40'); // clone의 origin/main은 뒤처져 있다 — 읽기가 fetch해야 새 값을 본다

  // 1) overlay 채널: 실제 git으로 fetch 후 origin/main의 manifest를 읽는다
  assert.deepEqual(await repoUpdate.overlayVersion({ repository: clone }), { known: true, version: '1.32.40', commit: head, error: '' });
  assert.equal(git(clone, 'rev-parse', 'HEAD'), first, 'the checkout itself must not move');
  assert.equal((await repoUpdate.overlayVersion({ repository: clone, origin })).known, true, 'approved origin matches');
  const foreign = await repoUpdate.overlayVersion({ repository: clone, origin: 'https://example.invalid/other.git' });
  assert.equal(foreign.known, false);
  assert.match(foreign.error, /원격 주소/);
  const unset = await repoUpdate.overlayVersion(null);
  assert.equal(unset.known, false);
  assert.match(unset.error, /clone/);
  // 승인 관문: Sync-HubRepository.py와 같은 조건(schemaVersion 1·enabled true·clone·원격)이 아니면 fetch할 clone이 없다.
  for (const settings of [null, { schemaVersion: 1, enabled: false, repository: clone, origin }, { enabled: true, repository: clone, origin },
    { schemaVersion: 1, enabled: true, repository: clone }, { schemaVersion: 1, enabled: true, origin }]) {
    const gate = repoUpdate.approvedRepository(settings);
    assert(!gate.repository && /승인되지 않아/.test(gate.error), JSON.stringify(settings));
  }
  assert.deepEqual(repoUpdate.approvedRepository({ schemaVersion: 1, enabled: true, repository: clone, origin }), { repository: clone, origin });
  fs.renameSync(origin, origin + '.gone');
  const unreachable = await repoUpdate.overlayVersion({ repository: clone });
  assert.equal(unreachable.known, false, 'a failed fetch is unknown, not the stale local ref');
  assert.match(unreachable.error, /fetch/);
  fs.renameSync(origin + '.gone', origin);

  // 2) 두 채널 조합 — 설치본 채널은 이 PC처럼 1.30.0에 멈춰 있다
  const share = path.join(tmp, 'share');
  writeLatest(share, '1.30.0');
  const overlayAt = (version) => async () => ({ known: true, version, commit: head, error: '' });
  const unknownOverlay = async () => ({ known: false, version: '', commit: '', error: '공유 저장소 fetch에 실패했습니다' });

  // overlay가 새롭고 설치본이 옛것: 설치본 Hub는 "게시되지 않음"을 분명히 말하고 옛 설치본을 받지 않는다
  const packaged = await updater.checkForUpdate(share, '1.32.19', { packaged: true, overlay: overlayAt('1.32.36') });
  assert.equal(packaged.available, true);
  assert.equal(packaged.installerAvailable, false);
  assert.equal(packaged.upToDate, false);
  assert.equal(packaged.newest, '1.32.36');
  assert.equal(packaged.version, '1.30.0');
  assert.equal(packaged.setup, '', 'no Setup path when the installer is not newer');
  assert.match(packaged.message, /v1\.32\.36\(\w{7}\) 소스\(overlay\)가 있지만 이 버전의 설치본은 게시되지 않았습니다/);
  assert.match(packaged.message, /설치본 v1\.30\.0/);
  assert.equal(updater.stageSetup, undefined, 'repository updates expose no Setup staging entry point');

  // 소스 실행: overlay로 안내하고 설치본 이야기는 하지 않는다
  const source = await updater.checkForUpdate(share, '1.32.31', { packaged: false, overlay: overlayAt('1.32.36') });
  assert.equal(source.available, true);
  assert.equal(source.sourceRun, true);
  assert.match(source.message, /새 버전 v1\.32\.36/);
  assert.match(source.message, /소스로 실행 중이라 설치본을 설치하지 않습니다.*overlay/);
  assert.doesNotMatch(source.message, /게시되지 않았습니다/);

  // 둘 다 같거나 옛것이면 그때만 최신
  for (const [current, packagedRun] of [['1.32.37', true], ['1.32.36', false], ['1.32.36', true]]) {
    const r = await updater.checkForUpdate(share, current, { packaged: packagedRun, overlay: overlayAt('1.32.36') });
    assert.equal(r.available, false);
    assert.equal(r.upToDate, true, `${current} packaged=${packagedRun}`);
    assert.match(r.message, /공유 저장소 main v1\.32\.36\(\w{7}\) · 공유 폴더 설치본 v1\.30\.0/);
  }

  // overlay를 모르면 어떤 실행이든 "최신"이라고 하지 않는다(읽기 함수가 throw해도 마찬가지)
  for (const packagedRun of [true, false]) {
    const r = await updater.checkForUpdate(share, '1.32.37', { packaged: packagedRun, overlay: unknownOverlay });
    assert.equal(r.available, false);
    assert.equal(r.upToDate, false);
    assert.match(r.message, /공유 저장소 확인 불가 — 공유 저장소 fetch에 실패했습니다/);
  }
  const thrown = await updater.checkForUpdate(share, '1.32.37', { overlay: () => { throw new Error('boom'); } });
  assert.equal(thrown.upToDate, false);
  assert.equal(thrown.overlay.known, false);

  // 설치본 채널을 못 읽으면: 설치본 Hub는 판단 보류, 소스 실행은 overlay로 판단
  assert.equal((await updater.checkForUpdate('', '1.32.36', { packaged: true, overlay: overlayAt('1.32.36') })).upToDate, false);
  assert.equal((await updater.checkForUpdate('', '1.32.36', { packaged: false, overlay: overlayAt('1.32.36') })).upToDate, true);

  // 설치본이 새로우면 설치본 Hub는 받을 수 있고, 더 새 overlay가 있으면 함께 알린다
  writeLatest(share, '1.33.0');
  const both = await updater.checkForUpdate(share, '1.32.19', { packaged: true, overlay: overlayAt('1.33.2') });
  assert.equal(both.installerAvailable, true);
  assert.equal(both.version, '1.33.0');
  assert(both.setup.endsWith('ai-hub-Setup-1.33.0.exe'));
  assert.equal(both.newest, '1.33.2');
  assert.match(both.message, /새 설치본 v1\.33\.0.*더 새 v1\.33\.2\(\w{7}\) 소스\(overlay\)/);

  // 3) 실제 읽기 함수를 그대로 연결
  writeLatest(share, '1.30.0');
  const e2e = await updater.checkForUpdate(share, '1.32.36', { packaged: false, overlay: () => repoUpdate.overlayVersion({ repository: clone }) });
  assert.equal(e2e.available, true);
  assert.equal(e2e.newest, '1.32.40');
  assert.equal(e2e.overlay.commit, head);

  console.log('Update channels: overlay fetch/read, origin guard, unknown never latest, packaged vs source-run messages, no Setup staging API passed');
})().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; }).finally(() => {
  if (path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(tmp).startsWith('hub-update-channels-')) {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* git 객체 잠금은 다음 정리에 맡긴다 */ }
  }
});

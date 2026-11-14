'use strict';
// Game identity fixtures: exe name + SHA-256 picks the known build, anti-cheat markers in the exe folder or the
// Unreal game root block runtime features, and an unreadable folder blocks instead of passing.
const assert = require('assert/strict'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { identify } = require('../src/core/game-identity');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-game-identity-fixture-'));
const originalReaddir = fs.promises.readdir;
// Every exe sits at least three folders below the fixture root so the ancestor scan never reads the real temp folder.
function exe(rel, content, markers = []) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  for (const m of markers) m.endsWith('/') ? fs.mkdirSync(path.join(root, m), { recursive: true }) : fs.writeFileSync(path.join(root, m), '');
  return file;
}
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const known = [{ id: 'fixture-game', exeName: 'Game.exe', sha256: sha('build-1'), version: '1.0.0' }];

(async () => {
  const clean = exe('clean/a/b/Game/Game.exe', 'build-1');
  const ok = await identify({ exePath: clean, known });
  assert.deepEqual({ runtimeAllowed: ok.runtimeAllowed, reason: ok.reason, game: ok.game, sha256: ok.sha256 },
    { runtimeAllowed: true, reason: null, game: { id: 'fixture-game', version: '1.0.0' }, sha256: sha('build-1') });

  const patched = await identify({ exePath: exe('patched/a/b/Game/game.EXE', 'build-2'), known });
  assert.equal(patched.reason, 'game_version_unknown');
  assert.equal(patched.game, null);
  assert.equal(patched.runtimeAllowed, false);

  assert.equal((await identify({ exePath: exe('other/a/b/Other/Other.exe', 'x'), known })).reason, 'game_unknown');

  const unity = await identify({ exePath: exe('unity/a/b/Game/Game.exe', 'build-1', ['unity/a/b/Game/battleye/']), known });
  assert.equal(unity.reason, 'runtime_blocked_anticheat_marker');
  assert.deepEqual(unity.game, { id: 'fixture-game', version: '1.0.0' }, 'a known build is still identified');
  assert.equal(path.basename(unity.markers[0]), 'battleye');

  const unreal = await identify({ exePath: exe('ue/Game/Proj/Binaries/Win64/Proj-Win64-Shipping.exe', 'ue', ['ue/Game/EasyAntiCheat/', 'ue/Game/start_protected_game.exe']), known: [] });
  assert.equal(unreal.reason, 'runtime_blocked_anticheat_marker');
  assert.deepEqual(unreal.markers.map(m => path.basename(m)).sort(), ['EasyAntiCheat', 'start_protected_game.exe']);

  const beyond = await identify({ exePath: exe('deep/EasyAntiCheat/x/y/z/w/Game/Game.exe', 'build-1'), known });
  assert.equal(beyond.reason, null, 'markers further up than the game root are not scanned');

  const blockedDir = path.dirname(path.dirname(clean));
  fs.promises.readdir = async (dir, ...rest) => path.resolve(dir) === blockedDir ? Promise.reject(new Error('EACCES')) : originalReaddir(dir, ...rest);
  const unreadable = await identify({ exePath: clean, known });
  assert.equal(unreadable.reason, 'runtime_blocked_marker_scan_failed');
  assert.deepEqual(unreadable.unreadable, [blockedDir]);
  console.log('Passed: exe name + SHA-256 identifies the build, hash mismatch -> game_version_unknown, unknown exe -> game_unknown, anti-cheat markers in exe folder or Unreal game root -> runtime_blocked_anticheat_marker, unreadable folder blocks');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  fs.promises.readdir = originalReaddir;
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('hub-game-identity-fixture-')) fs.rmSync(root, { recursive: true, force: true });
});

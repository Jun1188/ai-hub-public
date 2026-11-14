'use strict';
// Identifies a game build by exe name + SHA-256 and blocks runtime features (injection, live type dumps) when an
// anti-cheat is installed next to it: attaching there risks bans and terms violations even for read-only tooling.
// Static analysis of copied files is not gated here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Names (case-insensitive) that anti-cheat installers leave in a game folder. Update as new anti-cheats appear.
const ANTICHEAT_MARKERS = [
  'EasyAntiCheat', 'EasyAntiCheat_EOS_Setup.exe', 'start_protected_game.exe', 'EasyAntiCheat_x64.dll', 'EasyAntiCheat.sys',
  'BattlEye', 'BEService.exe', 'BEService_x64.exe', 'BEClient_x64.dll', 'BEDaisy.sys',
  'GameGuard', 'GameMon.des', 'XIGNCODE', 'x3.xem', 'vgk.sys', 'mhyprot2.sys',
];
// Unreal ships the exe in <game>/<project>/Binaries/Win64 while the anti-cheat folder sits in <game>.
const ANCESTOR_LEVELS = 3;
const IO_TIMEOUT_MS = 5000;

const withTimeout = (promise, what, ms = IO_TIMEOUT_MS) => require('./promise-timeout').withTimeout(promise, ms, () => new Error(what + ' timeout'));

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

/** Marker names found in the exe folder and its first ancestors; a folder that cannot be listed is reported, not skipped. */
async function findMarkers(exePath) {
  const wanted = new Set(ANTICHEAT_MARKERS.map(n => n.toLowerCase()));
  const found = [], unreadable = [];
  let dir = path.dirname(path.resolve(exePath));
  for (let level = 0; level <= ANCESTOR_LEVELS; level++) {
    try {
      for (const name of await withTimeout(fs.promises.readdir(dir), 'marker scan')) if (wanted.has(name.toLowerCase())) found.push(path.join(dir, name));
    } catch { unreadable.push(dir); }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { found, unreadable };
}

/**
 * @param {{exePath:string, known?:Array<{id:string, exeName:string, sha256:string, version?:string}>}} p known builds of the target game
 * @returns runtimeAllowed is true only for a recognized build with no anti-cheat marker
 */
async function identify({ exePath, known = [] }) {
  const exeName = path.basename(exePath);
  const [sha256, markers] = await Promise.all([withTimeout(hashFile(exePath), 'exe hash', 60000), findMarkers(exePath)]);
  const sameName = known.filter(k => k.exeName.toLowerCase() === exeName.toLowerCase());
  const build = sameName.find(k => k.sha256.toLowerCase() === sha256) || null;
  // Failing to read a folder is not "no anti-cheat" (project rule 6), so it blocks like a marker would.
  const reason = markers.found.length ? 'runtime_blocked_anticheat_marker'
    : markers.unreadable.length ? 'runtime_blocked_marker_scan_failed'
      : !sameName.length ? 'game_unknown'
        : !build ? 'game_version_unknown' : null;
  return { exeName, sha256, game: build && { id: build.id, version: build.version || null }, runtimeAllowed: !reason, reason,
    markers: markers.found, unreadable: markers.unreadable };
}

module.exports = { identify, ANTICHEAT_MARKERS };

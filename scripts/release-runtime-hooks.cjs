'use strict';

const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {Arch} = require('electron-builder');
const spec = require('./release-runtimes.json');

function verify(context, runtimeRoot, archive, extra = []) {
  execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'Verify-ReleaseRuntimes.ps1'),
    '-RuntimeRoot', runtimeRoot, '-SourceRoot', context.packager.projectDir, '-Archive', archive, ...extra
  ], {stdio: 'inherit', windowsHide: true});
}

exports.beforePack = function beforePack(context) {
  if (context.electronPlatformName !== 'win32') return;
  if (context.arch !== Arch.x64) throw new Error('Only Windows x64 release inputs have been reviewed.');
  const archive = process.env.AIHUB_ELECTRON_ZIP;
  if (!archive || !path.isAbsolute(archive) || path.basename(archive) !== spec.electron.zipName) {
    throw new Error(`Set AIHUB_ELECTRON_ZIP to the absolute path of ${spec.electron.zipName}.`);
  }
  verify(context, context.packager.projectDir, archive, ['-InputsOnly']);
  // electron-builder 25 takes this directory as its local ZIP cache before unpacking.
  context.packager.config.electronDist = path.dirname(archive);
};

exports.afterPack = function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  verify(context, context.appOutDir, path.join(context.packager.config.electronDist, spec.electron.zipName));
};

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// File identities distinguish redirected filesystem views without reading configuration or keys.
function capture({ dataRoot, chromiumProfile, stat = fs.statSync } = {}) {
  try {
    if (![dataRoot, chromiumProfile].every(value => typeof value === 'string' && path.isAbsolute(value))) throw Error();
    const vault = path.join(dataRoot, 'credentials.local');
    const entries = [[dataRoot, 'directory'], [path.join(dataRoot, 'config.local.json'), 'file'],
      [chromiumProfile, 'directory'], [vault, 'directory', true],
      [path.join(vault, 'key-table.v2.json'), 'file', true]].map(([file, kind, optional]) => {
      let info;
      try { info = stat(file, { bigint: true }); }
      catch (error) {
        if (optional && error.code === 'ENOENT') return ['absent'];
        throw error;
      }
      if ((kind === 'directory' ? !info.isDirectory() : !info.isFile()) ||
          typeof info.dev !== 'bigint' || typeof info.ino !== 'bigint' || info.dev < 0n || info.ino <= 0n) throw Error();
      return [kind, info.dev.toString(), info.ino.toString()];
    });
    return { schemaVersion: 1, status: 'available', fingerprint: crypto.createHash('sha256')
      .update(JSON.stringify(['hub-profile-files-1', ...entries])).digest('hex') };
  } catch {
    return { schemaVersion: 1, status: 'unavailable', reason: 'profile_identity_unavailable' };
  }
}

function current() {
  try {
    const electron = require('electron');
    if (!electron.app || typeof electron.app.getPath !== 'function') throw Error();
    const profile = capture({ dataRoot: require('./paths').hubDataDir(),
      chromiumProfile: electron.app.getPath('userData') });
    return { ...profile, requireGui: Boolean(electron.BrowserWindow?.getAllWindows()
      .some(window => !window.isDestroyed() && window.isVisible())) };
  } catch {
    return { schemaVersion: 1, status: 'unavailable', reason: 'profile_identity_unavailable', requireGui: false };
  }
}
module.exports = { capture, current };

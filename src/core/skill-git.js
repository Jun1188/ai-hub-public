'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function checkoutOptions(clone) {
  // A fetched .gitattributes can select a user's installed smudge driver before any review.
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-skill-config-'));
  try {
    const empty = path.join(isolated, 'empty');
    fs.writeFileSync(empty, '', { flag: 'wx' });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:GIT_|SSH_ASKPASS|GCM_)/i.test(key)));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: empty, GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' });
    return {
      env,
      args: ['-C', clone, '-c', 'core.hooksPath=' + isolated, '-c', 'core.symlinks=false',
        '-c', 'protocol.allow=never', '-c', 'submodule.recurse=false'],
      close() { fs.unlinkSync(empty); fs.rmdirSync(isolated); }
    };
  } catch (error) {
    fs.rmSync(isolated, { recursive: true, force: true });
    throw error;
  }
}

function githubSubdirectory(parts) {
  const names = parts.map(decodeURIComponent);
  if (names.some(n => !n || n === '.' || n === '..' || /[\\/:\x00]/.test(n) || /^\.git$/i.test(n))) {
    throw new Error('Invalid skill subdirectory.');
  }
  return names;
}

module.exports = { checkoutOptions, githubSubdirectory };

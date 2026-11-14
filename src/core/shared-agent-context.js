'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function manifest(deps = {}) {
  const cfg = (deps.config || require('./config')).load();
  const configured = cfg.sharedContext?.bootstrapPath;
  if (require('./public-profile').enabled && !configured) return null;
  const file = configured || (!deps.config && cfg.sharedContext
    ? path.join(os.homedir(), 'Documents', 'Codex', 'shared-agent-context', 'bootstrap.json') : '');
  if (!file) return null;
  if (!configured && !fs.existsSync(file)) return null;
  if (!path.isAbsolute(file)) throw new Error('Shared bootstrap must use a device-local absolute path');
  if (fs.statSync(file).size > 256 * 1024) throw new Error('Shared bootstrap exceeds size limit');
  const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(value.readCommit) || !Array.isArray(value.skills))
    throw new Error('Invalid shared bootstrap contract');
  const base = fs.realpathSync(path.dirname(file));
  for (const target of [value.repositoryRoot, value.skillRoot]) {
    if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('Invalid shared context root');
    const relative = path.relative(base, fs.realpathSync(target));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
      throw new Error('Shared context points outside its local root');
  }
  return value;
}

module.exports = { manifest };

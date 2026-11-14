'use strict';
// Office-laptop lite profile: device-only setting, automatic local inference off, heavy binary analysis deferred.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-profile-'));
process.env.APPDATA = temporary;
const data = path.join(temporary, 'ai-hub');
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.local.json'), JSON.stringify({ hub: { profile: 'lite' } }));
const config = require('../src/core/config');
const profile = require('../src/core/device-profile');
const graph = require('../src/core/analysis-graph');

(async () => {
  assert.equal(config.DEFAULTS.hub.profile, 'full');
  assert.ok(config.LOCAL_ONLY_PATHS.includes('hub.profile'), 'the profile never syncs to other PCs');
  assert.equal(profile.lite(), true);
  assert.equal(profile.automaticPreparation(), false);
  assert.equal(profile.describe().profile, 'lite');
  assert.equal(typeof profile.describe().recommended, 'boolean');
  assert.deepEqual(await graph.admission('binary'), { admitted: false, reason: 'lite_profile_heavy_analysis_on_desktop' });

  config.update({ hub: { profile: 'full' } });
  const local = JSON.parse(fs.readFileSync(path.join(data, 'config.local.json'), 'utf8').replace(/^\uFEFF/, ''));
  const shared = JSON.parse(fs.readFileSync(path.join(data, 'config.cache.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(local.hub.profile, 'full');
  assert.equal(shared.hub && shared.hub.profile, undefined, 'shared config carries no device profile');
  assert.equal(config.reload().hub.profile, 'full');
  assert.equal(profile.lite(), false);
  assert.equal(profile.automaticPreparation(), true);
  config.update({ localRuntimes: { automaticPreparation: false } });
  assert.equal(profile.automaticPreparation(), false, 'the existing per-device opt-out still applies');
  console.log('device profile: lite mode is device-only, disables automatic local inference and defers heavy binary analysis');
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(temporary, { recursive: true, force: true }));

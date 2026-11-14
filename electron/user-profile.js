'use strict';
// Select the Chromium encryption profile before startup can await updates or request a lock.
const {app}=require('electron');
const path=require('path');
if (!process.env.AIHUB_SELFTEST) {
  const fs = require('fs');
  const selected = require('../src/core/paths').chromiumProfileDir();
  fs.mkdirSync(selected, { recursive: true });
  app.setPath('userData', selected);
  app.setPath('sessionData', selected);
}

if (process.env.AIHUB_SELFTEST) {
  // Self-tests use a private profile and never tune models or the user's Chromium cache.
  const profile = path.join(path.dirname(process.env.AIHUB_SELFTEST), path.basename(process.env.AIHUB_SELFTEST) + '.profile');
  require('fs').mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  process.env.APPDATA = path.join(profile, 'roaming');
  process.env.AIHUB_SHARE_DIR = path.join(profile, 'share-sandbox');
}


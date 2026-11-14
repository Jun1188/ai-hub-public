'use strict';
const path = require('node:path');
const enabled = require('../../package.json').publicLite === true;
const FEATURES = ['dashboard', 'debugging', 'knowledge', 'source', 'memory', 'orchestration'];
function allowed(channel) {
  if (!enabled) return true;
  // Personal account discovery, implicit credential reuse, internal publishing and automatic source delivery are absent.
  return !/^(?:share:(?!status)|targets:|registrar:|conn:(?:register|unregister)|connector|club:|update:(?!syncStatus)|profile:repositoryAutoUpdateSet)/.test(channel);
}
module.exports = { enabled, FEATURES, allowed, dataName: 'ai-hub-public-lite', appId: 'com.jun1188.aihub.publiclite' };

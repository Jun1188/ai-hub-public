'use strict';
const path = require('path');
const crypto = require('crypto');
const repository = require('../src/core/repository-update');
const paths = require('../src/core/paths');

function install({ app, busy, server, check, quit }) {
  let reviewedCommit = null;
  const snapshot = () => {
    const state = repository.status(), delivery = state.delivery, approval = repository.approval().status;
    return { version: app.getVersion(), policy: repository.manualPolicy(),
      approval: approval === 'not-checked' ? 'approved' : approval,
      status: state.status, commit: reviewedCommit || state.commit || null,
      delivery: delivery ? Object.fromEntries(['id', 'commit', 'status', 'needsRecovery', 'version', 'pluginStatus', 'recoveryVerified']
        .filter(key => Object.hasOwn(delivery, key)).map(key => [key, delivery[key]])) : null };
  };
  require('../src/core/app-lifecycle').configure({
    root: paths.hubDataDir(), instanceId: crypto.randomUUID(), snapshot,
    check: async expectedCommit => {
      const lite = require('../src/core/device-profile').lite();
      const result = expectedCommit
        ? await (repository.manualPolicy() === 'manual'
          ? repository.manualPreflight({ expectedCommit, lite }) : repository.sync({ expectedCommit, lite }))
        : await check();
      reviewedCommit = result?.overlay?.commit || result?.commit || null;
      return result;
    },
    busy: () => busy() || require('../src/core/model-control').busy(),
    authorized: () => {
      const hub = require('../src/core/config').load().hub;
      const address = server()?.address();
      return Boolean(address && ['127.0.0.1', '::1'].includes(address.address)
        && !hub.lanAccess && hub.requireAuth === true && hub.authToken);
    },
    arm: expectedCommit => repository.startAfterExit({ guiPid: process.pid, exe: process.execPath,
      packaged: paths.isPackaged(), lite: require('../src/core/device-profile').lite(),
      port: require('../src/core/config').load().hub.httpPort,
      pointerPath: path.join(paths.hubDataDir(), 'app-root.json'), expectedCommit, requireExitConsent: true }),
    delivery: repository.delivery, consent: repository.exitConsent, quit,
    relaunch: () => { app.relaunch(); quit(); },
  });
}
module.exports = { install };

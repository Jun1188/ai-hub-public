'use strict';
// Read-only local totals for retained session snapshots. No configuration or credential is loaded.
console.log(JSON.stringify(require('../src/core/device-config-metrics').summary(), null, 2));

// Who started a recorded delegation: the entry path (mcp, gui, pipeline, hub, script) and, for MCP, the client's
// self-reported name. AsyncLocalStorage lets the MCP tool wrapper and the GUI IPC wrapper tag once instead of threading
// a parameter through offload, pipelines and the delegator. Names only — no tokens or paths. The one id is agy's root
// conversation id (`conversation`, tool-usage.js), so a record can say which agy conversation started it.
'use strict';
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

// Untagged work is the Hub's own (timers, autopilot) in the Electron main process; elsewhere a node script that
// required the module directly — the case that made benchmark jobs look like real use (2026-10-18).
function fallback() {
  if (process.type === 'browser') return { via: 'hub' };
  const script = require.main && path.basename(require.main.filename);
  return { via: 'script', ...(script ? { script } : {}) };
}

module.exports = {
  run: (caller, fn) => als.run(caller, fn),
  current: () => ({ ...(als.getStore() || fallback()) }),
};

// Runs a symbol/cvar map or render map scan off the main thread: the engine-wide scan reads ~30k files
// synchronously (~45 s) and would otherwise stall the Hub's HTTP/MCP server.
'use strict';
const { parentPort, workerData } = require('worker_threads');

try {
  const { kind, name, root, notesRoots } = workerData;
  const result = kind === 'render' ? require('./renderpipe').scan(name, root) : require('./symbolmap').scan({ name, root, notesRoots });
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message });
}

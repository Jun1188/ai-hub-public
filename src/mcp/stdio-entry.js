#!/usr/bin/env node
// stdio entry point: launched directly by MCP clients (Claude Code, Antigravity,
// Codex, Gemini CLI, or any third-party host).
'use strict';

const { serveStdio } = require('@modelcontextprotocol/server/stdio');
const { createHubServer } = require('./hub-server');
const downstream = require('../core/downstream');

async function main() {
  // SDK v2 probes server/discover and serves either protocol era.
  await serveStdio(() => createHubServer());
  const shutdown = async () => {
    await downstream.closeAll().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[ai-hub] fatal:', err);
  process.exit(1);
});

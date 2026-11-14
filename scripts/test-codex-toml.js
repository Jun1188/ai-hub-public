// Verifies the codex TOML strip regex removes only our sections.
'use strict';
const SERVER = 'ai-hub';

const original = [
  'model = "gpt-5.5"',
  '',
  '[mcp_servers.unityMCP]',
  'url = "http://127.0.0.1:8080/mcp"',
  '',
  '[features]',
  'memories = true',
  '',
].join('\n');

const withHub =
  original +
  `\n[mcp_servers.${SERVER}]\ncommand = 'node'\nargs = ['entry.js']\n` +
  `\n[mcp_servers.${SERVER}.env]\nELECTRON_RUN_AS_NODE = "1"\n`;

const re = new RegExp(`(?:^|\\n)\\[mcp_servers\\.${SERVER}(?:\\.[\\w.]+)?\\][^]*?(?=\\n\\[|$)`, 'g');
const stripped = withHub.replace(re, '');

const ok1 = stripped.includes('[mcp_servers.unityMCP]') && stripped.includes('[features]') && stripped.includes('model =');
const ok2 = !stripped.includes(SERVER);
console.log('other sections preserved:', ok1);
console.log('hub sections removed:', ok2);
process.exit(ok1 && ok2 ? 0 : 1);

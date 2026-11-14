// Stand-in for `rea` (rea-agents 6.4.0) used by test-rea-analysis.js. Mirrors the CLI contract that the Hub relies on:
// known commands and flags only, progress on stderr, Evidence or an error envelope ({error, code, message}) on stdout.
import { createHash } from 'node:crypto';
const fail = (code, message) => { process.stdout.write(JSON.stringify({ error: 'Analysis failed', code, message })); process.exit(1); };
const FLAGS = { providers: [], analyze: ['--provider'], function: ['--procedure', '--provider'], decompile: ['--procedure', '--provider'],
  xrefs: ['--address', '--provider'], 'inspect-managed-artifact': [], 'inspect-managed-members': [], 'analyze-javascript-application': [] };
const [command, ...rest] = process.argv.slice(2);
if (!(command in FLAGS)) fail('COMMAND_NOT_FOUND', 'Unknown command: ' + command);
const positional = [], options = {};
let filter = null;
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  if (arg === '--json') continue;
  if (arg === '--filter-output') { filter = rest[++i]; continue; }
  if (arg.startsWith('--')) {
    const [name, value] = arg.split(/=(.*)/s);
    if (!FLAGS[command].includes(name) || value === undefined) fail('UNKNOWN_FLAG', 'Unknown flag: ' + name);
    options[name] = value;
  } else positional.push(arg);
}
if (command === 'providers') {
  process.stdout.write(JSON.stringify({ open: false,
    capabilities: [{ operation: 'inspect_managed_artifact', available: true }, { operation: 'capture_native_ui_scenario', available: false, reason: 'Native macOS utilities require macOS.' }],
    analysis_provider_candidates: [{ provider: { id: 'ghidra', name: 'Ghidra', version: '12.1.4' }, availability: { status: 'unavailable', reason: 'GHIDRA_INSTALL_DIR is not set' } }],
    server_identity: { package: { name: 'rea-agents', version: '6.4.0' } } }));
  process.exit(0);
}
const [target] = positional;
process.stderr.write(JSON.stringify({ rea_progress: { phase: command, completed: 0, total: 1 } }) + '\n');
if (positional.length !== 1) fail('INVALID_ARGUMENTS', 'Expected one target path');
if (/fail/.test(String(target))) fail('capability_unavailable', 'Fixture provider is unavailable.');
const extra = options['--procedure'] || options['--address'] || '';
const id = 'ev_' + createHash('sha256').update([command, target, extra].join('\0')).digest('hex');
const evidence = { evidence_id: id,
  subject: { name: 'fixture', digest: { sha256: 'a'.repeat(64) }, format: 'pe', architecture: 'x86-64', local_path: target },
  provider: { id: 'rea-managed', name: 'REA managed analyzer', version: '1' }, analysis_profile: null,
  predicate_type: 'rea.fixture', operation: command, parameters: { extra: extra || null }, confidence: 'observed', authority: 'shipped-artifact',
  environment: null, limitations: ['Fixture limitation: metadata only.'], locations: [{ kind: 'symbol', name: 'Example.Parser', address: '0x1000' }],
  evidence_links: [], raw_result: null, normalized_result: { summary: { types: 1 }, graph: { large: true }, pseudocode: 'int parse(void) { return 0; }' } };
// --filter-output keeps the listed top-level keys and, for "a.b" paths, only the listed children.
function project(value, keys) {
  const out = {};
  for (const key of keys) {
    const [head, child] = key.replace(/\[.*\]$/, '').split('.');
    if (!(head in value)) continue;
    if (!child) out[head] = value[head];
    else if (value[head] && child in value[head]) out[head] = { ...(out[head] || {}), [child]: value[head][child] };
  }
  return out;
}
process.stdout.write(JSON.stringify(filter ? project(evidence, filter.match(/[^,[]+(?:\[[^\]]*\])?/g)) : evidence)); // commas inside [a,b] slices stay

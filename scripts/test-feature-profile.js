'use strict';
// 경량 프로필의 기능 표(feature-profile): 같은 오버레이에서 화면 단추와 MCP 도구만 거른다.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); } }
const fp = require('../src/core/feature-profile');
const full = { hub: { profile: 'full' } }, lite = { hub: { profile: 'lite' } };

check('full profile shows every tab and tool', () => {
  assert.deepStrictEqual(fp.view(full).hiddenTabs, []);
  assert(fp.toolEnabled('ue_cvar_find', full) && fp.toolEnabled('symbol_find', full));
});
check('lite default: dashboard, debugging, light source analysis, knowledge graph', () => {
  const v = fp.view(lite);
  assert.deepStrictEqual(v.features.filter((f) => f.enabled).map((f) => f.id), ['dashboard', 'debugging', 'knowledge', 'source']);
  for (const t of ['aider', 'pipelines', 'projects', 'skills', 'memory', 'selfimprove', 'history']) assert(v.hiddenTabs.includes(t), t);
  assert(!v.hiddenTabs.includes('settings'));
});
check('lite drops game-engine source tools and keeps the rest', () => {
  for (const t of ['ue_class_info', 'ue_source_scan', 'render_pipeline_map', 'symbol_hierarchy', 'deep_analysis_briefing']) assert(!fp.toolEnabled(t, lite), t);
  for (const t of ['source_search', 'source_qa', 'offload_run', 'skill_find', 'knowledge_graph_query', 'render_monitor', 'hub_status']) assert(fp.toolEnabled(t, lite), t);
});
check('a lite device can pick its own features; unknown ids are dropped', () => {
  const cfg = { hub: { profile: 'lite', liteFeatures: ['engine-source', 'memory', 'nope'] } };
  assert.deepStrictEqual([...fp.enabled(cfg)], ['engine-source', 'memory']);
  assert(fp.toolEnabled('ue_cvar_find', cfg));
  assert.deepStrictEqual(fp.sanitize(['memory', 'nope', 'dashboard']), ['dashboard', 'memory']);
  assert.strictEqual(fp.sanitize('memory'), null);
  assert(fp.view(full).features.find((f) => f.id === 'dashboard').inLite);
});
check('every tab button in index.html belongs to a feature or is settings', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
  const known = new Set(['settings', ...fp.FEATURES.flatMap((f) => f.tabs)]);
  assert.deepStrictEqual(tabs.filter((t) => !known.has(t)), []);
  assert(/data-feature="engine-source"/.test(html));
});
check('hub.liteFeatures stays on this device', () => {
  assert(require('../src/core/config').LOCAL_ONLY_PATHS.includes('hub.liteFeatures'));
});

console.log(`기능 프로필: 통과 ${passed} / 실패 ${failed}`);
if (failed) process.exitCode = 1;

'use strict';
const fs = require('fs');
const path = require('path');
const URI = 'ui://ai-hub/harness.html';
const MIME = 'text/html;profile=mcp-app';
async function snapshot() {
  const data = await require('../core/resource-monitor').snapshot();
  // Explicit allowlist: modelFit may contain paths; never project it into the panel.
  return { contractVersion: '1.0.0', sampledAt: data.sampledAt, pollAfterMs: 5000,
    resources: { cpu: data.cpu, ram: data.ram, gpu: data.gpu, hub: data.hub, scope: data.scope },
    modelOperations:(data.modelOperations||[]).map(r=>({requestId:r.requestId,provider:r.provider,state:r.state,phase:r.phase,admission:r.admission})),
    offloadJobs: require('../core/offload').active().length };
}
function registerHarnessPanel(server) {
  require('./harness-panel-actions').register(server);
  const ui = { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] }, prefersBorder: true };
  server.registerResource('ai-hub-harness-panel', URI, { mimeType: MIME, _meta: { ui } }, async () => ({
    contents: [{ uri: URI, mimeType: MIME, text: fs.readFileSync(path.join(__dirname, 'harness-panel.html'), 'utf8'), _meta: { ui } }],
  }));
  const handler = async () => {
    const value = await snapshot();
    return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
  };
  server.registerTool('harness_panel', {
    title: 'ai-hub · 자원과 작업 상태',
    description: 'Open the ai-hub panel. This call is read-only: system resources, model preparation and running offload job count, no secrets. Controls inside the panel act only after the user confirms them there.',
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: URI }, 'openai/ui': { entrypoints: [{ type: 'thread' }] } },
  }, handler);
  server.registerTool('harness_panel_refresh', {
    title: 'Refresh Hub panel measurements', description: 'Read-only cached measurements for the panel.',
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] } },
  }, handler);
}
module.exports = { registerHarnessPanel, snapshot };

// IPC: per-process hardware record (telemetry) for the dashboard.
'use strict';
const telemetry = require('../../src/core/telemetry');

/** @param {import('./register-handlers').IpcContext} ctx */
function register(ctx) {
  const { handle } = ctx;
  handle('res:report', async (sinceSeconds) => {
    const report = await telemetry.report({ sinceSeconds: Math.max(10, Math.min(172800, Number(sinceSeconds) || 600)), top: 8 });
    // 진단 → 그 진단에서 나온 RSI 제안. 제안 장부를 못 읽어도 자원 기록은 그대로 보인다.
    try { report.findings = require('../../src/core/governor/monitoring-gaps').link(report.findings, await require('../../src/core/rsi/research-agents').list()); } catch { /* 연결 없이 표시 */ }
    return report;
  });
  handle('res:exportTrace', (sinceSeconds) => telemetry.exportTrace({ sinceSeconds: Math.max(10, Math.min(172800, Number(sinceSeconds) || 600)) }));
  handle('res:openInsights', (file) => require('../../src/core/devtools').openInsights(file));
}

module.exports = { register };

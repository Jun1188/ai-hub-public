'use strict';
function register(server) {
  const research = require('../core/research-review');
  for (const [name, title, handler] of [
    ['research_review_status', 'Research review and calibration status', () => research.summary()],
    ['research_review_brief', 'Verified research hypotheses for improvement proposals', async () => {
      const s = await research.status();
      return { ...research.project(s), brief: s.stale ? '' : s.brief || '' };
    }],
  ]) server.registerTool(name, {
    title, description: 'Read stored source-verified hypotheses. No browsing, model call, source edit, installation or adoption. Ratings are triage; measured gains require evaluations.',
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => { const data = await handler(); return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] }; });
}
module.exports = { register };

'use strict';
const path = require('path');
const { execFile } = require('child_process');
let cached = null, expires = 0, pending = null;
const unavailable = () => ({ available: false, authority: 'proposals-only', selected: [], brief: '', stale: true });
async function read(deps = {}) {
  const repo = (deps.memory || require('./shared-repo-memory')).repoRoot();
  if (!repo) return unavailable();
  const bootstrap = (deps.bootstrap || require('./shared-agent-context')).manifest();
  const args = [path.join(repo, 'tools', 'research_review.cjs'), 'brief-json', '--repo', repo];
  if (bootstrap?.researchStateRoot) {
    if (!path.isAbsolute(bootstrap.researchStateRoot)) return unavailable();
    args.push('--state', bootstrap.researchStateRoot);
  }
  return new Promise(resolve => {
    (deps.execFile || execFile)(process.execPath, args, {
      cwd: repo, timeout: 8000, windowsHide: true, encoding: 'utf8', maxBuffer: 128 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }, (error, stdout) => {
      if (error) return resolve(unavailable());
      try { const value = JSON.parse(stdout); resolve({ ...value, available: true }); }
      catch { resolve(unavailable()); }
    });
  });
}
async function status() {
  if (cached && Date.now() < expires) return cached;
  if (!pending) pending = read().then(value => { cached = value; expires = Date.now() + 60000; return value; })
    .catch(() => unavailable()).finally(() => { pending = null; });
  return pending;
}
function project(s) {
  return { available: s.available, authority: 'proposals-only', stale: Boolean(s.stale), partial: Boolean(s.partial),
    lastReviewAt: s.lastReviewAt || null, count: s.count || 0, eligibleCount: s.eligibleCount || 0,
    calibrationSamples: s.calibration ? s.calibration.samples : 0,
    selected: (s.selected || []).slice(0, 3).map(c => ({ hypothesisId: c.hypothesisId, title: c.title,
      kind: c.kind, origin: c.origin || 'research', component: c.component, score: c.score, confidence: c.confidence,
      status: c.status, measured: Boolean(c.measured) })) };
}
async function summary() { return project(await status()); }
module.exports = { status, summary, project, read };

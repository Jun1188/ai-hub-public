'use strict';
// Run against a fully assembled candidate. All input, worker responses, and data roots are temporary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const app = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-w56-'));
process.env.APPDATA = dir;
const core = name => require(path.join(app, 'src/core', name));
const checks = [];
function check(name, fn) { fn(); checks.push(name); }
function write(name, content) {
  const dest = path.join(dir, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
}

async function routes() {
  const rule = '# Rules\n- Use the `anchorTag` helper for evaluation in this synthetic fixture.\n';
  write('AGENTS.md', rule);
  write('.claude/rules/renderer.md', rule);
  write('skills/development/sample/SKILL.md', '---\nname: sample\ndescription: Fixture\n---\nanchorTag HARNESS_BODY_ONLY');
  write('src/fixture.js', 'function anchorTag() { return "HUB_BODY_ONLY"; }');
  const requests = [];
  const deps = { dataDir: dir, appRoot: dir, sharedRepo: { repoRoot: () => dir }, bootstrap: { manifest: () => null },
    telemetry: { report: async () => ({ findings: [{ kind: 'fake', severity: 'info', summary: 'DIAGNOSTIC_ONLY' }] }) },
    audit: { audit: async () => ({ totals: { files: 1 }, files: [{ path: 'src/fixture.js', lines: 1 }],
      cycles: [], coupled: [], violations: [], upward: [], duplicates: [], hotspots: [], orphans: [], unclassified: [] }) },
    runJudge: async req => {
      requests.push(req);
      const id = /^- \[([^\]]+)\] /m.exec(req.task)[1];
      return { ok: true, value: { items: [{ id, verdict: 'meets', confidence: 1 }] } };
    } };
  core('evaluation/deterministic-eval').evaluate = async subject => ({ fingerprint: subject.kind, score: 1 });
  const ops = core('rsi/hub-operations').operations(deps);
  const run = arg => ops['eval.agent'].fn(arg);
  await run({ subject: 'hub-source' });
  check('MCP/IPC operation default sends cloud coordinates and counts', () => {
    const r = requests.at(-1);
    assert.equal(r.worker, 'codex');
    assert.match(r.text, /src\/fixture.js/);
    assert.match(r.text, /debuggingFindingCount/);
    assert.doesNotMatch(r.text, /HUB_BODY_ONLY|DIAGNOSTIC_ONLY/);
  });
  const samples = await ops['eval.sample'].fn({ subjects: ['hub-source', 'shared-skills'] });
  check('sample default reuses summary cache and withholds harness body', () => {
    assert.equal(samples.sampled.length, 2); assert.equal(samples.sampled[0].cached, true);
    const r = requests.at(-1); assert.equal(r.worker, 'codex');
    assert.match(r.text, /skills\/development\/sample\/SKILL.md/); assert.doesNotMatch(r.text, /HARNESS_BODY_ONLY/);
  });
  await run({ subject: 'shared-skills', worker: 'codex' });
  check('explicit full harness and summary have distinct cache keys', () => assert.match(requests.at(-1).text, /HARNESS_BODY_ONLY/));
  await run({ subject: 'hub-source', includeSource: true });
  check('previous implicit excerpt stays local', () => {
    assert.equal(requests.at(-1).worker, 'local'); assert.match(requests.at(-1).text, /HUB_BODY_ONLY/);
  });
  await run({ subject: 'hub-source', worker: 'agy', includeSource: true });
  check('explicit cloud excerpt retained', () => {
    assert.equal(requests.at(-1).worker, 'agy'); assert.match(requests.at(-1).text, /HUB_BODY_ONLY/);
  });
  await run({ subject: 'shared-skills', worker: 'local' });
  check('explicit local retained', () => assert.equal(requests.at(-1).worker, 'local'));
  check('GUI starts with implicit summary route', () => assert.match(fs.readFileSync(path.join(app, 'ui/index.html'), 'utf8'), /id="si-worker"[^>]*><option value=""/));
}

async function usage() {
  let replies = [];
  core('local-chat-stream').chat = async () => {
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return { content: 'ok', finishReason: 'stop', ...next };
  };
  const jobs = core('offload').createOffload({ file: path.join(dir, 'jobs.json'),
    hardware: { withLocalSlot: fn => fn() }, selectLocal: async () => ({ picked: { provider: 'llamacpp', model: 'synthetic', contextLength: 4096 } }),
    prepare: async () => ({ model: 'synthetic' }), runAgy: async () => ({ model: 'fixture', response: 'ok', usage: { input_tokens: null, output_tokens: 0 } }) });
  const run = async (responses, worker = 'local') => {
    replies = responses;
    const r = await jobs.runAndWait({ worker, task: 'synthetic', text: 'fixture' }, 5);
    return [r.state, r.usage.inputTokens, r.usage.cachedInputTokens, r.usage.outputTokens];
  };
  const vectors = [
    ['observed local fields', [{ usage: { prompt_tokens: 9, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 5 } } }], ['succeeded', 9, 5, 3]],
    ['measured zero cache', [{ usage: { prompt_tokens: 9, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } }], ['succeeded', 9, 0, 0]],
    ['string counters reject impossible cache', [{ usage: { prompt_tokens: '5', completion_tokens: '2', prompt_tokens_details: { cached_tokens: '7' } } }], ['succeeded', 5, null, 2]],
    ['absent usage', [{ usage: null }], ['succeeded', null, null, null]],
    ['invalid fields and impossible cache', [{ usage: { prompt_tokens: 5, completion_tokens: false, prompt_tokens_details: { cached_tokens: 7 } } }], ['succeeded', 5, null, null]],
    ['retry with partial reporting stays missing', [{ finishReason: 'length', usage: { prompt_tokens: 5, completion_tokens: 1 } }, { usage: { prompt_tokens: 7, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } } }], ['succeeded', 12, null, 3]],
    ['launched request interrupted before usage', [new Error('fixture failure')], ['failed', null, null, null]],
    ['agy explicit null and observed zero', [], ['succeeded', null, null, 0], 'agy']
  ];
  for (const [name, responses, expected, worker] of vectors) {
    const seen = await run(responses, worker);
    check(name, () => assert.deepEqual(seen, expected));
  }
}

(async () => { await routes(); await usage(); console.log(JSON.stringify({ schemaVersion: 1, passed: checks }, null, 2)); })()
  .catch(err => { console.error(err); process.exitCode = 1; });

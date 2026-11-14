'use strict';
// 작업 표(Hub 쪽) 회귀 테스트: 사건 파일 형식·이름 순서·정화, 행 키가 Python work_table.key_of와 같다,
// AGENT_WORK_DIR 없이 node에서는 쓰지 않는다, 하네스 로그 쓸기(행 없는 최근 세션만 unconfirmed),
// offload 대기와 실행 시간 분리(G-4). 임시 폴더만 쓴다.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-work-table-test-'));
process.env.APPDATA = path.join(SANDBOX, 'appdata');
const wt = require('../src/core/work-table');
const queue = () => { try { return fs.readdirSync(path.join(SANDBOX, 'wt', 'inbox.d')).sort(); } catch { return []; } };
const events = () => queue().map((n) => JSON.parse(fs.readFileSync(path.join(SANDBOX, 'wt', 'inbox.d', n), 'utf8')));

(async () => {
  // 1) AGENT_WORK_DIR가 없는 node 프로세스(시험 스크립트)는 실제 표에 쓰지 않는다
  delete process.env.AGENT_WORK_DIR;
  assert.equal(wt.dir(), path.join(os.homedir(), '.agent-work'));
  assert.equal(wt.emit({ ev: 'note', k: 'x' }), false);
  process.env.AGENT_WORK_DIR = path.join(SANDBOX, 'wt');

  // 2) 행 키는 Python과 같다(work_table.key_of('claude', 'abc'), key_of('codex', 'abc'))
  assert.equal(wt.keyOf('claude', 'abc'), require('crypto').createHash('sha256').update('claude-code\u0000abc').digest('hex').slice(0, 16));
  assert.equal(wt.keyOf('claude-code', 'abc'), wt.keyOf('claude', 'abc'));
  assert.equal(wt.keyOf('claude', 'abc'), 'ecd1226b22d0c489'); // python tools/work_table.py: key_of('claude', 'abc')

  // 3) 작업 사건: 이름은 시각 순, 요약은 정화(긴 16진수·키·사용자 경로 없음), 시도 = 작업 id 앞 8자
  const id = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
  wt.job('offload', id, { worker: 'local', state: 'working', summary: `read ${'ab'.repeat(20)} api_key=hunter22 ${os.homedir()}\\x | y` });
  wt.job('offload', id, { worker: 'local', state: 'done', summary: 'offload local succeeded' });
  const [a, b] = events();
  const h8 = require('crypto').createHash('sha256').update(id).digest('hex').slice(0, 8);
  assert.deepEqual([a.ev, a.k, a.h, a.w, a.s, a.att], ['job', `hub-offload-${h8}`, 'hub', 'offload:local', 'working', h8]);
  // review #48: two bus ids made in the same moment (m-<time36>-<random>) must not share a row
  wt.job('bus', 'm-mhc9k2ab-1a2b3c', { state: 'working' }); wt.job('bus', 'm-mhc9k2ab-9f8e7d', { state: 'working' });
  const [, , b1, b2] = events();
  assert.notEqual(b1.k, b2.k);
  assert(!/[0-9a-f]{32,}/i.test(a.sum) && !a.sum.includes('hunter22') && !a.sum.includes(os.homedir()) && !a.sum.includes('|'), a.sum);
  assert(a.sum.length <= 60);
  assert.equal(b.s, 'done');
  assert(queue()[0] < queue()[1]);
  assert(!queue().some((n) => n.endsWith('.tmp')));
  assert.equal(wt.logical(path.join(os.homedir(), 'Documents', 'Codex', 'repo', 'a.md')), 'work:repo/a.md');

  // 4) offload 시작·끝 → 행, 대기와 실행 분리(G-4). 가짜 GPU 슬롯이 80ms 기다리게 한다.
  for (const n of queue()) fs.unlinkSync(path.join(SANDBOX, 'wt', 'inbox.d', n));
  const offload = require('../src/core/offload');
  const hardware = { refresh: async () => {}, advise: () => ({ route: 'local', model: 'm', ctxTokens: 4096, reasons: [] }),
    withLocalSlot: async (fn) => { await new Promise((r) => setTimeout(r, 80)); return fn(); } };
  const jobs = wt.watchOffload(offload.createOffload({ file: path.join(SANDBOX, 'jobs.json'), hardware,
    prepare: async (p) => ({ model: p.model }), selectLocal: async () => ({ picked: { provider: 'lmstudio', model: 'm', contextLength: 4096 } }) }));
  const broker = require('../src/core/credential-broker');
  const requestResponse = broker.requestResponse;
  let r;
  try {
    broker.requestResponse = async () => { throw new Error('synthetic chat failure'); };
    r = await jobs.runAndWait({ task: 'classify', text: 'hello' }, 20);
  } finally {
    broker.requestResponse = requestResponse;
  }
  assert(r.usage.waitMs >= 70, JSON.stringify(r.usage));
  const stored = jobs.list().find((x) => x.id === r.id);
  assert.equal(stored.usage.runMs, stored.usage.workerMs - stored.usage.waitMs);
  const rows = events();
  assert.deepEqual(rows.map((e) => e.s), ['working', 'failed']);
  assert.match(rows[1].sum, /^offload local failed .*wait 0s$/);

  // 5) 쓸기: 최근에 쓴, 행이 없는 최상위 세션 로그만. 하위 에이전트 로그·오래된 로그·행이 있는 세션은 건너뛴다.
  for (const n of queue()) fs.unlinkSync(path.join(SANDBOX, 'wt', 'inbox.d', n));
  const claude = path.join(SANDBOX, 'claude', 'projects'), codex = path.join(SANDBOX, 'codex', 'sessions');
  const cwd = path.join(os.homedir(), 'Documents', 'Codex', 'hub-x');
  const put = (file, text, ageMs = 0) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
    const t = new Date(Date.now() - ageMs); fs.utimesSync(file, t, t); return { file, mtimeMs: t.getTime() }; };
  const sid = '11111111-2222-3333-4444-555555555555', tid = '66666666-7777-8888-9999-000000000000';
  const line = JSON.stringify({ type: 'user', cwd }) + '\n';
  const active = [
    { harness: 'claude-code', root: claude, ...put(path.join(claude, 'C--proj', `${sid}.jsonl`), line) },
    { harness: 'claude-code', root: claude, ...put(path.join(claude, 'C--proj', sid, 'subagents', 'agent-1.jsonl'), line) },
    { harness: 'claude-code', root: claude, ...put(path.join(claude, 'C--proj', 'old.jsonl'), line, 3 * 3600 * 1000) },
    { harness: 'codex', root: codex, ...put(path.join(codex, '2026', '10', '25', `rollout-2026-10-25T22-00-00-${tid}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { id: tid, cwd } }) + '\n') },
    { harness: 'claude-code', root: claude, ...put(path.join(claude, 'C--proj', 'has-row.jsonl'), line) },
    // headless runs are jobs, not peer sessions: `codex exec` and `claude -p`
    { harness: 'codex', root: codex, ...put(path.join(codex, '2026', '10', '25', 'rollout-2026-10-25T22-01-00-77777777-8888-9999-aaaa-bbbbbbbbbbbb.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd, originator: 'codex_exec', source: 'exec' } }) + '\n') },
    { harness: 'claude-code', root: claude, ...put(path.join(claude, 'C--proj', 'print-run.jsonl'), JSON.stringify({ type: 'user', cwd, entrypoint: 'sdk-cli' }) + '\n') },
  ];
  fs.writeFileSync(path.join(SANDBOX, 'wt', 'state.json'), JSON.stringify({ schema: 'agent-work/1', rows: { [wt.keyOf('claude', 'has-row')]: {} } }));
  assert.equal(await wt.sweep(active), 2);
  const swept = events();
  assert.deepEqual(swept.map((e) => [e.ev, e.h, e.k, e.cwd, e.w, e.src]), [
    ['sweep', 'claude', wt.keyOf('claude', sid), 'work:hub-x', 'hub-x', 'sweep'],
    ['sweep', 'codex', wt.keyOf('codex', tid), 'work:hub-x', 'hub-x', 'sweep']]);
  // 깨진 state.json이면 행을 중복으로 만들지 않도록 아무것도 쓰지 않는다
  fs.writeFileSync(path.join(SANDBOX, 'wt', 'state.json'), '{');
  assert.equal(await wt.sweep(active), 0);

  // 6) 하네스 로그 수집기가 쓸기를 부르고 그 수를 lastRun에 남긴다
  fs.unlinkSync(path.join(SANDBOX, 'wt', 'state.json'));
  for (const n of queue()) fs.unlinkSync(path.join(SANDBOX, 'wt', 'inbox.d', n));
  const log = await require('../src/core/harness-skill-log').collect({ dataDir: path.join(SANDBOX, 'hubdata'), roots: { 'claude-code': claude, codex } });
  assert.equal(log.swept, 3, JSON.stringify(log)); // no state.json now, so has-row is swept too; old and subagent logs are not

  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log('work-table: emit/keys/scrub, offload wait split, sweep — OK');
})().catch((e) => { console.error(e); process.exit(1); });

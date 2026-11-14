'use strict';
// 채팅 명령·태그(hub-commands.js): 해석·검증, 읽기/쓰기 허용(allowWrite + confirm), Discord·GitHub 경로, Discord 대기 헤더,
// Drive 미러(삭제 없음·탈출 거부·시간 초과·회로 차단), MCP 도구·프롬프트(바이트 불변)·리소스, 기록의 가림, 경로 표.
// 가짜 fetch·더미 키·임시 폴더만 쓴다(규칙 11). 실제 Discord·GitHub·Google·Drive 호출은 없다.
const assert = require('assert/strict'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-cmd-test-'));
process.env.APPDATA = path.join(temp, 'appdata');
process.env.LOCALAPPDATA = path.join(temp, 'local');
process.env.AGENT_WORK_DIR = path.join(temp, 'agent-work');
const connections = require('../src/core/api-connections'), specs = require('../src/core/api-specs');
const tools = require('../src/mcp/external-connection-tools'), cmd = require('../src/core/hub-commands');
const drive = require('../src/core/drive-sync-folder'), discord = require('../src/core/discord-actions'), github = require('../src/core/github-actions');
const keepAlive = setInterval(() => {}, 1000);

(async () => {
  let checks = 0;
  const ok = (v, label) => { assert.ok(v, label); checks++; };
  const rejects = async (fn, re, label) => { await assert.rejects(fn, re, label); checks++; };
  const key = 'fixture-only-dummy-key', root = path.join(temp, 'data'), keys = new Map();
  const vault = { put: (id, v) => keys.set(id, v), use: (id, _o, fn) => fn(keys.get(id)), statusFor: (id) => ({ stored: keys.has(id) }), remove: (id) => keys.delete(id) };
  const store = connections.createStore({ root, vault, isBusy: () => false });
  const discordPreset = connections.PRESETS.find((p) => p.id === 'discord'), githubPreset = connections.PRESETS.find((p) => p.id === 'github');
  store.save({ ...discordPreset, maxCallsPerRun: 32 }, key);
  const seen = [];
  let reply = () => new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const fetchMock = async (url, o) => { seen.push({ url: String(url), method: o.method, body: o.body ? JSON.parse(o.body) : undefined, auth: o.headers.Authorization }); return reply(String(url), o); };
  let clock = 1e12;
  const logFile = path.join(temp, 'hub-commands.jsonl');
  const fakeDownstream = { listConfigured: () => [{ name: 'unity', type: 'http', connected: true }, { name: 'idle-server', type: 'stdio', connected: false }],
    listTools: async () => [{ name: 'unity_status', description: 'Editor status' }, { name: 'unity_build', description: 'Build player' }] };
  const deps = { store, fetch: fetchMock, callApi: tools.callApi, now: () => (clock += 5000), logFile, downstream: fakeDownstream, specs: specs.createSpecs({ root, store }) };
  const json = (v, status = 200, headers = {}) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const ID = '123456789012345678', ID2 = '223456789012345678';

  // 1) 해석·검증
  ok(cmd.parse('/discord guilds').name === 'discord guilds', 'guilds');
  ok(cmd.parse(`/discord messages ${ID}`).args.limit === 10 && cmd.parse(`/discord messages ${ID} 20`).args.limit === 20, '메시지 개수 기본 10, 상한 20');
  const send = cmd.parse(`/discord send ${ID}   빌드 완료:  v1.2  "배포"`);
  ok(send.write && send.args.content === '빌드 완료:  v1.2  "배포"', '보낼 글은 채널 ID 뒤 원문 그대로(공백 유지)');
  ok(cmd.parse(`/discord send ${ID} "따옴표 한 쌍은 벗김"`).args.content === '따옴표 한 쌍은 벗김', '감싼 따옴표');
  ok(cmd.parse('/actions @club-gh runs octo/game').connection === 'club-gh', '명령 뒤 @연결 선택');
  const runs = cmd.parse('/actions runs octo/game deploy.yml 5');
  ok(runs.args.workflow === 'deploy.yml' && runs.args.limit === 5 && cmd.parse('/actions runs octo/game 7').args.limit === 7 && cmd.parse('/actions runs octo/game 161335').args.workflow === '161335', 'runs 선택 인자');
  const dispatch = cmd.parse('/actions dispatch octo/game deploy.yml main target=pages "note=빌드 3"');
  ok(dispatch.write && dispatch.args.ref === 'main' && dispatch.args.inputs.target === 'pages' && dispatch.args.inputs.note === '빌드 3', 'dispatch 입력');
  ok(cmd.parse('/drive mirror "C:\\builds\\My Game" games/my-game').args.target === 'games/my-game' && cmd.parse('/drive ls').args.path === '', 'drive 해석');
  ok(cmd.parse('@discord messages send').kind === 'tag' && cmd.parse('@discord messages send').query === 'messages send', '태그');
  const bad = [
    ['/discord channels 12', /Discord ID/], ['/discord messages ' + ID + ' 21', /1–20/], ['/discord send ' + ID, /사용법/], ['/discord send abc hi', /Discord ID/],
    ['/discord send ' + ID + ' ' + 'x'.repeat(2001), /2000/], ['/discord send ' + ID + ' 키 ghp_' + 'a'.repeat(36), /credential/],
    ['/discord send ' + ID + ' 경로 C:\\Users\\someone\\x', /private user path/],
    ['/actions runs octo', /owner\/repo/], ['/actions runs octo/game/x', /owner\/repo/], ['/actions runs -octo/game', /owner\/repo/], ['/actions runs octo/..', /owner\/repo/],
    ['/actions run octo/game abc', /실행 ID/], ['/actions dispatch octo/game deploy.sh main', /워크플로/], ['/actions dispatch octo/game deploy.yml ../main', /ref/],
    ['/actions dispatch octo/game deploy.yml main bad', /이름=값/], ['/actions dispatch octo/game deploy.yml main ' + Array.from({ length: 11 }, (_, i) => `k${i}=v`).join(' '), /10개/],
    ['/drive ls ../outside', /상대 경로/], ['/drive ls C:\\Windows', /상대 경로/], ['/drive ls keys/.env', /민감/], ['/drive ls secrets/id_rsa', /민감/],
    ['/drive mirror C:\\src', /사용법/], ['/drive mirror C:\\src .', /하위 폴더/],
    ['/api discord https://evil.example/x', /경로/], ['/api Discord /x', /연결 ID/], ['/unknown x', /모르는 명령/], ['hello', /\/로/], ['@bad!tag', /@연결ID/], ['', /1–4000/],
  ];
  for (const [line, re] of bad) assert.throws(() => cmd.parse(line), re, line), checks++;

  // 2) Discord 경로·인증·응답 줄이기
  reply = (url) => url.endsWith('/users/@me/guilds') ? json([{ id: ID, name: '동아리', icon: 'x', permissions: '8' }])
    : url.includes('/channels?') || url.endsWith('/channels') ? json([{ id: ID2, name: 'general', type: 0, parent_id: ID }, { id: '323456789012345678', name: 'voice', type: 2 }])
    : json([{ id: '1', content: '안녕', timestamp: '2026-10-28T00:00:00Z', author: { username: 'bot', global_name: 'Bot' }, attachments: [{}], embeds: [] }]);
  const guilds = await cmd.run('/discord guilds', { via: 'ui' }, deps);
  ok(seen.at(-1).url === 'https://discord.com/api/v10/users/@me/guilds' && seen.at(-1).method === 'GET' && seen.at(-1).auth === 'Bot ' + key, 'guilds 경로·Bot 인증');
  ok(JSON.stringify(guilds.result.guilds) === JSON.stringify([{ id: ID, name: '동아리' }]) && guilds.result.notice && !JSON.stringify(guilds).includes(key), '필요한 필드만, 외부 데이터 표시, 키 없음');
  const ch = await cmd.run(`/discord channels ${ID}`, {}, deps);
  ok(seen.at(-1).url === `https://discord.com/api/v10/guilds/${ID}/channels` && ch.result.channels[0].type === 'text' && ch.result.channels[0].parent === ID, 'channels 경로');
  const msgs = await cmd.run(`/discord messages ${ID2} 3`, {}, deps);
  ok(seen.at(-1).url === `https://discord.com/api/v10/channels/${ID2}/messages?limit=3` && msgs.result.messages[0].author === 'Bot' && msgs.result.messages[0].attachments === 1, 'messages 경로·작성자');

  // 3) 쓰기 허용: allowWrite가 꺼져 있으면 보내지도 묻지도 않는다 → 켜면 confirm 없이 계획만 → confirm:true면 POST
  let n = seen.length;
  await rejects(() => cmd.run(`/discord send ${ID2} 배포했습니다`, { confirm: true }, deps), /쓰기를 허용하지 않습니다/, 'allowWrite 꺼짐');
  ok(seen.length === n, '막힌 쓰기는 보내지 않음');
  store.save({ ...discordPreset, maxCallsPerRun: 32, allowWrite: true });
  const plan = await cmd.run(`/discord send ${ID2} 배포했습니다 @everyone`, {}, deps);
  ok(plan.confirmRequired && /채널 223456789012345678/.test(plan.summary) && seen.length === n, 'confirm 없으면 계획만, 전송 없음');
  reply = () => json({ id: '999', channel_id: ID2, content: 'x' });
  const sent = await cmd.run(`/discord send ${ID2} 배포했습니다 @everyone`, { confirm: true }, deps);
  ok(seen.at(-1).method === 'POST' && seen.at(-1).url === `https://discord.com/api/v10/channels/${ID2}/messages` && seen.at(-1).body.content === '배포했습니다 @everyone'
    && JSON.stringify(seen.at(-1).body.allowed_mentions) === '{"parse":[]}' && sent.result.sent.id === '999', 'send POST·멘션 끔');

  // 4) Discord 대기 헤더: 버킷이 비면 재설정까지 차단, 429는 Retry-After만큼 차단, 자동 재시도 없음
  store.save({ ...discordPreset, id: 'discord-rl', maxCallsPerRun: 32 }, key);
  reply = () => json([], 200, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '30' });
  await cmd.run('/discord @discord-rl guilds', {}, deps);n = seen.length;
  await rejects(() => cmd.run('/discord @discord-rl guilds', {}, deps), /회로가 잠시 차단/, '버킷 소진 뒤 차단');
  ok(seen.length === n, '차단 중에는 보내지 않음');
  store.save({ ...discordPreset, id: 'discord-429', maxCallsPerRun: 32 }, key);
  reply = () => json({ message: 'You are being rate limited.', retry_after: 2.5, global: false }, 429, { 'Retry-After': '3' });
  await rejects(() => cmd.run('/discord @discord-429 guilds', {}, deps), /HTTP 429.*3초 뒤/, '429 메시지와 대기 시간');
  n = seen.length;await rejects(() => cmd.run('/discord @discord-429 guilds', {}, deps), /회로가 잠시 차단/, '429 뒤 차단');ok(seen.length === n, '429 뒤 자동 재시도 없음');
  await rejects(() => cmd.run('/discord @github guilds', {}, deps), /이 PC에 API 연결이 없습니다/, '없는 연결 선택');

  // 5) GitHub: 연결이 없으면 등록 안내 → 프리셋 연결로 경로, 204 dispatch는 성공
  await rejects(() => cmd.run('/actions workflows octo/game', {}, deps), /GitHub 연결이 없습니다.*설정 > 외부 연결/, 'GitHub 연결 없음 안내');
  store.save({ ...githubPreset, maxCallsPerRun: 32 }, key);
  reply = (url) => url.includes('/jobs') ? json({ jobs: [{ id: 5, name: 'build', status: 'completed', conclusion: 'failure', steps: [{ name: 'test', conclusion: 'failure' }, { name: 'setup', conclusion: 'success' }] }] })
    : url.includes('/runs/') ? json({ id: 42, name: 'Deploy', run_number: 7, status: 'completed', conclusion: 'failure', head_branch: 'main' })
    : url.includes('/runs') ? json({ workflow_runs: [{ id: 42, name: 'Deploy', status: 'completed' }] }) : json({ total_count: 1, workflows: [{ id: 161335, name: 'Deploy', path: '.github/workflows/deploy.yml', state: 'active' }] });
  const wf = await cmd.run('/actions workflows octo/game', {}, deps);
  ok(seen.at(-1).url === 'https://api.github.com/repos/octo/game/actions/workflows?per_page=100' && seen.at(-1).auth === 'Bearer ' + key && wf.result.workflows[0].path.endsWith('deploy.yml'), 'workflows 경로');
  await cmd.run('/actions runs octo/game deploy.yml 5', {}, deps);
  ok(seen.at(-1).url === 'https://api.github.com/repos/octo/game/actions/workflows/deploy.yml/runs?per_page=5', 'runs(워크플로) 경로');
  await cmd.run('/actions runs octo/game', {}, deps);
  ok(seen.at(-1).url === 'https://api.github.com/repos/octo/game/actions/runs?per_page=10', 'runs 경로');
  const one = await cmd.run('/actions run octo/game 42', {}, deps);
  ok(seen.at(-2).url.endsWith('/actions/runs/42') && seen.at(-1).url.endsWith('/actions/runs/42/jobs?per_page=50') && one.result.jobs[0].failedSteps.join() === 'test', 'run + jobs');
  n = seen.length;
  await rejects(() => cmd.run('/actions dispatch octo/game deploy.yml main target=pages', { confirm: true }, deps), /쓰기를 허용하지 않습니다/, 'dispatch 쓰기 막힘');ok(seen.length === n, '막힌 dispatch 미전송');
  store.save({ ...githubPreset, maxCallsPerRun: 32, allowWrite: true });
  ok((await cmd.run('/actions dispatch octo/game deploy.yml main target=pages', {}, deps)).confirmRequired && seen.length === n, 'dispatch 계획만');
  reply = () => new Response(null, { status: 204 });
  const dispatched = await cmd.run('/actions dispatch octo/game deploy.yml main target=pages', { confirm: true }, deps);
  ok(seen.at(-1).method === 'POST' && seen.at(-1).url === 'https://api.github.com/repos/octo/game/actions/workflows/deploy.yml/dispatches'
    && JSON.stringify(seen.at(-1).body) === '{"ref":"main","inputs":{"target":"pages"}}' && dispatched.result.dispatched === true, '204 dispatch는 성공');
  reply = () => json({ message: 'Must have admin rights to Repository.' }, 403);
  await rejects(() => cmd.run('/actions workflows octo/private', {}, deps), /HTTP 403: Must have admin/, '403 메시지');
  ok(github.routes.runs({ owner: 'o', repo: 'r' }, null, 3) === '/repos/o/r/actions/runs?per_page=3' && discord.routes.send(ID) === `/api/v10/channels/${ID}/messages`, '경로 함수');

  // 6) /api GET과 @태그(API 연결·MCP 서버)
  reply = () => json({ id: 'me', username: 'ai-connecter' });
  const api = await cmd.run('/api discord /api/v10/users/@me', {}, deps);
  ok(seen.at(-1).method === 'GET' && api.result.body.username === 'ai-connecter', '/api GET');
  const tag = await cmd.run('@discord', {}, deps);
  ok(tag.result.kind === 'api' && tag.result.connection.origin === 'https://discord.com' && tag.result.commands.includes('/discord guilds') && !JSON.stringify(tag).includes(key), '@API 연결 태그');
  const mcpTag = await cmd.run('@unity build', {}, deps);
  ok(mcpTag.result.kind === 'mcp' && mcpTag.result.tools.length === 1 && mcpTag.result.tools[0].name === 'unity_build', '@MCP 서버 태그(검색어)');
  ok(/연결되지 않은/.test((await cmd.resolveTag('idle-server', '', deps)).note), '연결 안 된 서버는 띄우지 않음');
  await rejects(() => cmd.run('@nothing', {}, deps), /등록한 API 연결·MCP 서버가 아닙니다/, '없는 태그');
  const cat = cmd.catalog(deps);
  ok(cat.tags.some((t) => t.tag === '@discord' && t.kind === 'api') && cat.tags.some((t) => t.tag === '@unity' && t.kind === 'mcp') && cat.commands.find((c) => c.name === 'drive mirror').write, '카탈로그');

  // 7) Drive: 목록·정보, 민감 파일 숨김, 링크(정션) 거부, 미러는 복사·갱신만(삭제 없음), 탈출 거부
  const driveRoot = path.join(temp, 'drive-root'), src = path.join(temp, 'build'), outside = path.join(temp, 'outside');
  for (const d of [driveRoot, path.join(src, 'Build'), outside]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(driveRoot, 'readme.txt'), 'hi');fs.writeFileSync(path.join(driveRoot, '.env'), 'X=1');fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  fs.symlinkSync(outside, path.join(driveRoot, 'escape'), 'junction');
  fs.writeFileSync(path.join(src, 'index.html'), '<html>v1</html>');fs.writeFileSync(path.join(src, 'Build', 'game.wasm'), Buffer.alloc(2048, 1));
  fs.writeFileSync(path.join(src, '.env'), 'TOKEN=x');fs.writeFileSync(path.join(src, 'id_rsa'), 'k');
  const breaker = { failures: 0, until: 0 };
  const off = { ...deps, driveSettings: { root: driveRoot, allowWrite: false }, drive: { breaker } };
  const ls = await cmd.run('/drive ls', {}, off);
  ok(ls.result.entries.some((e) => e.name === 'readme.txt' && e.type === 'file' && e.size === 2) && !ls.result.entries.some((e) => e.name === '.env') && ls.result.hidden === 1, '목록·민감 파일 숨김');
  ok(ls.result.entries.find((e) => e.name === 'escape').type === 'link', '정션은 link로만 표시');
  await rejects(() => cmd.run('/drive ls escape', {}, off), /링크/, '정션 따라가기 거부');
  ok((await cmd.run('/drive stat readme.txt', {}, off)).result.type === 'file', 'stat');
  await rejects(() => cmd.run('/drive stat missing.txt', {}, off), /없는 경로/, '없는 경로');
  await rejects(() => cmd.run(`/drive mirror "${src}" games/demo`, { confirm: true }, off), /Drive 쓰기가 꺼져/, 'Drive 쓰기 기본 꺼짐');
  ok(!fs.existsSync(path.join(driveRoot, 'games')), '꺼져 있으면 아무것도 만들지 않음');
  const on = { ...off, driveSettings: { root: driveRoot, allowWrite: true } };
  ok((await cmd.run(`/drive mirror "${src}" games/demo`, {}, on)).confirmRequired && !fs.existsSync(path.join(driveRoot, 'games')), 'mirror 계획만');
  fs.mkdirSync(path.join(driveRoot, 'games', 'demo'), { recursive: true });fs.writeFileSync(path.join(driveRoot, 'games', 'demo', 'keep-me.txt'), 'old build note');
  const m1 = (await cmd.run(`/drive mirror "${src}" games/demo`, { confirm: true }, on)).result;
  const dst = path.join(driveRoot, 'games', 'demo');
  ok(m1.copied === 2 && m1.updated === 0 && m1.deleted === 0 && fs.readFileSync(path.join(dst, 'index.html'), 'utf8') === '<html>v1</html>' && fs.statSync(path.join(dst, 'Build', 'game.wasm')).size === 2048, '복사');
  ok(fs.existsSync(path.join(dst, 'keep-me.txt')) && !fs.existsSync(path.join(dst, '.env')) && !fs.existsSync(path.join(dst, 'id_rsa')) && m1.skipped.filter((s) => s.reason === 'sensitive').length === 2, '대상 파일 유지(삭제 없음)·민감 파일 제외');
  ok(!fs.readdirSync(dst).some((f) => /\.tmp/.test(f)), '임시 파일 없음');
  const m2 = (await cmd.run(`/drive mirror "${src}" games/demo`, { confirm: true }, on)).result;
  ok(m2.copied === 0 && m2.updated === 0 && m2.unchanged === 2, '다시 실행하면 그대로');
  fs.writeFileSync(path.join(src, 'index.html'), '<html>v2 longer</html>');fs.unlinkSync(path.join(src, 'Build', 'game.wasm'));
  const m3 = (await cmd.run(`/drive mirror "${src}" games/demo`, { confirm: true }, on)).result;
  ok(m3.updated === 1 && fs.readFileSync(path.join(dst, 'index.html'), 'utf8').includes('v2') && fs.existsSync(path.join(dst, 'Build', 'game.wasm')), '갱신, 원본에서 지운 파일도 대상에 남김');
  await rejects(() => cmd.run(`/drive mirror "${src}" escape/x`, { confirm: true }, on), /링크/, '정션 너머로 미러 거부');
  ok(fs.readdirSync(outside).join() === 'secret.txt', '정션 대상 폴더는 그대로');
  await rejects(() => cmd.run(`/drive mirror "${path.join(driveRoot, 'games')}" other`, { confirm: true }, on), /겹칩니다/, 'Drive 안을 원본으로 거부');
  await rejects(() => cmd.run(`/drive mirror "${path.join(process.env.APPDATA, 'ai-hub')}" other`, { confirm: true }, on), /Hub 데이터|없거나/, 'Hub 데이터 폴더 거부');
  await rejects(() => cmd.run('/drive mirror relative\\path other', { confirm: true }, on), /절대 경로/, '상대 원본 거부');
  const capped = await drive.mirror(src, 'games/capped', { settings: { root: driveRoot, allowWrite: true }, breaker, totalMs: -1 });
  ok(capped.partial && capped.remaining === capped.files && capped.copied === 0, '시간 상한: 남은 수를 돌려주고 멈춤');
  // PR #69 리뷰: 하네스 개인 상태 폴더를 품거나 그 안인 원본, 경로 중간 정션으로 Hub 데이터 폴더를 가리키는 원본은 거부한다
  const home = path.join(temp, 'home'), codexHome = path.join(home, '.codex'), hubData = path.join(temp, 'hub-data');
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });fs.writeFileSync(path.join(codexHome, 'sessions', 'private.jsonl'), '{}');
  fs.mkdirSync(path.join(hubData, 'logs'), { recursive: true });fs.writeFileSync(path.join(hubData, 'logs', 'run.log'), 'x');
  fs.symlinkSync(hubData, path.join(temp, 'alias'), 'junction');
  const guarded = { settings: { root: driveRoot, allowWrite: true }, breaker, privateDirs: [codexHome], hubDataDir: hubData };
  await rejects(() => drive.mirror(home, 'games/home', guarded), /개인 상태/, '.codex를 품은 원본 거부');
  await rejects(() => drive.mirror(path.join(codexHome, 'sessions'), 'games/sessions', guarded), /개인 상태/, '.codex 안의 원본 거부');
  await rejects(() => drive.mirror(path.join(temp, 'alias', 'logs'), 'games/logs', guarded), /Hub 데이터/, '경로 중간 정션으로 Hub 데이터 우회 거부');
  ok(['home', 'sessions', 'logs'].every((d) => !fs.existsSync(path.join(driveRoot, 'games', d))), '거부하면 아무것도 만들지 않음');

  // 8) Drive 시간 초과 → 회로 차단(차단 중에는 Drive를 건드리지 않는다)
  let calls = 0;
  const slow = { ...fs.promises, stat: (...a) => { calls++; return new Promise((r) => setTimeout(() => r(fs.promises.stat(...a)), 300)); } };
  const tb = { failures: 0, until: 0 };
  for (let i = 0; i < 3; i++) await rejects(() => drive.list('', { settings: { root: driveRoot }, fsp: slow, ioMs: 40, breaker: tb }), /시간 초과/, '시간 초과 ' + i);
  const before = calls;
  await rejects(() => drive.list('', { settings: { root: driveRoot }, fsp: slow, ioMs: 40, breaker: tb }), /멈췄습니다/, '3회 뒤 차단');
  ok(calls === before && tb.until > Date.now(), '차단 중에는 호출하지 않음');
  // PR #69 리뷰: 루트 확인(stat)이 성공해도 목록(readdir)이 멈추면 시간 초과가 쌓여 차단된다. 끝난 명령만 수를 지운다.
  const stalled = { ...fs.promises, readdir: () => new Promise(() => {}) }, sb = { failures: 0, until: 0 };
  for (let i = 0; i < 3; i++) await rejects(() => drive.list('', { settings: { root: driveRoot }, fsp: stalled, ioMs: 40, breaker: sb }), /시간 초과/, 'readdir 멈춤 ' + i);
  ok(sb.failures >= 3 && sb.until > Date.now(), '앞선 stat 성공이 시간 초과 수를 지우지 않음');
  const rb = { failures: 2, until: 0 };
  await drive.list('', { settings: { root: driveRoot }, breaker: rb });
  ok(rb.failures === 0, '끝난 명령은 수를 지움');
  await rejects(() => drive.root({ settings: { root: path.join(temp, 'no-such-drive') }, breaker: { failures: 0, until: 0 } }), /Drive 루트 폴더가 없습니다/, '없는 루트');
  assert.throws(() => drive.save({ root: 'relative\\x' }), /절대 경로/);checks++;

  // 9) 기록: 실행한 명령마다 한 줄, 토큰 모양·사용자 경로는 가림(이력 파일·작업 표)
  const fakeToken = 'ghp_' + 'Z9'.repeat(18), fakeHex = crypto.randomBytes(20).toString('hex');
  await cmd.run(`@discord ${fakeToken} ${fakeHex} C:\\Users\\someone\\x`, {}, deps);
  await rejects(() => cmd.run(`/api discord /api/v10/users/${fakeToken}`, {}, deps), /credential|API/, '경로의 키 모양은 보내지 않음');
  const log = fs.readFileSync(logFile, 'utf8'), rows = log.trim().split('\n').map((l) => JSON.parse(l));
  ok(!log.includes(fakeToken) && !log.includes(fakeHex) && !log.includes('someone') && log.includes('[redacted]'), '이력 가림');
  ok(rows.some((r) => r.via === 'ui' && r.command === 'discord guilds' && r.ok) && rows.some((r) => r.command === 'api' && !r.ok && r.error) && rows.every((r) => r.id && r.at && typeof r.ms === 'number'), '성공·실패 모두 기록');
  ok(!rows.some((r) => r.command === 'discord send' && r.ok === undefined) && rows.filter((r) => r.command === 'discord send').length === 1, '계획(confirm 없음)은 기록하지 않음');
  const inbox = path.join(process.env.AGENT_WORK_DIR, 'inbox.d'), events = fs.readdirSync(inbox).map((f) => fs.readFileSync(path.join(inbox, f), 'utf8'));
  ok(events.length >= rows.length && events.every((e) => !e.includes(fakeToken) && !e.includes(fakeHex)) && events.some((e) => /"k":"hub-command-/.test(e)), '작업 표 행(가림)');
  const act = require('../src/core/activity').collect({ kind: 'command' }, { commandLog: logFile, pipeline: { history: () => [] }, stats: { history: () => [] }, offload: { list: () => [] }, aiderDir: null });
  ok(act.items.length === rows.length && act.items.every((i) => i.kind === 'command') && act.summary.command.count === rows.length, '이력 탭 출처');

  // 10) MCP: 도구·프롬프트(바이트 불변)·리소스 템플릿. 이 프로세스의 기본 저장소에는 연결이 없다.
  const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
  const server = require('../src/mcp/hub-server').createHubServer(), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'cmd-test', version: '0' });
  await client.connect(b);
  const listed = (await client.listTools()).tools, hc = listed.find((t) => t.name === 'hub_command');
  ok(hc && hc.description.length < 600 && Object.keys(hc.inputSchema.properties).sort().join() === 'command,confirm', 'hub_command 등록·짧은 설명·키 입력 없음');
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
  ok(['discord', 'actions', 'drive'].every((p) => prompts.includes(p)), '프롬프트 3개');
  const textOf = async (name, args) => (await client.getPrompt({ name, arguments: args })).messages[0].content.text;
  // 프롬프트 글이 바뀌면 클라이언트의 캐시 접두부도 바뀐다 — 고칠 때만 의도적으로 갱신한다.
  const PINNED = { discord: '37c5e344e9aa2ccb', actions: 'f205c5e6b8535557', drive: '492471720762cf76' };
  for (const name of ['discord', 'actions', 'drive']) {
    const t1 = await textOf(name, {}), t2 = await textOf(name, {}), withReq = await textOf(name, { request: '최근 실행 보여 줘' });
    const hash = crypto.createHash('sha256').update(t1).digest('hex').slice(0, 16);
    ok(t1 === t2 && withReq.startsWith(t1) && withReq.endsWith('요청: 최근 실행 보여 줘') && t1.includes('hub_command') && t1.includes('confirm:true') && !/\d{4}-\d{2}-\d{2}/.test(t1), name + ' 프롬프트 고정 접두부');
    ok(PINNED[name] === hash, `${name} 프롬프트 바이트가 바뀌었습니다(의도했다면 PINNED 갱신): ${hash}`);
  }
  const templates = (await client.listResourceTemplates()).resourceTemplates;
  ok(templates.some((t) => t.uriTemplate === 'hub-connection://{id}'), '연결 리소스 템플릿');
  const res = await client.callTool({ name: 'hub_command', arguments: { command: '/actions runs octo/game' } });
  ok(res.isError && /GitHub 연결이 없습니다/.test(res.content[0].text), 'MCP: GitHub 연결 없음 안내');
  const planOnly = await client.callTool({ name: 'hub_command', arguments: { command: '/drive ls ../x' } });
  ok(planOnly.isError && /상대 경로/.test(planOnly.content[0].text), 'MCP: 검증 오류');
  await client.close();

  // 11) 경로 표: 이 의도들이 Hub 도구로 간다(Discord가 comfy_workflow_run으로 가지 않는다)
  const routes = require('../src/core/toolroute/route-table'), rdeps = { dataDir: path.join(temp, 'routes') };
  for (const [intent, id, target] of [['send a message to a Discord channel', 'discord-message', 'mcp:hub_command'], ['list GitHub Actions runs', 'github-actions', 'mcp:hub_command'],
    ['copy a game build to Google Drive', 'drive-files', 'mcp:hub_command'], ['call a registered API', 'api-call', 'mcp:api_call'], ['read a URL reference document', 'url-reference', 'mcp:url_reference_read']]) {
    const r = await routes.resolve(intent, {}, rdeps);
    ok(r.best && r.best.id === id && r.best.target === target && /confirm|untrusted|allowWrite/.test(r.best.note || ''), `${intent} → ${r.best && r.best.id}`);
  }
  ok((await routes.resolve('send a message to a Discord channel', {}, rdeps)).best.target !== 'mcp:comfy_workflow_run', 'Discord 의도가 이미지 생성으로 가지 않음');

  clearInterval(keepAlive);
  console.log(`hub-commands 검사 ${checks}개 통과`);
  process.exit(0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

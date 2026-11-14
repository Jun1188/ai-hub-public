// 외부 CLI 작업자 프로세스: offload의 'codex' 작업자(읽기 전용 `codex exec`), 'agy' 작업자(Antigravity CLI
// 헤드리스, 마스킹한 사본만 든 임시 폴더)와 프로세스 트리 종료.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { StringDecoder } = require('node:string_decoder');
const consoleText = require('./console-text');
const { scrub } = require('./secret-scrub');
const safety = require('./prompt-safety');

const MAX_OUTPUT_BYTES = 1024 * 1024;

function findExe(name, extra = []) {
  const candidates = [process.env[`AIHUB_${name.toUpperCase()}_BIN`], ...extra,
    path.join(os.homedir(), '.local', 'bin', `${name}.exe`),
    ...String(process.env.PATH || '').split(path.delimiter).map(p => path.join(p, `${name}.exe`))];
  return candidates.filter(Boolean).find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || '';
}
function codexBin() {
  return findExe('codex', [path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')]);
}
// Track the ChildProcess object, not its recyclable PID. Repeated output/abort events can overlap.
const termination = new WeakMap();
function killTree(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode != null) return;
  // POSIX has no helper process. A later SIGTERM remains available to a worker handling signals.
  if (process.platform !== 'win32') { child.kill('SIGTERM'); return; }
  const active = termination.get(child);
  if (active) { active.requestedAgain = true; return; }
  const attempt = { requestedAgain: false };
  termination.set(child, attempt);
  try {
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => {
      if (!error) return;
      termination.delete(child);
      if (attempt.requestedAgain) {
        // Another caller requested a stop while this command was running. Retry only on failure.
        try { killTree(child); } catch { /* A later caller can retry a failed spawn. */ }
      }
    });
  } catch (error) {
    termination.delete(child);
    throw error;
  }
}

// CLI 버전마다 옵션이 다르다. 한 번만 물어보고 실행 파일별로 기억한다.
const schemaSupport = new Map();
function supportsOutputSchema(bin) {
  if (!schemaSupport.has(bin)) {
    schemaSupport.set(bin, new Promise(resolve => execFile(bin, ['exec', '--help'],
      { timeout: 15000, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, ...consoleText.RAW_OUTPUT },
      (_error, stdout, stderr) => resolve(/--output-schema/.test(consoleText.decode(stdout) + consoleText.decode(stderr))))));
  }
  return schemaSupport.get(bin);
}

/**
 * `codex exec`를 읽기 전용으로 한 번 돌려 마지막 메시지만 돌려준다.
 * --ignore-user-config를 넘기지 않는다: 사용자의 `[windows] sandbox` 설정까지 버려져
 * 읽기 전용 샌드박스가 Windows에서 실패한다(실측).
 */
// 사용 한도 소진과 일시적 제한을 나눈다(Codex 리뷰 ①, 2026-10-25) — 판정자 순서는 소진일 때만 다음 작업자로 넘어간다.
// 소진 문구는 이 PC ~/.codex/sessions에 남은 실제 오류("You’ve hit your usage limit. Upgrade to Pro …")와 codex.exe 0.159.0 문자열이다.
// 일시적 제한은 Codex가 스스로 재시도한 뒤의 "exceeded retry limit, last status: 429"뿐이다. 맨 "rate limit"·"429"는 진행 로그에
// 인용된 글일 수 있어 보지 않는다(그때는 예전처럼 `Codex exit <n>`).
const CODEX_EXHAUSTED = /^(?:you[’']ve hit your usage limit|(?:your |this |the )?workspace is out of credits)\b/i;
const CODEX_THROTTLED = /^(?:stream error:\s*)?exceeded retry limit, last status: 429\b/i;

async function runCodex({ prompt, cwd, schema, timeoutSec = 600, signal, onSpawn, bin = codexBin() }) {
  if (!bin) throw new Error('Codex CLI not found');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-'));
  const answerFile = path.join(dir, 'answer.txt');
  const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--color', 'never', '--sandbox', 'read-only',
    '-C', cwd, '--output-last-message', answerFile];
  let schemaApplied = false;
  if (schema && await supportsOutputSchema(bin)) {
    const schemaFile = path.join(dir, 'schema.json');
    fs.writeFileSync(schemaFile, JSON.stringify(schema), 'utf8');
    args.push('--output-schema', schemaFile);
    schemaApplied = true;
  }
  args.push('-');
  return new Promise((resolve, reject) => {
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    if (signal?.aborted) { cleanup(); return reject(new Error('Cancelled')); }
    const child = spawn(bin, args, { cwd, windowsHide: true, shell: false, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    onSpawn?.(child.pid);
    let size = 0, failure = '';
    const abort = () => { failure = 'Cancelled'; killTree(child); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { failure = 'Codex timeout'; killTree(child); }, timeoutSec * 1000);
    // 출력은 버린다 — 진행 로그에 작업 지시·파일 내용이 섞여 결과로 새지 않게 마지막 메시지 파일만 읽는다.
    // Only the CLI's last ERROR diagnostic can classify a failure. Stdout and quoted progress may be source text.
    const decoder = new StringDecoder('utf8');
    let stderrTail = '';
    const count = chunk => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) { failure = 'Codex output exceeded 1 MiB'; killTree(child); }
    };
    child.stdout.on('data', count);
    child.stderr.on('data', chunk => { count(chunk); stderrTail = (stderrTail + decoder.write(chunk)).slice(-4096); });
    child.on('error', e => { failure = e.message; });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      stderrTail = (stderrTail + decoder.end()).slice(-4096);
      // 시간 초과·취소·출력 초과가 아닌 비정상 종료에서 한도 문구가 보이면 한도다(그때는 마지막 메시지가 없다).
      const lastError = [...stderrTail.matchAll(/^[ \t]*ERROR:[ \t]*([^\r\n]+)/gim)].at(-1)?.[1] || '';
      const limited = failure || code === 0 ? null
        : CODEX_EXHAUSTED.test(lastError) ? 'codex_quota_exhausted' : CODEX_THROTTLED.test(lastError) ? 'codex_throttled' : null;
      let output = '';
      try { output = fs.readFileSync(answerFile, 'utf8'); } catch { failure = failure || 'Codex produced no final message'; }
      cleanup();
      if (!failure && !output.trim()) failure = 'Codex returned an empty final message';
      if (limited) reject(Object.assign(new Error(limited === 'codex_throttled' ? 'Codex rate limited' : 'Codex usage limit'), { offloadReason: limited }));
      else if (failure || code !== 0) reject(new Error(failure || `Codex exit ${code}`));
      else resolve({ output, schemaApplied });
    });
  });
}

// ── agy(Antigravity CLI) 헤드리스 작업자. 설계: 공유 저장소 reports/hub-expansion-review-20261016.md 3.3 ──
// 작업 종류별 모델 등급(2026-10-18 사용자 결정): fast는 추출·요약·형식 변환·짧은 분류,
// reasoning은 판정·원인 추적 같은 다단계 판단, deep은 설계 비교·결정이다. agy는 Gemini 4만 쓴다(같은 날 나중 결정 —
// Flash는 빈 답·도구 거부·오판이 실측됐다). 그래서 fast와 reasoning은 지금 같은 모델·노력 단계이고 deep만 노력 단계가 높다.
// 기본 등급의 slug는 agy-model-tiers.json에서 정한다. 명시 model도 계정 목록에 있어야 하며 노력 단계는 ID 접미부를 따른다.
const AGY_TIERS = ['fast', 'reasoning', 'deep'];
// offload_run의 계약(작고 검증 가능한 추출·분류·변환)이 단순 작업이고, 할당량을 더 쓰는 추론은 명시할 때만 쓴다.
const AGY_DEFAULT_TIER = 'fast';
const AGY_MODEL_ID = /^gemini-4-[a-z0-9-]+-(low|medium|high|xhigh|max)$/;
// 읽기 말고 다른 허용 규칙(셸·쓰기·MCP·URL 실행)이 있으면 agy가 셸이나 MCP 서버(Hub가 등록되면 Hub 자신)를 부를 수 있다.
const SAFE_ALLOW_RULE = /^(?:read_file|read_url)\(/;
// 문구 출처는 agy 1.4.0(2026-10-16): 로그인은 실제 실행 로그, 할당량·모델 거부·soft-deny는 변경 기록과 agy.exe 문자열.
const AGY_AUTH = /not logged into Antigravity/i;
// shortcut: 할당량·모델 거부는 실제 실패 출력을 보지 못했다(일부러 소진시키지 않음). 실제로 나면 그 문구로 맞출 것.
// 일시적 429·rate limit은 agy가 스스로 재시도하므로 소진으로 보지 않는다.
// A bare "quota" or RESOURCE_EXHAUSTED can also report throttling or a service fault.
const AGY_QUOTA_EXHAUSTED = /\b(?:individual quota (?:reached|exhausted)|credits balance is too low|out of credits)\b/i;
const AGY_RATE_LIMIT = /\b(?:per[- ](?:minute|second)|rate[- ]limit(?:ed)?|too many requests)\b/i;
const AGY_MODEL_REFUSED = /\b(?:invalid|unknown) model\b|selected model is not supported/i;
// 헤드리스는 승인이 필요한 도구를 soft-deny하고 stderr에 "...headless mode cannot prompt for, so ... auto-denied"를 쓴다.
const AGY_SOFT_DENY = /headless mode cannot prompt for/i;
// 1.4.7은 거부를 stdout JSON의 denied_actions([{action:"mcp",display_name:"CallMcpTool"}])로도 준다(실측 2026-10-25) — 안내 문구가 바뀌어도 잡힌다.
const deniedInJson = (stdout) => { try { const d = JSON.parse(stdout.trim()).denied_actions; return Array.isArray(d) && d.length > 0; } catch { return false; } };
// 모델·에이전트 API 실패는 종료 코드 3과 stderr의 `AGY_ERROR: {...}` 한 줄이다(변경 기록 1.2.6·1.2.10). 1.4.7 실측(2026-10-25, 모델 요청을
// 막아 일으킴): {"short_error":"...","status":"UNKNOWN","error_code":2,"code_kind":"grpc","retryable":false,"error_id":"..."}.
// 사유 코드에는 정해진 상태 이름만 싣는다 — short_error에는 요청 주소·입력이 섞일 수 있다.
const API_STATUSES = ['CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];
function agyApiStatus(stderr) {
  const line = stderr.split(/\r?\n/).map((l) => l.trim()).reverse().find((l) => l.startsWith('AGY_ERROR:'));
  if (!line) return null;
  try {
    const v = JSON.parse(line.slice('AGY_ERROR:'.length));
    return { status: API_STATUSES.includes(v.status) ? v.status : 'ERROR',
      retryable: v.retryable === true, shortError: String(v.short_error || '') };
  } catch { return { status: 'ERROR' }; }
}
const USER_MASK = 'C:\\Users\\<user>'; // secret-scrub.scrub이 남기는 자리 표시
// 명령줄 한도(32,767자)에서 실행 파일·다른 인자와 Node의 따옴표 처리 몫을 뺀 여유. 넘는 지시는 TASK_FILE로 간다.
const PROMPT_ARG_LIMIT = 24000;
const TASK_FILE = '0-task.md'; // 입력 파일은 1-부터라 겹치지 않는다

function agyBin() {
  return findExe('agy', [path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe')]);
}
const agySettingsFile = () => path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
// IDE와 같이 쓰는 공유 설정. agy 1.4.0은 여기 권한도 적용하고, Remote Control에서 고른 "Always allow"는 여기에만 저장된다.
const agySharedConfigFile = () => path.join(os.homedir(), '.gemini', 'config', 'config.json');
const agyWorkRoot = () => path.join(require('./paths').hubStorageDir(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')), 'agy-work');
// offload가 읽는 정해진 사유 코드로만 실패한다 — agy 출력에는 입력이 섞여 있을 수 있다.
const agyFail = (reason, isDeclined = false) => Object.assign(new Error(reason), isDeclined ? { declined: reason } : { offloadReason: reason });

function agyQuery(bin, args, signal) {
  return new Promise(resolve => execFile(bin, args, { timeout: 30000, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, signal, ...consoleText.RAW_OUTPUT },
    (_error, stdout, stderr) => resolve(consoleText.decode(stdout) + '\n' + consoleText.decode(stderr))));
}

/** MCP 탭·hub_status용. 로그인·모델은 `agy models`가 갱신마다 네트워크를 타므로 실행 때 사전 점검에 맡긴다. */
async function agyStatus({ bin = agyBin(), binArgs = [], list = () => require('./offload').list() } = {}) {
  const version = bin ? (await agyQuery(bin, [...binArgs, '--version'])).trim().split(/\r?\n/)[0] : '';
  const jobs = list().filter(j => j.worker === 'agy'); // offload가 이 모듈을 부르므로 늦게 require한다
  const count = state => jobs.filter(j => j.state === state).length;
  const last = jobs[jobs.length - 1];
  return { installed: Boolean(bin), version, succeeded: count('succeeded'), declined: count('declined'), failed: count('failed'),
    last: last ? { state: last.state, model: last.model || '', reason: last.reason || '', at: last.finishedAt || last.createdAt } : null };
}

/** 권한 규칙을 못 읽으면 안전하다고 보지 않는다(규칙 6). 파일이 없으면 규칙이 없는 것이다. */
async function agyRulesSafe(file, allowOf) {
  try {
    const allow = allowOf(JSON.parse((await fs.promises.readFile(file, 'utf8')).replace(/^\uFEFF/, ''))) ?? [];
    return Array.isArray(allow) && allow.every(rule => typeof rule === 'string' && SAFE_ALLOW_RULE.test(rule.trim()));
  } catch (e) { return e.code === 'ENOENT'; }
}

// `agy models`는 줄마다 "slug<TAB>표시 이름"이다(slug에 노력 단계 -low/-medium/-high가 붙는다).
const listedModels = listing => listing.split(/\r?\n/).map(line => line.trim().split(/\s+/)[0]).filter(Boolean);

function agySpawn(bin, args, cwd, timeoutSec, signal, onSpawn) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve({ failure: 'Cancelled' });
    const child = spawn(bin, args, { cwd, windowsHide: true, shell: false, env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    onSpawn(child.pid);
    const out = [], err = [];
    let size = 0, failure = '';
    const stop = why => { failure = failure || why; killTree(child); };
    const abort = () => stop('Cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    // agy 자신의 --print-timeout이 먼저 끝내도록 Hub 상한은 30초 늦다.
    const timer = setTimeout(() => stop('timeout'), timeoutSec * 1000 + 30000);
    const keep = list => chunk => { size += chunk.length; if (size > MAX_OUTPUT_BYTES) stop('output_exceeded'); else list.push(chunk); };
    child.stdout.on('data', keep(out)); child.stderr.on('data', keep(err));
    child.on('error', () => { failure = failure || 'agy_not_installed'; });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      resolve({ code, failure, stdout: consoleText.decode(Buffer.concat(out)), stderr: consoleText.decode(Buffer.concat(err)) });
    });
  });
}

function agyResult(code, stdout, stderr) {
  let out = null;
  try { out = JSON.parse(stdout.trim()); } catch { /* 아래에서 사유 코드로 바꾼다 */ }
  if (out && out.status === 'SUCCESS') {
    return { structured: out.structured_output ?? null, response: typeof out.response === 'string' ? out.response : '', usage: out.usage || null };
  }
  const { status: api, retryable, shortError } = agyApiStatus(stderr) || {};
  const said = `${out?.error || ''}\n${stderr}`;
  if (api === 'UNAUTHENTICATED') throw agyFail('agy_auth', true);
  // RESOURCE_EXHAUSTED는 소진과 일시적 429에 함께 쓰인다. agy가 다시 해 볼 만하다고 하면 일시적 제한이다 — 판정자 순서를 넘기지 않는다.
  if (api === 'RESOURCE_EXHAUSTED') {
    const detail = `${out?.error || ''}\n${shortError}`;
    if (retryable || AGY_RATE_LIMIT.test(detail)) throw agyFail('agy_throttled');
    if (AGY_QUOTA_EXHAUSTED.test(detail)) throw agyFail('agy_quota_exhausted', true);
    throw agyFail('agy_api_resource_exhausted');
  }
  if (api === 'DEADLINE_EXCEEDED') throw agyFail('timeout');
  if (AGY_AUTH.test(said)) throw agyFail('agy_auth', true);
  if (!api && AGY_RATE_LIMIT.test(said)) throw agyFail('agy_throttled');
  if (!api && AGY_QUOTA_EXHAUSTED.test(said)) throw agyFail('agy_quota_exhausted', true);
  if (AGY_MODEL_REFUSED.test(said)) throw agyFail('agy_model_unavailable', true);
  if (api) throw agyFail(api === 'ERROR' ? 'agy_api_error' : `agy_api_${api.toLowerCase()}`);
  // 2는 인자 오류다(1.3.4, 실측 1.4.7) — 이 agy가 Hub가 넘긴 플래그를 받지 않는다. 다시 돌려도 같으니 거절한다.
  if (code === 2) throw agyFail('agy_bad_arguments', true);
  if (!out || typeof out !== 'object') throw agyFail(code ? `agy_exit_${code}` : 'agy_bad_output');
  // RUNNING은 --print-timeout 안에 끝에 닿지 못한 실행이다. 할당량 소모 여부를 모르니 다시 돌리지 않는다.
  if (out.status === 'RUNNING' || (out.status === 'ERROR' && /timed? ?out/i.test(said))) throw agyFail('timeout');
  throw agyFail(out.status === 'ERROR' ? 'agy_error' : 'agy_incomplete');
}

/**
 * agy 헤드리스를 한 번 돌린다. 모델 호출 전에 ① 입력 마스킹(가리지 못한 키·사용자 경로가 남으면 agy를 띄우지 않는다)
 * ② 사전 점검(버전·권한 규칙·로그인·등급의 모델)을 하고, 마스킹한 사본만 든 새 폴더를 작업 폴더로 실행한 뒤 지운다.
 * --dangerously-skip-permissions는 쓰지 않는다: 폴더 밖 쓰기·셸·MCP는 agy 기본 정책(Ask)에 맡긴다.
 * 등급의 모델이 없으면 다른 등급으로 내리거나 올리지 않고 거절한다 — 호출자가 직접 하거나 다른 등급을 명시한다.
 * binArgs: 시험에서 node 스크립트를 가짜 agy로 띄우는 자리(Windows는 shell:false로 .cmd를 띄울 수 없다).
 */
async function runAgy({ prompt, inputs = [], schema, timeoutSec = 600, signal, onSpawn, bin = agyBin(), binArgs = [], model: requestedModel, tier = AGY_DEFAULT_TIER,
  tiers = require('./agy-model-tiers.json').tiers, settingsFile = agySettingsFile(), sharedConfigFile = agySharedConfigFile(), workRoot = agyWorkRoot() }) {
  const files = inputs.map((input, i) => ({ name: `${i + 1}-${path.basename(String(input.name || 'input.txt')).replace(/[^\w.-]/g, '_').slice(-80)}`,
    text: scrub(input.text) }));
  // 입력은 agy가 읽기 도구로 읽어야 하므로 "도구를 부르지 마라"고 쓰지 않는다. 그 모순이 2026-10-18 Flash가 다른 도구를
  // 시도해 soft-deny된 원인 후보다(미확인).
  const request = [scrub(prompt), files.length ? 'Read only these input files in the current folder, and only with your file-reading tool. '
    + 'Do not read other paths, list or search folders, change files, run commands or call any other tool. '
    + 'If the answer depends on anything outside these files, say it is unclear instead of guessing.\n'
    + files.map(f => '- ' + f.name).join('\n') : ''].filter(Boolean).join('\n\n');
  // scrub이 남긴 자리 표시는 사용자 이름을 드러내지 않는다. 가리지 못한 경로·키만 거절한다.
  try { for (const text of [request, ...files.map(f => f.text)]) safety.assertExternal(text.split(USER_MASK).join('')); }
  catch { throw agyFail('blocked_secret_like_text', true); }

  if (!bin) throw agyFail('agy_not_installed', true);
  const query = async args => { const text = await agyQuery(bin, [...binArgs, ...args], signal); signal?.throwIfAborted(); return text; };
  const help = await query(['--help']);
  if (!/--output-format/.test(help) || !/--json-schema/.test(help)) throw agyFail('agy_outdated', true);
  // 공유 설정은 protobuf JSON(jetbox_state_pb.UserSettings)이고 agy는 camelCase 이름으로 쓴다.
  if (!await agyRulesSafe(settingsFile, s => s.permissions?.allow)
    || !await agyRulesSafe(sharedConfigFile, s => s.userSettings?.globalPermissionGrants?.allow)) throw agyFail('agy_unsafe_permissions', true);
  const listing = await query(['models']);
  if (AGY_AUTH.test(listing)) throw agyFail('agy_auth', true);
  const explicit = requestedModel != null;
  const match = typeof requestedModel === 'string' && requestedModel.match(AGY_MODEL_ID);
  const { model, effort } = explicit ? { model: match ? requestedModel : null, effort: match && match[1] }
    : (AGY_TIERS.includes(tier) && tiers[tier]) || {};
  if (!model || !effort || !listedModels(listing).includes(model)) throw agyFail('agy_model_unavailable', true);

  fs.mkdirSync(workRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(workRoot, 'job-'));
  try {
    const cwd = path.join(dir, 'in');
    fs.mkdirSync(cwd);
    for (const f of files) fs.writeFileSync(path.join(cwd, f.name), f.text, 'utf8');
    const args = [...binArgs, '--output-format', 'json', '--model', model, '--effort', effort,
      '--print-timeout', `${Math.max(1, Math.ceil(timeoutSec / 60))}m`, '--sandbox'];
    if (schema) {
      const schemaFile = path.join(dir, 'schema.json');
      fs.writeFileSync(schemaFile, JSON.stringify(schema), 'utf8');
      args.push('--json-schema', schemaFile);
    }
    // 지시는 -p 인자로 준다: 헤드리스 문서상 stdin은 --input-format stream-json일 때만 읽는다.
    // -p 인자는 명령줄이라 위험 명령 예시가 있으면 Defender가 agy를 막는다(LOG 13) — 그 줄만 무력화한다.
    const instructions = require('./supply/payload-defang').defang(request).text;
    // Windows 명령줄은 32,767자까지다. 넘으면 spawn이 ENAMETOOLONG을 던져 `worker_failed`로만 남았다(버스 본문은 64 KiB까지).
    // 긴 지시는 작업 폴더의 0-task.md로 옮긴다 — 작업 폴더 안 읽기는 헤드리스에서도 허용된다(1.4.7 실측 2026-10-25).
    if (instructions.length > PROMPT_ARG_LIMIT) {
      fs.writeFileSync(path.join(cwd, TASK_FILE), instructions, 'utf8');
      args.push('-p', `Your instructions are in ${TASK_FILE} in the current folder. Read it with your file-reading tool, then follow it exactly.`);
    } else args.push('-p', instructions);
    const run = await agySpawn(bin, args, cwd, timeoutSec, signal, pid => onSpawn?.(pid, model));
    // 실패로 끝난 실행의 soft-deny도 오류에 싣는다. 2026-10-18 거부된 실행이 412·599초(상한 600초)까지 헛돌았다 —
    // 조금만 더 갔으면 시간 초과로 끝나 거부 사실이 사라졌다.
    const toolDenied = AGY_SOFT_DENY.test(run.stderr || '') || deniedInJson(run.stdout || '');
    try {
      if (run.failure) throw run.failure === 'Cancelled' ? new Error('Cancelled') : agyFail(run.failure);
      const result = agyResult(run.code, run.stdout, run.stderr);
      // 거부당해 아무것도 내지 못한 실행은 다시 돌려도 같다(1.4.7: 종료 0, 빈 response). 결과로 넘기면 offload가 한 번 더 돌리고
      // 형식 오류로, 버스는 "null"을 답으로 남겼다. 사람이 권한을 정할 일이라 거절한다 — 판정자 순서는 다음으로 넘어간다.
      if (toolDenied && result.structured == null && !result.response.trim()) throw agyFail('agy_tool_denied', true);
      return { ...result, toolDenied, model, tier: explicit ? null : tier };
    } catch (e) { throw Object.assign(e, toolDenied ? { toolDenied } : {}); }
  } finally {
    // 지우지 못한 사본은 마스킹된 기기 전용 파일이다. 그 때문에 이미 받은 결과를 버리지 않는다.
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 위 참고 */ }
  }
}

// "이 작업자는 지금 쓸 수 없다"는 거절: 순서가 있는 작업자 선택(RSI 판정자, 원본 갱신 검토)이 다음 작업자로 넘어가는 사유.
// 소진·헤드리스 거부(agy_tool_denied, 다시 돌려도 같음)는 넘어가고, 일시적 제한(codex_throttled·agy_throttled, http_429)은 넘어가지 않는다.
// codex_rate_limited는 1.32.22~1.32.25가 소진에 쓰던 이름이라 남긴다.
const WORKER_UNAVAILABLE = /^(agy_(quota_exhausted|auth|not_installed|outdated|unsafe_permissions|model_unavailable|bad_arguments|api_unavailable|api_permission_denied|tool_denied)|codex_(quota_exhausted|rate_limited|cli_not_found)|local_not_viable|model_not_admitted|backend_unreachable)\b/;

module.exports = { codexBin, runCodex, agyBin, agyStatus, runAgy, killTree, AGY_TIERS, AGY_DEFAULT_TIER, AGY_MODEL_ID, WORKER_UNAVAILABLE };

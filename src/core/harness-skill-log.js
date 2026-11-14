// 하네스 로그에서 스킬 사용만 모은다. 스킬은 Hub를 거치지 않고 써도 된다 — Claude Code는 Skill 도구·SKILL.md 읽기로,
// Codex는 SKILL.md를 읽는 명령으로 쓰고, 이 수집기가 그 기록을 skill-usage.json·knowledge-metrics.json에 하네스 이름과 함께 더한다.
// 원천: Claude Code 트랜스크립트(~/.claude/projects/**/*.jsonl), Codex 세션(~/.codex/sessions/**/*.jsonl). 읽기 전용이다.
// 남기는 것은 스킬 id·하네스·시각뿐이다. 대화·명령·파일 경로는 저장하지 않고, 이어 읽을 위치는 파일 경로의 해시 아래 둔다.
// 한 세션(파일)에서 같은 스킬은 한 번만 센다 — 같은 SKILL.md를 여러 번 읽거나 한 명령이 두 이벤트로 남아도 사용은 1이다.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { writeAtomic, readJson } = require('./atomic-file');

const CHUNK = 4 * 1024 * 1024, MAX_LINE = 64 * 1024 * 1024, MAX_DEPTH = 6;
const SKILL_PATH = /([A-Za-z0-9][A-Za-z0-9_.-]{0,79})[\\/]+SKILL\.md\b/gi;
// 읽기 명령만 사용으로 센다. 존재 확인(Test-Path)·복사·쓰기·목록(Get-ChildItem -Filter SKILL.md)은 사용이 아니다.
const READ_VERB = /(?:^|[^\w-])(?:Get-Content|gc|cat|type|head|tail|less|more|sed|awk|Select-String|rg|grep|findstr|Read-Utf8Text|readFile(?:Sync)?|read_text)(?![\w-])/i;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const MARKERS = ['SKILL.md', '"Skill"'];

const home = (deps) => deps.home || os.homedir();
const ROOTS = {
  'claude-code': (deps) => path.join(home(deps), '.claude', 'projects'),
  codex: (deps) => path.join(home(deps), '.codex', 'sessions'),
};
const stateFile = (deps = {}) => path.join(deps.dataDir || require('./paths').hubDataDir(), 'harness-skill-log.json');
const blank = () => ({ schemaVersion: 1, files: {}, totals: {}, lastRun: null });
const fileKey = (harness, file) => crypto.createHash('sha256').update(harness + '\u0000' + path.resolve(file).toLowerCase()).digest('hex').slice(0, 24);

/** 명령 문자열에서 SKILL.md를 읽는 문장의 스킬 이름(문장 = 줄·;·|·&& 사이). */
function readsInCommand(text) {
  const out = new Set();
  for (const s of String(text || '').split(/\r?\n|;|&&|\|/)) {
    for (const m of s.matchAll(SKILL_PATH)) if (READ_VERB.test(s.slice(0, m.index))) out.add(m[1]);
  }
  return [...out];
}

const skillDir = (file) => (/([^\\/]+)[\\/]+SKILL\.md$/i.exec(String(file || '')) || [])[1];

/** Claude Code 한 줄(assistant 메시지)의 도구 호출: Skill 도구, SKILL.md Read, SKILL.md를 읽는 Bash·PowerShell. */
function claudeUses(e) {
  if (e.type !== 'assistant') return [];
  const out = [];
  for (const c of (e.message && e.message.content) || []) {
    if (!c || c.type !== 'tool_use') continue;
    const i = c.input || {};
    if (c.name === 'Skill' && typeof i.skill === 'string') out.push(i.skill.replace(/^\//, ''));
    else if (c.name === 'Read' && skillDir(i.file_path)) out.push(skillDir(i.file_path));
    else if ((c.name === 'Bash' || c.name === 'PowerShell') && typeof i.command === 'string') out.push(...readsInCommand(i.command));
  }
  return out;
}

/** Codex 한 줄: exec(코드)·shell 함수 호출·로컬 셸 호출의 명령, 완료된 명령의 읽기 분석(parsed_cmd). */
function codexUses(e) {
  const p = e.payload || {};
  if (p.type === 'custom_tool_call') return readsInCommand(p.input);
  if (p.type === 'function_call') return readsInCommand(p.arguments);
  if (p.type === 'local_shell_call') return readsInCommand([].concat((p.action && p.action.command) || []).join(' '));
  if (p.type === 'item_completed' && p.item && p.item.type === 'CommandExecution') {
    const parsed = (p.item.parsed_cmd || []).filter((c) => c && c.type === 'read').map((c) => skillDir(c.path || c.name)).filter(Boolean);
    return [...parsed, ...readsInCommand(p.item.command)];
  }
  return [];
}
const EXTRACT = { 'claude-code': claudeUses, codex: codexUses };

async function jsonlFiles(root, depth = 0, out = []) {
  let entries;
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return out; throw e; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const p = path.join(root, e.name);
    if (e.isDirectory() && depth < MAX_DEPTH) await jsonlFiles(p, depth + 1, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/** 파일의 새 바이트(entry.off부터)를 줄 단위로 읽는다. 표시어가 든 줄만 JSON으로 푼다. 끝의 미완성 줄은 다음 실행에 읽는다. */
async function readNew(file, entry, onEvent) {
  const st = await fs.promises.stat(file);
  if (st.size < entry.off) entry.off = 0; // 잘리거나 새로 쓴 파일 — 세션 안 중복 제거가 다시 세지 않게 한다
  if (st.size === entry.off) return 0;
  const fh = await fs.promises.open(file, 'r');
  let pos = entry.off, carry = Buffer.alloc(0), skipping = false, read = 0;
  try {
    while (pos < st.size) {
      const buf = Buffer.alloc(Math.min(CHUNK, st.size - pos));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      pos += bytesRead; read += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const next = MARKERS.map((m) => data.indexOf(m));
      let start = 0, nl;
      while ((nl = data.indexOf(10, start)) !== -1) {
        // 표시어 위치를 앞으로만 옮겨 가며 찾는다 — 줄마다 처음부터 찾지 않는다.
        for (let i = 0; i < next.length; i++) if (next[i] !== -1 && next[i] < start) next[i] = data.indexOf(MARKERS[i], start);
        if (!skipping && next.some((x) => x !== -1 && x < nl)) {
          let e = null;
          try { e = JSON.parse(data.toString('utf8', start, nl)); } catch { /* 깨진 줄은 건너뛴다 */ }
          if (e) onEvent(e);
        }
        skipping = false; start = nl + 1;
      }
      carry = data.subarray(start);
      if (carry.length > MAX_LINE) { carry = Buffer.alloc(0); skipping = true; } // 거대한 한 줄(도구 출력)은 버린다
      entry.off = pos - carry.length;
    }
  } finally { await fh.close(); }
  return read;
}

/**
 * 한 번 수집: 새 로그 줄에서 스킬 사용을 찾아 skill-usage.json·knowledge-metrics.json에 더하고 읽은 위치를 저장한다.
 * deps: dataDir, home, roots({harness: dir}), now. 반환: 이번에 더한 사용과 하네스별 누계.
 */
let running = null;
function collect(deps = {}) {
  if (running) return running; // 타이머와 버튼이 겹쳐도 한 번만 읽는다
  running = run(deps).finally(() => { running = null; });
  return running;
}
async function run(deps) {
  const started = deps.now ? deps.now() : Date.now();
  const state = await readJson(stateFile(deps), blank()); // 깨진 파일은 throw — 덮어쓰면 모든 로그를 다시 센다
  if (state.schemaVersion !== 1) throw new Error('harness-skill-log.json 형식이 다릅니다');
  const rows = [], seen = new Set(), errors = [], active = [];
  let files = 0, bytes = 0;
  for (const [harness, rootOf] of Object.entries(ROOTS)) {
    const root = (deps.roots && deps.roots[harness]) || rootOf(deps);
    for (const file of await jsonlFiles(root)) {
      const key = fileKey(harness, file);
      seen.add(key);
      const entry = state.files[key] || (state.files[key] = { h: harness, off: 0, skills: [] });
      const fallbackAt = await fs.promises.stat(file).then((s) => s.mtimeMs, () => started);
      try {
        const before = bytes;
        bytes += await readNew(file, entry, (e) => {
          for (const raw of EXTRACT[harness](e)) {
            const name = String(raw).trim();
            if (!NAME.test(name) || entry.skills.includes(name)) continue;
            entry.skills.push(name);
            const at = Date.parse(e.timestamp || (e.payload && e.payload.timestamp) || '') || fallbackAt;
            rows.push({ id: `skill:${name}`, harness, at });
          }
        });
        files++;
        if (bytes > before) active.push({ harness, root, file, mtimeMs: fallbackAt });
      } catch (e) { errors.push(`${harness}: ${e.code || e.message}`); }
    }
  }
  for (const key of Object.keys(state.files)) if (!seen.has(key)) delete state.files[key]; // 지워진 로그
  if (rows.length) {
    await require('./cache/skill-index').addUses(rows, deps);
    await require('./knowledge-metrics').recordHarnessUses(rows, deps);
  }
  for (const r of rows) state.totals[r.harness] = (state.totals[r.harness] || 0) + 1;
  const byHarness = {};
  for (const r of rows) byHarness[r.harness] = (byHarness[r.harness] || 0) + 1;
  // Sessions that wrote to their log but have no work-table row (hooks absent or untrusted) get an `unconfirmed` row.
  const swept = await require('./work-table').sweep(active, started).catch(() => 0);
  state.lastRun = { at: new Date(started).toISOString(), ms: (deps.now ? deps.now() : Date.now()) - started, files, bytes, added: rows.length, byHarness, swept, errors: errors.slice(0, 5) };
  await writeAtomic(stateFile(deps), JSON.stringify(state));
  return { ...state.lastRun, totals: state.totals };
}

/** 화면·harness_compat용: 마지막 실행과 하네스별 누계(읽기만). */
async function status(deps = {}) {
  const s = await readJson(stateFile(deps), blank()).catch(() => blank());
  return { lastRun: s.lastRun, totals: s.totals, sessions: Object.keys(s.files || {}).length };
}

module.exports = { collect, status, readsInCommand, claudeUses, codexUses, ROOTS };

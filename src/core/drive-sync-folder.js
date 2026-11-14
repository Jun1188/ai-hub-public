'use strict';
// Google Drive 데스크톱 클라이언트가 동기화하는 폴더(기본: 공유 폴더의 부모 「내 드라이브」)를 Google API 없이 다룬다.
// 규칙 1·2·9: 동기 I/O 없음(모든 호출에 시간 상한, share.js와 같은 멈춘 호출 셈), 삭제 없음(미러는 복사·갱신만),
// 연속 시간 초과 3회면 10분 회로 차단. 결과에는 기기 경로 대신 루트 기준 상대 경로만 싣는다(규칙 4).
// 루트와 쓰기 허용은 기기 전용 설정(hubCommands.driveRoot·driveAllowWrite, config.local.json)이다.
const fs = require('fs');
const path = require('path');
const share = require('./share');
const { SENSITIVE } = require('./harness-bridge/virtual-workspace');

const IO_MS = 5000;
// 게임 웹 빌드(.data·.wasm)가 수백 MB라 share.js의 50 MB 상한보다 크게 둔다. 시간 상한에 걸리면 남은 파일 수를 돌려주고 다시 부르면 이어서 한다.
const LIMITS = { entries: 200, files: 5000, fileBytes: 512 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024, totalMs: 5 * 60 * 1000 };
const TRIP_AFTER = 3, COOLDOWN_MS = 10 * 60 * 1000;
const TEMP = /\.tmp(-\d+)?$/;
const moduleBreaker = { failures: 0, until: 0 };
let autoRoot = { at: 0, root: '' };

const WRITE_OFF = 'Drive 쓰기가 꺼져 있습니다. 데스크톱 Hub의 설정 > 외부 연결 › Drive 동기화 폴더에서 「쓰기 허용」을 켜야 합니다.';

function settings(cfg = require('./config').load()) {
  const s = cfg.hubCommands || {};
  return { root: typeof s.driveRoot === 'string' ? s.driveRoot : '', allowWrite: s.driveAllowWrite === true };
}

/** 모든 Drive 호출의 입구: 차단 중이면 보내지 않고, 시간 초과를 세어 차단한다. 일은 thunk로 받아 차단 중에는 시작하지 않는다. */
async function io(deps, work, label, ms) {
  const b = deps.breaker || moduleBreaker;
  if (b.until > Date.now()) throw Error(`Drive 폴더가 연속으로 응답하지 않아 ${Math.ceil((b.until - Date.now()) / 60000)}분 동안 멈췄습니다. 자동 재시도하지 않습니다.`);
  try { return await share.withTimeout(work(), ms || deps.ioMs || IO_MS, label); }
  catch (e) {
    if (share.isTimeout(e)) { if (++b.failures >= TRIP_AFTER) b.until = Date.now() + COOLDOWN_MS; throw Error(`Drive 폴더 응답 시간 초과(${label}). 자동 재시도하지 않습니다.`); }
    throw e;
  }
}
// 연속 시간 초과 수는 명령 하나(목록·정보·미러)가 시간 초과 없이 끝났을 때만 지운다. 호출마다 지우면 루트 확인(stat)은 되고
// 목록(readdir)만 멈출 때 매번 1로 돌아가 차단기가 열리지 않고, 끝나지 않은 호출이 쌓인다(PR #69 리뷰).
function settled(deps, value) { (deps.breaker || moduleBreaker).failures = 0; return value; }
const orNull = (p) => p.catch((e) => { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; });

async function root(deps = {}) {
  const fsp = deps.fsp || fs.promises;
  let r = (deps.settings || settings()).root;
  if (!r) {
    if (Date.now() - autoRoot.at > 5 * 60 * 1000) {
      const cfg = deps.config || require('./config').load();
      const shared = process.env.AIHUB_SHARE_DIR || (cfg.share && cfg.share.dir) || await share.autodetectRoot();
      autoRoot = { at: Date.now(), root: shared ? path.dirname(shared) : '' };
    }
    r = autoRoot.root;
  }
  if (!r) throw Error('Drive 동기화 폴더를 찾지 못했습니다. Google Drive 데스크톱의 「내 드라이브」가 없으면 설정 > 외부 연결에서 Drive 루트를 지정하세요.');
  const st = await io(deps, () => orNull(fsp.stat(r)), 'stat');
  if (!st || !st.isDirectory()) throw Error('Drive 루트 폴더가 없습니다. Drive 데스크톱이 실행 중인지, 설정 > 외부 연결의 Drive 루트가 맞는지 확인하세요.');
  return r;
}

/** 루트 기준 상대 경로 → 조각 배열. 드라이브 문자·..·특수문자·민감 파일은 거부한다. */
function relParts(input) {
  const s = String(input == null ? '' : input).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = s ? s.split('/').filter((p) => p && p !== '.') : [];
  if (s.length > 400 || /[\0<>:"|?*]/.test(s) || parts.includes('..')) throw Error('Drive 경로는 루트 기준 상대 경로입니다(드라이브 문자·..·<>:"|?* 불가).');
  for (let i = 1; i <= parts.length; i++) if (SENSITIVE.test(parts.slice(0, i).join('/'))) throw Error('민감한 파일(키·자격 증명·.env 등)은 다루지 않습니다.');
  return parts;
}

/** 루트 아래 경로로 잇되, 이미 있는 조각 중 링크(심볼릭 링크·정션)가 있으면 거부한다 — 링크를 따라 루트 밖으로 나가지 않게. */
async function inside(r, parts, deps) {
  const fsp = deps.fsp || fs.promises;
  let cur = r;
  for (const p of parts) {
    cur = path.join(cur, p);
    const st = await io(deps, () => orNull(fsp.lstat(cur)), 'lstat');
    if (!st) break;
    if (st.isSymbolicLink()) throw Error('링크(심볼릭 링크·정션)는 따라가지 않습니다: ' + parts.join('/'));
  }
  return path.join(r, ...parts);
}

async function list(sub, deps = {}) {
  const fsp = deps.fsp || fs.promises;
  const r = await root(deps), parts = relParts(sub), dir = await inside(r, parts, deps);
  const all = await io(deps, () => fsp.readdir(dir, { withFileTypes: true }), 'readdir');
  const entries = [];
  let hidden = 0;
  for (const e of all.slice(0, LIMITS.entries)) {
    if (SENSITIVE.test([...parts, e.name].join('/')) || TEMP.test(e.name)) { hidden++; continue; }
    if (e.isSymbolicLink()) entries.push({ name: e.name, type: 'link' });
    else if (e.isDirectory()) entries.push({ name: e.name, type: 'dir' });
    else if (e.isFile()) {
      const st = await io(deps, () => orNull(fsp.stat(path.join(dir, e.name))), 'stat');
      if (st) entries.push({ name: e.name, type: 'file', size: st.size, modified: new Date(st.mtimeMs).toISOString() });
    }
  }
  return settled(deps, { path: parts.join('/') || '.', entries, total: all.length, truncated: all.length > LIMITS.entries, hidden });
}

async function stat(sub, deps = {}) {
  const fsp = deps.fsp || fs.promises;
  const r = await root(deps), parts = relParts(sub), p = await inside(r, parts, deps);
  const st = await io(deps, () => orNull(fsp.lstat(p)), 'lstat');
  if (!st) throw Error('Drive에 없는 경로입니다: ' + (parts.join('/') || '.'));
  return settled(deps, { path: parts.join('/') || '.', type: st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file', size: st.size, modified: new Date(st.mtimeMs).toISOString() });
}

// 하네스 개인 상태(세션·대화·DB·실행 로그·캐시·자격 증명)는 Drive로 내보내지 않는다(공유 저장소 AGENTS.md 안전 경계). 원본이 이 안에 있거나
// 이것을 품으면(홈 폴더 통째 등) 거부한다 — 순회 중에는 링크를 따르지 않으므로 품은 원본만 막으면 순회가 여기에 닿지 않는다.
function privateDirs(deps) {
  if (deps.privateDirs) return deps.privateDirs;
  const home = require('os').homedir();
  return [process.env.CODEX_HOME || path.join(home, '.codex'), path.join(home, '.claude'), path.join(home, '.gemini'), path.join(home, '.agent-work'),
    path.join(home, '.ssh'), process.env.APPDATA, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ai-hub'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ai-allinone-hub')].filter(Boolean);
}

/** 미러 원본(로컬 디스크): 절대 경로의 실제 폴더, Drive 루트·Hub 데이터·하네스 개인 상태 폴더와 겹치지 않을 것. */
async function sourceDir(source, r, deps) {
  const fsp = deps.fsp || fs.promises;
  const s = String(source || '').trim();
  if (!s || !path.isAbsolute(s) || s.startsWith('\\\\') || s.includes('\0')) throw Error('미러 원본은 이 PC의 로컬 폴더 절대 경로입니다(네트워크 경로 불가).');
  const abs = path.resolve(s);
  const local = (p) => require('./promise-timeout').withTimeout(p, IO_MS, () => Error('미러 원본 폴더 응답 시간 초과'));
  const st = await local(orNull(fsp.lstat(abs)));
  if (!st || !st.isDirectory() || st.isSymbolicLink()) throw Error('미러 원본 폴더가 없거나 링크입니다.');
  // 겹침은 실제 경로로 비교한다 — 경로 중간 조각이 링크·정션이면 글자 비교로는 실제 위치를 모른다(PR #69 리뷰). 원본은 반드시 풀어야 하고,
  // 없는 보호 폴더나 풀리지 않는 Drive 가상 드라이브는 글자 경로로 비교한다.
  const src = await local(fsp.realpath(abs)).catch(() => { throw Error('미러 원본 폴더의 실제 경로를 확인하지 못했습니다.'); });
  const real = (p) => local(fsp.realpath(p)).catch(() => path.resolve(p));
  const within = (a, b) => { const rel = path.relative(b, a); return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  const overlaps = async (p) => { const d = await real(p); return within(src, d) || within(d, src); };
  if (await overlaps(r)) throw Error('미러 원본과 Drive 루트가 겹칩니다. Drive 밖의 빌드 폴더를 고르세요.');
  if (await overlaps(deps.hubDataDir || require('./paths').hubDataDir())) throw Error('Hub 데이터 폴더(설정·키 저장소)는 미러하지 않습니다.');
  for (const p of privateDirs(deps)) {
    if (await overlaps(p)) throw Error('하네스 개인 상태 폴더(.codex·.claude·.gemini·AppData 등의 세션·로그·자격 증명)와 겹치는 원본은 미러하지 않습니다.');
  }
  return src;
}

/** 원본 트리(로컬)를 상한 안에서 센다. 링크·민감 파일·임시 파일은 건너뛰고, 상한을 넘으면 아무것도 복사하기 전에 멈춘다. */
async function walkSource(src, deps) {
  const fsp = deps.fsp || fs.promises;
  const files = [], skipped = [];
  // 원본도 다른 동기화 폴더일 수 있어 호출마다 시간 상한을 건다(규칙 1·9).
  const local = (p, label) => require('./promise-timeout').withTimeout(p, deps.ioMs || IO_MS, () => Error(`미러 원본 폴더 응답 시간 초과(${label}). 자동 재시도하지 않습니다.`));
  let bytes = 0;
  async function walk(dir, prefix) {
    for (const e of await local(fsp.readdir(dir, { withFileTypes: true }), 'readdir')) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name, abs = path.join(dir, e.name);
      if (SENSITIVE.test(rel)) { skipped.push({ path: rel, reason: 'sensitive' }); continue; }
      if (e.isSymbolicLink()) { skipped.push({ path: rel, reason: 'link' }); continue; }
      if (e.isDirectory()) { await walk(abs, rel); continue; }
      if (!e.isFile() || TEMP.test(e.name)) continue;
      const st = await local(fsp.stat(abs), 'stat');
      if (st.size > LIMITS.fileBytes) { skipped.push({ path: rel, reason: 'too-large' }); continue; }
      files.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
      bytes += st.size;
      if (files.length > LIMITS.files) throw Error(`원본 파일이 ${LIMITS.files}개를 넘습니다. 빌드 출력 폴더만 고르세요.`);
      if (bytes > LIMITS.totalBytes) throw Error(`원본 크기가 ${Math.round(LIMITS.totalBytes / 1048576)} MB를 넘습니다. 빌드 출력 폴더만 고르세요.`);
    }
  }
  await walk(src, '');
  return { files, skipped, bytes };
}

/** 임시 파일에 복사한 뒤 rename(원자적), 원본 시각을 남겨 다음 회차에 같은 파일을 다시 복사하지 않는다. */
async function copyOne(file, dst, deps) {
  const fsp = deps.fsp || fs.promises;
  const tmp = `${dst}.tmp-${process.pid}`;
  await io(deps, () => fsp.mkdir(path.dirname(dst), { recursive: true }), 'mkdir');
  try {
    await io(deps, () => fsp.copyFile(file.abs, tmp), 'copy', (deps.ioMs || IO_MS) * 4 + Math.ceil(file.size / (8 * 1048576)) * 1000);
    await io(deps, () => fsp.rename(tmp, dst), 'rename');
  } catch (e) {
    // 시간 초과면 복사가 아직 진행 중일 수 있다. 남은 임시 파일은 목록·미러가 건너뛴다(share.js와 같은 처리).
    if (!/시간 초과/.test(e.message)) await io(deps, () => fsp.unlink(tmp), 'unlink').catch(() => {});
    throw e;
  }
  const t = new Date(file.mtimeMs);
  await io(deps, () => fsp.utimes(dst, t, t), 'utimes');
}

/** 로컬 폴더 → Drive 하위 폴더. 없는 파일은 복사, 크기·시각이 다르면 갱신, 대상에만 있는 파일은 그대로 둔다(삭제 없음). */
async function mirror(source, target, deps = {}) {
  const fsp = deps.fsp || fs.promises, started = Date.now();
  if (!(deps.settings || settings()).allowWrite) throw Error(WRITE_OFF);
  const r = await root(deps), parts = relParts(target);
  if (!parts.length) throw Error('미러 대상은 Drive 루트 아래 하위 폴더여야 합니다.');
  const src = await sourceDir(source, r, deps), dstRoot = await inside(r, parts, deps);
  const { files, skipped, bytes } = await walkSource(src, deps);
  const out = { source: path.basename(src), target: parts.join('/'), files: files.length, bytes, copied: 0, updated: 0, unchanged: 0, failed: [], skipped: skipped.slice(0, 50), partial: false, remaining: 0, deleted: 0 };
  const checked = new Set();
  let timedOut = false;
  for (let i = 0; i < files.length; i++) {
    if (Date.now() - started > (deps.totalMs || LIMITS.totalMs)) { out.partial = true; out.remaining = files.length - i; break; }
    const f = files[i], segs = f.rel.split('/');
    try {
      const dirKey = segs.slice(0, -1).join('/');
      if (!checked.has(dirKey)) { await inside(r, [...parts, ...segs.slice(0, -1)], deps); checked.add(dirKey); }
      const dst = path.join(dstRoot, ...segs);
      const st = await io(deps, () => orNull(fsp.lstat(dst)), 'lstat');
      if (st && (st.isSymbolicLink() || st.isDirectory())) { out.skipped.push({ path: f.rel, reason: 'target-conflict' }); continue; }
      if (st && st.size === f.size && Math.abs(st.mtimeMs - f.mtimeMs) < 2000) { out.unchanged++; continue; }
      await copyOne(f, dst, deps);
      if (st) out.updated++; else out.copied++;
    } catch (e) {
      // 시간 초과·차단은 마운트가 멈춘 것이라 회차를 끝낸다. 파일 하나의 잠금·권한 오류는 그 파일만 건너뛴다.
      if (/시간 초과|멈췄습니다/.test(e.message)) { timedOut = true; out.partial = true; out.remaining = files.length - i; out.failed.push({ path: f.rel, error: e.message }); break; }
      out.failed.push({ path: f.rel, error: String(e.code || e.message).slice(0, 120) });
    }
  }
  out.skipped = out.skipped.slice(0, 50);
  out.failed = out.failed.slice(0, 50);
  out.notice = '대상에만 있는 파일은 지우지 않습니다. ' + (out.partial ? '시간 상한에서 멈췄습니다 — 같은 명령을 다시 실행하면 이어서 복사합니다.' : '');
  return timedOut ? out : settled(deps, out);
}

/** 설정 화면: 저장값·실제로 쓸 루트(자동이면 찾은 값)·쓰기 허용. 찾기 실패는 오류 글로만 돌려준다. */
async function view(deps = {}) {
  const s = deps.settings || settings();
  let effectiveRoot = '', error = null;
  try { effectiveRoot = await root(deps); } catch (e) { error = e.message; }
  return { root: s.root, allowWrite: s.allowWrite, auto: !s.root, effectiveRoot, error };
}

function save(input = {}) {
  const r = String(input.root == null ? '' : input.root).trim();
  if (r && (!path.isAbsolute(r) || r.startsWith('\\\\') || r.length > 260 || /[\0<>"|?*]/.test(r))) throw Error('Drive 루트는 이 PC의 절대 경로여야 합니다(비우면 「내 드라이브」 자동 탐지).');
  const config = require('./config');
  config.setLocalOnly('hubCommands.driveRoot', r);
  config.setLocalOnly('hubCommands.driveAllowWrite', input.allowWrite === true);
  autoRoot = { at: 0, root: '' };
  return settings(config.load());
}

module.exports = { settings, root, relParts, list, stat, mirror, view, save, LIMITS, WRITE_OFF };

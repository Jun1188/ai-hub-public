// 컴퓨터 간 데이터 공유 계층 (Google Drive "내 드라이브" 기반).
//
// 왜 이렇게 만들었나 — 2026-07-26 사고 기록:
//   Drive의 "다른 컴퓨터"(백업) 영역에 있는 앱 폴더 안에 hub-sync/ 를 두고
//   설정을 동기 읽기(fs.readFileSync)로 읽었더니,
//     · 마운트가 불안정해질 때 stat 한 번에 수 분씩 블록 → 앱이 멈춤
//     · G: 드라이브가 통째로 사라졌다 돌아오는 일까지 발생
//     · 설정을 못 읽어 기본값으로 떠서 "업데이트가 롤백된 것처럼" 보임
//   그래서 아래 다섯 가지를 불변 규칙으로 삼는다.
//
// 설계 원칙:
//   1) %APPDATA%\ai-hub 가 항상 "권위 저장소". 앱은 로컬만 보고 동작한다.
//   2) 공유 폴더는 best-effort 미러일 뿐. 느리거나 끊기거나 사라져도
//      앱 동작에는 아무 영향이 없어야 한다.
//   3) 공유 경로에 대한 동기 I/O(fs.*Sync)는 금지. 전부 비동기 + 타임아웃.
//   4) 삭제는 전파하지 않는다. 한쪽에서 파일이 사라져도 반대쪽을 지우지 않는다.
//      (마운트가 사라진 것을 "사용자가 지운 것"과 구별할 수 없기 때문)
//   5) 충돌은 mtime 기준 last-write-wins.
//
// 위치: "다른 컴퓨터"(백업) 영역이 아니라 **내 드라이브**를 쓴다.
//   내 드라이브는 두 컴퓨터 모두에서 같은 경로(G:\내 드라이브\...)로 보이고
//   양방향 동기화가 정상 동작한다. 백업 영역은 원본 PC의 단방향 미러라 부적합.
'use strict';

const fs = require('fs');
const path = require('path');
const { hubDataDir } = require('./paths');

const IO_TIMEOUT_MS = 5000;      // 개별 파일 작업 타임아웃
const PROBE_TIMEOUT_MS = 2000;   // 존재 확인 타임아웃
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 이보다 큰 파일은 건너뜀
const BREAKER_TRIP_AFTER = 3;    // 연속 실패 N회면 회로 차단
const BREAKER_COOLDOWN_MS = 10 * 60 * 1000;

const SHARE_FOLDER_NAME = 'ai-hub';
const MYDRIVE_NAMES = ['내 드라이브', 'My Drive'];

/**
 * 공유 대상 화이트리스트 (hubDataDir 기준 상대 경로).
 * 여기 없는 것은 전부 기기 전용으로 남는다:
 *   config.local.json(토큰·절대경로), index/·renderpipe/(재생성 가능한 캐시),
 *   finetune/·logs/·history.jsonl·stats.json·autopilot-state.json(기기별 기록)
 */
const SHARED_ITEMS = [
  { rel: 'config.cache.json', kind: 'file' }, // 공유 설정(기기 전용 값 제외됨)
  { rel: 'memory', kind: 'dir' },
  { rel: 'projects.json', kind: 'file' },
  { rel: 'pipelines.json', kind: 'file' },
  { rel: 'pipelines', kind: 'dir' },
  // 1.29.0에서 뺀 기능의 폴더(ai-projects·delegation-skills·harness-knowledge·proposals)는 더
  // 동기화하지 않는다. 지우지는 않는다(규칙 2).
];

const state = {
  root: null,          // 확정된 공유 폴더 경로(null이면 비활성)
  detecting: false,
  syncing: false,
  lastSyncAt: 0,
  lastError: '',
  failures: 0,
  breakerUntil: 0,
  copiedIn: 0,
  copiedOut: 0,
  // 시간 초과됐지만 밑의 fs 호출은 아직 안 끝난 수. Promise.race는 그 호출을 취소하지 못해
  // libuv 스레드(기본 4개)를 계속 잡으므로, 0이 될 때까지 새 회차를 시작하지 않는다.
  stuckCalls: 0,
};

let onChange = null; // 공유본이 들어와 로컬이 바뀌었을 때 호출(설정 리로드용)

// 원자적 쓰기의 임시파일(이 파일의 `.tmp-<pid>` 포함). 실패나 시간 초과 뒤 남아도 미러하지 않는다.
const TEMP_FILE = /\.tmp(-\d+)?$/;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      state.stuckCalls++;
      const settled = () => { state.stuckCalls--; };
      promise.then(settled, settled);
      reject(Object.assign(new Error(`timeout:${label}`), { code: 'ETIMEDOUT' }));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const isTimeout = (err) => Boolean(err) && err.code === 'ETIMEDOUT';

/** 없으면 null. 시간 초과·권한 오류는 던진다 — 읽지 못한 것은 "없음"이 아니다(규칙 6). */
async function statOrNull(p, ms = IO_TIMEOUT_MS) {
  try {
    return await withTimeout(fs.promises.stat(p), ms, 'stat');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

async function existsSafe(p, ms = PROBE_TIMEOUT_MS) {
  return (await statOrNull(p, ms).catch(() => null)) !== null;
}

// ---- 공유 폴더 위치 결정 ----------------------------------------------------

/** 내 드라이브를 찾아 <내 드라이브>/ai-hub 경로를 돌려준다. 없으면 null. */
async function autodetectRoot() {
  const letters = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  for (const L of letters) {
    if (!(await existsSafe(`${L}:\\`, 500))) continue;
    for (const name of MYDRIVE_NAMES) {
      const myDrive = path.join(`${L}:\\`, name);
      if (await existsSafe(myDrive)) {
        const canonical = path.join(myDrive, SHARE_FOLDER_NAME);
        const legacy = path.join(myDrive, 'AI-AllInOne-Hub');
        if (await existsSafe(canonical)) return canonical;
        return await existsSafe(legacy) ? legacy : canonical;
      }
    }
  }
  return null;
}

/**
 * 공유 폴더를 결정한다. 우선순위:
 *   1) 환경변수 AIHUB_SHARE_DIR
 *   2) 설정 share.dir (기기 전용 값 — 컴퓨터마다 다를 수 있음)
 *   3) 내 드라이브 자동 탐지
 * 결정되면 폴더를 만들고 경로를 반환. 후보가 없으면 null(공유 비활성).
 * 후보는 있는데 만들 수 없으면(마운트 없음·시간 초과) 던져서 syncNow가 실패로 센다.
 */
async function resolveRoot(configuredDir) {
  if (state.root) return state.root;
  if (state.detecting) return null;
  state.detecting = true;
  try {
    let root = process.env.AIHUB_SHARE_DIR || configuredDir || '';
    if (!root) root = (await autodetectRoot()) || '';
    if (!root) return null;
    await withTimeout(fs.promises.mkdir(root, { recursive: true }), IO_TIMEOUT_MS, 'mkdir');
    state.root = root;
    return root;
  } finally {
    state.detecting = false;
  }
}

// ---- 미러링 ---------------------------------------------------------------

/**
 * 디렉터리를 재귀 순회해 files(relPath -> {mtimeMs, size})와 skip(relPath -> 사유)을 만든다.
 * 폴더가 없으면 빈 결과. 못 읽은 가지·파일과 크기 초과 파일은 skip에 넣고, 시간 초과는 던진다.
 */
async function listTree(root) {
  const files = new Map();
  const skip = new Map();
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await withTimeout(
        fs.promises.readdir(dir, { withFileTypes: true }), IO_TIMEOUT_MS, 'readdir',
      );
    } catch (err) {
      if (isTimeout(err)) throw err;
      if (err.code !== 'ENOENT') skip.set(prefix, err.message);
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(abs, rel);
      } else if (e.isFile() && !TEMP_FILE.test(e.name)) {
        let st;
        try {
          st = await statOrNull(abs);
        } catch (err) {
          if (isTimeout(err)) throw err;
          skip.set(rel, err.message);
          continue;
        }
        if (!st) continue; // 순회 중에 사라졌다
        if (st.size > MAX_FILE_BYTES) skip.set(rel, `${abs}: ${MAX_FILE_BYTES}바이트 초과`);
        else files.set(rel, { mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  }
  await walk(root, '');
  return { files, skip };
}

/**
 * src -> dst 복사(디렉터리 자동 생성 + mtime 보존). 실패는 던진다.
 * rename이 끝나면 dst는 이미 바뀌었으므로 그때 pass[dir]을 센다 — 뒤의 utimes가 실패해도
 * 들어온 변경이 onChange(설정 리로드)에서 빠지지 않게.
 */
async function copyFile(src, dst, mtimeMs, pass, dir) {
  const tmp = `${dst}.tmp-${process.pid}`;
  try {
    await withTimeout(fs.promises.mkdir(path.dirname(dst), { recursive: true }), IO_TIMEOUT_MS, 'mkdir');
    await withTimeout(fs.promises.copyFile(src, tmp), IO_TIMEOUT_MS * 4, 'copy');
    await withTimeout(fs.promises.rename(tmp, dst), IO_TIMEOUT_MS, 'rename');
  } catch (err) {
    // 시간 초과면 복사가 아직 진행 중일 수 있고 지우기도 멈춘다. 남은 임시파일은 listTree가 건너뛴다.
    if (!isTimeout(err)) {
      await withTimeout(fs.promises.unlink(tmp), PROBE_TIMEOUT_MS, 'unlink').catch(() => {});
    }
    throw err;
  }
  pass[dir]++;
  // mtime을 원본과 맞춰야 다음 회차에 무한 복사가 일어나지 않는다.
  const t = new Date(mtimeMs);
  await withTimeout(fs.promises.utimes(dst, t, t), IO_TIMEOUT_MS, 'utimes');
}

// 한 항목의 실패(권한·잠금 등)는 그 항목만 이번 회차에서 건너뛴다. 시간 초과는 마운트가 멈춘 것이라 회차를 끝낸다.
function skipOrThrow(pass, err) {
  if (isTimeout(err)) throw err;
  pass.skipped.push(String((err && err.message) || err));
}

/** 파일 한 쌍을 mtime 기준으로 양방향 동기화. 한쪽을 읽지 못하면 던진다. */
async function syncFilePair(localPath, remotePath, pass) {
  const ls = await statOrNull(localPath);
  const rs = await statOrNull(remotePath);
  if (!ls && !rs) return;
  if (ls && ls.size > MAX_FILE_BYTES) return;
  // 1초 이내 차이는 같은 파일로 본다 (FS마다 mtime 해상도가 다름).
  if (!rs || (ls && ls.mtimeMs > rs.mtimeMs + 1000)) {
    await copyFile(localPath, remotePath, ls.mtimeMs, pass, 'out');
  } else if (!ls || rs.mtimeMs > ls.mtimeMs + 1000) {
    await copyFile(remotePath, localPath, rs.mtimeMs, pass, 'in');
  }
}

/** 디렉터리 한 쌍을 양방향 동기화. 삭제는 전파하지 않는다. */
async function syncDirPair(localDir, remoteDir, pass) {
  const localTree = await listTree(localDir);
  const remoteTree = await listTree(remoteDir);
  const skip = new Map([...localTree.skip, ...remoteTree.skip]);
  pass.skipped.push(...skip.values());
  // 한쪽에서 못 본 가지·파일은 "없음"이 아니다 — 반대쪽 사본으로 덮지 않게 이번 회차에서 뺀다.
  const skipped = (rel) => [...skip.keys()].some((p) => p === '' || rel === p || rel.startsWith(`${p}/`));
  const rels = new Set([...localTree.files.keys(), ...remoteTree.files.keys()]);
  for (const rel of rels) {
    if (skipped(rel)) continue;
    const l = localTree.files.get(rel);
    const r = remoteTree.files.get(rel);
    const lp = path.join(localDir, ...rel.split('/'));
    const rp = path.join(remoteDir, ...rel.split('/'));
    try {
      if (l && (!r || l.mtimeMs > r.mtimeMs + 1000)) {
        await copyFile(lp, rp, l.mtimeMs, pass, 'out');
      } else if (r && (!l || r.mtimeMs > l.mtimeMs + 1000)) {
        await copyFile(rp, lp, r.mtimeMs, pass, 'in');
      }
    } catch (err) {
      skipOrThrow(pass, err);
    }
  }
}

// ---- 공개 API -------------------------------------------------------------

function breakerOpen() {
  return state.breakerUntil > Date.now();
}

/**
 * 한 번 동기화한다. 절대 throw하지 않으며, 실패해도 앱에는 영향이 없다.
 * @param {string} configuredDir 설정에 저장된 공유 폴더 경로(비어 있으면 자동 탐지)
 * @returns {Promise<object>} status()
 */
async function syncNow(configuredDir = '') {
  if (state.syncing) return status();      // 단일 실행: 블록된 작업이 쌓이지 않게
  state.syncing = true;
  const local = hubDataDir();
  const pass = { in: 0, out: 0, skipped: [] };
  try {
    await require('./repository-update').sync({ lite: require('./device-profile').lite() });
    if (breakerOpen()) return status();
    if (state.stuckCalls > 0) {
      throw new Error(`이전 공유 폴더 작업 ${state.stuckCalls}건이 아직 끝나지 않았습니다 (마운트 응답 없음)`);
    }
    const root = await resolveRoot(configuredDir);
    if (!root) {
      state.lastError = '공유 폴더를 찾을 수 없습니다 (내 드라이브 미탐지)';
      return status();
    }
    // 정해 둔 공유 폴더가 사라졌거나(ENOENT) 응답이 없으면 이번 회차는 실패다.
    await withTimeout(fs.promises.stat(root), PROBE_TIMEOUT_MS, 'probe');
    for (const item of SHARED_ITEMS) {
      const lp = path.join(local, item.rel);
      const rp = path.join(root, item.rel);
      try {
        if (item.kind === 'file') await syncFilePair(lp, rp, pass);
        else await syncDirPair(lp, rp, pass);
      } catch (err) {
        skipOrThrow(pass, err);
      }
    }
    state.lastSyncAt = Date.now();
    state.lastError = pass.skipped.length
      ? `이번 회차에서 ${pass.skipped.length}개 항목을 건너뜀: ${pass.skipped[0]}`
      : '';
    state.failures = 0;
  } catch (err) {
    // 공유 폴더에 닿지 못했거나 작업이 시간 초과됐다. 연속되면 회로를 끊어 반복 대기를 막는다.
    state.failures++;
    state.lastError = String((err && err.message) || err);
    if (state.failures >= BREAKER_TRIP_AFTER) {
      state.breakerUntil = Date.now() + BREAKER_COOLDOWN_MS;
      state.root = null; // 다음 시도 때 경로부터 다시 확인
    }
  } finally {
    // 중간에 끝난 회차도 이미 끝난 복사는 센다.
    state.copiedIn += pass.in;
    state.copiedOut += pass.out;
    state.syncing = false;
  }
  if (pass.in > 0 && typeof onChange === 'function') {
    try {
      onChange({ changedIn: pass.in, changedOut: pass.out });
    } catch {
      /* 콜백 오류는 동기화에 영향 없음 */
    }
  }
  return status();
}

let timer = null;

/** 주기 동기화 시작 (GUI/트레이 프로세스에서만 호출). */
function start({ configuredDir = '', intervalMs = 5 * 60 * 1000, onSharedChange = null } = {}) {
  onChange = onSharedChange;
  stop();
  // 시작 직후 한 번, 그다음 주기적으로. 모두 비동기라 시작을 지연시키지 않는다.
  setTimeout(() => { syncNow(configuredDir); }, 3000).unref?.();
  timer = setInterval(() => { syncNow(configuredDir); }, intervalMs);
  timer.unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function status() {
  return {
    repository: require('./repository-update').status(),
    enabled: Boolean(state.root),
    root: state.root || '',
    lastSyncAt: state.lastSyncAt,
    lastError: state.lastError,
    syncing: state.syncing,
    paused: breakerOpen(),
    pausedUntil: state.breakerUntil,
    copiedIn: state.copiedIn,
    copiedOut: state.copiedOut,
    items: SHARED_ITEMS.map((i) => i.rel),
  };
}

/** 설정에서 경로가 바뀌었을 때 재탐지를 강제한다. */
function resetRoot() {
  state.root = null;
  state.failures = 0;
  state.breakerUntil = 0;
  state.lastError = '';
}

module.exports = {
  syncNow,
  start,
  stop,
  status,
  resetRoot,
  autodetectRoot,
  // 다른 Drive 경로 작업(drive-sync-folder.js)도 같은 시간 상한·멈춘 호출 셈을 쓴다 — libuv 스레드는 하나의 풀이다.
  withTimeout,
  isTimeout,
  SHARE_FOLDER_NAME,
  SHARED_ITEMS,
};

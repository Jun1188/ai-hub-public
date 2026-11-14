// Hub configuration store.
//
// 저장 구조 (전부 %APPDATA%\ai-hub — 로컬 디스크라 항상 빠르고 안전):
//   1) 공유 설정  -> config.cache.json
//        - 컴퓨터 간에 같아야 하는 값. share.js가 공유 폴더로 미러링합니다.
//        - 저장할 때마다 _updatedAt(수정 시각, epoch ms)을 기록합니다.
//        - 두 컴퓨터의 설정이 충돌하면 "_updatedAt이 더 최신인 쪽"이 이깁니다.
//   2) 기기 전용 -> config.local.json
//        - 인증 토큰, 절대경로 등 컴퓨터마다 달라야 하는 값. 공유하지 않습니다.
//
// ⚠ 이 파일은 Google Drive 경로를 **절대 직접 읽거나 쓰지 않습니다.**
//   예전(v1.7.x)에는 앱 폴더 안 hub-sync/config.json을 fs.readFileSync로 읽었는데,
//   Drive 마운트가 불안정해지면 stat 한 번에 수 분씩 블록되어 Electron 메인
//   프로세스가 통째로 멈췄고, 설정을 못 읽어 기본값으로 떠서 "업데이트가
//   롤백된 것처럼" 보이는 사고가 있었습니다. 공유는 전적으로 share.js가
//   비동기 + 타임아웃으로만 처리합니다.
//
// 예전 버전이 쓰던 %APPDATA%/ai-hub/config.json 은 첫 실행 시
// 파일 수정 시각을 _updatedAt으로 삼아 공유 파일로 마이그레이션합니다.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const deviceFile = require('./device-config-replace');
const saveMetrics = require('./device-config-metrics');
const { hubDataDir } = require('./paths');

// 예전(단일 파일) 위치 — 마이그레이션 원본으로만 사용.
const LEGACY_FILE = path.join(hubDataDir(), 'config.json');
// 기기 전용 오버라이드(토큰, 절대경로). 공유 안 함.
const LOCAL_FILE = path.join(hubDataDir(), 'config.local.json');
// 공유 설정의 권위 저장소. share.js가 이 파일을 공유 폴더와 미러링합니다.
const SHARED_FILE = path.join(hubDataDir(), 'config.cache.json');

// 컴퓨터마다 달라야 하는 값(점 표기 경로). 공유 파일엔 절대 쓰지 않습니다.
const LOCAL_ONLY_PATHS = [
  'hub.authToken',               // 기기별 시크릿(첫 실행 시 생성)
  'memory.dir',                  // 절대경로
  'devpipeline.antigravityPath', // 절대경로
  'devpipeline.vswherePath',     // 절대경로
  'share.dir',                   // 공유 폴더 경로(컴퓨터마다 드라이브 문자가 다를 수 있음)
  'hubCommands.driveRoot',       // /drive 명령의 Drive 동기화 폴더(절대경로, 비우면 내 드라이브 자동 탐지)
  'hubCommands.driveAllowWrite', // /drive mirror 허용 — 이 PC에서 켠 것만(다른 PC로 번지지 않게)
  'hub.autoStart',               // Device-only startup preference.
  'hub.profile',                 // full | lite(사무용 노트북 경량 모드). device-profile.js 참고
  'hub.liteFeatures',            // 경량 모드에서 켤 기능 ID 목록(feature-profile.js). 없으면 기본 묶음
  // LM Studio는 컴퓨터마다 포트도, 설치된 모델도 다르다. 공유하면 한쪽에서 고른
  // 모델 이름이 다른 쪽으로 넘어가 "그런 모델 없음"이 되거나, 포트가 어긋나 위임이
  // 전부 실패한다. 모델 등급표(modelTiers)는 모델 계열에 대한 지식이라 계속 공유한다.
  'lmstudio.baseUrl',
  'index.skillEmbeddingModel',    // 스킬 검색 전용 임베딩 — 이 PC의 LM Studio에 받은 모델 이름
  'localRuntimes.comfyUrl',
  'localRuntimes.llamaUrl',
  'localRuntimes.llamaRepo',
  'localRuntimes.llamaModelPath', // selected existing GGUF: device-only
  'localRuntimes.automaticPreparation', // office/control-only hosts may disable automatic inference

  'localRuntimes.showInstallActions',
  'delegation.defaultModel',
  // 1.29.0에서 오케스트레이션은 없어졌지만 남은 값이 공유 파일로 새거나 기기 파일에서 지워지지 않게 둔다.
  'orchestration.workerModel',
  'orchestration.reviewerModel',
  // 하드웨어 임계값 덮어쓰기는 기기마다 VRAM·전원·발열 조건이 달라 공유하지 않는다.
  'hardware.policyOverrides',
  // 공유 저장소 clone 위치는 PC마다 다르다(드라이브·사용자 폴더).
  'sharedContext.repoPath',
  'sharedContext.bootstrapPath',
];

// 다운스트림 서버 항목에서 기기 전용으로 취급할 필드. headers에는 인증 토큰이,
// env에는 컴퓨터별 경로가 들어간다 — 공유 설정에 실려 Drive로 나가면 안 된다.
// 서버 이름이 동적이라 LOCAL_ONLY_PATHS(고정 경로)로는 못 다룬다.
const DOWNSTREAM_LOCAL_FIELDS = ['headers', 'env'];

/** 이 설정 객체에 실제로 존재하는 기기 전용 경로 전체(고정 + 다운스트림 동적). */
function localOnlyPathsFor(obj) {
  const paths = [...LOCAL_ONLY_PATHS];
  for (const name of Object.keys((obj && obj.downstreamServers) || {})) {
    for (const f of DOWNSTREAM_LOCAL_FIELDS) paths.push(`downstreamServers.${name}.${f}`);
  }
  return paths;
}

const DEFAULTS = {
  lmstudio: {
    enabled: false,
    baseUrl: 'http://127.0.0.1:1234',
    // 600초. 이 값은 2026-07-30까지 **아무 효과가 없었다** — fetch(undici)의
    // headersTimeout 300초가 무조건 먼저 걸렸기 때문이다(lmstudio.chatOnce의 스트리밍
    // 주석 참고). 스트리밍으로 바꾸면서 비로소 동작하게 됐고, 그러자 300초로는
    // 부족하다는 게 드러났다: 근거 기반 분석(renderpipe·deepdive)은 추론형 모델에서
    // 실측 247~300초가 걸린다(완료 3057토큰 중 2347토큰=77%가 히든 추론).
    timeoutMs: 600000,
  },
  localRuntimes: {
    comfyUrl: 'http://127.0.0.1:8188',
    llamaUrl: 'http://127.0.0.1:8080',
    llamaRepo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M',
    showInstallActions: false,
    automaticPreparation: false,
  },
  hub: {
    enabled: false,
    httpPort: 18763,
    bindHost: '127.0.0.1',
    // Expose the HTTP hub on the LAN (bind 0.0.0.0) so AI tools on other
    // machines can register this hub by URL. Bearer auth is forced ON in
    // this mode regardless of requireAuth.
    lanAccess: false,
    // Bearer token required for HTTP MCP connections. Generated on first run.
    authToken: '',
    requireAuth: true,
    // Keep the hub alive in the system tray when the window is closed.
    closeToTray: false,
    // Launch the app automatically at Windows login (packaged builds only).
    autoStart: false,
    // 'full' | 'lite' — optional office-laptop mode, device-only (src/core/device-profile.js).
    profile: 'lite',
  },
  delegation: {
    // Default model used when the caller does not pick one. Empty = auto-route.
    defaultModel: '',
    defaultTemperature: 0.2,
    defaultMaxTokens: 4096,
    // Per-model capability tier. Tiers gate which task types a model may take:
    //   high   -> gamedev + programming + reasoning
    //   medium -> programming + reasoning
    //   low    -> reasoning only
    // Unknown models fall back to heuristics in delegator.js.
    modelTiers: {},
    // Extra instructions the user appends to every delegated task (GUI editable).
    userGlobalPrompt: '',
    // 답변이 max_tokens에 걸려 잘리면(finish_reason=length) 예산을 늘려 한 번만
    // 다시 부른다. 추론형 모델은 예산을 히든 추론에 먼저 쓰기 때문에 첫 호출이
    // 잘릴 수 있는데, 그 결과로 측정된 추론 비율이 이후 호출의 예산에 반영된다
    // (src/core/reply-budget.js).
    retryOnTruncation: true,
  },
  // 하드웨어 최적화(hardware-optimizer.js). 정책 기본값은 공유 저장소 harness/routing-policy.json과
  // 같은 src/core/routing-policy.default.json이다. 이 PC만 다른 값은 policyOverrides에 둔다(기기 전용).
  hardware: {
    policyOverrides: {},
  },
  // 메모리 탭의 공유 저장소 검색(shared-memory.js). 비우면 알려진 clone 위치에서 찾는다.
  sharedContext: {
    repoPath: '',
    bootstrapPath: '',
  },
  ui: {
    // false = 기본 버전 (간단 GUI). true = 개발자 버전: JSON 파이프라인 편집,
    // C++ 소스 인덱싱 고급 옵션, 파인튜닝, 스킬/등급 편집 등 노출.
    devMode: false,
  },
  autopilot: {
    // Claude-Code-style background work, SAFE tasks only (hub-local data;
    // never shell/build/downstream steps). Runs while the app/tray is alive.
    enabled: false,
    jobs: {
      memoryConsolidate: true,
      safePipelines: true,
    },
  },
  memory: {
    // Custom storage dir for hub memory. Empty = %APPDATA%/ai-hub/memory.
    // 컴퓨터 간 메모리 공유는 이제 share.js가 담당하므로 보통 비워둡니다.
    dir: '',
  },
  devpipeline: {
    // Manual tool-path overrides for game-project detection (auto-detect otherwise).
    antigravityPath: '',
    vswherePath: '',
  },
  // 컴퓨터 간 데이터 공유 (Google Drive 내 드라이브). share.js 참고.
  share: {
    // 공유 폴더 경로. 비우면 내 드라이브를 자동 탐지합니다(기기 전용 값).
    dir: '',
    // 주기 동기화 사용 여부.
    enabled: false,
    // 동기화 주기(분).
    intervalMin: 5,
  },
  // Repository updates keep the existing installation path and apply on next launch.
  update: {
    autoCheck: false,
    checkIntervalMin: require('./repository-update').manualPolicy() === 'manual' ? 30 : 60,
  },
  downstreamServers: {
    // name -> { type: 'stdio'|'http', command?, args?, env?, url?, enabled }
  },
};

let cache = null;
// 비동기 호출자가 이전 load() 객체를 보유해도 그 객체를 받았을 때의 값과 비교한다.
const deviceBaselines = new WeakMap();
let localFileExpected = false;

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---- dotted-path helpers (점 표기 경로 도우미) ----
function getByPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setByPath(obj, dotted, val) {
  const keys = dotted.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!o[keys[i]] || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = val;
}
function hasByPath(obj, dotted) {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys) {
    if (o == null || typeof o !== 'object' || !(k in o)) return false;
    o = o[k];
  }
  return true;
}
function deleteByPath(obj, dotted) {
  const keys = dotted.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o == null || typeof o[keys[i]] !== 'object') return;
    o = o[keys[i]];
  }
  delete o[keys[keys.length - 1]];
}

/** 설정 객체를 공유(shared) / 기기전용(local) 두 조각으로 분리. */
function splitLocal(cfg) {
  const clone = JSON.parse(JSON.stringify(cfg || {}));
  delete clone._updatedAt;
  const local = {};
  for (const p of localOnlyPathsFor(clone)) {
    if (hasByPath(clone, p)) {
      setByPath(local, p, getByPath(clone, p));
      deleteByPath(clone, p);
    }
  }
  // 다른 컴퓨터가 "무엇이 비어 있는지" 알 수 있게 필드/키 **이름만** 남긴다.
  // 값이 아니라 이름이므로 시크릿이 아니고, downstream.autofillLocalSecrets()가
  // 이걸 보고 로컬 AI 도구 설정에서 값을 찾아 채운다.
  // 표식을 지우지는 않는다 — "이 컴퓨터에 값이 없다"와 "원래 필요 없다"를 구별할 수
  // 없기 때문. 서버를 다시 추가하면 새 항목이 만들어져 표식도 초기화된다.
  for (const [name, spec] of Object.entries(clone.downstreamServers || {})) {
    if (!spec || typeof spec !== 'object') continue;
    const needs = {};
    for (const f of DOWNSTREAM_LOCAL_FIELDS) {
      const v = getByPath(local, `downstreamServers.${name}.${f}`);
      if (v && typeof v === 'object' && Object.keys(v).length) needs[f] = Object.keys(v);
    }
    if (Object.keys(needs).length) spec.needsLocal = needs;
  }
  return { shared: clone, local };
}

/** local 파일 내용 중 LOCAL_ONLY 값만 골라냄(과거 잔여 필드 방지). */
function pickLocalOnly(obj) {
  const out = {};
  for (const p of localOnlyPathsFor(obj)) {
    if (hasByPath(obj, p)) setByPath(out, p, getByPath(obj, p));
  }
  return out;
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

// 기기 파일을 다시 쓸 때에는 읽기 실패를 새 설치로 간주할 수 없다.
// 실패는 캐시하지 않는다. 다음 로드·저장 요청은 원본을 다시 읽는다.
function readLocalForWrite() {
  // ReplaceFile can move the old target to its backup and then fail. This also has to survive a process restart.
  if (deviceFile.recoveryPending(LOCAL_FILE)) {
    const error = new Error(deviceFile.recoveryMessage);
    error.code = 'HUB_DEVICE_CONFIG_READ';
    error.reason = 'recovery_required';
    throw error;
  }
  try {
    const text = fs.readFileSync(LOCAL_FILE, 'utf8').replace(/^\uFEFF/, '');
    localFileExpected = true;
    const local = JSON.parse(text);
    if (local && typeof local === 'object' && !Array.isArray(local)) return local;
  } catch (error) {
    if (error.code === 'ENOENT' && !localFileExpected) return null;
    localFileExpected = true;
  }
  // JSON 오류에는 원문의 일부가, 시스템 오류에는 사용자 경로가 들어갈 수 있다.
  const error = new Error('기기 설정을 읽을 수 없어 저장하지 않았습니다. 파일 접근을 확인한 뒤 다시 시도하세요.');
  error.code = 'HUB_DEVICE_CONFIG_READ';
  throw error;
}

function fileMtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 원자적 쓰기. 임시 파일에 다 쓴 뒤 rename으로 바꿔치기한다.
 *
 * 왜: 예전에는 writeFileSync로 바로 덮어썼는데, 앱을 연속 실행하면 한 프로세스가
 * 쓰는 도중(파일이 잘린 상태) 다른 프로세스가 읽어서 JSON 파싱에 실패했다.
 * 그 결과 "설정이 없다"고 판단해 기본값으로 덮어써 downstreamServers가 통째로
 * 날아갔다(2026-07-26). rename은 원자적이라 읽는 쪽은 항상 옛 파일 아니면 새 파일을 본다.
 */
const deviceRetries = new WeakMap();
const waitWord = new Int32Array(new SharedArrayBuffer(4));
const deviceReplaceCodes = new Set(['EPERM','EACCES','EBUSY']);
function deviceConflict() {
  const error = new Error('다른 작업이 기기 설정을 변경했습니다. 최신 설정을 확인한 뒤 다시 저장하세요.');
  error.code = 'HUB_DEVICE_CONFIG_WRITE';
  error.reason = 'changed';
  return error;
}
function writeJSON(file, obj, previous, guard, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = guard ? path.join(guard.lock,guard.token+'.tmp') : `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  // Preserve BOM for device-only PowerShell settings; shared JSON stays unchanged.
  const prefix = file === LOCAL_FILE ? '\uFEFF' : '';
  let moved = false;
  try {
    fs.writeFileSync(tmp, prefix + JSON.stringify(obj, null, 2), {encoding:'utf8', flag:'wx', mode:0o600});
    if (mode?.createOnly || (file === LOCAL_FILE && previous === null)) {
      try {
        fs.linkSync(tmp,file);
        if (file === LOCAL_FILE) saveMetrics.count('physicalWrites');
      }
      catch(err) { if (!mode?.createOnly || err.code !== 'EEXIST') throw err; }
      return;
    }
    for (let attempt = 0; ; attempt++) {
      if (file === LOCAL_FILE && !isDeepStrictEqual(previous, readLocalForWrite())) throw deviceConflict();
      try {
        fs.renameSync(tmp, file);
        if (file === LOCAL_FILE) saveMetrics.count('physicalWrites');
        moved = true;
        return;
      } catch (err) {
        if (file !== LOCAL_FILE || process.platform !== 'win32' || !deviceReplaceCodes.has(err.code)) throw err;
        if (attempt < 2) {
          saveMetrics.count('renameRetries');
          // Legacy synchronous callers get at most 8 ms of waiting. The UI waits asynchronously for longer contention.
          Atomics.wait(waitWord, 0, 0, attempt === 0 ? 2 : 6);
          continue;
        }
        if (!mode?.deferNative) {
          const op=deviceFile.prepare(file,tmp,currentDigest(previous),guard);
          saveMetrics.count('nativeEntries');
          deviceFile.replaceSync(op);
          saveMetrics.count('physicalWrites');
          return;
        }
        const blocked = new Error('기기 설정 파일을 교체할 수 없습니다 (' + err.code + '). 잠시 후 다시 저장하세요.');
        blocked.code = 'HUB_DEVICE_CONFIG_WRITE';
        blocked.reason = 'replace_denied';
        blocked.nativeCode = err.code;
        deviceRetries.set(blocked, {previous,obj});
        throw blocked;
      }
    }
  } finally {
    if (!moved) {
      try { fs.unlinkSync(tmp); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
  }
}

function currentDigest(previous) {
  const bytes = fs.readFileSync(LOCAL_FILE);
  let state;
  try { state = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')); } catch { throw deviceConflict(); }
  if (!isDeepStrictEqual(previous,state)) throw deviceConflict();
  return deviceFile.digest(bytes);
}

function writeLocal(obj, previous, mode) {
  if (isDeepStrictEqual(obj, previous)) return;
  return writeChangedLocal(obj, previous, mode);
}
const writeChangedLocal = saveMetrics.track(function (obj, previous, mode) {
  let guard;
  try {
    guard = deviceFile.claim(LOCAL_FILE);
    writeJSON(LOCAL_FILE, obj, previous, guard, mode);
    localFileExpected = true;
  } catch (error) {
    if (error.reason === 'writer_busy') deviceRetries.set(error,{previous,obj});
    if (error.code === 'HUB_DEVICE_CONFIG_WRITE' || error.code === 'HUB_DEVICE_CONFIG_READ') throw error;
    if (error.code === 'EEXIST') localFileExpected = true;
    const failure = new Error('기기 설정을 저장하지 못했습니다. 파일 접근을 확인한 뒤 다시 시도하세요.');
    failure.code = 'HUB_DEVICE_CONFIG_WRITE';
    throw failure;
  } finally { if (guard) guard.release(); }
});

function writeShared(obj, mode) {
  try {
    writeJSON(SHARED_FILE, obj, undefined, undefined, mode);
  } catch {
    const error = new Error('공유 설정을 저장하지 못했습니다. 파일 접근을 확인한 뒤 다시 시도하세요.');
    error.code = 'HUB_SHARED_CONFIG_WRITE';
    throw error;
  }
}

/**
 * {obj, ts, unreadable} 형태로 후보를 만든다.
 * 파일이 있는데 읽지 못한 경우(unreadable)와 아예 없는 경우를 구별해야 한다 —
 * 읽기 실패를 "설정 없음"으로 취급하면 멀쩡한 설정을 기본값으로 덮어쓰게 된다.
 */
function candidate(file) {
  const obj = readJSON(file);
  if (obj) {
    const ts = typeof obj._updatedAt === 'number' ? obj._updatedAt : fileMtimeMs(file);
    return { obj, ts, unreadable: false };
  }
  return fs.existsSync(file) ? { obj: null, ts: 0, unreadable: true } : null;
}

/** 망가진 설정 파일을 지우지 않고 옆으로 치워 둔다(사후 분석용). */
function quarantine(file) {
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    /* 옮기지 못해도 진행 */
  }
}

function load() {
  if (cache) return cache;

  const existingLocal = readLocalForWrite();
  const localObj = structuredClone(existingLocal || {});

  // 공유 설정 후보: 권위 파일 / (마이그레이션용) 레거시. 둘 다 %APPDATA%라 즉시 읽힘.
  const shared = candidate(SHARED_FILE);
  const legacy = candidate(LEGACY_FILE);
  const cands = [];
  if (shared && !shared.unreadable) cands.push({ ...shared, from: 'shared' });
  if (legacy && !legacy.unreadable) cands.push({ ...legacy, from: 'legacy' });

  // 파일은 있는데 읽지 못했다 = 설정이 없는 게 아니라 뭔가 잘못된 것.
  // 절대 기본값으로 덮어쓰지 않는다(예전에 이렇게 downstreamServers가 날아갔다).
  if (shared && shared.unreadable) quarantine(SHARED_FILE);

  // 가장 최근(_updatedAt/mtime 최대)이 이김 = 마지막으로 편집된 설정 반영.
  let winner = null;
  for (const c of cands) if (!winner || c.ts > winner.ts) winner = c;

  let sharedBase = {};
  let sharedTs = Date.now();
  let migratedLegacy = false;

  let scrubbedSecrets = false;
  if (winner) {
    const { shared: sh, local } = splitLocal(winner.obj);
    sharedBase = sh;
    sharedTs = winner.ts;
    // 공유 파일에 다운스트림 시크릿(headers/env)이 섞여 있었다면 지금 걷어냈다 —
    // 아래에서 정리본을 강제로 다시 써서 Drive로도 정리본이 나가게 한다.
    scrubbedSecrets = Boolean(local.downstreamServers && Object.keys(local.downstreamServers).length);
    // 공유/레거시 파일에 섞여 있던 기기전용 값은 local 파일에 없을 때만 채움.
    for (const p of localOnlyPathsFor(local)) {
      if (hasByPath(local, p) && !hasByPath(localObj, p)) {
        setByPath(localObj, p, getByPath(local, p));
      }
    }
    if (winner.from === 'legacy') migratedLegacy = true;
  }

  let effective = deepMerge(DEFAULTS, sharedBase);
  effective = deepMerge(effective, pickLocalOnly(localObj));

  // 공유 쪽에서 사라진 서버의 로컬 시크릿이 type 없는 부분 항목으로 되살아나지 않게.
  for (const [name, spec] of Object.entries(effective.downstreamServers || {})) {
    if (!spec || typeof spec !== 'object' || !spec.type) delete effective.downstreamServers[name];
  }

  // 인증 토큰은 기기 전용. 없으면 생성해서 local 파일에만 저장.
  if (!getByPath(effective, 'hub.authToken')) {
    const tok = crypto.randomBytes(24).toString('hex');
    setByPath(effective, 'hub.authToken', tok);
    setByPath(localObj, 'hub.authToken', tok);
  }
  writeLocal(pickLocalOnly(localObj), existingLocal);

  // 채택한 공유본을 권위 파일에 반영(share.js가 여기서부터 공유 폴더로 미러링).
  // 후보가 하나도 없으면(새 설치) 파일을 만들지 않는다 — 기본값 파일을 지금 만들면
  // mtime이 공유 폴더의 기존 설정보다 최신이라, share.js(mtime 기준 last-write-wins)가
  // 기본값을 공유 폴더로 밀어내 다른 컴퓨터의 설정을 지운다. 첫 save() 때 생기면 된다.
  // (읽기 실패 케이스도 winner가 없으므로 자연히 덮어쓰지 않는다.)
  const sharedStamped = { ...sharedBase, _updatedAt: sharedTs };
  if (winner && (scrubbedSecrets || !shared || shared.unreadable || shared.ts !== sharedTs)) {
    writeShared(sharedStamped);
  }

  if (migratedLegacy) {
    // 레거시 파일이 다시 마이그레이션 후보로 잡히지 않도록 치워둠.
    try {
      fs.renameSync(LEGACY_FILE, `${LEGACY_FILE}.migrated`);
    } catch {
      /* 이동 실패해도 치명적이지 않음 */
    }
  }

  delete effective._updatedAt;
  deviceBaselines.set(effective, splitLocal(effective).local);
  cache = effective;
  return cache;
}

/**
 * 디스크의 hub.authToken을 한 번 다시 읽어 캐시에 반영한다.
 * **인증에 실패한 직후에만** 부를 것 — 정상 경로에 파일 I/O를 얹지 않기 위해서다.
 *
 * 왜 필요한가: load()는 프로세스 수명 동안 cache를 돌려준다(위 300줄). 허브가 뜬 뒤에
 * 토큰이 바뀌면(재등록, 또는 허브 시작 시점에 토큰이 아직 확정되지 않았던 경우)
 * 실행 중인 허브는 영원히 옛 값과 비교해서, config.local.json에 적힌 올바른 토큰까지
 * 401로 거절했다(2026-07-27). 오류 메시지는 "invalid bearer token" 하나뿐이라
 * 클라이언트 문제로 보이고, 허브를 재시작해야만 풀렸다.
 *
 * 읽기 실패는 "토큰 없음"이 아니다(AGENTS.md 규칙 6) — 캐시를 건드리지 않고 null을
 * 돌려주므로 호출자는 원래대로 거절한다. 못 읽었다고 인증을 열어주지 않는다.
 *
 * @returns {string|null} 디스크의 토큰. 파일을 읽지 못했거나 비어 있으면 null.
 */
function refreshAuthToken() {
  const localObj = readJSON(LOCAL_FILE);
  if (!localObj) return null; // 파일이 없거나 읽지 못함 — 기존 값을 유지한다
  const tok = getByPath(localObj, 'hub.authToken');
  if (typeof tok !== 'string' || !tok) return null;
  localFileExpected = true;
  // cache는 load()가 돌려준 바로 그 객체다. 제자리에서 고쳐야 이미 cfg를 들고 있는
  // 쪽(registrar, electron/main.js의 상태 표시)도 새 토큰을 본다.
  if (cache) setByPath(cache, 'hub.authToken', tok);
  if (cache) setByPath(deviceBaselines.get(cache), 'hub.authToken', tok);
  return tok;
}

function save(cfg, explicit, expected, mode) {
  const { shared, local } = splitLocal(cfg);
  const existingLocal = readLocalForWrite();
  if (expected !== undefined && !isDeepStrictEqual(expected, existingLocal)) throw deviceConflict();
  const mergedLocal = structuredClone(existingLocal || {});
  // 디스크가 권위다. update는 명시된 경로만, 전체 cfg를 수정하는 기존 호출자는
  // 마지막에 돌려준 값과 달라진 경로만 쓴다. 다른 프로세스의 토큰 회전을 보존한다.
  const baseline = deviceBaselines.get(cfg) || deviceBaselines.get(cache);
  const paths = new Set([...localOnlyPathsFor(baseline), ...localOnlyPathsFor(local)]);
  for (const p of paths) {
    const specified = explicit && hasByPath(explicit, p);
    const next = getByPath(local, p);
    if (explicit ? !specified : isDeepStrictEqual(next, getByPath(baseline, p))) continue;
    if (next === undefined) {
      if (p.startsWith('downstreamServers.')) deleteByPath(mergedLocal, p);
    } else if (specified && next && typeof next === 'object' && !Array.isArray(next)) {
      setByPath(mergedLocal, p, deepMerge(getByPath(mergedLocal, p) || {}, getByPath(explicit, p)));
    } else {
      setByPath(mergedLocal, p, next);
    }
  }
  for (const [name, fields] of Object.entries(mergedLocal.downstreamServers || {})) {
    if (!Object.keys(fields).length) delete mergedLocal.downstreamServers[name];
  }
  if (!Object.keys(mergedLocal.downstreamServers || {}).length) delete mergedLocal.downstreamServers;
  writeLocal(mergedLocal, existingLocal, mode);
  // 공유 설정에 수정 시각 기록(가장 최근 편집이 이기도록).
  // A device-only gesture must not mutate the shared generation or fail after its local commit.
  if (!explicit || !isDeepStrictEqual(explicit,splitLocal(explicit).local)) {
    writeShared({ ...shared, _updatedAt: Date.now() });
  } else {
    try { fs.statSync(SHARED_FILE); }
    catch (err) {
      if (err.code!=='ENOENT') throw Object.assign(new Error('공유 설정 파일 접근을 확인하세요.'),{code:'HUB_SHARED_CONFIG_WRITE'});
      writeShared({ ...shared, _updatedAt: Date.now() }, {createOnly:true});
    }
  }
  const effective = deepMerge(deepMerge(DEFAULTS, shared), pickLocalOnly(mergedLocal));
  for (const [name, spec] of Object.entries(effective.downstreamServers || {})) {
    if (!spec?.type) delete effective.downstreamServers[name];
  }
  deviceBaselines.set(cfg, local);
  deviceBaselines.set(effective, splitLocal(effective).local);
  delete effective._updatedAt;
  cache = effective;
  return cache;
}

function update(partial) {
  const cfg = deepMerge(load(), partial);
  return save(cfg, partial);
}

// A change by another writer ends this user gesture. Never replay a stale edit after the wait.
async function updateWithRetry(partial) {
  const changes = structuredClone(partial);
  let expected;
  const delays = [40, 120, 350];
  for (let attempt = 0; ; attempt++) {
    try { return save(deepMerge(load(), changes), changes, expected, {deferNative:true}); }
    catch (error) {
      if (!deviceRetries.has(error)) throw error;
      const plan = deviceRetries.get(error);
      expected = plan.previous;
      if (attempt >= delays.length) {
        if (error.reason !== 'replace_denied') throw error;
        const guard = deviceFile.claim(LOCAL_FILE);
        const tmp = path.join(guard.lock,guard.token+'.tmp');
        try {
          const digest=currentDigest(expected);
          fs.writeFileSync(tmp,'\uFEFF'+JSON.stringify(plan.obj,null,2),{flag:'wx',mode:0o600});
          const operation = deviceFile.prepare(LOCAL_FILE,tmp,digest,guard);
          saveMetrics.count('nativeEntries');
          await deviceFile.replaceAsync(operation);
          saveMetrics.count('physicalWrites');
        } finally {
          try { fs.unlinkSync(tmp); } catch (err) { if(err.code!=='ENOENT') throw err; } finally { guard.release(); }
        }
        return save(deepMerge(load(),changes),changes,plan.obj,{deferNative:true});
      }
      saveMetrics.count('requestRetries');
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}

/**
 * 기기 전용 경로 하나를 **교체**한다(병합 아님 — 덮어쓰기 항목을 지울 수 있어야 한다).
 * 공유 파일과 _updatedAt은 건드리지 않는다: 이 PC만의 값을 바꿨다고 공유 설정이
 * 최신본으로 둔갑해 다른 컴퓨터의 편집을 이기면 안 된다(share.js last-write-wins).
 * 기기 파일을 읽지 못하면 쓰지 않는다 — 토큰이 든 파일을 빈 객체로 덮으면 안 된다.
 */
function setLocalOnly(dotted, value) {
  if (!LOCAL_ONLY_PATHS.includes(dotted)) throw new Error(`기기 전용 설정 경로가 아닙니다: ${dotted}`);
  const effective = load();
  const existingLocal = readLocalForWrite();
  const next = structuredClone(existingLocal || {});
  setByPath(next, dotted, JSON.parse(JSON.stringify(value)));
  writeLocal(next, existingLocal);
  setByPath(effective, dotted, JSON.parse(JSON.stringify(value)));
  setByPath(deviceBaselines.get(effective), dotted, structuredClone(value));
  return effective;
}

/** 캐시 무효화(공유 동기화로 파일이 바뀐 뒤 다시 읽고 싶을 때). */
function reload() {
  cache = null;
  return load();
}

module.exports = {
  load,
  save: saveMetrics.track(save),
  update: saveMetrics.track(update),
  updateWithRetry: saveMetrics.track(updateWithRetry),
  setLocalOnly: saveMetrics.track(setLocalOnly),
  saveMetrics: saveMetrics.summary,
  reload,
  refreshAuthToken,
  DEFAULTS,
  DOWNSTREAM_LOCAL_FIELDS,
  LOCAL_ONLY_PATHS,
  // 경로 정보(진단/설정 화면용).
  CONFIG_FILE: SHARED_FILE, // 하위 호환: 공유 설정 파일 경로.
  SHARED_FILE,
  LOCAL_FILE,
  LEGACY_FILE,
};

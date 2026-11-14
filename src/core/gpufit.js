// 로드된 모델이 이 컴퓨터 GPU에 실제로 들어가는지 재고, 안 들어가면 자리를 만든다.
//
// 왜 필요한가 (2026-07-30 실측): RTX 5060 Laptop 8GB(8151MiB)에 qwen2.5-coder-14b
// (8.99GB)와 gemma-4-12b-qat(6.66GB)가 함께 로드돼 있었다. LM Studio는 이걸 거부하지
// 않는다 — 컨텍스트를 32768에서 4352로 조용히 깎고 남은 레이어를 CPU로 넘긴다.
// 그래서 하나의 원인이 서로 무관해 보이는 증상 둘로 갈라진다:
//   (1) 2.4 tok/s — "로컬 모델은 원래 느리다"로 오해된다
//   (2) 소스 파일 하나도 안 들어가는 컨텍스트 — "모델 한계"로 오해된다
// 어느 쪽도 오류를 내지 않으므로 로그를 봐서는 알 수 없고 밖에서 재야 한다.
// (gemma를 내리자 같은 태스크가 2.4 → 4.5 tok/s. qwen은 혼자서도 VRAM을 넘겨서
//  절반만 회복됐다 — 그건 언로드로 못 고치고 더 작은 모델이라야 한다.)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const consoleText = require('./console-text');

const HOME = os.homedir();

// 외부 프로세스는 타임아웃 + 회로 차단 뒤에서만 부른다(AGENTS.md 규칙 9).
const EXEC_TIMEOUT_MS = 10000;
const BREAKER_TRIP_AFTER = 3;
const BREAKER_RESET_MS = 10 * 60 * 1000;

// 디스플레이·컴포지터가 먼저 쓰는 몫. 노트북 GPU는 화면도 같이 그리므로 VRAM
// 전체를 모델에 줄 수 없다. 이만큼은 계산에서 빼 둔다.
const DISPLAY_RESERVE_MIB = 640;

// 측정 결과 유효 기간. 라우팅 같은 뜨거운 경로는 이 캐시만 읽고 절대 프로세스를
// 띄우지 않는다 — 위임 한 번에 8초짜리 spawn이 붙으면 고치려는 문제보다 나쁘다.
const PROBE_TTL_MS = 60 * 1000;

const MIB = 1024 * 1024;

// ---- 외부 도구 감지 --------------------------------------------------------
// 경로를 설정에 저장하지 않는다. 컴퓨터마다 다르므로 쓸 때마다 찾는다(규칙 8).
const TOOLS = {
  lms: {
    names: ['lms.exe', 'lms'],
    candidates: [path.join(HOME, '.lmstudio', 'bin', 'lms.exe'), path.join(HOME, '.lmstudio', 'bin', 'lms')],
  },
  'nvidia-smi': {
    names: ['nvidia-smi.exe', 'nvidia-smi'],
    candidates: [
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
    ],
  },
};

const breakers = new Map(); // tool -> { fails, until }

function breakerOpen(tool) {
  const b = breakers.get(tool);
  return Boolean(b && b.until && Date.now() < b.until);
}

function noteFailure(tool) {
  const b = breakers.get(tool) || { fails: 0, until: 0 };
  b.fails += 1;
  if (b.fails >= BREAKER_TRIP_AFTER) {
    b.until = Date.now() + BREAKER_RESET_MS;
    b.fails = 0;
  }
  breakers.set(tool, b);
}

function noteSuccess(tool) {
  breakers.delete(tool);
}

/** 실행 파일 이름 후보. 알려진 설치 위치를 먼저 보고, 없으면 PATH에 맡긴다. */
function commandFor(tool) {
  const spec = TOOLS[tool];
  for (const c of spec.candidates) {
    // 로컬 디스크 경로만 본다 — 동기 검사를 동기화 폴더에 쓰면 안 된다(규칙 1).
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* 접근 불가는 후보에서 뺀다 */ }
  }
  return spec.names[0];
}

function runTool(tool, args) {
  if (breakerOpen(tool)) return Promise.resolve(null);
  return new Promise((resolve) => {
    // 버퍼로 받아 콘솔 인코딩으로 읽는다 — lms가 한글로 내는 오류가 섞여도
    // 깨지지 않게(console-text.js). 정상 경로의 JSON은 ASCII라 영향이 없다.
    execFile(commandFor(tool), args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true, ...consoleText.RAW_OUTPUT }, (err, stdout) => {
      if (err) {
        noteFailure(tool);
        resolve(null);
        return;
      }
      noteSuccess(tool);
      resolve(consoleText.decode(stdout));
    });
  });
}

// ---- 측정 ------------------------------------------------------------------

/** @returns {Promise<{totalMiB:number, usedMiB:number}|null>} 못 재면 null */
async function readVram() {
  const out = await runTool('nvidia-smi', ['--query-gpu=memory.total,memory.used', '--format=csv,noheader,nounits']);
  if (!out) return null;
  // 여러 GPU면 첫 줄(주 GPU)만 본다. 모델을 GPU에 쪼개 올리는 구성은 다루지 않는다.
  const line = out.trim().split('\n')[0] || '';
  const [total, used] = line.split(',').map((s) => parseInt(s.trim(), 10));
  if (!Number.isFinite(total) || total <= 0) return null;
  return { totalMiB: total, usedMiB: Number.isFinite(used) ? used : 0 };
}

/**
 * 지금 로드된 모델과 **런타임 실측 크기**. `lms ps --json`의 sizeBytes는 파일
 * 크기가 아니라 실제로 잡은 양이라, 디스크의 gguf를 재는 것보다 정확하다.
 * @returns {Promise<Array<{id:string,sizeMiB:number,contextLength:number,maxContextLength:number,idle:boolean}>|null>}
 */
const IDLE_STATUSES = new Set(['idle', 'loaded']);

async function readLoaded() {
  const out = await runTool('lms', ['ps', '--json']);
  if (out === null) return null;
  let rows;
  try {
    rows = JSON.parse(out.trim() || '[]');
  } catch {
    return null; // 파싱 실패는 "로드된 게 없음"이 아니다(규칙 6)
  }
  if (!Array.isArray(rows)) return null;
  return rows
    .filter((r) => r && r.type !== 'embedding' && r.type !== 'embeddings')
    .map((r) => ({
      id: String(r.identifier || r.modelKey || ''),
      sizeMiB: Math.round(Number(r.sizeBytes || 0) / MIB),
      contextLength: Number(r.contextLength || 0) || 0,
      maxContextLength: Number(r.maxContextLength || 0) || 0,
      // `lms ps` 상태는 idle·processingPrompt·generating이다 — 'busy'는 오지 않는다(2026-10-22 실측).
      // 확실히 노는 것만 내린다: 모르는 상태를 노는 걸로 보면 생성 중인 모델을 내려 Hub 밖의 요청까지 끊는다.
      idle: IDLE_STATUSES.has(String(r.status || '').toLowerCase()),
    }))
    .filter((r) => r.id);
}

let cache = null; // { at, vram, loaded }

/** 실측값을 새로 받아 캐시한다. 도구가 없으면 그 항목만 null로 남는다. */
async function probe(force) {
  if (!force && cache && Date.now() - cache.at < PROBE_TTL_MS) return cache;
  const [vram, loaded] = await Promise.all([readVram(), readLoaded()]);
  cache = { at: Date.now(), vram, loaded };
  return cache;
}

// ---- 판정 ------------------------------------------------------------------

/**
 * 이 컴퓨터에서 지금 상태가 어떤가.
 *
 * verdict:
 *   unknown   — 못 쟀다(nvidia-smi/lms 없음, 비-NVIDIA GPU). 아무것도 하지 않는다.
 *   ok        — 로드된 모델 전부가 GPU에 들어간다.
 *   crowded   — 넘치는데 **내릴 게 있다** → 내리면 나아진다. 조치 대상.
 *   oversized — 넘치는데 내릴 게 없다(쓰는 모델 하나뿐) → 더 작은 모델이라야 한다.
 *
 * ⚠ "쓸 모델이 혼자서도 넘으니 내려도 소용없다"로 판정하면 안 된다. 실측(2026-07-30):
 * qwen(8.99GB)은 8GB GPU에 혼자서도 안 들어가는데, 옆의 gemma를 내리자 같은 태스크가
 * 2.4 → 4.5 tok/s가 됐다. GPU에 올라가는 레이어 수는 연속적이라 **완전히 못 고쳐도
 * 부분 회복이 크다.** 그러니 기준은 "keep이 들어가는가"가 아니라 "내릴 게 있는가"다.
 *
 * @param {{keep?:string}} [p] keep은 지금 쓰려는(또는 마지막으로 쓴) 모델 id
 */
function judge(snapshot, p = {}) {
  const { vram, loaded } = snapshot;
  if (!vram || !loaded) {
    return { verdict: 'unknown', usableMiB: null, loadedMiB: null, models: loaded || [], evictable: [], message: '' };
  }
  const usableMiB = Math.max(0, vram.totalMiB - DISPLAY_RESERVE_MIB);
  const loadedMiB = loaded.reduce((n, m) => n + m.sizeMiB, 0);
  // 남길 모델: 방금 라우팅된 것. 알 수 없으면 가장 큰 것을 쓰는 중이라고 본다.
  const keep = (p.keep && loaded.find((m) => m.id === p.keep))
    || loaded.slice().sort((a, b) => b.sizeMiB - a.sizeMiB)[0]
    || null;
  const evictable = loaded.filter((m) => m.idle && (!keep || m.id !== keep.id));

  if (loadedMiB <= usableMiB) {
    return { verdict: 'ok', usableMiB, loadedMiB, models: loaded, evictable: [], message: '' };
  }

  const shrunk = keep && keep.maxContextLength && keep.contextLength && keep.contextLength < keep.maxContextLength;
  const ctxNote = shrunk ? `${keep.id}의 컨텍스트가 ${keep.maxContextLength} → ${keep.contextLength}로 깎였습니다. ` : '';

  if (!evictable.length) {
    return {
      verdict: 'oversized',
      usableMiB,
      loadedMiB,
      models: loaded,
      evictable,
      message:
        `로드된 ${gb(loadedMiB)}가 이 GPU에 쓸 수 있는 ${gb(usableMiB)}를 넘습니다. ${ctxNote}` +
        '일부가 CPU에서 돌아 느립니다. 내릴 수 있는 다른 모델이 없으니 더 작은 모델(7~8B)이 필요합니다.',
    };
  }

  const afterMiB = loadedMiB - evictable.reduce((n, m) => n + m.sizeMiB, 0);
  return {
    verdict: 'crowded',
    usableMiB,
    loadedMiB,
    models: loaded,
    evictable,
    message:
      `모델 ${loaded.length}개가 합쳐 ${gb(loadedMiB)}로 쓸 수 있는 ${gb(usableMiB)}를 넘습니다. ${ctxNote}` +
      `놀고 있는 ${evictable.map((m) => m.id).join(', ')}를 내리면 ${gb(afterMiB)}가 됩니다` +
      (afterMiB <= usableMiB ? '.' : ' — 그래도 넘치지만 CPU로 넘어가는 몫이 줄어 빨라집니다.'),
  };
}

function gb(mib) {
  return (mib / 1024).toFixed(1) + 'GB';
}

/** 재고 판정까지. 뜨거운 경로에서 부르지 말 것(프로세스를 띄운다). */
async function assess(p = {}) {
  return judge(await probe(p.force), p);
}

// ---- 조치 ------------------------------------------------------------------

// 자동 언로드가 반복되면 사용자가 방금 올린 모델과 싸우게 된다. 이 간격에 한 번까지.
const EVICT_COOLDOWN_MS = 10 * 60 * 1000;
let lastEvictAt = 0;

/**
 * 자리를 만든다. `crowded`일 때 **놀고 있는** 다른 모델만 내린다.
 *
 * 내려도 안전한 이유: LM Studio는 요청이 오면 그때 다시 로드한다(JIT). 즉 이 조치는
 * 되돌릴 수 있고, 잃는 건 다음 사용 때의 로딩 시간뿐이다. 반대로 `oversized`에는
 * 아무것도 하지 않는다 — 내릴 게 없고, 내려 봐야 안 고쳐진다.
 *
 * @param {{keep?:string, dryRun?:boolean}} p
 */
async function makeRoom(p = {}) {
  const a = await assess({ keep: p.keep, force: true });
  if (a.verdict !== 'crowded' || !a.evictable.length) return { acted: false, verdict: a.verdict, unloaded: [], assessment: a };
  if (!p.dryRun && Date.now() - lastEvictAt < EVICT_COOLDOWN_MS) {
    return { acted: false, verdict: a.verdict, unloaded: [], cooldown: true, assessment: a };
  }
  // 큰 것부터 내린다 — 같은 회복량을 더 적은 언로드로 얻는다(내린 만큼 다음 사용 때
  // 콜드 로드 비용이 생기므로 필요 이상으로 내리지 않는다).
  const unloaded = [];
  let remainingMiB = a.loadedMiB;
  for (const m of a.evictable.slice().sort((x, y) => y.sizeMiB - x.sizeMiB)) {
    if (remainingMiB <= a.usableMiB) break;
    if (p.dryRun || (await runTool('lms', ['unload', m.id])) !== null) {
      unloaded.push(m.id);
      remainingMiB -= m.sizeMiB;
    }
  }
  if (unloaded.length && !p.dryRun) {
    lastEvictAt = Date.now();
    cache = null; // 방금 바꿨으니 캐시된 스냅숏은 못 믿는다
  }
  return { acted: unloaded.length > 0, verdict: a.verdict, unloaded, assessment: a };
}

/**
 * ComfyUI처럼 LM Studio 밖에서 GPU를 쓰는 런타임에 자리를 넘긴다. 그쪽 사용량은 `lms ps`에
 * 안 잡혀 judge()가 넘침을 못 보므로 판정 없이 **놀고 있는** 모델을 전부 내린다. 쿨다운은
 * 주기 점검이 사용자가 올린 모델과 싸우지 않게 하는 장치라 사용자가 시작한 이 경로엔 걸지 않는다.
 * 필요량(needMiB)을 알고 지금 남은 VRAM에 이미 들어가면 아무것도 내리지 않는다 — 큰 GPU에서
 * 콜드 로드를 늘리지 않게. 모르거나 VRAM을 못 재면 넘침을 막을 방법이 없으니 전부 내린다.
 * keep은 곧 쓸 모델 id(기다리는 작업의 lastRouted) — 놀고 있어도 남긴다. 내렸다간 그 작업이 콜드 로드부터 한다.
 */
async function unloadIdle({ needMiB, keep } = {}) {
  if (Number.isFinite(needMiB) && needMiB > 0) {
    const vram = await readVram();
    if (vram && vram.totalMiB - vram.usedMiB - DISPLAY_RESERVE_MIB >= needMiB) return { acted: false, unloaded: [], fits: true };
  }
  const loaded = await readLoaded();
  if (!loaded) return { acted: false, unloaded: [], unknown: true };
  const unloaded = [];
  for (const m of loaded.filter((x) => x.idle && x.id !== keep)) {
    if ((await runTool('lms', ['unload', m.id])) !== null) unloaded.push(m.id);
  }
  if (unloaded.length) cache = null;
  return { acted: unloaded.length > 0, unloaded };
}

// ---- 뜨거운 경로용 (캐시만 읽는다) -----------------------------------------

// 주기 점검이 "무엇을 남겨야 하는지" 알아야 엉뚱한 걸 내리지 않는다. 위임이
// 모델을 고를 때마다 여기 적어 두면 점검은 파일을 읽지 않고도 안다.
let routedModel = null;

function noteRouted(modelId) {
  if (typeof modelId === 'string' && modelId) routedModel = modelId;
}

function lastRouted() {
  return routedModel;
}

/**
 * 이 모델이 GPU에 들어가는가. **측정한 적 없으면 null** — 모른다는 뜻이고,
 * 호출자는 모른다고 순위를 바꾸면 안 된다. 절대 I/O를 하지 않는다.
 * @returns {boolean|null}
 */
function fitsCached(modelId) {
  if (!cache || !cache.vram || !cache.loaded) return null;
  const m = cache.loaded.find((x) => x.id === modelId);
  if (!m) return null; // 로드된 적 없으면 크기를 모른다
  return m.sizeMiB <= Math.max(0, cache.vram.totalMiB - DISPLAY_RESERVE_MIB);
}

/** 마지막 측정 요약. 대시보드 status에 그대로 실린다. */
function lastAssessment(keep) {
  if (!cache) return { verdict: 'unknown', message: '' };
  const a = judge(cache, { keep });
  return {
    verdict: a.verdict,
    message: a.message,
    usableMiB: a.usableMiB,
    loadedMiB: a.loadedMiB,
    models: a.models.map((m) => ({ id: m.id, sizeMiB: m.sizeMiB, contextLength: m.contextLength, maxContextLength: m.maxContextLength })),
  };
}

module.exports = {
  probe, assess, judge, makeRoom, unloadIdle, fitsCached, lastAssessment, noteRouted, lastRouted,
  DISPLAY_RESERVE_MIB, PROBE_TTL_MS, EVICT_COOLDOWN_MS,
  _internals: { readVram, readLoaded, commandFor },
};

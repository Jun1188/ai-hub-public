#!/usr/bin/env node
// gpufit의 판정 로직 회귀 테스트. 외부 프로세스(nvidia-smi·lms)를 부르지 않으므로
// GPU가 없는 컴퓨터·CI에서도 돌아간다 — 스냅숏을 직접 만들어 judge()에 넣는다.
'use strict';

const gpufit = require('../src/core/gpufit');
const delegator = require('../src/core/delegator');

let failed = 0;
function check(name, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failed++;
}

// 실제로 관측된 구성(2026-07-30, RTX 5060 Laptop 8151MiB)
const VRAM_8G = { totalMiB: 8151, usedMiB: 7783 };
const QWEN = { id: 'qwen/qwen2.5-coder-14b', sizeMiB: 8571, contextLength: 4352, maxContextLength: 32768, idle: true };
const GEMMA = { id: 'google/gemma-4-12b-qat', sizeMiB: 6820, contextLength: 8192, maxContextLength: 262144, idle: true };
const SMALL = { id: 'qwen/qwen2.5-coder-7b', sizeMiB: 4700, contextLength: 32768, maxContextLength: 32768, idle: true };

console.log('=== 못 쟀을 때는 아무 판단도 하지 않는다 ===');
check('nvidia-smi 실패 → unknown', gpufit.judge({ vram: null, loaded: [QWEN] }).verdict === 'unknown');
check('lms 실패 → unknown', gpufit.judge({ vram: VRAM_8G, loaded: null }).verdict === 'unknown');
// 읽기 실패를 "빈 목록"으로 오해하면 안 된다(AGENTS.md 규칙 6): 빈 배열은 진짜 없는 것.
check('로드된 모델 없음(빈 배열)은 ok', gpufit.judge({ vram: VRAM_8G, loaded: [] }).verdict === 'ok');

console.log('');
console.log('=== 들어가면 건드리지 않는다 ===');
{
  const a = gpufit.judge({ vram: VRAM_8G, loaded: [SMALL] });
  check('7B 하나 → ok', a.verdict === 'ok');
  check('ok면 내릴 대상이 없다', a.evictable.length === 0);
}

console.log('');
console.log('=== 겹쳐서 넘치면 놀고 있는 쪽을 내린다 ===');
{
  const a = gpufit.judge({ vram: VRAM_8G, loaded: [QWEN, GEMMA] }, { keep: QWEN.id });
  check('두 개 겹침 → crowded', a.verdict === 'crowded');
  check('keep은 내리지 않는다', !a.evictable.some((m) => m.id === QWEN.id));
  check('놀고 있는 gemma가 대상', a.evictable.some((m) => m.id === GEMMA.id));
  // keep이 혼자서도 안 들어가도 crowded여야 한다 — 실측에서 gemma를 내리자
  // 2.4 → 4.5 tok/s였다. "어차피 안 들어간다"고 포기하면 이 회복을 놓친다.
  check('keep이 혼자서도 넘쳐도 crowded (부분 회복이 크다)', QWEN.sizeMiB > a.usableMiB && a.verdict === 'crowded');
  check('메시지가 부분 회복임을 밝힌다', /그래도 넘치지만/.test(a.message));
  check('깎인 컨텍스트를 알린다', /4352/.test(a.message));
}

console.log('');
console.log('=== 바쁜 모델은 내리지 않는다 ===');
{
  const busy = { ...GEMMA, idle: false };
  const a = gpufit.judge({ vram: VRAM_8G, loaded: [QWEN, busy] }, { keep: QWEN.id });
  check('생성 중인 모델은 대상에서 빠진다', !a.evictable.some((m) => m.id === busy.id));
  check('내릴 게 없으면 oversized', a.verdict === 'oversized');
}

console.log('');
console.log('=== 혼자 넘치면 진단만 한다 ===');
{
  const a = gpufit.judge({ vram: VRAM_8G, loaded: [QWEN] }, { keep: QWEN.id });
  check('14B 하나 → oversized', a.verdict === 'oversized');
  check('내릴 대상이 없다', a.evictable.length === 0);
  check('더 작은 모델이 필요하다고 말한다', /더 작은 모델/.test(a.message));
}

console.log('');
console.log('=== keep을 모르면 가장 큰 것을 쓰는 중이라고 본다 ===');
{
  const a = gpufit.judge({ vram: VRAM_8G, loaded: [GEMMA, QWEN] });
  check('가장 큰 qwen을 남긴다', !a.evictable.some((m) => m.id === QWEN.id));
}

console.log('');
console.log('=== 라우팅은 측정 전에는 순위를 바꾸지 않는다 ===');
check('측정 전 fitsCached는 null', gpufit.fitsCached('qwen/qwen2.5-coder-14b') === null);
check('모르는 모델도 null', gpufit.fitsCached('nonexistent/model') === null);
check('noteRouted가 기록된다', (gpufit.noteRouted('a/b'), gpufit.lastRouted() === 'a/b'));
check('빈 값은 무시한다', (gpufit.noteRouted(''), gpufit.lastRouted() === 'a/b'));

console.log('');
console.log('=== 예산 상수 ===');
check('디스플레이 몫을 빼 둔다', gpufit.DISPLAY_RESERVE_MIB > 0);
{
  const a = gpufit.judge({ vram: VRAM_8G, loaded: [SMALL] });
  check('usable = total - reserve', a.usableMiB === VRAM_8G.totalMiB - gpufit.DISPLAY_RESERVE_MIB);
}

console.log('');
console.log('=== delegator가 gpufit을 순위에 쓴다 ===');
// 소스 지문: 정렬에서 fit이 loaded 바로 뒤여야 한다. 앞에 두면 안 떠 있는 모델을
// 골라 콜드 로드(수십 초)를 유발하고, 뒤로 밀면 tier가 같은 두 모델 중 CPU로 흘러넘친
// 쪽을 계속 고른다.
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'core', 'delegator.js'), 'utf8');
  check('routeModel 정렬에 fit이 있다', /b\.loaded - a\.loaded \|\|\s*\n\s*b\.fit - a\.fit/.test(src));
  check('delegate가 라우팅 결과를 gpufit에 알린다', /gpufit\.noteRouted\(model\)/.test(src));
  check('fitScore는 모를 때 중립(0)', /fits === null \? 0/.test(src));
}
check('routeModel은 여전히 export된다', typeof delegator.routeModel === 'function');

console.log('');
console.log(failed === 0 ? '모든 검사 통과' : `${failed}개 실패`);
process.exit(failed === 0 ? 0 : 1);

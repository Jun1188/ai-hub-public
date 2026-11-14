// Quality check against a built UE source index.
// 인덱스 이름을 하드코딩하지 않는다 — 컴퓨터마다 이름·엔진 버전이 다르다.
// 클래스 정보가 있는 가장 큰 인덱스를 골라 쓰고, 없으면 안내 후 성공으로 끝낸다
// (인덱스는 GUI/CLI로 그 컴퓨터에서 만들어야 하는 선행 조건이지 코드 결함이 아니다).
'use strict';
const codeindex = require('../src/core/codeindex');

/**
 * 임베딩 호출이 남긴 keep-alive 소켓이 닫히는 중에 process.exit()을 때리면 Windows
 * libuv가 abort한다("!(handle->flags & UV_HANDLE_CLOSING)", exit 127) — 검사는 전부
 * 통과해 놓고 러너에는 실패로 잡힌다. 정리할 틈을 주고 나간다
 * (scripts/test-mcp-http.js 말미와 같은 이유).
 */
async function exitCleanly(code) {
  await new Promise((r) => setTimeout(r, 200));
  process.exit(code);
}

(async () => {
  const indexes = codeindex.listIndexes()
    .filter((i) => i.classCount > 0 && !i.indexing)
    .sort((a, b) => b.chunkCount - a.chunkCount);
  if (!indexes.length) {
    console.log('SKIP: 클래스 정보가 있는 소스 인덱스가 없습니다.');
    console.log('  먼저 GUI(소스 분석 탭)나 `node scripts/build-ue-index.js`로 UE 인덱스를 만드세요.');
    return exitCleanly(0);
  }
  // 아래 질의는 게임플레이 클래스를 색인했을 때만 의미가 있다. Math 폴더만 담은
  // 소형 인덱스도 classCount > 0 이라 위 필터를 통과하는데, 거기에 AActor를 물으면
  // 당연히 NOT FOUND다 — 크기가 아니라 **기준 클래스(AActor)를 담고 있는지**로 고른다.
  // 데이터 부재를 코드 결함처럼 보고하지 않기 위해서다.
  const usable = indexes
    .map((i) => ({ index: i, anchor: codeindex.classInfo(i.name, 'AActor').matches.find((m) => m.name === 'AActor') }))
    .filter((x) => x.anchor);
  if (!usable.length) {
    console.log(`SKIP: 인덱스 ${indexes.length}개 중 AActor를 담은 것이 없습니다 (가장 큰 것: '${indexes[0].name}', ${indexes[0].root}).`);
    console.log('  `node scripts/build-ue-index.js`로 엔진 소스를 색인하면 이 검사가 실제로 돕니다.');
    return exitCleanly(0);
  }
  const { index: chosen, anchor } = usable[0];
  const name = chosen.name;
  console.log(`index: ${name} (${chosen.chunkCount} chunks, ${chosen.classCount} classes)`);

  for (const q of [
    'how character movement replication works over network',
    'spawn actor deferred with custom transform',
    'gameplay tag container matching',
  ]) {
    const r = await codeindex.search(name, q, 3);
    console.log(`\nQ: ${q}`);
    for (const x of r) console.log(`  [${x.score}] ${x.file}:${x.startLine}${x.module ? ` (${x.module})` : ''}`);
  }
  console.log(`\nAActor: ${anchor.kind} @ ${anchor.file}:${anchor.line}, module=${anchor.module}, parents=[${anchor.parents}]`);
  console.log('AActor children (first 10):', codeindex.classInfo(name, 'AActor').children.slice(0, 10).join(', '));
  const c = codeindex.classInfo(name, 'UCharacterMovementComponent');
  const ce = c.matches.find((m) => m.name === 'UCharacterMovementComponent');
  console.log('UCharacterMovementComponent:', ce ? `parents=[${ce.parents}] @ ${ce.file}` : 'NOT FOUND');
  return exitCleanly(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });

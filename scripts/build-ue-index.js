// Builds the full UE Runtime index from the CLI (same engine the GUI uses).
//   node scripts/build-ue-index.js [소스루트] [인덱스이름]
// 인자를 생략하면 이 컴퓨터의 UE 설치를 자동 감지한다 — 경로를 하드코딩하면
// 다른 컴퓨터(설치 드라이브가 다름)에서 그대로 깨진다.
'use strict';
const path = require('path');
const codeindex = require('../src/core/codeindex');

(async () => {
  let root = process.argv[2];
  let name = process.argv[3];
  if (!root) {
    const detected = await codeindex.detectUnrealRoots();
    if (!detected.length) {
      console.error('✗ UE 설치를 찾지 못했습니다. 소스 루트를 인자로 지정하세요.');
      process.exit(1);
    }
    root = path.join(detected[0].path, 'Runtime');
    name = name || `${detected[0].label.toLowerCase().replace(/[^\w-]/g, '-')}-runtime`;
    console.log(`감지된 엔진 사용: ${detected[0].label} → ${root}`);
  }
  name = name || 'ue-runtime';
  let last = 0;
  const meta = await codeindex.buildIndex({ name, root, exts: ['.h'] }, (p) => {
    if (Date.now() - last > 15000 || p.phase === 'done') {
      last = Date.now();
      console.log(`[${p.phase}] files=${p.files} chunks=${p.chunks} embedded=${p.embedded}/${p.total}`);
    }
  });
  console.log('DONE:', JSON.stringify({ chunks: meta.chunkCount, classes: meta.classCount }));
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });

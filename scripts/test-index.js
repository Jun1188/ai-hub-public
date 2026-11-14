// Smoke test: index a small UE subtree, then search and class lookup.
'use strict';
const fs = require('fs');
const path = require('path');
const codeindex = require('../src/core/codeindex');

// 엔진 경로를 하드코딩하지 않는다(규칙 8) — UE_5.7을 박아 둔 탓에 UE_5.8만 있는 PC에서 "Root not found"로 실패했다(2026-10-22).
function defaultRoot() {
  const base = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Epic Games');
  let versions = [];
  try { versions = fs.readdirSync(base).filter((d) => /^UE_\d+\.\d+$/.test(d)); } catch { return null; }
  versions.sort((a, b) => parseFloat(b.slice(3)) - parseFloat(a.slice(3)));
  for (const v of versions) {
    const dir = path.join(base, v, 'Engine', 'Source', 'Runtime', 'Core', 'Public', 'Math');
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

(async () => {
  const root = process.argv[2] || defaultRoot();
  if (!root) { console.log('UE 설치를 찾지 못해 건너뜀 (skipped)'); return; }
  const name = process.argv[3] || 'test-uemath';
  console.log('building index over:', root);
  const meta = await codeindex.buildIndex({ name, root, exts: ['.h'] }, (p) => {
    if (p.embedded % 512 === 0 || p.phase !== 'embedding') {
      process.stdout.write(`\r[${p.phase}] files=${p.files} chunks=${p.chunks} embedded=${p.embedded}/${p.total}   `);
    }
  });
  console.log('\nmeta:', JSON.stringify({ chunks: meta.chunkCount, classes: meta.classCount, dims: meta.dims }));

  const results = await codeindex.search(name, 'linear interpolation between two vectors', 3);
  console.log('\nSEARCH "lerp between two vectors":');
  for (const r of results) console.log(` [${r.score}] ${r.file}:${r.startLine}`);

  const info = codeindex.classInfo(name, 'FVector');
  console.log('\nCLASS FVector matches:', info.matches.length, info.matches[0] ? JSON.stringify(info.matches[0]) : '');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });

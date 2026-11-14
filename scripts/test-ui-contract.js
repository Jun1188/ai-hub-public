// 렌더러 계약 테스트.
//
// ui/ 는 번들러 없이 순수 <script> 태그를 순서대로 로드한다. 그래서 파일을 쪼갤 때
// 흔히 나는 사고가 정적으로 잡힌다:
//   · 새 파일을 index.html에 추가하는 걸 잊음 → 그 탭 버튼이 그냥 죽음
//   · 같은 전역 이름을 두 파일에서 선언 → 나중 스크립트가 SyntaxError로 통째로 중단
//   · $('없는-id') → 런타임에 null 참조
'use strict';

const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const uiDir = path.join(appRoot, 'ui');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function matchAll(text, pattern, group = 1, flags = 'g') {
  const out = [];
  const re = new RegExp(pattern, flags);
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[group]);
  return out;
}

/** ui/ 아래 모든 렌더러 스크립트를 ui 기준 상대경로(슬래시)로 모은다. */
function uiScripts() {
  const out = [];
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      // Pinned third-party distributions are loaded lazily and have their own provenance manifest.
      if (e.isDirectory() && e.name === 'vendor') continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (e.name.endsWith('.js')) out.push(rel);
    }
  };
  walk(uiDir, '');
  return out;
}

function main() {
  const html = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');
  const loaded = matchAll(html, '<script src="([^"]+)"');
  const files = uiScripts();

  console.log(`index.html이 로드하는 스크립트 ${loaded.length}개 / ui/ 실제 파일 ${files.length}개`);

  console.log('1) 스크립트 태그와 실제 파일이 맞는가');
  const missingFile = loaded.filter((s) => !fs.existsSync(path.join(uiDir, s)));
  check('없는 파일을 로드하지 않음', missingFile.length === 0, missingFile.join(', '));
  const notLoaded = files.filter((f) => !loaded.includes(f));
  check('로드되지 않는 파일 없음', notLoaded.length === 0, notLoaded.join(', '));

  console.log('2) 로드 순서');
  check('shell.js가 첫 번째', loaded[0] === 'shell.js', loaded[0]);
  check('boot.js가 마지막', loaded[loaded.length - 1] === 'boot.js', loaded[loaded.length - 1]);

  const sources = new Map(files.map((f) => [f, fs.readFileSync(path.join(uiDir, f), 'utf8')]));
  const allJs = [...sources.values()].join('\n');

  console.log('3) 전역 이름 중복 선언 (순수 스크립트라 중복이면 SyntaxError)');
  const declaredIn = new Map(); // name -> [file]
  for (const [file, text] of sources) {
    const names = [
      ...matchAll(text, '^(?:async\\s+)?function\\s+(\\w+)', 1, 'gm'),
      ...matchAll(text, '^(?:const|let)\\s+(\\w+)\\s*=', 1, 'gm'),
    ];
    for (const n of names) {
      if (!declaredIn.has(n)) declaredIn.set(n, []);
      declaredIn.get(n).push(file);
    }
  }
  const dupes = [...declaredIn.entries()].filter(([, fs_]) => fs_.length > 1);
  check('중복 선언 없음', dupes.length === 0,
    dupes.map(([n, f]) => `${n} (${f.join(', ')})`).join(' / '));

  console.log('4) 호출되는 refresh 함수가 정의돼 있는가');
  // 탭 전환(shell.js)과 초기화(boot.js)가 부르는 함수들이 실제로 있어야 한다.
  // `window.hub.x()` 같은 메서드 호출은 제외하려고 앞에 점이 없는 것만 고른다.
  const entryPoints = new Set([
    ...matchAll(sources.get('shell.js'), '(?<![.\\w])(refresh\\w+)\\('),
    ...matchAll(sources.get('boot.js'), '(?<![.\\w])(\\w+)\\('),
  ].filter((n) => !['setInterval', 'setTimeout', 'toast'].includes(n)));
  const undefinedEntries = [...entryPoints].filter((n) => !declaredIn.has(n));
  check('탭 전환·초기화가 부르는 함수 전부 존재', undefinedEntries.length === 0,
    undefinedEntries.join(', '));

  console.log('5) $(\'id\')가 존재하는 요소를 가리키는가');
  // 정적 HTML의 id + JS가 innerHTML로 만들어내는 id 둘 다 인정한다.
  const ids = new Set([
    ...matchAll(html, 'id="([^"]+)"'),
    ...matchAll(allJs, 'id="([^"$]+)"'),
    ...matchAll(allJs, String.raw`\.id\s*=\s*['"]([^'"]+)['"]`),
  ]);
  const referenced = new Set(matchAll(allJs, "\\$\\('([^']+)'\\)"));
  const unknownIds = [...referenced].filter((id) => !ids.has(id));
  check('없는 id를 참조하지 않음', unknownIds.length === 0, unknownIds.join(', '));

  console.log('6) 이름 규칙');
  check("제네릭한 bind() 잔재 없음", !/\bbind\(/.test(allJs));
  const vague = files.filter((f) => /\b(utils|helpers|common|misc)\b/.test(f));
  check('모호한 파일명 없음', vague.length === 0, vague.join(', '));

  console.log('');
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();

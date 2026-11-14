#!/usr/bin/env node
// 심층 분석(3계층) 회귀 테스트 (LM Studio 불필요 — 델리게이터를 스텁).
//
// 3계층은 외부 AI로 데이터가 **나가는** 층이다. 여기서 고정하는 안전 규칙:
//   - 기본은 좌표·구조만. 코드 발췌는 includeSource 옵트인일 때만.
//   - 전송 텍스트는 항상 scrub — 토큰·사용자 경로가 섞이면 안 된다.
//   - 분석은 텍스트뿐, 소스를 건드리는 경로가 없다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-deepdive-'));
process.env.APPDATA = SANDBOX;

const appRoot = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---- 픽스처: 심볼 맵 ----
const SRC = path.join(SANDBOX, 'Engine', 'Source');
function write(rel, text) {
  const p = path.join(SRC, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
}
write('Runtime/Engine/Classes/GameFramework/Actor.h', `
UCLASS()
class ENGINE_API AActor : public UObject
{
	GENERATED_BODY()
	// authToken: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef01 <- scrub 대상
};
`);
write('Runtime/Engine/Classes/GameFramework/Character.h', `
UCLASS()
class ENGINE_API ACharacter : public AActor
{
	GENERATED_BODY()
	void Jump(); // C:\\Users\\testuser\\secret 경로 언급
};
`);

const symbolmap = require('../src/core/symbolmap');
symbolmap.scan({ name: 'fx', root: SRC });

// ---- 스텁: 임베딩·델리게이터 (LM Studio 없이) ----
const embedderPath = require.resolve(path.join(appRoot, 'src', 'core', 'embedder.js'));
require(embedderPath);
require.cache[embedderPath].exports.embed = async (texts) =>
  texts.map(() => Float32Array.from({ length: 8 }, () => Math.random()));
require.cache[embedderPath].exports.model = () => 'stub-embed';

const delegatorPath = require.resolve(path.join(appRoot, 'src', 'core', 'delegator.js'));
require(delegatorPath);
let lastDelegate = null;
require.cache[delegatorPath].exports.delegate = async (p) => {
  lastDelegate = p;
  return { content: '분석 결과 [1]', model: 'stub-model' };
};

const deepdive = require('../src/core/deepdive');
const codeindex = require('../src/core/codeindex');

(async () => {
  console.log('1) 브리핑 — 기본은 좌표·구조만');
  {
    const b = await deepdive.briefing({ map: 'fx', topic: 'ACharacter' });
    check('심볼 좌표 포함', b.text.includes('Character.h'), b.text.slice(0, 200));
    check('상속 계층 포함', b.text.includes('조상: AActor'), b.text);
    check('코드 발췌 없음(옵트인 전)', !b.text.includes('```cpp') && b.meta.excerpts === 0);
    check('includeSource=false로 기록', b.meta.includeSource === false);
  }

  console.log('2) 발췌는 옵트인 + scrub');
  {
    await codeindex.buildIndex({ name: 'fx-idx', root: SRC, exts: ['.h'] });
    const b = await deepdive.briefing({ map: 'fx', topic: 'ACharacter', index: 'fx-idx', includeSource: true });
    check('옵트인하면 발췌 포함', b.meta.excerpts > 0 && b.text.includes('```cpp'), `excerpts=${b.meta.excerpts}`);
    check('토큰이 마스킹됨', !b.text.includes('deadbeefdeadbeef'), '');
    check('사용자 경로가 마스킹됨', !b.text.includes('testuser'), '');
    check('발췌 출처가 meta에 남음', Array.isArray(b.meta.sources) && b.meta.sources.length > 0);
  }

  console.log('3) 옵트인해도 index가 없으면 발췌 없음');
  {
    const b = await deepdive.briefing({ map: 'fx', topic: 'ACharacter', includeSource: true });
    check('index 없이는 발췌 불가', b.meta.excerpts === 0 && !b.text.includes('```cpp'));
  }

  console.log('4) analyze — 로컬 리뷰어 경로');
  {
    const r = await deepdive.analyze({ map: 'fx', topic: 'ACharacter', reviewer: 'local' });
    check('스텁 모델의 답을 그대로 돌려줌', r.answer === '분석 결과 [1]');
    check('외부 전송 아님으로 기록', r.external === false);
    check('브리핑이 프롬프트로 들어감', lastDelegate && lastDelegate.prompt.includes('Character.h'));
    check('시스템 프롬프트에 근거 인용 강제', /file:line/.test(lastDelegate.systemPrompt));
  }

  console.log('5) 리뷰어 목록 — 로컬만 남는다(외부 CLI push 경로 제거)');
  {
    const rs = deepdive.reviewers();
    check('local 리뷰어 존재', rs.some((r) => r.id === 'local' && r.external === false), JSON.stringify(rs));
  }

  console.log('6) 잘못된 입력은 명확히 실패');
  {
    let threw = '';
    try { await deepdive.briefing({ map: 'fx', topic: '' }); } catch (e) { threw = e.message; }
    check('빈 topic 거부', /필요/.test(threw), threw);
  }

  fs.rmSync(SANDBOX, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 150));
  console.log('');
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FAIL', e);
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 무시 */ }
  process.exit(1);
});

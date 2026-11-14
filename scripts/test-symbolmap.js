#!/usr/bin/env node
// 엔진 심볼 맵 회귀 테스트 (LM Studio·엔진 소스 불필요 — 픽스처로 돈다).
//
// 왜 이 계층이 있나: UE 5.8 전체 소스는 헤더 51,288개(492MB)다. 임베딩 색인은 약
// 3.4시간이 걸리고 상한(12만 청크)에서 12%만 담고 잘린다. 같은 트리를 정규식으로
// 훑으면 약 30초다. "어디 있나 / 부모가 뭔가"는 의미 검색이 필요 없는 질문이므로
// 여기서 답하고, 임베딩은 좁힌 영역의 "어떻게 동작하나"에만 쓴다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-symbolmap-'));
process.env.APPDATA = SANDBOX;

const symbolmap = require('../src/core/symbolmap');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---- 픽스처: 진짜 UE 헤더 모양을 흉내 낸 최소 트리 --------------------------
const SRC = path.join(SANDBOX, 'Engine', 'Source');
const NOTES = path.join(SANDBOX, 'notes');
function write(rel, text) {
  const p = path.join(SRC, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
}

write('Runtime/Engine/Classes/GameFramework/Actor.h', `
#pragma once
class UWorld;              // 전방 선언 — 지도에 올리면 안 된다
class FInlineProbe { public: int Sample() const; };
UCLASS(BlueprintType, Blueprintable)
class ENGINE_API AActor : public UObject
{
	GENERATED_BODY()
};
`);
write('Runtime/Engine/Classes/GameFramework/Pawn.h', `
#pragma once
UCLASS()
class ENGINE_API APawn : public AActor, public INavAgentInterface
{
	GENERATED_BODY()
};
`);
write('Runtime/Engine/Classes/GameFramework/Character.h', `
#pragma once
UCLASS()
class ENGINE_API ACharacter : public APawn
{
	GENERATED_BODY()
};
UENUM()
enum class EMovementMode : uint8 { Walking, Falling };
`);
write('Runtime/RenderCore/Public/SceneRendering.h', `
#pragma once
class RENDERCORE_API FSceneRenderer
{
public:
	void Render();
};
struct FInternalHelper { int32 X; };
`);
// C++는 반환 타입에도 class를 쓴다. 이름까지만 보고 끊으면 이게 UObject의 "선언"이
// 되어 계층 조회가 엉뚱한 파일을 가리킨다 — 실제로 겪은 오탐이다.
write('Runtime/SlateCore/Public/Styling/SlateBrush.h', `
#pragma once
struct SLATECORE_API FSlateBrush
{
	class UObject* GetResourceObject( ) const
	{
		return ResourceObject;
	}
	class UTexture2D& GetTexture() const;
};
`);

fs.mkdirSync(NOTES, { recursive: true });
fs.writeFileSync(path.join(NOTES, 'rendering.md'), `
# Rendering

## Scene rendering entry
FSceneRenderer drives the frame. Set r.Shaders.Optimize=0 while debugging.

## Unrelated section
This section mentions nothing in particular.
`, 'utf8');

console.log('1) 스캔 — 선언만 줍고 전방 선언은 거른다');
let info;
{
  info = symbolmap.scan({ name: 'fixture', root: SRC, notesRoot: NOTES });
  check('맵이 만들어짐', info.counts.symbols > 0, JSON.stringify(info.counts));
  const doc = symbolmap.load('fixture');
  const names = doc.symbols.map((s) => s.n);
  check('AActor·APawn·ACharacter·FSceneRenderer 수집', ['AActor', 'APawn', 'ACharacter', 'FSceneRenderer'].every((n) => names.includes(n)), names.join(','));
  check('전방 선언(UWorld)은 제외', !names.includes('UWorld'), names.join(','));
  check('한 줄 클래스의 멤버 세미콜론 허용', names.includes('FInlineProbe'));
  check('UENUM도 수집', names.includes('EMovementMode'));
  check('내보내지 않은 내부 struct는 제외', !names.includes('FInternalHelper'), names.join(','));
  check('반환 타입의 class는 선언이 아님(UObject 오탐 방지)', !names.includes('UObject'), names.join(','));
  check('참조 반환 타입도 마찬가지(UTexture2D)', !names.includes('UTexture2D'), names.join(','));
  check('같은 파일의 진짜 선언은 살아 있음', names.includes('FSlateBrush'), names.join(','));
  const actor = doc.symbols.find((s) => s.n === 'AActor');
  check('UCLASS 종류를 기록', actor.k === 'UCLASS', actor.k);
  check('모듈을 경로에서 뽑음', actor.m === 'Engine', actor.m);
  check('파일 경로는 루트 상대 + 슬래시', actor.f === 'Runtime/Engine/Classes/GameFramework/Actor.h', actor.f);
}

console.log('2) 검색 — 아는 이름을 그대로 치면 그게 1등이어야 한다');
{
  const r = symbolmap.find('fixture', 'Actor');
  check('정확 일치가 첫 번째', r.matches[0].name === 'AActor' || r.matches[0].name === 'Actor', r.matches.map((m) => m.name).join(','));
  const ch = symbolmap.find('fixture', 'ACharacter');
  check('정확 일치 검색', ch.matches[0].name === 'ACharacter', JSON.stringify(ch.matches[0]));
  const byKind = symbolmap.find('fixture', 'a', { kind: 'UCLASS' });
  check('종류로 거를 수 있음', byKind.matches.every((m) => m.kind === 'UCLASS'), JSON.stringify(byKind.matches));
  const byModule = symbolmap.find('fixture', 'F', { module: 'RenderCore' });
  check('모듈로 거를 수 있음', byModule.matches.every((m) => m.module === 'RenderCore'), JSON.stringify(byModule.matches));
  check('없는 이름은 빈 결과', symbolmap.find('fixture', 'zzz-nope').matches.length === 0);
}

console.log('3) 계층 — 부모 사슬과 자식, 인터페이스를 구별한다');
{
  const h = symbolmap.hierarchy('fixture', 'ACharacter');
  check('자기 자신을 찾음', h.found && h.self.name === 'ACharacter');
  // 트리 밖의 부모(UObject)도 사슬에 남긴다 — 선언을 못 찾았다고 "부모가 없다"고
  // 하면 안 된다. 대신 종류를 '?'로 표시해 좌표가 없다는 걸 드러낸다.
  check('조상 사슬 APawn → AActor → UObject',
    h.ancestors.map((a) => a.name).join('>') === 'APawn>AActor>UObject', JSON.stringify(h.ancestors.map((a) => a.name)));
  check('트리 밖 조상은 종류를 ?로', h.ancestors[2].kind === '?' && h.ancestors[2].file === '', JSON.stringify(h.ancestors[2]));
  const pawn = symbolmap.hierarchy('fixture', 'APawn');
  check('인터페이스는 부모와 분리', pawn.interfaces.join(',') === 'INavAgentInterface', JSON.stringify(pawn.interfaces));
  check('부모 클래스는 첫 번째만', pawn.ancestors[0].name === 'AActor', JSON.stringify(pawn.ancestors));
  const actor = symbolmap.hierarchy('fixture', 'AActor');
  check('직계 자식을 역참조', actor.children.map((c) => c.name).includes('APawn'), JSON.stringify(actor.children));
  check('손자는 직계에 없음', !actor.children.map((c) => c.name).includes('ACharacter'), JSON.stringify(actor.children));
  const missing = symbolmap.hierarchy('fixture', 'UNothingHere');
  check('없는 심볼은 found=false로', missing.found === false && missing.children.length === 0);
}

console.log('4) 해설 문서 — 심볼을 언급한 섹션으로 이어진다');
{
  const doc = symbolmap.load('fixture');
  check('섹션이 수집됨', doc.notes.length > 0, JSON.stringify(doc.counts));
  check('심볼을 언급하지 않는 섹션은 버림',
    !doc.notes.some((n) => n.t === 'Unrelated section'), JSON.stringify(doc.notes.map((n) => n.t)));
  const h = symbolmap.hierarchy('fixture', 'FSceneRenderer');
  check('계층 조회에 해설이 따라옴', h.notes.some((n) => n.title === 'Scene rendering entry'), JSON.stringify(h.notes));
  const found = symbolmap.find('fixture', 'FSceneRenderer');
  check('검색 결과에도 해설이 붙음', found.notes.length > 0, JSON.stringify(found.notes));
  const sec = doc.notes.find((n) => n.t === 'Scene rendering entry');
  check('콘솔 변수도 좌표로 수집', sec.s.includes('r.Shaders.Optimize'), JSON.stringify(sec.s));
}

console.log('5) scopeFor — 1계층이 2계층에 넘길 범위를 좁힌다');
{
  // 임베딩을 전체 트리에 걸면 몇 시간이다. 심볼이 모인 디렉터리만 뽑아 넘긴다.
  const s = symbolmap.scopeFor('fixture', 'A', { depth: 4 });
  check('맵의 루트를 함께 돌려줌', s.root.endsWith(path.join('Engine', 'Source')), s.root);
  check('디렉터리 단위로 묶임', s.dirs.every((d) => d.dir.split('/').length <= 4), JSON.stringify(s.dirs));
  check('GameFramework가 잡힘', s.dirs.some((d) => d.dir === 'Runtime/Engine/Classes/GameFramework'), JSON.stringify(s.dirs));
  check('심볼 많은 순으로 정렬', s.dirs.every((d, i) => i === 0 || s.dirs[i - 1].symbols >= d.symbols), JSON.stringify(s.dirs));

  const renderer = symbolmap.scopeFor('fixture', 'FSceneRenderer');
  check('다른 질의는 다른 디렉터리로 좁혀짐',
    renderer.dirs.length === 1 && renderer.dirs[0].dir.startsWith('Runtime/RenderCore'), JSON.stringify(renderer.dirs));
  // 범위는 언제나 디렉터리여야 한다. 파일이 섞이면 인덱싱이 그 항목을 무시해
  // 심볼을 통째로 놓친다 — 실제 엔진 맵에서 .h가 범위로 나왔었다.
  check('범위에 파일 경로가 섞이지 않음',
    [...s.dirs, ...renderer.dirs].every((d) => !/\.[A-Za-z0-9]+$/.test(d.dir)),
    JSON.stringify([...s.dirs, ...renderer.dirs].map((d) => d.dir)));

  const shallow = symbolmap.scopeFor('fixture', 'A', { depth: 1 });
  check('깊이를 얕게 주면 상위로 뭉침', shallow.dirs.every((d) => !d.dir.includes('/')), JSON.stringify(shallow.dirs));

  const none = symbolmap.scopeFor('fixture', 'zzz-nope');
  check('걸린 심볼이 없으면 빈 범위', none.dirs.length === 0 && none.symbolCount === 0);
}

console.log('6) 목록·삭제');
// 질의 캐시(열 SoA, 크기+mtime 무효화): 결과를 고쳐도 캐시가 안 바뀌고, 다른 프로세스가 맵을 바꾸면 다음 호출이 새 맵을 본다.
{
  const a = symbolmap.find('fixture', 'AActor');
  a.matches[0].parents.push('Tampered'); a.matches[0].name = 'Tampered';
  const b = symbolmap.find('fixture', 'AActor');
  check('결과 객체를 고쳐도 캐시는 그대로', b.matches[0].name === 'AActor' && !b.matches[0].parents.includes('Tampered'));
  const h = symbolmap.hierarchy('fixture', 'AActor');
  h.self.parents.length = 0;
  check('계층 결과도 캐시와 분리', symbolmap.hierarchy('fixture', 'AActor').self.parents.length > 0);
  // scan()을 거치지 않고 파일만 바뀐 경우(다른 프로세스의 재스캔): 임시파일+rename으로 덮어쓴다.
  const file = path.join(symbolmap.MAP_DIR, 'fixture.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.symbols.push({ n: 'ULateArrival', k: 'UCLASS', p: ['AActor'], f: 'Runtime/Engine/Late.h', l: 3, m: 'Engine' });
  fs.writeFileSync(file + '.tmp', JSON.stringify(doc), 'utf8');
  fs.renameSync(file + '.tmp', file);
  check('파일이 바뀌면 다음 호출이 새 맵을 읽음', symbolmap.find('fixture', 'ULateArrival').total === 1);
  check('새 맵의 자식 역참조', symbolmap.hierarchy('fixture', 'AActor').children.some((c) => c.name === 'ULateArrival'));
}

{
  check('목록에 뜸', symbolmap.list().some((m) => m.name === 'fixture'));
  check('삭제하면 사라짐', symbolmap.remove('fixture').every((m) => m.name !== 'fixture'));
  let gone = '';
  try { symbolmap.find('fixture', 'AActor'); } catch (e) { gone = e.code; }
  check('삭제한 맵은 캐시에서도 사라짐', gone === 'ENOENT', gone);
  let threw = '';
  try { symbolmap.scan({ name: 'bad name!', root: SRC }); } catch (e) { threw = e.message; }
  check('맵 이름을 검증(경로 탈출 방지)', /영문/.test(threw), threw);
  let threw2 = '';
  try { symbolmap.scan({ name: 'nope', root: path.join(SANDBOX, 'does-not-exist') }); } catch (e) { threw2 = e.message; }
  check('없는 경로는 명확히 실패', /존재하지 않습니다/.test(threw2), threw2);
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log('');
console.log(`통과 ${pass} / 실패 ${fail}`);
process.exit(fail === 0 ? 0 : 1);

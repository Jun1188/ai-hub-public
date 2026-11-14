#!/usr/bin/env node
// 소스 인덱스 테스트 — LM Studio 없이 embedder를 가짜로 바꿔 검증한다.
//
// 확인하는 것(2026-07-26 개선분):
//   · 경계 인식 청킹 — 함수/클래스/UE 매크로에서 끊는다 (예전엔 60줄 고정)
//   · 하이브리드 검색 — 임베딩 + 키워드/심볼 일치
//   · 파일별 다양성 제한
//   · 증분 재색인 — 바뀐 파일만 다시 임베딩
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const embedderPath = require.resolve(path.join(appRoot, 'src', 'core', 'embedder.js'));
require(embedderPath);

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/** 결정적인 가짜 임베딩 — 텍스트의 문자 분포를 8차원으로 접는다. */
const embedStats = { calls: 0, texts: 0 };
function stubEmbedder() {
  embedStats.calls = 0;
  embedStats.texts = 0;
  require.cache[embedderPath].exports.embed = async (texts) => {
    embedStats.calls++;
    embedStats.texts += texts.length;
    return texts.map((t) => {
      const v = new Float32Array(8);
      for (let i = 0; i < t.length; i++) v[t.charCodeAt(i) % 8] += 1;
      let n = 0;
      for (let i = 0; i < 8; i++) n += v[i] * v[i];
      n = Math.sqrt(n) || 1;
      for (let i = 0; i < 8; i++) v[i] /= n;
      return v;
    });
  };
  require.cache[embedderPath].exports.model = () => 'stub-embed';
}

function freshCodeindex(dataDir) {
  process.env.APPDATA = dataDir;
  for (const m of ['paths', 'config', 'codeindex']) {
    const p = require.resolve(path.join(appRoot, 'src', 'core', `${m}.js`));
    delete require.cache[p];
  }
  return require(path.join(appRoot, 'src', 'core', 'codeindex.js'));
}

const SAMPLE_CPP = `#include "SceneRendering.h"

class FSceneRenderer : public FSceneRendererBase
{
public:
	void RenderBasePass(FRDGBuilder& GraphBuilder);
	void RenderShadowDepthMaps(FRDGBuilder& GraphBuilder);
};

void FSceneRenderer::RenderBasePass(FRDGBuilder& GraphBuilder)
{
	RDG_EVENT_SCOPE(GraphBuilder, "BasePass");
	// 기본 패스는 지오메트리를 GBuffer에 그린다.
	for (int32 i = 0; i < Views.Num(); ++i)
	{
		RenderViewBasePass(GraphBuilder, Views[i]);
	}
}

void FSceneRenderer::RenderShadowDepthMaps(FRDGBuilder& GraphBuilder)
{
	RDG_EVENT_SCOPE(GraphBuilder, "ShadowDepths");
	// 그림자 깊이 맵을 아틀라스에 렌더한다.
	for (FProjectedShadowInfo* Shadow : SortedShadowsForShadowDepthPass)
	{
		Shadow->RenderDepth(GraphBuilder);
	}
}
`;

const SAMPLE_OTHER = `#include "Lighting.h"

void FDeferredShadingRenderer::RenderLights(FRDGBuilder& GraphBuilder)
{
	// 조명을 하나씩 적용한다.
	for (const FLightSceneInfo* Light : Scene->Lights)
	{
		ApplyLight(GraphBuilder, Light);
	}
}
`;

async function main() {
  stubEmbedder();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-idx-data-'));
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-idx-src-'));
  fs.writeFileSync(path.join(srcDir, 'SceneRenderer.cpp'), SAMPLE_CPP, 'utf8');
  fs.writeFileSync(path.join(srcDir, 'Lighting.cpp'), SAMPLE_OTHER, 'utf8');

  const codeindex = freshCodeindex(dataDir);

  console.log('1) 경계 인식 청킹');
  {
    const { chunks } = codeindex.chunkFile('SceneRenderer.cpp', SAMPLE_CPP);
    check('청크가 2개 이상으로 나뉨', chunks.length >= 2, `${chunks.length}개`);
    const startsAtBoundary = chunks.every((c) => {
      const first = SAMPLE_CPP.split('\n')[c.startLine - 1] || '';
      return /^(#include|class|void|\s*$)/.test(first);
    });
    check('모든 청크가 경계에서 시작', startsAtBoundary,
      chunks.map((c) => (SAMPLE_CPP.split('\n')[c.startLine - 1] || '').slice(0, 30)).join(' | '));
    const basePass = chunks.find((c) => c.text.includes('RenderBasePass(FRDGBuilder& GraphBuilder)\n{'));
    check('함수 본문이 한 청크 안에 온전히 들어감',
      Boolean(basePass && basePass.text.includes('RenderViewBasePass')));
  }

  console.log('2) 질의어 추출 (카멜케이스 분해 + 불용어 제거)');
  {
    const terms = codeindex.queryTerms('How does FSceneRenderer render the base pass?');
    check('카멜케이스를 쪼갬', terms.includes('Scene') && terms.includes('Renderer'), terms.join(','));
    check('원본 심볼도 유지', terms.includes('FSceneRenderer'), terms.join(','));
    check('불용어 제거', !terms.includes('does') && !terms.includes('the'), terms.join(','));
  }

  console.log('3) 인덱스 생성');
  const meta = await codeindex.buildIndex({ name: 'test-ue', root: srcDir, exts: ['.cpp'] });
  check('청크가 만들어짐', meta.chunkCount > 0, `${meta.chunkCount}개`);
  check('파일 스탬프가 기록됨', Object.keys(meta.files || {}).length === 2,
    Object.keys(meta.files || {}).join(','));
  const firstBuildTexts = embedStats.texts;

  console.log('4) 하이브리드 검색 — 심볼 정확 일치에 가산점');
  {
    const hits = await codeindex.search('test-ue', 'RenderShadowDepthMaps', 5);
    check('결과가 나옴', hits.length > 0);
    check('키워드 점수가 반영됨', hits.some((h) => h.keyword > 0),
      JSON.stringify(hits.map((h) => ({ f: h.file, k: h.keyword }))));
    check('심볼을 담은 청크가 1위', hits[0].text.includes('RenderShadowDepthMaps'),
      hits[0].text.slice(0, 60));
  }

  console.log('5) 파일별 다양성 제한');
  {
    const hits = await codeindex.search('test-ue', 'GraphBuilder', 6, { maxPerFile: 1 });
    const files = hits.map((h) => h.file);
    const uniq = new Set(files.slice(0, 2));
    check('상위 결과가 서로 다른 파일에서 나옴', uniq.size === 2, files.join(','));
  }

  console.log('6) 증분 재색인 — 바뀐 게 없으면 다시 임베딩하지 않음');
  {
    embedStats.texts = 0;
    const m2 = await codeindex.buildIndex({ name: 'test-ue', root: srcDir, exts: ['.cpp'] });
    check('새로 임베딩한 청크 없음', embedStats.texts === 0, `${embedStats.texts}개 임베딩됨`);
    check('전부 재사용으로 기록', m2.reusedChunks === m2.chunkCount,
      `${m2.reusedChunks}/${m2.chunkCount}`);
    check('청크 수 동일', m2.chunkCount === meta.chunkCount);
  }

  console.log('7) 증분 재색인 — 바뀐 파일만 다시 임베딩');
  {
    embedStats.texts = 0;
    await new Promise((r) => setTimeout(r, 1100)); // mtime 해상도 확보
    fs.writeFileSync(path.join(srcDir, 'Lighting.cpp'), `${SAMPLE_OTHER}\n// 수정됨\n`, 'utf8');
    const m3 = await codeindex.buildIndex({ name: 'test-ue', root: srcDir, exts: ['.cpp'] });
    check('일부만 다시 임베딩', embedStats.texts > 0 && embedStats.texts < firstBuildTexts,
      `${embedStats.texts} / 최초 ${firstBuildTexts}`);
    check('나머지는 재사용', m3.reusedChunks > 0, `${m3.reusedChunks}개 재사용`);
    const hits = await codeindex.search('test-ue', 'ApplyLight', 3);
    check('수정된 파일도 검색됨', hits.some((h) => h.file === 'Lighting.cpp'),
      hits.map((h) => h.file).join(','));
  }

  console.log('8) 범위를 바꾸면 전체 재색인');
  {
    embedStats.texts = 0;
    const m4 = await codeindex.buildIndex({ name: 'test-ue', root: srcDir, exts: ['.cpp', '.h'] });
    check('재사용 없이 다시 만듦', (m4.reusedChunks || 0) === 0 && embedStats.texts > 0,
      `재사용 ${m4.reusedChunks}, 임베딩 ${embedStats.texts}`);
  }

  console.log('8-1) subdirs — 1계층이 좁혀 준 범위만 색인한다');
  {
    // 심볼 맵이 "이 디렉터리들만 보면 된다"고 알려 주면 거기만 임베딩한다.
    // 엔진 전체는 3.4시간이지만 좁히면 수 분이다.
    const subDir = path.join(srcDir, 'Nested');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'Deep.cpp'), `${SAMPLE_CPP}\n// 하위 디렉터리 전용\nvoid OnlyInNested() {}\n`, 'utf8');

    const scoped = await codeindex.buildIndex({ name: 'test-scoped', root: srcDir, exts: ['.cpp'], subdirs: ['Nested'] });
    const files = Object.keys(scoped.files || {});
    check('범위 안의 파일만 들어감', files.length === 1 && files[0] === 'Nested/Deep.cpp', files.join(','));
    check('범위가 meta에 기록됨', (scoped.subdirs || []).join(',') === 'Nested', JSON.stringify(scoped.subdirs));
    const hits = await codeindex.search('test-scoped', 'OnlyInNested', 3);
    check('좁힌 범위 안에서 검색됨', hits.some((h) => h.file === 'Nested/Deep.cpp'), hits.map((h) => h.file).join(','));

    // 범위를 바꾸면 재사용하면 안 된다 — 넓히면 새 파일이 통째로 빠지고,
    // 좁히면 사라진 파일의 청크가 남는다.
    embedStats.texts = 0;
    const widened = await codeindex.buildIndex({ name: 'test-scoped', root: srcDir, exts: ['.cpp'] });
    check('범위를 넓히면 전체 재색인', (widened.reusedChunks || 0) === 0 && embedStats.texts > 0,
      `재사용 ${widened.reusedChunks}, 임베딩 ${embedStats.texts}`);
    check('넓힌 뒤에는 바깥 파일도 포함', Object.keys(widened.files || {}).length > 1,
      Object.keys(widened.files || {}).join(','));

    // 루트 밖을 가리키는 경로는 무시해야 한다(경로 탈출 방지).
    const escaped = await codeindex.buildIndex({ name: 'test-escape', root: srcDir, exts: ['.cpp'], subdirs: ['../..'] });
    check('루트 밖 subdir은 무시', Object.keys(escaped.files || {}).length > 0
      && Object.keys(escaped.files || {}).every((f) => !f.startsWith('..')),
      Object.keys(escaped.files || {}).join(','));
  }

  console.log('9) 파인튜닝 표본 추출 — 파일 균등 + 저품질 청크 제외');
  {
    const finetune = require(path.join(appRoot, 'src', 'core', 'finetune.js'));
    const boilerplate = {
      file: 'Fwd.h', startLine: 1, endLine: 20,
      text: '#include "A.h"\n#include "B.h"\nclass FFoo;\nclass FBar;\n'.repeat(6),
    };
    check('선언만 있는 청크는 학습 대상 아님', finetune.isTrainable(boilerplate) === false);
    const real = { file: 'A.cpp', startLine: 1, endLine: 30, text: SAMPLE_CPP };
    check('로직이 있는 청크는 학습 대상', finetune.isTrainable(real) === true);

    // 큰 파일 하나가 표본을 독차지하지 않아야 한다.
    const big = Array.from({ length: 50 }, (_, i) => ({ ...real, file: 'Big.cpp', startLine: i }));
    const small = [{ ...real, file: 'Small.cpp' }, { ...real, file: 'Tiny.cpp' }];
    const sampled = finetune.sampleForTraining([...big, ...small], 6);
    const files = new Set(sampled.map((c) => c.file));
    check('여러 파일에서 고루 뽑음', files.size === 3, [...files].join(','));
    check('요청한 개수만큼 뽑음', sampled.length === 6, `${sampled.length}개`);
  }

  console.log('10) 작업 파일이 남지 않음');
  {
    const idxDir = path.join(dataDir, 'ai-hub', 'index', 'test-ue');
    const junk = fs.readdirSync(idxDir).filter((f) => f.endsWith('.building'));
    check('.building 잔재 없음', junk.length === 0, junk.join(','));
  }

  console.log('11) 벡터·청크 수가 안 맞는 색인은 틀린 순위 대신 오류 (불변식은 적재 때 한 번 검사)');
  {
    const idxRoot = path.join(dataDir, 'ai-hub', 'index');
    const broken = path.join(idxRoot, 'test-broken');
    fs.cpSync(path.join(idxRoot, 'test-ue'), broken, { recursive: true });
    const vec = fs.readFileSync(path.join(broken, 'vectors.bin'));
    fs.writeFileSync(path.join(broken, 'vectors.bin'), vec.subarray(0, vec.length - 4 * 8));
    let err = '';
    try { await codeindex.search('test-broken', 'GraphBuilder', 3); } catch (e) { err = e.message; }
    check('짧은 vectors.bin은 재색인 안내 오류', /inconsistent/.test(err), err);
  }

  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(srcDir, { recursive: true, force: true });

  console.log('');
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('테스트 예외:', e); process.exit(1); });

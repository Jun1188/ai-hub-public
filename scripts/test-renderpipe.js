// Headless test for rendering-pipeline analysis. Uses the real UE renderer
// tree if present, else a synthetic renderer source. AI analysis needs LM Studio.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const renderpipe = require('../src/core/renderpipe');

function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) process.exitCode = 1;
}

async function findUeRenderer() {
  // Renderer 스캔 대상만 고른다 — Shaders 제안은 이 테스트의 패턴과 안 맞는다.
  for (const s of await renderpipe.suggestRoots()) {
    if (/renderer$/i.test(s.name) && fs.existsSync(s.path)) return s;
  }
  return null;
}

function makeSynthetic() {
  const dir = path.join(os.tmpdir(), 'aihub-rp-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MyPassRendering.cpp'),
`void FDeferredShadingSceneRenderer::RenderMyPass(FRDGBuilder& GraphBuilder)
{
    RDG_GPU_STAT_SCOPE(GraphBuilder, MyPassStat);
    SCOPED_DRAW_EVENTF(RHICmdList, MyPassEvent, TEXT("MyPass"));
    GraphBuilder.AddPass(RDG_EVENT_NAME("MyCustomPass"), Params, ERDGPassFlags::Raster,
        [](FRHICommandList& RHICmdList) { /* draw */ });
}
IMPLEMENT_GLOBAL_SHADER(FMyPassVS, "/Engine/Private/MyPass.usf", "MainVS", SF_Vertex);
DECLARE_GPU_STAT_NAMED(MyPassStat, TEXT("My Pass"));
`, 'utf8');
  fs.writeFileSync(path.join(dir, 'MyPass.usf'), '// shader\nfloat4 MainVS() : SV_Position { return 0; }\n', 'utf8');
  return { dir };
}

async function main() {
  const ue = await findUeRenderer();
  let root, cleanup = null, name = 'test-rp-' + Date.now();
  if (ue) {
    root = ue.path;
    console.log('INFO: using real UE renderer at', root);
  } else {
    const syn = makeSynthetic();
    root = syn.dir;
    cleanup = () => fs.rmSync(syn.dir, { recursive: true, force: true });
    console.log('INFO: UE not found — using synthetic renderer');
  }

  const s = renderpipe.scan(name, root);
  assert(s.fileCount > 0, 'scan found files');
  assert(s.counts.rdgPasses > 0, 'found RDG passes');
  assert(s.counts.rendererFuncs > 0, 'found renderer functions');
  assert(s.counts.shaders > 0, 'found shaders');
  console.log('  counts:', JSON.stringify(s.counts));

  assert(renderpipe.list().some((m) => m.name === name), 'map listed');

  const topic = ue ? 'BasePass' : 'MyPass';
  const q = renderpipe.query(name, topic, 10);
  const hits = renderpipe.CATEGORIES.reduce((n, c) => n + q.categories[c].total, 0);
  assert(hits > 0, `query "${topic}" returns hits (${hits})`);

  // path-escape guard: scan name must reject separators
  let rejected = false;
  try { renderpipe.scan('../evil', root); } catch { rejected = true; }
  assert(rejected, 'scan name with path separator is rejected');

  // AI analysis (LM Studio 필요)
  try {
    const r = await renderpipe.analyze(name, topic, {});
    const ok = r.answer && !/NEEDS_ESCALATION/.test(r.answer) && r.sources.length > 0;
    assert(ok, `analyze("${topic}") returns grounded answer with sources (${r.sources.length})`);
    console.log('  model:', r.model, '| answer head:', r.answer.slice(0, 120).replace(/\n/g, ' '));
  } catch (e) {
    console.log('SKIP: analyze — ' + e.message);
  }

  renderpipe.removeMap(name);
  assert(!renderpipe.list().some((m) => m.name === name), 'map removed');
  if (cleanup) cleanup();
  console.log('DONE');
  process.exit(process.exitCode || 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });

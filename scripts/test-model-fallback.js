// 컴퓨터마다 LM Studio에 설치된 모델·포트가 다를 때의 동작 검증 (LM Studio 없이 스텁).
//
// 확인하는 것:
//   · 기기별 값(LM Studio 주소, 기본 모델, 1.28까지의 오케스트레이션 모델)이 공유 설정에 안 실린다
//   · 저장된 설정·파이프라인에 박힌 모델이 없으면 자동 선택으로 후퇴한다
//   · 호출자가 방금 지정한 모델은 후퇴하지 않고 오류로 알린다
//   · 연결 실패 메시지에 실제 주소가 들어간다(포트가 어긋난 경우를 알아보게)
'use strict';
// Preparation admission/lifecycle has its own isolated regression fixtures.
const control=require('../src/core/model-control');control.ensure=control.ready=async p=>({model:p.model,state:'loaded'});

const fs = require('fs');
const os = require('os');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const MODULES = ['paths', 'config', 'lmstudio', 'stats', 'memory', 'delegator'];

/** 임시 APPDATA로 모듈을 새로 읽는다 — 실제 설정 파일을 건드리지 않는다. */
function freshModules(home) {
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
  for (const m of MODULES) delete require.cache[require.resolve(path.join(appRoot, 'src', 'core', `${m}.js`))];
  const mod = (m) => require(path.join(appRoot, 'src', 'core', `${m}.js`));
  return { config: mod('config'), lmstudio: mod('lmstudio'), delegator: mod('delegator') };
}

/** 이 컴퓨터에 있는 모델은 두 개뿐이라고 가정한다. */
function stubModels(lmstudio) {
  lmstudio.listModelsDetailed = async () => [
    { id: 'stub-coder-14b', state: 'loaded', type: 'llm', contextLength: 8192 },
    { id: 'stub-general-12b', state: 'loaded', type: 'llm', contextLength: 8192 },
  ];
  lmstudio.chat = async (p) => ({ content: `OUT(${p.model})`, model: p.model, usage: {} });
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-modelfb-'));
  const { config, lmstudio, delegator } = freshModules(home);
  stubModels(lmstudio);

  console.log('1) 기기별 값은 공유 설정에 실리지 않는다');
  {
    config.update({
      lmstudio: { baseUrl: 'http://127.0.0.1:9999' },
      delegation: { defaultModel: 'only-on-that-machine' },
      orchestration: { workerModel: 'only-on-that-machine' },
    });
    const shared = JSON.parse(fs.readFileSync(path.join(home, 'AppData', 'Roaming', 'ai-hub', 'config.cache.json'), 'utf8').replace(/^\uFEFF/, ''));
    const local = JSON.parse(fs.readFileSync(path.join(home, 'AppData', 'Roaming', 'ai-hub', 'config.local.json'), 'utf8').replace(/^\uFEFF/, ''));
    check('LM Studio 주소가 공유본에 없음', !(shared.lmstudio && shared.lmstudio.baseUrl), JSON.stringify(shared.lmstudio));
    check('기본 모델이 공유본에 없음', !(shared.delegation && shared.delegation.defaultModel), JSON.stringify(shared.delegation));
    check('오케스트레이션 모델이 공유본에 없음', !(shared.orchestration && shared.orchestration.workerModel), JSON.stringify(shared.orchestration));
    check('세 값 모두 로컬 파일에 저장됨',
      local.lmstudio.baseUrl === 'http://127.0.0.1:9999'
      && local.delegation.defaultModel === 'only-on-that-machine'
      && local.orchestration.workerModel === 'only-on-that-machine', JSON.stringify(local));
  }

  console.log('2) 모델 존재 확인');
  {
    check('있는 모델', (await delegator.hasModel('stub-coder-14b')) === true);
    check('없는 모델', (await delegator.hasModel('missing-70b')) === false);
  }

  console.log('3) 호출자가 지정한 모델이 없으면 오류 (조용히 바꾸지 않는다)');
  {
    let msg = '';
    try {
      await delegator.delegate({ prompt: 'x', taskType: 'programming', model: 'missing-70b' });
    } catch (e) { msg = String(e.message || e); }
    check('예외를 던진다', msg.includes('missing-70b'), msg);
    check('가능한 모델을 알려준다', msg.includes('stub-coder-14b'), msg);
  }

  console.log('4) 저장된 설정에서 온 모델은 자동 선택으로 후퇴한다');
  {
    const r = await delegator.delegate({ prompt: 'x', taskType: 'programming', model: 'missing-70b', modelFallback: true });
    check('위임이 성공한다', Boolean(r.content), JSON.stringify(r).slice(0, 120));
    check('대체 사실을 보고한다', r.modelFallback && r.modelFallback.requested === 'missing-70b', JSON.stringify(r.modelFallback));
    check('이 컴퓨터에 있는 모델로 실행됐다',
      ['stub-coder-14b', 'stub-general-12b'].includes(r.model), r.model);
    const ok = await delegator.delegate({ prompt: 'x', taskType: 'programming', model: 'stub-coder-14b', modelFallback: true });
    check('있는 모델이면 대체 보고가 없다', !ok.modelFallback && ok.model === 'stub-coder-14b', ok.model);
  }

  console.log('5) 연결 실패 메시지에 주소가 들어간다');
  {
    // 아무도 듣지 않는 포트로 실제 요청을 보낸다(로컬, 즉시 거부됨).
    config.update({ lmstudio: { baseUrl: 'http://127.0.0.1:1' } });
    delete require.cache[require.resolve(path.join(appRoot, 'src', 'core', 'lmstudio.js'))];
    const fresh = require(path.join(appRoot, 'src', 'core', 'lmstudio.js'));
    let msg = '';
    try { await fresh.listModels(); } catch (e) { msg = String(e.message || e); }
    check('주소·포트를 알려준다', msg.includes('127.0.0.1:1'), msg);
    check('무엇을 확인할지 알려준다', msg.includes('포트'), msg);
  }

  fs.rmSync(home, { recursive: true, force: true });
  console.log('');
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('테스트 예외:', e); process.exit(1); });

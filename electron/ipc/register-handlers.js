// IPC 등록 지점 — 도메인별 모듈을 한곳에서 붙인다.
//
// 왜 나눴나: 예전에는 main.js 한 파일에 IPC 핸들러 100여 개가 몰려 있어서
// 기능 하나를 고치려면 창 생성·트레이·허브 기동 코드까지 전부 지나가야 했다.
// 채널 이름 접두사(mem:, proj:, index: ...)가 이미 도메인을 나누고 있었으므로
// 그 경계를 그대로 파일 경계로 옮겼다.
//
// main.js에 남는 것: 창/트레이/HTTP 허브/자동 업데이트처럼 앱 수명주기에 얽힌 상태.
// 여기로 오는 것: 그 상태를 건드리지 않는 순수 도메인 핸들러.
'use strict';

/**
 * @typedef {object} IpcContext
 * @property {(channel: string, fn: Function) => void} handle
 *   핸들러 등록. 반환값은 {ok, data} / 예외는 {ok, error}로 감싸진다.
 * @property {(channel: string, payload: any) => void} send
 *   렌더러로 이벤트 전송(진행률 등). 창이 없으면 조용히 무시된다.
 * @property {() => Electron.BrowserWindow | null} window
 *   모달 다이얼로그의 부모 창. 호출 시점에 평가해야 하므로 함수로 받는다.
 */

const DOMAINS = [
  require('./hub-memory'),
  require('./automation'),
  require('./source-analysis'),
  require('./game-projects'),
  require('./mcp-connections'),
  require('./local-runtime'),
  require('./device-key-delivery'),
  require('./media-generation'),
  require('./creation-studio'),
  require('./creation-resources'),
  require('./herdr'),
  require('./aider-studio'),
  require('./activity'),
  require('./todo-done'),
  require('./shared-repo-memory'),
  require('./analysis-graph'),
  require('./knowledge-graph'),
  require('./resources'),
  require('./debugging'),
  require('./offload'),
  require('./self-improvement'),
  require('./device-profile'),
  require('./hub-commands'),
];

/** @param {IpcContext} ctx */
function registerAll(ctx) {
  const mutations = new Set(['index:delete','sym:remove','rp:remove','mem:save','mem:delete','proj:add','proj:remove','proj:refresh']);
  const context = { ...ctx, handle(channel, fn) {
    ctx.handle(channel, async (...args) => {
      const result = await fn(...args);
      if (mutations.has(channel)) require('../../src/core/knowledge-graph').invalidate();
      return result;
    });
  } };
  for (const domain of DOMAINS) domain.register(context);
}

function dispatch(channel,event,getWindow,handler,args) {
  const invoke=()=>require('../../src/core/caller').run({via:'gui'},()=>handler(...args));
  if (!['deviceKey:','studio:','herdr:','todoDone:'].some(prefix=>channel.startsWith(prefix))) return invoke();
  const index=require('node:path').join(__dirname,'..','..','ui','index.html');
  return require('./device-key-delivery').withTrustedFrame(event,getWindow,require('node:url').pathToFileURL(index).href,invoke);
}

module.exports = { registerAll, dispatch };

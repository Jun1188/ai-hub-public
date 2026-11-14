// IPC: per-machine ComfyUI and llama.cpp runtime management.
'use strict';

const { dialog } = require('electron');
const runtime = require('../../src/core/local-runtime');
const config = require('../../src/core/config');

function register(ctx) {
  const { handle, window } = ctx;
  // 외부 연결(설정 탭): API 연결·명세, URL 참조. 키·쓰기 허용은 이 데스크톱 경로로만 바뀐다.
  const apis = () => require('../../src/core/api-connections'), specs = () => require('../../src/core/api-specs').instance();
  const club = () => require('../../src/core/club-materials/hub-service.cjs').instance();
  handle('local:clubStatus', () => club().status());
  handle('local:clubStop', () => club().disable());
  handle('local:clubStart', async () => {
    const chosen=await dialog.showOpenDialog(window(),{title:'동아리 봇의 승인 대상 JSON 선택',properties:['openFile'],filters:[{name:'허용 대상',extensions:['json']}]});
    if(chosen.canceled||chosen.filePaths.length!==1)return club().status();
    const fs=require('node:fs/promises'), file=chosen.filePaths[0], stat=await fs.lstat(file);
    if(!stat.isFile()||stat.size>2048)throw Error('허용 대상 JSON은 2 KiB 이내 일반 파일이어야 합니다.');
    const c=require('../../src/core/club-materials/hub-service.cjs').scope(JSON.parse(await fs.readFile(file,'utf8')));
    const result=await dialog.showMessageBox(window(),{type:'question',title:'이 PC에서 동아리 봇 시작',
      message:'지정한 길드 명령을 등록하고 허용한 채널에서 비공개 자료를 받습니다.',
      detail:[`서버 ${c.guild}`,`자료 채널 ${c.channel}`,`포럼 ${c.forum}`,`스레드 ${c.threads.join(', ')}`,`주간 공지 ${c.news}`,`Drive 폴더 ${c.driveFolder}`].join('\n'),
      buttons:['취소','이 범위로 시작'],cancelId:0,defaultId:0});
    return result.response===1?club().start(c,true):club().status();
  });
  handle('local:apiList', () => Promise.all(apis().instance().list().map(async (p) => ({ ...p, operations: await specs().summary(p.id) }))));
  handle('local:apiSave', (profile,secret) => apis().instance().save(profile,secret));
  handle('local:apiRemove', async (id) => { const r = apis().instance().remove(id); await specs().forget(id); return r; });
  handle('local:apiPresets', () => apis().PRESETS);
  handle('local:geminiCheck', async () => {
    const profile = apis().instance().get('gemini');
    const gemini = require('../../src/core/credential-migration').LEGACY_API.gemini;
    if (profile.origin !== gemini.origin || profile.auth !== gemini.auth ||
        String(profile.authHeader).toLowerCase() !== gemini.authHeader) {
      throw Error('Gemini 연결의 서비스 주소와 API 키 헤더 설정을 확인하세요.');
    }
    const {callApi} = require('../../src/mcp/external-connection-tools');
    const result = await callApi({connection:'gemini', method:'GET', route:'/v1beta/models?pageSize=1'});
    return {httpStatus:result.httpStatus, listed:Array.isArray(result.body?.models)};
  });
  handle('local:apiSpecRefresh', (id) => specs().refresh(String(id || '')));
  handle('local:urlList', () => require('../../src/core/url-references').instance().list());
  handle('local:urlSave', (input) => require('../../src/core/url-references').instance().save(input || {}));
  handle('local:urlRemove', (id) => require('../../src/core/url-references').instance().remove(String(id || '')));
  handle('local:urlRefresh', (id) => require('../../src/core/url-references').instance().refresh(String(id || '')));
  handle('local:status', () => runtime.status());
  handle('local:resources', () => require('../../src/core/resource-monitor').snapshot());
  handle('local:credentialPut', (provider, secret) => require('../../src/core/credential-vault').put(provider, secret));
  handle('local:credentialStatus', () => require('../../src/core/credential-vault').status());
  handle('local:install', (kind) => runtime.install(String(kind)));
  handle('local:startComfy', () => runtime.startComfy());
  handle('local:stopComfy', () => runtime.stopComfy());
  handle('local:startLlama', (repo) => runtime.startLlama(String(repo || '')));
  handle('local:showInstallActions', (on) => config.updateWithRetry({ localRuntimes: { showInstallActions: Boolean(on) } }));
  handle('local:update', (values) => config.updateWithRetry({ localRuntimes: values || {} }));
  handle('local:comfyRun', (p) => runtime.comfyWorkflow({
    workflowFile: String(p.workflowFile || ''),
    inputs: p.inputs || {},
    timeoutMs: Number(p.timeoutMs) || 600000,
    loras: Array.isArray(p.loras) ? p.loras : undefined,
    loraTarget: p.loraTarget,
  }));
  handle('local:pickWorkflow', async () => {
    const res = await dialog.showOpenDialog(window(), {
      title: 'ComfyUI API 워크플로 JSON 선택',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    return res.canceled ? null : res.filePaths[0];
  });
}

module.exports = { register };

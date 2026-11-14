// IPC: Aider Studio process orchestration and project selection.
'use strict';

const { dialog } = require('electron');
const aider = require('../../src/core/aider-studio');
const runtime = require('../../src/core/local-runtime');
const modelChanges = new Map();
let modelChangeId = 0;

function register(ctx) {
  const { handle, send, window } = ctx;
  aider.setEmitter((channel, payload) => {
    if (channel === 'aider:log') send('aider:log', payload);
    if (channel === 'aider:status') send('aider:status', payload);
  });
  function changeModel(model, on) {
    if (require('../../src/core/model-control').busy()) throw new Error('MCP 모델 준비 작업이 진행 중입니다. 완료 상태를 먼저 확인하세요.');
    if (require('../../src/core/offload').active().length || aider.isBusy()) throw new Error('진행 중인 작업을 먼저 완료하거나 중지하세요.');
    if ([...modelChanges.values()].some(r => r.state === 'running')) throw new Error('진행 중인 모델 상태 변경을 기다려 주세요.');
    const requestId = String(++modelChangeId);
    const lockId = 'aider-model-' + requestId;
    const modelLock = require('../../src/core/model-change-lock');
    modelLock.acquire(lockId);
    const record = { requestId, model: String(model || ''), state: 'running' };
    modelChanges.set(requestId, record);
    if (modelChanges.size > 20) modelChanges.delete(modelChanges.keys().next().value);
    require('../../src/core/hardware-optimizer').withLocalSlot(()=>runtime.setLlamaModel(record.model,on)).then(result => Object.assign(record, { state: 'completed', result }))
      .catch(err => Object.assign(record, { state: 'failed', error: err.message }))
      .finally(() => modelLock.release(lockId));
    return { requestId };
  }
  handle('aider:modelStart', model => changeModel(model, true));
  handle('aider:modelStop', model => changeModel(model, false));
  handle('aider:modelResult', id => {
    const record = modelChanges.get(String(id));
    if (!record) throw new Error('모델 상태 변경 기록이 없습니다.');
    return record;
  });
  handle('aider:status', () => aider.status());
  handle('aider:preview', (p) => aider.commandPlan(p || {}));
  handle('aider:start', (p) => {
    if (require('../../src/core/model-change-lock').busy()) throw new Error('모델 준비가 끝난 뒤 작업을 시작하세요.');
    return aider.start(p || {});
  });
  handle('aider:cancel', (runId) => aider.cancel(String(runId || '')));
  handle('aider:pickProject', async () => {
    const res = await dialog.showOpenDialog(window(), {
      title: 'Aider가 작업할 프로젝트 폴더 선택',
      properties: ['openDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });
}

module.exports = { register };

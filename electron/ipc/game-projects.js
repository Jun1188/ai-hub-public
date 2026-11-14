// IPC: 게임 프로젝트(Unity/Unreal 감지·런처)와 빌드 파이프라인.
// 엔진·도구 경로는 코드에 박지 않고 실행할 때마다 그 컴퓨터에서 자동 감지한다
// (projects.detectTools) — 두 컴퓨터에서 같은 설정으로 동작해야 하므로.
'use strict';

const { dialog } = require('electron');

const projects = require('../../src/core/projects');
const pipeline = require('../../src/core/pipeline');

/** @param {import('./register-handlers').IpcContext} ctx */
function register(ctx) {
  const { handle, send, window } = ctx;

  // 파이프라인 로그/상태를 렌더러로 흘려보낸다.
  pipeline.setEmitter((channel, payload) => send(channel, payload));

  handle('proj:list', () => projects.list().map((p) => ({ ...p, missingHere: !require('fs').existsSync(p.path) })));
  handle('proj:tools', (force) => projects.detectTools(Boolean(force)));
  handle('proj:add', (p) => projects.add(String(p)));
  handle('proj:remove', (id) => projects.remove(String(id)));
  handle('proj:refresh', (id) => projects.refresh(String(id)));
  handle('proj:pick', async () => {
    const res = await dialog.showOpenDialog(window(), {
      title: 'Unity, Unreal, Node.js 프로젝트 또는 Visual Studio 솔루션 폴더 선택',
      properties: ['openDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  handle('proj:launchEditor', (id) => projects.launchEditor(String(id)));
  handle('proj:launchSln', (id) => projects.launchSln(String(id)));
  handle('proj:launchAntigravity', (id) => projects.launchAntigravity(String(id)));

  handle('pipe:list', () => pipeline.list());
  handle('pipe:save', (p) => pipeline.save(p));
  handle('pipe:delete', (id) => pipeline.removePipeline(String(id)));
  handle('pipe:start', (id, projectId) =>
    pipeline.start(String(id), projectId ? String(projectId) : undefined));
  handle('pipe:graphValidate', (g, mode) => {
    const graph = require('../../src/core/pipeline-state-graph');
    return mode === 'fingerprint' ? graph.fingerprint(g) : graph.validate(g);
  });
  handle('pipe:graphSimulate', (g,mockResults) => require('../../src/core/pipeline-state-graph').simulate(g,mockResults));
  handle('pipe:resume', (id,state) => pipeline.resume(String(id),state));
  handle('pipe:cancel', (runId) => pipeline.cancel(String(runId)));
  handle('pipe:history', (pipelineId) =>
    pipeline.history(pipelineId ? String(pipelineId) : undefined));
  handle('pipe:readLog', (runId, stepIndex) => pipeline.readLog(String(runId), Number(stepIndex)));
  handle('pipe:flowMap', () => require('../../src/core/delegation-flow').snapshot({ pipeline })); // 실행 중 파이프라인은 위 계층이라 여기서 넘긴다
}

module.exports = { register };

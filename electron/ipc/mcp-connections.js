// IPC: MCP 양방향 연결.
//   registrar  — 이 허브를 각 AI 도구(Claude Code/Antigravity/Gemini/Codex)에 등록 (허브 = 서버)
//   downstream — 허브가 다른 MCP 서버에 접속 (허브 = 호스트)
//   skills     — 스킬 파일을 각 AI 도구에 설치
'use strict';

const { dialog } = require('electron');

const registrar = require('../../src/core/registrar');
const connectors = require('../../src/core/connectors');
const downstream = require('../../src/core/downstream');
const skills = require('../../src/core/skills');

/** @param {import('./register-handlers').IpcContext} ctx */
function register(ctx) {
  const { handle, window } = ctx;

  handle('registrar:register', (targetId, mode) =>
    registrar.register(String(targetId), mode === 'http' ? 'http' : 'stdio'));
  handle('registrar:unregister', (targetId) => registrar.unregister(String(targetId)));
  handle('registrar:snippets', () => registrar.thirdPartySnippets());
  handle('registrar:migrateHttp', (dryRun) => registrar.migrateToHttp({ dryRun: Boolean(dryRun) }));

  // CLI 커넥터(Unity CLI)를 다른 AI 도구에 등록. 브리지는 로컬 디스크에
  // 설치된 사본을 쓴다 — 동기화 폴더를 직접 가리키면 마운트가 흔들릴 때 같이 죽는다.
  handle('conn:status', () => connectors.status());
  handle('conn:install', () => connectors.install());
  handle('conn:register', (targetId, cliId) => connectors.register(String(targetId), String(cliId)));
  handle('conn:unregister', (targetId, cliId) => connectors.unregister(String(targetId), String(cliId)));
  handle('conn:migrate', (dryRun) => connectors.migrate({ dryRun: Boolean(dryRun) }));

  handle('downstream:list', () => downstream.listConfigured());
  handle('downstream:add', (name, spec) => downstream.addServer(String(name), spec || {}));
  handle('downstream:remove', (name) => downstream.removeServer(String(name)));
  handle('downstream:connect', (name) => downstream.connect(String(name)));
  handle('downstream:disconnect', (name) => downstream.disconnect(String(name)));
  handle('downstream:tools', (name) => downstream.listTools(String(name)));
  handle('downstream:presets', () => downstream.presets());
  handle('downstream:autofill', (dryRun) => downstream.autofillLocalSecrets({ dryRun: Boolean(dryRun) }));

  handle('skills:install', (source, targetIds) =>
    require('../../src/core/repository-skills').installExisting(String(source), Array.isArray(targetIds) ? targetIds.map(String) : []));
  handle('skills:list', () => skills.listInstalled());
  handle('skills:remove', (targetId, skillName) => skills.removeSkill(String(targetId), String(skillName)));
  handle('skills:preview', (targetId, skillName) => skills.previewSkill(String(targetId), String(skillName)));
  handle('skills:pick', async () => {
    const res = await dialog.showOpenDialog(window(), {
      title: '스킬 파일 또는 폴더 선택',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Skill', extensions: ['md', 'markdown'] }, { name: 'All', extensions: ['*'] }],
    });
    return res.canceled ? null : res.filePaths[0];
  });
}

module.exports = { register };

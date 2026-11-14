// IPC: 기기 프로필이 보여 줄 화면 — 경량 기기는 같은 오버레이에서 기능 표(feature-profile.js)로 거른다.
'use strict';

/** @param {import('./register-handlers').IpcContext} ctx */
function register({ handle, window }) {
  handle('profile:features', () => require('../../src/core/feature-profile').view());
  const updater = () => require('../../src/core/repository-update');
  handle('profile:repositoryAutoUpdateGet', () => updater().autoUpdateSetting());
  let changing = false;
  handle('profile:repositoryAutoUpdateSet', async enabled => {
    if (typeof enabled !== 'boolean') throw new Error('자동 갱신 선택값이 올바르지 않습니다.');
    const current = await updater().autoUpdateSetting();
    if (changing) return { ...current, error: true, message: '이 PC의 자동 갱신 설정을 저장하고 있습니다.' };
    if (current.blocked || enabled === current.enabled) return current;
    changing = true;
    try {
      if (!enabled) return await updater().setAutoUpdate(false);
      const { dialog } = require('electron');
      const config = require('../../src/core/config').load();
      let repository = config.sharedContext?.repoPath ||
        require('../../src/core/shared-agent-context').manifest()?.sourceRepository ||
        require('../../src/core/shared-repo-memory').repoRoot();
      const fs = require('fs').promises;
      if (repository) repository = await fs.realpath(repository).catch(() => null);
      if (!repository) {
        const selection = await dialog.showOpenDialog(window(), {
          title: 'your-org/your-shared-context 저장소 폴더 선택', properties: ['openDirectory'],
        });
        if (selection.canceled || !selection.filePaths[0]) return { ...current, cancelled: true };
        repository = await fs.realpath(selection.filePaths[0]);
      }
      const confirmation = await dialog.showMessageBox(window(), {
        type: 'question', title: '이 PC의 Hub 자동 갱신',
        message: '이 PC에서 Hub를 시작할 때 새 버전을 확인하고 적용할까요?',
        detail: `저장소: ${repository}\n원격: your-org/your-shared-context (main)\n\n기존 플러그인 갱신 선택은 보존됩니다.`,
        buttons: ['취소', '자동 갱신 켜기'], defaultId: 0, cancelId: 0, noLink: true,
      });
      return confirmation.response === 1 ? await updater().setAutoUpdate(true, repository) : { ...current, cancelled: true };
    } finally { changing = false; }
  });
}

module.exports = { register };

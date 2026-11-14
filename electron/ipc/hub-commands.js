// IPC: 입력창의 /명령·@태그(hub-commands.js — MCP hub_command와 같은 해석기)와 설정 › 외부 연결의 Drive 동기화 폴더.
// 쓰기 명령은 화면이 확인 창을 띄운 뒤에만 confirm=true로 다시 부른다. Drive 설정은 기기 전용(config.local.json)이다.
'use strict';

function register(ctx) {
  const { handle } = ctx;
  const commands = () => require('../../src/core/hub-commands');
  const drive = () => require('../../src/core/drive-sync-folder');
  const deps = () => ({ callApi: require('../../src/mcp/external-connection-tools').callApi });
  handle('cmd:catalog', () => commands().catalog());
  handle('cmd:run', (line, confirm) => commands().run(String(line || ''), { confirm: confirm === true, via: 'ui' }, deps()));
  handle('cmd:driveGet', () => drive().view());
  handle('cmd:driveSave', (input) => drive().save(input || {}));
}

module.exports = { register };

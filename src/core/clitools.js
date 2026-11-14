// CLI 도구를 MCP 서버처럼 다루기 위한 카탈로그 + 실행 파일 자동 감지.
//
// Unity CLI는 그냥 명령줄 프로그램이라 MCP 서버가 아니다. (Antigravity CLI 커넥터는 1.29.0에서
// 뺐다 — 작업자로 쓰는 경로가 없어졌다.)
// src/mcp/cli-bridge.js가 얇은 stdio MCP 서버로 감싸고, 여기서는
//   · 어떤 툴을 노출할지(tools)
//   · 이 컴퓨터에서 실행 파일이 어디 있는지(detect)
// 를 정의한다.
//
// ⚠ 실행 파일 경로를 설정에 저장하지 않는다. 컴퓨터마다 다르므로 실행할 때마다
//   찾는다 — 공유 설정에 절대경로가 박히면 다른 컴퓨터에서 그대로 깨진다.
//   (예전에 `%USERPROFILE%\.mcp-connectors\cli-mcp-bridge.js` 절대경로가 공유
//    설정에 들어가 있어서 다른 컴퓨터에서는 존재하지 않는 파일을 가리켰다.)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');

const NO_INPUT_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };

/** Unity CLI는 배너/대화형 프롬프트를 끄고 JSON으로 받아야 파싱할 수 있다. */
const UNITY_BASE = ['--no-banner', '--non-interactive', '--format', 'json'];

const CLI_TOOLS = {
  unity: {
    label: 'Unity CLI',
    serverName: 'unity-cli',
    envVar: 'UNITY_BIN',
    candidates: [
      path.join(LOCALAPPDATA, 'Unity', 'bin', 'unity.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Unity', 'bin', 'unity.exe'),
    ],
    pathNames: ['unity.exe', 'unity'],
    tools: [
      {
        name: 'unity_run',
        description: 'Run the Unity CLI with arbitrary arguments.',
        inputSchema: {
          type: 'object',
          properties: {
            args: { type: 'array', items: { type: 'string' }, description: 'Arguments to pass to the Unity CLI.' },
            json: { type: 'boolean', default: true, description: 'Request JSON output when true.' },
          },
          required: ['args'],
          additionalProperties: false,
        },
        buildArgs(input) {
          if (!Array.isArray(input.args) || !input.args.every((a) => typeof a === 'string')) {
            throw new Error('"args" must be an array of strings');
          }
          if (input.json !== undefined && typeof input.json !== 'boolean') {
            throw new Error('"json" must be a boolean');
          }
          const prefix = input.json === false ? ['--no-banner', '--non-interactive'] : UNITY_BASE;
          return prefix.concat(input.args);
        },
      },
      {
        name: 'unity_status',
        description: 'Get Unity CLI status.',
        inputSchema: NO_INPUT_SCHEMA,
        buildArgs: () => UNITY_BASE.concat(['status']),
      },
      {
        name: 'unity_projects',
        description: 'List Unity projects.',
        inputSchema: NO_INPUT_SCHEMA,
        buildArgs: () => UNITY_BASE.concat(['projects', 'list']),
      },
      {
        name: 'unity_editors',
        description: 'List installed Unity editors.',
        inputSchema: NO_INPUT_SCHEMA,
        buildArgs: () => UNITY_BASE.concat(['editors', '--installed']),
      },
    ],
  },
};

/** PATH에서 실행 파일을 찾는다. */
function findOnPath(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* 없는 디렉터리 — 넘어감 */
      }
    }
  }
  return null;
}

/**
 * 이 컴퓨터에서 CLI 실행 파일을 찾는다. 우선순위:
 *   1) 환경변수 (UNITY_BIN)
 *   2) 알려진 설치 경로
 *   3) PATH
 * @returns {string|null}
 */
function detect(id) {
  const def = CLI_TOOLS[id];
  if (!def) return null;
  const fromEnv = process.env[def.envVar];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const c of def.candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* 없음 — 다음 후보 */
    }
  }
  const onPath = findOnPath(def.pathNames);
  if (onPath) return onPath;
  return null;
}

/** GUI/진단용 목록. */
function list() {
  return Object.entries(CLI_TOOLS).map(([id, def]) => {
    const bin = detect(id);
    return {
      id,
      label: def.label,
      serverName: def.serverName,
      bin: bin || '',
      available: Boolean(bin),
      toolNames: def.tools.map((t) => t.name),
      dataDirs: (def.dataDirs || []).filter((d) => fs.existsSync(d)),
    };
  });
}

function get(id) {
  return CLI_TOOLS[id] || null;
}

module.exports = { CLI_TOOLS, detect, list, get, findOnPath, ids: () => Object.keys(CLI_TOOLS) };

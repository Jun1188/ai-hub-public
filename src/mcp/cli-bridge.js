// CLI 도구를 stdio MCP 서버로 감싸는 얇은 브리지.
//
//   node src/mcp/cli-bridge.js unity
//
// Unity CLI는 MCP 서버가 아니라 그냥 명령줄 프로그램이다.
// 허브(그리고 Claude Code·Antigravity 같은 다른 AI 도구)는 MCP만 말할 수 있으므로
// 이 브리지가 JSON-RPC(stdio)를 받아 CLI 실행으로 바꿔준다.
//
// 노출할 툴 목록과 실행 파일 위치는 src/core/clitools.js가 정한다. 실행 파일은
// 실행 시점에 이 컴퓨터에서 찾으므로 설정에 절대경로가 남지 않는다.
//
// SDK를 쓰지 않고 프로토콜을 직접 다룬다 — 이 브리지는 다른 AI 도구의 설정에도
// 등록되어 허브 없이 단독으로 돌 수 있어야 해서 의존성이 없는 편이 낫다.
'use strict';

const { execFile } = require('child_process');
const readline = require('readline');
const path = require('path');

/**
 * 이 파일은 두 곳에서 실행된다:
 *   · 앱 안 (src/mcp/) — clitools는 ../core/clitools.js
 *   · 허브가 설치한 독립 복사본 (%APPDATA%/ai-hub/connectors/) — 같은 폴더에 나란히
 * 외부 AI 도구(Claude Code·Antigravity)는 설치된 복사본을 가리킨다. 앱 소스를 직접
 * 가리키면 동기화 폴더가 잠깐 사라져도 그 도구들의 MCP 서버가 통째로 죽는다.
 */
function loadLocal(fileName) {
  const candidates = [
    path.join(__dirname, fileName),               // 설치된 복사본
    path.join(__dirname, '..', 'core', fileName), // 앱 안
  ];
  for (const p of candidates) {
    try {
      return require(p);
    } catch (err) {
      if (err.code !== 'MODULE_NOT_FOUND') throw err;
    }
  }
  process.stderr.write(`${fileName}를 찾을 수 없습니다.\n`);
  process.exit(1);
  return null;
}

const clitools = loadLocal('clitools.js');
const consoleText = loadLocal('console-text.js');

const targetName = process.argv[2];
const target = clitools.get(targetName);

if (!target) {
  process.stderr.write(`Usage: node cli-bridge.js <${clitools.ids().join('|')}>\n`);
  process.exit(1);
}

const EXEC_TIMEOUT_MS = 180000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function resultResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(text, isError) {
  return { content: [{ type: 'text', text: String(text) }], isError: Boolean(isError) };
}

function combineOutput(stdout, stderr) {
  const out = stdout == null ? '' : String(stdout);
  const err = stderr == null ? '' : String(stderr);
  if (!err) return out;
  if (!out) return err;
  return out.endsWith('\n') ? out + err : `${out}\n${err}`;
}

function formatExecutionError(error, stdout, stderr) {
  const parts = [
    `CLI execution failed: ${(error && error.message) || String(error)}`,
    `Code: ${error && error.code !== undefined ? String(error.code) : 'undefined'}`,
  ];
  if (stdout) parts.push(`stdout:\n${String(stdout)}`);
  if (stderr) parts.push(`stderr:\n${String(stderr)}`);
  return parts.join('\n');
}

function executeCli(bin, args) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      // 출력을 버퍼로 받아 이 컴퓨터의 콘솔 인코딩으로 읽는다. utf8로 고정하면
      // 한국어 Windows(CP949)의 CLI 출력이 U+FFFD로 깨진 채 **AI 모델의 컨텍스트로
      // 그대로 들어간다** — 모델은 그게 깨진 건지 원래 그런 건지 알 수 없다.
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, ...consoleText.RAW_OUTPUT },
      (error, stdout, stderr) => {
        const out = consoleText.decode(stdout);
        const err = consoleText.decode(stderr);
        if (error) resolve(toolResult(formatExecutionError(error, out, err), true));
        else resolve(toolResult(combineOutput(out, err), false));
      }
    );
  });
}

async function callTool(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return toolResult('Invalid tools/call parameters', true);
  }
  if (typeof params.name !== 'string') return toolResult('Tool name must be a string', true);

  const tool = target.tools.find((t) => t.name === params.name);
  if (!tool) return toolResult(`Unknown tool: ${params.name}`, true);

  const input = params.arguments === undefined ? {} : params.arguments;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return toolResult('Tool arguments must be an object', true);
  }

  // 실행 직전에 찾는다 — 도중에 설치되거나 옮겨질 수 있으므로 캐시하지 않는다.
  const bin = clitools.detect(targetName);
  if (!bin) {
    return toolResult(
      `${target.label} 실행 파일을 찾지 못했습니다. 설치했다면 ${target.envVar} 환경변수로 경로를 지정하세요.`,
      true
    );
  }

  let args;
  try {
    args = tool.buildArgs(input);
  } catch (error) {
    return toolResult(`Invalid arguments for ${tool.name}: ${(error && error.message) || String(error)}`, true);
  }
  return executeCli(bin, args);
}

function modernRequest(message) {
  const meta = message && message.params && message.params._meta;
  return Boolean(meta && meta['io.modelcontextprotocol/protocolVersion'] === '2026-07-28');
}

function eraResult(message, payload, cacheable) {
  if (!modernRequest(message)) return payload;
  return {
    ...payload,
    resultType: 'complete',
    ...(cacheable ? { ttlMs: 300000, cacheScope: 'private' } : {}),
    _meta: {
      ...(payload._meta || {}),
      'io.modelcontextprotocol/serverInfo': { name: target.serverName, version: '1.1.0' },
    },
  };
}
async function dispatch(message) {
  const isObject = message !== null && typeof message === 'object' && !Array.isArray(message);
  const hasId = isObject && Object.prototype.hasOwnProperty.call(message, 'id');

  try {
    if (!isObject) {
      if (hasId) writeMessage(errorResponse(message.id, -32600, 'Invalid Request'));
      return;
    }

    switch (message.method) {
      case 'server/discover':
        if (hasId) writeMessage(resultResponse(message.id, eraResult(message, {
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {} },
          instructions: target.label + ' CLI tools exposed without session state.',
        }, true)));
        return;

      case 'initialize':
        if (hasId) {
          writeMessage(resultResponse(message.id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: target.serverName, version: '1.0.0' },
          }));
        }
        return;

      case 'notifications/initialized':
        return;

      case 'tools/list':
        if (hasId) {
          writeMessage(resultResponse(message.id, eraResult(message, {
            tools: target.tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })).sort((a, b) => a.name.localeCompare(b.name)),
          }, true)));
        }
        return;

      case 'tools/call': {
        const result = await callTool(message.params);
        if (hasId) writeMessage(resultResponse(message.id, eraResult(message, result, false)));
        return;
      }

      case 'ping':
        if (hasId) writeMessage(resultResponse(message.id, {}));
        return;

      default:
        if (hasId) writeMessage(errorResponse(message.id, -32601, 'Method not found'));
    }
  } catch (error) {
    const text = (error && error.message) || String(error);
    if (hasId) writeMessage(errorResponse(message.id, -32603, text));
    else process.stderr.write(`Internal notification error: ${text}\n`);
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });

input.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    process.stderr.write(`JSON parse error: ${(error && error.message) || String(error)}\n`);
    writeMessage(errorResponse(null, -32700, 'Parse error'));
    return;
  }
  void dispatch(message);
});

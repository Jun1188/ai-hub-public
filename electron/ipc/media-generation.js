'use strict';

const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const path = require('node:path');
const ENDPOINT = 'http://127.0.0.1:3900/mcp/';
const TOOLS = { speak: 'generate_speech', clone: 'clone_voice' };

function field(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw Error(label + ' 입력을 확인하세요.');
  return value.trim();
}

async function connectVoice() {
  const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
  const client = new Client({ name: 'ai-hub-media', version: '1.0.0' });
  // Never follow a redirect or an OAuth/metadata link with a voice request.
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch(input, options) {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      if (url !== ENDPOINT) throw Error('VoiceStudio 수신 주소가 변경되었습니다.');
      return fetch(input, { ...options, redirect: 'error' });
    },
  });
  try {
    await client.connect(transport);
    if (client.getServerVersion()?.name !== 'VoiceStudio') throw Error('VoiceStudio 서버 식별 실패');
    return client;
  } catch (e) { await client.close().catch(() => {}); throw e; }
}

// Only the desktop dashboard enters here. Callers may select an operation,
// while endpoint, tool name, dialog and exact arguments belong to the main process.
function register(ctx, {
  openVoice = connectVoice, dialog = require('electron').dialog,
  runtime = () => require('../../src/core/local-runtime'),
  withLocalSlot = fn => require('../../src/core/hardware-optimizer').withLocalSlot(fn),
  comfyUrl = () => require('../../src/core/config').load().localRuntimes?.comfyUrl || 'http://127.0.0.1:8188',
} = {}) {
  let busy = false;
  const confirm = async (message, detail) => {
    const parent = ctx.window();
    if (!parent || parent.isDestroyed()) throw Error('Hub 확인 창을 열 수 없습니다.');
    const choice = await dialog.showMessageBox(parent, {
      type: 'question', title: '미디어 생성 요청', message, detail,
      buttons: ['취소', '확인하고 한 번 실행'], defaultId: 0, cancelId: 0, noLink: true,
    });
    return choice.response === 1;
  };
  ctx.handle('media:run', async (p = {}) => {
    if (busy) throw Error('이전 미디어 요청을 마친 뒤 실행하세요.');
    busy = true;
    let client;
    try {
      if (p.kind === 'image') {
        const endpoint = new URL(comfyUrl());
        if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
            endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash)
          throw Error('대시보드 이미지는 이 PC의 ComfyUI 주소가 필요합니다.');
        const workflowFile = field(p.workflowFile, '워크플로', 1024);
        const data = await fs.readFile(workflowFile);
        const workflow = JSON.parse(data.toString('utf8').replace(/^\uFEFF/u, ''));
        const inputs = p.inputs || {};
        if (typeof inputs !== 'object' || Array.isArray(inputs)) throw Error('노드 입력은 JSON 객체여야 합니다.');
        const summary = '수신처 ' + endpoint.origin + '\n워크플로 ' + workflowFile +
          '\n파일 SHA-256 ' + createHash('sha256').update(data).digest('hex') +
          '\n입력 ' + field(JSON.stringify(inputs), '노드 입력', 2400);
        if (!await confirm('ComfyUI에서 이 워크플로를 실행할까요?', summary)) return { status: 'cancelled' };
        const start = performance.now();
        const result = await runtime().comfyWorkflow({ workflowFile, inputs }, { workflow, endpoint: endpoint.origin });
        return { status: 'completed', provider: 'ComfyUI', id: result.promptId, outputs: result.outputs,
          elapsedMs: Math.round(performance.now() - start), cost: null };
      }

      if (!Object.hasOwn(TOOLS, p.kind) && p.kind !== 'discover') throw Error('지원하지 않는 공급자 또는 작업입니다.');
      if (p.kind !== 'discover' && !['own', 'authorized'].includes(p.authority)) throw Error('음성 사용 권한을 확인하세요.');
      client = await openVoice();
      // FastMCP returns a single page today. Also accept paginated servers.
      const names = new Set(), cursors = new Set();
      let cursor;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        for (const tool of page.tools) names.add(tool.name);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw Error('잘못된 VoiceStudio 도구 페이지입니다.');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (p.kind === 'discover') return { endpoint: ENDPOINT, tools: Object.values(TOOLS).filter(name => names.has(name)) };
      const tool = TOOLS[p.kind];
      if (!names.has(tool)) throw Error('VoiceStudio 도구 없음: ' + tool);
      const purpose = field(p.purpose, '용도', 180);
      let args, details;
      if (p.kind === 'clone') {
        const parent = ctx.window();
        if (!parent || parent.isDestroyed()) throw Error('음성 파일 선택 창을 열 수 없습니다.');
        const chosen = await dialog.showOpenDialog(parent, { properties: ['openFile'], title: '복제에 동의한 단일 화자 샘플 선택',
          filters: [{ name: 'Audio', extensions: ['wav', 'flac', 'mp3', 'ogg', 'm4a'] }] });
        if (chosen.canceled || !chosen.filePaths?.[0]) return { status: 'cancelled' };
        const file = chosen.filePaths[0];
        const handle = await fs.open(file, 'r');
        let bytes;
        try {
          const { size } = await handle.stat();
          if (!size || size > 8 * 1024 * 1024) throw Error('8 MiB 이하의 음성 샘플을 선택하세요.');
          bytes = Buffer.alloc(size);
          let offset = 0;
          while (offset < size) {
            const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
            if (!bytesRead) throw Error('읽는 동안 음성 샘플이 변경되었습니다.');
            offset += bytesRead;
          }
          if ((await handle.stat()).size !== size) throw Error('읽는 동안 음성 샘플이 변경되었습니다.');
        } finally { await handle.close(); }
        const name = field(p.profile, '새 프로필 이름', 120);
        args = { name, ref_audio_base64: bytes.toString('base64') };
        details = '새 프로필 ' + name + '\n샘플 ' + path.basename(file) + ' (' + bytes.length + ' bytes)' +
          '\nSHA-256 ' + createHash('sha256').update(bytes).digest('hex');
      } else {
        args = { profile_id: field(p.profile, '음성 프로필 ID', 120), text: field(p.text, '대본', 1600) };
        details = '프로필 ' + args.profile_id + '\n대본\n' + args.text;
      }
      const authority = p.authority === 'own' ? '본인 목소리' : '화자가 이 용도에 동의한 목소리';
      const consent = [authority, '수신처 ' + ENDPOINT, '도구 ' + tool, '용도 ' + purpose, details].join('\n');
      if (!await confirm('선택한 목소리를 이 용도와 수신처에 사용할 권한이 있습니까?', consent)) return { status: 'cancelled' };
      let start;
      const result = await withLocalSlot(() => {
        start = performance.now();
        return client.callTool({ name: tool, arguments: args }, { timeout: 15 * 60 * 1000 });
      });
      if (result.isError) throw Error('VoiceStudio 도구 실행 실패');
      const item = result.content?.find(c => c.type === 'text');
      const payload = JSON.parse(item?.text || '{}');
      if (payload.error) throw Error('VoiceStudio 오류: ' + String(payload.error).slice(0, 250));
      const id = p.kind === 'clone' ? payload.profile_id : payload.audio_id;
      if (typeof id !== 'string' || !/^[\w.-]{1,160}$/u.test(id)) throw Error('VoiceStudio 결과 ID 누락 또는 형식 오류');
      return { status: 'completed', provider: 'VoiceStudio', tool, id, elapsedMs: Math.round(performance.now() - start),
        cost: null, ...(p.kind === 'speak' ? { audio: new URL('/audio/' + id + '.wav', ENDPOINT).href } : {}) };
    } finally { try { if (client) await client.close(); } finally { busy = false; } }
  });
}
module.exports = { register };

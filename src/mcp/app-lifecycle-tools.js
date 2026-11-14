'use strict';
const { z } = require('zod');
const lifecycle = require('../core/app-lifecycle');

function register(server, forward) {
  const tools = {
    hub_lifecycle_status: { readOnly: true, inputSchema: {},
      description: 'Read local Hub lifecycle availability, busy state and existing update approval. No paths or keys.',
      run: () => lifecycle.status() },
    hub_lifecycle_request: { inputSchema: { action: z.enum(['check', 'apply', 'restart']),
      request_id: z.string().uuid(), confirmed: z.literal(true),
      expected_commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional() },
      description: 'Explicit local Hub check, guarded patch application or normal restart. Reuse the request ID after disconnect; never replay with a new ID. Existing device approval and the reviewed expected_commit are required for apply; both update policies use their existing preflight. No installer build, publication or approval enrollment.',
      run: args => lifecycle.request(args) },
    hub_lifecycle_result: { readOnly: true, inputSchema: { request_id: z.string().uuid() },
      description: 'Read the original lifecycle request and authoritative update-worker receipt after reconnect. Unknown or interrupted is not success.',
      run: args => lifecycle.result(args.request_id) },
  };
  for (const [name, tool] of Object.entries(tools)) server.registerTool(name, {
    title: name, description: tool.description, inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: Boolean(tool.readOnly), destructiveHint: !tool.readOnly, openWorldHint: !tool.readOnly },
  }, async args => {
    try {
      if (forward) return await forward(name, args);
      const value = await tool.run(args);
      return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
    } catch {
      return { isError: true, content: [{ type: 'text', text: '수명주기 요청을 완료하지 못했습니다. 같은 요청 ID의 결과와 현재 작업·승인 상태를 확인하세요.' }] };
    }
  });
}
module.exports = { register };

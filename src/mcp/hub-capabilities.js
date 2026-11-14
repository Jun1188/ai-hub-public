'use strict';
// AI 클라이언트에게 어느 상황에 어느 Hub 도구 묶음을 쓸지 알려 주는 지도. 묶음은 Hub 화면의 네 묶음(상태·진단 · 작업 · 지식·분석 · 개선)과 같다.
// INSTRUCTIONS는 요청마다 다시 실리는 고정 앞부분이라 짧게(1,200자 이하) 두고 바이트를 바꾸지 않는다 — 날짜·버전·개수를 넣으면
// 프롬프트 캐시가 깨진다. 도구별 한 줄은 repo://hub/capabilities 자원이 실제로 등록된 도구로 읽을 때 만든다.
const URI = 'repo://hub/capabilities';

// 이름 끝의 *는 접두사. 새 도구가 어느 묶음에도 안 맞으면 scripts/test-mcp-capabilities.js가 실패한다.
const CATEGORIES = [
  { id: 'monitor', label: '상태·진단', when: 'health, slowness, GPU/VRAM, past activity',
    tools: ['hub_status', 'local_resource_status', 'resource_timeline', 'governor_status', 'process_inspect', 'render_monitor',
      'frame_capture_analyze', 'harness_panel*'] },
  { id: 'work', label: '작업', when: 'run or hand off',
    // local_*: local_resource_status는 위 monitor가 정확한 이름으로 먼저 잡는다(categoryOf는 묶음 순서대로 찾는다).
    tools: ['offload_*', 'expert_reprompt', 'devpipeline_*', 'dev_pipeline_graph_*', 'aider_*', 'local_*', 'comfy_*', 'api_*',
      'hub_command', 'hub_lifecycle*', 'club_materials_news', 'downstream_*', 'project_list', 'bus_*', 'harness_compat', 'creation_studio_*', 'herdr_*'] },
  { id: 'knowledge', label: '지식·분석', when: 'source file:line, graphs, binaries, skills',
    tools: ['symbol_*', 'source_*', 'ue_*', 'render_pipeline_*', 'deep_analysis_briefing', 'knowledge_graph_*', 'analysis_*', 'skill_*',
      'url_reference*', 'gamer_lens_*'] },
  { id: 'improve', label: '개선', when: 'evaluate, propose; a human approves',
    tools: ['rsi_*', 'eval_run', 'upstream_sync_check', 'research_review_*', 'script_safety_scan'] },
];
const ROUTE = { id: 'route', label: '도구 고르기', when: 'only when unsure which tool fits', tools: ['tool_route*'] };

const INSTRUCTIONS = [
  'Hub tool map (UI groups). Call a tool you know directly; tool_route only when unsure. Deterministic tools (no model call) '
    + 'before model-backed ones. offload_run: read files under ~25 KB yourself (context re-sent); local over ~25 KB; '
    + 'agy (~100 KB+) and codex only on request. Offload/Aider/analysis output is a proposal to review, never auto-applied.',
  ...CATEGORIES.map((c) => `- ${c.id} (${c.label}) - ${c.when}: ${c.tools.join(', ')}.`),
  `One line per tool: ${URI}.`,
].join('\n');

const matches = (pattern, name) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern);
function categoryOf(name) {
  return [...CATEGORIES, ROUTE].find((c) => c.tools.some((p) => matches(p, name))) || null;
}

function describe(tools) {
  const line = (t) => {
    const first = String(t.description || '').split(/(?<=\.)\s/)[0].replace(/\s+/g, ' ').slice(0, 220);
    return `- ${t.name}${t.title ? ` — ${t.title}` : ''}${first ? `: ${first}` : ''}`;
  };
  const groups = [...CATEGORIES, ROUTE, { id: 'other', label: '분류 없음', when: 'not mapped yet' }].map((c) => ({ ...c, rows: [] }));
  for (const t of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const id = (categoryOf(t.name) || { id: 'other' }).id;
    groups.find((g) => g.id === id).rows.push(line(t));
  }
  return ['# Hub capabilities', INSTRUCTIONS, ...groups.filter((g) => g.rows.length)
    .map((g) => `\n## ${g.id} (${g.label}) - ${g.when}\n${g.rows.join('\n')}`)].join('\n');
}

/** @param {() => Array<{name:string,title?:string,description?:string}>} listTools 모델에게 보이는 등록 도구 */
function register(server, listTools) {
  server.registerResource('hub-capabilities', URI, {
    mimeType: 'text/markdown', description: 'Which Hub tool group fits which situation, one line per registered tool.',
  }, async () => ({ contents: [{ uri: URI, mimeType: 'text/markdown', text: describe(listTools()) }] }));
}

module.exports = { register, categoryOf, INSTRUCTIONS, CATEGORIES, ROUTE, URI };

'use strict';
const { dialog, shell } = require('electron');
const graph = require('../../src/core/knowledge-graph');
const repository = require('../../src/core/repository-skills');
function register({ handle, send, window }) {
  handle('kg:sources', () => graph.sources());
  handle('kg:query', options => graph.query(options || {}));
  handle('kg:addresses', options => require('../../src/core/graph-addresses').format(options || {}));
  handle('kg:detail', (key, node) => graph.detail(String(key), String(node)));
  handle('kg:refresh', key => graph.refresh(String(key)));
  handle('kg:cancel', key => graph.cancel(String(key)));
  handle('kg:original', async (key, node) => {
    const error = await shell.openPath(await graph.original(String(key), String(node)));
    if (error) throw new Error(error);
    return { opened: true };
  });
  handle('kg:pick', async () => {
    const result = await dialog.showOpenDialog(window(), { title: '디렉터리 또는 Obsidian 볼트', properties: ['openDirectory'] });
    return result.canceled ? '' : result.filePaths[0];
  });
  handle('kg:build', async options => graph.buildDirectory(options || {}, p => send('kg:progress', p)));
  handle('kg:import', async folder => graph.importVault(String(folder), p => send('kg:progress', p)));
  handle('kg:export', key => graph.exportVault(String(key)));
  // 실제 참조 빈도(스킬 사용 기록) — 그래프 노드 크기와 사용도 필터에 쓴다. 없으면 빈 표.
  handle('kg:usage', async () => {
    try { return { usage: await require('../../src/core/cache/skill-index').usageCounts() }; }
    catch { return { usage: {} }; }
  });
  // 시간별 지표(스킬 검색·찾지 못함·사용·참조까지 miss·캐시·경로 표)와 그 수치에서 나온 RSI 제안.
  handle('kg:metrics', days => require('../../src/core/knowledge-metrics').snapshot({ days: Number(days) || 30 }));
  // Claude Code·Codex 로그에서 스킬 사용을 지금 모은다(배경에서도 30분마다). 스킬 id·하네스·시각만 더한다.
  handle('kg:collect', () => require('../../src/core/harness-skill-log').collect());
  handle('kg:metricsBrief', async () => require('../../src/core/rsi/metric-proposals').brief(await require('../../src/core/knowledge-metrics').snapshot({ days: 30 })));
  handle('kg:propose', options => require('../../src/core/rsi/metric-proposals').submitUserProposal(options || {}));
  // AI 제안은 몇 분 걸릴 수 있다 — 바로 답하고 결과는 kg:aiDone으로 보낸다. 큐에는 제안만 들어간다(사람이 승인).
  handle('kg:aiPropose', options => {
    const o = options || {};
    require('../../src/core/rsi/metric-proposals').aiPropose({ worker: ['local', 'codex', 'agy'].includes(o.worker) ? o.worker : 'local', note: String(o.note || '') })
      .then(result => send('kg:aiDone', { result }), error => send('kg:aiDone', { error: error.message }));
    return { started: true };
  });
  handle('kg:proposals', async () => (await require('../../src/core/rsi/research-agents').list()).slice(0, 80)
    .map(p => ({ id: p.id, title: p.title, origin: p.origin, state: p.state, targets: p.targets, verdict: p.review?.verdict || null })));
  handle('kg:openObsidian', async key => {
    const obsidian = require('../../src/core/obsidian/obsidian-link');
    const folder = obsidian.paths().vault;
    const result = await dialog.showMessageBox(window(), { type: 'question', buttons: ['Obsidian으로 열기', '폴더만 열기'], defaultId: 0,
      message: '현재 그래프를 관리 볼트에 매핑합니다.', detail: '수집한 모든 원본과 현재 그래프를 합칩니다. 기존 사용자 편집은 보존합니다.\n' + folder });
    const mapped = await obsidian.autoIndex({ keys: [...new Set(['all:knowledge', String(key)])] });
    const detected = await obsidian.detect();
    const vault = { folder, nodes: mapped.sync.nodes, warnings: [], sync: mapped.sync };
    if (mapped.sync.keptUserEdits.length) vault.warnings.push(`사용자 편집 보존: ${mapped.sync.keptUserEdits.length}개. 해당 노트는 자동 갱신하지 않았습니다.`);
    if (mapped.sync.archive) vault.warnings.push('이전 생성 노트 복구 위치: ' + mapped.sync.archive);
    if (result.response === 0 && detected.registered) {
      try { await shell.openExternal('obsidian://open?vault=' + encodeURIComponent(detected.vaultId) + '&file=' + encodeURIComponent('Hub Index')); }
      catch { const error = await shell.openPath(folder); if (error) throw new Error(error); return { ...vault, opened: 'folder', reason: 'Obsidian 프로토콜을 열지 못해 볼트 폴더를 열었습니다.' }; }
      return { ...vault, opened: 'obsidian-requested' };
    }
    const error = await shell.openPath(folder); if (error) throw new Error(error);
    return { ...vault, opened: 'folder', reason: result.response === 0 ?
      '볼트가 아직 등록되지 않았습니다. Obsidian에서 이 폴더를 볼트로 열어 주세요. 앱 실행 중에는 등록 설정을 변경하지 않습니다.' : '' };
  });
  handle('repoSkills:list', query => repository.list(String(query || '')));
  handle('repoSkills:preview', file => repository.preview(String(file)));
  handle('repoSkills:install', (file, targets) => repository.install(String(file), Array.isArray(targets) ? targets.map(String) : []));
  handle('repoSkills:add', async options => { const result = await repository.add(options || {}); graph.invalidate(); return result; });
  handle('repoSkills:update', async () => { const result = await repository.update(); graph.invalidate(); return result; });
}
module.exports = { register };

// Live delegation map: roles as nodes, measured traffic as edges. Numbers come from pipe:flowMap (in-memory counters);
// polls every 3 s only while the pipelines tab is visible.
'use strict';
(() => {
  const ROLES = [['deterministic', '결정적 도구', '심볼·cvar·그래프'], ['offload', 'offload', '위임'], ['local-model', '로컬 모델 설명', 'source_qa 등'],
    ['aider', 'Aider', '로컬 편집'], ['pipelines', '파이프라인', '상태 그래프'], ['resources', '자원·상태', ''], ['downstream', '다운스트림 MCP', ''], ['other', '기타', '']];
  const kb = b => (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
  let pending = false;
  function draw(m) {
    const used = ROLES.filter(([id]) => m.roles[id] || ['offload', 'pipelines'].includes(id));
    const rowH = 54, height = Math.max(used.length * rowH + 20, 200), o = m.offload.totals;
    let svg = `<svg class="flow-map" viewBox="0 0 900 ${height}" width="100%" role="img" aria-label="위임 흐름"><defs><marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" class="pg-arrowhead"/></marker></defs>`;
    svg += `<g class="flow-node flow-main" transform="translate(10,${height / 2 - 30})"><rect width="170" height="60" rx="10"/><text x="12" y="25">메인 에이전트</text><text x="12" y="45" class="pg-sub">Codex·Claude (MCP)</text></g>`;
    used.forEach(([id, label, sub], i) => {
      const r = m.roles[id] || { calls: 0, bytes: 0, errors: 0 }, y = 10 + i * rowH;
      svg += `<path class="pg-edge ${r.calls ? 'flow-active' : ''}" d="M180,${height / 2} C260,${height / 2} 260,${y + 22} 330,${y + 22}" marker-end="url(#flow-arrow)"/>`
        + `<text x="200" y="${y + 18}" class="flow-label">${r.calls}회 · ${kb(r.bytes)}${r.errors ? ' · 오류 ' + r.errors : ''}</text>`
        + `<g class="flow-node" transform="translate(330,${y})"><rect width="200" height="44" rx="8"/><text x="10" y="18">${esc(label)}</text><text x="10" y="35" class="pg-sub">${esc(sub)}</text></g>`;
      if (id === 'offload') {
        const active = m.offload.active.length, byWorker = {};
        for (const r of m.offload.recent) byWorker[r.worker] = (byWorker[r.worker] || 0) + 1;
        const workers = Object.entries(byWorker).map(([w, n]) => `${w === 'agy' ? 'Gemini(agy)' : w} ${n}`).join(' · ');
        svg += `<path class="pg-edge" d="M530,${y + 22} L600,${y + 22}" marker-end="url(#flow-arrow)"/>`
          + `<g class="flow-node ${active ? 'pg-live' : ''}" transform="translate(600,${y - 4})"><rect width="290" height="52" rx="8"/>`
          + `<text x="10" y="18">작업자 ${active ? '실행 중 ' + active : '대기'} · ${esc(workers || '스키마 검증')}</text>`
          + `<text x="10" y="38" class="pg-sub">최근 ${m.offload.recent.length}: 성공 ${o.succeeded} · 거절 ${o.declined} · 실패 ${o.failed} · 출력 ${o.outputTokens} tok · ${o.energyWh} Wh</text></g>`;
      }
      if (id === 'pipelines' && m.pipelines.length) svg += `<text x="540" y="${y + 26}" class="flow-label">${m.pipelines.map(p => esc(p.name) + ' @ ' + esc(p.nodeId || '시작')).join(' · ')}</text>`;
    });
    const total = Object.values(m.roles).reduce((a, r) => a + r.bytes, 0);
    $('flow-map').innerHTML = svg + '</svg>';
    $('flow-summary').textContent = `이 Hub가 메인 에이전트에 돌려준 응답 ${kb(total)} (토큰 근사 ${Math.round(total / 4)}) · 자원 기록 ${m.telemetry.running ? '동작' : '중지'} · 프로세스 재시작 시 0부터 셉니다.`;
  }
  async function refresh() {
    if (pending || document.hidden || !$('tab-pipelines')?.classList.contains('active')) return;
    pending = true;
    try { draw(await call(window.hub.pipeFlowMap)); } catch (e) { $('flow-summary').textContent = '흐름 정보를 읽지 못했습니다: ' + e.message; }
    finally { pending = false; }
  }
  setInterval(refresh, 3000);
})();

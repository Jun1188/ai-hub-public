'use strict';
// 지식 그래프 위·아래 칸: 스킬 참조 지표의 시간별 추이(skill_find · 찾지 못함 · 사용 · 참조까지 miss · 캐시 · 경로 표)와
// 그 수치로 쓰는 개선 방향 → RSI 제안 큐. 승인은 자가개선 탭에서 사람이 하고, 승인은 작업 지시서만 남긴다(규칙 10).
(() => {
  let snap = null, loadedAt = 0, days = 30;
  const sum = (rows, f) => rows.reduce((s, r) => s + (r[f] || 0), 0);
  const ratio = (a, b) => (b ? a / b : null);
  const pct = (v) => (v == null ? '-' : Math.round(v * 100) + '%');
  const fixed = (v) => (v == null ? '-' : v.toFixed(2));
  const HARNESS = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', 'gemini-cli': 'Gemini CLI', 'claude-desktop': 'Claude 데스크톱',
    cursor: 'Cursor', vscode: 'VS Code', 'ai-hub': 'Hub', script: '스크립트', unknown: '미상', other: '기타' };
  const harnessName = (h) => HARNESS[h] || h;
  const byText = (by) => Object.entries(by || {}).sort((a, b) => b[1] - a[1]).map(([h, n]) => `${harnessName(h)} ${n}`).join(' · ');

  /** 값 배열(빈 날은 null)을 작은 꺾은선으로. 색은 currentColor라 CSS가 정한다. */
  function sparkline(values, w = 120, h = 28) {
    const v = (values || []).map((x) => (x == null ? null : Number(x)));
    const nums = v.filter((x) => x != null);
    if (!nums.length) return `<svg class="kg-spark" width="${w}" height="${h}" aria-hidden="true"></svg>`;
    const max = Math.max(...nums), min = Math.min(0, ...nums), span = max - min || 1;
    const pts = v.map((x, i) => (x == null ? null : `${(i / Math.max(1, v.length - 1) * (w - 4) + 2).toFixed(1)},${(h - 3 - (x - min) / span * (h - 6)).toFixed(1)}`)).filter(Boolean);
    return `<svg class="kg-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline fill="none" stroke="currentColor" stroke-width="1.5" points="${pts.join(' ')}"/></svg>`;
  }

  async function load(force = false) {
    if (!force && snap && Date.now() - loadedAt < 60000) return snap;
    try { snap = await call(window.hub.knowledgeMetrics, days); loadedAt = Date.now(); } catch (e) { snap = null; if ($('kgm-tiles')) $('kgm-tiles').textContent = '지표를 읽지 못했습니다: ' + e.message; }
    return snap;
  }

  // 최근 7일 값과 그 전 7일 대비 변화. better: 늘면 좋은 지표인지(사용·적중률) 줄면 좋은 지표인지(찾지 못함·miss).
  function tile(label, now, before, format, series, better, hint) {
    const delta = now == null || before == null ? '' : now === before ? '변화 없음' : `${now > before ? '▲' : '▼'} ${format(Math.abs(now - before))}`;
    const good = now != null && before != null && now !== before && ((now > before) === better);
    return `<div class="kgm-tile" title="${esc(hint)}"><small>${esc(label)}</small><b>${esc(format(now))}</b>`
      + `<small class="${delta && delta !== '변화 없음' ? (good ? 'good' : 'bad') : ''}">${esc(delta || '이전 7일 기록 없음')}</small>${sparkline(series)}</div>`;
  }

  function render() {
    const panel = $('kgm-panel'); if (!panel || !snap) return;
    const s = snap.series, week = s.slice(-7), prev = s.slice(-14, -7);
    const cacheAvg = (rows) => { const r = rows.filter((x) => x.cacheHitRatio != null); return r.length ? sum(r, 'cacheHitRatio') / r.length : null; };
    const count = (n) => (n == null ? '-' : String(Math.round(n)));
    $('kgm-tiles').innerHTML = [
      tile('스킬 검색 (skill_find)', sum(week, 'finds'), prev.length ? sum(prev, 'finds') : null, count, s.map((r) => r.finds), true, '에이전트가 스킬을 찾은 횟수'),
      tile('찾지 못함 비율', ratio(sum(week, 'notFound'), sum(week, 'finds')), ratio(sum(prev, 'notFound'), sum(prev, 'finds')), pct, s.map((r) => ratio(r.notFound, r.finds)), false, 'skill_find가 notFound를 돌려준 비율'),
      tile('참조까지 평균 miss', ratio(sum(week, 'misses'), sum(week, 'found')), ratio(sum(prev, 'misses'), sum(prev, 'found')), fixed, s.map((r) => ratio(r.misses, r.found)), false, '실제로 쓴 스킬이 검색에 나오기 전까지 빗나간 검색 수(같은 탐색 30분 안)'),
      tile('쓴 스킬의 평균 검색 순위', ratio(sum(week, 'rankSum'), sum(week, 'ranked')), ratio(sum(prev, 'rankSum'), sum(prev, 'ranked')), fixed, s.map((r) => ratio(r.rankSum, r.ranked)), false, '실제로 쓴 스킬이 그 검색 결과의 몇 번째였나(1 = 맨 위). 검색 분석의 클릭 순위와 같은 지표'),
      tile('실제 사용 (skill_use · 하네스 로그)', sum(week, 'uses'), prev.length ? sum(prev, 'uses') : null, count, s.map((r) => r.uses), true, '스킬을 읽고 적용한 횟수: Hub skill_use + Claude Code·Codex 로그에서 모은 세션별 사용(Hub를 거치지 않아도 센다)'),
      tile('캐시 적중률', cacheAvg(week), cacheAvg(prev), pct, s.map((r) => r.cacheHitRatio), true, '지역성 캐시(스킬 색인·임베딩) 적중 비율'),
    ].join('') + `<div class="kgm-tile" title="tool_route가 맞는 경로를 못 찾은 의도"><small>경로 표 빗나간 의도 (누적)</small><b>${snap.routes.total}</b><small>${esc(snap.routes.top[0] ? '가장 많음: ' + snap.routes.top[0].example.slice(0, 40) : '기록 없음')}</small></div>`
      + harnessTiles();
    const c = snap.collector && snap.collector.lastRun;
    $('kgm-collect-state').textContent = c ? `하네스 로그 수집 ${new Date(c.at).toLocaleString('ko-KR')} · 새 사용 ${c.added} · 파일 ${c.files}개 · ${Math.round(c.bytes / 1024)} KB 읽음${c.errors && c.errors.length ? ' · 오류 ' + c.errors.join(', ') : ''}` : '하네스 로그 수집 기록 없음 (Hub 시작 2분 뒤, 이후 30분마다)';
    const skills = Object.entries(snap.skills);
    const hard = skills.filter(([, x]) => x.found).sort((a, b) => b[1].misses / b[1].found - a[1].misses / a[1].found).slice(0, 8);
    const unused = skills.filter(([id, x]) => x.shown && !x.uses && !(snap.lifetime || {})[id]).sort((a, b) => b[1].shown - a[1].shown).slice(0, 8);
    const name = (id) => id.replace(/^skill:/, '');
    $('kgm-hard').innerHTML = hard.length ? '<tr><th>스킬</th><th>사용</th><th>평균 miss</th><th>평균 순위</th><th>노출</th><th>추이</th></tr>' + hard.map(([id, x]) => `<tr><td><button class="kg-link" data-kgm-skill="${esc(id)}">${esc(name(id))}</button></td><td>${x.uses}</td><td class="${x.misses / x.found >= 2 ? 'warn' : ''}">${(x.misses / x.found).toFixed(1)}</td><td>${fixed(ratio(x.rankSum, x.ranked))}</td><td>${x.shown}</td><td>${sparkline(x.daily, 90, 20)}</td></tr>`).join('')
      : '<tr><td class="hint">검색을 거친 사용 기록이 아직 없습니다. 에이전트가 skill_find → skill_use를 쓰면 쌓입니다.</td></tr>';
    $('kgm-missed').innerHTML = (snap.notFound.length ? snap.notFound.slice(0, 8).map((n) => `<li><button class="kg-link" data-kgm-query="${esc(n.q)}">"${esc(n.q)}"</button> × ${n.count} <small class="hint">${esc((n.last || '').slice(0, 10))}</small></li>`).join('') : '<li class="hint">찾지 못한 질의 없음</li>')
      + (unused.length ? `<li class="hint" style="margin-top:8px">노출되지만 쓰이지 않는 스킬</li>${unused.map(([id, x]) => `<li><button class="kg-link" data-kgm-skill="${esc(id)}">${esc(name(id))}</button> 노출 ${x.shown}</li>`).join('')}` : '');
  }

  // 하네스별: 기간 안의 스킬 사용(skill_use는 부른 MCP 클라이언트, 로그 수집은 그 하네스)과 Hub MCP 도구 호출(tool-usage.local).
  function harnessTiles() {
    const uses = Object.values(snap.harness || {}).reduce((a, b) => a + b, 0);
    const logUses = sum(snap.series, 'logUses');
    const calls = snap.hubCalls || { total: 0, harnesses: {} };
    const callBy = Object.fromEntries(Object.entries(calls.harnesses || {}).map(([h, r]) => [h, r.calls]));
    const top = Object.entries(calls.harnesses || {}).sort((a, b) => b[1].calls - a[1].calls)[0];
    return `<div class="kgm-tile kgm-wide" title="스킬을 쓴 하네스. Claude Code·Codex는 자기 로그에서(Hub를 거치지 않아도), 그 밖은 skill_use로"><small>하네스별 스킬 사용 (${snap.days}일)</small><b>${uses}</b><small>${esc(byText(snap.harness) || '기록 없음')}</small><small>그중 로그에서 모음 ${logUses}</small></div>`
      + `<div class="kgm-tile kgm-wide" title="MCP 클라이언트별 Hub 도구 호출(tool-usage.local). 하네스가 Hub를 언제 쓰는지의 효과 측정"><small>하네스별 Hub 호출 (${calls.days || snap.days}일)</small><b>${calls.total}</b><small>${esc(byText(callBy) || '기록 없음')}</small>`
      + `<small>${top ? esc(`${harnessName(top[0])} 상위: ${top[1].top.slice(0, 3).map((t) => `${t.tool} ${t.calls}`).join(', ')}`) : ''}</small></div>`;
  }

  async function renderRecent() {
    const host = $('kgm-recent'); if (!host) return;
    try {
      const rows = (await call(window.hub.knowledgeProposals)).filter((p) => /^(knowledge-metrics|user:knowledge-graph)/.test(p.origin)).slice(0, 10);
      host.innerHTML = rows.length ? rows.map((p) => `<div class="row"><button class="kg-link" data-kgm-proposal="${esc(p.id)}">${esc(p.title)}</button><span class="hint">${esc(p.state)}${p.verdict ? ' · 검토 ' + esc(p.verdict) : ''} · ${esc(p.origin)}</span></div>`).join('')
        : '<p class="hint">아직 지표에서 나온 제안이 없습니다. 자가개선 탭의 "제안 수집 → 검토"도 이 지표를 읽습니다.</p>';
    } catch (e) { host.textContent = e.message; }
  }

  function mount() {
    const panel = $('kgm-panel'); if (!panel || panel.dataset.ready) return;
    panel.dataset.ready = '1';
    panel.innerHTML = `<div class="kg-heading"><div><h2>스킬 참조 지표</h2><p class="hint">이 PC의 에이전트가 스킬을 찾고 쓴 기록 · 최근 7일 값과 그 전 7일 대비 · 꺾은선은 기간 전체</p></div>
      <div class="row"><select id="kgm-days" aria-label="기간"><option value="14">14일</option><option value="30" selected>30일</option><option value="90">90일</option></select><button id="kgm-reload" class="small">새로 고침</button><button id="kgm-collect" class="small" title="Claude Code·Codex 세션 로그의 새 줄에서 스킬 사용만 읽는다(스킬 id·하네스·시각만 남김)">하네스 로그에서 다시 모으기</button></div></div>
      <p id="kgm-collect-state" class="hint" aria-live="polite"></p>
      <div id="kgm-tiles" class="kgm-tiles">읽는 중…</div>
      <div class="grid2"><div><h3>찾기 어려운 스킬 <span class="hint">이름을 누르면 그래프에서 엽니다</span></h3><table id="kgm-hard" class="table"></table></div>
      <div><h3>자주 찾지 못한 질의 <span class="hint">누르면 그 질의로 개선 방향 초안</span></h3><ul id="kgm-missed" class="kgm-list"></ul></div></div>`;
    $('kgm-improve').innerHTML = `<h2>개선 방향 → RSI 제안</h2>
      <p class="hint">위 수치를 근거로 방향을 적어 제안 큐에 넣거나, 같은 수치를 AI에게 보여 제안을 받습니다. 둘 다 자가개선 탭의 제안 큐로 가서 검토를 거치고, 사람이 승인해야 작업 지시서가 됩니다 — 코드는 자동으로 바뀌지 않습니다.</p>
      <label>제목</label><input id="kgm-title" placeholder="예: discernment-nudge 설명에 실제 질의 표현 넣기" />
      <label>개선 방향 (AI에게 줄 프롬프트로도 씁니다)</label><textarea id="kgm-prompt" rows="7" placeholder="어떤 수치가 문제인지, 무엇을 바꾸면 그 수치가 어떻게 바뀔지 적습니다."></textarea>
      <label>대상 경로 (쉼표로 구분, 선택)</label><input id="kgm-targets" placeholder="skills/review/discernment-nudge/SKILL.md" />
      <div class="row"><button id="kgm-draft" class="small">현재 수치로 초안 채우기</button><button id="kgm-submit" class="primary">제안 큐에 넣기</button>
        <select id="kgm-worker" aria-label="AI 작업자"><option value="local">AI: 로컬 모델</option><option value="codex">AI: Codex</option><option value="agy">AI: Antigravity</option></select>
        <button id="kgm-ai">AI에게 개선 방향 제안받기</button><span id="kgm-state" class="hint" aria-live="polite"></span></div>
      <h3>지표에서 나온 제안</h3><div id="kgm-recent"></div>`;
    $('kgm-days').addEventListener('change', async () => { days = Number($('kgm-days').value); await load(true); render(); window.HubKnowledgeGraph?.redraw(); });
    $('kgm-reload').addEventListener('click', async () => { await load(true); render(); renderRecent(); window.HubKnowledgeGraph?.redraw(); });
    $('kgm-collect').addEventListener('click', async () => {
      const b = $('kgm-collect'); b.disabled = true;
      try { const r = await call(window.hub.knowledgeCollect); toast(`하네스 로그에서 새 스킬 사용 ${r.added}회를 더했습니다.`); await load(true); render(); window.HubKnowledgeGraph?.redraw(); }
      catch (e) { toast(e.message, true); } finally { b.disabled = false; }
    });
    const pick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.kgmSkill) window.HubKnowledgeGraph?.focusSkill(b.dataset.kgmSkill);
      else if (b.dataset.kgmQuery) draft(`스킬 공백: "${b.dataset.kgmQuery}"`, `## 근거\n- skill_find "${b.dataset.kgmQuery}" 가 반복해서 notFound\n\n## 개선 방향\n- `, '');
      else if (b.dataset.kgmProposal) window.HubSelfImprove?.show(b.dataset.kgmProposal);
    };
    panel.addEventListener('click', pick); $('kgm-improve').addEventListener('click', pick);
    $('kgm-draft').addEventListener('click', async () => {
      try { const brief = await call(window.hub.knowledgeMetricsBrief); $('kgm-prompt').value = `${brief}\n\n## 개선 방향\n- `; $('kgm-prompt').focus(); } catch (e) { toast(e.message, true); }
    });
    $('kgm-submit').addEventListener('click', async () => {
      const b = $('kgm-submit'); b.disabled = true;
      try {
        const r = await call(window.hub.knowledgePropose, { title: $('kgm-title').value, prompt: $('kgm-prompt').value, targets: $('kgm-targets').value.split(',').map((t) => t.trim()).filter(Boolean) });
        $('kgm-state').textContent = `제안 ${r.id}를 큐에 넣고 검토했습니다 — 자가개선 탭에서 승인·반려합니다.`;
        renderRecent();
      } catch (e) { toast(e.message, true); } finally { b.disabled = false; }
    });
    $('kgm-ai').addEventListener('click', async () => {
      try {
        $('kgm-ai').disabled = true; $('kgm-state').textContent = 'AI가 수치를 읽고 제안하는 중… (몇 분 걸릴 수 있음)';
        await call(window.hub.knowledgeAiPropose, { worker: $('kgm-worker').value, note: $('kgm-prompt').value });
      } catch (e) { $('kgm-ai').disabled = false; $('kgm-state').textContent = e.message; }
    });
    window.hub.onKnowledgeAiDone?.((p) => {
      $('kgm-ai').disabled = false;
      $('kgm-state').textContent = p.error || p.result.skipped
        || `AI 제안 ${p.result.offered}개 중 새 제안 ${p.result.added}개를 큐에 넣었습니다(${p.result.worker}).${p.result.droppedTargets ? ` 경로가 아닌 대상 ${p.result.droppedTargets}개는 버렸습니다.` : ''}`;
      renderRecent();
    });
  }

  function draft(title, prompt, targets) {
    hubGo('knowledge', 'kgm-improve');
    $('kgm-title').value = title; $('kgm-prompt').value = prompt; $('kgm-targets').value = targets || '';
  }

  window.HubKnowledgeMetrics = {
    sparkline,
    async ensure() { mount(); await load(); render(); },
    /** 그래프 노드의 기간 합계. 스킬이면 기록이 없어도 0으로(안 쓰였다는 것도 수치다), 그 밖은 null. */
    forNode(n) {
      if (!snap) return null;
      // 스킬 수치는 SKILL.md(스킬 노드)에만 — 같은 이름의 스킬 폴더가 사용·마지막 참조를 같이 들면 둘 다 크게 그려져 무엇이 쓰였는지 헷갈린다.
      const skill = n.kind === 'skill';
      const id = skill ? `skill:${n.label}` : `${n.kind}:${n.label}`, x = snap.skills[id], lastUse = (snap.lastUse || {})[id] || null;
      return x ? { ...x, days: snap.days, lastUse } : skill ? { uses: 0, shown: 0, misses: 0, found: 0, byHarness: {}, daily: [], days: snap.days, lastUse } : null;
    },
    /** skill-usage.json의 누적 하네스별 사용(그 스킬이 아니면 null). */
    lifetimeByHarness(n) { return snap && n.kind === 'skill' ? (snap.lifetimeByHarness || {})[`skill:${n.label}`] || null : null; },
    harnessName,
    draftFor(n) {
      const x = this.forNode(n) || { uses: 0, shown: 0, misses: 0, found: 0, days };
      draft(`${n.label} 개선`, `## 근거 (최근 ${x.days}일)\n- 사용 ${x.uses}회, 검색 노출 ${x.shown}회, 참조까지 평균 miss ${x.found ? (x.misses / x.found).toFixed(1) : '-'} (검색을 거친 사용 ${x.found}회), 하네스별 ${byText(x.byHarness) || '-'}\n\n## 개선 방향\n- `, n.repositoryPath || n.path || '');
    },
  };
  document.querySelector('#tabs [data-tab="knowledge"]')?.addEventListener('click', async () => { mount(); await load(true); render(); renderRecent(); });
})();

'use strict';
(() => {
  const views = new Map();
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const statuses = { collected: '수집 시 존재', reported: 'PC 위치 기록 · 현재 미확인', 'location-unknown': '위치 미확인' };
  const origin = n => `${n.computerId || 'PC 미확인'} · ${n.scope || '범위 미확인'} · ${statuses[n.status] || '이전 색인 · 다시 수집 필요'}${n.observedAt ? ' · ' + n.observedAt : ''}`;
  const labels = { contains: '포함', links: '문서 링크', declares: '선언', inherits: '상속', mentions: '언급', calls: '호출', references: '참조', reports: '보고', caches: '캐시', counts: '사용 기록', warms: '예열' };
  // 관계 종류마다 색을 고정한다 — 점·선만으로는 어떤 관계인지 읽을 수 없었다. 포함(구조)은 옅게, 의미 관계는 진하게.
  const relationColors = { contains: '#3a4250', links: '#5b9bd5', inherits: '#e39b4f', calls: '#6cc58a', references: '#4fc1c0', declares: '#b48ee8', mentions: '#7d8796', reports: '#d8c65a', caches: '#c58ac0', counts: '#99ce9f', warms: '#f0a3b5' };
  const relColor = r => relationColors[r] || '#9a8f7c';
  // 역할 = 점 모양(색은 분류, 크기는 참조·사용). 역할과 용도 한 줄은 Hub(src/core/knowledge-roles.js)가 경로 규칙으로 붙인다.
  const ROLE = { skill: ['스킬', 'pip'], catalog: ['카탈로그', 'square'], subskill: ['하위 스킬·참조', 'triangle'], cache: ['캐시', 'hexagon'], log: ['문제 로그', 'triangleDown'],
    memory: ['메모리 노트', 'pentagon'], data: ['데이터·DB', 'diamond'], config: ['설정', 'cross'], doc: ['문서', 'circle'], script: ['스크립트', 'circle'], directory: ['폴더', 'circle'], reference: ['미해결 링크', 'circle'] };
  const roleLabel = r => (ROLE[r] || [r || '기타'])[0];
  const shapeOf = r => (ROLE[r] || [null, 'circle'])[1];
  const POLY = { triangle: [3, -Math.PI / 2, 1.25], triangleDown: [3, Math.PI / 2, 1.25], diamond: [4, 0, 1.2], pentagon: [5, -Math.PI / 2, 1.1], hexagon: [6, 0, 1.1] };
  // 모양의 꼭짓점(캔버스와 범례 SVG가 같은 점을 쓴다). 원은 null.
  const shapePoints = (shape, x, y, r) => {
    if (shape === 'square') { const s = r * 0.9; return [[x - s, y - s], [x + s, y - s], [x + s, y + s], [x - s, y + s]]; }
    if (shape === 'cross') { const a = r * 1.1, b = r * 0.4; return [[-b, -a], [b, -a], [b, -b], [a, -b], [a, b], [b, b], [b, a], [-b, a], [-b, b], [-a, b], [-a, -b], [-b, -b]].map(([u, v]) => [x + u, y + v]); }
    const p = POLY[shape]; if (!p) return null;
    return Array.from({ length: p[0] }, (_, i) => { const t = p[1] + i * 2 * Math.PI / p[0]; return [x + r * p[2] * Math.cos(t), y + r * p[2] * Math.sin(t)]; });
  };
  const roleIcon = (role, color = '#9fb0c6') => {
    const pts = shapePoints(shapeOf(role), 6, 6, 4.2);
    const body = pts ? `<polygon points="${pts.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}" fill="${color}"/>` : `<circle cx="6" cy="6" r="4.2" fill="${color}"/>${shapeOf(role) === 'pip' ? '<circle cx="6" cy="6" r="1.5" fill="#0f1115"/>' : ''}`;
    return `<svg class="kg-role-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">${body}</svg>`;
  };
  const when = ms => !ms ? '-' : new Date(ms).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const harnessText = by => Object.entries(by || {}).sort((a, b) => b[1] - a[1]).map(([h, c]) => `${window.HubKnowledgeMetrics?.harnessName(h) || h} ${c}`).join(' · ');
  // 노드 색 = 분류(스킬은 skills/<분류>/, 그 밖은 종류), 크기 = 참조·사용 단계. 분류 색은 범례에 이름과 함께 나온다.
  const TIER_R = [4, 4.5, 7.5, 11]; // 참조·사용 단계별 점 반지름: 없음(빈 원) · 적음 · 중간 · 많음
  const palette = ['#5b9bd5', '#e39b4f', '#6cc58a', '#bfa3ee', '#e3bb75', '#4fc1c0', '#eb9c8d', '#d8c65a', '#c58ac0', '#99ce9f', '#8996a8', '#f0a3b5'];
  const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a.toFixed(2)})`;
  const segDist = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(p.x - a[0] - t * dx, p.y - a[1] - t * dy); };
  const fmtBytes = b => !Number.isFinite(b) ? '-' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b > 1024 ? Math.round(b / 1024) + ' KB' : b + ' B';
  // 색 묶음: skills/<분류>/ 안이면 그 분류, 밖이면 역할(카탈로그·데이터·캐시…).
  const groupOf = n => { const m = /^skills\/([^/]+)\//.exec(n.path || ''); return m ? m[1] : n.kind === 'skill' ? 'skill' : roleLabel(n.role || n.kind); };
  const invoke = async (fn, ...args) => call(window.hub[fn], ...args);
  const metricsOf = n => window.HubKnowledgeMetrics?.forNode(n) || null;
  const COLUMNS = [['label', '이름'], ['role', '역할'], ['group', '분류'], ['inRefs', '들어오는 참조'], ['used', '누적 사용'], ['uses', '기간 사용'], ['harness', '하네스'], ['shown', '검색 노출'], ['avgMiss', '참조까지 miss'], ['last', '최근 참조'], ['fresh', '최신'], ['bytes', '크기'], ['effect', '효과 지수']];

  class GraphView {
    constructor(host, fixed = '') {
      this.host = host; this.key = fixed; this.fixed = fixed; this.selected = ''; this.focus = ''; this.serial = 0; this.zoom = 1; this.pan = { x: 0, y: 0 };
      this.hiddenRelations = new Set(); this.hiddenGroups = new Set(); this.hiddenRoles = new Set(); this.sort = { col: 'inRefs', desc: true }; this.mode = 'graph';
      host.innerHTML = `<div class="kg-heading"><div><h2>지식 그래프</h2><p class="hint">원본 파일 · 문서 링크 · 분석 근거 · 참조와 사용 수치</p></div><span class="kg-status" aria-live="polite"></span></div>
        <div class="row kg-toolbar"><select class="kg-source" aria-label="그래프 원본"></select><input class="kg-search" placeholder="이름·경로·본문 검색" aria-label="그래프 검색"><button class="kg-find">검색</button><button class="kg-refresh small">원본 다시 읽기</button><span class="kg-modes" role="group" aria-label="보기"><button class="small" data-mode="graph" aria-pressed="true">그래프</button><button class="small" data-mode="table" aria-pressed="false">표</button></span></div>
        <div class="row kg-toolbar"><select class="kg-role" aria-label="역할"><option value="">모든 역할</option></select><select class="kg-kind" aria-label="노드 종류"><option value="">모든 종류</option></select><select class="kg-depth" aria-label="주변 깊이"><option value="1">주변 1단계</option><option value="2">주변 2단계</option><option value="3">주변 3단계</option></select><button class="kg-local small">선택 노드 주변</button><button class="kg-global small">전체 범위</button><select class="kg-arrange" aria-label="배치"><option value="group">배치: 분류별 묶음</option><option value="force">배치: 관계 힘</option></select><select class="kg-usage" aria-label="사용도"><option value="">모든 사용도</option><option value="hot">자주 참조</option><option value="cold">참조 없음</option><option value="hard">찾기 어려움 (miss 많음)</option><option value="heavy">크고 덜 쓰임</option><option value="cached">캐시됨</option><option value="stale">최신 아님</option></select><label class="kg-check"><input type="checkbox" class="kg-structural" checked> 포함 관계 표시</label><button class="kg-export small">볼트 생성</button><button class="kg-obsidian small">Obsidian으로 열기</button></div>
        ${host.id === 'knowledge-workspace' ? `<details class="kg-attachment" hidden><summary>작업 지시에 디렉터리 관계 첨부</summary>
          <div class="row"><button class="kg-from small">선택 노드를 출발점으로</button>
          <select class="kg-relation" aria-label="출발점에서 대상까지의 관계"><option value="contains">포함한다</option><option value="references">참조한다</option><option value="dependsOn">의존한다</option><option value="generates">생성한다</option></select>
          <button class="kg-add-edge small">선택 노드를 대상으로 추가</button><button class="kg-undo-edge small">마지막 관계 제거</button></div>
          <pre class="kg-edge-list" aria-live="polite"></pre><p class="hint">작업실에서 같은 프로젝트를 선택한 뒤 작업 지시에 /graph attach를 입력하고 Enter를 누르세요.</p></details>` : ''}
        <div class="kg-roles" aria-label="역할 범례(점 모양) — 눌러서 숨기기"></div>
        <div class="kg-groups" aria-label="분류 범례 — 눌러서 숨기기"></div>
        <div class="kg-layout"><div class="kg-list" role="list" aria-label="그래프 노드 목록"></div><div class="kg-surface"><canvas class="kg-canvas" aria-label="지식 그래프. 왼쪽 목록이나 표 보기에서도 노드를 선택할 수 있습니다."></canvas><div class="kg-table" hidden></div><div class="kg-gesture">점 모양 = 역할(위 범례) · 점 색 = 분류 · 점 크기 = 참조·사용(빈 모양 = 없음, 큰 점 옆 숫자) · 선 색 = 관계 종류 · 화살촉 = 방향(나가는 쪽 → 들어오는 쪽) · 점선 = 추정 관계 · 빨간 고리 = miss 많음 · 선에 올리면 관계</div><div class="kg-legend" aria-label="관계 범례 — 눌러서 숨기기"></div><div class="kg-tip" hidden></div></div><aside class="kg-detail" aria-live="polite">노드를 선택하면 원본과 백링크, 사용 추이가 표시됩니다.</aside></div>
        <details class="kg-warnings"><summary>수집 범위와 미해결 관계</summary><pre></pre></details>`;
      this.el = cls => host.querySelector('.kg-' + cls);
      this.attachment = { key: '', from: null, edges: [] };
      this.el('from')?.addEventListener('click', () => this.editAttachment('from'));
      this.el('add-edge')?.addEventListener('click', () => this.editAttachment('add'));
      this.el('undo-edge')?.addEventListener('click', () => this.editAttachment('undo'));
      this.el('source').hidden = Boolean(fixed);
      this.el('source').addEventListener('change', () => { this.key = this.el('source').value; this.reset(); this.load(); });
      this.el('find').addEventListener('click', () => { this.focus = ''; this.load(); });
      this.el('search').addEventListener('keydown', e => { if (e.key === 'Enter') { this.focus = ''; this.load(); } });
      this.el('kind').addEventListener('change', () => this.load());
      this.el('role').addEventListener('change', () => this.load());
      this.el('roles').addEventListener('click', e => { const b = e.target.closest('[data-role-key]'); if (!b) return; const r = b.dataset.roleKey; if (this.hiddenRoles.has(r)) this.hiddenRoles.delete(r); else this.hiddenRoles.add(r); this.drawGraph(this.data); });
      this.el('depth').addEventListener('change', () => { if (this.focus) this.load(); });
      this.el('local').addEventListener('click', () => { if (!this.selected) return toast('먼저 노드를 선택하세요.'); this.focus = this.selected; this.el('search').value = ''; this.load(); });
      this.el('global').addEventListener('click', () => { this.focus = ''; this.el('search').value = ''; this.load(); });
      this.el('refresh').addEventListener('click', () => this.refresh(true));
      this.el('modes').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b && b.dataset.mode !== this.mode) { this.mode = b.dataset.mode; this.showMode(); } });
      this.el('arrange').addEventListener('change', () => this.data && this.drawGraph(this.data));
      this.el('usage').addEventListener('change', () => this.data && this.drawGraph(this.data));
      this.el('structural').addEventListener('change', () => { if (this.el('structural').checked) this.hiddenRelations.delete('contains'); else this.hiddenRelations.add('contains'); this.paint?.(); this.legend(); });
      this.el('legend').addEventListener('click', e => { const b = e.target.closest('[data-rel]'); if (!b) return; const r = b.dataset.rel; if (this.hiddenRelations.has(r)) this.hiddenRelations.delete(r); else this.hiddenRelations.add(r); this.el('structural').checked = !this.hiddenRelations.has('contains'); this.paint?.(); this.legend(); });
      this.el('groups').addEventListener('click', e => { const b = e.target.closest('[data-group-key]'); if (!b) return; const g = b.dataset.groupKey; if (this.hiddenGroups.has(g)) this.hiddenGroups.delete(g); else this.hiddenGroups.add(g); this.drawGraph(this.data); });
      this.el('table').addEventListener('click', e => {
        const th = e.target.closest('[data-sort]'); if (th) { const c = th.dataset.sort; this.sort = { col: c, desc: this.sort.col === c ? !this.sort.desc : c !== 'label' && c !== 'group' }; this.renderTable(); return; }
        const tr = e.target.closest('[data-node]'); if (tr) this.select(tr.dataset.node);
      });
      this.el('export').addEventListener('click', () => this.export(false));
      this.el('obsidian').addEventListener('click', () => this.export(true));
      this.el('list').addEventListener('click', e => { const b = e.target.closest('[data-node]'); if (b) this.select(b.dataset.node); });
      this.el('detail').addEventListener('click', async e => {
        const b = e.target.closest('button'); if (!b) return;
        try {
          if (b.dataset.node) this.select(b.dataset.node);
          else if (b.dataset.action === 'original') await invoke('knowledgeOriginal', this.key, this.selected);
          else if (b.dataset.action === 'skill') {
            window.dispatchEvent(new CustomEvent('hub-skill-selected', { detail: { path: this.node.repositoryPath, label: this.node.label } }));
            if (!this.fixed) hubGo('skills', 'skill-selected');
          } else if (b.dataset.action === 'draft') window.HubKnowledgeMetrics?.draftFor(this.node);
          else if (b.dataset.proposal) window.HubSelfImprove?.show(b.dataset.proposal);
        } catch (error) { toast(error.message, true); }
      });
      this.setupCanvas();
    }
    editAttachment(action) {
      if (!this.key?.startsWith('directory:') || this.data?.key !== this.key) return;
      const a = this.attachment;
      if (a.key !== this.key) { a.key = this.key; a.from = null; a.edges = []; }
      const n = this.data.nodes.find(row => row.id === this.selected);
      if (action === 'undo') a.edges.pop();
      else if (!n || n.virtual || n.hubImported || !['file','directory'].includes(n.kind)) return toast('파일 또는 폴더 노드를 선택하세요.', true);
      else if (action === 'from') a.from = { id: n.id, path: n.path };
      else {
        if (!a.from || a.from.id === n.id) return toast('서로 다른 출발점과 대상을 선택하세요.', true);
        const relation = this.el('relation');
        if (a.edges.length >= 16) return toast('한 번에 관계 16개까지 첨부할 수 있습니다.', true);
        if (a.edges.some(e => e.source === a.from.id && e.target === n.id && e.relation === relation.value)) return;
        a.edges.push({ source: a.from.id, target: n.id, relation: relation.value,
          label: `${a.from.path} → ${relation.selectedOptions[0].text} → ${n.path}` });
      }
      this.el('edge-list').textContent = [a.from ? '출발점 ' + a.from.path : '', ...a.edges.map(e => e.label)].filter(Boolean).join('\n');
    }
    reset() { this.selected = ''; this.focus = ''; this.el('search').value = ''; this.el('kind').value = ''; this.el('role').value = ''; this.el('detail').textContent = '노드를 선택하세요.';
      this.attachment = { key: '', from: null, edges: [] };
      if (this.el('edge-list')) this.el('edge-list').textContent = '';
    }
    async refresh(rebuild = false) {
      try {
        this.el('status').textContent = '원본 확인 중…';
        const data = await invoke('knowledgeSources');
        const old = this.key || this.fixed;
        this.el('source').replaceChildren(...data.sources.map(s => new Option(s.label, s.key)));
        this.key = data.sources.some(s => s.key === old) ? old : data.sources[0]?.key;
        this.el('source').value = this.key;
        if (rebuild && this.key) await invoke('knowledgeRefresh', this.key);
        await this.load();
      } catch (e) { this.el('status').textContent = e.message; }
    }
    async load() {
      if (!this.key) return;
      const serial = ++this.serial;
      this.el('status').textContent = '관계 읽는 중…';
      try {
        const data = await invoke('knowledgeQuery', { key: this.key, query: this.el('search').value, focus: this.focus,
          kinds: this.el('kind').value ? [this.el('kind').value] : [], roles: this.el('role').value ? [this.el('role').value] : [], depth: Number(this.el('depth').value), limit: 180 });
        if (serial !== this.serial) return;
        try { this.usage = (await invoke('knowledgeUsage')).usage || {}; } catch { this.usage = {}; }
        try { this.proposals = await invoke('knowledgeProposals'); } catch { this.proposals = []; }
        await window.HubKnowledgeMetrics?.ensure();
        if (serial !== this.serial) return;
        this.data = data;
        if (this.el('attachment')) this.el('attachment').hidden = !this.key.startsWith('directory:');
        const currentKind = this.el('kind').value;
        this.el('kind').replaceChildren(new Option('모든 종류', ''), ...data.kinds.map(k => new Option(k, k)));
        this.el('kind').value = currentKind;
        const currentRole = this.el('role').value;
        this.el('role').replaceChildren(new Option('모든 역할', ''), ...(data.roles || []).map(r => new Option(roleLabel(r), r)));
        this.el('role').value = currentRole;
        this.el('status').textContent = `${data.nodes.length}/${data.totalMatches}개 표시 · 연결 ${data.edges.length}개` + (data.truncated ? ' · 표시 상한 적용' : '');
        this.el('warnings').querySelector('pre').textContent = [data.root, ...(data.warnings || []), data.truncated ? '검색어 또는 종류를 선택해 범위를 좁히세요. 전체 자료는 원본 인덱스에 보존됩니다.' : ''].filter(Boolean).join('\n');
        this.drawGraph(data);
      } catch (e) { if (serial === this.serial) this.el('status').textContent = e.message; }
    }
    renderList() {
      this.el('list').innerHTML = (this.points || []).map(n => `<button class="kg-node${n.id === this.selected ? ' selected' : ''}" data-node="${escape(n.id)}" role="listitem">${roleIcon(n.role, n.color)}<span><b>${escape(n.label)}</b><small>${escape(roleLabel(n.role))} · ${escape(n.group)} · 참조 ${n.m.refs}${n.m.uses ? ' · 30일 사용 ' + n.m.uses : ''}${n.m.avgMiss != null ? ' · miss ' + n.m.avgMiss.toFixed(1) : ''}<br>${escape(n.path)}</small></span></button>`).join('') || '<p class="hint">검색 결과가 없습니다.</p>';
    }
    // 자주 찾는 목록은 이름보다 수치로 읽힌다: 같은 노드를 정렬 가능한 표로도 보인다.
    renderTable() {
      const val = (n, c) => ({ label: n.label, role: roleLabel(n.role), group: n.group, inRefs: n.m.inRefs, used: n.m.used, uses: n.m.uses, harness: n.m.harness || null, shown: n.m.shown, avgMiss: n.m.avgMiss,
        last: n.m.lastAt, fresh: n.freshness ? (n.freshness.ok ? '최신' : '아님') : null, bytes: n.m.bytes, effect: n.m.effect }[c]);
      const { col, desc } = this.sort;
      const rows = [...(this.points || [])].sort((a, b) => { const x = val(a, col), y = val(b, col); const d = x == null ? 1 : y == null ? -1 : typeof x === 'string' ? x.localeCompare(y) : x - y; return x == null || y == null ? d : desc ? -d : d; });
      const cell = (n, c) => { const v = val(n, c); return c === 'bytes' ? fmtBytes(v) : c === 'avgMiss' || c === 'effect' ? (v == null ? '-' : v.toFixed(2)) : c === 'last' ? when(v) : c === 'label' ? `${roleIcon(n.role, n.color)} ${escape(v)}` : c === 'fresh' && v ? `<span class="kg-fresh ${v === '최신' ? 'ok' : 'bad'}">${v}</span>` : escape(v ?? '-'); };
      this.el('table').innerHTML = `<table class="table"><tr>${COLUMNS.map(([c, t]) => `<th data-sort="${c}" aria-sort="${col === c ? (desc ? 'descending' : 'ascending') : 'none'}">${t}${col === c ? (desc ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr>`
        + rows.map(n => `<tr data-node="${escape(n.id)}" class="${n.id === this.selected ? 'selected' : ''}">${COLUMNS.map(([c]) => `<td>${cell(n, c)}</td>`).join('')}</tr>`).join('') + '</table>';
    }
    showMode() {
      const table = this.mode === 'table';
      this.el('canvas').hidden = table; this.el('legend').hidden = table; this.el('gesture').hidden = table; this.el('table').hidden = !table;
      this.el('modes').querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === this.mode)));
      this.el('arrange').disabled = this.mode !== 'graph'; // 배치는 그래프 보기에만
      if (table) this.renderTable(); else this.drawGraph(this.data);
    }
    async select(nid) {
      const key = this.key; this.selected = nid;
      this.host.querySelectorAll('.kg-node,.kg-table tr[data-node]').forEach(b => b.classList.toggle('selected', b.dataset.node === nid));
      try {
        const n = await invoke('knowledgeDetail', key, nid);
        if (this.key !== key || this.selected !== nid) return;
        this.node = n;
        const related = new Map(n.related.map(r => [r.id, r]));
        const links = (rows, target) => rows.slice(0, 100).map(e => `<li><button class="kg-link" data-node="${escape(e[target])}">${escape(related.get(e[target])?.label || e[target])}</button><small><b style="color:${relColor(e.relation)}">${target === 'target' ? '→' : '←'} ${escape(labels[e.relation] || e.relation)}</b> · ${escape(e.evidence)}<br>${escape(e.computerId || 'PC 미확인')} → ${escape(e.targetComputerId || 'PC 미확인')} · ${escape(e.scope || '범위 미확인')} → ${escape(e.targetScope || '범위 미확인')} · ${escape(statuses[e.status] || '다시 수집 필요')}</small></li>`).join('') || '<li class="hint">없음</li>';
        const m = this.metric(n), relCount = new Map();
        // 관계마다 방향을 나눠 센다: → 나가는(이 노드가 출발), ← 들어오는(이 노드가 도착).
        for (const [rows, dir] of [[n.outgoing, '→'], [n.backlinks, '←']]) for (const e of rows) { const k = dir + ' ' + e.relation; relCount.set(k, (relCount.get(k) || 0) + 1); }
        const summary = [...relCount].sort((a, b) => b[1] - a[1]).map(([k, c]) => { const [dir, r] = k.split(' '); return `<span class="kg-rel" style="border-color:${relColor(r)}">${dir} ${escape(labels[r] || r)} ${c}</span>`; }).join(' ');
        const x = metricsOf(n), spark = x ? window.HubKnowledgeMetrics.sparkline(x.daily, 160, 28) : '';
        const usage = x ? `<p class="kg-metrics">최근 ${x.days}일 사용 ${x.uses} · 검색 노출 ${x.shown} · 참조까지 평균 miss ${x.found ? (x.misses / x.found).toFixed(1) : '-'} (검색을 거친 사용 ${x.found}회) · 평균 검색 순위 ${x.ranked ? (x.rankSum / x.ranked).toFixed(1) : '-'}</p><div class="kg-spark" title="일별 사용">${spark}</div>` : '';
        // 역할·용도와 그 노드의 사실: 크기 · 마지막 참조(스킬 = 마지막 사용, 캐시 = 마지막 읽힘) · 수정/저장 · 캐시 적중·miss · 하네스별 사용 · 최신 여부.
        const hn = h => window.HubKnowledgeMetrics?.harnessName(h) || h, facts = [];
        if (n.bytes != null) facts.push(`크기 ${fmtBytes(n.bytes)}${n.files != null ? ` · 파일 ${n.files}개` : ''}`);
        if (x?.lastUse) facts.push(`마지막 참조 ${when(x.lastUse.at)}${x.lastUse.harness ? ` (${hn(x.lastUse.harness)})` : ''}`);
        else if (n.lastAccess) facts.push(`마지막 참조 ${when(Date.parse(n.lastAccess))}`);
        else if (n.kind === 'skill') facts.push('마지막 참조 기록 없음');
        if (n.mtimeMs) facts.push(`${n.role === 'cache' ? '저장' : '수정'} ${when(n.mtimeMs)}`);
        if (n.cacheStats) facts.push(`캐시 적중 ${n.cacheStats.hits} · miss ${n.cacheStats.misses} · 원본 변경으로 다시 만듦 ${n.cacheStats.stale}${n.cachedDocs ? ` · 든 문서 ${n.cachedDocs}개` : ''}`);
        if (x?.byHarness && Object.keys(x.byHarness).length) facts.push(`최근 ${x.days}일 하네스별 사용: ${harnessText(x.byHarness)}`);
        const life = window.HubKnowledgeMetrics?.lifetimeByHarness(n);
        if (life && Object.keys(life).length) facts.push(`누적 하네스별 사용: ${harnessText(life)}`);
        if (n.cachedAt) facts.push(`스킬 색인 캐시에 있음 (${when(n.cachedAt)} 저장)`);
        const fresh = n.freshness ? `<li><span class="kg-fresh ${n.freshness.ok ? 'ok' : 'bad'}">${n.freshness.ok ? '최신' : '최신 아님'}</span> ${escape(n.freshness.note)}</li>` : '';
        const roleLine = `<p class="kg-role-line">${roleIcon(n.role, this.groupColor?.get(groupOf(n)))} <b>${escape(roleLabel(n.role))}</b>${n.purpose ? ' · ' + escape(n.purpose) : ''}</p><ul class="kg-facts">${facts.map(f => `<li>${escape(f)}</li>`).join('')}${fresh}</ul>`;
        const mine = (this.proposals || []).filter(p => (p.targets || []).some(t => t === n.path || t === n.repositoryPath || t === 'skill:' + n.label) || (n.kind === 'skill' && p.title.includes(n.label)));
        const props = mine.length ? `<h4>관련 RSI 제안 (${mine.length})</h4><ul>${mine.slice(0, 8).map(p => `<li><button class="kg-link" data-proposal="${escape(p.id)}">${escape(p.title)}</button><small>${escape(p.state)}${p.verdict ? ' · 검토 ' + escape(p.verdict) : ''} · ${escape(p.origin)}</small></li>`).join('')}</ul>` : '';
        this.el('detail').innerHTML = `<h3>${escape(n.label)}</h3>${roleLine}<p class="kg-metrics">들어오는 참조 ${m.inRefs} · 나가는 연결 ${n.outgoing.length} · 누적 사용 ${m.used} · 크기 ${fmtBytes(m.bytes)} · 효과 지수 ${m.effect == null ? '-' : m.effect.toFixed(2)} · 분류 ${escape(groupOf(n))}</p>${usage}<p>${summary}</p><p class="kg-path">${escape(n.file || n.sourceLocation || n.path)}${n.line ? ':' + escape(n.line) : ''}</p><p class="hint">${escape(n.kind)} · ${escape(n.evidence)}<br>${escape(origin(n))}</p><div class="row">${n.file ? '<button class="small" data-action="original">원본 열기</button>' : ''}${n.repositoryPath ? '<button class="small primary" data-action="skill">스킬 탭에서 등록</button>' : ''}${n.kind === 'skill' ? '<button class="small" data-action="draft">이 수치로 개선 방향 쓰기</button>' : ''}</div>${props}<pre class="kg-body">${escape(n.description || n.body || '')}</pre><h4>→ 나가는 연결 (${n.outgoing.length})</h4><ul>${links(n.outgoing, 'target')}</ul><h4>← 들어오는 연결 · 백링크 (${n.backlinks.length})</h4><ul>${links(n.backlinks, 'source')}</ul>`;
        this.paint?.();
      } catch (e) { toast(e.message, true); }
    }
    /** 다른 화면에서 이름(또는 경로)으로 노드를 고른다 — 보이는 노드에 없으면 그 이름으로 검색한다. */
    async focusNode(name) {
      // 스킬 이름은 그 폴더 이름과 같다 — 스킬 노드(SKILL.md)를 먼저 고른다.
      const find = () => (this.points || []).find(n => n.kind === 'skill' && n.label === name) || (this.points || []).find(n => n.label === name || n.path === name);
      const hit = find();
      if (hit) return this.select(hit.id);
      this.el('search').value = name; this.focus = ''; await this.load();
      const again = find();
      if (again) this.select(again.id);
    }
    async export(open) {
      const b = this.el(open ? 'obsidian' : 'export'); b.disabled = true;
      try {
        this.el('status').textContent = open ? '현재 그래프를 Obsidian 볼트에 매핑 중…' : 'Obsidian 볼트 생성 중…';
        const result = await invoke(open ? 'knowledgeOpenObsidian' : 'knowledgeExport', this.key);
        this.el('status').textContent = `${open ? '볼트 매핑' : '볼트 생성'}: ${result.nodes}개 노트${result.opened === 'obsidian-requested' ? ' · Obsidian 열기 요청' : result.opened === 'folder' ? ' · 폴더 열림' : ''}`;
        this.el('warnings').open = true; this.el('warnings').querySelector('pre').textContent = result.folder + '\n' + (result.reason || '') + '\n' + (result.warnings || []).join('\n');
      } catch (e) { this.el('status').textContent = e.message; }
      finally { b.disabled = false; }
    }
    setupCanvas() {
      const canvas = this.el('canvas'); let drag = null;
      const nodeAt = p => (this.points || []).find(n => Math.hypot(n.x - p.x, n.y - p.y) < 13 / this.zoom);
      canvas.addEventListener('pointerdown', e => {
        const hit = nodeAt(this.world(e));
        drag = { x: e.offsetX, y: e.offsetY, hit, moved: false }; canvas.setPointerCapture(e.pointerId);
      });
      canvas.addEventListener('pointermove', e => {
        const tip = this.el('tip');
        if (!drag) {
          const p = this.world(e), hit = nodeAt(p), edge = hit ? null : this.edgeAt(p), d = hit && this.degree?.get(hit.id);
          tip.hidden = !hit && !edge;
          tip.style.left = (e.offsetX + 12) + 'px'; tip.style.top = (e.offsetY + 12) + 'px';
          if (hit) tip.textContent = `${hit.label} · ${roleLabel(hit.role)} · ${hit.group} · 참조·사용 ${hit.score} · 들어오는 ${d?.in ?? 0} · 나가는 ${d?.out ?? 0} · 누적 사용 ${hit.m.used}${hit.m.uses ? ' · 30일 ' + hit.m.uses : ''}${hit.m.avgMiss != null ? ' · miss ' + hit.m.avgMiss.toFixed(1) : ''} · ${fmtBytes(hit.m.bytes)}`;
          else if (edge) tip.textContent = `${edge.a.label} → ${edge.b.label} · ${labels[edge.relation] || edge.relation}${edge.evidence && edge.evidence !== 'EXTRACTED' ? ' · 추정(' + edge.evidence + ')' : ''}`;
          return;
        }
        const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
        if (drag.hit) { drag.hit.x += dx / this.zoom; drag.hit.y += dy / this.zoom; drag.hit.pinned = true; }
        else { this.pan.x += dx; this.pan.y += dy; }
        drag.x = e.offsetX; drag.y = e.offsetY; this.paint?.();
      });
      const release = () => { if (drag?.hit && !drag.moved) this.select(drag.hit.id); drag = null; };
      canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', () => { drag = null; });
      canvas.addEventListener('wheel', e => {
        e.preventDefault(); const p = this.world(e), next = Math.max(0.25, Math.min(5, this.zoom * Math.exp(-e.deltaY * 0.001)));
        this.zoom = next; this.pan = { x: e.offsetX - p.x * next, y: e.offsetY - p.y * next }; this.paint?.();
      }, { passive: false });
      new ResizeObserver(() => { if (this.data && this.host.offsetParent) this.drawGraph(this.data); }).observe(this.el('surface'));
    }
    world(e) { return { x: (e.offsetX - this.pan.x) / this.zoom, y: (e.offsetY - this.pan.y) / this.zoom }; }
    /** 마우스 아래 간선(그린 경로와 같은 점으로 판정). */
    edgeAt(p) {
      let best = null, bestD = 5 / this.zoom;
      for (const e of this.visibleEdges?.() || []) {
        const pts = this.edgePath(e);
        for (let i = 1; i < pts.length; i++) { const d = segDist(p, pts[i - 1], pts[i]); if (d < bestD) { bestD = d; best = e; } }
      }
      return best;
    }
    metric(n) {
      const used = (this.usage || {})[`${n.kind}:${n.label}`] || 0; // 스킬 노드만 'skill:<이름>' — 같은 이름의 폴더는 세지 않는다
      const bytes = Number.isFinite(n.bytes) ? n.bytes : null, inRefs = this.inDegree?.get(n.id) || 0, refs = inRefs + used;
      const x = metricsOf(n);
      // 최근 참조: 스킬은 마지막 사용(skill_use·하네스 로그), 캐시는 마지막 읽힘(.meta.json). 파일 수정 시각은 참조가 아니다.
      const lastAt = x?.lastUse?.at || (n.lastAccess ? Date.parse(n.lastAccess) : null) || null;
      // 효과 지수 = 참조 ÷ log2(크기KB+2): 같은 참조면 작은 파일이, 같은 크기면 많이 쓰이는 파일이 높다.
      return { used, bytes, inRefs, refs, effect: bytes == null ? null : refs / Math.log2(bytes / 1024 + 2), lastAt, harness: x ? harnessText(x.byHarness) : '',
        uses: x ? x.uses : null, shown: x ? x.shown : null, avgMiss: x && x.found ? x.misses / x.found : null };
    }
    legend() {
      const counts = {};
      for (const e of this.data?.edges || []) counts[e.relation] = (counts[e.relation] || 0) + 1;
      this.el('legend').innerHTML = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([r, c]) =>
        `<button class="kg-legend-item${this.hiddenRelations.has(r) ? ' off' : ''}" data-rel="${escape(r)}" aria-pressed="${!this.hiddenRelations.has(r)}" title="출발 → 도착 간선 ${c}개 · 눌러서 숨기기"><i style="background:${relColor(r)}"></i>${escape(labels[r] || r)} → ${c}</button>`).join('');
    }
    groupLegend(groups, counts, tiers) {
      // 참조·사용 범례는 그림과 같은 크기의 원과 그 단계의 실제 값 범위를 보인다.
      const scale = tiers.filter(t => t.n).map(t => `<span class="kg-tier"><i class="${t.tier ? '' : 'hollow'}" style="width:${2 * TIER_R[t.tier]}px;height:${2 * TIER_R[t.tier]}px"></i>${t.tier ? (t.min === t.max ? t.min : `${t.min}–${t.max}`) : '없음'}</span>`).join('');
      this.el('groups').innerHTML = groups.map(g => `<button class="kg-legend-item${this.hiddenGroups.has(g) ? ' off' : ''}" data-group-key="${escape(g)}" aria-pressed="${!this.hiddenGroups.has(g)}"><i class="kg-swatch" style="background:${this.groupColor.get(g)}"></i>${escape(g)} ${counts[g] || 0}</button>`).join('')
        + `<span class="kg-scale" title="점 크기 = 참조(들어오는 링크) + 사용 수. 단계는 지금 보이는 노드 값의 3분위">참조·사용${scale}</span>`;
    }
    drawGraph(data, keepView = false) {
      if (!data) return;
      cancelAnimationFrame(this.frame);
      const canvas = this.el('canvas'), width = this.el('surface').clientWidth || 520, height = 450;
      const ratio = window.devicePixelRatio || 1; canvas.width = width * ratio; canvas.height = height * ratio;
      if (!keepView) { this.zoom = 1; this.pan = { x: width / 2, y: height / 2 }; }
      this.inDegree = new Map();
      for (const e of data.edges) if (e.relation !== 'contains') this.inDegree.set(e.target, (this.inDegree.get(e.target) || 0) + 1);
      const usageFilter = this.el('usage').value;
      const keep = n => {
        if (this.hiddenGroups.has(groupOf(n)) || this.hiddenRoles.has(n.role)) return false;
        if (!usageFilter) return true;
        if (usageFilter === 'cached') return Boolean(n.cachedAt) || n.role === 'cache';
        if (usageFilter === 'stale') return Boolean(n.freshness && !n.freshness.ok);
        const m = this.metric(n);
        return usageFilter === 'hot' ? m.refs >= 3 : usageFilter === 'cold' ? m.refs === 0 : usageFilter === 'hard' ? (m.avgMiss ?? 0) >= 1 : m.bytes != null && m.bytes > 64 * 1024 && m.refs <= 1;
      };
      const roleCounts = {};
      for (const n of data.nodes) roleCounts[n.role] = (roleCounts[n.role] || 0) + 1;
      // 역할 범례: 모양 + 이름 + 수. 용도는 마우스를 올리면(제목) 보인다.
      this.el('roles').innerHTML = Object.entries(roleCounts).sort((a, b) => b[1] - a[1]).map(([r, c]) =>
        `<button class="kg-legend-item${this.hiddenRoles.has(r) ? ' off' : ''}" data-role-key="${escape(r)}" aria-pressed="${!this.hiddenRoles.has(r)}" title="${escape(data.roleInfo?.[r]?.purpose || roleLabel(r))} · 눌러서 숨기기">${roleIcon(r)}${escape(roleLabel(r))} ${c}</button>`).join('');
      const allGroups = [...new Set(data.nodes.map(groupOf))].sort(), groupCounts = {};
      for (const n of data.nodes) groupCounts[groupOf(n)] = (groupCounts[groupOf(n)] || 0) + 1;
      this.groupColor = new Map(allGroups.map((g, i) => [g, palette[i % palette.length]]));
      const nodes = data.nodes.filter(keep);
      const groups = [...new Set(nodes.map(groupOf))];
      const grouped = this.el('arrange').value === 'group';
      const anchors = new Map(groups.map((g, i) => [g, { x: Math.cos(i / groups.length * Math.PI * 2) * 170, y: Math.sin(i / groups.length * Math.PI * 2) * 150 }]));
      this.points = nodes.map((n, i) => {
        const a = grouped ? anchors.get(groupOf(n)) : { x: 0, y: 0 }, spread = grouped ? 6 : 16, group = groupOf(n);
        return { ...n, group, color: this.groupColor.get(group), m: this.metric(n), x: a.x + Math.cos(i * 2.39996) * Math.sqrt(i + 1) * spread, y: a.y + Math.sin(i * 2.39996) * Math.sqrt(i + 1) * spread, vx: 0, vy: 0 };
      });
      // 참조·사용은 단계로 그린다: 0 = 빈 원, 나머지는 지금 보이는 노드 값의 3분위로 작은·중간·큰 점. 투명도로 그리던 것은
      // 분류 색 12개와 섞여 적음과 많음이 구분되지 않았다(2026-10-23 사용자 지적).
      for (const n of this.points) n.score = n.m.refs + (n.m.uses || 0);
      const scores = this.points.map(n => n.score).filter(v => v > 0).sort((a, b) => a - b);
      const cut = q => scores[Math.min(scores.length - 1, Math.floor(q * scores.length))] || 0, t1 = cut(1 / 3), t2 = cut(2 / 3);
      const tiers = [0, 1, 2, 3].map(tier => ({ tier, n: 0, min: Infinity, max: 0 }));
      for (const n of this.points) {
        n.tier = n.score <= 0 ? 0 : n.score <= t1 ? 1 : n.score <= t2 ? 2 : 3;
        const t = tiers[n.tier]; t.n++; t.min = Math.min(t.min, n.score); t.max = Math.max(t.max, n.score);
      }
      this.groupLegend(allGroups, groupCounts, tiers);
      this.renderList();
      const byId = new Map(this.points.map(n => [n.id, n]));
      const edges = data.edges.map(e => ({ ...e, a: byId.get(e.source), b: byId.get(e.target) })).filter(e => e.a && e.b);
      this.degree = new Map(this.points.map(n => [n.id, { in: 0, out: 0 }]));
      for (const e of edges) { this.degree.get(e.a.id).out++; this.degree.get(e.b.id).in++; }
      // 간선 경로(그리기와 마우스 판정이 같은 점을 쓴다).
      this.edgePath = e => [[e.a.x, e.a.y], [e.b.x, e.b.y]];
      this.visibleEdges = () => edges.filter(e => !this.hiddenRelations.has(e.relation));
      const radius = n => (n.id === this.selected ? 3 : 0) + (n.kind === 'directory' ? 1 : 0) + TIER_R[n.tier];
      const context = canvas.getContext('2d');
      // 화살촉은 경로의 마지막 마디 방향으로 도착 노드 가장자리에 — 곡선이어도 어느 쪽으로 들어가는지 보인다.
      const arrow = (pts, r, size) => {
        const [x1, y1] = pts[pts.length - 1], [x0, y0] = pts[pts.length - 2], d = Math.hypot(x1 - x0, y1 - y0) || 1, ux = (x1 - x0) / d, uy = (y1 - y0) / d;
        const tx = x1 - ux * (r + 2), ty = y1 - uy * (r + 2), s = size / this.zoom;
        context.beginPath(); context.moveTo(tx, ty); context.lineTo(tx - ux * s - uy * s * 0.55, ty - uy * s + ux * s * 0.55); context.lineTo(tx - ux * s + uy * s * 0.55, ty - uy * s - ux * s * 0.55); context.closePath(); context.fill();
      };
      const ring = (n, r, color, dash) => { context.strokeStyle = color; context.lineWidth = 1.6 / this.zoom; context.setLineDash(dash ? [3 / this.zoom, 2 / this.zoom] : []); context.beginPath(); context.arc(n.x, n.y, r + 2.5, 0, Math.PI * 2); context.stroke(); context.setLineDash([]); };
      this.paint = () => {
        if (this.mode === 'table') return;
        context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
        context.translate(this.pan.x, this.pan.y); context.scale(this.zoom, this.zoom);
        if (grouped) { context.font = `${12 / Math.sqrt(this.zoom)}px sans-serif`; for (const [g, a] of anchors) { context.fillStyle = this.groupColor.get(g); context.fillText(g, a.x - 20, a.y - 60); } }
        for (const e of this.visibleEdges()) {
          // 선택한 노드에서 나가는 간선은 →, 들어오는 간선은 ←로 관계 이름을 붙인다. 포함(구조)은 옅은 회색, 의미 관계는 관계 색.
          const out = e.a.id === this.selected, inn = e.b.id === this.selected, touch = out || inn, structural = e.relation === 'contains';
          const color = structural && !touch ? '#55607a' : relColor(e.relation);
          context.strokeStyle = color; context.fillStyle = color;
          context.globalAlpha = touch ? 1 : this.selected ? 0.18 : structural ? 0.5 : 0.9;
          context.lineWidth = (touch ? 2 : structural ? 0.8 : 1.4) / this.zoom;
          // 근거가 추출(EXTRACTED)이 아니면 점선 — 추정 관계를 사실처럼 보이지 않게.
          context.setLineDash(e.evidence && e.evidence !== 'EXTRACTED' ? [4 / this.zoom, 3 / this.zoom] : []);
          const pts = this.edgePath(e);
          context.beginPath(); context.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) context.lineTo(pts[i][0], pts[i][1]); context.stroke();
          context.setLineDash([]);
          arrow(pts, radius(e.b), structural ? 4 : 6);
          if (touch) { const [mx, my] = pts[Math.floor(pts.length / 2)]; context.font = `${10 / Math.sqrt(this.zoom)}px sans-serif`; context.fillText(`${out ? '→' : '←'} ${labels[e.relation] || e.relation}`, mx + 3, my - 3); }
        }
        context.globalAlpha = 1;
        for (const n of this.points) {
          const active = n.id === this.selected, r = radius(n), shape = shapeOf(n.role), pts = shapePoints(shape, n.x, n.y, r);
          context.beginPath();
          if (pts) { context.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) context.lineTo(p[0], p[1]); context.closePath(); } else context.arc(n.x, n.y, r, 0, Math.PI * 2);
          if (n.tier || active) { context.fillStyle = n.color; context.fill(); }
          else { context.fillStyle = rgba(n.color, 0.12); context.fill(); context.strokeStyle = n.color; context.lineWidth = 1.4 / this.zoom; context.stroke(); } // 참조·사용 없음 = 빈 모양
          // 스킬은 가운데 점(◉)으로 문서·스크립트의 원과 구분한다.
          if (shape === 'pip') { context.beginPath(); context.arc(n.x, n.y, Math.max(1.2, r * 0.36), 0, Math.PI * 2); context.fillStyle = n.tier || active ? '#0f1115' : n.color; context.fill(); }
          if ((n.m.avgMiss ?? 0) >= 1) ring(n, r, '#e0665a', false);
          else if (n.m.effect != null && n.m.effect >= 1) ring(n, r, '#7fd49a', false);
          else if (n.m.bytes > 64 * 1024 && n.m.refs === 0) ring(n, r, '#d39a5a', true);
          if (active || n.tier === 3 || this.zoom > 1.5 || this.points.length < 45 || /^(?:skills\/)?CATALOG\.md$/.test(n.path)) {
            context.font = `${11 / Math.sqrt(this.zoom)}px sans-serif`; context.fillStyle = active ? '#fff' : '#b7c0ce';
            context.fillText(n.label.slice(0, 30) + (n.tier >= 2 ? ` · ${n.score}` : ''), n.x + r + 4, n.y + 3); // 큰 점은 값도 — 크기만으로는 얼마인지 모른다
          }
        }
      };
      let tick = 0;
      const settle = () => {
        if (!this.host.offsetParent || this.mode !== 'graph') return;
        const points = this.points;
        for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
          const a = points[i], b = points[j], dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 25, f = (grouped ? 60 : 110) / d2;
          a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
        }
        for (const e of edges) {
          if (this.hiddenRelations.has(e.relation)) continue;
          const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, distance = Math.hypot(dx, dy) || 1, f = (distance - 65) * (grouped ? 0.003 : 0.008);
          e.a.vx += dx / distance * f; e.a.vy += dy / distance * f; e.b.vx -= dx / distance * f; e.b.vy -= dy / distance * f;
        }
        for (const n of points) if (!n.pinned) {
          const a = grouped ? anchors.get(groupOf(n)) : { x: 0, y: 0 }, pull = grouped ? 0.02 : 0.0007;
          n.vx = (n.vx - (n.x - a.x) * pull) * 0.78; n.vy = (n.vy - (n.y - a.y) * pull) * 0.78;
          n.x += Math.max(-5, Math.min(5, n.vx)); n.y += Math.max(-5, Math.min(5, n.vy));
        }
        this.paint(); if (++tick < 180) this.frame = requestAnimationFrame(settle);
      };
      this.legend();
      if (this.mode === 'table') this.renderTable();
      this.paint(); if (!keepView && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) this.frame = requestAnimationFrame(settle);
    }
  }
  function mount(id, fixed) { const host = document.getElementById(id); if (!host) return null; if (!views.has(id)) views.set(id, new GraphView(host, fixed)); return views.get(id); }
  const full = () => mount('knowledge-workspace');
  window.HubKnowledgeGraph = {
    async addresses(projectDir) {
      const v = views.get('knowledge-workspace'), a = v?.attachment;
      if (!a?.edges.length || a.key !== v.key) throw new Error('지식 그래프의 디렉터리에서 첨부할 관계를 선택하세요.');
      return invoke('knowledgeAddresses', { key: a.key, projectDir,
        edges: a.edges.map(({ source, target, relation }) => ({ source, target, relation })) });
    },
    async refreshSkills() { await mount('skill-knowledge-graph', 'skills:repository')?.refresh(); },
    async refreshSource() { await mount('source-knowledge-graph')?.refresh(); },
    async open(key) {
      const v = full(); v.key = key; v.reset();
      document.querySelector('#tabs [data-tab="knowledge"]').click();
    },
    async refresh() { await full()?.refresh(); },
    /** 지표·제안 화면에서 스킬 하나로 간다: 스킬 원본으로 바꾸고 그 노드를 고른다. */
    async focusSkill(name) {
      const v = full(); if (!v) return;
      hubGo('knowledge', 'knowledge-workspace');
      if (v.key !== 'skills:repository') { v.key = 'skills:repository'; v.reset(); await v.refresh(); }
      await v.focusNode(String(name).replace(/^skill:/, ''));
    },
    redraw() { for (const v of views.values()) if (v.data) v.drawGraph(v.data); },
  };
  document.querySelector('#tabs [data-tab="knowledge"]')?.addEventListener('click', () => window.HubKnowledgeGraph.refresh());
  document.querySelector('#tabs [data-tab="source"]')?.addEventListener('click', () => window.HubKnowledgeGraph.refreshSource());
  document.querySelector('#tabs [data-tab="skills"]')?.addEventListener('click', () => window.HubKnowledgeGraph.refreshSkills());
  const action = (id, fn) => document.getElementById(id)?.addEventListener('click', async () => { const b = document.getElementById(id); b.disabled = true; try { await fn(); } catch (e) { toast(e.message, true); } finally { b.disabled = false; } });
  action('knowledge-pick', async () => { const root = await invoke('knowledgePick'); if (root) document.getElementById('knowledge-root').value = root; });
  action('knowledge-build', async () => {
    const result = await invoke('knowledgeBuild', { root: document.getElementById('knowledge-root').value });
    full().key = result.key; await full().refresh();
  });
  action('knowledge-import', async () => {
    const root = await invoke('knowledgePick'); if (!root) return;
    const progress = document.getElementById('knowledge-progress'); if (progress) progress.textContent = 'Obsidian 볼트 루트와 노트 연결을 읽는 중…';
    const result = await invoke('knowledgeImport', root); full().key = result.key; await full().refresh();
    if (progress) progress.textContent = `볼트 가져오기: 노드 ${result.nodes}개 · 관계 ${result.edges}개`;
  });
  let runningKey = '';
  action('knowledge-cancel', async () => { if (runningKey) await invoke('knowledgeCancel', runningKey); });
  window.hub.onKnowledgeProgress?.(p => { runningKey = p.key || ''; const el = document.getElementById('knowledge-progress'); if (el) el.textContent = `${p.phase} · ${p.files || 0}개 파일`; });
  for (const tab of ['memory', 'projects']) {
    const host = document.getElementById('tab-' + tab); if (!host) continue;
    const button = document.createElement('button'); button.className = 'small'; button.textContent = '파일·문서를 지식 그래프로 탐색';
    button.addEventListener('click', () => window.HubKnowledgeGraph.open(tab === 'memory' ? 'memory:notes' : 'all:knowledge'));
    host.prepend(button);
  }
})();

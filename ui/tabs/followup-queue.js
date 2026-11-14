'use strict';
// Current per-PC execution state stays separate from shared completion history.
(() => {
  const group = document.querySelector('#tabs .tab-group[data-group="monitor"]');
  if (!group || !document.querySelector('main')) return;
  const button = document.createElement('button'); button.dataset.tab = 'followup'; button.textContent = '후속 큐'; group.append(button);
  const section = document.createElement('section'); section.id = 'tab-followup'; section.className = 'tab';
  section.innerHTML = `<style>
    #tab-followup .fq-head{display:flex;justify-content:space-between;gap:16px;margin-bottom:18px}#tab-followup h1{font-size:24px;margin-bottom:8px}
    #tab-followup p{line-height:1.7;color:var(--muted)}#tab-followup .fq-filters{display:grid;grid-template-columns:180px minmax(200px,1fr);gap:12px;margin:18px 0}
    #tab-followup label{display:flex;flex-direction:column;gap:6px;color:var(--muted)}#tab-followup input,#tab-followup select{width:100%;min-width:0}
    #tab-followup .fq-counts{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}#tab-followup .fq-counts span{padding:6px 10px;background:var(--panel2);border-radius:5px}
    #tab-followup article{border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;padding:18px;margin:12px 0;background:var(--panel);overflow-wrap:anywhere}
    #tab-followup article[data-state="blocked"],#tab-followup article[data-state="held"]{border-left-color:var(--warn)}#tab-followup article[data-state="running"]{border-left-color:var(--accent2)}
    #tab-followup article header{display:flex;justify-content:space-between;gap:16px;padding:0;border:0;background:none;align-items:start}#tab-followup h2{font-size:15px;margin:10px 0;line-height:1.6}
    #tab-followup .fq-reason{white-space:pre-wrap;color:var(--text);padding:12px;background:var(--panel2);margin:12px 0;border-radius:5px}
    #tab-followup .fq-status{white-space:pre-wrap;margin-top:12px}#tab-followup .fq-status[data-error="true"]{color:var(--warn)}
    #tab-followup .fq-meta{font-size:12px;margin-top:8px}#tab-followup .fq-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
    #tab-followup .fq-empty{padding:30px;border:1px dashed var(--border);text-align:center;color:var(--muted)}
    @media(max-width:650px){#tab-followup .fq-filters{grid-template-columns:1fr}#tab-followup .fq-head,#tab-followup article header{flex-wrap:wrap}}
  </style><div class="fq-head"><div><h1>후속 큐</h1><p>이 PC에서 이어갈 작업과 실제 대기 사유를 확인합니다.</p></div><button class="fq-refresh">새로고침</button></div>
    <p class="fq-machine"></p><div class="fq-filters"><label>진행 상태<select class="fq-filter" aria-label="후속 큐 상태">
    <option value="all">모든 상태</option><option value="running">진행 중</option><option value="ready">인수 대기</option><option value="held">보류</option><option value="blocked">입력·조건 대기</option></select></label>
    <label>작업 찾기<input class="fq-search" type="search" placeholder="ID · 내용 · 사유 · 담당자" aria-label="후속 큐 검색"></label></div>
    <p class="fq-updated">마지막 성공 조회: 아직 없음</p><p class="fq-status" role="status" aria-live="polite">아직 읽지 않았습니다.</p><div class="fq-counts" aria-label="후속 상태별 수"></div><div class="fq-records"></div>`;
  document.querySelector('main').append(section);
  const get = name => section.querySelector('.fq-' + name), labels = { running: '진행 중', ready: '인수 대기', held: '보류', blocked: '입력·조건 대기' };
  let data, generation = 0, failed = false;
  const when = seconds => { const date = new Date(Number(seconds) * 1000); return seconds && Number.isFinite(date.getTime()) ? date.toLocaleString('ko-KR') : '시각 미기록'; };
  async function open(row, reference) {
    try { await call(window.hub.todoDoneOpen, { scope: 'followup', snapshotId: data.snapshotId, id: row.id, fingerprint: row.fingerprint, reference }); }
    catch (error) { get('status').textContent = error.message; get('status').dataset.error = 'true'; }
  }
  function render() {
    if (!data) return;
    const query = get('search').value.trim().toLocaleLowerCase(), state = get('filter').value;
    const matching = data.tasks.filter(row => !query || `${row.id} ${row.summary} ${row.reason} ${row.owner || ''}`.toLocaleLowerCase().includes(query));
    const counts = matching.reduce((out, row) => { out[row.displayState] = (out[row.displayState] || 0) + 1; return out; }, {});
    get('counts').innerHTML = Object.entries(counts).map(([key, count]) => `<span>${labels[key]} <b>${count}</b></span>`).join('');
    const list = get('records'); list.replaceChildren();
    for (const row of matching.filter(row => state === 'all' || row.displayState === state)) {
      const card = document.createElement('article'); card.dataset.state = row.displayState;
      const reason = row.reason || (row.state === 'blocked' ? '대기 사유가 기록되지 않았습니다. 담당자의 확인이 필요합니다.' : row.state === 'running' ? '담당자가 이 작업을 진행 중입니다.' : '순서와 자원 조건에 따라 인수를 기다립니다.');
      card.innerHTML = `<header><strong>${esc(row.id)}</strong><span>${labels[row.displayState]}</span></header><h2>${esc(row.summary)}</h2>
        <p>현재 담당: ${esc(row.owner || '현재 인수자 없음')}${row.stale ? ' · 갱신 지연, 소유권을 자동 회수하지 않습니다.' : ''}</p>
        ${row.owner ? `<p class="fq-meta">담당 갱신 ${esc(when(row.heartbeatAt))}</p>` : ''}
        <p class="fq-reason">${esc(reason)}</p><p class="fq-meta">${row.checkpoint ? '체크포인트: ' + esc(row.checkpoint.label) + ' · ' + esc(when(row.checkpoint.savedAt)) + (row.checkpoint.reference ? '' : ' · 저장소 밖 경로 가림') : '저장된 체크포인트 없음'}</p>
        <div class="fq-actions"></div>`;
      const actions = card.querySelector('.fq-actions');
      for (const [reference, name] of [[row.detail ? 'detail' : null, '요구 문서'], [row.checkpoint?.reference ? 'checkpoint' : null, '체크포인트 열기']]) {
        if (!reference) continue;
        const action = document.createElement('button'); action.textContent = name; action.className = 'small'; action.disabled = failed; action.onclick = () => open(row, reference); actions.append(action);
      }
      list.append(card);
    }
    if (!list.children.length) { const empty = document.createElement('div'); empty.className = 'fq-empty'; empty.textContent = '이 조건에 맞는 후속 작업이 없습니다.'; list.append(empty); }
  }
  async function refresh() {
    const request = ++generation; get('refresh').disabled = true;
    if (data) { failed = true; render(); }
    get('status').textContent = data ? '실제 큐를 다시 읽는 중입니다. 마지막 성공 목록을 유지합니다.' : '이 PC의 실제 큐를 읽는 중입니다.';
    try {
      const fresh = await call(window.hub.todoFollowupView);
      if (request !== generation) return;
      data = fresh; failed = false; get('machine').textContent = data.machine + ' · 완료·취소 이력은 Done 큐에서 확인합니다.';
      get('updated').textContent = '마지막 성공 조회 ' + new Date(data.observedAt).toLocaleString('ko-KR');
      get('status').textContent = data.truncated ? '조회 한도로 일부 목록만 표시합니다. 공유 큐에서 전체 기록을 확인하세요.' : '실제 인수·진행·대기 상태입니다. 이 화면에서 작업을 자동 인수하거나 재개하지 않습니다.';
      get('status').dataset.error = 'false'; render();
    } catch (error) {
      if (request !== generation) return;
      failed = true; render(); get('status').dataset.error = 'true';
      get('status').textContent = error.message + (data ? '\n마지막 성공 목록을 보존했습니다. 문서 열기는 새로고침 성공 후 사용할 수 있습니다.' : '');
    } finally { if (request === generation) get('refresh').disabled = false; }
  }
  button.onclick = () => {
    document.querySelectorAll('#tabs button').forEach(item => item.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(item => item.classList.remove('active'));
    button.classList.add('active'); section.classList.add('active'); lastTabOf.monitor = 'followup'; showGroup('monitor'); refresh();
  };
  get('refresh').onclick = refresh; get('filter').onchange = render; get('search').oninput = render;
  window.todoFollowupUI = { refresh };
})();

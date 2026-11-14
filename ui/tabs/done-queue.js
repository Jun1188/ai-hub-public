'use strict';
// Optional read-only history tab. Loaded after shell.js, before boot.js.
(() => {
  const labels = { completed: '완료', 'partially-completed': '일부 PC 완료', 'finalization-pending': '정리 대기',
    cancelled: '사용자 취소', superseded: '대체됨', 'needs-review': '확인 필요', active: '활성', held: '보류' };
  const group = document.querySelector('#tabs .tab-group[data-group="monitor"]');
  if (!group || !document.querySelector('main')) return;
  const tabButton = document.createElement('button');
  tabButton.dataset.tab = 'done'; tabButton.textContent = 'Done 큐'; group.append(tabButton);
  const section = document.createElement('section'); section.id = 'tab-done'; section.className = 'tab';
  section.innerHTML = `<style>
    #tab-done .dq-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}
    #tab-done h1{font-size:24px;letter-spacing:-.5px;margin-bottom:8px}#tab-done p{color:var(--muted);line-height:1.6}
    #tab-done .dq-filters{display:grid;grid-template-columns:minmax(150px,1fr) minmax(150px,1fr) minmax(200px,2fr);gap:12px;margin:18px 0}
    #tab-done label{display:flex;flex-direction:column;gap:7px;color:var(--muted);font-size:12px}
    #tab-done input,#tab-done select,#tab-done textarea{width:100%;min-width:0}
    #tab-done .dq-counts{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 18px}
    #tab-done .dq-counts span{padding:6px 10px;background:var(--panel2);border-radius:5px;font-variant-numeric:tabular-nums}
    #tab-done .dq-record{border:1px solid var(--border);border-left:3px solid var(--accent2);padding:18px;margin-bottom:12px;background:var(--panel);border-radius:8px;overflow-wrap:anywhere}
    #tab-done .dq-record[data-state="needs-review"]{border-left-color:var(--warn)}#tab-done .dq-record[data-state="cancelled"]{border-left-color:var(--muted)}
    #tab-done .dq-record header{padding:0;border:0;display:flex;justify-content:space-between;align-items:start;gap:16px;background:none}
    #tab-done .dq-record h2{font-size:15px;line-height:1.6;margin:10px 0}#tab-done .dq-state{white-space:nowrap;font-size:12px;color:var(--accent2)}
    #tab-done .dq-record[data-state="needs-review"] .dq-state{color:var(--warn)}#tab-done .dq-record[data-state="cancelled"] .dq-state{color:var(--muted)}
    #tab-done details{margin-top:14px}#tab-done summary{cursor:pointer;color:var(--muted);padding:4px 0}
    #tab-done .dq-receipt{margin-top:12px;padding:12px;background:var(--panel2);border-radius:5px;line-height:1.7;white-space:normal}
    #tab-done .dq-receipt p{white-space:pre-wrap;color:var(--text)}#tab-done .dq-fingerprint{font:12px/1.7 Consolas,monospace;color:var(--muted);margin-top:8px}
    #tab-done .dq-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}#tab-done .dq-status{padding:12px 0;font-size:13px;white-space:pre-wrap}
    #tab-done .dq-status[data-error="true"]{color:var(--warn)}#tab-done .dq-empty{padding:38px 20px;border:1px dashed var(--border);text-align:center;color:var(--muted)}
    #tab-done .dq-plan{border:1px solid var(--accent);border-radius:8px;padding:20px;margin-bottom:18px;background:var(--panel)}
    #tab-done .dq-plan h2{font-size:18px;margin-bottom:12px}#tab-done .dq-plan label{margin-top:12px}#tab-done .dq-plan textarea{min-height:90px;resize:vertical}
    #tab-done .dq-plan pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;padding:14px;background:var(--bg);margin-top:14px}
    #tab-done .dq-warnings{padding:14px 18px;background:var(--panel2);border-left:3px solid var(--warn);margin-bottom:16px;line-height:1.7}
    @media(max-width:760px){#tab-done .dq-filters{grid-template-columns:1fr}#tab-done .dq-heading{flex-wrap:wrap}#tab-done .dq-record header{flex-wrap:wrap;gap:6px}}
  </style><div class="dq-heading"><div><h1>Done 큐</h1><p>완료 근거, 취소 이유와 PC별 남은 작업을 함께 확인합니다.</p></div><button class="dq-refresh">새로고침</button></div>
    <div class="dq-filters"><label>PC<select class="dq-machine" aria-label="Done 큐 PC"></select></label>
    <label>상태<select class="dq-state-filter" aria-label="Done 큐 상태"><option value="history">완료·취소·확인 기록</option><option value="all">모든 상태 · 활성 포함</option>${Object.entries(labels).map(([key, name]) => `<option value="${key}">${name}</option>`).join('')}</select></label>
    <label>작업 찾기<input class="dq-search" type="search" placeholder="작업 ID 또는 내용" aria-label="Done 큐 검색"></label></div>
    <p class="dq-updated">마지막 성공 조회: 아직 없음</p><p class="dq-status" role="status" aria-live="polite">아직 읽지 않았습니다.</p><div class="dq-counts" aria-label="상태별 기록 수"></div>
    <div class="dq-warnings" hidden></div><div class="dq-plan" hidden></div><div class="dq-records"></div><button class="dq-more" hidden>다음 100개 보기</button>`;
  document.querySelector('main').append(section);
  const get = name => section.querySelector('.dq-' + name);
  let data = null, generation = 0, failed = false, shown = 100;
  const status = (message, error = false) => { get('status').textContent = message; get('status').dataset.error = String(error); };
  const payload = row => ({ snapshotId: data.snapshotId, id: row.id, fingerprint: row.fingerprint });
  function pcOptions() {
    const select = get('machine'), before = select.value || data.machine;
    const pcs = [...new Set(data.tasks.flatMap(row => row.targets))].sort();
    select.replaceChildren();
    for (const [value, name] of [['all', '전체 PC'], ...pcs.map(pc => [pc, pc === data.machine ? `${pc} · 이 PC` : pc])]) {
      const option = document.createElement('option'); option.value = value; option.textContent = name; select.append(option);
    }
    select.value = pcs.includes(before) ? before : 'all';
  }
  async function openReference(row, reference, pc) {
    try { await call(window.hub.todoDoneOpen, { ...payload(row), reference, pc }); }
    catch (error) { status(error.message, true); }
  }
  function planForm(row) {
    const box = get('plan'), startingSnapshot = data.snapshotId;
    box.hidden = false; box.innerHTML = `<h2>재개 계획 확인</h2><p>이전 기록은 보존합니다. 새 작업 ID와 이유로 계획만 만들며 자동 등록하거나 실행하지 않습니다.</p>
      <p class="dq-original"></p><label>새 작업 ID<input class="dq-new-id" maxlength="80" placeholder="예: FOLLOWUP-20261114"></label>
      <label>재개 이유<textarea class="dq-reason" maxlength="1000"></textarea></label><div class="dq-actions"><button class="dq-build-plan">계획 만들기</button><button class="dq-close-plan">닫기</button></div><pre class="dq-plan-result" hidden></pre>`;
    get('original').textContent = row.id + ' · ' + labels[row.state];
    get('new-id').value = row.id.length < 70 ? row.id + '-NEXT' : '';
    get('close-plan').onclick = () => { box.hidden = true; };
    get('build-plan').onclick = async () => {
      const button = get('build-plan'); button.disabled = true;
      try {
        const plan = await call(window.hub.todoDonePlan, { ...payload(row), newId: get('new-id').value.trim(), reason: get('reason').value.trim() });
        if (data.snapshotId !== startingSnapshot || box.hidden) return;
        get('plan-result').textContent = JSON.stringify(plan, null, 2); get('plan-result').hidden = false;
        status('재개 계획을 만들었습니다. 기존 기록과 활성 큐는 변경하지 않았습니다.');
      } catch (error) { status(error.message, true); }
      finally { if (button.isConnected) button.disabled = false; }
    };
    box.scrollIntoView({ block: 'start' }); get('new-id').focus();
  }
  function render() {
    if (!data) return;
    const machine = get('machine').value, state = get('state-filter').value, query = get('search').value.trim().toLocaleLowerCase();
    const matching = data.tasks.filter(row => (machine === 'all' || row.targets.includes(machine))
      && (!query || `${row.id} ${row.summary} ${row.sharedStatus}`.toLocaleLowerCase().includes(query)));
    const counts = matching.reduce((out, row) => { out[row.state] = (out[row.state] || 0) + 1; return out; }, {});
    get('counts').innerHTML = Object.entries(counts).map(([key, count]) => `<span>${labels[key]} <b>${count}</b></span>`).join('');
    const rows = matching.filter(row => state === 'all' || (state === 'history' ? !['active', 'held'].includes(row.state) : row.state === state));
    const list = get('records'); list.replaceChildren();
    for (const row of rows.slice(0, shown)) {
      const card = document.createElement('article'); card.className = 'dq-record'; card.dataset.state = row.state;
      const receipts = Object.entries(row.completedPCs);
      card.innerHTML = `<header><strong>${esc(row.id)}</strong><span class="dq-state">${labels[row.state]}</span></header><h2>${esc(row.summary)}</h2>
        <p>${row.pendingPCs.length ? '완료 미확인: ' + esc(row.pendingPCs.join(', ')) : '대상 PC의 완료 기록이 있습니다.'}</p>
        ${row.disposition ? `<p>${esc(row.disposition.reason)}</p>` : ''}<div class="dq-actions"></div>
        <details><summary>정의·PC별 근거 ${receipts.length}개</summary><p class="dq-fingerprint">정의 지문 ${row.fingerprint}</p>
        <p>공유 상태: ${esc(row.sharedStatus)}</p><div class="dq-receipts"></div></details>`;
      const actions = card.querySelector('.dq-actions');
      const action = (name, handler) => { const b = document.createElement('button'); b.textContent = name; b.className = 'small'; b.disabled = failed; b.onclick = handler; actions.append(b); };
      if (row.detail) action('요구 문서', () => openReference(row, 'detail'));
      if (row.disposition?.evidence) action('취소·대체 근거', () => openReference(row, 'disposition'));
      if (!row.active) action('재개 계획', () => planForm(row));
      for (const [pc, receipt] of receipts) {
        const entry = document.createElement('div'); entry.className = 'dq-receipt';
        const at = new Date(receipt.completedAt * 1000);
        const time = receipt.completedAt > 0 && Number.isFinite(at.getTime()) ? at.toLocaleString('ko-KR') : '시각 확인 필요';
        entry.innerHTML = `<strong>${esc(pc)}</strong> · ${esc(time)}<p>${esc(receipt.note)}</p>`;
        if (receipt.evidence) { const b = document.createElement('button'); b.textContent = receipt.evidence; b.className = 'small'; b.disabled = failed; b.onclick = () => openReference(row, 'receipt', pc); entry.append(b); }
        card.querySelector('.dq-receipts').append(entry);
      }
      list.append(card);
    }
    if (!rows.length) { const empty = document.createElement('div'); empty.className = 'dq-empty'; empty.textContent = '이 조건에 맞는 기록이 없습니다.'; list.append(empty); }
    get('more').hidden = rows.length <= shown;
  }
  async function refresh() {
    const request = ++generation; get('refresh').disabled = true; get('plan').hidden = true;
    if (data) { failed = true; render(); }
    status(data ? '기록을 다시 읽는 중입니다. 마지막 성공 목록을 유지합니다.' : '공유 기록을 읽는 중입니다.');
    try {
      const fresh = await call(window.hub.todoDoneView);
      if (request !== generation) return;
      data = fresh; failed = false; shown = 100; pcOptions(); render();
      get('updated').textContent = `마지막 성공 조회 ${new Date(data.observedAt).toLocaleString('ko-KR')}`;
      const warnings = get('warnings'); warnings.hidden = !data.warnings.length;
      warnings.textContent = data.warnings.length ? `기록 대조가 필요한 항목 ${data.warnings.length}개\n` + data.warnings.map(w => `${w.id || '기록'} · ${w.code} · ${w.path}`).join('\n') : '';
      status('공유 기록의 단계별 완료입니다. 실제 실행 검수 여부는 PC별 근거를 확인하세요.');
    } catch (error) {
      if (request !== generation) return;
      failed = true; render(); status(`${error.message}${data ? '\n마지막 성공 목록입니다. 근거 열기와 재개는 새로고침 성공 후 사용할 수 있습니다.' : ''}`, true);
    } finally { if (request === generation) get('refresh').disabled = false; }
  }
  tabButton.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach(button => button.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    tabButton.classList.add('active'); section.classList.add('active');
    lastTabOf.monitor = 'done'; showGroup('monitor'); refresh();
  });
  get('refresh').onclick = refresh;
  for (const name of ['machine', 'state-filter']) get(name).addEventListener('change', () => { shown = 100; render(); });
  get('search').addEventListener('input', () => { shown = 100; render(); });
  get('more').onclick = () => { shown += 100; render(); };
  window.todoDoneUI = { refresh };
})();

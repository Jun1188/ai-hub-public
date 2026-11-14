// 메모리 탭 — 공유 저장소 메모리 검색(읽기 전용)과 이 PC 로컬 메모리 조회/추가/검색, 중복 정리, 저장 위치.
// 공개판은 독립 로컬 저장소를 사용하며 공유 저장소는 사용자가 명시해 연결한다.
'use strict';

// ---- memory tab ---------------------------------------------------------------

async function refreshMemory() {
  refreshSharedMemory();
  try {
    const s = await call(window.hub.memStats);
    $('mem-stats').innerHTML = `총 <b>${s.total}</b>개 · ` +
      Object.entries(s.byType).map(([t, c]) => `${esc(t)} ${c}`).join(' · ');
    $('mem-dir-now').textContent = `현재: ${s.dir} ${s.isShared ? '(공유 경로 사용 중)' : '(이 컴퓨터 전용)'}`;
    if (!$('mem-dir').value) $('mem-dir').value = s.isShared ? s.dir : '';
    await renderMemList(await call(window.hub.memList, '', 50));
  } catch (e) { toast(e.message, true); }
}

async function renderMemList(items) {
  $('mem-list').innerHTML = items.length
    ? items.map((m) => `
      <div class="row" style="margin:6px 0; align-items:flex-start">
        <div style="flex:1">
          <span class="badge">${esc(m.type)}</span> ${m.score !== undefined ? `<span class="hint">[${m.score}]</span>` : ''}
          <span>${esc(m.text.slice(0, 160))}${m.text.length > 160 ? '…' : ''}</span>
          <div class="hint">${esc((m.ts || '').slice(0, 16).replace('T', ' '))} · ${esc((m.tags || []).join(', '))}</div>
        </div>
        <button class="small danger" data-mem-del="${esc(m.id)}">삭제</button>
      </div>`).join('')
    : '<div class="hint">저장된 메모리가 없습니다.</div>';
  document.querySelectorAll('[data-mem-del]').forEach((b) => b.addEventListener('click', async () => {
    await call(window.hub.memDelete, b.dataset.memDel).catch((e) => toast(e.message, true));
    refreshMemory();
  }));
}

$('mem-add').addEventListener('click', async () => {
  const text = $('mem-text').value.trim();
  if (text.length < 3) return toast('내용을 입력하세요.', true);
  try {
    const r = await call(window.hub.memSave, text, $('mem-type').value, $('mem-tags').value);
    toast(r.deduplicated ? '이미 같은 내용이 저장되어 있습니다.' : '메모리가 저장되었습니다.');
    $('mem-text').value = ''; $('mem-tags').value = '';
    refreshMemory();
  } catch (e) { toast(e.message, true); }
});

$('mem-find').addEventListener('click', async () => {
  const q = $('mem-query').value.trim();
  if (!q) return refreshMemory();
  try { await renderMemList(await call(window.hub.memSearch, q, 10)); } catch (e) { toast(e.message, true); }
});

$('mem-refresh').addEventListener('click', refreshMemory);
$('mem-consolidate').addEventListener('click', async () => {
  try {
    const r = await call(window.hub.memConsolidate);
    toast(r.removedCount ? `중복 메모리 ${r.removedCount}개를 통합했습니다.` : '중복된 메모리가 없습니다.');
    refreshMemory();
  } catch (e) { toast(e.message, true); }
});

async function applyMemDir(dir) {
  try {
    const s = await call(window.hub.memSetDir, dir);
    $('mem-dir').value = s.isShared ? s.dir : '';
    toast(s.isShared ? `메모리 저장 위치 변경: ${s.dir}` : '메모리 저장 위치를 로컬 기본값으로 되돌렸습니다.');
    refreshMemory();
  } catch (e) { toast(e.message, true); }
}
$('mem-dir-apply').addEventListener('click', () => applyMemDir($('mem-dir').value.trim()));
$('mem-dir-default').addEventListener('click', () => applyMemDir(''));

// ---- 공유 저장소 메모리 (shared-repo-memory.js) -------------------------------------

const SMEM_KIND = { memory: '메모리', log: '문제 해결 로그', skill: 'skill', doc: '문서' };

async function refreshSharedMemory() {
  try {
    const s = await call(window.hub.smemStatus);
    $('smem-status').innerHTML = s.found
      ? `저장소: <code>${esc(s.root)}</code>` +
        (s.head ? ` · ${esc(s.head.commit)} ${esc(s.head.date)} ${esc(s.head.subject)}` : '') +
        (s.python ? '' : ' · <span class="warn">Python 3가 없어 검색할 수 없습니다</span>')
      : '<span class="warn">codex-shared-context clone을 찾지 못했습니다.</span> 아래에서 위치를 지정하세요.';
    if (!$('smem-repo').value && s.configured) $('smem-repo').value = s.configured;
  } catch (e) { $('smem-status').textContent = e.message; }
}

$('smem-find').addEventListener('click', async () => {
  const q = $('smem-query').value.trim();
  if (!q) return toast('검색어를 입력하세요.', true);
  const kinds = Object.keys(SMEM_KIND).filter((k) => $('smem-k-' + k).checked);
  $('smem-find').disabled = true;
  try {
    const r = await call(window.hub.smemSearch, q, kinds, 8);
    $('smem-results').innerHTML = r.results.length
      ? r.results.map((x) => `
        <div class="row" style="margin:6px 0; align-items:flex-start">
          <div style="flex:1">
            <span class="badge">${esc(SMEM_KIND[x.kind] || x.kind)}</span> <b>${esc(x.title)}</b>
            <div class="hint">${esc(x.path)} · 점수 ${Number(x.score).toFixed(1)}</div>
            <div>${esc(x.snippet)}</div>
          </div>
        </div>`).join('')
      : '<div class="hint">결과가 없습니다.</div>';
  } catch (e) { toast(e.message, true); } finally { $('smem-find').disabled = false; }
});
$('smem-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('smem-find').click(); });

async function applySmemRepo(dir) {
  try {
    await call(window.hub.smemSetRepo, dir);
    if (!dir) $('smem-repo').value = '';
    toast(dir ? '공유 저장소 위치를 저장했습니다.' : '공유 저장소 연결을 해제했습니다.');
    refreshSharedMemory();
  } catch (e) { toast(e.message, true); }
}
$('smem-repo-apply').addEventListener('click', () => applySmemRepo($('smem-repo').value.trim()));
$('smem-repo-auto').addEventListener('click', () => applySmemRepo(''));


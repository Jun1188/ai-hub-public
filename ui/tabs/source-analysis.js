// 소스 분석 탭 — 학습 Q&A, UE 렌더링 파이프라인 분석, C++ 소스 인덱스,
// 파인튜닝 데이터셋 생성.
'use strict';

// ---- source analysis tab --------------------------------------------------------

async function refreshSource() {
  try {
    if (!cloudJobId && !cloudPreview) await refreshCloudTargets().catch(e => toast(e.message, true));
    const ue = await call(window.hub.idxDetectUE);
    $('idx-ue-detect').innerHTML = ue.length
      ? '<h3>감지된 Unreal Engine</h3>' + ue.map((u, i) =>
          `<button class="small" data-ue="${i}">＋ ${esc(u.label)} Runtime 인덱스 설정</button>`).join('')
      : '<div class="hint">Unreal Engine 설치가 감지되지 않았습니다. 임의의 C++ 소스 경로도 인덱싱할 수 있습니다.</div>';
    document.querySelectorAll('[data-ue]').forEach((b) => b.addEventListener('click', () => {
      const u = ue[Number(b.dataset.ue)];
      $('idx-name').value = u.label.toLowerCase().replace('_', '') + '-runtime';
      $('idx-root').value = u.path + '\\Runtime';
      invalidateCloudPreview();
      toast('설정이 입력되었습니다. "인덱싱 시작"을 누르세요.');
    }));
    await refreshIdxList();
    await refreshFtList();
    await refreshRenderpipe();
    await refreshSymbolMap();
    await refreshDeepdive();
  } catch (e) { toast(e.message, true); }
}

// ---- deep analysis (tier 3) -------------------------------------------------

async function refreshDeepdive() {
  try {
    const [maps, indexes, reviewers] = await Promise.all([
      call(window.hub.symList), call(window.hub.idxList), call(window.hub.ddReviewers),
    ]);
    $('dd-map').innerHTML = maps.length
      ? maps.map((m) => `<option value="${esc(m.name)}">맵: ${esc(m.name)}</option>`).join('')
      : '<option value="">심볼 맵 없음</option>';
    $('dd-index').innerHTML = '<option value="">발췌 안 함</option>'
      + indexes.map((i) => `<option value="${esc(i.name)}">인덱스: ${esc(i.name)}</option>`).join('');
    $('dd-reviewer').innerHTML = reviewers.map((r) =>
      `<option value="${esc(r.id)}">${esc(r.label)}${r.external ? ' — 외부 전송' : ''}</option>`).join('');
  } catch (e) { toast(e.message, true); }
}

function ddOpts() {
  return {
    map: $('dd-map').value,
    index: $('dd-index').value,
    topic: $('dd-topic').value.trim(),
    question: $('dd-question').value.trim(),
    includeSource: $('dd-source').checked && Boolean($('dd-index').value),
    reviewer: $('dd-reviewer').value,
    save: $('dd-save').checked,
  };
}

$('dd-preview').addEventListener('click', async () => {
  const o = ddOpts();
  if (!o.map || !o.topic) { toast('심볼 맵과 주제를 지정하세요.', true); return; }
  try {
    const b = await call(window.hub.ddPreview, o);
    $('dd-out').textContent = b.text;
    $('dd-meta').textContent = `보낼 내용 ${b.meta.chars}자 · 코드 발췌 ${b.meta.excerpts}개 — 이 텍스트가 그대로 전송됩니다`;
  } catch (e) { toast(e.message, true); }
});

$('dd-run').addEventListener('click', async () => {
  const o = ddOpts();
  if (!o.map || !o.topic) { toast('심볼 맵과 주제를 지정하세요.', true); return; }
  $('dd-run').disabled = true;
  $('dd-meta').textContent = o.reviewer.startsWith('mcp:')
    ? '외부 AI가 분석하는 중...' : '로컬 모델이 분석하는 중 (수 분 걸릴 수 있음)...';
  $('dd-out').textContent = '';
  try {
    const r = await call(window.hub.ddAnalyze, o);
    $('dd-out').textContent = r.answer;
    $('dd-meta').textContent = `${r.external ? '외부' : '로컬'} 분석 완료 · ${(r.elapsedMs / 1000).toFixed(0)}초 · 브리핑 ${r.meta.chars}자 · 발췌 ${r.meta.excerpts}개`
      + (r.savedMemoryId ? ' · 학습노트 저장됨' : '');
  } catch (e) { $('dd-meta').textContent = ''; toast(e.message, true); }
  finally { $('dd-run').disabled = false; }
});

// ---- engine symbol map ------------------------------------------------------
// 임베딩 없이 만드는 좌표 지도. 맵이 하나도 없으면 **먼저 경로 매핑을 요구**한다 —
// 이게 없으면 외부 AI가 이 엔진의 실제 위치를 알 방법이 없다.

async function refreshSymbolMap() {
  try {
    const [maps, suggest] = await Promise.all([call(window.hub.symList), call(window.hub.symSuggest)]);
    window._symSuggest = suggest;
    $('sym-suggest').innerHTML = (maps.length ? '' : '<div class="warn" style="margin-bottom:6px">엔진 소스 경로가 아직 매핑되지 않았습니다. 아래에서 경로를 고르고 스캔하세요.</div>')
      + (suggest.length
        ? suggest.map((s, i) => `<button class="small" data-sym-sg="${i}">＋ ${esc(s.label)}</button>`).join(' ')
        : '<div class="hint">엔진 소스가 자동 감지되지 않았습니다. 경로를 직접 지정하세요.</div>');
    document.querySelectorAll('[data-sym-sg]').forEach((b) => b.addEventListener('click', () => {
      const s = window._symSuggest[Number(b.dataset.symSg)];
      $('sym-name').value = s.label.replace(/[^\w-]+/g, '-').toLowerCase().slice(0, 40);
      $('sym-root').value = s.path;
      toast('경로가 입력되었습니다. "심볼 스캔"을 누르세요.');
    }));
    $('sym-map').innerHTML = maps.length
      ? maps.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('')
      : '<option value="">맵 없음</option>';
    $('sym-list').innerHTML = maps.length
      ? maps.map((m) => `<div style="margin:4px 0">🗺 <b>${esc(m.name)}</b> — 파일 ${m.fileCount} · 심볼 ${m.counts.symbols}`
        + (m.counts.noteSections ? ` · 해설 ${m.counts.noteSections}섹션` : '')
        + ` <button class="small danger" data-sym-del="${esc(m.name)}">삭제</button></div>`).join('')
      : '';
    document.querySelectorAll('[data-sym-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`심볼 맵 "${b.dataset.symDel}"를 삭제할까요?`)) return;
      try { await call(window.hub.symRemove, b.dataset.symDel); refreshSymbolMap(); } catch (e) { toast(e.message, true); }
    }));
  } catch (e) { toast(e.message, true); }
}

/** 인덱스 폼에 지금 적힌 확장자 — 범위의 파일 수를 같은 기준으로 세기 위해. */
function idxExts() {
  return $('idx-exts').value.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 체크된 범위의 합계를 실시간으로 보여 준다(임베딩 비용이 곧 파일 수다). */
function symScopeTotal() {
  const dirs = window._symScopeDirs || [];
  let files = 0;
  let picked = 0;
  dirs.forEach((d, i) => {
    const cb = document.querySelector(`[data-sym-dir="${i}"]`);
    if (cb && cb.checked) { files += d.files; picked++; }
  });
  $('sym-meta').textContent = `선택 ${picked}/${dirs.length}개 디렉터리 · 파일 ${files}개`;
}

function symbolLine(m) {
  return `  ${m.kind.padEnd(10)} ${m.name}\n      ${m.file}:${m.line}${m.module ? `  [${m.module}]` : ''}`;
}

function renderHierarchy(h) {
  if (!h.found) return `${h.symbol}: 이 맵에서 찾지 못했습니다.`;
  const lines = [`${h.self.kind} ${h.self.name}`, `  ${h.self.file}:${h.self.line}  [${h.self.module}]`];
  if (h.interfaces.length) lines.push(`  인터페이스: ${h.interfaces.join(', ')}`);
  if (h.ancestors.length) {
    lines.push('', '조상:');
    h.ancestors.forEach((a, i) => lines.push(`  ${'  '.repeat(i)}↑ ${a.name}${a.file ? `  (${a.file}:${a.line})` : '  (트리 밖)'}`));
  }
  lines.push('', `직계 자식 ${h.childCount}개:`);
  for (const c of h.children.slice(0, 40)) lines.push(`  ↓ ${c.name}  (${c.file}:${c.line})`);
  if (h.childCount > 40) lines.push(`  … 외 ${h.childCount - 40}개`);
  if (h.notes.length) {
    lines.push('', '해설 문서:');
    for (const n of h.notes) lines.push(`  📖 ${n.file}:${n.line}  ${n.title}`);
  }
  return lines.join('\n');
}

$('sym-pick').addEventListener('click', async () => {
  try {
    const dir = await call(window.hub.symPickDir);
    if (dir) $('sym-root').value = dir;
  } catch (e) { toast(e.message, true); }
});

$('sym-scan').addEventListener('click', async () => {
  const name = $('sym-name').value.trim();
  const root = $('sym-root').value.trim();
  if (!name || !root) { toast('맵 이름과 엔진 소스 경로를 입력하세요.', true); return; }
  const notesRoots = $('sym-notes').value.split('\n').map((s) => s.trim()).filter(Boolean);
  $('sym-scan').disabled = true;
  $('sym-meta').textContent = '심볼을 스캔하는 중...';
  try {
    await call(window.hub.symScan, { name, root, notesRoots });
  } catch (e) { $('sym-meta').textContent = ''; $('sym-scan').disabled = false; toast(e.message, true); }
});

window.hub.onSymProgress((p) => {
  $('sym-meta').textContent = p.phase === 'notes'
    ? `해설 문서 ${p.done}/${p.total}`
    : `소스 ${p.done}/${p.total}`;
});

window.hub.onSymDone((p) => {
  $('sym-scan').disabled = false;
  if (p.error) { $('sym-meta').textContent = ''; toast(p.error, true); return; }
  const c = p.info.counts;
  $('sym-meta').textContent = `스캔 완료: 파일 ${p.info.fileCount}개 → 심볼 ${c.symbols}개`
    + (c.noteSections ? ` · 해설 ${c.noteSections}섹션` : '');
  refreshSymbolMap().then(() => { $('sym-map').value = p.info.name; });
});

$('sym-find').addEventListener('click', async () => {
  const name = $('sym-map').value;
  const q = $('sym-query').value.trim();
  if (!name || !q) { toast('맵과 심볼 이름을 지정하세요.', true); return; }
  try {
    const r = await call(window.hub.symFind, name, q, { limit: 40 });
    const out = [`"${r.query}" — ${r.total}건${r.total > r.matches.length ? ` (상위 ${r.matches.length}개)` : ''}`, ''];
    for (const m of r.matches) out.push(symbolLine(m));
    if (r.notes.length) {
      out.push('', '해설 문서:');
      for (const n of r.notes) out.push(`  📖 ${n.file}:${n.line}  ${n.title}`);
    }
    $('sym-out').textContent = r.total ? out.join('\n') : '일치하는 심볼이 없습니다.';
    $('sym-meta').textContent = `심볼 검색: "${r.query}"`;
  } catch (e) { toast(e.message, true); }
});

// 1계층 → 2계층. 검색에 걸린 심볼이 모인 디렉터리만 골라 인덱스 폼에 채운다.
// 임베딩은 비싸므로(엔진 전체 3.4시간) 무엇을 얼마나 색인할지 먼저 보여 준다.
$('sym-scope').addEventListener('click', async () => {
  const name = $('sym-map').value;
  const q = $('sym-query').value.trim();
  if (!name || !q) { toast('맵과 심볼 이름을 지정하세요.', true); return; }
  try {
    const s = await call(window.hub.symScope, name, q, { depth: 4, exts: idxExts() });
    if (!s.dirs.length) { toast('걸린 심볼이 없어 좁힐 범위가 없습니다.', true); return; }
    window._symScopeRoot = s.root;
    // 심볼 몇 개 때문에 디렉터리 전체(파일 수천 개)를 끌고 오는 항목이 섞인다.
    // 체크박스로 드러내 사용자가 빼도록 한다 — 임베딩은 비싸다.
    $('sym-scope-list').innerHTML = `<div class="hint" style="margin:6px 0">"${esc(q)}" 심볼 ${s.symbolCount}개가 모인 디렉터리 — 색인할 것만 남기세요</div>`
      + s.dirs.map((d, i) =>
        `<label class="row" style="gap:6px"><input type="checkbox" data-sym-dir="${i}" checked />`
        + `<span>심볼 <b>${d.symbols}</b> · 파일 <b>${d.files}</b> — <code>${esc(d.dir)}</code></span></label>`).join('')
      + '<div class="row"><button id="sym-scope-apply" class="small primary">이 범위로 인덱스 설정</button></div>';
    document.querySelectorAll('[data-sym-dir]').forEach((cb) => cb.addEventListener('change', symScopeTotal));
    $('sym-scope-apply').addEventListener('click', () => {
      const dirs = s.dirs.filter((_, i) => document.querySelector(`[data-sym-dir="${i}"]`).checked).map((d) => d.dir);
      if (!dirs.length) { toast('디렉터리를 하나 이상 고르세요.', true); return; }
      window._symScope = { root: s.root, dirs };
      $('idx-name').value = `${name}-${q.toLowerCase().replace(/[^\w-]+/g, '')}`.slice(0, 48);
      $('idx-root').value = s.root;
      invalidateCloudPreview();
      toast(`범위 ${dirs.length}개 디렉터리가 설정되었습니다. 아래 "인덱싱 시작"을 누르세요.`);
    });
    window._symScopeDirs = s.dirs;
    symScopeTotal();
    $('sym-out').textContent = '';
  } catch (e) { toast(e.message, true); }
});

$('sym-tree').addEventListener('click', async () => {
  const name = $('sym-map').value;
  const q = $('sym-query').value.trim();
  if (!name || !q) { toast('맵과 심볼 이름을 지정하세요.', true); return; }
  try {
    const h = await call(window.hub.symHierarchy, name, q);
    $('sym-out').textContent = renderHierarchy(h);
    $('sym-meta').textContent = `상속 계층: ${q}`;
  } catch (e) { toast(e.message, true); }
});

// ---- rendering-pipeline analysis -------------------------------------------

async function refreshRenderpipe() {
  try {
    const [maps, suggest] = await Promise.all([call(window.hub.rpList), call(window.hub.rpSuggest)]);
    $('rp-suggest').innerHTML = suggest.length
      ? suggest.map((s, i) => `<button class="small" data-rp-sg="${i}">＋ ${esc(s.label)} 스캔 설정</button>`).join(' ')
      : '';
    window._rpSuggest = suggest;
    document.querySelectorAll('[data-rp-sg]').forEach((b) => b.addEventListener('click', () => {
      const s = window._rpSuggest[Number(b.dataset.rpSg)];
      $('rp-name').value = s.name;
      $('rp-root').value = s.path;
      toast('스캔 설정이 입력되었습니다. "구조 스캔"을 누르세요.');
    }));
    $('rp-map').innerHTML = maps.length
      ? maps.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('')
      : '<option value="">스캔 없음</option>';
    $('rp-list').innerHTML = maps.length
      ? maps.map((m) => {
        const c = m.counts;
        return `<div style="margin:4px 0">📊 <b>${esc(m.name)}</b> — 패스 ${c.rdgPasses} · 셰이더 ${c.shaders} · GPU스탯 ${c.gpuStats} · 드로우 ${c.drawEvents} · 렌더러함수 ${c.rendererFuncs} <button class="small danger" data-rp-del="${esc(m.name)}">삭제</button></div>`;
      }).join('')
      : '<div class="hint">아직 스캔한 렌더링 맵이 없습니다.</div>';
    document.querySelectorAll('[data-rp-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`렌더링 맵 "${b.dataset.rpDel}"를 삭제할까요?`)) return;
      try { await call(window.hub.rpRemove, b.dataset.rpDel); refreshRenderpipe(); } catch (e) { toast(e.message, true); }
    }));
  } catch (e) { toast(e.message, true); }
}

$('rp-scan').addEventListener('click', async () => {
  const name = $('rp-name').value.trim();
  const root = $('rp-root').value.trim();
  if (!name || !root) return toast('스캔 이름과 소스 경로를 입력하세요.', true);
  $('rp-scan').disabled = true;
  $('rp-meta').textContent = '소스 구조를 스캔하는 중...';
  try {
    const s = await call(window.hub.rpScan, name, root);
    const c = s.counts;
    $('rp-meta').textContent = `스캔 완료: ${s.fileCount}개 파일 · 패스 ${c.rdgPasses} · 셰이더 ${c.shaders} · GPU스탯 ${c.gpuStats} · 드로우 ${c.drawEvents} · 렌더러함수 ${c.rendererFuncs}`;
    await refreshRenderpipe();
    $('rp-map').value = name;
  } catch (e) { $('rp-meta').textContent = ''; toast(e.message, true); }
  finally { $('rp-scan').disabled = false; }
});

$('rp-find').addEventListener('click', async () => {
  const name = $('rp-map').value;
  if (!name) return toast('먼저 렌더링 맵을 스캔하세요.', true);
  try {
    const q = await call(window.hub.rpQuery, name, $('rp-topic').value.trim());
    const catLabel = { rdgPasses: 'RDG 패스', shaders: '셰이더', gpuStats: 'GPU 스탯', drawEvents: '드로우 이벤트', rendererFuncs: '렌더러 함수' };
    let out = '';
    for (const [cat, c] of Object.entries(q.categories)) {
      if (!c.items.length) continue;
      out += `── ${catLabel[cat]} (${c.total}건) ──\n` +
        c.items.map((x) => `  ${x.name}  —  ${x.file}:${x.line}`).join('\n') + '\n\n';
    }
    $('rp-out').textContent = out || '해당 키워드로 찾은 항목이 없습니다.';
    $('rp-meta').textContent = `지도 검색: "${q.filter || '전체'}"`;
  } catch (e) { toast(e.message, true); }
});

$('rp-analyze').addEventListener('click', async () => {
  const name = $('rp-map').value;
  const topic = $('rp-topic').value.trim();
  if (!name) return toast('먼저 렌더링 맵을 스캔하세요.', true);
  if (!topic) return toast('분석할 주제를 입력하세요 (예: BasePass).', true);
  $('rp-analyze').disabled = true;
  $('rp-meta').textContent = '렌더링 맵과 실제 코드를 근거로 로컬 AI가 분석하는 중...';
  $('rp-out').textContent = '';
  try {
    const r = await call(window.hub.rpAnalyze, name, topic, $('rp-save').checked);
    $('rp-out').textContent = r.answer +
      (r.sources.length ? '\n\n── 근거 소스 ──\n' + r.sources.map((s) => `${s.file}:${s.startLine}-${s.endLine}`).join('\n') : '');
    $('rp-meta').textContent = `모델: ${r.model} · 지도 매칭 ${r.mapHits}건${r.savedMemoryId ? ' · 학습 노트 저장됨' : ''}`;
  } catch (e) {
    $('rp-meta').textContent = '';
    toast(e.message, true);
  } finally {
    $('rp-analyze').disabled = false;
  }
});

async function refreshIdxList() {
  const list = await call(window.hub.idxList);
  $('idx-list').innerHTML = list.length
    ? '<tr><th>이름</th><th>청크</th><th>클래스</th><th>갱신</th><th></th></tr>' +
      list.map((i) => `<tr>
        <td>${esc(i.name)}<div class="hint">${esc(i.root)}</div></td>
        <td>${i.chunkCount ?? '-'}</td><td>${i.classCount ?? '-'}</td>
        <td class="hint">${esc((i.updatedAt || '').slice(0, 16).replace('T', ' '))}${i.indexing ? ' <span class="warn">(빌드 중)</span>' : ''}</td>
        <td><button class="small danger" data-idx-del="${esc(i.name)}">삭제</button></td>
      </tr>`).join('')
    : '<tr><td class="hint">아직 인덱스가 없습니다.</td></tr>';
  const opts = list.map((i) => `<option value="${esc(i.name)}">${esc(i.name)}</option>`).join('');
  $('q-index').innerHTML = opts;
  $('ft-index').innerHTML = opts;
  document.querySelectorAll('[data-idx-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`인덱스 "${b.dataset.idxDel}"를 삭제할까요?`)) return;
    try { await call(window.hub.idxDelete, b.dataset.idxDel); refreshIdxList(); } catch (e) { toast(e.message, true); }
  }));
}

$('idx-pick').addEventListener('click', async () => {
  const p = await call(window.hub.idxPickRoot);
  if (p) {
    $('idx-root').value = p;
    invalidateCloudPreview();
  }
});

// 인덱싱 범위 프리셋 — 고르면 확장자 칸을 채운다(직접 수정도 가능).
call(window.hub.idxPresets).then((presets) => {
  $('idx-preset').innerHTML = presets
    .map((p) => `<option value="${esc(p.exts.join(','))}">${esc(p.label)}</option>`).join('');
  $('idx-preset').addEventListener('change', () => {
    $('idx-exts').value = $('idx-preset').value;
    invalidateCloudPreview();
  });
}).catch(() => { /* 프리셋을 못 받아도 확장자를 직접 입력하면 된다 */ });

let activeIndexName = '', activeIndexJob = '', indexStarting = false;
$('idx-build').addEventListener('click', async () => {
  const name = $('idx-name').value.trim();
  const root = $('idx-root').value.trim();
  if (!name || !root) return toast('인덱스 이름과 루트 경로를 입력하세요.', true);
  const exts = $('idx-exts').value.split(',').map((s) => s.trim()).filter(Boolean);
  // 심볼 맵이 좁혀 준 범위. 루트를 바꿨으면 그 범위는 더 이상 유효하지 않다.
  const scope = window._symScope;
  const subdirs = scope && scope.root === root ? scope.dirs : [];
  activeIndexName = name;
  activeIndexJob = '';
  indexStarting = true;
  $('idx-build').disabled = true;
  $('idx-cancel').disabled = false;
  $('idx-progress').textContent = '서버·임베딩 모델 확인 중...';
  $('idx-last-diagnostic').textContent = '';
  try {
    const result = await call(window.hub.idxBuild, { name, root, exts, subdirs });
    if (indexStarting) activeIndexJob = result.jobId;
  } catch (e) {
    indexStarting = false;
    $('idx-build').disabled = false;
    $('idx-cancel').disabled = true;
    toast(e.message, true);
  }
});

$('idx-cancel').addEventListener('click', async () => {
  try { await call(window.hub.idxCancel, activeIndexName); } catch (e) { toast(e.message, true); }
});
window.hub.onIndexProgress((p) => {
  if (activeIndexName && p.name !== activeIndexName) return;
  if (activeIndexJob && p.jobId && p.jobId !== activeIndexJob) return;
  if (p.phase === 'error' || p.phase === 'done') {
    indexStarting = false;
    activeIndexJob = '';
    $('idx-build').disabled = false;
    $('idx-cancel').disabled = true;
    $('idx-last-diagnostic').textContent = JSON.stringify(p, null, 2);
    refreshSourceDiagnostics();
  }
  if (p.phase === 'error') {
    $('idx-progress').textContent = `[${p.diagnostic?.category || 'unknown'}] ${p.error}${p.logError ? ' · 진단 저장 실패' : ''}`;
  } else if (p.phase === 'done') {
    $('idx-progress').textContent = `완료 — 청크 ${p.chunks ?? p.total ?? ''}개${p.logError ? ' · 진단 저장 실패' : ''}`;
    refreshIdxList();
  } else {
    const pct = p.total ? Math.round((p.embedded / p.total) * 100) : 0;
    // 재사용 청크 수를 보여주면 증분 재색인이 실제로 일하고 있는지 바로 안다.
    const reused = p.reused ? ` · 재사용 ${p.reused}` : '';
    $('idx-progress').textContent =
      p.phase === 'checking-server' ? '서버·임베딩 모델 확인 중...'
        : `[${p.phase}] 파일 ${p.files ?? 0} · 청크 ${p.chunks ?? 0}${reused} · 임베딩 ${p.embedded ?? 0}/${p.total ?? 0} (${pct}%)`;
    if (p.retry) $('idx-progress').textContent += ` · 시도 ${p.retry.attempt} 실패 [${p.retry.category}]`;
    if (p.logError) $('idx-progress').textContent += ' · 진단 저장 실패';
  }
});

async function refreshSourceDiagnostics() {
  try { $('idx-diagnostics').textContent = JSON.stringify(await call(window.hub.idxDiagnostics), null, 2); }
  catch (e) { $('idx-diagnostics').textContent = `로그 읽기 실패: ${e.message}`; }
}
$('idx-log-refresh').addEventListener('click', refreshSourceDiagnostics);
$('idx-log-copy').addEventListener('click', async () => {
  try {
    const rows = await call(window.hub.idxDiagnostics);
    await navigator.clipboard.writeText(JSON.stringify(rows, null, 2));
    toast('진단 로그를 복사했습니다.');
  } catch (e) { toast(`로그 복사 실패: ${e.message}`, true); }
});
let cloudPreview = null, cloudJobId = '', cloudPreparing = false, previewRevision = 0;
const completedCloudJobs = new Set();
function sourceRecipient() {
  return $('idx-local-only').checked ? { privacy: 'local-only', worker: 'local' }
    : { privacy: 'external', worker: $('idx-cloud-worker').value };
}
function updateCloudStart() {
  $('idx-cloud-start').disabled = cloudPreparing || Boolean(cloudJobId) || !cloudPreview
    || cloudPreview.expiresAt < Date.now() || !$('idx-cloud-consent').checked || !sourceRecipient().worker;
}
function invalidateCloudPreview() {
  previewRevision++;
  cloudPreview = null;
  $('idx-cloud-consent').checked = false;
  $('idx-cloud-text').textContent = '';
  $('idx-cloud-scope').textContent = '내용이 바뀌었습니다. 전송 내용을 다시 확인하세요.';
  updateCloudStart();
}
for (const id of ['idx-root', 'idx-exts', 'idx-cloud-question', 'idx-cloud-paths']) {
  $(id).addEventListener('input', invalidateCloudPreview);
}
$('idx-cloud-consent').addEventListener('change', updateCloudStart);
$('idx-local-only').addEventListener('change', () => {
  $('idx-cloud-worker').disabled = $('idx-local-only').checked;
  invalidateCloudPreview();
});
$('idx-cloud-worker').addEventListener('change', invalidateCloudPreview);
async function refreshCloudTargets() {
  const previous = $('idx-cloud-worker').value;
  const targets = await call(window.hub.idxCloudTargets);
  $('idx-cloud-worker').innerHTML = targets.map(t => `<option value="${t.available ? esc(t.id) : ''}" ${t.available ? '' : 'disabled'}>${esc(t.label)}${t.available ? '' : ' — CLI 없음'}</option>`).join('');
  const first = targets.find(t => t.id === previous && t.available) || targets.find(t => t.available);
  $('idx-cloud-worker').value = first ? first.id : '';
  if ($('idx-cloud-worker').value !== previous) invalidateCloudPreview();
  updateCloudStart();
}
$('idx-cloud-preview').addEventListener('click', async () => {
  invalidateCloudPreview();
  const revision = previewRevision;
  cloudPreparing = true;
  $('idx-cloud-preview').disabled = true;
  $('idx-cloud-state').textContent = '소스 발췌 준비 중...';
  updateCloudStart();
  try {
    const root = $('idx-root').value.trim(), scope = window._symScope;
    const result = await call(window.hub.idxCloudPreview, {
      ...sourceRecipient(), root, exts: $('idx-exts').value.split(',').map(s => s.trim()).filter(Boolean),
      subdirs: scope?.root === root ? scope.dirs : [], question: $('idx-cloud-question').value,
      paths: $('idx-cloud-paths').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
    });
    if (revision !== previewRevision) return;
    cloudPreview = result;
    $('idx-cloud-text').textContent = result.text;
    $('idx-cloud-scope').textContent = `수신 작업자 ${result.worker} · 발췌 ${result.files.length}개 · ${result.chars}자 · 후보 ${result.candidateCount}개 · 제외 ${result.skipped}개${result.truncated ? ' · 일부 범위만 포함됨' : ''} · 10분간 유효`;
    $('idx-cloud-state').textContent = '전송 내용과 실행 대상을 확인한 뒤 동의해 주세요.';
  } catch (e) { $('idx-cloud-state').textContent = e.message; refreshSourceDiagnostics(); }
  finally { cloudPreparing = false; $('idx-cloud-preview').disabled = Boolean(cloudJobId); updateCloudStart(); }
});
$('idx-cloud-start').addEventListener('click', async () => {
  if (!cloudPreview || !$('idx-cloud-consent').checked) return;
  cloudPreparing = true;
  $('idx-cloud-preview').disabled = true;
  updateCloudStart();
  $('idx-cloud-answer').textContent = '';
  try {
    const result = await call(window.hub.idxCloudStart, { previewId: cloudPreview.id, ...sourceRecipient(), confirmed: true });
    cloudPreview = null;
    $('idx-cloud-consent').checked = false;
    if (completedCloudJobs.has(result.jobId)) return;
    cloudJobId = result.jobId;
    $('idx-cloud-state').textContent = `소스 분석 중 · ${result.worker} · ${result.jobId}`;
    $('idx-cloud-cancel').disabled = false;
  } catch (e) { $('idx-cloud-state').textContent = e.message; }
  finally { cloudPreparing = false; $('idx-cloud-preview').disabled = Boolean(cloudJobId); updateCloudStart(); }
});
$('idx-cloud-cancel').addEventListener('click', async () => {
  try { if (cloudJobId) await call(window.hub.idxCloudCancel, cloudJobId); } catch (e) { toast(e.message, true); }
});
window.hub.onIndexCloudProgress(p => {
  if (cloudJobId && p.jobId !== cloudJobId) return;
  if (p.phase === 'running') return;
  completedCloudJobs.add(p.jobId);
  if (completedCloudJobs.size > 20) completedCloudJobs.delete(completedCloudJobs.values().next().value);
  $('idx-cloud-state').textContent = p.phase === 'done'
    ? `소스 분석 완료 · ${p.worker} · ${p.model || '모델 미확인'}${p.truncated ? ' · 일부 소스만 분석' : ''} · 벡터 인덱싱 상태는 별도입니다.`
    : `[${p.diagnostic?.category || p.phase}] ${p.diagnostic?.hint || '실패 원인을 확인하세요.'}`;
  if (p.logError) $('idx-cloud-state').textContent += ' · 진단 저장 실패';
  $('idx-cloud-answer').textContent = p.answer || '';
  $('idx-last-diagnostic').textContent = JSON.stringify({ ...p, answer: undefined }, null, 2);
  cloudJobId = '';
  $('idx-cloud-preview').disabled = false;
  $('idx-cloud-cancel').disabled = true;
  updateCloudStart();
  refreshSourceDiagnostics();
});

$('q-run').addEventListener('click', async () => {
  const idx = $('q-index').value;
  const q = $('q-text').value.trim();
  if (!idx || !q) return toast('인덱스와 검색어를 입력하세요.', true);
  $('q-out').textContent = '검색 중...';
  try {
    const r = await call(window.hub.idxSearch, idx, q, 6);
    $('q-out').textContent = r.map((x) =>
      `[${x.score}] ${x.file}:${x.startLine}-${x.endLine}\n${x.text.slice(0, 400)}\n`).join('\n────────────\n');
  } catch (e) { $('q-out').textContent = '오류: ' + e.message; }
});

$('q-class-run').addEventListener('click', async () => {
  const idx = $('q-index').value;
  const c = $('q-class').value.trim();
  if (!idx || !c) return toast('인덱스와 클래스명을 입력하세요.', true);
  try {
    const r = await call(window.hub.idxClass, idx, c);
    $('q-out').textContent = JSON.stringify(r, null, 2);
  } catch (e) { $('q-out').textContent = '오류: ' + e.message; }
});

let currentFtJob = null;
$('ft-run').addEventListener('click', async () => {
  const indexName = $('ft-index').value;
  if (!indexName) return toast('인덱스를 먼저 만드세요.', true);
  try {
    await call(window.hub.ftGenerate, {
      indexName,
      count: Number($('ft-count').value) || 100,
      model: $('ft-model').value.trim() || undefined,
    });
    $('ft-progress').textContent = '생성 시작됨... (로컬 모델 속도에 따라 오래 걸릴 수 있음)';
  } catch (e) { toast(e.message, true); }
});
$('ft-stop').addEventListener('click', async () => {
  if (currentFtJob) await call(window.hub.ftCancel, currentFtJob).catch(() => {});
  toast('중지 요청됨 — 현재 항목까지 저장됩니다.');
});
$('ft-open').addEventListener('click', () => call(window.hub.ftOpenDir).catch((e) => toast(e.message, true)));

window.hub.onFtProgress((p) => {
  if (p.job) currentFtJob = p.job;
  if (p.phase === 'error') $('ft-progress').innerHTML = `<span class="bad">오류: ${esc(p.error)}</span>`;
  else if (p.phase === 'done') {
    $('ft-progress').innerHTML = `<span class="ok">완료 — 성공 ${p.ok} / 실패 ${p.failed}</span> <span class="hint">${esc(p.outFile || '')}</span>`;
    refreshFtList();
  } else {
    $('ft-progress').textContent = `[${p.phase}] ${p.done ?? 0}/${p.total ?? 0} (성공 ${p.ok ?? 0}, 실패 ${p.failed ?? 0})`;
  }
});

async function refreshFtList() {
  const list = await call(window.hub.ftList);
  $('ft-list').innerHTML = list.length
    ? '<tr><th>파일</th><th>크기</th><th>생성</th></tr>' +
      list.map((f) => `<tr><td>${esc(f.file)}</td><td>${f.sizeKB} KB</td><td class="hint">${esc(f.mtime.slice(0, 16).replace('T', ' '))}</td></tr>`).join('')
    : '<tr><td class="hint">생성된 데이터셋이 없습니다.</td></tr>';
}

// ---- source Q&A (학습) ------------------------------------------------------

async function refreshLearning() {
  const select = $('learn-index');
  try {
    const list = await call(window.hub.idxList);
    const selected = select.value;
    select.replaceChildren(...list.map(i => new Option(i.name, i.name)));
    if (list.some(i => i.name === selected)) select.value = selected;
  } catch (e) {
    select.replaceChildren();
    toast(e.message, true);
  }
}

$('idx-open-learning').addEventListener('click', () => hubGo('learning', 'learn-q'));
$('learn-manage-index').addEventListener('click', () => hubGo('source', 'idx-root'));
$('learn-open-evidence').addEventListener('click', () => {
  hubGo('source', 'ag-purpose');
  if ($('ag-purpose')) $('ag-purpose').value = 'learning';
  else toast('이 버전에서는 분석 근거 화면을 열 수 없습니다.', true);
});
$('learn-read-notes').addEventListener('click', async () => {
  const output = $('learn-notes');
  try {
    const rows = await call(window.hub.memList, 'note', 50);
    const notes = rows.filter(row => ['source-qa', 'deepdive', 'render-analyze'].includes(row.source) ||
      (Array.isArray(row.tags) && row.tags.includes('learning')));
    output.replaceChildren(...notes.map(note => {
      const p = document.createElement('p');
      p.textContent = note.text;
      return p;
    }));
    if (!notes.length) output.textContent = '최근 노트 50개에 학습 노트가 없습니다.';
  } catch (e) { output.textContent = e.message; }
});

$('learn-ask').addEventListener('click', async () => {
  const q = $('learn-q').value.trim();
  const idx = $('learn-index').value;
  if (!q) return toast('질문을 입력하세요.', true);
  if (!idx) return toast('소스 인덱스 관리에서 학습할 인덱스를 먼저 만드세요.', true);
  $('learn-ask').disabled = true;
  $('learn-meta').textContent = '관련 코드를 찾고 로컬 모델이 설명을 작성하는 중...';
  $('learn-out').textContent = '';
  try {
    const r = await call(window.hub.learnAsk, idx, q, $('learn-save').checked);
    $('learn-out').textContent = r.answer +
      '\n\n── 근거 소스 ──\n' + r.sources.map((s, i) => `[${i + 1}] ${s.file}:${s.startLine}-${s.endLine}`).join('\n');
    $('learn-meta').textContent = `모델: ${r.model}${r.savedMemoryId ? ' · 학습 노트로 저장됨' : ''}`;
  } catch (e) {
    $('learn-meta').textContent = '';
    toast(e.message, true);
  } finally {
    $('learn-ask').disabled = false;
  }
});

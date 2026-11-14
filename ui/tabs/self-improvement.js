'use strict';
// 자가개선 탭: 평가 3계층 · RSI 3중 루프 · 제안 승인 · 하네스 연결 · 구조/캐시/거버너/Obsidian.
// 전역 이름 충돌을 피하려고 IIFE 안에 둔다(렌더러 규칙). 동적 HTML은 모두 esc()를 거친다.
(() => {
  const pct = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`);
  const num = (v) => (v == null ? '-' : String(v));
  const state = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  // 2계층이 판정을 하나도 못 냈을 때의 이유(조각 수·창·근거 크기·답 분포) — 점수 null만으로는 입력이 창보다 컸는지 모른다.
  const noDecisionText = (n) => (n ? ` · 판정 없음: 조각 ${num(n.parts)} · 창 ${num(n.contextLength)} · 근거 ${num(n.evidenceChars)}자 · ${esc(Object.entries(n.verdicts || {}).map(([v, c]) => `${v} ${c}`).join(', '))}` : '');

  function renderEval(ev) {
    const rows = [];
    for (const tier of ['deterministic', 'agent', 'meta']) {
      const list = Array.isArray(ev[tier]) ? ev[tier] : [];
      for (const r of list.slice(-3).reverse()) {
        const detail = tier === 'meta' ? `상태 ${esc(r.status)} · 짝 ${num(r.pairs)} · 대상 ${num(r.subjects)} · kappa ${num(r.kappa)} · Brier ${num(r.brier)} · BSS ${num(r.bss)} · 판정 실패율 ${pct(r.judgeFailureRate)}${r.judge ? ` · ${esc(r.judge)}` : ''}`
          : tier === 'agent' ? `점수 ${num(r.score)} · 판정 ${num(r.decisive)}/${(r.items || []).length} · 작업자 ${esc(r.worker)}${r.judgeFailed ? ' · 판정 실패(null)' : ''}${r.failedParts ? ` · 실패 조각 ${num(r.failedParts)}` : ''}${noDecisionText(r.noDecision)}`
            : `점수 ${num(r.score)} · 실패 ${(r.checks || []).filter((c) => !c.pass).map((c) => esc(c.id)).join(', ') || '없음'}`;
        rows.push(`<tr><td>${esc({ deterministic: '1 결정적', agent: '2 에이전트', meta: '3 메타' }[tier])}</td><td>${esc((r.subject && r.subject.label) || r.subject?.kind || '-')}</td><td>${detail}</td><td class="hint">${esc((r.at || '').slice(0, 16))}</td></tr>`);
      }
    }
    const t = ev.metaTrend || {}, items = (ev.agentItems && ev.agentItems.items) || [];
    if (t.status === 'measured') rows.push(`<tr><td>3 메타 추세</td><td>최근 ${num(t.n)}회 (${esc(t.judge)}끼리)</td><td>kappa ${t.kappaDelta >= 0 ? '+' : ''}${num(t.kappaDelta)} · Brier ${t.brierDelta >= 0 ? '+' : ''}${num(t.brierDelta)} (Brier는 낮을수록 좋음)</td><td></td></tr>`);
    if (items.length) rows.push(`<tr><td>2 기준표 항목</td><td>판정 ${num(ev.agentItems.judgments)}회</td><td>위반율 높은 순: ${items.slice(0, 5).map((i) => `${esc(i.id)} ${pct(i.violationRate)}${i.unclearRate ? ` (불명확 ${pct(i.unclearRate)})` : ''}`).join(' · ')}</td><td></td></tr>`);
    $('si-eval').innerHTML = rows.join('') || '<tr><td class="hint">아직 평가 기록이 없습니다.</td></tr>';
  }

  // 제안 → 그 근거를 보는 화면. 원천마다 한 곳; 없는 원천(논문·경로 표 등)은 단추가 없다.
  const EVIDENCE = [
    [/^(knowledge-metrics|user:knowledge-graph)/, '지식 그래프 지표', (p) => {
      const skill = (p.targets || []).find((t) => /^(skills\/|skill:)/.test(t)); // 스킬을 가리키면 그 노드, 아니면(색인 등) 지표 칸
      return skill ? window.HubKnowledgeGraph?.focusSkill(skill) : hubGo('knowledge', 'kgm-panel');
    }],
    [/^governor-eval$/, '디버깅 원인 프로세스', () => hubGo('debugging', 'dbg-culprits')],
    // 진단을 가리키는 제안은 그 진단 줄로(가장 최근 것, 24시간 창). 진단이 없는 공백은 공백 표로.
    [/^monitoring-gaps$/, '모니터링 공백', (p) => {
      const ref = (p.targets || []).filter((t) => t.startsWith('diagnostic:')).pop();
      return ref && typeof dbgShowFinding === 'function' ? dbgShowFinding(ref.split(':').pop(), 86400) : hubGo('selfimprove', 'si-gaps');
    }],
    [/^structure-audit$/, '구조 감사', () => hubGo('selfimprove', 'si-structure')],
    [/^meta-eval$/, '평가 3계층', () => hubGo('selfimprove', 'si-eval')],
  ];
  const shown = new Map();
  let focusId = '';
  // 검토를 사람 결정으로 잰 한 줄: recommend가 대부분이면 검토가 변별하지 않는다는 뜻이다.
  const reviewText = (c) => (c && !c.error && c.reviewVsHuman?.n ? `<p class="hint">검토 ↔ 사람 결정 ${num(c.reviewVsHuman.n)}건: 일치 ${pct(c.reviewVsHuman.agreement)} (늘 recommend라면 ${pct(c.reviewVsHuman.alwaysRecommend)})`
    + ` · recommend 비율 ${pct(c.recommendShare)}${c.discriminates === false ? ' — 변별 없음' : ''}${c.staleOpen?.length ? ` · 근거 생산자가 바뀐 열린 제안 ${num(c.staleOpen.length)}개(검토 revise, 반려는 사람이)` : ''}</p>` : '');
  function renderProposals(list, review) {
    if (!Array.isArray(list) || !list.length) { $('si-proposals').innerHTML = '<p class="hint">제안이 없습니다. "제안 수집 → 검토"를 누르세요.</p>'; return; }
    shown.clear(); for (const p of list) shown.set(p.id, p);
    $('si-proposals').innerHTML = reviewText(review) + list.map((p) => { const ev = EVIDENCE.find(([re]) => re.test(p.origin)); return `<div class="si-proposal" id="si-p-${esc(p.id)}"><b>[${esc(p.loop)}] ${esc(p.title)}</b>
      <div class="hint">${esc(p.origin)} · ${esc(p.state)}${p.review ? ` · 검토 ${esc(p.review.verdict)} (우선순위 ${esc(p.review.score)})${p.review.reasons.length ? ' · ' + esc(p.review.reasons.join('; ')) : ''}` : ''}${p.applicable ? ' · 승인 시 설정 적용' : ''}</div>
      <div class="hint">${esc(p.hypothesis)}</div>
      <div class="row">${ev ? `<button class="small" data-si-evidence="${esc(p.id)}">근거: ${esc(ev[1])}</button>` : ''}${p.state === 'proposed' || p.state === 'reviewed' ? `<button class="small primary" data-si-decide="approved" data-si-id="${esc(p.id)}">승인</button><button class="small" data-si-decide="rejected" data-si-id="${esc(p.id)}">반려</button>` : ''}</div></div>`; }).join('');
    if (focusId) { const el = $('si-p-' + focusId); focusId = ''; hubFlash(el); }
  }
  // 다른 화면(지식 그래프 등)에서 제안 하나로 온다: 탭을 열고, 목록이 그려지면 그 제안으로 스크롤한다.
  window.HubSelfImprove = { show(id) {
    if ($('tab-selfimprove').classList.contains('active')) return hubFlash($('si-p-' + id));
    focusId = String(id); hubGo('selfimprove');
  } };

  function renderHarness(list, bus) {
    const rows = (Array.isArray(list) ? list : []).map((h) => `<tr><td>${esc(h.label || h.id)}</td><td>${h.installed ? esc(h.version || '설치됨') : '미설치'}</td>
      <td>${h.installed ? (h.contractOk ? '계약 정상' : `빠진 플래그: ${esc((h.missing || []).join(', '))}`) : '-'}${h.drift ? ' · ⚠ 업데이트 후 변경' : ''}</td>
      <td>${esc(h.mcp || '-')}</td><td>${h.dispatch ? '직접 전달 가능' : '우편함만'}</td></tr>`);
    $('si-harness').innerHTML = rows.join('') || '<tr><td class="hint">"호환성 탐침"을 누르세요.</td></tr>';
    if (bus && !bus.error) state('si-bus', `버스 이벤트 ${bus.events} · 답 중간값 ${bus.medianMs == null ? '-' : Math.round(bus.medianMs / 1000) + '초'}`);
  }

  // 이번 세션 수치는 재시작하면 0이라, 세션을 넘는 효과는 누적·최근 창(metrics.json)으로 본다.
  function renderCache(c) {
    if (c.error) { state('si-cache', c.error); $('si-cache-keys').innerHTML = ''; return; }
    const s = c.session || {}, life = c.lifetime || {}, recent = c.recent || {};
    const sec = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(1)}초`), ms = (v) => (v == null ? '-' : `${v}ms`);
    state('si-cache', `캐시 적중률 이번 세션 ${pct(s.hitRatio)} (메모리 ${num(s.hits)} · 디스크 ${num(s.diskHits)} · 미스 ${num(s.misses)}) · 최근 ${num(c.recentDays)}일 ${pct(recent.hitRatio)}`
      + ` · 누적 ${pct(life.hitRatio)} (조회 ${num(life.lookups)} · 세션 ${num(c.sessions)}회 · 절약 추정 ${sec(life.savedMs)}, 그중 디스크 ${sec(life.diskSavedMs)}) · 메모 ${num(s.size)}`
      + (c.neverHit?.length ? ` · ⚠ 한 번도 안 맞은 분류: ${c.neverHit.join(', ')}` : ''));
    $('si-cache-keys').innerHTML = (c.byKey || []).map((k) => `<tr><td>${esc(k.key)}</td><td>누적 ${pct(k.lifetime.hitRatio)} · 최근 ${pct(k.recent.hitRatio)}</td>
      <td>메모리 ${num(k.lifetime.hits)} · 디스크 ${num(k.lifetime.diskHits)} · 미스 ${num(k.lifetime.misses)} · 축출 ${num(k.lifetime.evictions)}</td>
      <td>평균 적재 ${ms(k.avgLoadMs)} · 디스크 적중 ${ms(k.avgDiskHitMs)}</td><td>절약 추정 ${sec(k.lifetime.savedMs)} (디스크 ${sec(k.lifetime.diskSavedMs)})</td></tr>`).join('');
  }

  // 원본 갱신 대기·최근 결과. 승인은 사람이 여기서만 한다(MCP에는 결정 도구가 없다).
  const UP_STATE = { pending: '승인 대기', running: '적용 중', applied: '적용됨', approved: '승인됨', rejected: '반려', failed: '실패' };
  async function refreshUpstream() {
    try {
      const { items } = await call(window.hub.siUpstream);
      $('si-upstream').innerHTML = items.length ? items.map((x) => `<div class="si-proposal" id="si-u-${esc(x.id)}"><b>${esc(x.title || `${x.target} → ${x.to}`)}</b>
        <div class="hint">${esc(x.source)} · ${esc(x.kind)} · ${esc(UP_STATE[x.state] || x.state)}${x.risks && x.risks.length ? ` · 위험: ${esc(x.risks.join(', '))}` : ''}${x.review ? ` · 검토 ${esc(x.review.worker || '-')}: ${esc(x.review.verdict)} — ${esc((x.review.reasons || []).join('; '))}` : ''}${x.error ? ` · ${esc(x.error)}` : ''}</div>
        ${x.publicText ? `<details><summary class="hint">바뀐 내용</summary><pre class="hint">${esc(x.publicText)}</pre></details>` : ''}
        ${x.state === 'pending' ? `<div class="row"><button class="small primary" data-si-upstream="approved" data-si-id="${esc(x.id)}">승인·적용</button><button class="small" data-si-upstream="rejected" data-si-id="${esc(x.id)}">반려</button></div>` : ''}</div>`).join('')
        : '<p class="hint">원본 갱신 기록이 없습니다.</p>';
    } catch (e) { $('si-upstream').textContent = e.message; }
  }

  async function refreshSelfImprove() {
    refreshUpstream();
    try {
      const o = await call(window.hub.siOverview);
      renderEval(o.evaluation || {});
      $('si-loops').innerHTML = Array.isArray(o.loops) ? o.loops.map((l) => `<div>${l.installed ? '✓' : '·'} ${esc(l.name)}</div>`).join('') : `<p class="hint">${esc(o.loops?.error || '')}</p>`;
      renderProposals(o.proposals, o.proposalReview);
      renderHarness(o.harnesses, o.bus);
      const s = o.structure || {};
      $('si-structure').textContent = s.error ? s.error : `구조 점수 ${s.score} · 파일 ${s.files} · 줄 ${s.lines} · 순환 ${s.cycles} · 도메인 교차 결합 ${s.coupledFiles} · 상향 의존 ${s.upwardDependencies} · 중복 ${pct(s.duplicateRatio)} · 미분류 ${s.unclassified}`;
      renderCache(o.cache || {});
      const g = o.governor || {};
      state('si-governor', g.error ? g.error : `거버너 ${g.running ? '실행 중' : '정지'} · 로컬 추론 관문 ${g.gate ? `닫힘(${esc(g.gate.reason)})` : '열림'}${g.lastDecision ? ' · 마지막 ' + esc(g.lastDecision.at.slice(11, 16)) : ''}`);
      $('si-gaps').innerHTML = (g.gaps || []).map((x) => `<li>${esc(x.key)} × ${x.count} — ${esc(x.detail)}</li>`).join('');
      const ob = o.obsidian || {};
      state('si-obsidian', ob.error ? ob.error : ob.installed ? `Obsidian 설치됨 · 볼트 ${ob.registered ? '등록됨' : '미등록'}${ob.running ? ' · 실행 중(등록은 종료 후)' : ''}` : `Obsidian 미설치 — Hub 그래프와 Markdown 볼트로 대체 · ${esc(ob.installHint || '')}`);
    } catch (e) { toast(e.message, true); }
  }

  const busy = (id, fn) => async () => { const b = $(id); if (b) b.disabled = true; try { await fn(); } catch (e) { toast(e.message, true); } finally { if (b) b.disabled = false; } };
  document.querySelector('#tabs [data-tab="selfimprove"]')?.addEventListener('click', refreshSelfImprove);
  $('tab-selfimprove')?.addEventListener('click', async (e) => {
    const ev = e.target.closest('[data-si-eval]');
    if (ev) { state('si-eval-state', '평가 중…'); await call(window.hub.siEvaluate, ev.dataset.siSubject || 'hub-source', ev.dataset.siEval, $('si-worker').value); return; }
    const evidence = e.target.closest('[data-si-evidence]');
    if (evidence) { const p = shown.get(evidence.dataset.siEvidence); const ev = p && EVIDENCE.find(([re]) => re.test(p.origin)); if (ev) ev[2](p); return; }
    const up = e.target.closest('[data-si-upstream]');
    if (up) {
      up.disabled = true;
      try { const r = await call(window.hub.siUpstreamDecide, up.dataset.siId, up.dataset.siUpstream); toast(r.state === 'applied' ? '적용했습니다' : r.state === 'failed' ? `적용 실패: ${r.error}` : '반려했습니다', r.state === 'failed'); } catch (err) { toast(err.message, true); }
      refreshUpstream();
      return;
    }
    const d = e.target.closest('[data-si-decide]');
    if (d) {
      const note = $('si-note')?.value || ''; // Electron 렌더러는 prompt()를 지원하지 않는다
      try { const r = await call(window.hub.siDecide, d.dataset.siId, d.dataset.siDecide, note); toast(r.workOrder ? '승인 — 작업 지시서를 남겼습니다' : '처리했습니다'); refreshSelfImprove(); } catch (err) { toast(err.message, true); }
    }
  });
  $('si-install')?.addEventListener('click', busy('si-install', async () => { const r = await call(window.hub.siInstallLoops); state('si-loop-state', `${r.length}개 루프 저장 — 파이프라인 탭에서 실행`); refreshSelfImprove(); }));
  $('si-propose')?.addEventListener('click', busy('si-propose', async () => { state('si-loop-state', '제안 수집 중…'); await call(window.hub.siPropose); }));
  $('si-probe')?.addEventListener('click', busy('si-probe', async () => { state('si-bus', '탐침 중…'); await call(window.hub.siHarnessProbe); }));
  $('si-gc-dry')?.addEventListener('click', busy('si-gc-dry', () => call(window.hub.siCacheGc, true)));
  $('si-gc')?.addEventListener('click', busy('si-gc', () => call(window.hub.siCacheGc, false)));
  $('si-tick')?.addEventListener('click', busy('si-tick', async () => { const r = await call(window.hub.siGovernorTick); toast(r.actions.length ? `거버너 행동 ${r.actions.length}개` : '압박 없음 — 행동 없음'); refreshSelfImprove(); }));
  $('si-obsidian-index')?.addEventListener('click', busy('si-obsidian-index', () => call(window.hub.siObsidianIndex)));
  $('si-upstream-check')?.addEventListener('click', busy('si-upstream-check', async () => { state('si-upstream-state', '점검 중…'); await call(window.hub.siUpstreamCheck); }));
  // 알림을 누르면(open) 자가개선 탭을 열고 그 항목으로 간다. 알림 없이 와도 목록은 갱신한다.
  window.hub.onSiUpstreamApproval?.((p) => {
    refreshUpstream().then(() => { if (p && p.open) { hubGo('selfimprove'); hubFlash($('si-u-' + p.id)); } });
  });
  window.hub.onSiDone?.((p) => {
    if (p.error) toast(`${p.name}: ${p.error}`, true);
    else if (p.name === 'cacheGc') toast(`GC ${p.result.dryRun ? '미리보기' : '완료'}: ${(p.result.removed || []).length}개 디렉터리`);
    else if (p.name === 'obsidianIndex') toast(`볼트 갱신 ${p.result.sync.written}개 · 사용자 수정 보존 ${p.result.sync.keptUserEdits.length}개 · 등록 ${p.result.registration}`);
    else if (p.name === 'propose') toast(`새 제안 ${p.result.added}개 · 검토 ${p.result.reviewed}개`);
    else if (p.name === 'upstreamCheck') { toast(`원본 점검: 포크 ${p.result.forks}개 · 도구 ${(p.result.tools || []).map((t) => `${t.id} ${t.outcome}`).join(', ') || '없음'}`); state('si-upstream-state', ''); }
    state('si-eval-state', ''); state('si-loop-state', '');
    refreshSelfImprove();
  });
})();

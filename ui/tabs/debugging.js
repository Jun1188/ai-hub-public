// 디버깅 탭 — 진단별 원인 프로세스, 렌더링 병목 측정, 프로세스 상세(스레드·메모리 맵 파일·하드웨어).
// 측정은 몇 초 걸리므로 IPC는 바로 {started}를 돌려주고 결과는 dbg:*Done 이벤트로 온다(src/core/debugging/).
'use strict';

const DBG_KIND = { paging: '페이징(디스크에서 메모리로 읽기)', disk_saturation: '디스크 포화', cpu_saturation: 'CPU 포화', vram_spill: 'VRAM 넘침(시스템 RAM으로)' };
const DBG_BOUND = { gpu: 'GPU 병목', 'render-thread': '렌더 스레드 병목', 'rhi-thread': 'RHI 스레드 병목', 'game-thread': '게임 스레드 병목', none: '포화된 단계 없음' };
const DBG_NO_FRAMES = { presentmon_not_found: 'PresentMon이 없습니다 (winget install Intel.PresentMon.Console)',
  etw_not_permitted: '이 계정이 Performance Log Users 그룹이 아니라 스레드·GPU 엔진으로만 판정했습니다', no_presents: '측정 동안 이 프로세스가 화면에 낸 프레임이 없습니다' };
const dbgMiB = (b) => (Number.isFinite(b) ? Math.round(b / 1048576).toLocaleString() : '-');
const dbgEngines = (g) => Object.entries(g || {}).map(([k, v]) => `${k} ${v.avg}%`).join(' ') || '-';

// 대시보드 경고에서 온 진단(시작 시각). 표를 그린 뒤 그 줄을 강조하고 지운다.
let dbgFocusFrom = '';
function dbgShowFinding(from, windowSeconds) {
  dbgFocusFrom = String(from);
  if ([...$('dbg-window').options].some((o) => o.value === String(windowSeconds))) $('dbg-window').value = String(windowSeconds);
  hubGo('debugging');
}

// 대시보드 프로세스 표에서 고른 PID: 그 칸에 넣고 측정을 바로 시작한다.
function dbgOpenProcess(pid, what, expectedStart) {
  const render = what === 'render', input = $(render ? 'dbg-render-pid' : 'dbg-inspect-pid');
  input.value = String(pid);
  hubGo('debugging', input.closest('.card'));
  if (render) dbgRender(expectedStart); else dbgInspect(expectedStart);
}

// PID 칸의 제안 목록: 최근 자원 기록의 프로세스(이름 · 앱 · PID). 직접 입력도 그대로 된다.
function dbgFillPids(processes) {
  const suggestions = new Map();
  for (const p of processes) {
    if (!suggestions.has(p.pid) || p.latestObserved !== false) suggestions.set(p.pid, p);
  }
  $('dbg-pids').innerHTML = [...suggestions.values()].map((p) => {
    const label = p.latestObserved === false ? '이전 관측 · ' + p.name :
      p.name + ' · ' + (p.job ? '작업 ' + p.job.slice(0, 12) : p.app);
    return `<option value="${p.pid}">${esc(label)}</option>`;
  }).join('');
}

async function refreshDebugging() {
  try {
    const r = await call(window.hub.resReport, Number($('dbg-window').value));
    dbgFillPids(r.processes || []);
    // 원인 미상 진단은 제안이 걸려 있거나 그 진단을 찾아온 때만 보인다(표가 '특정 불가' 줄로 차지 않게).
    const rows = (r.findings || []).filter((f) => f.culprits?.length || f.kind === 'paging' || f.proposals?.length || String(f.from) === dbgFocusFrom).slice(-12).reverse();
    $('dbg-culprits').innerHTML = '<tr><th>시각</th><th>진단</th><th>원인 (점유율)</th><th>근거</th><th></th></tr>' + (rows.map((f) => {
      const who = (f.culprits || []).map((c) => `${esc(c.label)}${c.job ? ` <span class="hint">작업 ${esc(c.job.slice(0, 12))}</span>` : ''}`).join('<br>') || '프로세스 특정 불가';
      const basis = f.basis === 'hard-faults-unavailable' ? '프로세스 하드 폴트 미측정' : f.basis === 'hard-faults' ? '하드 폴트' : f.basis === 'io-read' ? '읽기 바이트(옛 기록)' : f.basis === 'gpu-memory' ? 'GPU 메모리(전용+공유)' : f.kind === 'cpu_saturation' ? 'CPU 시간' : '읽기·쓰기 바이트';
      const inspect = f.culprits?.[0]?.inspect;
      return `<tr data-dbg-from="${esc(f.from)}"><td>${esc(new Date(f.from).toLocaleTimeString())} · ${f.seconds}s</td><td>${esc(DBG_KIND[f.kind] || f.kind)}${Number.isFinite(f.availMinMiB) ? `<div class="hint">여유 RAM 최저 ${f.availMinMiB} MiB</div>` : ''}${f.kind === 'paging' ? '<div class="hint">접근한 파일·메모리 압박 유발자는 미확인</div>' : ''}</td>`
        + `<td>${who}</td><td>${esc(basis)}</td><td>${inspect ? `<button class="small" data-dbg-inspect="${esc(inspect.pid)}:${esc(inspect.started)}">자세히</button>` : ''}${(f.proposals || []).map((p) => `<button class="small" data-dbg-proposal="${esc(p.id)}" title="${p.exact ? '이 진단이 근거인 제안' : '같은 종류의 원인 미상 진단에서 나온 제안'}">개선 제안 · ${esc(p.state)}</button>`).join('')}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="hint">이 기간에 원인을 짚을 진단이 없습니다</td></tr>');
    bindDataAction('dbg-inspect', (value) => { const [pid, started] = value.split(':'); $('dbg-inspect-pid').value = pid; dbgInspect(started); });
    bindDataAction('dbg-proposal', (id) => window.HubSelfImprove?.show(id));
    if (dbgFocusFrom) {
      const row = [...$('dbg-culprits').querySelectorAll('[data-dbg-from]')].find((tr) => tr.dataset.dbgFrom === dbgFocusFrom);
      dbgFocusFrom = '';
      if (row) hubFlash(row); else toast('그 진단은 원인을 짚을 기록이 이 기간에 없습니다.');
    }
  } catch (e) { $('dbg-culprits').innerHTML = `<tr><td class="bad">자원 기록을 읽지 못했습니다: ${esc(e.message)}</td></tr>`; }
}

async function dbgRender(expectedStart) {
  try {
    $('dbg-render-start').disabled = true;
    $('dbg-render-state').textContent = `측정 중… (${$('dbg-render-seconds').value}초)`;
    await call(window.hub.dbgRender, $('dbg-render-pid').value || null, Number($('dbg-render-seconds').value), typeof expectedStart === 'string' ? expectedStart : undefined);
  } catch (e) { $('dbg-render-start').disabled = false; $('dbg-render-state').textContent = e.message; }
}

window.hub.onDbgRenderDone((r) => {
  $('dbg-render-start').disabled = false;
  $('dbg-render-state').textContent = r.error === 'process_lifetime_changed' ? r.note : r.error ? `${r.error}${r.note ? ' — ' + r.note : ''}` : `${r.seconds}초 측정`;
  if (r.error) {
    for (const id of ['dbg-render-verdict', 'dbg-render-threads', 'dbg-render-events']) $(id).replaceChildren();
    return;
  }
  const g = r.gpu || {}, f = r.frames;
  const frames = f ? `<div>프레임 ${f.fps} fps · p50 ${f.frameMs.p50} ms · p99 ${f.frameMs.p99} ms · 최대 ${f.frameMs.max} ms · 프레임당 GPU ${f.gpuBusyPercent ?? '-'}%`
    + (f.gpuMs?.busy ? ` · GPU 작업 시간 p50 ${f.gpuMs.busy.p50} ms · p99 ${f.gpuMs.busy.p99} ms <span class="hint">PresentMon ETW 실측 ${f.gpuMs.busy.frames}프레임</span>` : ' · <span class="hint">GPU 시간 미측정</span>')
    + `${f.notDisplayed ? ` · 표시 안 됨 ${f.notDisplayed}` : ''} <span class="hint">${esc(f.presentMode || '')}${f.syncInterval > 0 ? ' · 수직 동기화' : ''}</span></div>`
    : `<div class="hint">프레임 시간 없음: ${esc(DBG_NO_FRAMES[r.framesError] || r.framesError || '-')}</div>`;
  $('dbg-render-verdict').innerHTML = `<b class="${r.bound === 'none' ? 'ok' : 'warn'}">${esc(DBG_BOUND[r.bound] || r.bound)}</b> · ${esc(r.target.name || '')} <span class="hint">${r.target.pid} · ${esc(r.target.app)}</span>`
    + `<div>GPU 엔진 ${esc(dbgEngines(g.engines))} · 보드 ${g.boardUtilAvg ?? '-'}% · VRAM 최고 ${dbgMiB(g.vramPeakBytes)} MiB${g.throttle?.length ? ` · 제한 ${esc(g.throttle.join(','))}` : ''}</div>`
    + frames + `<div class="hint">${esc(r.note)}</div>`;
  $('dbg-render-threads').innerHTML = '<tr><th>스레드</th><th>역할</th><th>평균 (코어 1개 기준)</th><th>최고</th></tr>'
    + r.threads.map((t) => `<tr><td>${esc(t.name || '(이름 없음)')} <span class="hint">${t.id}${t.main ? ' · 주 스레드' : ''}</span></td><td>${esc(t.role || '-')}</td>`
      + `<td class="${t.avg >= 85 ? 'warn' : ''}">${t.avg}%</td><td>${t.peak}%</td></tr>`).join('');
  $('dbg-render-events').innerHTML = [...(r.engine?.findings || []).map((f) => `<li class="warn">${esc(f.kind)} — ${esc(f.note || '')}</li>`),
    ...(r.engine?.events || []).slice(-10).map((e) => `<li>${esc(new Date(e.t).toLocaleTimeString())} · ${esc(e.kind)}${e.total !== undefined ? ` ${e.total}` : ''}</li>`)].join('');
});

async function dbgInspect(expectedStart) {
  try {
    $('dbg-inspect-start').disabled = true;
    $('dbg-inspect-state').textContent = `조사 중… (${$('dbg-inspect-seconds').value}초 + 준비)`;
    await call(window.hub.dbgInspect, $('dbg-inspect-pid').value, Number($('dbg-inspect-seconds').value), typeof expectedStart === 'string' ? expectedStart : undefined);
  } catch (e) { $('dbg-inspect-start').disabled = false; $('dbg-inspect-state').textContent = e.message; }
}

window.hub.onDbgInspectDone((r) => {
  $('dbg-inspect-start').disabled = false;
  $('dbg-inspect-state').textContent = r.error === 'process_replaced' ? '선택한 PID가 재사용됐습니다. 현재 프로세스를 다시 선택하세요.' :
    r.error === 'process_start_unverified' ? '선택한 프로세스의 생성 시각을 확인하지 못했습니다.' : r.error || `${r.seconds}초 조사`;
  if (r.error) {
    for (const id of ['dbg-inspect-summary', 'dbg-inspect-files', 'dbg-inspect-threads']) $(id).textContent = '';
    return;
  }
  const h = r.hardware || {}, p = r.process;
  $('dbg-inspect-summary').innerHTML = `<b>${esc(p.name || '')}</b> <span class="hint">${p.pid} · ${esc(p.app)}${p.role ? ' · ' + esc(p.role) : ''}${p.job ? ' · 작업 ' + esc(p.job.slice(0, 12)) : ''}</span>`
    + `<div>CPU 평균 ${h.cpuPercent?.avg ?? '-'}% · GPU ${esc(dbgEngines(h.gpuPercent))} · VRAM 최고 ${dbgMiB(h.vramPeakBytes)} MiB · 메모리 최고 ${dbgMiB(h.memPeakBytes)} MiB`
    + ` · 읽기 ${dbgMiB(h.ioReadBytes)} MiB · 쓰기 ${dbgMiB(h.ioWriteBytes)} MiB · 하드 폴트 ${h.hardFaultsPerSec ? `${h.hardFaultsPerSec.avg}/s (최고 ${h.hardFaultsPerSec.peak})` : '미측정'}</div>`
    + (h.hardFaultObservation ? `<div>최근 계측 구간 · ${esc(h.hardFaultObservation.previous)} → ${esc(h.hardFaultObservation.current)} · ${Number(h.hardFaultObservation.intervalMs).toFixed(2)} ms에 ${esc(h.hardFaultObservation.delta)}건</div>` : '')
    + '<div class="hint">Windows 프로세스 누적 카운터는 저장장치 읽기가 필요했던 폴트를 셉니다. 파일·페이지파일·주소·스택과 메모리 압박 유발자는 이 카운터로 식별할 수 없습니다. 아래 상주량 증가는 연관 단서입니다.</div>'
    + (r.filesError ? `<div class="warn">메모리 맵 파일 조사 실패 (${esc(r.filesError)})</div>` : '');
  $('dbg-inspect-files').innerHTML = r.files ? '<tr><th>메모리 맵 파일</th><th>RAM 상주</th><th>매핑 크기</th><th>상주량 증가율</th></tr>'
    + r.files.map((f) => `<tr><td>${esc(f.path)}${f.image ? ' <span class="hint">실행 이미지</span>' : ''}</td><td>${dbgMiB(f.residentBytes)} MiB</td><td>${dbgMiB(f.mappedBytes)} MiB</td>`
      + `<td class="${f.growthBytesPerSec >= 1048576 ? 'warn' : ''}">${f.growthBytesPerSec === null ? '-' : `${(f.growthBytesPerSec / 1048576).toFixed(1)} MiB/s`}</td></tr>`).join('') : '';
  $('dbg-inspect-threads').innerHTML = '<tr><th>바쁜 스레드</th><th>역할</th><th>평균 (코어 1개 기준)</th><th>최고</th></tr>'
    + (r.threads || []).map((t) => `<tr><td>${esc(t.name || '(이름 없음)')} <span class="hint">${t.id}</span></td><td>${esc(t.role || '-')}</td><td>${t.avg}%</td><td>${t.peak}%</td></tr>`).join('');
});

const DBG_CAPTURE_ERR = { rdc_not_found: 'rdc-cli가 없습니다 (uv tool install rdc-cli 후 rdc setup-renderdoc)', not_rdc: '.rdc 파일을 고르세요',
  renderdoc_xml_unreadable: '지원하는 RenderDoc 프레임 XML을 읽지 못했습니다.', renderdoc_xml_limit: '16 MiB 이하인 RenderDoc XML 파일을 선택하세요.',
  capture_not_found: '파일이 없습니다', frame_capture_busy: '다른 캡처를 분석하고 있습니다',
  renderdoc_unavailable: 'rdc가 RenderDoc 모듈을 불러오지 못했습니다 (rdc doctor로 확인)' };

async function dbgCaptureRun() {
  try {
    $('dbg-capture-start').disabled = true;
    $('dbg-capture-state').textContent = '분석 중… (GPU 슬롯 대기 + 리플레이, 무거운 프레임은 몇 분)';
    await call(window.hub.dbgCapture, $('dbg-capture-path').value);
  } catch (e) { $('dbg-capture-start').disabled = false; $('dbg-capture-state').textContent = e.message; }
}

window.hub.onDbgCaptureDone((r) => {
  $('dbg-capture-start').disabled = false;
  for (const id of ['dbg-capture-summary','dbg-capture-passes','dbg-capture-draws']) $(id).textContent = '';
  if (r.basis === 'structured-export') {
    $('dbg-capture-state').textContent = `${r.api} · 캡처 호출 ${r.actionCount}개 · XML 기록`;
    $('dbg-capture-summary').textContent = '프레임 안의 드로우·디스패치·가위 영역 설정입니다. 최대 100개를 표시합니다. GPU 시간은 미측정입니다.';
    $('dbg-capture-draws').innerHTML = '<tr><th>청크</th><th>API 호출</th><th>기록된 인자</th></tr>' + r.actions.map(action =>
      `<tr><td>${esc(action.chunk)}</td><td>${esc(action.call)}</td><td>${esc(Object.entries(action.values).map(([k,v]) => k + ' = ' + v).join(', '))}</td></tr>`).join('');
    return;
  }
  $('dbg-capture-state').textContent = r.error ? (DBG_CAPTURE_ERR[r.error] || r.error) : `${r.passCount}개 패스`;
  if (r.error) return;
  const g = r.gpu;
  $('dbg-capture-summary').innerHTML = `<b>${esc(r.api || '')}</b> · 이벤트 ${r.events ?? '-'} · 드로우 ${esc(String(r.drawCalls ?? '-'))}`
    + (g ? ` · GPU ${g.totalMs} ms <span class="hint">리플레이 기준, 이벤트 ${g.timedEvents}개</span>` : '')
    + `<div class="hint">패스 기준: ${r.passBasis === 'markers' ? `엔진 마커${r.markerRoot ? ` (공통 상위 ${esc(r.markerRoot)} 생략)` : ''}` : 'API 패스'}`
    + `${r.sourceMap ? ` · 소스 위치는 렌더 맵 ${esc(r.sourceMap)}` : ''}</div>`
    + `<div class="hint">${esc(r.note)}${r.countersError ? ` (${esc(r.countersError)})` : ''}${r.markersError ? ` · 마커 읽기 실패: ${esc(r.markersError)}` : ''}</div>`;
  $('dbg-capture-passes').innerHTML = '<tr><th>패스</th><th>GPU</th><th>비율</th><th>드로우</th><th>디스패치</th><th>삼각형</th><th>렌더 타깃</th><th>소스</th></tr>'
    + r.passes.map((p) => `<tr><td>${esc(p.name)}${p.path ? `<div class="hint">${esc(p.path)}</div>` : ''}</td><td>${p.gpuMs === null ? '-' : `${p.gpuMs} ms`}</td><td class="${p.gpuShare >= 0.25 ? 'warn' : ''}">${p.gpuShare === null ? '-' : `${Math.round(p.gpuShare * 100)}%`}</td>`
      + `<td>${p.draws}</td><td>${p.dispatches}</td><td>${Number(p.triangles).toLocaleString()}</td><td>${esc(p.target || '-')}</td>`
      + `<td>${(p.source || []).map((s) => `${esc(s.file)}:${s.line}`).join('<br>') || '-'}</td></tr>`).join('');
  $('dbg-capture-draws').innerHTML = '<tr><th>비싼 드로우 (EID)</th><th>패스</th><th>마커</th><th>종류</th><th>삼각형</th><th>인스턴스</th><th>GPU</th></tr>'
    + r.topDraws.map((d) => `<tr><td>${d.eid}</td><td>${esc(d.pass || '-')}</td><td>${esc(d.marker || '-')}</td><td>${esc(d.type || '')}</td>`
      + `<td>${Number(d.triangles).toLocaleString()}</td><td>${d.instances}</td><td>${d.gpuMs === null ? '-' : `${d.gpuMs} ms`}</td></tr>`).join('');
});

$('dbg-refresh').addEventListener('click', refreshDebugging);
async function dbgRsiRuns(side, selected) {
  const box = $(side + '-rsi-runs');
  try {
    const runs = await call(window.hub.dbgRsiRuns);
    box.textContent = '';
    if (!runs.length) { box.textContent='저장된 RSI 파이프라인 실행이 없습니다.'; return; }
    for (const r of runs) {
      const details=document.createElement('details'), summary=document.createElement('summary');
      summary.textContent = r.pipeline + ' · ' + r.runId + ' · ' + r.status;
      details.append(summary);
      details.open = selected === r.runId;
      const rows=document.createElement('div');
      const verdict=r.decision.verdict ? r.decision.verdict + ' · 선택 ' + (r.decision.chosen.join(', ') || '없음') + ' · 탈락 '+r.decision.rejected : ({'not-recorded':'결정 기록 없음','not-applicable':'L1 결정 대상 밖','unreadable':'결정 읽기 실패','too-large':'결정 파일 크기 제한'}[r.decision.state] || '미확인');
      rows.textContent = verdict;
      details.append(rows);
      for (const outcome of r.decision.outcomes || []) {
        const item=document.createElement('div');
        item.textContent=(outcome.candidate || '후보') + ' · ' + outcome.basis + (outcome.improvement === null ? '' : ' · 개선 점수 '+outcome.improvement);
        details.append(item);
      }
      for (const s of r.steps) {
        const line=document.createElement('div');
        line.textContent = (s.node || '단계 미상') + ' · ' + s.status + (s.visit > 1 ? ' · 방문 '+s.visit : '') +
          ' · '+(s.ms === null ? '시간 미측정' : s.ms + ' ms') + (s.exit === null ? '' : ' · 종료 코드 ' + s.exit);
        details.append(line);
      }
      const link=document.createElement('button');
      link.className='small';
      const other=side==='dbg'?'si':'dbg';
      link.textContent=other==='si'?'같은 실행의 자가개선 검토':'같은 실행의 디버깅 근거';
      link.onclick=()=>{hubGo(other==='si'?'selfimprove':'debugging',other+'-rsi-load');dbgRsiRuns(other,r.runId);};
      details.append(link);box.append(details);
    }
  } catch(error) { box.textContent='RSI 실행 기록을 읽지 못했습니다. '+error.message; }
}
for (const side of ['dbg','si']) $(side+'-rsi-load')?.addEventListener('click',()=>dbgRsiRuns(side));
$('dbg-window').addEventListener('change', refreshDebugging);
$('dbg-render-start').addEventListener('click', dbgRender);
$('dbg-inspect-start').addEventListener('click', dbgInspect);
$('dbg-capture-start').addEventListener('click', dbgCaptureRun);
$('dbg-capture-pick').addEventListener('click', async () => {
  const file = await call(window.hub.dbgPickCapture);
  if (file) $('dbg-capture-path').value = file;
});

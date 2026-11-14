// 대시보드 — LM Studio 상태, 허브 상태, AI 도구 등록 현황, 다운스트림 서버.
'use strict';

// ---- dashboard --------------------------------------------------------------

let resourceSnapshotPending = false;
$('vault-save').addEventListener('click', async () => {
  const field = $('vault-secret');
  const secret = field.value;
  field.value = '';
  try {
    const result = await call(window.hub.localCredentialPut, $('vault-provider').value, secret);
    $('vault-result').textContent = `${result.reference} 저장됨`;
  } catch { $('vault-result').textContent = '암호화 저장 실패. 데스크톱 Hub의 OS 암호화 지원을 확인하세요.'; }
});
async function refreshResourceSnapshot() {
  if (resourceSnapshotPending || document.hidden || !$('tab-dashboard')?.classList.contains('active')) return;
  resourceSnapshotPending = true;
  try {
    const sample = await call(window.hub.localResources);
    const percent = value => Number.isFinite(value) ? value.toFixed(1) + '%' : '측정 대기';
    const gib = value => (value / 1024 ** 3).toFixed(1) + ' GiB';
    const gpu = sample.gpu.available ? sample.gpu.devices.map(device =>
      `${device.name}: GPU ${percent(device.usagePercent)}, VRAM ${device.usedMiB ?? '?'} / ${device.totalMiB ?? '?'} MiB`).join(' · ') : 'GPU: 측정 불가';
    $('resource-snapshot').textContent = `CPU ${percent(sample.cpu.usagePercent)} · RAM ${gib(sample.ram.usedBytes)} / ${gib(sample.ram.totalBytes)} · ${gpu} · ${new Date(sample.sampledAt).toLocaleTimeString()}`;
    const preparation=(sample.modelOperations||[]).filter(r=>['running','deferred'].includes(r.state));
    for(const r of preparation){const e=r.admission?.expected;$('resource-snapshot').textContent+=' · 모델 '+r.requestId.slice(0,8)+' '+(r.state==='deferred'?'자원 대기':'준비 중')+(e?' (예상 RAM '+gib(e.ramBytes)+', VRAM '+gib(e.vramBytes)+')':'');}
  } catch {
    $('resource-snapshot').textContent = '자원 측정 연결 실패 — 기존 수치를 현재 값으로 사용하지 마세요.';
  } finally { resourceSnapshotPending = false; }
}
setInterval(refreshResourceSnapshot, 5000);

// Per-process record over a window: who used which engine/VRAM, Hub jobs as process trees, and findings.
async function refreshResourceReport() {
  if (document.hidden || !$('tab-dashboard')?.classList.contains('active')) return;
  const mib = b => Math.round((b || 0) / 1048576), engines = g => Object.entries(g || {}).map(([k, v]) => `${k} ${v.avg}%`).join(' ');
  try {
    const r = await call(window.hub.resReport, Number($('res-window').value));
    const m = r.machine || {}, board = m.gpuBoard;
    $('res-machine').textContent = r.samples
      ? `CPU 평균 ${m.cpuPercent.avg}% (최고 ${m.cpuPercent.peak}%) · GPU ${engines(m.gpuPercent) || '-'} · VRAM 최고 ${mib(m.vramPeakBytes)} MiB (공유 ${mib(m.sharedVramPeakBytes)})`
        + (board ? ` · 보드 평균 ${board.powerAvgW} W, ${board.energyWh} Wh, 최고 ${board.maxTempC}°C${board.throttleReasons.length ? ' · 제한 ' + board.throttleReasons.join(',') : ''}` : '')
      : '기록 대기 중 (자원 기록기가 막 시작됐으면 몇 초 뒤에 표시됩니다)';
    // PID를 골라 다음 단계(디버깅의 프로세스 상세·렌더링 병목)로 바로 간다 — PID를 따로 찾지 않게.
    $('res-procs').innerHTML = '<tr><th>프로세스</th><th>PID</th><th>앱 · 작업</th><th>CPU 평균</th><th>GPU 엔진 평균</th><th>VRAM 최고</th><th>메모리 최고</th><th>읽기 · 쓰기</th><th>다음 단계</th></tr>'
      + (r.processes || []).map(p => `<tr data-started="${/^\d{1,20}$/.test(p.started) ? p.started : ''}"><td>${esc(p.name)}${p.lifetimeOrdinal ? ` <span class="hint">${p.started ? '생애 ' + p.lifetimeOrdinal : '생성 시각 미상'}</span>` : ''}</td><td><code>${p.pid}</code></td><td>${esc(p.job ? '작업 ' + p.job.slice(0, 12) : p.app)}</td>`
        + `<td>${p.cpuPercent.avg}%</td><td>${esc(engines(p.gpuPercent) || '-')}</td>`
        + `<td>${mib(p.vramPeakBytes)} MiB${p.sharedVramPeakBytes > 64 * 1048576 ? ` <span class="warn">+공유 ${mib(p.sharedVramPeakBytes)}</span>` : ''}</td><td>${mib(p.memPeakBytes)} MiB</td>`
        + `<td>${mib(p.ioReadBytes)} / ${mib(p.ioWriteBytes)} MiB</td>`
        + (p.latestObserved === false ? '<td class="hint">이전 관측 기록</td></tr>'
          : `<td><button class="small" data-proc-open="inspect" data-pid="${p.pid}">상세</button> <button class="small" data-proc-open="render" data-pid="${p.pid}">렌더 병목</button> ${/^\d{1,20}$/.test(p.started) ? `<button class="small" draggable="true" data-rea-pid="${p.pid}">REA 대상으로 선택</button>` : ''}</td></tr>`)).join('');
    dbgFillPids(r.processes || []);
    const detail = f => Object.entries(f).filter(([k]) => !['kind', 'from', 'to', 'seconds', 'note'].includes(k)).map(([k, v]) => `${k}=${Array.isArray(v) ? v.map(x => x?.label ?? x).join(' + ') : v}`).join(' ');
    $('res-findings').innerHTML = (r.findings || []).slice(-8).map(f => `<li class="warn">${esc(new Date(f.from).toLocaleTimeString())} · ${esc(f.kind)} ${f.seconds}s · ${esc(detail(f))} — ${esc(f.note)}`
      + `${f.culprits?.length ? ` <button class="small" data-dash-finding="${esc(f.from)}">디버깅에서 원인 보기</button>` : ''}</li>`).join('')
      || '<li class="hint">이 기간에 감지된 문제 없음</li>';
  } catch (e) { $('res-machine').textContent = '자원 기록을 읽지 못했습니다: ' + e.message; }
}
setInterval(refreshResourceReport, 15000);
$('res-window').addEventListener('change', refreshResourceReport);
$('res-procs').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-proc-open]');
  if (b) dbgOpenProcess(b.dataset.pid, b.dataset.procOpen, b.closest('tr').dataset.started || undefined);
});
// 경고 → 같은 기간의 디버깅 원인 표에서 그 진단 줄을 연다(debugging.js).
$('res-findings').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-dash-finding]');
  if (b) dbgShowFinding(b.dataset.dashFinding, Number($('res-window').value));
});
$('res-export').addEventListener('click', async () => {
  try {
    const t = await call(window.hub.resExportTrace, Number($('res-window').value));
    $('res-export-result').textContent = t.file ? `${t.file} — ui.perfetto.dev에 끌어다 놓으면 브라우저 안에서만 열립니다.` : t.error;
  } catch (e) { $('res-export-result').textContent = e.message; }
});

// Unreal/Unity: sub-process roles (shader compile, asset import, build, DDC…), editor events and the engine's own records.
const DEV_ROLE = { editor: '편집기', game: '게임 실행', commandlet: '커맨드렛', batch: '배치', 'shader-compile': '셰이더 컴파일', ddc: 'DDC (Zen)',
  build: '빌드', 'live-coding': '라이브 코딩', trace: '트레이스·Insights', crash: '크래시 리포트', pak: '패키징', 'asset-import': '에셋 임포트',
  'script-build': '스크립트 빌드', packages: '패키지 관리자', hub: 'Unity Hub', licensing: '라이선스' };
function devEventText(e) {
  const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
  switch (e.kind) {
    case 'import': return `임포트 ${s(e.ms)} ${e.asset}${e.importer ? ` (${e.importer})` : ''}`;
    case 'domain-reload': return `도메인 리로드 ${s(e.ms)} — ${(e.phases || []).map((p) => `${p.phase} ${s(p.ms)}`).join(', ')}`;
    case 'script-build': return `스크립트 빌드 ${e.failed ? '실패' : '성공'} ${s(e.ms)}, ${e.items}개 갱신`;
    case 'script-compile-request': return `스크립트 컴파일 요청: ${e.reason}`;
    case 'refresh': return `에셋 새로고침 ${s(e.ms)} (${e.by})`;
    case 'load-map': return `맵 로드 ${s(e.ms)} ${e.map}`;
    case 'pie-start': return `PIE 시작 ${s(e.ms)}`;
    case 'live-coding': return `라이브 코딩: ${e.stage}`;
    case 'shader-compile-stats': return `셰이더 ${e.completed}/${e.assigned}개 완료${e.jobsPerSec ? `, ${e.jobsPerSec}개/s` : ''}${e.parallelization ? `, 병렬 ${e.parallelization}배` : ''}`;
    case 'pso-hitches': return `PSO 생성 끊김 누적 ${e.total}회 (사전 캐시 ${e.precached})`;
    case 'shader-workers': return `셰이더 작업자 ${e.workers}개`;
    case 'compile-error': return `컴파일 오류 ${e.code} ${e.text}`;
    case 'scene-open': return `씬 열기 ${e.scene}`;
    case 'unload-assets': return `미사용 에셋 ${e.assets}개 해제 (${e.size})`;
    default: return { 'play-mode': '플레이 모드 진입', 'script-reload': '스크립트 리로드', 'engine-ready': '엔진 초기화 완료' }[e.kind] || e.kind;
  }
}
async function refreshDevMonitor() {
  if (document.hidden || !$('tab-dashboard')?.classList.contains('active')) return;
  const mib = b => Math.round((b || 0) / 1048576), engines = g => Object.entries(g || {}).map(([k, v]) => `${k} ${v.avg}%`).join(' ');
  try {
    const r = await call(window.hub.resReport, 60);
    $('res-dev').innerHTML = (r.dev || []).map((d) => {
      const name = d.app === 'unreal' ? 'Unreal' : 'Unity';
      const projects = [...new Set(d.editors.filter((e) => e.project).map((e) => e.project.split(/[\\/]/).pop()))].join(', ');
      const roles = '<tr><th>역할</th><th>프로세스</th><th>CPU 평균 (최고)</th><th>GPU 엔진</th><th>VRAM</th><th>메모리</th><th>디스크 읽기/쓰기</th></tr>'
        + d.roles.map((x) => `<tr><td>${esc(DEV_ROLE[x.role] || x.role)}</td><td>${x.processesPeak}</td><td>${x.cpuPercent.avg}% (${x.cpuPercent.peak}%)</td>`
          + `<td>${esc(engines(x.gpuPercent) || '-')}</td><td>${mib(x.vramPeakBytes)} MiB</td><td>${mib(x.memPeakBytes)} MiB</td><td>${mib(x.ioReadBytes)} / ${mib(x.ioWriteBytes)} MiB</td></tr>`).join('');
      const c = d.counters, counts = [c.imports && `임포트 ${c.imports}개 ${c.importSeconds}s`, c.shadersCompiled && `셰이더 컴파일 ${c.shadersCompiled}개`,
        c.shadermapMisses && `셰이더맵 캐시 없음 ${c.shadermapMisses}개`].filter(Boolean).join(' · ');
      const events = d.events.slice(-8).reverse().map((e) => `<li>${esc(new Date(e.t).toLocaleTimeString())} ${esc(devEventText(e))}</li>`).join('');
      const findings = d.findings.map((f) => `<li class="warn">${esc(f.kind)} ${esc(f.note || f.asset || f.source || '')}</li>`).join('');
      const a = d.artifacts || {};
      const traces = (a.insightsTraces || []).map((t) => `<div class="res-artifact">${esc(t.file)} (${t.mb} MB)`
        + (a.insightsExe ? ` <button class="small" data-insights="${esc(t.file)}">Insights로 열기</button>` : '') + '</div>').join('');
      const others = [...(a.csvProfiles || []), ...(a.memorySnapshots || [])].map((t) => `<div class="res-artifact">${esc(t.file)} (${t.mb} MB)</div>`).join('');
      return `<section><h4>${name}${projects ? ' — ' + esc(projects) : ''}</h4><table class="table">${roles}</table>`
        + (counts ? `<div class="hint">${esc(counts)}</div>` : '') + (findings ? `<ul>${findings}</ul>` : '')
        + `<ul>${events || '<li class="hint">최근 1분 동안 편집기 로그 이벤트 없음</li>'}</ul>`
        + (traces || others ? `<div class="hint">엔진 자체 기록: ${esc(a.use || '')}</div>${traces}${others}` : '') + '</section>';
    }).join('') || '<div class="hint">실행 중인 Unreal·Unity 편집기가 없습니다.</div>';
  } catch (e) { $('res-dev').textContent = '개발 도구 기록을 읽지 못했습니다: ' + e.message; }
}
setInterval(refreshDevMonitor, 5000);
$('res-dev').addEventListener('click', async (ev) => {
  const file = ev.target?.dataset?.insights;
  if (!file) return;
  try { await call(window.hub.resOpenInsights, file); toast('Unreal Insights를 열었습니다.'); } catch (e) { toast(e.message, true); }
});

async function refreshDashboard() {
  refreshAgyStatus(); // ui/tabs/mcp.js — boot.js calls this only after every tab script has loaded
  refreshDevMonitor();
  refreshResourceSnapshot();
  refreshResourceReport();
  try {
    const st = await call(window.hub.status);
    // GPU에 안 들어가는 모델은 오류를 내지 않는다 — LM Studio가 컨텍스트를 깎고 남은
    // 레이어를 CPU로 넘긴다. "느리다/컨텍스트가 좁다"가 모델 탓처럼 보이므로 여기 띄운다.
    const gpu = st.lmstudio.gpu || {};
    $('lm-status').innerHTML = (st.lmstudio.alive
      ? `<span class="ok">● 연결됨</span> <span class="hint">${esc(st.lmstudio.url)}</span>`
      : `<span class="bad">● 연결 안 됨</span> <span class="hint">${esc(st.lmstudio.url)} — LM Studio에서 Local Server를 시작하세요</span>`)
      + (gpu.message
        ? `<div class="${gpu.verdict === 'oversized' ? 'bad' : 'warn'}" style="margin-top:4px">GPU: ${esc(gpu.message)}</div>`
        : '');
    $('lm-models').innerHTML =
      '<tr><th>모델</th><th>능력 등급</th><th>상태</th><th>평균 응답</th></tr>' +
      st.lmstudio.models.map((m) => `<tr><td>${esc(m.id)}</td><td><span class="badge ${esc(m.tier)}">${esc(m.tier)}</span></td>` +
        `<td>${m.state === 'loaded' ? '<span class="ok">● 로드됨</span>' : (m.state === 'not-loaded' ? '<span class="hint">○ 미로드</span>' : '<span class="hint">?</span>')}</td>` +
        `<td class="hint">${m.avgMs ? (m.avgMs / 1000).toFixed(1) + 's' : '-'}</td></tr>`).join('');
    // 떠 있어도 인증이 막혀 있으면 등록된 AI 도구는 전부 못 붙는다 — '실행 중'만
    // 보여주면 그 상태가 어디에도 안 드러난다(2026-07-28 사고).
    $('hub-status').innerHTML = st.hub.running
      ? `<span class="${st.hub.authOk === false ? 'bad' : 'ok'}">● 실행 중</span> 포트 ${st.hub.port} (인증: ${st.hub.requireAuth ? 'ON' : 'OFF'}${st.hub.lanAccess ? ' · <span class="warn">LAN 공개 중</span>' : ''})` +
        (st.hub.authError
          ? `<div class="bad" style="margin-top:4px">인증 실패: ${esc(st.hub.authError)}</div>` +
            `<div style="margin-top:6px"><button id="hub-retry" class="small">허브 다시 시작</button></div>`
          : '')
      : `<span class="warn">● HTTP 허브 중지됨</span> — stdio 등록은 계속 작동합니다` +
        (st.hub.error ? `<div class="bad" style="margin-top:4px">${esc(st.hub.error)}</div>` : '') +
        `<div style="margin-top:6px"><button id="hub-retry" class="small">허브 다시 시작</button></div>`;
    if ($('hub-retry')) {
      $('hub-retry').addEventListener('click', async () => {
        try {
          const r = await call(window.hub.hubRestart);
          toast(r.running ? '허브가 시작되었습니다.' : '허브 시작에 실패했습니다 — 포트 충돌 여부를 확인하세요.', !r.running);
          refreshDashboard();
        } catch (e) { toast(e.message, true); }
      });
    }
    $('hub-url').textContent = st.hub.url;
    $('target-status').innerHTML =
      '<tr><th>AI 도구</th><th>감지</th><th>허브 등록</th></tr>' +
      st.targets.map((t) => `<tr><td>${esc(t.name)}</td><td>${t.exists ? '<span class="ok">감지됨</span>' : '<span class="bad">없음</span>'}</td><td>${t.registered ? '<span class="ok">등록됨</span>' : '<span class="hint">미등록</span>'}</td></tr>`).join('');
    const ds = await call(window.hub.dsList);
    $('dash-downstream').innerHTML = ds.length
      ? '<tr><th>이름</th><th>유형</th><th>대상</th><th>상태</th></tr>' +
        ds.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.type)}</td><td class="hint">${esc(s.url || s.command || '')}</td><td>${s.connected ? '<span class="ok">연결됨</span>' : '<span class="hint">대기</span>'}</td></tr>`).join('')
      : '<tr><td class="hint">등록된 다운스트림 서버가 없습니다. MCP 연결 탭에서 추가하세요.</td></tr>';
    renderShare(st.share, st.version);
  } catch (e) {
    toast('상태 조회 실패: ' + e.message, true);
  }
}

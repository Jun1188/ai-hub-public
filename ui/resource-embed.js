// 자원 기록 임베드 — 다른 탭(작업실·프로젝트·노드 상세)이 필요할 때만 붙였다 떼는 작은 표시기. 기존 res:report를 그대로 쓴다.
'use strict';

/** Pure: one telemetry report → the part that belongs to a Hub job or a time window. */
function resEmbedSelect(report, filter) {
  const job = filter.jobId ? (report.jobs || []).find((j) => j.jobId === filter.jobId) || null : null;
  const jobMissing = Boolean(filter.jobId) && !job;
  // 시작만 있고 끝이 없는 창은 아직 진행 중인 구간이다: 이번 조회의 끝까지로 본다.
  const from = job ? job.start : filter.from, to = job ? (job.end ?? report.to) : (filter.to ?? (Number.isFinite(filter.from) ? report.to : undefined));
  const windowed = Number.isFinite(from) && Number.isFinite(to);
  // 없는 작업의 문제로 전체 기간의 경고를 보여 주면 남의 문제를 이 작업 탓으로 읽게 된다. 시간창을 함께 받았을 때만 그 구간으로 좁혀 보여 준다.
  const findings = jobMissing && !windowed ? [] : (report.findings || []).filter((f) => !windowed || (f.from <= to && f.to >= from));
  return { samples: report.samples || 0, machine: report.machine || null, job, jobMissing, window: windowed ? { from, to } : null, findings,
    partial: windowed && Number.isFinite(report.from) && from < report.from }; // 조회 기간이 구간의 앞부분을 못 덮음
}

/**
 * Pure: 검토 중인 실행(과 그 안의 노드 하나)이 자원 기록에서 가리킬 수 있는 구간. 근거가 없으면 unconfirmed만 돌려준다 —
 * 노드의 구간을 모를 때 실행 전체나 기기 전체로 넓히지 않는다.
 */
function resEmbedRunFilter(run, nodeId, now, graphId, editorSha) {
  // 끝이 undefined이면 진행 중(재개된 실행 포함): 창을 열어 두고 계속 읽는다.
  const start = Date.parse(run.startedAt), end = run.finishedAt ? Date.parse(run.finishedAt) : undefined;
  if (!Number.isFinite(start) || (run.finishedAt && !Number.isFinite(end))) return { unconfirmed: '이 실행의 시작·종료 시각이 기록에 없어 자원을 표시하지 않습니다.' };
  if (now - start > 172800e3) return { unconfirmed: '이 실행은 자원 기록 보존 기간(2일) 밖이라 표시하지 않습니다.' };
  // 편집기에서 고른 노드는 편집 중인 그래프의 것이다. 다른 파이프라인의 실행에 같은 이름의 노드가 있어도 같은 단계가 아니다.
  if (nodeId && (!run.pipelineId || graphId !== run.pipelineId)) return { unconfirmed: '편집 중인 그래프가 이 실행의 파이프라인이 아니어서, 노드 이름이 같아도 표시하지 않습니다.' };
  if (nodeId && !run.graphCheckpoint?.graphSha) return { unconfirmed: '이 실행에는 그래프 지문이 없어 노드별 자원을 확인할 수 없습니다.' };
  if (nodeId && run.graphCheckpoint.graphSha !== editorSha) return { unconfirmed: '편집 중인 그래프가 실행 당시와 달라 이 노드의 자원을 연결할 수 없습니다.' };
  const windowSeconds = () => Math.min(172800, Math.max(10, Math.ceil((Date.now() - start) / 1000) + 30));
  const once = Boolean(run.finishedAt); // 끝난 실행의 구간은 더 바뀌지 않는다
  if (!nodeId) return { filter: { from: start, to: end }, windowSeconds, once, scope: 'run' };
  const visits = (run.steps || []).filter((s) => s.nodeId === nodeId && (s.jobId || Number.isFinite(s.startedAt)));
  if (!visits.length) return { unconfirmed: '이 노드는 이 실행에서 실행되지 않았거나 작업 ID·시작 시각이 기록에 없습니다. 실행 전체의 수치로 대신하지 않습니다.' };
  const last = visits[visits.length - 1]; // 여러 번 방문한 노드는 마지막 방문
  const filter = Number.isFinite(last.startedAt)
    ? { from: last.startedAt, to: Number.isFinite(last.durationMs) ? last.startedAt + last.durationMs : end } : {};
  if (last.jobId) filter.jobId = last.jobId;
  return { filter, windowSeconds, once: once || Number.isFinite(last.durationMs), scope: last.jobId ? 'node-job' : 'node-window' };
}

/** Pure: 이력에서 다시 읽은 같은 실행이 보여 주던 것과 달라졌는가(재개·종료·단계 추가). */
function resEmbedRunChanged(shown, fresh) {
  return shown.status !== fresh.status || shown.finishedAt !== fresh.finishedAt || (shown.steps || []).length !== (fresh.steps || []).length;
}

/**
 * 폴링 한 줄기. 타이머는 응답이 끝난 뒤에 다시 건다(setInterval이면 느린 응답 위에 호출이 겹친다).
 * deps: fetchReport(windowSeconds), render(view), isVisible(), isAttached()?, setTimer(fn, ms), clearTimer(id), now().
 */
function resEmbedCreate(deps) {
  const interval = Math.max(5000, deps.intervalMs || 15000); // 기록기는 2초 간격이고 요약은 대시보드도 15초다
  const stats = { fetches: 0, rendered: 0, skippedHidden: 0, droppedLate: 0, errors: 0 };
  let timer = null, pending = false, stopped = true, lastAt = -Infinity;
  const schedule = () => { if (!stopped && timer === null) timer = deps.setTimer(tick, interval); };
  function stop() {
    stopped = true;
    if (timer !== null) { deps.clearTimer(timer); timer = null; }
  }
  async function tick() {
    timer = null;
    if (stopped) return;
    if (deps.isAttached && !deps.isAttached()) return stop(); // 붙은 자리가 사라졌으면 스스로 끝낸다
    if (!deps.isVisible()) { stats.skippedHidden += 1; return schedule(); }
    if (pending) return;
    pending = true; stats.fetches += 1; lastAt = deps.now();
    try {
      const report = await deps.fetchReport(typeof deps.windowSeconds === 'function' ? deps.windowSeconds() : deps.windowSeconds || 600);
      if (stopped) stats.droppedLate += 1; // 뗀 뒤에 도착한 응답은 그리지 않는다
      else {
        deps.render(resEmbedSelect(report, deps.filter || {})); stats.rendered += 1;
        if (deps.once) stop(); // 끝난 구간은 한 번 읽으면 충분하다
      }
    } catch (error) {
      stats.errors += 1;
      if (!stopped) deps.render({ error: String((error && error.message) || error) });
    } finally { pending = false; schedule(); }
  }
  return {
    stats,
    start() { if (stopped) { stopped = false; tick(); } },
    stop,
    // 숨었다 다시 보일 때: 마지막 조회가 한 간격보다 오래됐을 때만 바로 한 번 조회한다
    becameVisible() {
      if (stopped || pending || deps.now() - lastAt < interval) return;
      if (timer !== null) { deps.clearTimer(timer); timer = null; }
      tick();
    },
  };
}

/** 렌더러용: host 요소에 붙이고, 떼는 함수를 돌려준다. 값은 textContent로만 넣는다. */
function resEmbedMount(host, options) {
  const mib = (bytes) => Math.round((bytes || 0) / 1048576);
  const tab = host.closest('.tab');
  const embed = resEmbedCreate({
    ...options,
    fetchReport: (seconds) => call(window.hub.resReport, seconds), // IPC 응답은 {ok, data} 봉투다 — shell.js의 call이 벗기고 실패는 던진다
    isVisible: () => !document.hidden && (!tab || tab.classList.contains('active')),
    isAttached: () => host.isConnected,
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (id) => clearTimeout(id), now: () => Date.now(),
    render(view) {
      if (view.error) { host.textContent = '자원 기록을 읽지 못했습니다 — 이전 수치를 현재 값으로 쓰지 마세요.'; return; }
      if (view.jobMissing && !view.window) { host.textContent = '이 작업의 자원 기록이 조회 기간 안에 없습니다.'; return; }
      const usage = (s) => `CPU 평균 ${s.cpuPercent.avg}% (최고 ${s.cpuPercent.peak}%) · VRAM 최고 ${mib(s.vramPeakBytes)} MiB`;
      // 수치는 그 대상의 것일 때만 쓴다: 묶인 프로세스가 있는 작업, 또는 필터 없는 기기 요약. 구간만 아는 경우 기기 전체 수치를 그 구간의 비용처럼 보이지 않는다.
      const head = !view.samples ? '기록 대기 중'
        : view.job ? (view.job.processes ? usage(view.job) : '이 작업에 묶인 프로세스 기록 없음')
          : view.jobMissing ? '작업 기록 없음(같은 시간대만 표시)'
            : view.window ? '선택한 구간(프로세스별 사용량은 묶인 작업이 있을 때만 표시)'
              : view.machine ? usage(view.machine) : '기록 대기 중';
      host.textContent = head + ' · ' + (view.findings.length
        ? '같은 시간대 기기 경고: ' + view.findings.map((f) => `${f.kind} ${f.seconds}s`).join(', ') : '같은 시간대 경고 없음')
        + (view.partial ? ' · 조회 기간이 구간의 앞부분을 덮지 못함' : '');
    },
  });
  const onVisible = () => { if (!document.hidden) embed.becameVisible(); };
  const onLeave = () => embed.stop();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pagehide', onLeave);
  embed.start();
  return function unmount() {
    embed.stop();
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pagehide', onLeave);
  };
}

// 게임 프로젝트 탭에 들어올 때 붙이고 나갈 때 뗀다. 탭 전환에는 이벤트가 없어서(단추 클릭과 panel-navigation 두 경로)
// 탭의 class 변화를 직접 본다.
let resEmbedUnmount = null;
function resEmbedSync() {
  const host = $('proj-res-embed'), active = $('tab-projects').classList.contains('active');
  if (active && !resEmbedUnmount) resEmbedUnmount = resEmbedMount(host, { windowSeconds: 600 });
  else if (!active && resEmbedUnmount) { resEmbedUnmount(); resEmbedUnmount = null; host.textContent = ''; }
}
new MutationObserver(resEmbedSync).observe($('tab-projects'), { attributes: true, attributeFilter: ['class'] });
resEmbedSync();

// 파이프라인 「실행 상태 검토」: 고른 실행, 또는 그 실행에서 고른 노드의 구간만 보여 준다. 다시 고르면 앞의 구독을 먼저 끊는다.
let resEmbedRunUnmount = null, resEmbedRunShown = null;
function resEmbedInvalidateRunNode() {
  if (!resEmbedRunShown?.nodeId) return;
  resEmbedShowRun(null);
  $('pg-review-res').textContent = '그래프를 편집했습니다. 확인할 노드를 다시 선택하세요.';
}
async function resEmbedShowRun(run, nodeId, graphId, getGraph) {
  const host = $('pg-review-res');
  if (resEmbedRunUnmount) { resEmbedRunUnmount(); resEmbedRunUnmount = null; }
  const selection = run ? { run, nodeId, graphId, getGraph } : null;
  resEmbedRunShown = selection;
  host.textContent = '';
  if (!run || !$('tab-pipelines').classList.contains('active')) return;
  let editorSha;
  if (nodeId && run.graphCheckpoint?.graphSha && graphId && run.pipelineId === graphId) {
    host.textContent = '실행 당시 그래프와 비교 중입니다.';
    try {
      editorSha = await call(window.hub.pipeGraphValidate, getGraph(), 'fingerprint');
    } catch {
      if (resEmbedRunShown === selection) host.textContent = '편집 중인 그래프의 지문을 확인할 수 없습니다.';
      return;
    }
    if (resEmbedRunShown !== selection || !$('tab-pipelines').classList.contains('active')) return;
  }
  const plan = resEmbedRunFilter(run, nodeId, Date.now(), graphId, editorSha);
  if (plan.unconfirmed) { host.textContent = plan.unconfirmed; return; }
  resEmbedRunUnmount = resEmbedMount(host, { filter: plan.filter, windowSeconds: plan.windowSeconds, once: plan.once });
}
new MutationObserver(() => {
  const active = $('tab-pipelines').classList.contains('active');
  if (!active && resEmbedRunUnmount) { resEmbedRunUnmount(); resEmbedRunUnmount = null; }
  else if (active && resEmbedRunShown && !resEmbedRunUnmount) resEmbedShowRun(resEmbedRunShown.run, resEmbedRunShown.nodeId, resEmbedRunShown.graphId, resEmbedRunShown.getGraph);
}).observe($('tab-pipelines'), { attributes: true, attributeFilter: ['class'] });

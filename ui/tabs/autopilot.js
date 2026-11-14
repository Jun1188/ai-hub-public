// 대시보드의 '자동 작업' 카드 — 안전 작업 한정 백그라운드 자동화 토글.
'use strict';

// ---- autopilot (안전 작업 한정 백그라운드 자동화) ----------------------------------

async function refreshAutopilot() {
  try {
    const s = await call(window.hub.autoStatus);
    $('auto-enabled').checked = s.enabled;
    $('auto-job-mem').checked = s.jobs.memoryConsolidate;
    $('auto-job-pipe').checked = s.jobs.safePipelines;
    $('auto-last').textContent = s.lastTick
      ? `마지막 점검: ${new Date(s.lastTick).toLocaleString('ko-KR')}`
      : (s.enabled ? '아직 점검 전 (켠 직후 20초 내 첫 실행)' : '');
    $('auto-activity').innerHTML = s.activity.length
      ? '<b>최근 활동</b><br>' + s.activity.slice(0, 10).map((a) =>
          `${esc(a.ts.slice(5, 16).replace('T', ' '))} · [${esc(a.job)}] ${esc(a.message)}`).join('<br>')
      : (s.enabled ? '아직 활동 기록이 없습니다.' : '');
  } catch (e) { toast(e.message, true); }
}

async function saveAutopilot() {
  try {
    await call(window.hub.autoUpdate, {
      enabled: $('auto-enabled').checked,
      jobs: {
        memoryConsolidate: $('auto-job-mem').checked,
        safePipelines: $('auto-job-pipe').checked,
      },
    });
    refreshAutopilot();
  } catch (e) { toast(e.message, true); }
}
for (const id of ['auto-enabled', 'auto-job-mem', 'auto-job-pipe']) {
  $(id).addEventListener('change', saveAutopilot);
}
$('auto-run-now').addEventListener('click', async () => {
  $('auto-run-now').disabled = true;
  $('auto-last').textContent = '실행 중...';
  try {
    await call(window.hub.autoRunNow);
    toast('자동 작업을 한 차례 실행했습니다.');
  } catch (e) { toast(e.message, true); }
  finally { $('auto-run-now').disabled = false; refreshAutopilot(); }
});

// 시작 시 1회 실행 — 초기 렌더와 주기 갱신. 반드시 마지막에 로드되어야 한다
// (다른 파일이 정의한 refresh 함수들을 호출하므로).
'use strict';

// ---- init -----------------------------------------------------------------------

window.hub.onHubError((msg) => toast('허브 서버 오류: ' + msg, true));
// 자가 점검이 인증 고장을 잡았거나 스스로 고친 순간에만 온다(상태가 바뀔 때만).
window.hub.onHubAuth((r) => { if (r && r.message) toast('허브 인증: ' + r.message, !r.ok); });
window.hub.configGet().then((r) => {
  if (r.ok) applyUiMode(r.data.ui && r.data.ui.devMode);
});
applyFeatureProfile();
refreshDashboard();
refreshAutopilot();
setInterval(() => {
  if (document.querySelector('#tab-dashboard.active')) { refreshDashboard(); refreshAutopilot(); }
}, 15000);

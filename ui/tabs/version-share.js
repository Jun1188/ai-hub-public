// 대시보드의 '버전 & 컴퓨터 간 공유' 카드와 상단 자동 업데이트 알림 줄.
// 실행 중에는 확인하고, 파일 교체는 다음 실행에 적용한다.
'use strict';

// ---- 버전 & 컴퓨터 간 공유 --------------------------------------------------

let currentVersion = '';
let pendingUpdate = null;

function fmtWhen(ms) {
  if (!ms) return '아직 없음';
  const diff = Math.max(0, Date.now() - ms);
  if (diff < 60000) return '방금';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}분 전`;
  return new Date(ms).toLocaleString();
}

function renderShare(share, version) {
  if (version) currentVersion = version;
  if (!share) return;
  if (!share.enabled) {
    $('share-status').innerHTML = share.lastError
      ? `<span class="warn">● 공유 꺼짐</span> <span class="hint">${esc(share.lastError)}</span>`
      : '<span class="hint">○ 공유 폴더 미설정 — 설정 탭에서 지정하거나 자동 탐지를 누르세요</span>';
  } else if (share.paused) {
    $('share-status').innerHTML =
      `<span class="warn">● 일시 중지</span> <span class="hint">연속 실패로 잠시 쉬는 중 — 앱 동작에는 영향 없습니다</span>`;
  } else {
    $('share-status').innerHTML =
      `<span class="ok">● 공유 중</span> <span class="hint">${esc(share.root)}</span>`;
  }
  $('share-last').textContent = share.enabled
    ? `마지막 동기화: ${fmtWhen(share.lastSyncAt)} · 받음 ${share.copiedIn} / 보냄 ${share.copiedOut}`
    : '';
  if (share.repository) {
    $('update-enroll').hidden = share.repository.status !== 'disabled';
    $('share-last').textContent += `${share.enabled ? ' · ' : ''}${share.repository.message}`;
    const delivery = share.repository.delivery;
    if (delivery) $('share-last').textContent += ` · 최근 적용 (${delivery.status}): ${delivery.message}`;
  }
  if (!$('update-status').dataset.checked) {
    $('update-status').innerHTML = `현재 버전 <b>v${esc(currentVersion || '?')}</b>`;
  }
}

// 설치본(공유 폴더 latest.json)과 overlay(공유 저장소 main) 두 채널을 updater.js가 확인해 message로 설명한다.
function renderUpdate(info) {
  if (info.manual) {
    $('update-enroll').hidden = info.status !== 'disabled';
    $('update-install').style.display = 'none';
    $('update-status').dataset.checked = '1';
    $('update-status').textContent = '현재 버전 v' + info.current;
    $('update-notes').textContent = info.message;
    return;
  }
  $('update-enroll').hidden = info.status !== 'disabled';
  $('update-status').dataset.checked = '1';
  pendingUpdate = info.available ? info : null;
  $('update-status').innerHTML = info.available
    ? `<span class="ok">● 새 버전 v${esc(info.version)}</span> <span class="hint">현재 v${esc(info.current)}</span>`
    : `현재 버전 <b>v${esc(info.current || currentVersion)}</b> ${info.error
      ? `<span class="warn">${esc(info.error)}</span>` : '<span class="ok">최신입니다</span>'}`;
  $('update-notes').textContent = info.message || '';
  $('update-install').style.display = info.available ? '' : 'none';
}

$('update-check').addEventListener('click', async () => {
  const b = $('update-check');
  b.disabled = true;
  b.textContent = '확인 중...';
  try {
    renderUpdate(await call(window.hub.updateCheck));
  } catch (e) { toast(e.message, true); } finally {
    b.disabled = false;
    b.textContent = '업데이트 확인';
  }
});

$('update-install').addEventListener('click', async () => {
  if (!pendingUpdate) return;
  const b = $('update-install');
  b.disabled = true;
  try {
    await call(window.hub.updateApply);
  } catch (e) { toast(e.message, true); } finally { b.disabled = false; }
});

$('update-enroll').addEventListener('click', async () => {
  const b = $('update-enroll');
  b.disabled = true;
  try {
    const result = await call(window.hub.updateEnroll);
    if (result) renderUpdate(result);
  } catch (e) { toast(e.message, true); } finally { b.disabled = false; }
});

$('share-sync').addEventListener('click', async () => {
  const b = $('share-sync');
  b.disabled = true;
  b.textContent = '동기화 중...';
  try {
    renderShare(await call(window.hub.shareSyncNow));
    toast('동기화했습니다.');
  } catch (e) { toast(e.message, true); } finally {
    b.disabled = false;
    b.textContent = '지금 동기화';
  }
});

// 자동 확인은 매시간 돈다. 설치본이 게시되지 않은 overlay 버전은 계속 '새 버전'으로 남으니 버전마다 한 번만 알린다.
let updateToastedVersion = '';
if (window.hub.onUpdateAvailable) window.hub.onUpdateAvailable((info) => {
  renderUpdate(info);
});
if (window.hub.onShareChanged) window.hub.onShareChanged((s) => renderShare(s));

function showManualSync(value) {
  $('update-sync-status').textContent = value.message || '';
  $('update-sync').disabled = ['checking', 'building', 'restart'].includes(value.phase);
}
window.hub.onUpdateChecked(renderUpdate);
window.hub.onUpdateSyncState(showManualSync);
call(window.hub.updateSyncStatus).then(value => {
  $('update-sync').hidden = value.mode !== 'manual';
  if (value.mode === 'manual') {
    showManualSync(value);
    $('update-enroll').textContent = '저장소 업데이트 허용';
    $('set-repo-update-label').textContent = '이 PC에서 공유 저장소 업데이트 허용';
    $('set-repo-update-help').textContent = '새 버전은 자동으로 확인합니다. 버전 카드에서 앱·설치본 동기화를 누르면 이 PC에 적용합니다.';
  }
  if (value.mode === 'invalid') $('update-sync-status').textContent = '이 PC의 수동 동기화 정책 파일을 확인해 주세요.';
}).catch(error => { $('update-sync-status').textContent = error.message; });
$('update-sync').addEventListener('click', async () => {
  const button = $('update-sync');
  button.disabled = true;
  try { showManualSync(await call(window.hub.updateSync)); }
  catch (error) { button.disabled = false; toast(error.message, true); }
});

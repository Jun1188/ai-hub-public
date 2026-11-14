// 설정 탭 — LM Studio/허브 설정, 개발자 버전 토글, 공유 폴더, 자동 업데이트.
'use strict';

// ---- settings -----------------------------------------------------------------

let settingsUpdateRevision = 0;
let settingsUpdateBusy = false;

async function refreshRepositoryToggle() {
  if (settingsUpdateBusy) return;
  const revision = ++settingsUpdateRevision;
  const box = $('set-repo-update');
  const check = $('set-repo-check');
  box.disabled = check.disabled = true;
  try {
    const state = await call(window.hub.repositoryAutoUpdateGet);
    if (revision !== settingsUpdateRevision) return;
    box.checked = state.enabled;
    box.indeterminate = Boolean(state.blocked);
    box.disabled = Boolean(state.blocked);
    check.disabled = box.disabled || !box.checked || Boolean(state.unavailable);
    $('set-repo-update-info').textContent = state.message;
  } catch (e) {
    if (revision !== settingsUpdateRevision) return;
    box.indeterminate = true;
    $('set-repo-update-info').textContent = '이 PC의 자동 갱신 설정을 읽지 못했습니다. ' + e.message;
  }
}

$('set-repo-update').addEventListener('change', async () => {
  const box = $('set-repo-update');
  if (settingsUpdateBusy) return;
  settingsUpdateBusy = true;
  settingsUpdateRevision++;
  box.disabled = $('set-repo-check').disabled = true;
  $('set-repo-update-info').textContent = '이 PC의 자동 갱신 설정을 저장하는 중…';
  const requested = box.checked;
  let issue;
  try {
    const state = await call(window.hub.repositoryAutoUpdateSet, requested);
    if (state.error || (!state.cancelled && state.enabled !== requested)) issue = state.message;
  } catch (e) { issue = e.message; }
  finally {
    settingsUpdateBusy = false;
    await refreshRepositoryToggle();
    if (issue) $('set-repo-update-info').textContent = issue;
  }
});

window.addEventListener('focus', () => {
  if ($('tab-settings').classList.contains('active')) refreshRepositoryToggle();
});

$('set-repo-check').addEventListener('click', async () => {
  if (settingsUpdateBusy) return;
  settingsUpdateBusy = true;
  settingsUpdateRevision++;
  $('set-repo-update').disabled = $('set-repo-check').disabled = true;
  const info = $('set-repo-update-info');
  info.textContent = '새 버전을 확인하는 중…';
  let message;
  try {
    const result = await call(window.hub.updateCheck);
    message = result.message || result.error || (result.available ? '다음 시작 때 새 버전을 적용합니다.' : '확인이 끝났습니다.');
  } catch (e) { message = e.message; }
  finally {
    settingsUpdateBusy = false;
    await refreshRepositoryToggle();
    if (!$('set-repo-check').disabled) info.textContent = message;
  }
});

async function refreshSettings() {
  refreshRepositoryToggle();
  try {
    const cfg = await call(window.hub.configGet);
    const st = await call(window.hub.status);
    $('set-lmurl').value = cfg.lmstudio.baseUrl;
    $('set-port').value = cfg.hub.httpPort;
    $('set-auth').checked = cfg.hub.requireAuth;
    $('set-tray').checked = cfg.hub.closeToTray !== false;
    $('set-autostart').checked = Boolean(cfg.hub.autoStart);
    $('set-lite').checked = cfg.hub.profile === 'lite';
    $('set-lite-hint').textContent = '로컬 모델 자동 준비·백그라운드 하드웨어 점검·autopilot을 끄고 무거운 바이너리 분석은 데스크톱에 맡깁니다.' +
      (st.profile && st.profile.recommended && st.profile.profile !== 'lite' ? ' 이 PC의 메모리 크기에는 경량 모드를 권장합니다.' : '');
    const features = await call(window.hub.profileFeatures);
    $('set-lite-features').innerHTML = features.features.map((f) => `<label class="row"><input type="checkbox" data-lite-feature="${esc(f.id)}"${f.inLite ? ' checked' : ''} /> ${esc(f.label)}</label>`).join('');
    $('set-defmodel').value = cfg.delegation.defaultModel || '';
    $('set-lan').checked = Boolean(cfg.hub.lanAccess);
    $('set-devmode').checked = Boolean(cfg.ui && cfg.ui.devMode);
    $('set-share-enabled').checked = !cfg.share || cfg.share.enabled !== false;
    $('set-update-check').checked = !cfg.update || cfg.update.autoCheck !== false;
    const share = st.share || {};
    $('share-dir-now').innerHTML = share.enabled
      ? `현재: <b>${esc(share.root)}</b> ${share.paused ? '<span class="warn">(일시 중지)</span>' : '<span class="ok">(공유 중)</span>'}`
      : `현재: <span class="hint">공유 안 함${share.lastError ? ' — ' + esc(share.lastError) : ''}</span>`;
    if (!$('share-dir').value) $('share-dir').value = (cfg.share && cfg.share.dir) || '';
    $('set-paths').innerHTML =
      `앱 위치: ${esc(st.appRoot)}<br>데이터/설정: ${esc(st.dataDir)}<br>공유 폴더: ${esc(share.root || '(없음)')}`;
  } catch (e) { toast(e.message, true); }
}

async function applyShareDir(dir) {
  try {
    await call(window.hub.shareSetDir, dir);
    toast(dir ? `공유 폴더를 설정했습니다: ${dir}` : '공유 폴더를 자동 탐지로 되돌렸습니다.');
    $('share-dir').value = dir;
    setTimeout(refreshSettings, 1500); // 첫 동기화가 도는 동안 잠깐 기다렸다 갱신
  } catch (e) { toast(e.message, true); }
}

$('share-dir-apply').addEventListener('click', () => applyShareDir($('share-dir').value.trim()));
$('share-dir-pick').addEventListener('click', async () => {
  try {
    const dir = await call(window.hub.sharePickDir);
    if (dir) applyShareDir(dir);
  } catch (e) { toast(e.message, true); }
});
$('share-dir-auto').addEventListener('click', async () => {
  try {
    const found = await call(window.hub.shareDetect);
    if (!found) return toast('내 드라이브를 찾지 못했습니다. Google Drive 데스크톱이 실행 중인지 확인하세요.', true);
    applyShareDir('');
    $('share-dir').value = '';
    toast(`자동 탐지: ${found}`);
  } catch (e) { toast(e.message, true); }
});

function applyUiMode(dev) {
  document.body.classList.toggle('dev', Boolean(dev));
}

$('set-devmode').addEventListener('change', async () => {
  const on = $('set-devmode').checked;
  try {
    await call(window.hub.uiDevMode, on);
    applyUiMode(on);
    toast(on ? '개발자 버전으로 전환했습니다.' : '기본 버전으로 전환했습니다.');
  } catch (e) { toast(e.message, true); }
});

$('set-save').addEventListener('click', async () => {
  try {
    await call(window.hub.configUpdate, {
      lmstudio: { baseUrl: $('set-lmurl').value.trim() },
      hub: {
        httpPort: Number($('set-port').value),
        requireAuth: $('set-auth').checked,
        closeToTray: $('set-tray').checked,
        autoStart: $('set-autostart').checked,
        lanAccess: $('set-lan').checked,
        profile: $('set-lite').checked ? 'lite' : 'full',
        liteFeatures: [...document.querySelectorAll('[data-lite-feature]:checked')].map((c) => c.dataset.liteFeature),
      },
      delegation: { defaultModel: $('set-defmodel').value.trim() },
      share: { enabled: $('set-share-enabled').checked },
      update: {
        autoCheck: $('set-update-check').checked,
      },
    });
    const r = await call(window.hub.hubRestart);
    $('set-result').textContent = r.running ? '저장되었고 허브가 재시작되었습니다.' : '저장되었지만 허브 시작에 실패했습니다 (포트 충돌 확인).';
    applyFeatureProfile(); // 화면 단추는 바로, 나머지 경량 동작은 앱을 다시 시작한 뒤
  } catch (e) { toast(e.message, true); }
});

// 소스 overlay 적용 뒤 새 코드를 불러온다. 작업 중이면 main.js가 거절한다.
$('set-relaunch').addEventListener('click', async () => {
  try {
    await call(window.hub.appRelaunch);
    $('set-result').textContent = 'Hub 앱을 다시 시작합니다…';
  } catch (e) { toast(e.message, true); }
});

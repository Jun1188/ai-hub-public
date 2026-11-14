// 로컬 모델 패널 — 전역 사용자 프롬프트·모델 등급 편집과 로컬 런타임(ComfyUI·llama.cpp) 상태.
'use strict';

// ---- local models ---------------------------------------------------------------

let delegateLocalState = null;

async function refreshDelegate() {
  try {
    const st = await call(window.hub.status);
    await refreshLocalRuntimes();
    const cfg = await call(window.hub.configGet);
    $('dg-global').value = cfg.delegation.userGlobalPrompt || '';
    const tiers = cfg.delegation.modelTiers || {};
    $('tier-editor').innerHTML = st.lmstudio.models.map((m) => `
      <label class="row" style="margin:4px 0">
        <span style="flex:1;word-break:break-all">${esc(m.id)}</span>
        <select data-tier-model="${esc(m.id)}" style="width:110px">
          ${['high', 'medium', 'low', 'none'].map((t) => `<option value="${t}" ${(tiers[m.id] || m.tier) === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </label>`).join('') || '<div class="hint">모델 없음</div>';
  } catch (e) {
    toast(e.message, true);
  }
}

$('dg-global-save').addEventListener('click', async () => {
  try {
    await call(window.hub.configUpdate, { delegation: { userGlobalPrompt: $('dg-global').value } });
    toast('전역 프롬프트가 저장되었습니다.');
  } catch (e) { toast(e.message, true); }
});
$('tier-save').addEventListener('click', async () => {
  try {
    const tiers = {};
    document.querySelectorAll('[data-tier-model]').forEach((s) => { tiers[s.dataset.tierModel] = s.value; });
    await call(window.hub.configUpdate, { delegation: { modelTiers: tiers } });
    toast('모델 등급이 저장되었습니다.');
  } catch (e) { toast(e.message, true); }
});
async function refreshLocalRuntimes() {
  delegateLocalState = await call(window.hub.localStatus);
  const c = delegateLocalState.comfy;
  const l = delegateLocalState.llama;
  $('local-install-toggle').checked = delegateLocalState.showInstallActions;
  $('local-llama-repo').value = l.repo || $('local-llama-repo').value;
  $('local-runtime-status').innerHTML =
    `<div><b>ComfyUI</b> — 런타임 ${c.installed ? '<span class="ok">설치됨</span>' : '<span class="bad">없음</span>'}` +
    ` · API ${c.running ? '<span class="ok">실행 중</span>' : '<span class="warn">꺼짐</span>'}` +
    ` · 모델 ${c.models.count ? `<span class="ok">${c.models.count}개</span>` : '<span class="bad">0개</span>'}` +
    (c.models.unreadable ? ` <span class="warn">(못 읽은 폴더 ${c.models.unreadable}개)</span>` : '') +
    ` · 로드 노드 ${c.nodeClasses.length}개</div>` +
    `<div><b>llama.cpp</b> — 실행 파일 ${l.installed ? '<span class="ok">설치됨</span>' : '<span class="bad">없음</span>'}` +
    ` · API ${l.running ? '<span class="ok">실행 중</span>' : '<span class="warn">꺼짐</span>'}` +
    ` · 로드 모델 ${l.models.length ? `<span class="ok">${l.models.length}개</span>` : '<span class="bad">0개</span>'}</div>` +
    delegateComfyNote(c) +
    `<div class="hint">자동 선택: ${esc(delegateLocalState.routing.reason)}</div>`;
  const actions = [];
  if (!c.installed) actions.push('<button class="small" data-local-install="comfy">ComfyUI 자동 설치</button>');
  if (!l.installed) actions.push('<button class="small" data-local-install="llama">llama.cpp 자동 설치</button>');
  else if (!l.running || !l.models.length) actions.push('<button class="small primary" data-local-start="llama">모델 다운로드 + llama 서버 시작</button>');
  // ComfyUI 시작·끄기는 설치 동작이 아니라 런타임 조작이라 「설치 동작 보기」와 상관없이 보인다.
  const control = c.control || {};
  const comfyStarting = Boolean(control.lastStart && control.lastStart.state === 'starting');
  const comfyActions = [];
  if (c.installed && !c.running && !comfyStarting) comfyActions.push('<button class="small" data-comfy="start">ComfyUI 시작</button>');
  if (control.owner) comfyActions.push('<button class="small" data-comfy="stop">ComfyUI 끄기</button>');
  $('local-runtime-actions').innerHTML = comfyActions.join('') + (delegateLocalState.showInstallActions ? actions.join('') : '');
  document.querySelectorAll('[data-comfy]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      if (b.dataset.comfy === 'stop') { await call(window.hub.localStopComfy); toast('ComfyUI를 껐습니다.'); }
      else {
        const r = await call(window.hub.localStartComfy);
        toast(r.desktopOpened ? r.message : 'ComfyUI를 시작하는 중입니다. 준비되면 상태가 바뀝니다.');
        if (!r.desktopOpened) delegatePollComfy(36);
      }
      await refreshLocalRuntimes();
    } catch (e) { toast(e.message, true); b.disabled = false; }
  }));
  document.querySelectorAll('[data-local-install]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await call(window.hub.localInstall, b.dataset.localInstall); toast('설치가 완료되었습니다.'); await refreshLocalRuntimes(); }
    catch (e) { toast(e.message, true); } finally { b.disabled = false; }
  }));
  document.querySelectorAll('[data-local-start]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await call(window.hub.localStartLlama, $('local-llama-repo').value.trim());
      toast('시작했습니다. 모델 다운로드/서버 준비 후 새로고침됩니다.');
      setTimeout(() => refreshLocalRuntimes().catch(() => {}), 5000);
    } catch (e) { toast(e.message, true); }
  }));
}

/** 허브가 띄운 ComfyUI의 상태 한 줄: 누가 띄웠는지, 어디서 여는지, 시작 중·실패. */
function delegateComfyNote(c) {
  const control = c.control || {};
  const s = control.lastStart;
  if (control.owner) {
    return `<div class="hint">허브가 띄운 ComfyUI가 실행 중입니다(${control.owner.manual ? '직접 시작 — 자동으로 끄지 않음' : '워크플로용 — 쉬면 자동 종료'}). ` +
      `화면은 브라우저에서 ${esc(c.url)} 로 여세요. 이 동안 Comfy Desktop에서 서버를 시작하면 같은 DB 잠금 때문에 실패합니다.</div>`;
  }
  if (s && s.state === 'starting') return '<div class="hint">ComfyUI 시작 중… 보통 20~70초, 최대 3분 걸립니다.</div>';
  if (s && s.state === 'failed') return `<div class="hint"><span class="bad">ComfyUI 시작 실패</span>: ${esc(s.error || s.code || '')}</div>`;
  return '';
}

/** 백그라운드 시작이 끝날 때까지 5초마다 상태를 다시 읽는다(최대 3분). */
function delegatePollComfy(left) {
  setTimeout(async () => {
    try { await refreshLocalRuntimes(); } catch { return; }
    const s = delegateLocalState && delegateLocalState.comfy.control && delegateLocalState.comfy.control.lastStart;
    if (s && s.state === 'starting' && left > 1) delegatePollComfy(left - 1);
    else if (s && s.state === 'failed') toast(`ComfyUI 시작 실패: ${s.error || s.code || ''}`, true);
    else if (s && s.state === 'up') toast('ComfyUI가 준비됐습니다.');
  }, 5000);
}

$('local-install-toggle').addEventListener('change', async () => {
  try { await call(window.hub.localShowInstallActions, $('local-install-toggle').checked); await refreshLocalRuntimes(); }
  catch (e) { toast(e.message, true); }
});
$('local-comfy-pick').addEventListener('click', async () => {
  try { const p = await call(window.hub.localPickWorkflow); if (p) $('local-comfy-workflow').value = p; }
  catch (e) { toast(e.message, true); }
});
$('local-comfy-run').addEventListener('click', async () => {
  $('local-comfy-run').disabled = true;
  $('local-comfy-output').textContent = 'ComfyUI 워크플로 실행 중...';
  try {
    const inputs = $('local-comfy-inputs').value.trim() ? JSON.parse($('local-comfy-inputs').value) : {};
    const r = await call(window.hub.mediaRun, { kind: 'image', workflowFile: $('local-comfy-workflow').value.trim(), inputs });
    mediaResult('image', r);
    $('local-comfy-output').textContent = JSON.stringify(r, null, 2);
  } catch (e) { $('local-comfy-output').textContent = `오류: ${e.message}`; mediaResult('image', { status: 'failed' }); }
  finally { $('local-comfy-run').disabled = false; }
});
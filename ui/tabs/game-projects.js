// 게임 프로젝트 탭 — Unity/Unreal 프로젝트 목록과 에디터·VS·Antigravity 런처.
'use strict';

// ---- game projects ---------------------------------------------------------------

async function refreshProjects() {
  try {
    const list = await call(window.hub.projList);
    $('proj-list').innerHTML = list.length
      ? list.map((p) => `
        <div class="row" style="margin:8px 0; align-items:flex-start">
          <div style="flex:1">
            <span class="badge">${esc(p.kind)}</span> <b>${esc(p.name)}</b>
            <span class="hint">${esc(p.language || p.engineVersion || p.buildSystem)}</span>
            <div class="hint">${esc(p.path)}${p.missingHere ? ' <span class="warn">이 PC에 없음 (다른 PC에서 등록)</span>' : ''}</div>
            ${p.kind === 'node' ? Object.values(p.commands || {}).map(c => '<code>' + esc(c) + '</code>').join(' ') :
              p.kind === 'msbuild' || p.editorPath ? '' : '<div class="warn">⚠ 이 컴퓨터에서 해당 엔진 버전을 찾지 못했습니다</div>'}
          </div>
          ${p.kind === 'unity' || p.kind === 'unreal' ? `<button class="small" data-proj-editor="${esc(p.id)}">에디터</button>` : ''}
          ${p.kind === 'node' && !p.slnPath ? '' : `<button class="small" data-proj-sln="${esc(p.id)}">VS</button>`}
          <button class="small" data-proj-ag="${esc(p.id)}">Antigravity</button>
          ${p.kind === 'unreal' && p.engineRoot ? `<button class="small" data-proj-idx="${esc(p.id)}" data-eng-root="${esc(p.engineRoot)}" data-eng-ver="${esc(p.engineVersion)}">엔진 소스 인덱싱</button>` : ''}
          <button class="small" data-proj-refresh="${esc(p.id)}">재감지</button>
          <button class="small danger" data-proj-del="${esc(p.id)}">삭제</button>
        </div>`).join('')
      : '<div class="hint">등록된 프로젝트가 없습니다. Unity, Unreal, Node.js 또는 Visual Studio 솔루션 폴더를 추가하세요.</div>';
    bindDataAction('proj-editor', (id) => launchAction(window.hub.projLaunchEditor, id, '에디터'));
    bindDataAction('proj-sln', (id) => launchAction(window.hub.projLaunchSln, id, 'Visual Studio'));
    bindDataAction('proj-ag', (id) => launchAction(window.hub.projLaunchAntigravity, id, 'Antigravity'));
    bindDataAction('proj-refresh', async (id) => {
      await call(window.hub.projRefresh, id).catch((e) => toast(e.message, true));
      toast('프로젝트 정보를 다시 감지했습니다.');
      refreshProjects();
    });
    bindDataAction('proj-del', async (id) => {
      await call(window.hub.projRemove, id).catch((e) => toast(e.message, true));
      refreshProjects();
    });
    document.querySelectorAll('[data-proj-idx]').forEach((b) => b.addEventListener('click', async () => {
      const name = ('ue-' + b.dataset.engVer).replace(/[^\w-]/g, '-');
      const root = b.dataset.engRoot + '\\Engine\\Source';
      try {
        await call(window.hub.idxBuild, { name, root, exts: ['.h'] });
        toast(`엔진 소스 인덱싱 시작: "${name}" — 소스 분석 탭에서 진행 상황을 확인하세요.`);
      } catch (e) { toast(e.message, true); }
    }));
    refreshProjectTools(false);
  } catch (e) { toast(e.message, true); }
}

async function launchAction(fn, id, label) {
  try {
    const r = await call(fn, id);
    if (r.ok) toast(`${label}를 실행했습니다.`);
    else toast(r.error, true);
  } catch (e) { toast(e.message, true); }
}

async function refreshProjectTools(force) {
  try {
    const t = await call(window.hub.projTools, force);
    const rows = [];
    rows.push(`<h3>Unity 에디터 (${t.unityEditors.length})</h3>`);
    rows.push(t.unityEditors.length
      ? t.unityEditors.map((e) => `<div class="hint">• ${esc(e.version)} — ${esc(e.exePath)}</div>`).join('')
      : '<div class="hint">감지 안 됨</div>');
    rows.push(`<h3>Unreal 엔진 (${t.unrealEngines.length})</h3>`);
    rows.push(t.unrealEngines.length
      ? t.unrealEngines.map((e) => `<div class="hint">• ${esc(e.version)} — ${esc(e.installLocation)}</div>`).join('')
      : '<div class="hint">감지 안 됨</div>');
    rows.push('<h3>기타</h3>');
    rows.push(`<div class="hint">Visual Studio: ${t.visualStudio ? esc(t.visualStudio.displayName) : '감지 안 됨'}</div>`);
    rows.push(`<div class="hint">Antigravity: ${t.antigravityPath ? esc(t.antigravityPath) : '감지 안 됨'}</div>`);
    rows.push(`<div class="hint">UGS CLI: ${t.ugsPath ? esc(t.ugsPath) : '감지 안 됨'}</div>`);
    rows.push(`<div class="hint">감지 시각: ${esc(t.detectedAt.slice(0, 19).replace('T', ' '))}</div>`);
    $('proj-tools').innerHTML = rows.join('');
  } catch (e) { toast(e.message, true); }
}

$('proj-add').addEventListener('click', async () => {
  try {
    const dir = await call(window.hub.projPick);
    if (!dir) return;
    const p = await call(window.hub.projAdd, dir);
    toast(`${p.kind} 프로젝트 "${p.name}" 등록됨`);
    refreshProjects();
  } catch (e) { toast(e.message, true); }
});
$('proj-reload').addEventListener('click', refreshProjects);
$('proj-tools-refresh').addEventListener('click', () => refreshProjectTools(true));

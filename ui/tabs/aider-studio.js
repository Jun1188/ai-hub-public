// Aider Studio is the visible control plane for local-model coding runs, local models and MCP.
'use strict';

let aiderStudioRunId = '';
let aiderStudioModels = [];

document.querySelector('main').insertAdjacentHTML('beforeend', `
  <section id="tab-aider" class="tab aider-workbench">
    <div class="aider-masthead">
      <div>
        <span class="aider-mark">A/</span>
        <h1>에이전트 작업실</h1>
        <p>Aider로 로컬 모델 코딩 작업을 실행하고, 로컬 모델과 MCP 연결을 관리합니다.</p>
      </div>
      <div id="aider-status" class="aider-health">확인 중...</div>
    </div>
    <div class="aider-subnav">
      <button data-aider-panel="work" class="active">작업</button>
      <button data-aider-panel="models">로컬 모델</button>
      <button data-aider-panel="connections">MCP 연결</button>
    </div>
    <div id="aider-panel-work" class="aider-panel active">
      <div class="aider-grid">
        <aside class="aider-rail">
          <h2>작업 대상</h2>
          <label>프로젝트 폴더</label>
          <div class="row"><input id="aider-project" placeholder="C:\\path\\to\\repository" /><button id="aider-pick" class="small">선택</button></div>
          <div id="aider-direct-options">
          <label>모델 공급자</label>
          <select id="aider-provider">
            <option value="lmstudio">LM Studio</option>
            <option value="llamacpp">llama.cpp (실행 중 모델)</option>
            <option value="hf-cache">Hugging Face 캐시 → llama.cpp</option>
          </select>
          <label>로컬 모델</label>
          <select id="aider-model"><option value="">자동 선택</option></select>
          <div id="aider-model-note" class="hint"></div>
          <label>편집 모드</label>
          <select id="aider-mode">
            <option value="code">Code — 파일 편집</option>
            <option value="architect">Architect — 설계 후 편집</option>
            <option value="ask">Ask — 읽고 답변만</option>
          </select>
          </div>
          <button id="aider-graph-workers" type="button" data-feature="pipelines">파이프라인 노드별 작업자 설정</button>
          <label>집중할 파일 <span class="hint">(프로젝트 기준, 한 줄에 하나)</span></label>
          <textarea id="aider-files" rows="7" placeholder="src/core/example.js&#10;README.md"></textarea>
          <div class="aider-switches">
            <label class="row"><input id="aider-dry" type="checkbox" /> 파일을 바꾸지 않는 dry run</label>
            <label class="row" id="aider-commit-row"><input id="aider-commits" type="checkbox" /> Aider 자동 커밋 허용</label>
          </div>
        </aside>
        <section class="aider-command">
          <div class="aider-section-title"><h2>작업 지시</h2><span id="aider-execution-note">한 번 실행 · 선택한 로컬 모델</span></div>
          <textarea id="aider-prompt" rows="12" placeholder="원하는 결과, 지켜야 할 제약, 완료 조건을 적으세요."></textarea>
          <div class="aider-actions">
            <button id="aider-preview">실행 설정 확인</button><button id="aider-run" class="primary">Aider 실행</button><button id="aider-cancel" class="danger" disabled>중지</button>
          </div>
          <div class="aider-disclosure">Aider가 선택한 로컬 모델로 파일을 편집합니다. 자동 커밋은 허용한 경우에만 합니다.</div>
          <h2>실행 명령</h2><pre id="aider-command-preview" class="output small">미리보기를 누르면 실제 명령이 표시됩니다.</pre>
        </section>
        <section class="aider-console">
          <div class="aider-section-title"><h2>실행 로그</h2><span id="aider-run-state">대기</span></div>
          <pre id="aider-log" class="output">Aider 출력을 여기에 스트리밍합니다.</pre>
        </section>
      </div>
    </div>
    <div id="aider-panel-models" class="aider-panel"><div class="card"><h2>llama.cpp 모델</h2><p class="hint">토글로 각 모델을 로드하거나 메모리에서 내립니다. 모델 파일은 보존됩니다.</p><button id="aider-model-refresh">새로고침</button><div id="aider-model-controls"></div><pre id="aider-model-error" class="hint"></pre></div><div id="aider-model-summary" class="aider-integrated"></div></div>
    <div id="aider-panel-connections" class="aider-panel"></div>
  </section>`);

// Keep old handlers and IPC contracts intact while moving their surfaces under Aider.
const aiderLmCard = $('lm-status') && $('lm-status').closest('.card');
if (aiderLmCard) $('aider-model-summary').appendChild(aiderLmCard);
const aiderLegacyDelegate = $('tab-delegate');
if (aiderLegacyDelegate) {
  aiderLegacyDelegate.classList.remove('tab');
  aiderLegacyDelegate.classList.add('aider-integrated');
  $('aider-panel-models').appendChild(aiderLegacyDelegate);
}
const aiderMcpPanel = $('tab-mcp');
if (aiderMcpPanel) {
  aiderMcpPanel.classList.remove('tab');
  aiderMcpPanel.classList.add('aider-integrated');
  $('aider-panel-connections').appendChild(aiderMcpPanel);
}

document.querySelectorAll('[data-aider-panel]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-aider-panel]').forEach((item) => item.classList.toggle('active', item === button));
    document.querySelectorAll('.aider-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `aider-panel-${button.dataset.aiderPanel}`));
    if (button.dataset.aiderPanel === 'models') { refreshDashboard(); refreshDelegate(); refreshAiderStudio(); }
    if (button.dataset.aiderPanel === 'connections') refreshMcp();
  });
});

function aiderStudioPayload() {
  return {
    projectDir: $('aider-project').value.trim(), prompt: $('aider-prompt').value,
    provider: $('aider-provider').value, model: $('aider-model').value || undefined,
    mode: $('aider-mode').value,
    files: $('aider-files').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    dryRun: $('aider-dry').checked, autoCommits: $('aider-commits').checked,
  };
}

function refreshAiderModelOptions() {
  const provider = $('aider-provider').value;
  const current = $('aider-model').value;
  const matches = aiderStudioModels.filter((m) => m.provider === provider);
  $('aider-model').innerHTML = '<option value="">자동 선택</option>' + matches.map((m) =>
    `<option value="${esc(m.id)}">${esc(m.id)} · ${esc(m.state)}</option>`).join('');
  if ([...$('aider-model').options].some((o) => o.value === current)) $('aider-model').value = current;
  const notes = {
    lmstudio: 'LM Studio의 OpenAI 호환 API를 사용합니다.',
    llamacpp: '현재 llama.cpp 서버에 로드된 모델만 사용합니다.',
    'hf-cache': 'hf CLI 캐시의 GGUF 저장소를 llama.cpp로 준비해 사용합니다.',
  };
  $('aider-model-note').textContent = `${notes[provider]} ${matches.length}개 발견`;
}

async function refreshAiderStudio() {
  try {
    const state = await call(window.hub.aiderStatus);
    aiderStudioModels = state.models || [];
    const control = state.control || {};
    $('aider-model-controls').replaceChildren();
    const controlModels = state.llama.router ? state.llama.models : state.hf.models;
    for (const model of controlModels) {
      const row = document.createElement('div'); row.className = 'row';
      const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.setAttribute('role', 'switch');
      const on = state.llama.router ? ['loaded', 'loading'].includes(model.state) : control.managed && control.model === model.id;
      toggle.checked = on; toggle.setAttribute('aria-label', `${model.id} 서버`);
      toggle.disabled = Boolean(state.active || state.starting) || (!state.llama.router && Boolean(control.managed || state.llama.running) && !on);
      const label = document.createElement('span'); label.textContent = `${model.id} · ${model.failed ? '로드 실패' : state.llama.router ? model.state : on ? '실행 중 / 준비 중' : '꺼짐'}`;
      const unload = document.createElement('button'); unload.textContent = 'Unload'; unload.disabled = !on || Boolean(state.active);
      const act = async (stop) => {
        toggle.disabled = true; unload.disabled = true;
        $('aider-model-error').textContent = '';
        label.textContent = `${model.id} · ${stop ? '종료 중' : '모델 로드 중'}`;
        try {
          const { requestId } = await call(stop ? window.hub.aiderModelStop : window.hub.aiderModelStart, model.id);
          while (true) {
            const result = await call(window.hub.aiderModelResult, requestId);
            if (result.state === 'failed') throw new Error(result.error);
            if (result.state === 'completed') break;
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
        catch (err) { toast(err.message, true); $('aider-model-error').textContent = `${model.id} · 실패: ${err.message}`; }
        finally { await refreshAiderStudio(); }
      };
      toggle.addEventListener('change', () => act(!toggle.checked)); unload.addEventListener('click', () => act(true));
      row.append(toggle, label, unload); $('aider-model-controls').appendChild(row);
    }
    const usable = aiderStudioModels.length > 0;
    $('aider-status').innerHTML = `<b>${state.installed ? esc(state.version) : 'Aider 실행 불가'}</b>` +
      `<span>LM Studio ${state.lmstudio.models.length} · llama.cpp ${state.llama.models.length} · HF cache ${state.hf.models.length}</span>`;
    $('aider-status').classList.toggle('ready', state.installed && usable);
    refreshAiderModelOptions();
    if (state.active) {
      aiderStudioRunId = state.active.runId;
      $('aider-run-state').textContent = '실행 중'; $('aider-run').disabled = true; $('aider-cancel').disabled = false;
    }
  } catch (err) {
    $('aider-run-state').textContent = '실패';
    $('aider-log').textContent += `[hub] ${err.message}\n`;
    toast(err.message, true);
  }
}

$('aider-provider').addEventListener('change', refreshAiderModelOptions);
$('aider-graph-workers').addEventListener('click', () => hubGo('pipelines', 'pg-workspace'));
$('aider-pick').addEventListener('click', async () => {
  try { const selected = await call(window.hub.aiderPickProject); if (selected) $('aider-project').value = selected; }
  catch (err) { toast(err.message, true); }
});
$('aider-preview').addEventListener('click', async () => {
  try {
    const plan = await call(window.hub.aiderPreview, aiderStudioPayload()); $('aider-command-preview').textContent = plan.display;
  }
  catch (err) { toast(err.message, true); }
});
$('aider-run').addEventListener('click', async () => {
  $('aider-run').disabled = true;
  try {
    const plan = await call(window.hub.aiderPreview, aiderStudioPayload());
    $('aider-command-preview').textContent = plan.display; $('aider-log').textContent = '';
    const started = await call(window.hub.aiderStart, aiderStudioPayload());
    aiderStudioRunId = started.runId; $('aider-run-state').textContent = '실행 중';
    $('aider-run').disabled = true; $('aider-cancel').disabled = false;
  } catch (err) { $('aider-run').disabled = false; $('aider-run-state').textContent = '실패'; $('aider-log').textContent += `\n${err.message}`; toast(err.message, true); }
});
$('aider-cancel').addEventListener('click', async () => {
  try {
    await call(window.hub.aiderCancel, aiderStudioRunId);
  }
  catch (err) { toast(err.message, true); }
});

window.hub.onAiderLog((event) => {
  if (event.runId !== aiderStudioRunId) return;
  const log = $('aider-log'); log.textContent += event.text; log.scrollTop = log.scrollHeight;
});
window.hub.onAiderStatus((event) => {
  if (event.runId !== aiderStudioRunId) return;
  $('aider-run-state').textContent = event.state === 'completed' ? '완료' : event.state === 'failed' ? '실패' : '실행 중';
  if (event.state !== 'running') { $('aider-run').disabled = false; $('aider-cancel').disabled = true; }
});
$('aider-model-refresh').addEventListener('click', refreshAiderStudio);

// 파이프라인 탭 — 빌드/자동화 파이프라인 목록, 실행, 로그, 간단 만들기(템플릿).
'use strict';

// ---- build pipelines -------------------------------------------------------------

const PIPE_EXAMPLE = {
  name: '예시: 빌드 후 AI 로그 요약',
  projectId: '',
  steps: [
    { type: 'shell', name: '준비', command: 'echo build start' },
    { type: 'ai', name: '로그 요약', taskType: 'programming', inputFrom: 'previousLog', promptTemplate: '다음 빌드 로그를 3줄로 요약해줘:\n{{input}}' },
  ],
};

let currentRunId = null;

async function refreshPipelines() {
  try {
    const [pipes, projs] = await Promise.all([call(window.hub.pipeList), call(window.hub.projList)]);
    $('pipe-list').innerHTML = pipes.length
      ? pipes.map((p) => {
        const safe = !p.graph && p.steps.every((s) => ['ai', 'source-index', 'finetune-gen'].includes(s.type));
        const auto = p.auto && p.auto.enabled;
        return `
        <div class="row" style="margin:6px 0">
          <div style="flex:1"><b>${esc(p.name)}</b> <span class="hint">${p.steps.length} 스텝${p.projectId ? ' · 프로젝트 연결됨' : ''}${auto ? ' · <span class="ok">자동 실행 중</span>' : ''}</span></div>
          <button class="small primary" data-pipe-run="${esc(p.id)}">실행</button>
          ${safe ? `<button class="small" data-pipe-auto="${esc(p.id)}" data-on="${auto ? '0' : '1'}">${auto ? '자동 끄기' : '자동 실행'}</button>` : ''}
          <button class="small" data-pipe-edit="${esc(p.id)}">편집</button>
          <button class="small danger" data-pipe-del="${esc(p.id)}">삭제</button>
        </div>`;
      }).join('')
      : '<div class="hint">저장된 파이프라인이 없습니다. 아래에서 만들거나 예시를 불러오세요.</div>';
    $('pipe-run-project').innerHTML =
      '<option value="">프로젝트: 파이프라인 기본값</option>' +
      projs.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.kind)})</option>`).join('');
    bindDataAction('pipe-run', startPipeline);
    document.querySelectorAll('[data-pipe-auto]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const on = b.dataset.on === '1';
        await call(window.hub.pipeAutoToggle, b.dataset.pipeAuto, on);
        toast(on ? '자동 실행이 켜졌습니다 (기본 24시간 주기, 대시보드의 자동 작업이 켜져 있어야 함).' : '자동 실행을 껐습니다.');
        refreshPipelines();
      } catch (e) { toast(e.message, true); }
    }));
    bindDataAction('pipe-edit', (id) => {
      const p = pipes.find((x) => x.id === id);
      if (p) { $('pipe-json').value = JSON.stringify(p, null, 2); window.pipelineGraphEditor.load(p); }
    });
    bindDataAction('pipe-del', async (id) => {
      await call(window.hub.pipeDelete, id).catch((e) => toast(e.message, true));
      refreshPipelines();
    });
    refreshPipeHistory();
  } catch (e) { toast(e.message, true); }
}

async function startPipeline(id) {
  try {
    const projectId = $('pipe-run-project').value || undefined;
    const { runId } = await call(window.hub.pipeStart, id, projectId);
    currentRunId = runId;
    $('pipe-log').textContent = '';
    $('pipe-run-meta').innerHTML = `<span class="ok">● 실행 중</span> <span class="hint">${esc(runId)}</span>`;
    $('pipe-cancel').disabled = false;
  } catch (e) { toast(e.message, true); }
}

async function refreshPipeHistory() {
  try {
    const runs = await call(window.hub.pipeHistory);
    $('pipe-history').innerHTML = runs.length
      ? '<tr><th>파이프라인</th><th>상태</th><th>시작</th><th>스텝</th><th></th></tr>' +
        runs.slice(0, 20).map((r) => {
          const cls = r.status === 'succeeded' ? 'ok' : ['running','paused'].includes(r.status) ? 'warn' : 'bad';
          const stepsTxt = r.steps.map((s) => `${s.name}:${s.status}`).join(', ');
          return `<tr><td>${esc(r.pipelineName)}</td><td><span class="${cls}">${esc(r.status)}</span></td>` +
            `<td class="hint">${esc(r.startedAt.slice(5, 16).replace('T', ' '))}</td>` +
            `<td class="hint">${esc(stepsTxt.slice(0, 60))}${stepsTxt.length > 60 ? '…' : ''}</td>` +
            `<td><button class="small" data-run-log="${esc(r.runId)}" data-steps="${r.steps.length}">로그</button>${r.graphCheckpoint ? '<button class="small" data-graph-review="'+esc(r.runId)+'">상태·검토</button>' : ''} </td></tr>`;
        }).join('')
      : '<tr><td class="hint">실행 이력이 없습니다</td></tr>';
    document.querySelectorAll('[data-graph-review]').forEach(b=>b.addEventListener('click',()=>window.pipelineGraphEditor.review(runs.find(r=>r.runId===b.dataset.graphReview))));
    window.pipelineGraphEditor?.sync(runs); // 검토 중인 실행이 재개·종료됐으면 자원 표시의 구간을 새 기록으로 바꾼다
    document.querySelectorAll('[data-run-log]').forEach((b) => b.addEventListener('click', async () => {
      const runId = b.dataset.runLog;
      // 이력 열람 모드: 진행 중인 실행의 라이브 로그가 섞이지 않도록 분리
      currentRunId = null;
      $('pipe-cancel').disabled = true;
      const n = Number(b.dataset.steps) || 0;
      let out = '';
      for (let i = 0; i < n; i++) {
        const log = await call(window.hub.pipeReadLog, runId, i).catch(() => '');
        if (log) out += `===== 스텝 ${i} =====\n${log.replace(/\r\n/g, '\n')}\n`;
      }
      $('pipe-log').textContent = out || '(로그 없음)';
      $('pipe-run-meta').innerHTML = `<span class="hint">이력 로그: ${esc(runId)}</span>`;
    }));
  } catch (e) { toast(e.message, true); }
}

$('pipe-save').addEventListener('click', async () => {
  try {
    const obj = JSON.parse($('pipe-json').value);
    const saved = await call(window.hub.pipeSave, obj);
    $('pipe-json').value = JSON.stringify(saved, null, 2);
    toast(`파이프라인 "${saved.name}" 저장됨`);
    refreshPipelines();
  } catch (e) { toast('저장 실패: ' + e.message, true); }
});
$('pipe-new').addEventListener('click', () => { $('pipe-json').value = ''; });
$('pipe-example').addEventListener('click', () => {
  $('pipe-json').value = JSON.stringify(PIPE_EXAMPLE, null, 2);
});

// UE 소스코드 등록 → 인덱싱 → 파인튜닝 데이터셋까지 한 번에 도는 예시.
// 실행 시 프로젝트 선택에서 Unreal 프로젝트를 고르면 ${project.engineRoot}가 채워집니다.
const PIPE_EXAMPLE_FT = {
  name: '예시: UE 엔진 파인튜닝 데이터셋',
  projectId: '',
  steps: [
    { type: 'source-index', name: '엔진 소스 인덱싱', index: 'ue-engine', root: '${project.engineRoot}\\Engine\\Source\\Runtime', exts: ['.h'] },
    { type: 'finetune-gen', name: '데이터셋 생성', indexName: 'ue-engine', count: 100 },
    { type: 'ai', name: '데이터셋 생성 요약', taskType: 'programming', inputFrom: 'previousLog',
      promptTemplate: '다음 파인튜닝 데이터셋 생성 로그를 보고 데이터 품질과 다음 단계(Unsloth LoRA 학습)를 한국어로 정리해줘:\n{{input}}' },
  ],
};
$('pipe-example-ft').addEventListener('click', () => {
  $('pipe-json').value = JSON.stringify(PIPE_EXAMPLE_FT, null, 2);
});
// ---- basic-mode pipeline builder (템플릿 → 폼 → JSON 생성) ------------------

const PB_TEMPLATES = {
  shell: {
    fields: [{ id: 'cmd', label: '실행할 명령 (여러 줄 = 여러 스텝)', kind: 'textarea', ph: 'echo hello\nnpm test' }],
    build: (v) => v.cmd.split('\n').map((c) => c.trim()).filter(Boolean)
      .map((c, i) => ({ type: 'shell', name: `명령 ${i + 1}`, command: c })),
  },
  'unity-build': {
    fields: [{ id: 'method', label: '실행할 정적 메서드 (예: BuildScript.PerformBuild)', ph: 'BuildScript.PerformBuild' }],
    build: (v) => [{ type: 'unity-batch', name: 'Unity 배치 실행', executeMethod: v.method.trim() }],
  },
  'ue-cook': {
    fields: [{ id: 'extra', label: '추가 인자 (선택, 공백 구분)', ph: '-clientconfig=Development' }],
    build: (v) => [{
      type: 'uat', name: 'BuildCookRun', command: 'BuildCookRun',
      args: ['-platform=Win64', '-build', '-cook', '-stage', '-pak', ...(v.extra.trim() ? v.extra.trim().split(/\s+/) : [])],
    }],
  },
  'ai-task': {
    fields: [{ id: 'prompt', label: 'AI에게 시킬 작업', kind: 'textarea', ph: '예: 프로젝트 폴더 구조에 맞는 .gitignore를 만들어줘' }],
    build: (v) => [{ type: 'ai', name: 'AI 작업', taskType: 'programming', promptTemplate: v.prompt.trim() }],
  },
};

function renderPbFields() {
  const t = PB_TEMPLATES[$('pb-template').value];
  $('pb-fields').innerHTML = t.fields.map((f) => `
    <label>${esc(f.label)}</label>
    ${f.kind === 'textarea'
      ? `<textarea id="pbf-${f.id}" rows="3" placeholder="${esc(f.ph || '')}"></textarea>`
      : `<input id="pbf-${f.id}" placeholder="${esc(f.ph || '')}" />`}`).join('');
}
$('pb-template').addEventListener('change', renderPbFields);
renderPbFields();

$('pb-create').addEventListener('click', async () => {
  try {
    const tKey = $('pb-template').value;
    const t = PB_TEMPLATES[tKey];
    const values = {};
    for (const f of t.fields) values[f.id] = $(`pbf-${f.id}`).value || '';
    const steps = t.build(values);
    if (!steps.length) return toast('필수 입력을 채워주세요.', true);
    if ($('pb-summary').checked) {
      steps.push({
        type: 'ai', name: 'AI 요약', taskType: 'reasoning', inputFrom: 'previousLog',
        promptTemplate: '다음 실행 로그의 결과(성공/실패, 핵심 내용, 다음에 할 일)를 한국어 3~5줄로 요약해줘:\n{{input}}',
      });
    }
    const name = $('pb-name').value.trim() || `${tKey} 파이프라인`;
    const projectId = $('pipe-run-project').value || undefined;
    const saved = await call(window.hub.pipeSave, { name, projectId, steps });
    toast(`파이프라인 "${saved.name}" 생성됨 — 목록에서 실행하세요.`);
    $('pb-name').value = '';
    refreshPipelines();
  } catch (e) { toast(e.message, true); }
});

$('pipe-cancel').addEventListener('click', async () => {
  if (!currentRunId) return;
  await call(window.hub.pipeCancel, currentRunId).catch((e) => toast(e.message, true));
  toast('실행 취소를 요청했습니다.');
});

window.hub.onPipelineLog((p) => {
  if (p.runId !== currentRunId) return;
  const el = $('pipe-log');
  el.textContent += p.chunk.replace(/\r\n/g, '\n');
  if (el.textContent.length > 400000) el.textContent = el.textContent.slice(-300000);
  el.scrollTop = el.scrollHeight;
});

window.hub.onPipelineStatus((p) => {
  if (p.runId !== currentRunId) return;
  window.pipelineCanvas.mark(p);
  if (p.status === 'running') {
    $('pipe-run-meta').innerHTML = `<span class="ok">● 실행 중</span> 스텝 ${p.stepIndex + 1} <span class="hint">${esc(p.runId)}</span>`;
  } else {
    const cls = p.status === 'succeeded' ? 'ok' : 'bad';
    $('pipe-run-meta').innerHTML = `<span class="${cls}">● ${esc(p.status)}</span> <span class="hint">${esc(p.runId)}</span>`;
    $('pipe-cancel').disabled = true;
    refreshPipeHistory();
  }
});

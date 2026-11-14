'use strict';
(() => {
  let mounted = false;
  let evidenceId = '', reaEvidenceId = '';
  const el = id => document.getElementById(id);
  const ui = {
    async refresh() {
      if (!window.hub.analysisGraphCapabilities) return;
      mount();
      try {
        // REA status probes an external CLI; the graph list must not wait for it.
        call(window.hub.analysisAdapters).then(adapters => {
          const rea = adapters.rea || {};
          el('ag-rea-status').textContent = rea.available
            ? 'REA ' + rea.version + ' (Node ' + rea.nodeVersion + ') · ' + (rea.providers || []).map(p => p.id + ': ' + p.status).join(', ')
            : 'REA 미설치 또는 실행 불가 — ' + (rea.remediation || rea.reason || '') + ' · Ghidra 그래프는 대체 경로로 계속 사용할 수 있습니다.';
          el('ag-adapters').textContent = adapters.references.map(row => row.id + ': ' + row.target + ' (' + row.integration + ')').join('\n');
        }).catch(error => toast(error.message, true));
        const [caps, rows] = await Promise.all([call(window.hub.analysisGraphCapabilities), call(window.hub.analysisGraphList)]);
        el('ag-capabilities').textContent = 'AST: ' + (caps.ast.available ? caps.ast.version : '런타임 없음') +
          ' · Ghidra: ' + (caps.ghidra.available ? '사용 가능' : '런타임 없음') + ' · Java: ' + (caps.java.available ? caps.java.version : '없음');
        el('ag-graphs').innerHTML = '<option value="">분석 결과 선택</option>' + rows.map(row => '<option value="' + esc(row.name) + '">' + esc(row.name) + ' · ' + esc(row.kind) + ' · ' + (row.nodes || 0) + ' nodes</option>').join('');
      } catch (error) { toast(error.message, true); }
    },
  };
  function mount() {
    if (mounted || !el('tab-source')) return;
    mounted = true;
    const panel = document.createElement('section');
    panel.className = 'card'; panel.id = 'ag-panel';
    panel.innerHTML = '<h2>구조 · 바이너리 그래프</h2><p>심볼로 위치를 찾은 뒤 작은 소스 범위를 분석하세요. 모델 호출 없이 호출·참조·모듈 관계를 추출합니다.</p>' +
      '<h3>REA 바이너리·아티팩트 분석 (우선)</h3><p class="hint" id="ag-rea-status"></p>' +
      '<p class="hint">네이티브(Ghidra)·.NET·Electron/JS 대상을 실행하지 않고 분석합니다. 근거는 이 PC에만 저장됩니다. 게임 엔진 소스는 아래 AST 구조 분석을 사용하세요.</p>' +
      '<label>대상 파일·폴더<input id="ag-rea-target" placeholder="C:\\path\\Game.dll 또는 Electron 앱 폴더/app.asar"></label><button id="ag-rea-pick" class="small">파일 선택</button>' +
      '<label>작업<select id="ag-rea-workflow">' +
      '<option value="managed-artifact">.NET 어셈블리 정보</option><option value="managed-members">.NET 멤버</option><option value="javascript">Electron·JS 앱</option></select></label>' +
      '<button id="ag-rea-run">REA 분석</button><button id="ag-rea-prepare" class="small">REA 근거 준비</button>' +
      '<pre id="ag-rea-result" aria-live="polite"></pre><hr>' +
      '<div id="ag-capabilities" class="hint"></div><label>결과 이름<input id="ag-name" value="project-structure" maxlength="80"></label>' +
      '<label>소스 루트<input id="ag-root" placeholder="프로젝트 경로"></label><button id="ag-pick-root" class="small">폴더 선택</button>' +
      '<label>분석 범위 (루트 상대 경로, 줄마다 한 개)<textarea id="ag-scope" rows="3" placeholder="Source/MyModule\nPackages/manifest.json"></textarea></label>' +
      '<button id="ag-build">선택 범위 AST 분석</button><hr><label>선택한 EXE/DLL<input id="ag-binary-file" readonly></label>' +
      '<button id="ag-pick-binary" class="small">파일 선택</button><label>함수 주소 (선택, 최대 5개)<input id="ag-addresses" placeholder="140001000,140001040"></label>' +
      '<button id="ag-binary">Ghidra 정적 분석 (대체 경로)</button><button id="ag-cancel" class="small">작업 취소 요청</button>' +
      '<p class="hint">파일은 실행하지 않습니다. 디컴파일 결과와 간접 호출은 불완전할 수 있습니다.</p><pre id="ag-progress" aria-live="polite"></pre><hr>' +
      '<select id="ag-graphs"></select><input id="ag-query" placeholder="함수·모듈·경로 검색"><select id="ag-direction"><option value="both">주변 관계</option><option value="upstream">호출하는 쪽</option><option value="downstream">호출받는 쪽</option></select>' +
      '<button id="ag-knowledge" class="small">공통 지식 그래프</button><button id="ag-search">조회</button><button id="ag-architecture" class="small">구조 보기</button><button id="ag-open" class="small">원본 그래프 열기</button>' +
      '<label>경로 출발 노드 ID<input id="ag-from"></label><label>도착 노드 ID<input id="ag-to"></label><button id="ag-path">방향 경로 찾기</button><div id="ag-result"></div><hr>' +
      '<h3>분석 근거로 학습·개발 연결</h3><p class="hint">조회한 노드 중 최대 12개를 선택하세요. 근거 준비·제안 전송은 모델을 호출하지 않습니다.</p>' +
      '<label>목적<select id="ag-purpose"><option value="learning">학습 설명·단계별 연습</option><option value="development">개발 변경 제안</option><option value="modding">패스스루 브리지 제안</option></select></label>' +
      '<label><input type="checkbox" id="ag-include-source"> 선택 위치의 소스·디컴파일 발췌 포함</label>' +
      '<button id="ag-prepare">근거 준비·미리보기</button><button id="ag-check" class="small">근거 최신 여부 확인</button>' +
      '<button id="ag-transfer" class="small">작업 탭에 제안 보내기</button><pre id="ag-evidence" aria-live="polite"></pre>' +
      '<details><summary>분석·모딩 도구 연결 상태</summary><pre id="ag-adapters"></pre></details>' +
      '<button id="ag-probe" class="small">가상 호스트·게스트 IPC 시험</button><pre id="ag-probe-result" aria-live="polite"></pre>';
    el('tab-source').appendChild(panel);
    window.reaTargetUI.mount(panel);
    const invoke = (id, fn) => el(id).addEventListener('click', async () => { try { await fn(); } catch (error) { toast(error.message, true); } });
    invoke('ag-pick-root', async () => { el('ag-root').value = await call(window.hub.analysisGraphPickRoot); });
    invoke('ag-pick-binary', async () => { el('ag-binary-file').value = await call(window.hub.analysisGraphPickBinary); });
    invoke('ag-build', async () => { await call(window.hub.analysisGraphBuild, { name: el('ag-name').value.trim(), root: el('ag-root').value.trim(),
      paths: el('ag-scope').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean) }); toast('구조 분석을 시작했습니다.'); });
    invoke('ag-binary', async () => { await call(window.hub.analysisGraphBinary, { name: el('ag-name').value.trim(), file: el('ag-binary-file').value,
      addresses: el('ag-addresses').value.split(',').map(x => x.trim()).filter(Boolean) }); toast('선택한 파일의 정적 분석을 시작했습니다.'); });
    invoke('ag-cancel', async () => { await call(window.hub.analysisGraphCancel, el('ag-name').value.trim()); toast('취소를 요청했습니다. 종료 결과를 확인하세요.'); });
    invoke('ag-knowledge', async () => { if (!el('ag-graphs').value) throw new Error('분석 결과를 선택하세요.'); await window.HubKnowledgeGraph.open('analysis:' + el('ag-graphs').value); });
    invoke('ag-search', async () => { render(await call(window.hub.analysisGraphQuery, el('ag-graphs').value, el('ag-query').value, { direction: el('ag-direction').value })); });
    invoke('ag-path', async () => { render(await call(window.hub.analysisGraphPath, el('ag-graphs').value, el('ag-from').value, el('ag-to').value)); });
    invoke('ag-open', async () => { await call(window.hub.analysisGraphOpen, el('ag-graphs').value); });
    invoke('ag-architecture', async () => { await call(window.hub.analysisGraphArchitecture, el('ag-graphs').value); });
    invoke('ag-prepare', async () => {
      evidenceId = '';
      const pack = await call(window.hub.analysisContextPrepare, { graph: el('ag-graphs').value,
        nodeIds: [...el('ag-result').querySelectorAll('[data-ag-node]:checked')].map(node => node.value),
        purpose: el('ag-purpose').value, includeSource: el('ag-include-source').checked });
      evidenceId = pack.evidenceId;
      const { localHandoff, ...preview } = pack;
      el('ag-evidence').textContent = JSON.stringify(preview, null, 2);
    });
    invoke('ag-rea-pick', async () => { el('ag-rea-target').value = await call(window.hub.analysisPickReaTarget); });
    invoke('ag-rea-run', async () => {
      reaEvidenceId = ''; el('ag-rea-result').textContent = 'REA 분석 중…';
      const result = await call(window.hub.analysisReaAnalyze, { workflow: el('ag-rea-workflow').value, target: el('ag-rea-target').value.trim() });
      reaEvidenceId = result.evidenceId || '';
      el('ag-rea-result').textContent = JSON.stringify(result, null, 2);
    });
    invoke('ag-rea-prepare', async () => {
      evidenceId = '';
      const pack = await call(window.hub.analysisContextPrepare, { reaEvidenceId, purpose: el('ag-purpose').value, includeSource: el('ag-include-source').checked });
      evidenceId = pack.evidenceId;
      const { localHandoff, ...preview } = pack;
      el('ag-evidence').textContent = JSON.stringify(preview, null, 2);
    });
    invoke('ag-check', async () => { el('ag-evidence').textContent = JSON.stringify(await call(window.hub.analysisContextCheck, evidenceId), null, 2); });
    invoke('ag-transfer', async () => {
      const proposal = await call(window.hub.analysisContextProposal, evidenceId);
      el('aider-project').value = proposal.projectDir; el('aider-files').value = proposal.files.join('\n');
      el('aider-prompt').value = proposal.prompt; el('aider-mode').value = 'ask'; el('aider-dry').checked = true;
      toast('같은 근거 ID의 제안을 Aider 작업 탭(ask · dry run)에 넣었습니다. 실행할 내용과 권한을 확인하세요.');
    });
    invoke('ag-probe', async () => { el('ag-probe-result').textContent = JSON.stringify(await call(window.hub.analysisBridgeProbe), null, 2); });
    el('ag-graphs').addEventListener('change', () => { evidenceId = ''; el('ag-evidence').textContent = ''; el('ag-result').replaceChildren(); });
    for (const id of ['ag-purpose','ag-include-source','ag-result']) el(id).addEventListener('change', () => {
      evidenceId = ''; el('ag-evidence').textContent = '선택이 바뀌었습니다. 근거를 다시 준비하세요.';
    });
    if (window.hub.onAnalysisGraphProgress) window.hub.onAnalysisGraphProgress(async progress => {
      el('ag-progress').textContent = JSON.stringify(progress, null, 2);
      if (['done','deferred','unavailable','error'].includes(progress.phase)) await ui.refresh();
    });
  }
  function render(result) {
    evidenceId = ''; el('ag-evidence').textContent = '';
    const nodes = result.matches || result.nodes || [];
    el('ag-result').innerHTML = (result.warnings || []).map(w => '<p class="hint">' + esc(w) + '</p>').join('') +
      '<p>' + nodes.length + '개 노드 · ' + (result.edges || []).length + '개 관계' + (result.found === false ? ' · 경로 없음' : '') + '</p>' +
      nodes.map(n => '<article><label><input type="checkbox" data-ag-node value="' + esc(n.id) + '"><b>' + esc(n.label || n.id) + '</b></label> <code>' + esc(n.id) + '</code><small> · ' + esc(n.type || '') + ' · ' + esc(n.evidence) + ' · ' + esc(n.source_location || n.source_file || n.binary_address || '근거 위치 미상') + '</small></article>').join('') +
      '<pre>' + esc(JSON.stringify(result.edges || [], null, 2)) + '</pre>' +
      (result.selectedFunctions || []).map(row => '<details><summary>' + esc(row.address) + ' · 선택 함수 흐름 · ' + esc(row.evidence) + '</summary>' +
        '<p class="hint">' + esc(row.note) + '</p><pre>' + esc(JSON.stringify({ blocks: row.blocks, flows: row.flows }, null, 2)) + '</pre><pre>' + esc(row.decompiled || '디컴파일 결과 없음') + '</pre></details>').join('');
  }
  window.analysisGraphUI = ui;
})();

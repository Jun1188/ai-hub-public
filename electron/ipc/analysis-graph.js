'use strict';
const { dialog, shell } = require('electron');
const graph = require('../../src/core/analysis-graph');
async function detailAvailability(format) {
  if (format === 'source') {
    const path = require('path');
    const runtime = await require('../../src/core/analysis-process').detectPython(path.join(__dirname,'../../scripts/analysis_ast.py'));
    return runtime.available ? {engine:'Graphify',available:true} :
      {engine:'Graphify',available:false,reason:'Python·Graphify 소스 분석 런타임이 설치되어 있지 않습니다.'};
  }
  if (format === 'mixed') return {available:false, reason:'혼합 CLR/네이티브 파일은 상세 분석기를 자동 선택하지 않습니다.'};
  const native = format === 'native', engine = native ? 'Ghidra' : 'REA';
  try {
    const state = native ? require('../../src/core/analysis-process').detectGhidra() : require('../../src/core/rea-analysis').installedCli();
    if (state.available) return {engine, available:true};
    const reason = state.reason === 'rea_version_mismatch' ? '설치된 REA 버전이 Hub 지원 버전과 다릅니다.' : engine + ' 분석기가 설치되어 있지 않습니다.';
    return {engine, available:false, reason};
  } catch { return {engine, available:false, reason:engine + ' 설치 파일을 확인할 수 없습니다.'}; }
}
function graphFindings(graph) {
  if (!graph.nodes || !graph.edges) return [];
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const compact = text => String(text || '').replace(/[\r\n\t]/g, ' ').slice(0, 160);
  const findings = [];
  for (const edge of graph.edges) {
    if (edge.relation !== 'calls') continue;
    const caller = byId.get(edge.source), callee = byId.get(edge.target);
    if (!caller || !callee) continue;
    findings.push([compact(caller.label) + ' → ' + compact(callee.label),
      compact(edge.source_location || caller.source_location || caller.binary_address), compact(edge.evidence)].filter(Boolean).join(' · '));
    if (findings.length === 8) break;
  }
  if (findings.length) return findings;
  return graph.nodes.filter(n => ['function','method','class'].includes(n.type)).slice(0, 8)
    .map(n => [compact(n.label), compact(n.source_location || n.binary_address), compact(n.evidence)].filter(Boolean).join(' · '));
}
function register(ctx) {
  const { handle, send, window } = ctx;
  const { makeTargetService, analysisScope, snapshot, imageInfo } = require('../../src/core/rea-target');
  const targets = makeTargetService({ readLink: file => shell.readShortcutLink(file) });
  const previews = new Map(), reports = new Map();
  handle('ag:targetProcesses', () => targets.list());
  handle('ag:targetPreview', async input => {
    const identity = await targets.preview(input);
    if (identity.folder) return identity;
    const id = require('crypto').randomUUID();
    if (previews.size >= 12) previews.delete(previews.keys().next().value);
    previews.set(id, { input, identity, expires: Date.now() + 15 * 60 * 1000 });
    return { id, identity };
  });
  handle('ag:targetAnalyze', async (id, intent) => {
    const scope = analysisScope(intent);
    const candidate = previews.get(id);
    if (!candidate || candidate.expires < Date.now()) throw new Error('선택 시간이 지났습니다. 대상을 다시 선택하세요.');
    previews.delete(id);
    const target = await targets.verify(candidate.input, candidate.identity);
    const fs = require('fs'), path = require('path');
    const evidenceDir = path.join(require('../../src/core/paths').hubDataDir(), 'rea-inputs.local');
    const isolated = await snapshot(target, evidenceDir);
    const copied = await imageInfo(isolated);
    if (copied.sha256 !== target.sha256) throw new Error('검증 사본의 지문이 달라졌습니다.');
    const reportId = require('crypto').randomUUID();
    const report = { id:reportId, scope, engine:'Hub 정적 파일·소스 구조', sha256:copied.sha256, format:copied.format, bytes:copied.bytes,
      observed:copied.structure, detail:await detailAvailability(copied.format), limitations:[copied.format === 'source' ?
        '선택한 소스의 목록·내용 지문만 확인했습니다. 함수·참조 관계는 상세 분석에서 추출하며 런타임 동작은 미확인입니다.' :
        '파일 구성만 직접 관측했습니다. 창 동작·메모리 상태·원본 소스와의 대응은 미확인입니다.'] };
    await fs.promises.writeFile(path.join(evidenceDir,copied.sha256,reportId+'.json'), JSON.stringify(report,null,2), {flag:'wx',mode:0o600});
    if (reports.size >= 12) reports.delete(reports.keys().next().value);
    reports.set(reportId, { isolated, report });
    return report;
  });
  handle('ag:targetDetail', async id => {
    const saved = reports.get(id);
    if (!saved) throw new Error('분석 근거를 다시 준비하세요.');
    const target = await imageInfo(saved.isolated);
    const { scope } = saved.report;
    if (target.sha256 !== saved.report.sha256) throw new Error('검증 사본이 변경되었습니다.');
    const {available, engine, reason} = await detailAvailability(target.format);
    if (!available) return {scope, engine, unavailable:true, reason};
    const source = target.format === 'source';
    const consent = await dialog.showMessageBox(window(), {
      type: 'question', title: '상세 분석기 실행', message: engine + '에 검증 사본 전체를 전달할까요?',
      detail: (source ? '목록에 표시한 소스 사본만 전달합니다. ' : '선택한 범위는 보고서에 적용됩니다. ') + engine + '와 하위 도구는 사본 전체를 읽을 수 있으며, ' +
        '이 실행에서 네트워크 통신을 차단하거나 외부 수신자를 확인하지 않습니다.\n\nSHA-256  ' + target.sha256,
      buttons: ['취소', engine + ' 실행'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (consent.response !== 1) return { scope, engine, canceled: true };
    if (source) {
      const path = require('path'), codebase = target.structure.kind === 'codebase';
      const name = 'rea-source-' + target.sha256.slice(0,20);
      const result = await graph.build({ name, root:codebase?target.path:path.dirname(target.path),
        paths:codebase?target.structure.files.map(row=>row.file):[path.basename(target.path)] });
      return {scope,name,engine:'Graphify',reason:result.reason||result.admission?.reason,
        unavailable:result.unavailable,deferred:result.deferred,nodes:result.nodes?.length,edges:result.edges?.length,warnings:result.warnings,
        findings:graphFindings(result)};
    }
    if (target.format === 'native') {
      const name = 'rea-' + target.sha256.slice(0, 20);
      const result = await graph.binary({ name, file: target.path, expectedSha256: target.sha256 });
      return { scope, name, engine: 'Ghidra', reason: result.reason || result.admission?.reason,
        unavailable: result.unavailable, deferred: result.deferred, nodes: result.nodes?.length, edges: result.edges?.length,
        findings:graphFindings(result) };
    }
    const workflow = target.format === 'managed' ? 'managed-artifact' : 'javascript';
    const result = await require('../../src/core/rea-analysis').analyze({ target: target.path, workflow, expectedSha256: target.sha256 });
    if (result.evidenceId) saved.evidenceId = result.evidenceId;
    return { scope, engine: 'REA', ...result };
  });
  handle('ag:targetLocations', (id, offset) => {
    const saved = reports.get(id);
    if (!saved?.evidenceId) throw new Error('상세 분석 근거를 다시 준비하세요.');
    const {evidence, record} = require('../../src/core/rea-analysis').load(saved.evidenceId);
    if (record.input.sha256 !== saved.report.sha256) throw new Error('상세 분석의 입력 지문이 다릅니다.');
    return require('../../src/core/rea-location-page').locationPage(evidence, offset);
  });
  handle('ag:capabilities', () => graph.capabilities());
  handle('ag:list', () => graph.list());
  handle('ag:adapters', async () => ({ rea: await require('../../src/core/rea-analysis').status(),
    references: require('../../src/core/analysis-adapters').references }));
  handle('ag:reaAnalyze', options => require('../../src/core/rea-analysis').analyze(options || {}));
  handle('ag:contextPrepare', options => require('../../src/core/analysis-context').prepare(options));
  handle('ag:contextCheck', evidenceId => require('../../src/core/analysis-context').check(String(evidenceId)));
  handle('ag:contextProposal', async evidenceId => {
    const context = require('../../src/core/analysis-context'), bundle = context.load(String(evidenceId));
    await context.validateCurrent(bundle);
    return { evidenceId: bundle.evidenceId, purpose: bundle.purpose, projectDir: bundle.projectDir,
      files: [...new Set(bundle.nodes.map(n => n.file).filter(Boolean))], prompt: context.proposal(bundle) };
  });
  handle('ag:bridgeProbe', () => require('../../src/core/passthrough-probe').run());
  handle('ag:query', (name, query, options) => graph.query(String(name), String(query || ''), options || {}));
  handle('ag:path', (name, source, target) => graph.shortestPath(String(name), String(source), String(target)));
  handle('ag:cancel', name => graph.cancel(String(name)));
  function start(kind, options) {
    if (!options || typeof options !== 'object') throw new Error('analysis_options_required');
    graph[kind](options, progress => send('ag:progress', progress))
      .then(result => send('ag:progress', { name: options.name, phase: result.deferred ? 'deferred' : result.unavailable ? 'unavailable' : 'done',
        admission: result.admission, reason: result.reason || result.admission?.reason,
        nodes: result.nodes?.length, edges: result.edges?.length, warnings: result.warnings }))
      .catch(error => send('ag:progress', { name: options.name, phase: 'error', error: String(error.message || error) }));
    return { started: true, name: options.name };
  }
  handle('ag:build', options => start('build', options));
  handle('ag:binary', options => start('binary', options));
  handle('ag:pickRoot', async () => {
    const result = await dialog.showOpenDialog(window(), { title: '구조 분석 소스 루트', properties: ['openDirectory'] });
    return result.canceled ? '' : result.filePaths[0];
  });
  handle('ag:pickBinary', async () => {
    const result = await dialog.showOpenDialog(window(), { title: '정적 분석할 EXE/DLL', properties: ['openFile'], filters: [{ name: 'Binary', extensions: ['exe','dll'] }] });
    return result.canceled ? '' : result.filePaths[0];
  });
  handle('ag:pickReaTarget', async () => {
    const result = await dialog.showOpenDialog(window(), { title: '분석할 바이너리·ASAR·소스 파일 (실행하지 않음)', properties: ['openFile'] });
    return result.canceled ? '' : result.filePaths[0];
  });
  handle('ag:pickReaDirectory', async () => {
    const result = await dialog.showOpenDialog(window(), { title: '애플리케이션·코드베이스 폴더 (후보 선택)', properties: ['openDirectory'] });
    return result.canceled ? '' : result.filePaths[0];
  });
  handle('ag:open', name => shell.openPath(graph.graphPath(String(name))));
  handle('ag:architecture', async name => shell.openPath(await graph.architecture(String(name))));
}
module.exports = { register };

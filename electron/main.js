// Electron main process: hosts the GUI, runs the HTTP MCP hub in-process,
// and bridges the renderer to the core modules over IPC.
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, session } = require('electron');
const path = require('path');
// Windows 알림(원본 갱신 승인 등)은 앱 사용자 모델 ID가 있어야 뜬다 — 설치형과 같은 ID.
const publicProfile = require('../src/core/public-profile');
if (process.platform === 'win32') app.setAppUserModelId(publicProfile.enabled ? publicProfile.appId : 'com.user.ai-allinone-hub');

require('./user-profile');

const config = require('../src/core/config');
if (!publicProfile.enabled && (process.argv.includes('--lite') || require('fs').existsSync(path.join(__dirname, '..', 'resources', 'lite-profile.txt')))) {
  config.setLocalOnly('hub.profile', 'lite');
  config.setLocalOnly('hub.autoStart', false);
  config.setLocalOnly('localRuntimes.automaticPreparation', false);
}
if (process.env.AIHUB_SELFTEST) config.update({ hub: { profile: 'lite', enabled: false, autoStart: false }, share: { enabled: false } });
const lmstudio = require('../src/core/lmstudio');
const delegator = require('../src/core/delegator');
const gpufit = require('../src/core/gpufit');
const registrar = require('../src/core/registrar');
const downstream = require('../src/core/downstream');
const stats = require('../src/core/stats');
const share = require('../src/core/share');
const autopilot = require('../src/core/autopilot');
const pipeline = require('../src/core/pipeline');
const connectors = require('../src/core/connectors');
const { detectTargets, hubDataDir, appRoot, isPackaged } = require('../src/core/paths');
const { startHttpHub } = require('../src/mcp/http-entry');
const authcheck = require('../src/mcp/authcheck');

let mainWindow = null;
let httpServer = null;
let tray = null;
let isQuitting = false;
const ICON_PATH = path.join(appRoot(), 'build', 'icon.png');

/** 렌더러로 이벤트를 보낸다. 창이 닫혀 있으면 조용히 무시된다. */
function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0f1115',
    title: publicProfile.enabled ? 'AI Hub Lite' : 'ai-hub',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs webUtils for drag&drop paths
    },
  });
  if (publicProfile.enabled) require('./public-validation').attach({app,window:mainWindow,config});
  mainWindow.removeMenu();
  // Close-to-tray: keep the hub serving MCP clients in the background.
  mainWindow.on('close', (e) => {
    if (!isQuitting && config.load().hub.closeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  // 렌더러 오류는 항상 메인 프로세스 로그로 넘긴다. ui/ 는 번들러 없이 <script>를
  // 순서대로 로드하므로 파일 하나가 SyntaxError로 죽어도 창은 멀쩡히 뜨고 그 탭만
  // 조용히 동작을 멈춘다. 그걸 눈에 보이게 만든다. (0=verbose 1=info 2=warn 3=error)
  mainWindow.webContents.on('console-message', (...args) => {
    // Electron 36+는 details 객체 하나를 넘긴다. 두 형태를 모두 받는다.
    const d = typeof args[0] === 'object' && 'level' in args[0]
      ? args[0]
      : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
    const isError = d.level === 3 || d.level === 'error' || d.level === 2 || d.level === 'warning';
    if (!isError && !process.env.AIHUB_DEBUG) return;
    const where = d.sourceId ? ` (${d.sourceId}:${d.lineNumber})` : '';
    console.error(`[renderer:${d.level}] ${d.message}${where}`);
  });
  // 렌더러 스모크 테스트: 모든 탭을 눌러보고 결과를 JSON으로 남기고 종료한다.
  // ui/ 는 <script>를 순서대로 로드하므로 파일 하나가 SyntaxError로 죽어도 창은
  // 정상적으로 뜬다. 그 탭의 함수가 정의됐는지 확인하는 게 유일한 확실한 검증이다.
  if (process.env.AIHUB_SELFTEST) {
    // 각 탭 파일이 정의해야 하는 전역들. 하나라도 없으면 그 파일이 로드되지 않았거나
    // 파싱 단계에서 죽었다는 뜻이다.
    const REQUIRED_GLOBALS = [
      '$', 'toast', 'esc', 'call', 'bindDataAction', 'applyUiMode',
      'refreshDashboard', 'refreshAutopilot', 'refreshMcp', 'refreshSkills', 'refreshSettings',
      'refreshDelegate', 'refreshHistory', 'refreshSource', 'refreshMemory', 'refreshProjects',
      'refreshPipelines', 'refreshInstalled', 'refreshIdxList', 'refreshFtList',
      'refreshRenderpipe', 'refreshPipeHistory', 'refreshProjectTools', 'renderShare', 'renderUpdate',
      'refreshConnectors', 'refreshAgyStatus',
    ];
    // CSP(script-src 'self')가 eval을 막으므로 이름을 문자열로 넘겨 검사할 수 없다.
    // typeof 검사문을 미리 펼쳐 정적 코드로 만든다.
    const typeofChecks = REQUIRED_GLOBALS
      .map((n) => `if (typeof ${n} !== 'function') missing.push('${n}');`)
      .join('\n');

    mainWindow.webContents.once('did-finish-load', async () => {
      let report;
      try {
        // worldId 0 = 페이지의 메인 월드. contextIsolation이 켜져 있으면 그냥
        // executeJavaScript는 preload와 같은 격리 월드에서 돌아 페이지 전역이 안 보인다.
        report = await mainWindow.webContents.executeJavaScriptInIsolatedWorld(0, [{ code: `(async () => {
          const errors = [];
          window.addEventListener('error', (e) => errors.push(String(e.message)));
          window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + e.reason));
          const missing = [];
          ${typeofChecks}
          const tabs = [...document.querySelectorAll('#tabs button')].map((b) => b.dataset.tab);
          for (const t of tabs) {
            document.querySelector('#tabs button[data-tab="' + t + '"]').click();
            await new Promise((r) => setTimeout(r, 350));
          }
          const shown = tabs.filter((t) => document.getElementById('tab-' + t));
          const features = {};
          try {
            const status = await call(window.hub.status); features.version = status.version; features.share = status.share;
            features.hubRunning = status.hub.running;
            await refreshRepositoryToggle();
            const toggle = document.getElementById('set-repo-update');
            const check = document.getElementById('set-repo-check');
            const caption = document.getElementById('set-repo-update-info');
            const approval = await call(window.hub.repositoryAutoUpdateGet);
            features.repositoryToggle = { bridged: typeof window.hub.repositoryAutoUpdateSet === 'function',
              present: !!toggle && !!check && !!caption, enabled: approval.enabled, checked: toggle.checked,
              editable: !toggle.disabled, checkDisabled: check.disabled, caption: caption.textContent };
            if (!features.repositoryToggle.bridged || !features.repositoryToggle.present || approval.blocked
              || toggle.checked !== approval.enabled || toggle.disabled || check.disabled === approval.enabled
              || !caption.textContent.trim()) errors.push('device update toggle differs from stored approval');
            const update = await call(window.hub.updateCheck);
            renderUpdate(update);
            features.update = { status: update.status, enrollVisible: !document.getElementById('update-enroll').hidden,
              applyVisible: document.getElementById('update-install').style.display !== 'none',
              bridge: typeof window.hub.updateEnroll === 'function' && typeof window.hub.updateApply === 'function' };
            if (!features.update.bridge || features.update.enrollVisible !== (update.status === 'disabled')
                || features.update.applyVisible !== update.available) errors.push('update controls disagree with the repository status');
            features.credentialMetadata = await call(window.hub.localCredentialStatus);
            features.analysis = await call(window.hub.analysisGraphCapabilities);
            features.knowledgeUI = typeof window.HubKnowledgeGraph?.refresh === 'function';
            const skills = await call(window.hub.knowledgeQuery, { key: 'skills:repository', query: 'setup.md' });
            const documents = await call(window.hub.knowledgeQuery, { key: 'repository:documents', query: 'academy-guide' });
            features.knowledge = { skills: { root: skills.root, nodes: skills.nodes.length, warnings: skills.warnings },
              documents: { nodes: documents.nodes.length, warnings: documents.warnings } };
          } catch (error) { errors.push('feature audit: ' + error.message); }
          return { tabs, shown, missing, errors, features };
        })()` }]);
      } catch (err) {
        report = { fatal: String((err && err.message) || err) };
      }
      require('fs').writeFileSync(process.env.AIHUB_SELFTEST, JSON.stringify(report, null, 2), 'utf8');
      isQuitting = true;
      if (report.fatal || report.errors?.length || report.missing?.length) app.exit(1);
      else app.quit();
    });
  }
  if (process.env.AIHUB_SCREENSHOT) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (['dashboard','source','aider','settings'].includes(process.env.AIHUB_TAB)) {
            await mainWindow.webContents.executeJavaScript(
              `document.querySelector('#tabs button[data-tab="${process.env.AIHUB_TAB}"]').click()`
            );
            await new Promise((r) => setTimeout(r, 1200));
          }
          if (['ag-panel'].includes(process.env.AIHUB_CAPTURE_ID)) {
            await mainWindow.webContents.executeJavaScript('document.getElementById('+JSON.stringify(process.env.AIHUB_CAPTURE_ID)+')?.scrollIntoView({block:"start"})');
            await new Promise(resolve=>setTimeout(resolve,300));
          }
          const img = await mainWindow.webContents.capturePage();
          require('fs').writeFileSync(process.env.AIHUB_SCREENSHOT, img.toPNG());
          console.log('[screenshot saved]');
          if (process.env.AIHUB_SCREENSHOT_EXIT === '1') { isQuitting = true; app.quit(); }
        } catch (e) {
          console.error('[screenshot failed]', e);
        }
      }, 2500);
    });
  }
  mainWindow.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
}

let hubError = null; // last bind/start failure, surfaced in status

/** Human-readable reason + fix for a hub start failure. */
function describeHubError(err) {
  const port = config.load().hub.httpPort;
  const code = err && err.code;
  if (code === 'EADDRINUSE') {
    return `포트 ${port}을 다른 프로그램이 이미 사용 중입니다. 이 앱이 이미 실행 중(트레이 확인)이거나, 설정에서 다른 포트로 바꾼 뒤 "저장 후 허브 재시작"을 누르세요.`;
  }
  if (code === 'EACCES') {
    return `포트 ${port} 사용 권한이 없습니다. 설정에서 1024보다 큰 다른 포트를 사용하세요.`;
  }
  return String((err && err.message) || err);
}

function startHub() {
  hubError = null;
  // Self-tests set hub.enabled=false. Ignoring it let a private-profile instance (other token) take port 8763 from a
  // restarting Hub, which then stayed up without its MCP server (2026-10-17).
  if (config.load().hub.enabled === false) return;
  try {
    httpServer = startHttpHub({});
    httpServer.on('error', (err) => {
      httpServer = null;
      hubError = describeHubError(err);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('hub-error', hubError);
    });
    httpServer.on('listening', () => { verifyHubAuth().catch(() => {}); });
  } catch (err) {
    httpServer = null;
    hubError = describeHubError(err);
  }
}

// 허브가 떠 있는데 인증만 어긋나면 어디에도 안 보인다 — 대시보드는 "실행 중",
// /health는 {ok:true}인데 등록된 AI 도구는 전부 401을 받는다(2026-07-28 실제 사고).
// 주기적으로 진짜 요청을 넣어 확인하고, 어긋났으면 캐시 갱신 → 허브 재시작 순으로
// 스스로 고친다. 사유와 조치는 대시보드 status에 실린다.
let hubAuth = { ok: true, reason: '', repaired: null, message: '' };
let lastAuthRestartAt = 0;
const AUTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
// 재시작으로도 안 고쳐지는 원인(포트 충돌 등)이면 5분마다 재시작을 반복하게 된다.
// 자동 재시작은 이 간격에 한 번까지만.
const AUTH_RESTART_COOLDOWN_MS = 30 * 60 * 1000;

async function verifyHubAuth() {
  if (!httpServer || !httpServer.listening) return;
  const canRestart = Date.now() - lastAuthRestartAt > AUTH_RESTART_COOLDOWN_MS;
  const before = hubAuth.ok;
  hubAuth = await authcheck.checkAuth({
    port: config.load().hub.httpPort,
    restart: canRestart ? async () => {
      lastAuthRestartAt = Date.now();
      await new Promise((r) => httpServer.close(r));
      httpServer = null;
      startHub();
      await new Promise((r) => setTimeout(r, 300));
    } : null,
  });
  if (hubAuth.repaired) console.error(`[ai-hub] hub auth self-check: ${hubAuth.repaired} — ${hubAuth.message}`);
  // 상태가 바뀐 순간에만 알린다(정상 → 고장, 고장 → 정상).
  if (before !== hubAuth.ok || hubAuth.repaired) sendToWindow('hub-auth', hubAuth);
}

// GPU에 안 들어가는 모델은 오류를 내지 않는다 — LM Studio가 컨텍스트를 조용히 깎고
// 남은 레이어를 CPU로 넘긴다(gpufit.js에 실측). 느려진 게 모델 탓처럼 보이므로
// 주기적으로 재서 대시보드에 싣고, 여러 모델이 겹쳐 넘친 경우에는 놀고 있는 쪽을
// 내려 자리를 만든다. 혼자서도 넘치는 경우(oversized)에는 진단만 한다 — 내려서
// 고쳐지지 않고, 사용자가 쓰려던 모델을 마음대로 내리면 안 된다.
const GPU_CHECK_INTERVAL_MS = 5 * 60 * 1000;

async function verifyGpuFit() {
  // offload·autopilot 판단이 캐시만 읽을 수 있도록 전원·무거운 앱·모델 크기를 같은 주기로 채운다.
  require('../src/core/hardware-optimizer').refresh().catch(() => {});
  const r = await gpufit.makeRoom({ keep: gpufit.lastRouted() });
  if (r.acted) {
    console.error(`[ai-hub] GPU fit: unloaded ${r.unloaded.join(', ')} — ${r.assessment.message}`);
    sendToWindow('gpu-fit', gpufit.lastAssessment(gpufit.lastRouted()));
  }
}

// ---- IPC: all handlers wrap results as {ok, data|error} -------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      if (!publicProfile.allowed(channel)) throw new Error('공개 경량판에서 자동 등록·동기화·내부 배포는 제공하지 않습니다.');
      return { ok: true, data: await require('./ipc/register-handlers').dispatch(channel, _event, () => mainWindow, fn, args) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

handle('status', async () => {
  const cfg = config.load();
  let models = [];
  let alive = false;
  try {
    if (publicProfile.enabled && !cfg.lmstudio.enabled) throw new Error('External model connection disabled');
    models = await lmstudio.listModelsDetailed();
    alive = true;
  } catch { /* LM Studio down */ }
  return {
    lmstudio: {
      url: cfg.lmstudio.baseUrl,
      alive,
      models: models.map((m) => ({ id: m.id, tier: delegator.tierOf(m.id), state: m.state, avgMs: stats.latencyOf(m.id) })),
      // 모델이 GPU에 들어가는지. 추가 I/O 없음 — verifyGpuFit이 갱신해 둔 값이다.
      gpu: gpufit.lastAssessment(gpufit.lastRouted()),
    },
    hub: {
      running: Boolean(httpServer && httpServer.listening),
      port: cfg.hub.httpPort,
      requireAuth: cfg.hub.requireAuth,
      lanAccess: Boolean(cfg.hub.lanAccess),
      error: hubError,
      // 떠 있어도 인증이 막혀 있으면 클라이언트에겐 죽은 것과 같다. 주기 점검 결과를
      // 그대로 싣는다(추가 I/O 없음 — verifyHubAuth가 갱신해 둔 값).
      authOk: hubAuth.ok,
      authError: hubAuth.ok ? null : hubAuth.message,
      url: `http://127.0.0.1:${cfg.hub.httpPort}/mcp`,
    },
    targets: publicProfile.enabled ? [] : registrar.status(),
    dataDir: hubDataDir(),
    appRoot: appRoot(),
    version: app.getVersion(),
    share: share.status(),
    profile: require('../src/core/device-profile').describe(cfg),
  };
});

handle('config:get', () => config.load());
handle('config:update', async (partial) => {
  const allowed = {};
  if (partial.lmstudio) allowed.lmstudio = { baseUrl: String(partial.lmstudio.baseUrl || 'http://127.0.0.1:1234') };
  if (partial.hub) {
    allowed.hub = {};
    if (publicProfile.enabled && typeof partial.hub.enabled === 'boolean') allowed.hub.enabled = partial.hub.enabled;
    if (partial.hub.httpPort) allowed.hub.httpPort = Math.max(1024, Math.min(65535, Number(partial.hub.httpPort)));
    for (const k of ['requireAuth', 'closeToTray', 'autoStart', 'lanAccess']) {
      if (typeof partial.hub[k] === 'boolean') allowed.hub[k] = partial.hub[k];
    }
    if (['full', 'lite'].includes(partial.hub.profile)) allowed.hub.profile = partial.hub.profile; // applies after relaunch
    const liteFeatures = require('../src/core/feature-profile').sanitize(partial.hub.liteFeatures);
    if (liteFeatures) allowed.hub.liteFeatures = liteFeatures;
  }
  if (partial.delegation) {
    allowed.delegation = {};
    for (const k of ['defaultModel', 'userGlobalPrompt']) {
      if (typeof partial.delegation[k] === 'string') allowed.delegation[k] = partial.delegation[k];
    }
    for (const k of ['defaultTemperature', 'defaultMaxTokens']) {
      if (typeof partial.delegation[k] === 'number') allowed.delegation[k] = partial.delegation[k];
    }
    if (partial.delegation.modelTiers && typeof partial.delegation.modelTiers === 'object') {
      const tiers = {};
      for (const [m, t] of Object.entries(partial.delegation.modelTiers)) {
        if (['high', 'medium', 'low', 'none'].includes(t)) tiers[m] = t;
      }
      allowed.delegation.modelTiers = tiers;
    }
  }
  if (partial.update) {
    allowed.update = {};
    if (typeof partial.update.autoCheck === 'boolean') allowed.update.autoCheck = partial.update.autoCheck;
  }
  if (partial.share) {
    allowed.share = {};
    if (typeof partial.share.enabled === 'boolean') allowed.share.enabled = partial.share.enabled;
    if (partial.share.intervalMin) {
      allowed.share.intervalMin = Math.max(1, Math.min(240, Number(partial.share.intervalMin)));
    }
  }
  const updated = await config.updateWithRetry(allowed);
  applyAutoStart();
  return updated;
});

handle('history:list', (limit) => stats.history(Number(limit) || 100));
handle('history:summary', () => stats.summary());

handle('ui:devMode', (on) => config.update({ ui: { devMode: Boolean(on) } }));

// 도메인별 핸들러(메모리·자동화·AI프로젝트·소스분석·게임프로젝트·MCP)는 electron/ipc/ 로
// 나눠 두었다. 여기 남은 것은 창·트레이·HTTP 허브·업데이트처럼 앱 수명주기 상태에
// 얽힌 핸들러뿐이다.
require('./ipc/register-handlers').registerAll({
  handle,
  send: (channel, payload) => sendToWindow(channel, payload),
  window: () => mainWindow,
});

handle('share:status', () => share.status());
handle('share:syncNow', () => share.syncNow(config.load().share.dir));
handle('share:detect', () => share.autodetectRoot());
handle('share:setDir', async (dir) => {
  const updated = await config.updateWithRetry({ share: { dir: String(dir || '') } });
  share.resetRoot();
  share.syncNow(updated.share.dir); // 비동기 — 응답을 붙잡지 않는다
  return updated;
});
handle('share:pickDir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '컴퓨터 간 공유 폴더 선택 (Google Drive 내 드라이브 권장)',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});

function appIsBusy() {
  try {
    if (awesome?.busy() || pipeline.activeCount() > 0) return true;
    if (require('../src/core/offload').active().length > 0) return true;
  } catch { /* Modules may still be starting. */ }
  return false;
}

async function checkAndMaybeUpdate() {
  const policy = require('../src/core/repository-update').manualPolicy();
  if (policy === 'invalid') throw new Error('이 PC의 수동 동기화 정책 파일을 확인해 주세요.');
  if (policy === 'manual') return manualController().check();
  const result = await require('../src/core/repository-update').sync({
    lite: require('../src/core/device-profile').lite(),
  });
  const info = {
    ...result, current: app.getVersion(), available: result.status === 'pending',
    error: ['up-to-date', 'local-newer', 'pending'].includes(result.status) ? '' : result.message,
  };
  if (info.available) sendToWindow('update-available', info);
  return info;
}

handle('update:check', checkAndMaybeUpdate);
let enrollingHub = false;
handle('update:enroll', async () => {
  if (enrollingHub) throw new Error('자동 갱신 승인을 확인하고 있습니다.');
  enrollingHub = true;
  try {
    const updater = require('../src/core/repository-update');
    const approval = updater.approval();
    if (approval.status === 'blocked') throw new Error(approval.message);
    if (approval.status !== 'disabled') return checkAndMaybeUpdate();
    const clone = config.load().sharedContext?.repoPath || require('../src/core/shared-agent-context').manifest()?.sourceRepository
      || require('../src/core/shared-repo-memory').repoRoot();
    if (!clone) throw new Error('메모리 탭에서 공유 저장소 clone 경로를 먼저 지정하세요.');
    const repository = await require('fs').promises.realpath(clone);
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'question', title: 'Hub 자동 갱신', message: '이 기기의 Hub 소스 자동 갱신을 켤까요?',
      detail: `현재 앱: ${appRoot()}\n저장소: ${repository}\n원격: your-org/your-shared-context (main)\n\n${updater.manualPolicy() === 'manual' ? '원격 변경은 자동 확인하고 앱·설치본 동기화를 누르면 적용합니다.' : '다음 시작 때 백업 후 적용합니다.'} 패널 갱신은 별도 등록할 수 있습니다.`,
      buttons: ['취소', 'Hub 자동 갱신 켜기'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (confirmation.response !== 1) return null;
    const saved = await updater.enroll(repository);
    if (saved.status !== 'not-checked') throw new Error(saved.message);
    return await checkAndMaybeUpdate();
  } finally { enrollingHub = false; }
});
// Keep the existing IPC name for older renderers, but never accept a Setup path.
handle('update:install', checkAndMaybeUpdate);
handle('update:defer', () => ({ deferred: true, onQuit: false }));
let applyingHub = false;
handle('update:apply', async () => {
  if (require('../src/core/repository-update').manualPolicy() !== 'standard')
    throw new Error('이 PC에서는 앱·설치본 동기화 버튼을 사용하세요.');
  if (applyingHub || appIsBusy()) throw new Error('실행 중인 작업이 끝난 뒤 적용하세요.');
  applyingHub = true;
  try {
    const cfg = config.load();
    const result = await require('../src/core/repository-update').startAfterExit({
      guiPid: process.pid, exe: process.execPath, packaged: isPackaged(), lite: require('../src/core/device-profile').lite(),
      port: cfg.hub.enabled === false ? 0 : cfg.hub.httpPort, pointerPath: path.join(hubDataDir(), 'app-root.json'),
    });
    if (appIsBusy()) throw new Error('새 작업이 시작되어 종료를 보류합니다. 작업 완료 후 다시 확인하세요.');
    setTimeout(() => { isQuitting = true; app.quit(); }, 300);
    return result;
  } catch (error) { applyingHub = false; throw error; }
});

let manualUpdates, awesome;
function manualController() {
  if (!manualUpdates) manualUpdates = require('./app-updates').create({
    app, packaged: isPackaged, busy: appIsBusy,
    shareRoot: async () => share.status().root || config.load().share.dir || await share.autodetectRoot(),
    onState: state => sendToWindow('update-sync-state', state),
    onCheck: info => sendToWindow('update-checked', info),
    port: () => config.load().hub.enabled === false ? 0 : config.load().hub.httpPort,
    quit: () => { isQuitting = true; app.quit(); },
  });
  return manualUpdates;
}
handle('update:syncStatus', () => {
  const mode = require('../src/core/repository-update').manualPolicy();
  return { mode, ...(mode === 'manual' ? manualController().status() : {}) };
});
handle('update:sync', () => manualController().begin());

// Every URL another AI can use to reach this hub (localhost + LAN addresses).
handle('net:urls', () => {
  const cfg = config.load();
  const port = cfg.hub.httpPort;
  const urls = [{ label: '이 컴퓨터', url: `http://127.0.0.1:${port}/mcp` }];
  if (cfg.hub.lanAccess) {
    const os = require('os');
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) urls.push({ label: `LAN (${name})`, url: `http://${a.address}:${port}/mcp` });
      }
    }
  }
  return { urls, lanAccess: Boolean(cfg.hub.lanAccess), requireAuth: cfg.hub.requireAuth || cfg.hub.lanAccess, token: cfg.hub.authToken };
});

handle('hub:restart', async () => {
  if (httpServer) {
    await new Promise((r) => httpServer.close(r));
    httpServer = null;
  }
  startHub();
  await new Promise((r) => setTimeout(r, 300));
  return { running: Boolean(httpServer && httpServer.listening) };
});

// 소스 overlay를 적용한 뒤 새 코드로 다시 띄운다. 작업 중이면 자동 설치와 같은 기준으로 거절한다.
handle('app:relaunch', () => {
  if (appIsBusy()) throw new Error('실행 중인 파이프라인·offload 작업이 끝난 뒤 다시 시작하세요.');
  setTimeout(() => { app.relaunch(); isQuitting = true; app.quit(); }, 300);
  return { relaunching: true };
});

handle('targets:list', () => detectTargets());
handle('openPath', (p) => {
  // Only allow opening known safe locations, not arbitrary paths from the UI.
  // 경계 비교는 구분자까지 포함해서 (…\hub 가 …\hub-evil 을 허용하지 않게),
  // Windows 경로라 대소문자 무시.
  const allowedRoots = [hubDataDir(), appRoot(), ...detectTargets().map((t) => path.dirname(t.configPath))];
  const resolved = path.resolve(String(p)).toLowerCase();
  const allowed = allowedRoots.some((root) => {
    const r = path.resolve(root).toLowerCase();
    return resolved === r || resolved.startsWith(r + path.sep);
  });
  if (!allowed) throw new Error('Opening this path is not allowed.');
  return shell.openPath(path.resolve(String(p)));
});

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function createTray() {
  const img = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('ai-hub');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '허브 열기', click: showWindow },
      { type: 'separator' },
      {
        label: '종료',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('double-click', showWindow);
}

function applyAutoStart() {
  // Login items only make sense for the installed build, not `electron .` dev runs. A self-test runs with an
  // isolated profile whose defaults must not overwrite the user's real login item.
  if (!isPackaged() || process.env.AIHUB_SELFTEST) return;
  app.setLoginItemSettings({
    openAtLogin: Boolean(config.load().hub.autoStart),
    path: process.execPath,
  });
}

/**
 * 버전이 바뀐 첫 실행이면 렌더러 캐시를 비운다.
 *
 * 왜: UI를 file:// 로 여는데도 Chromium은 userData(%APPDATA%\ai-hub)의
 * Cache/Code Cache에 컴파일 산출물을 남기고, NSIS 설치는 userData를 건드리지 않는다.
 * 그래서 새 버전을 설치해도 이전 설치본의 캐시가 살아남아 화면이 옛 버전처럼
 * 보일 수 있다(2026-08 데스크탑에서 실제 발생). 설치 시점이 아니라 앱의 첫 실행에서
 * 지우는 이유: 대화·설정은 남기고 캐시만 골라 지울 수 있는 건 앱 자신뿐이다.
 */
async function purgeRendererCacheOnVersionChange() {
  const fs = require('fs');
  const marker = path.join(app.getPath('userData'), 'last-run-version.txt');
  const current = app.getVersion();
  let previous = '';
  try { previous = fs.readFileSync(marker, 'utf8').trim(); } catch { /* 첫 실행 */ }
  if (previous === current) return;
  try {
    const work = Promise.all([
      session.defaultSession.clearCache(),
      session.defaultSession.clearCodeCaches({}),
    ]);
    // 캐시 비우기가 늦어도 창 표시를 2초 넘게 막지 않는다.
    await Promise.race([work, new Promise((resolve) => setTimeout(resolve, 2000))]);
  } catch { /* 캐시 정리는 best-effort */ }
  try { fs.writeFileSync(marker, current, 'utf8'); } catch { /* 다음 실행에 다시 시도 */ }
}

// Single instance: the hub owns a TCP port and the tray icon, so a second
// copy could only ever fail to bind and show "허브 중지됨". Hand the launch to
// the running instance (raise its window) and exit instead.
const gotSingleInstanceLock = global.aihubStartupOwnsInstanceLock || app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
    if (!publicProfile.enabled) require('../src/core/repository-update').sync({ lite: require('../src/core/device-profile').lite() }).catch(() => {});
  });

  app.whenReady().then(async () => {
    await purgeRendererCacheOnVersionChange();
    // Codex 패널 플러그인이 경로 설정 없이 이 PC의 Hub를 찾도록 실행 위치를 남긴다(기기 전용).
    require('../src/core/app-root-pointer').record({ appRoot: appRoot(), version: app.getVersion(), packaged: isPackaged() });
    // 조립 루트: 자격 증명 브로커(platform)와 키 이전이 쓸 API 연결 저장소(integration)를 여기서 넣는다.
    const connections = () => require('../src/core/api-connections').instance();
    require('../src/core/credential-broker').useConnections(connections);
    const migration = publicProfile.enabled ? {failed: []} : require('../src/core/credential-migration').run({ store: connections });
    if (migration.failed.length) console.error('[credentials] Migration deferred for ' + migration.failed.length + ' records; broker remains closed for invalid records');
    require('./app-lifecycle').install({ app, busy: () => applyingHub || Boolean(manualUpdates?.busy()) || appIsBusy(),
      server: () => httpServer, check: checkAndMaybeUpdate, quit: () => { isQuitting = true; app.quit(); } });
    startHub();
    if (!publicProfile.enabled) {
    const club = require('../src/core/club-materials/hub-service.cjs').instance();
    club.start().catch(() => console.error('[club-materials] Saved Gateway could not start; check External Connections.'));
    app.on('before-quit', event => { if (!event.defaultPrevented) { try { club.stop(); } catch {} } });
    awesome = require('../src/core/club-materials/awesome-auto.cjs').start({
      dataDir: require('../src/core/paths').hubDataDir(), connections: connections(),
      broker: require('../src/core/credential-broker') });
    app.on('before-quit', event => { if (!event.defaultPrevented) awesome.stop(); });
    }
    createWindow();
    createTray();
    applyAutoStart();
    const profile = require('../src/core/device-profile'), lite = profile.lite();
    if (!lite) autopilot.start(); // ticks only act when config.autopilot.enabled; the lite profile never schedules them

    // 외부 AI 도구가 쓰는 CLI 브리지를 로컬 디스크에 최신본으로 깔아 둔다.
    // 실패해도 앱 동작에는 영향이 없다(그 도구들이 옛 사본을 계속 쓸 뿐).
    try {
      if (!publicProfile.enabled) connectors.install();
    } catch { /* best-effort */ }
    // 다른 컴퓨터에서 설정한 다운스트림 서버의 기기 전용 인증정보(headers/env)를
    // 이 컴퓨터의 AI 도구 설정에서 찾아 채운다. 공유 설정에는 시크릿이 실리지 않으므로
    // 새 컴퓨터에는 골격만 도착한다 — 손입력 없이 바로 쓰게 하려는 것.
    try {
      const r = publicProfile.enabled ? {filled: []} : downstream.autofillLocalSecrets();
      if (r.filled.length) console.error(`[ai-hub] 인증정보 자동 감지 ${r.filled.length}건`);
    } catch { /* best-effort */ }
    // Best-effort: re-establish downstream connections that dropped unexpectedly.
    setInterval(() => downstream.reconnectDropped().catch(() => {}), lite ? profile.LITE.reconnectMs : 30000);
    // 허브가 떠 있는데 인증만 막힌 상태를 눈에 보이게 만든다(verifyHubAuth 주석 참고).
    setInterval(() => { verifyHubAuth().catch(() => {}); }, AUTH_CHECK_INTERVAL_MS).unref?.();
    // GPU에 안 들어가는 모델을 재고, 겹쳐 넘쳤으면 자리를 만든다(verifyGpuFit 주석 참고).
    if (!lite) { // the lite profile runs no local models, so it skips hardware/GPU polling
      // Continuous per-process record (one below-normal sampler, ~0.1 % CPU) for the session.
      require('../src/core/telemetry').keepRunning();
      verifyGpuFit().catch(() => {});
      setInterval(() => { verifyGpuFit().catch(() => {}); }, GPU_CHECK_INTERVAL_MS).unref?.();
    }
    if (!publicProfile.enabled) require('../src/core/rsi/background').start({ lite }); // 거버너·캐시 GC·Obsidian 감시·포크 점검(src/core/rsi/background.js)

    // 컴퓨터 간 데이터 공유. 전부 비동기라 창 표시를 지연시키지 않고,
    // 공유 폴더가 없거나 Drive가 멈춰 있어도 앱은 로컬 데이터로 정상 동작한다.
    const cfg = config.load();
    if (!publicProfile.enabled && cfg.share.enabled) {
      share.start({
        configuredDir: cfg.share.dir,
        intervalMs: Math.max(lite ? profile.LITE.shareIntervalMin : 1, Number(cfg.share.intervalMin) || 5) * 60 * 1000,
        onSharedChange: () => {
          // 다른 컴퓨터에서 바뀐 설정이 들어왔으면 다시 읽어 GUI에 알린다.
          config.reload();
          sendToWindow('share-changed', share.status());
        },
      });
    }
    // 새 버전 확인(공유 폴더 release/latest.json + 공유 저장소 main의 overlay 버전). 실패해도 조용히 넘어간다.
    if (!publicProfile.enabled && cfg.update.autoCheck) {
      const runCheck = () => checkAndMaybeUpdate().catch(() => {});
      setTimeout(runCheck, 8000).unref?.();
      const everyMs = Math.max(5, Number(cfg.update.checkIntervalMin) || 60) * 60 * 1000;
      setInterval(runCheck, everyMs).unref?.();
    }
    if (require('../src/core/repository-update').manualPolicy() === 'manual')
      manualController().resume().catch(error => sendToWindow('update-sync-state', { phase: 'blocked', message: error.message }));
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', event => {
  if (manualUpdates?.busy()) { event.preventDefault(); return; }
  isQuitting = true;
  require('../src/core/rsi/background').stop().catch(() => {});
});

app.on('window-all-closed', async () => {
  // Window closing normally hides to tray (handled in 'close'); reaching here
  // means tray mode is off or the app is quitting.
  if (!config.load().hub.closeToTray || isQuitting) {
    await downstream.closeAll().catch(() => {});
    if (httpServer) httpServer.close();
    app.quit();
  }
});

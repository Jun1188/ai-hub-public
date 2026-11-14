'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

let pending = null;
let last = initialStatus();
function initialStatus(includeTarget = false) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8').replace(/^\uFEFF/, ''));
    if (settings?.schemaVersion !== 1 || typeof settings.enabled !== 'boolean') {
      return { status: 'blocked', message: '이 PC의 자동 갱신 승인 파일 형식을 확인하세요.' };
    }
    return settings.enabled
      ? { status: 'not-checked', message: '저장소 자동 갱신이 승인되었습니다. 업데이트 확인 대기 중입니다.',
        ...(includeTarget ? { settings } : {}) }
      : { status: 'disabled', message: '저장소 자동 갱신이 승인되지 않았습니다.' };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'disabled', message: '이 PC의 저장소 자동 갱신이 꺼져 있습니다.' };
    return { status: 'blocked', message: '자동 갱신 승인 파일을 읽지 못했습니다. 파일 형식과 권한을 확인해 주세요.' };
  }
}
function settingsPath() {
  if (require('./public-profile').enabled) return path.join(require('./paths').hubDataDir(), 'repository-update.local.json');
  // Do not load app modules before the cold-start overlay has been applied.
  let base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'win32' && base.includes('LocalCache\\Roaming')) base = path.join(os.homedir(), 'AppData', 'Roaming');
  const canonical = path.join(base, 'ai-hub'), legacy = path.join(base, 'ai-allinone-hub');
  return path.join(!fs.existsSync(canonical) && fs.existsSync(legacy) ? legacy : canonical, 'repository-update.local.json');
}
// This device-only policy is outside the shared configuration and application tree.
// A damaged opt-in must not silently turn cold-start application back on.
function manualPolicy() {
  const file = path.join(path.dirname(settingsPath()), 'manual-sync-policy.local.json');
  try {
    const policy = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return policy?.mode === 'manual' ? 'manual' : 'invalid';
  } catch (error) {
    return error.code === 'ENOENT' ? 'standard' : 'invalid';
  }
}
function invoke(command, args) {
  return new Promise(resolve => execFile(command, args, {
    windowsHide: true, timeout: 240000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  }, (error, stdout) => resolve({ error, stdout })));
}
async function runUpdater(options) {
  const hub = path.resolve(__dirname, '..', '..');
  const args = [path.join(hub, 'scripts', 'Sync-HubRepository.py'), '--hub', hub, '--settings', settingsPath(), ...options];
  for (const [command, prefix] of [['python', []], ['py', ['-3']]]) {
    const out = await invoke(command, [...prefix, ...args]);
    if (out.error?.code === 'ENOENT') continue;
    try {
      if (out.error) throw out.error;
      return JSON.parse(String(out.stdout).replace(/^\uFEFF/, '').trim());
    } catch {
      return { status: 'blocked', message: '저장소 자동 갱신을 완료하지 못했습니다. Python 3와 연결·폴더 권한을 확인해 주세요.' };
    }
  }
  return { status: 'blocked', message: '자동 갱신에는 Python 3가 필요합니다. 설치를 요청해 주세요.' };
}
async function perform({ lite = false, expectedCommit } = {}) {
  if (process.env.AIHUB_SELFTEST) return last;
  const approval = initialStatus();
  if (approval.status !== 'not-checked') return (last = approval);
  const args = ['--check-only'];
  if (expectedCommit) args.push('--expected-commit', expectedCommit);
  if (lite || fs.existsSync(path.resolve(__dirname, '../../resources/lite-profile.txt'))) args.push('--lite');
  return (last = await runUpdater(args));
}
async function autoUpdateSetting() {
  const state = initialStatus(true);
  if (state.status !== 'not-checked') return { enabled: false, blocked: state.status === 'blocked', message: state.message };
  const repo = await inspectRepository(state.settings);
  return repo.error
    ? { enabled: true, unavailable: true, message: repo.error + ' 설정을 끈 뒤 올바른 폴더로 다시 켤 수 있습니다.' }
    : { enabled: true, message: state.message };
}
async function setAutoUpdate(enabled, repository) {
  if (typeof enabled !== 'boolean' || (enabled && !path.isAbsolute(repository || ''))) {
    throw new Error('이 PC의 갱신 설정과 공유 저장소 경로를 확인하세요.');
  }
  const result = await runUpdater(enabled ? ['--enable-for', repository] : ['--disable']);
  const stored = await autoUpdateSetting();
  if (result.status === (enabled ? 'not-checked' : 'disabled') && stored.enabled === enabled && !stored.blocked) {
    last = result;
    return { ...stored, message: result.message };
  }
  return { ...stored, error: true, message: result.message || stored.message };
}
function sync(options) {
  if (manualPolicy() !== 'standard') return Promise.resolve(last);
  if (!pending) pending = perform(options).catch(() => {
    last = { status: 'blocked', message: '저장소 자동 갱신에 실패했습니다. 설정과 설치 폴더를 확인해 주세요.' };
    return last;
  }).finally(() => { pending = null; });
  return pending;
}
function applyReceipt(id) {
  if (id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || ''))
    throw new Error('올바른 갱신 작업 ID가 필요합니다.');
  const directory = path.dirname(settingsPath());
  const file = id ? path.join(directory, 'repository-apply-results', id + '.json')
    : path.join(directory, 'repository-apply-result.json');
  try {
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    return path.relative(path.resolve(__dirname, '../..'), result.appRoot) === '' && (!id || result.id === id) ? result : null;
  } catch (error) {
    if (id && error.code === 'ENOENT') {
      const current = applyReceipt();
      return current?.id === id ? current : null;
    }
    return error.code === 'ENOENT' ? null : { status: 'blocked', needsRecovery: true, message: '갱신 결과 파일을 확인해 주세요.' };
  }
}

function startupGate() {
  const state = applyReceipt();
  const returned = state?.id && !state.needsRecovery && ['relaunching', 'recovering', 'verified', 'blocked'].includes(state.status)
    && process.argv.includes('--hub-update-return=' + state.id);
  if (returned) return 'returned';
  try {
    // An existing, unlocked file is normal after the worker exits.
    fs.closeSync(fs.openSync(path.join(path.dirname(settingsPath()), 'repository-apply.lock'), 'r+'));
  } catch (error) {
    if (error.code !== 'ENOENT') return 'busy';
  }
  return state?.needsRecovery || state?.status === 'applying' ? 'recovery' : 'normal';
}

async function startAfterExit({ guiPid, exe, packaged, lite, port, pointerPath, recover = false, expectedCommit, requireExitConsent = false }) {
  const receipt = recover ? applyReceipt() : null;
  const commit = recover ? receipt?.commit : last.commit;
  const eligible = recover ? receipt?.needsRecovery || receipt?.status === 'applying' : last.status === 'pending';
  if (expectedCommit && commit !== expectedCommit) throw new Error('검토한 커밋이 바뀌었습니다. 다시 동기화해 주세요.');
  if (!eligible || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit || '')) throw new Error('검토한 갱신 커밋을 확인할 수 없습니다.');
  const profile = require('./profile-identity').current();
  const expectedProfile = recover ? receipt?.expectedProfileFingerprint : profile.fingerprint;
  if (profile.status !== 'available' || !/^[0-9a-f]{64}$/.test(expectedProfile || '') ||
      profile.fingerprint !== expectedProfile) throw new Error('기존 Hub 프로필의 정체성을 확인하지 못했습니다. 원래 실행 환경에서 다시 확인하세요.');
  const hub = path.resolve(__dirname, '../..');
  const requestId = require('crypto').randomUUID();
  const command = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', path.join(hub, 'scripts/Apply-HubUpdate.ps1'),
    '-Dispatch', '-HubRoot', hub, '-AppExe', exe, '-GuiPid', String(guiPid), '-SettingsPath', settingsPath(),
    '-PointerPath', pointerPath, '-RequestId', requestId, '-Commit', commit, '-Port', String(port),
    '-ExpectedProfileFingerprint', expectedProfile];
  if (recover ? receipt.requireGui === true : profile.requireGui) args.push('-RequireGui');
  if (recover) args.push('-Recover');
  if (requireExitConsent) args.push('-RequireExitConsent');
  if (packaged) args.push('-Packaged');
  if (lite) args.push('-Lite');
  const out = await invoke(command, args);
  const state = applyReceipt();
  if (out.error || state?.id !== requestId || state.status !== 'armed') {
    throw new Error(state?.id === requestId ? state.message : '분리된 갱신 작업자를 시작할 수 없습니다. 현재 Hub를 계속 사용합니다.');
  }
  return { id: requestId, status: 'armed' };
}
async function exitConsent(id, commit, allowExit) {
  const state = applyReceipt();
  if (!/^[0-9a-f-]{36}$/.test(id || '') || state?.id !== id || state.commit !== commit || state.status !== 'armed')
    throw new Error('갱신 작업자의 종료 대기 기록이 바뀌었습니다.');
  await require('./atomic-file').writeAtomic(path.join(path.dirname(settingsPath()), 'repository-exit-' + id + '.json'),
    JSON.stringify({ schemaVersion: 1, id, commit, allowExit: allowExit === true }) + '\n');
}
// Sync-HubRepository.py와 같은 비대화식 git: 자격 증명 창·훅·fsmonitor 없이 제한 시간 안에 끝낸다. 실패 출력(원격 주소에 자격 증명이
// 섞일 수 있다)은 버리고 null을 준다. 출력은 커밋 해시와 저장소 파일 원문(UTF-8)이라 콘솔 코드페이지 해석(규칙 12)이 필요 없다.
function git(repo, args, timeout) {
  return new Promise(resolve => execFile('git', ['-c', 'core.hooksPath=' + os.devNull, '-c', 'core.fsmonitor=false',
    '-c', 'submodule.recurse=false', '-C', repo, ...args], {
    windowsHide: true, timeout, maxBuffer: 1024 * 1024, encoding: 'buffer',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10' },
  }, (error, stdout) => resolve(error ? null : stdout.toString('utf8'))));
}
// fetch는 이 PC가 승인한 자동 갱신 설정이 있을 때만 한다(AGENTS.md: PC별로 승인한 부트스트랩만 fetch). 조건은 Sync-HubRepository.py와
// 같다 — schemaVersion 1, enabled true, clone과 승인 원격. 승인이 없거나 끈 PC는 공유 저장소에 손대지 않고 overlay 채널을 "확인 못함"으로 둔다.
function approvedRepository(settings) {
  if (settings?.schemaVersion !== 1 || settings.enabled !== true ||
      ![settings.repository, settings.origin].every(v => typeof v === 'string' && v.trim())) {
    return { error: '이 PC는 저장소 자동 갱신이 승인되지 않아(repository-update.local.json) 공유 저장소의 overlay 버전을 확인하지 않았습니다.' };
  }
  return { repository: settings.repository, origin: settings.origin };
}
async function overlayRepository() {
  let settings = null;
  try { settings = JSON.parse((await fs.promises.readFile(settingsPath(), 'utf8')).replace(/^﻿/, '')); }
  catch (error) { if (error.code !== 'ENOENT') return { error: '저장소 자동 갱신 설정(repository-update.local.json)을 읽지 못했습니다.' }; }
  return inspectRepository(settings);
}
async function inspectRepository(settings) {
  if (settings?.enabled === true && ![settings.repository, settings.origin].every(v => typeof v === 'string' && v.trim()))
    return { error: '이 PC의 승인 파일에 저장소 경로 또는 원격 주소가 없습니다.' };
  const repo = approvedRepository(settings);
  if (repo.error) return repo;
  if (!path.isAbsolute(repo.repository) ||
      !['https://github.com/your-org/your-shared-context.git', 'git@github.com:your-org/your-shared-context.git'].includes(repo.origin)) {
    return { error: '이 PC의 승인된 저장소 경로나 원격 주소가 올바르지 않습니다.' };
  }
  const root = (await git(repo.repository, ['rev-parse', '--show-toplevel'], 10000))?.trim();
  if (!root || path.relative(repo.repository, root) !== '') return { error: '이 PC에서 승인된 저장소의 최상위 폴더를 찾을 수 없습니다.' };
  if ((await git(repo.repository, ['remote', 'get-url', 'origin'], 10000))?.trim() !== repo.origin)
    return { error: '공유 저장소 원격 주소가 이 PC의 승인값과 다릅니다.' };
  return repo;
}
/**
 * 공유 저장소 main의 Hub overlay 버전(integrations/ai-hub/manifest.json의 resultHubVersion). 1.30.0 이후 버전은 설치본 없이
 * overlay로만 나가서 업데이트 확인이 이 채널도 본다. 작업 트리는 그대로 두고 origin/main 추적 참조만 fetch한다.
 * 확인하지 못하면 known:false — 호출자는 이것을 "최신"으로 읽으면 안 된다. target을 주면 그 clone만 본다(시험).
 */
async function overlayVersion(target) {
  const unknown = error => ({ known: false, version: '', commit: '', error });
  if (process.env.AIHUB_SELFTEST) return unknown('자체 점검 실행에서는 공유 저장소를 확인하지 않습니다.');
  const repo = target === undefined ? await overlayRepository() : target;
  if (repo?.error) return unknown(repo.error);
  if (!repo?.repository) return unknown('공유 저장소 clone을 찾지 못했습니다(메모리 탭에서 경로 지정).');
  if (repo.origin && (await git(repo.repository, ['remote', 'get-url', 'origin'], 10000))?.trim() !== repo.origin)
    return unknown('공유 저장소 원격 주소가 승인값과 다릅니다.');
  if (await git(repo.repository, ['fetch', '--no-tags', '--no-recurse-submodules', 'origin',
    'refs/heads/main:refs/remotes/origin/main'], 20000) === null) return unknown('공유 저장소 fetch에 실패했습니다(네트워크·인증·동시 갱신). 잠시 뒤 다시 확인하세요.');
  const commit = (await git(repo.repository, ['rev-parse', 'refs/remotes/origin/main'], 10000) || '').trim();
  const text = /^[0-9a-f]{40,64}$/.test(commit) ? await git(repo.repository, ['show', commit + ':integrations/ai-hub/manifest.json'], 10000) : null;
  try {
    const version = JSON.parse(text.replace(/^﻿/, '')).resultHubVersion;
    if (/^\d+(\.\d+)+$/.test(version)) return { known: true, version, commit, error: '' };
  } catch { /* 아래 */ }
  return unknown('공유 저장소 main에서 Hub overlay 버전을 읽지 못했습니다.');
}
module.exports = { sync, status: () => ({ ...last, delivery: applyReceipt() }), delivery: applyReceipt,
  approval: initialStatus, startupGate, startAfterExit, exitConsent,
  manualPolicy, manualPreflight: async options => {
    if (manualPolicy() !== 'manual' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.expectedCommit || ''))
      throw new Error('이 PC의 수동 업데이트 정책과 확인한 커밋이 필요합니다.');
    return perform(options);
  },
  enroll: repository => runUpdater(['--enroll', repository]), overlayVersion, approvedRepository, autoUpdateSetting, setAutoUpdate };

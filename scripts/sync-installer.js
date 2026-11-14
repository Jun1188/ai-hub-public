'use strict';
// Invoked only by the desktop sync button; never by a timer or startup check.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const updater = require('../src/core/updater');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const assert = (value, message) => { if (!value) throw new Error(message); };
async function currentRelease(share) {
  const file = path.join(updater.releaseDir(share), updater.LATEST_FILE);
  try {
    const value = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    if (!/^\d+\.\d+\.\d+$/.test(value?.version) ||
        !/^(?:ai-hub|AI-AllInOne-Hub)-Setup-[\d.]+\.exe$/i.test(value.setup) ||
        !/^[a-f\d]{64}$/i.test(value.sha256))
      throw new Error('공유 설치본 manifest 형식이 잘못되었습니다.');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('공유 설치본 manifest를 확인할 수 없어 기존 파일을 보존했습니다.');
  }
}
async function electronArchive() {
  const spec = read(path.join(root, 'scripts', 'release-runtimes.json')).electron;
  const policy = read(path.join(require('../src/core/paths').hubDataDir(), 'manual-sync-policy.local.json'));
  const archive = policy.electronArchive || process.env.AIHUB_ELECTRON_ZIP;
  assert(typeof archive === 'string' && path.isAbsolute(archive) && path.basename(archive) === spec.zipName,
    '이 PC의 수동 동기화 정책에서 검증할 Electron ZIP 경로를 지정해 주세요.');
  assert(await updater.sha256File(archive) === spec.zipSha256, 'Electron ZIP 해시가 검토한 릴리스 입력과 다릅니다.');
  return archive;
}
function snapshot() {
  const hashes = {};
  function walk(rel) {
    const file = path.join(root, rel);
    const stat = fs.lstatSync(file);
    assert(!stat.isSymbolicLink(), '소스에 링크가 있어 빌드를 보류했습니다.');
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(rel, name));
    else hashes[rel] = hash(file);
  }
  for (const rel of ['electron', 'src', 'ui', 'scripts', 'skills', 'build', 'resources', 'package.json', 'package-lock.json']) walk(rel);
  return hashes;
}
async function verifyPacked(packed, pkg, before) {
  const bundled = read(path.join(packed, 'package.json'));
  assert(bundled.version === pkg.version && JSON.stringify(pkg.dependencies) === JSON.stringify(bundled.dependencies), '설치본 버전·의존성이 소스와 다릅니다.');
  assert(fs.existsSync(path.join(packed, bundled.main)), '설치본 실행 파일이 빠졌습니다.');
  for (const [rel, expected] of Object.entries(before)) {
    if (/^(electron|src|ui)[\\/]/.test(rel)) assert(hash(path.join(packed, rel)) === expected, '설치본 파일이 소스와 다릅니다: ' + rel);
  }
  for (const name of Object.keys(pkg.dependencies || {})) assert(read(path.join(packed, 'node_modules', name, 'package.json')).version, '의존성 누락: ' + name);
  const runtime = path.resolve(packed, '..', 'runtime');
  assert(hash(path.join(runtime, 'node.exe')) === read(path.join(runtime, 'runtime-manifest.json')).sha256, '번들 런타임 해시가 다릅니다.');
  const herdr = path.resolve(packed, '..', 'herdr'), herdrFiles = read(path.join(herdr, 'herdr-manifest.json')).files;
  for (const [rel, expected] of Object.entries(herdrFiles)) assert(hash(path.join(herdr, rel)) === expected, '번들 Herdr 파일이 검토본과 다릅니다: ' + rel);
  // Run the packaged MCP graph without HTTP, real model calls or the user's app data.
  const result = spawnSync(process.execPath, ['-e', `
    const p=require('path'),{createRequire}=require('module');
    const r=createRequire(p.join(process.argv[1],'package.json'));
    const {Client,InMemoryTransport}=r('@modelcontextprotocol/client');
    (async()=>{const s=r('./src/mcp/hub-server').createHubServer();const[a,b]=InMemoryTransport.createLinkedPair();
    await s.connect(a);const c=new Client({name:'installer-check',version:'1'},{capabilities:{}});await c.connect(b);
    const names=(await c.listTools()).tools.map(t=>t.name);if(!names.includes('hub_status')||!names.includes('hub_command'))throw Error('MCP tools missing');
    await c.close();})().catch(e=>{console.error(e.message);process.exitCode=1});`, packed], {
    windowsHide: true, timeout: 60000, encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AIHUB_SELFTEST: '1',
      APPDATA: path.join(path.dirname(packed), 'validation', 'Roaming'),
      LOCALAPPDATA: path.join(path.dirname(packed), 'validation', 'Local'),
      AGENT_WORK_DIR: path.join(path.dirname(packed), 'validation', 'work') },
  });
  assert(result.status === 0, '설치본 MCP 초기화 검사에 실패했습니다.');
}
async function main() {
  const share = process.argv[process.argv.indexOf('--share') + 1];
  assert(process.argv.includes('--share') && path.isAbsolute(share), '공유 폴더 경로가 필요합니다.');
  const pkg = read(path.join(root, 'package.json'));
  assert(/^\d+\.\d+\.\d+$/.test(pkg.version), '버전 형식 오류');
  const latest = await currentRelease(share);
  if (latest && updater.compareVersions(latest.version, pkg.version) >= 0) {
    assert(updater.compareVersions(latest.version, pkg.version) === 0, '공유 설치본이 앱보다 새롭습니다. 앱을 먼저 갱신해 주세요.');
    assert(path.basename(latest.setup || '') === latest.setup, '공유 설치본 파일명 오류');
    assert(await updater.sha256File(path.join(share, 'release', latest.setup)) === latest.sha256, '공유 설치본 해시가 맞지 않습니다. 기존 파일은 보존했습니다.');
    return { ok: true, version: pkg.version, sha256: latest.sha256, message: '앱과 공유 설치본이 모두 최신입니다.' };
  }
  const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
  assert(fs.existsSync(cli), '이 PC에는 설치본 빌드 도구가 없습니다. 개발 PC의 Hub에서 동기화해 주세요.');
  const verifiedArchive = await electronArchive();
  const before = snapshot();
  const output = path.join(require('../src/core/paths').hubStorageDir(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')), 'release');
  fs.mkdirSync(output, { recursive: true });
  const lock = path.join(output, 'manual-build.lock');
  const fd = fs.openSync(lock, 'wx'); // Never steal an uncertain build's ownership.
  let publishLock, uncertain = false;
  try {
    fs.writeFileSync(fd, JSON.stringify({pid:process.pid,version:pkg.version,at:new Date().toISOString()}));
    const log = fs.openSync(path.join(output, 'manual-build.log'), 'a');
    let built;
    try { built = spawnSync(process.execPath, [cli, '--win', '--publish', 'never', '-c.directories.output=' + output],
      { cwd: root, windowsHide: true, timeout: 25 * 60 * 1000, stdio: ['ignore', log, log],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AIHUB_ELECTRON_ZIP: verifiedArchive } }); }
    finally { fs.closeSync(log); }
    uncertain = built.error?.code === 'ETIMEDOUT';
    assert(built.status === 0, '설치본 빌드가 실패했습니다. 로컬 release/manual-build.log를 확인해 주세요.');
    await verifyPacked(path.join(output, 'win-unpacked', 'resources', 'app'), pkg, before);
    assert(JSON.stringify(before) === JSON.stringify(snapshot()), '빌드 중 앱 소스가 바뀌어 게시를 보류했습니다.');
    const dir = path.join(share, 'release');
    await fs.promises.mkdir(dir, { recursive: true });
    publishLock = await fs.promises.open(path.join(dir, '.hub-publish.lock'), 'wx');
    const current = await currentRelease(share);
    assert(!current || updater.compareVersions(current.version, pkg.version) < 0, '다른 게시자가 공유 설치본을 갱신했습니다. 다시 확인해 주세요.');
    const setup = path.join(output, `ai-hub-Setup-${pkg.version}.exe`);
    const existingSetup = path.join(dir, path.basename(setup));
    if (fs.existsSync(existingSetup) && await updater.sha256File(existingSetup) !== await updater.sha256File(setup))
      throw new Error('공유 폴더에 같은 버전의 다른 설치본이 있어 기존 파일을 보존했습니다.');
    const result = await updater.publish({shareRoot:share,setupPath:setup,version:pkg.version,
      notes:'Hub 수동 동기화: 앱 파일·런타임 해시와 MCP 초기화 검사 통과.',keep:Number.MAX_SAFE_INTEGER,verifyBeforeRelease:true});
    assert(await updater.sha256File(result.dest) === result.latest.sha256, '공유 설치본 사후 해시 검사 실패');
    return {ok:true,version:pkg.version,sha256:result.latest.sha256,message:`앱과 공유 설치본 v${pkg.version} 동기화를 완료했습니다.`};
  } finally {
    if (publishLock) { await publishLock.close(); await fs.promises.unlink(path.join(share, 'release', '.hub-publish.lock')); }
    fs.closeSync(fd); if (!uncertain) fs.unlinkSync(lock);
  }
}
if (require.main === module) main().then(result => console.log(JSON.stringify(result))).catch(error => {
  console.log(JSON.stringify({ok:false,message:String(error.message || error)}));process.exitCode=1;
});
module.exports = { snapshot, verifyPacked, main };

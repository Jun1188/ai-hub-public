// Obsidian 연결: 설치 감지 → (미설치) Hub 그래프 + Markdown 볼트로 대체 → (설치되면) 자동 색인·볼트 등록.
// 기존 "볼트 생성"은 매번 새 볼트라 Obsidian 목록에 없어 obsidian://open이 열지 못했다. 여기서는 Hub가 관리하는
// 고정 볼트 하나를 제자리 갱신한다. 사용자가 고친 노트(마지막 생성 해시와 다름)는 덮어쓰지 않고, 지우지도 않는다.
// Obsidian 설정(obsidian.json)에는 Obsidian이 꺼져 있을 때만, 백업 뒤 우리 볼트 항목 하나만 더한다.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const appData = () => process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const localAppData = () => process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const exists = (p) => fs.promises.access(p).then(() => true, () => false);

function paths(deps = {}) {
  const data = deps.dataDir || require('../paths').hubDataDir();
  return { exe: deps.exe || path.join(localAppData(), 'Programs', 'Obsidian', 'Obsidian.exe'), config: deps.obsidianConfig || path.join(appData(), 'obsidian', 'obsidian.json'),
    vault: path.join(data, 'knowledge-graph', 'obsidian-vault'), state: path.join(data, 'knowledge-graph', 'obsidian-state.json') };
}

async function running(deps = {}) {
  if (deps.isRunning) return deps.isRunning();
  return new Promise((resolve) => require('child_process').execFile('tasklist.exe', ['/FI', 'IMAGENAME eq Obsidian.exe', '/NH'], { windowsHide: true, timeout: 8000, encoding: 'buffer' },
    (err, out) => resolve(!err && /obsidian\.exe/i.test(require('../console-text').decode(out || Buffer.alloc(0))))));
}

/** 설치·실행·등록 볼트 상태. 볼트 경로는 사용자 폴더를 가린다. */
async function detect(deps = {}) {
  const p = paths(deps);
  if (require('../public-profile').enabled && !deps.obsidianConfig) return {
    installed: false, exe: false, configFound: false, running: false, vaultPath: p.vault,
    registered: false, vaultId: null, vaults: [], publicIsolated: true,
    installHint: '공개 경량판은 기존 Obsidian 설정이나 개인 볼트를 자동으로 찾지 않습니다.'
  };
  const [exe, config] = await Promise.all([exists(p.exe), exists(p.config)]);
  let vaults = [];
  if (config) {
    try { const j = await readJson(p.config, {}); vaults = Object.entries(j.vaults || {}).map(([id, v]) => ({ id, path: v.path, open: !!v.open })); }
    catch { /* 읽지 못하면 등록 목록만 모른다 */ }
  }
  const ours = vaults.find((v) => v.path && path.resolve(v.path).toLowerCase() === path.resolve(p.vault).toLowerCase());
  const scrub = require('../secret-scrub').scrub;
  return { installed: exe || config, exe, configFound: config, running: exe || config ? await running(deps) : false, vaultPath: p.vault, registered: !!ours, vaultId: ours?.id || null,
    vaults: vaults.map((v) => ({ id: v.id, path: scrub(String(v.path || '')), open: v.open })),
    installHint: exe || config ? null : 'winget install -e --id Obsidian.Obsidian (설치 뒤 Hub가 자동으로 볼트를 색인·등록합니다)' };
}

const readJson = (file, fallback) => require('../atomic-file').readJson(file, fallback);

/**
 * 관리 볼트를 제자리 갱신한다. files: { 상대경로: 내용 }. 마지막으로 Hub가 쓴 해시와 현재 파일이 다르면(사용자가 고침) 건너뛴다.
 */
async function syncFiles(files, deps = {}) {
  const p = paths(deps);
  const manifestFile = path.join(p.vault, '.hub-vault.json');
  const manifest = await readJson(manifestFile, { generated: true, files: {} });
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('볼트 관리 목록을 읽지 못했습니다. 원본을 보존하고 갱신을 중단합니다.');
  const written = [], keptUserEdits = [];
  for (const [rel, text] of Object.entries(files)) {
    if (rel.includes('..') || path.isAbsolute(rel) || rel.startsWith('.obsidian')) continue;
    const full = path.join(p.vault, ...rel.split('/'));
    let current = null;
    try { current = await fs.promises.readFile(full, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (current != null && (!manifest.files[rel] || sha(current) !== manifest.files[rel])) { keptUserEdits.push(rel); continue; }
    if (current === text) { manifest.files[rel] = sha(text); continue; }
    await require('../atomic-file').writeAtomic(full, text);
    manifest.files[rel] = sha(text);
    written.push(rel);
  }
  const stale = Object.keys(manifest.files).filter((rel) => !(rel in files));
  // Archive only unchanged generated notes; edits and unknown files stay in the user's vault.
  const archive = path.join(path.dirname(p.vault), 'obsidian-archive', new Date().toISOString().replace(/[:.]/g, '-'));
  let archived = 0;
  for (const rel of stale) {
    if (!/^(?:Graph|Nodes)\//.test(rel) || rel.split('/').includes('..') || path.isAbsolute(rel)) continue;
    const full = path.join(p.vault, ...rel.split('/'));
    let current;
    try { current = await fs.promises.readFile(full, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') { delete manifest.files[rel]; continue; } throw e; }
    if (sha(current) !== manifest.files[rel]) { keptUserEdits.push(rel); continue; }
    const saved = path.join(archive, ...rel.split('/'));
    await fs.promises.mkdir(path.dirname(saved), { recursive: true });
    await fs.promises.rename(full, saved); delete manifest.files[rel]; archived++;
  }
  manifest.updatedAt = new Date().toISOString();
  manifest.formatVersion = 2;
  await require('../atomic-file').writeAtomic(manifestFile, '\uFEFF' + JSON.stringify(manifest, null, 1));
  return { vault: p.vault, nodes: Object.keys(files).filter(rel => rel.startsWith('Nodes/')).length, written: written.length, unchanged: Object.keys(files).length - written.length - keptUserEdits.filter(rel => rel in files).length, keptUserEdits, stale: stale.length, archived, archive: archived ? archive : null };
}

/** 지식 그래프 원천 + RSI 경험 라이브러리·승인 작업 지시서를 볼트 파일로 만든다. */
async function buildFiles(keys, deps = {}) {
  const graph = deps.graph || require('../knowledge-graph');
  const nodes = new Map(), edges = new Map(), warnings = new Set();
  for (const key of keys) {
    const g = await graph.load(key);
    if (key.startsWith('directory:') && g.root && require('../repository-skills').within(path.join(deps.dataDir || require('../paths').hubDataDir(), 'knowledge-graph'), path.resolve(g.root))) {
      warnings.add('Hub가 생성한 볼트의 재수집본은 자기 복제를 막기 위해 제외했습니다. 원본 그래프는 통합 매핑에 포함됩니다.');
      continue;
    }
    for (const n of g.nodes || []) {
      const old = nodes.get(n.id);
      nodes.set(n.id, { ...n, ...old, kind: old?.kind === 'skill' || n.kind === 'skill' ? 'skill' : old?.kind || n.kind,
        sourceKeys: [...new Set([...(old?.sourceKeys || []), ...(n.sourceKeys || [key])])] });
    }
    for (const e of g.edges || []) edges.set(`${e.source}|${e.target}|${e.relation}`, e);
    for (const w of g.warnings || []) warnings.add(w);
  }
  const files = require('./vault-notes').render({ key: keys.join(', '), label: 'Hub 지식 볼트', nodes: [...nodes.values()], edges: [...edges.values()], warnings: [...warnings] });
  // RSI 경험 라이브러리는 데이터 계약(rsi/library/<domain>/*.md)으로만 읽는다 — 자가개선 모듈을 끌어오지 않게.
  const libRoot = path.join(deps.dataDir || require('../paths').hubDataDir(), 'rsi', 'library');
  for (const e of await fs.promises.readdir(libRoot, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue;
    for (const name of ['INDEX.md', 'EXPERIENCE.md']) {
      try { files[`RSI Library/${e.name}/${name}`] = await fs.promises.readFile(path.join(libRoot, e.name, name), 'utf8'); } catch { /* 아직 없음 */ }
    }
  }
  const approved = path.join(deps.dataDir || require('../paths').hubDataDir(), 'rsi', 'approved');
  for (const n of (await fs.promises.readdir(approved).catch(() => [])).filter((x) => x.endsWith('.md')).slice(0, 200)) files[`RSI Work Orders/${n}`] = await fs.promises.readFile(path.join(approved, n), 'utf8');
  const extraNotes = Object.keys(files).filter(n => n.startsWith('RSI '));
  files['Hub Index.md'] += '\n## 자가개선\n\n' + extraNotes.map(n => `- [[${n}|${path.basename(n, '.md')}]]`).join('\n') + '\n';
  return files;
}

/** Obsidian이 꺼져 있을 때만 우리 볼트 항목을 더한다(백업 후 원자적 쓰기). 켜져 있으면 다음 주기로 미룬다. */
async function register(deps = {}) {
  const p = paths(deps);
  const d = await detect(deps);
  if (!d.installed) return { registered: false, reason: 'not-installed' };
  if (d.registered) return { registered: true, reason: 'already' };
  if (d.running) return { registered: false, reason: 'obsidian-running' };
  const j = d.configFound ? await readJson(p.config, null).catch(() => null) : { vaults: {} };
  if (!j) return { registered: false, reason: 'config-unreadable' }; // 읽기 실패를 빈 설정으로 덮지 않는다(규칙 6)
  if (d.configFound) await fs.promises.copyFile(p.config, `${p.config}.hub-backup-${Date.now()}`);
  j.vaults = j.vaults || {};
  j.vaults[crypto.randomBytes(8).toString('hex')] = { path: p.vault, ts: Date.now() };
  await require('../atomic-file').writeAtomic(p.config, JSON.stringify(j));
  return { registered: true, reason: 'added' };
}

/** 자동 색인: 볼트 갱신 + (설치돼 있으면) 등록. 설치 전환을 기억해 처음 설치된 순간을 알린다. */
async function indexVault({ keys = ['all:knowledge'] } = {}, deps = {}) {
  const p = paths(deps);
  const state = await readJson(p.state, { installed: false, lastIndexedAt: null });
  const d = await detect(deps);
  const sync = await syncFiles(await buildFiles(keys, deps), deps);
  const reg = d.installed ? await register(deps) : { registered: false, reason: 'not-installed' };
  const next = { installed: d.installed, lastIndexedAt: new Date().toISOString(), newlyInstalled: d.installed && !state.installed, registration: reg.reason, formatVersion: 2 };
  await require('../atomic-file').writeAtomic(p.state, '\uFEFF' + JSON.stringify(next));
  return { ...next, sync, detect: { installed: d.installed, running: d.running, registered: reg.registered } };
}

let pending = Promise.resolve();
function autoIndex(options = {}, deps = {}) {
  const result = pending.then(() => indexVault(options, deps));
  pending = result.catch(() => {});
  return result;
}

let timer = null;
/** 10분마다 설치 여부만 싸게 확인하고, 처음 설치됐거나 하루가 지났으면 자동 색인한다. */
function watch(deps = {}) {
  if (timer) return;
  const tick = async () => {
    const p = paths(deps);
    const state = await readJson(p.state, { installed: false, lastIndexedAt: null });
    const d = await detect(deps);
    const stale = state.formatVersion !== 2 || !state.lastIndexedAt || Date.now() - Date.parse(state.lastIndexedAt) > 24 * 3600 * 1000;
    if ((d.installed && !state.installed) || (d.installed && (stale || !d.registered))) await autoIndex({}, deps);
  };
  timer = setInterval(() => { tick().catch(() => {}); }, 10 * 60 * 1000);
  timer.unref?.();
  setTimeout(() => tick().catch(() => {}), 60 * 1000).unref?.();
}
function unwatch() { if (timer) clearInterval(timer); timer = null; }

module.exports = { detect, syncFiles, buildFiles, register, autoIndex, watch, unwatch, paths };

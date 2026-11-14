// 원본 그대로의 외부 도구(K4, update-policy)의 갱신: 지금은 uv tool로 설치한 Python 도구. 첫 항목은 Aider(사용자 지정 대표 예시).
// 감지(PyPI 최신) → 준비(그 사이 릴리스 노트, wheel 유무, 주 버전) → 정책 → 적용은 정확한 버전 설치 → 계약 시험(--version, 우리가 쓰는 플래그) →
// 실패하면 이전 버전으로 되돌리고 승인 대기. Hub 재시작은 필요 없다(Aider는 실행할 때마다 새로 띄운다).
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const DAY = 86400000;
const TOOLS = [
  { id: 'aider', kind: 'K4', mechanism: 'uv-tool', package: 'aider-chat', repository: 'https://github.com/Aider-AI/aider',
    notes: 'https://raw.githubusercontent.com/Aider-AI/aider/main/HISTORY.md',
    bin: () => require('../aider-studio').executable(), flags: () => require('../aider-studio').CLI_FLAGS },
];

const dataDirOf = (deps = {}) => deps.dataDir || require('../paths').hubDataDir();
const stateFile = (deps) => path.join(dataDirOf(deps), 'upstream-sync', 'tools.local.json');

function uvBin() {
  const home = os.homedir();
  const names = process.platform === 'win32' ? ['uv.exe'] : ['uv'];
  const dirs = [process.env.UV_BIN ? path.dirname(process.env.UV_BIN) : null, path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin'),
    ...String(process.env.PATH || '').split(path.delimiter)].filter(Boolean);
  for (const d of dirs) for (const n of names) { const f = path.join(d, n); if (fs.existsSync(f)) return f; }
  return null;
}

function run(file, args, timeout) {
  const consoleText = require('../console-text');
  return new Promise((resolve) => execFile(file, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...consoleText.RAW_OUTPUT },
    (err, stdout, stderr) => resolve({ ok: !err, code: err ? err.code : 0, out: [consoleText.decode(stdout), consoleText.decode(stderr)].filter(Boolean).join('\n') })));
}

const parts = (v) => String(v || '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
function compare(a, b) { const x = parts(a), y = parts(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; }
// 0.x에서도 첫 자리만 주 버전으로 본다 — Aider는 0.x 부 버전이 몇 주마다 나와, 그것까지 승인으로 돌리면 정책의 "AI 1차"가 사라진다. 깨지는지는 계약 시험이 본다.
const major = (a, b) => parts(a)[0] !== parts(b)[0];

async function installed(tool, deps) {
  const uv = (deps.uvBin || uvBin)();
  if (!uv) return null;
  const r = await (deps.run || run)(uv, ['tool', 'list'], 30000);
  const m = new RegExp(`^${tool.package.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')} v(\\S+)`, 'm').exec(r.out || '');
  return m ? m[1] : null;
}

async function getJson(url, deps) {
  const res = await (deps.fetch || fetch)(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'ai-hub' } });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return res.json();
}
async function getText(url, deps) {
  const res = await (deps.fetch || fetch)(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'ai-hub' } });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return res.text();
}

/** PyPI 최신 버전과 그 버전의 파일 모양(wheel이면 설치가 빌드 스크립트를 돌리지 않는다). */
async function latest(tool, deps) {
  const j = await getJson(`https://pypi.org/pypi/${encodeURIComponent(tool.package)}/json`, deps);
  const version = j.info && j.info.version;
  const files = (j.releases && j.releases[version]) || j.urls || [];
  return { version, wheel: files.some((f) => f.packagetype === 'bdist_wheel'), yanked: files.length > 0 && files.every((f) => f.yanked) };
}

/** 릴리스 노트에서 (from, to] 사이 절만. 제목 모양: "### Aider v0.86.0" */
function notesBetween(text, from, to) {
  const out = [];
  let keep = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    const h = /^#{2,3}\s+(?:Aider\s+)?v?(\d+\.\d+(?:\.\d+)?)/.exec(line);
    if (h) keep = compare(h[1], from) > 0 && compare(h[1], to) <= 0;
    if (keep) out.push(line);
  }
  return out.join('\n').slice(0, 8000);
}

/** 계약 시험: 설치된 버전이 기대한 것이고, 우리가 넘기는 플래그가 --help에 모두 있다. */
async function contract(tool, version, deps) {
  const bin = (deps.toolBin || ((t) => t.bin()))(tool);
  if (!bin) return { ok: false, missing: [], reason: 'binary_not_found' };
  const v = await (deps.run || run)(bin, ['--version'], 60000);
  if (!v.ok || !String(v.out).includes(version)) return { ok: false, missing: [], reason: `version ${String(v.out).trim().slice(0, 60)}` };
  const h = await (deps.run || run)(bin, ['--help'], 60000);
  const missing = (deps.toolFlags || ((t) => t.flags()))(tool).filter((f) => !new RegExp(`(^|[\\s,])${f.replace(/[-]/g, '\\-')}(?=[\\s,=]|$)`, 'm').test(h.out || ''));
  return { ok: h.ok && !missing.length, missing, reason: missing.length ? 'missing flags' : h.ok ? null : 'help failed' };
}

async function install(tool, version, deps) {
  const uv = (deps.uvBin || uvBin)();
  if (!uv) throw new Error('uv not found');
  const r = await (deps.run || run)(uv, ['tool', 'install', '--force', `${tool.package}==${version}`], 10 * 60 * 1000);
  if (!r.ok) throw new Error(`uv tool install ${tool.package}==${version}: ${String(r.out).trim().slice(-200)}`);
  return { version };
}

async function readState(deps) {
  return require('../atomic-file').readJsonOrQuarantine(stateFile(deps), { schemaVersion: 1, tools: {} });
}

/** 갱신 하나: 설치 → 계약 시험, 실패하면 이전 버전으로 되돌린다. 정책의 apply/check/rollback 세 단계로 나눠 넘긴다. */
function steps(tool, from, to, deps) {
  return {
    apply: () => install(tool, to, deps),
    check: async () => { const c = await contract(tool, to, deps); return c.ok; },
    rollback: () => (from ? install(tool, from, deps) : Promise.resolve()),
  };
}

/** 하루에 한 번씩 각 도구를 본다. 설치돼 있지 않은 도구는 건너뛴다(Hub가 설치하지 않는다). */
async function syncTools(deps = {}) {
  const policy = require('./update-policy');
  const state = await readState(deps);
  const now = (deps.now || Date.now)();
  const results = [];
  for (const tool of deps.tools || TOOLS) {
    const prev = state.tools[tool.id];
    if (!deps.force && prev && now - Date.parse(prev.checkedAt) < DAY) continue;
    const row = { id: tool.id, checkedAt: new Date(now).toISOString() };
    try {
      row.installed = await installed(tool, deps);
      if (!row.installed) { row.outcome = 'not-installed'; }
      else {
        const l = await latest(tool, deps);
        row.latest = l.version;
        if (!l.version || compare(l.version, row.installed) <= 0) row.outcome = 'current';
        else {
          const risks = [...(major(row.installed, l.version) ? ['major-version'] : []), ...(l.wheel ? [] : ['build-from-source']), ...(l.yanked ? ['yanked'] : [])];
          let notes = '';
          try { notes = notesBetween(await getText(tool.notes, deps), row.installed, l.version); } catch (e) { notes = `(릴리스 노트를 읽지 못함: ${String(e.message || e).slice(0, 80)})`; }
          const publicText = [`도구: ${tool.package} (${tool.repository})`, `설치됨 ${row.installed} → 최신 ${l.version}`,
            `우리가 넘기는 플래그: ${(deps.toolFlags || ((t) => t.flags()))(tool).join(' ')}`, '', '## 릴리스 노트', notes || '(해당 구간 없음)'].join('\n');
          const r = await policy.handle({ source: 'tool', target: tool.id, kind: tool.kind, from: row.installed, to: l.version,
            title: `${tool.package} ${row.installed} → ${l.version}`, risks, publicText }, steps(tool, row.installed, l.version, deps), deps);
          row.outcome = r.decision;
        }
      }
    } catch (e) { row.outcome = 'error'; row.error = String(e.message || e).slice(0, 200); }
    state.tools[tool.id] = row;
    results.push(row);
  }
  await require('../atomic-file').writeAtomic(stateFile(deps), JSON.stringify(state, null, 1));
  return results;
}

// 사람이 승인한 대기 항목: 같은 세 단계로 적용한다(되돌림 포함).
require('./update-policy').registerExecutor('tool', async (row, deps = {}) => {
  const tool = (deps.tools || TOOLS).find((t) => t.id === row.target);
  if (!tool) throw new Error('알 수 없는 도구: ' + row.target);
  const s = steps(tool, row.from, row.to, deps);
  await s.apply();
  if (!(await s.check())) { await s.rollback(); throw new Error('계약 시험 실패 — 이전 버전으로 되돌림'); }
  return { version: row.to };
});

module.exports = { TOOLS, syncTools, installed, latest, notesBetween, contract, compare, major, uvBin };

// 공유 저장소(codex-shared-context)의 메모리·로그·skill·문서를 Hub 메모리 탭에서 찾아본다.
//
// 왜: Hub 로컬 메모리(memory.js)는 PC마다 따로 쌓이는 학습 노트용이고, 여러 PC·AI가 함께
// 쓰는 지식의 원본은 공유 저장소다. 둘이 이어져 있지 않아 메모리 탭이 07-17 메모 하나로
// 멈춰 보였다(2026-10-04). 저장소의 검색 도구(tools/find_context.py, BM25·한글 2-gram,
// 표준 라이브러리)를 그대로 불러 Codex가 쓰는 것과 같은 결과를 보여 준다.
//
// 읽기 전용이다. 저장소 파일을 쓰거나 메모리를 활성화하지 않는다 — 적용은 저장소의
// 승인 절차(메모리 제안 → 사용자 승인)가 한다. clone 위치는 PC마다 달라 기기 전용 설정
// sharedContext.repoPath에 두고, 비어 있으면 알려진 위치에서 찾는다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const KINDS = ['memory', 'log', 'skill', 'doc'];
const TIMEOUT_MS = 20000;
let pythonCache = null;
const unavailable = message => Object.assign(new Error(message), { code: 'shared_memory_unavailable' });

function run(file, args, { cwd, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    }, (error, stdout, stderr) => resolve({ ok: !error, code: error ? error.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

function isRepo(dir) {
  try {
    return Boolean(dir) && fs.statSync(dir).isDirectory() &&
      fs.existsSync(path.join(dir, 'tools', 'find_context.py')) && fs.existsSync(path.join(dir, 'AGENTS.md'));
  } catch { return false; }
}

function candidates(configured) {
  const home = os.homedir();
  if (require('./public-profile').enabled) return configured ? [configured] : [];
  return [configured, path.join(home, 'Documents', 'GitHub', 'codex-shared-context'),
    path.join(home, 'Documents', 'Codex', 'codex-shared-context')].filter(Boolean);
}

function configuredPath(deps) {
  const cfg = (deps.config || require('./config')).load();
  return String((cfg.sharedContext || {}).repoPath || '');
}

/** 쓸 clone 경로. 지정값이 유효하면 그것, 아니면 알려진 위치 중 첫 번째. */
function repoRoot(deps = {}) {
  const configured = configuredPath(deps);
  const shared = require('./shared-agent-context').manifest(deps);
  if (shared && (!configured || path.resolve(configured) === path.resolve(shared.sourceRepository)))
    return isRepo(shared.repositoryRoot) ? shared.repositoryRoot : null;
  return candidates(configured).find(isRepo) || null;
}

/** python 3 실행 파일. Microsoft Store 별칭(설치 안 됨)이 걸리지 않게 버전을 확인한다. */
async function python(deps = {}) {
  if (deps.python) return deps.python;
  if (pythonCache) return pythonCache;
  for (const [cmd, pre] of [['python', []], ['py', ['-3']], ['python3', []]]) {
    const r = await run(cmd, [...pre, '--version'], { timeout: 8000 });
    if (r.ok && /Python 3\./.test(r.stdout + r.stderr)) return (pythonCache = { cmd, args: pre });
  }
  return null;
}

async function status(deps = {}) {
  const configured = configuredPath(deps);
  const root = repoRoot(deps);
  const shared = require('./shared-agent-context').manifest(deps);
  const pinned = shared && root === shared.repositoryRoot;
  if (!root) return { found: false, configured, candidates: candidates(configured) };
  const head = pinned ? { ok: true, stdout: shared.readCommit + '\t\tCommon agent bootstrap (pinned)' }
    : await run('git', ['-C', root, 'log', '-1', '--format=%h%x09%cs%x09%s'], { timeout: 8000 });
  const [commit, date, subject] = head.ok ? head.stdout.trim().split('\t') : [];
  return {
    found: true, root, configured, configuredValid: Boolean(configured) && (path.resolve(configured) === path.resolve(root) ||
      (pinned && path.resolve(configured) === path.resolve(shared.sourceRepository))),
    readCommit: pinned ? shared.readCommit : null,
    head: commit ? { commit, date, subject: String(subject || '').slice(0, 120) } : null,
    python: Boolean(await python(deps)),
  };
}

async function sourceVersion(root) {
  const parts = [];
  for (const rel of ['.git/index', 'memory-proposals', 'skills', 'docs', 'skills/writing/log/logs']) {
    const st = await fs.promises.stat(path.join(root, rel)).catch(() => null);
    parts.push(st ? Math.floor(st.mtimeMs) : 0);
  }
  return parts.join('.');
}

async function search(query, { kinds = KINDS, limit = 8 } = {}, deps = {}) {
  const q = String(query || '').trim();
  if (!q || q.length > 200) throw new Error('검색어는 1~200자로 입력하세요.');
  const want = (Array.isArray(kinds) ? kinds : String(kinds).split(',')).map(String).filter((k) => KINDS.includes(k));
  if (!want.length) throw new Error('찾을 종류(메모리·로그·skill·문서)를 하나 이상 고르세요.');
  const root = repoRoot(deps);
  if (!root) throw unavailable('공유 저장소 clone을 찾지 못했습니다. 메모리 탭에서 경로를 지정하세요.');
  const py = await python(deps);
  if (!py) throw unavailable('공유 저장소 검색에는 Python 3가 필요합니다.');
  const n = Math.max(1, Math.min(20, Number(limit) || 8));
  const load = async () => {
    const r = await run(py.cmd, [...py.args, path.join(root, 'tools', 'find_context.py'), q, '--json', '--limit', String(n), '--kinds', want.join(',')], { cwd: root });
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
    if (!r.ok || !parsed || !Array.isArray(parsed.results)) throw unavailable('공유 저장소 검색이 실패했습니다. 저장소의 tools/find_context.py를 확인하세요.');
    return parsed;
  };
  // find_context.py는 질의마다 색인을 새로 만든다(수 초). 같은 질의는 세션을 넘어 캐시하고,
  // git 색인·주요 폴더의 수정 시각이 바뀌거나 10분이 지나면 다시 읽는다.
  const data = deps.noCache ? await load() : await (deps.cache || require('./cache/locality-cache').instance())
    .get(`${q}\u0000${want.join(',')}\u0000${n}`, { cls: 'memory', category: 'shared-repo', version: await sourceVersion(root), ttlMs: 10 * 60 * 1000, loader: load });
  return {
    root, counts: data.counts || {},
    results: data.results.slice(0, n).map((x) => ({
      kind: String(x.kind || ''), title: String(x.title || '').slice(0, 160), path: String(x.path || '').slice(0, 240),
      score: Number(x.score) || 0, snippet: String(x.snippet || '').slice(0, 400),
    })),
  };
}

/** 기기 전용 clone 경로 지정. 빈 값이면 자동 찾기로 돌아간다. */
function setRepo(dir, deps = {}) {
  const value = String(dir || '').trim();
  if (value && !isRepo(value)) throw new Error('codex-shared-context clone 폴더가 아닙니다(tools/find_context.py와 AGENTS.md가 있어야 합니다).');
  (deps.config || require('./config')).setLocalOnly('sharedContext.repoPath', value);
  return status(deps);
}

module.exports = { status, search, setRepo, repoRoot, isRepo, KINDS };

#!/usr/bin/env node
// 공유 저장소(codex-shared-context) 메모리 검색 회귀 테스트(shared-repo-memory.js). 실제 저장소 대신 가짜 clone(같은 CLI 계약의
// tools/find_context.py)을 만들어 인자 전달·한글 인코딩·출력 파싱·경로 검증을 확인한다.
// Python 3가 없는 컴퓨터에서는 건너뛴다(메모리 탭은 그때 "Python 3 필요"를 보여 준다).
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-smem-'));
process.env.APPDATA = SANDBOX;
process.env.USERPROFILE = SANDBOX; // 알려진 clone 위치(문서\GitHub …)를 가짜 홈으로 돌린다
process.env.HOME = SANDBOX;

const hasPython = ['python', 'py', 'python3'].some((cmd) => {
  const r = spawnSync(cmd, cmd === 'py' ? ['-3', '--version'] : ['--version'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && /Python 3\./.test(String(r.stdout) + String(r.stderr));
});
if (!hasPython) {
  console.log('Python 3가 없어 공유 저장소 검색 테스트를 건너뜁니다.');
  process.exit(0);
}

const shared = require('../src/core/shared-repo-memory');
const repo = path.join(SANDBOX, 'clone 한글');
fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# test\n');
// find_context.py와 같은 CLI 계약: query --json --limit N --kinds a,b → JSON
fs.writeFileSync(path.join(repo, 'tools', 'find_context.py'), [
  'import json, sys',
  'a = sys.argv[1:]',
  'q = a[0]; limit = int(a[a.index("--limit") + 1]); kinds = a[a.index("--kinds") + 1].split(",")',
  'if q == "broken": print("not json"); sys.exit(0)',
  'rows = [{"id": "x%d" % i, "kind": kinds[i % len(kinds)], "title": q, "path": "skills/s%d/SKILL.md" % i, "score": 10 - i, "snippet": "s" * 900} for i in range(limit + 3)]',
  'print(json.dumps({"schemaVersion": 1, "readOnly": True, "query": q, "counts": {k: 1 for k in kinds}, "results": rows}, ensure_ascii=False))',
].join('\n'));

let stored = '';
const deps = {
  config: { load: () => ({ sharedContext: { repoPath: stored } }), setLocalOnly: (p, v) => { assert.equal(p, 'sharedContext.repoPath'); stored = v; } },
};

(async () => {
  // 1) clone을 못 찾으면 이유를 말한다(검색은 실행하지 않는다)
  const none = await shared.status(deps);
  assert.equal(none.found, false);
  await assert.rejects(shared.search('하드웨어', {}, deps), /clone을 찾지 못했습니다/);

  // 2) 경로 지정: clone이 아닌 폴더는 거절, 맞으면 기기 전용 설정에 저장
  assert.throws(() => shared.setRepo(SANDBOX, deps), /clone 폴더가 아닙니다/);
  const st = await shared.setRepo(repo, deps);
  assert.equal(stored, repo); assert.equal(st.found, true); assert.equal(st.root, repo); assert.equal(st.configuredValid, true);
  assert.equal(st.python, true); assert.equal(st.head, null); // git 저장소가 아니면 커밋 정보는 비운다

  // 3) 검색: 한글 질의·종류·개수가 그대로 전달되고, 결과는 상한과 길이 제한을 지킨다
  const r = await shared.search('하드웨어 위임', { kinds: ['memory', 'log', 'bogus'], limit: 3 }, deps);
  assert.equal(r.results.length, 3);
  assert.equal(r.results[0].title, '하드웨어 위임');
  assert.deepEqual([...new Set(r.results.map((x) => x.kind))].sort(), ['log', 'memory']);
  assert.equal(r.results[0].snippet.length, 400);
  assert.deepEqual(r.counts, { memory: 1, log: 1 });

  // 4) 입력 검증과 도구 고장
  await assert.rejects(shared.search('', {}, deps), /1~200자/);
  await assert.rejects(shared.search('x'.repeat(201), {}, deps), /1~200자/);
  await assert.rejects(shared.search('q', { kinds: ['bogus'] }, deps), /하나 이상/);
  await assert.rejects(shared.search('broken', {}, deps), /검색이 실패했습니다/);

  // Bootstrap path checks remain mandatory.
  const bootstrap = path.join(SANDBOX, 'bootstrap.json');
  for (let i = 0; i < 3; i++) {
    const file = path.join(repo, 'skills', 's' + i, 'SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '# owned reference');
  }
  const manifest = { schemaVersion: 1, readCommit: 'b'.repeat(40), sourceRepository: repo,
    repositoryRoot: repo, skillRoot: path.join(repo, 'skills'), skills: [] };
  fs.writeFileSync(bootstrap, JSON.stringify(manifest));
  const pinned = { ...deps, config: { load: () => ({ sharedContext: { repoPath: repo, bootstrapPath: bootstrap } }) } };
  assert.equal((await shared.status(pinned)).readCommit, 'b'.repeat(40));
  fs.writeFileSync(bootstrap, JSON.stringify({ ...manifest, repositoryRoot: path.dirname(SANDBOX) }));
  await assert.rejects(shared.status(pinned), /outside its local root/);

  // 5) 빈 값이면 자동 찾기로 돌아간다
  await shared.setRepo('', deps);
  assert.equal(stored, '');
  assert.equal((await shared.status(deps)).found, false);

  console.log('Shared memory: repo detection, device-only path validation, Hangul query and kinds passthrough, result limits, input and tool failure handling passed');
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* temp */ } });

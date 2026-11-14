'use strict';
// 지식 그래프 노드 역할(knowledge-roles): 경로 → 역할·용도, 스킬 그래프의 캐시·사용 기록 노드와 최신 여부, 원본 hub:data.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-kgr-'));
let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); } }
const roles = require('../src/core/knowledge-roles');
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

(async () => {
  await check('paths map to roles', async () => {
    const r = (p, kind = 'file') => roles.roleOf({ path: p, kind });
    assert.strictEqual(r('skills/CATALOG.md'), 'catalog');
    assert.strictEqual(r('skills/catalog.json'), 'catalog');
    assert.strictEqual(r('skills/development/ponytail/SKILL.md'), 'skill');
    assert.strictEqual(r('skills/writing/log/references/CATALOG.md'), 'subskill');
    assert.strictEqual(r('skills/writing/log/references/incident-followup.md'), 'subskill');
    assert.strictEqual(r('skills/writing/log/logs/INDEX.json'), 'log');
    assert.strictEqual(r('skills/writing/log/logs/a/b/x.md'), 'log');
    assert.strictEqual(r('memory-proposals/approved/m.md'), 'memory');
    assert.strictEqual(r('config/delegation-reliability.json'), 'config');
    assert.strictEqual(r('skills/x/agents/openai.yaml'), 'config');
    assert.strictEqual(r('evolve/state.json'), 'data');
    assert.strictEqual(r('skills/x/scripts/run.py'), 'script');
    assert.strictEqual(r('docs/setup.md'), 'doc');
    assert.strictEqual(r('skills', 'directory'), 'directory');
    assert.strictEqual(roles.roleOf({ path: 'n1', kind: 'note' }), 'memory');
    assert.strictEqual(roles.roleOf({ path: 'a#b', kind: 'symbol' }), 'symbol');
  });
  await check('purpose: known files, a skill description\'s first sentence, else the role', async () => {
    const g = roles.annotate({ nodes: [{ path: 'skills/catalog.json', kind: 'file' }, { path: 'skills/a/x/SKILL.md', kind: 'skill', description: 'Do the thing. Then more.' }, { path: 'docs/a.md', kind: 'file' }] });
    assert.match(g.nodes[0].purpose, /skill_find/);
    assert.strictEqual(g.nodes[1].purpose, 'Do the thing.');
    assert.strictEqual(g.nodes[2].purpose, roles.ROLES.doc.purpose);
  });

  await check('skill descriptions written as a folded block (description: >) are read, not left empty', async () => {
    const { frontmatter } = require('../src/core/repository-skills');
    assert.deepStrictEqual(frontmatter('---\nname: ponytail\ndescription: >\n  첫 줄 설명.\n  둘째 줄.\n---\n# x', 'f'), { name: 'ponytail', description: '첫 줄 설명. 둘째 줄.' });
    assert.deepStrictEqual(frontmatter('---\nname: "q"\ndescription: one line\n---\n', 'f'), { name: 'q', description: 'one line' });
    assert.deepStrictEqual(frontmatter('# no front matter', 'fallback'), { name: 'fallback', description: '' });
  });

  const repo = path.join(scratch, 'repo'), data = path.join(scratch, 'data');
  put(path.join(repo, 'skills', 'catalog.json'), JSON.stringify({ schemaVersion: 1, skills: [{ name: 'a', path: 'skills/dev/a/SKILL.md', bytes: 5 }, { name: 'b', path: 'skills/dev/b/SKILL.md', bytes: 99 }] }));
  const cacheDir = path.join(data, 'locality-cache', 'catalog', 'skills');
  put(path.join(cacheDir, 'abc123.json'), JSON.stringify({ key: 'index', version: 'v1', storedAt: 2000, value: { docs: [{ kind: 'skill', name: 'a', path: 'skills/dev/a/SKILL.md' }] } }));
  put(path.join(data, 'locality-cache', 'metrics.json'), JSON.stringify({ lifetime: { 'catalog/skills': { hits: 7, misses: 2, stale: 1 } },
    days: { '2026-10-22': { 'catalog/skills': { hits: 3 } }, '2026-10-23': { 'catalog/skills': { diskHits: 1 } }, '2026-10-24': { 'catalog/skills': { misses: 2 } } } }));
  put(path.join(data, 'skill-usage.json'), JSON.stringify({ 'skill:b': 3, $byHarness: { 'skill:b': { codex: 3 } } }));
  const graph = () => ({ key: 'skills:repository', nodes: [
    { id: 'n-a', kind: 'skill', label: 'a', path: 'skills/dev/a/SKILL.md', bytes: 5, mtimeMs: 1000 },
    { id: 'n-b', kind: 'skill', label: 'b', path: 'skills/dev/b/SKILL.md', bytes: 6, mtimeMs: 3000 },
    { id: 'n-c', kind: 'file', label: 'catalog.json', path: 'skills/catalog.json', bytes: 50 }], edges: [], warnings: [] });

  await check('skill graph: catalog freshness, cached index → cached skills, usage DB → counted skills', async () => {
    const g = await roles.enrichSkills(graph(), { repoRoot: repo, dataDir: data });
    const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    assert.strictEqual(by['n-a'].freshness.ok, true);
    assert.strictEqual(by['n-b'].freshness.ok, false); // catalog.json의 크기와 다르다
    assert.match(by['n-c'].freshness.note, /1개/);
    const cache = g.nodes.find((n) => n.role === 'cache' && n.label === '캐시된 스킬 색인');
    assert.deepStrictEqual(cache.cacheStats, { hits: 7, misses: 2, stale: 1 });
    assert.strictEqual(cache.lastAccess, '2026-10-23'); // 적중이 있던 마지막 날(미스만 있던 10-24는 참조가 아니다)
    assert.strictEqual(cache.freshness.ok, false); // b(3000)가 캐시(2000)보다 새롭다
    assert.strictEqual(by['n-a'].cachedAt, 2000); assert.ok(!by['n-b'].cachedAt);
    const rel = (r) => g.edges.filter((e) => e.relation === r).map((e) => `${by[e.source]?.label || e.source}>${by[e.target]?.label || e.target}`);
    assert.deepStrictEqual(rel('caches'), ['캐시된 스킬 색인>a']);
    assert.deepStrictEqual(rel('warms'), []); // 1.32.39: 예열(hot.json) 없음
    assert.deepStrictEqual(rel('counts'), ['skill-usage.json>b']);
  });
  await check('hub:data lists only known data, cache and config files — never local secrets', async () => {
    put(path.join(data, 'config.local.json'), '{"hub":{"authToken":"dummy"}}');
    put(path.join(data, 'credentials.local', 'x.bin'), 'x');
    put(path.join(data, 'projects.json'), '[]');
    const g = await roles.hubDataGraph('hub:data', data);
    const paths = g.nodes.map((n) => n.path);
    assert.ok(paths.includes('hub-data/skill-usage.json') && paths.includes('hub-data/projects.json') && paths.includes('hub-data/locality-cache/catalog/skills'));
    assert.ok(!paths.some((p) => /\.local|credential/.test(p)), paths.join(','));
    assert.ok(g.nodes.every((n) => !n.body));
    const cache = g.nodes.find((n) => n.path === 'hub-data/locality-cache/catalog/skills');
    assert.strictEqual(cache.kind, 'directory'); assert.strictEqual(cache.files, 1); assert.strictEqual(cache.cachedDocs, 1);
    // 두 원본의 같은 데이터 파일은 같은 id — 통합 그래프에서 한 노드가 된다
    const skillGraph = await roles.enrichSkills(graph(), { repoRoot: repo, dataDir: data });
    assert.ok(skillGraph.nodes.some((n) => n.id === g.nodes.find((x) => x.path === 'hub-data/skill-usage.json').id));
  });

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`knowledge roles: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

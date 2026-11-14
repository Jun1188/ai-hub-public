// 결정적 구조 감사: 요구(require) 그래프·순환·중복·계층 위반·고아 파일·복잡도 핫스팟.
// 모델을 쓰지 않으므로 평가 1계층과 RSI 루프의 "스파게티 지표"가 매번 같은 입력에 같은 값을 낸다.
//   node src/core/architecture/structure-audit.js [앱 루트] [--json]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCAN_DIRS = ['src', 'electron', 'ui'];
const CODE = /\.(c?js)$/;
const SHINGLE = 6; // 6줄 미만 반복은 관용구(import 묶음·try/catch)라 중복으로 치지 않는다
const LINE_BUDGET = 700;
const MAP_FILE = path.join(__dirname, 'module-map.json');

const posix = (p) => p.split(path.sep).join('/');

async function walk(root, rel, out) {
  let entries;
  try { entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(root, child, out);
    else if (CODE.test(e.name) || e.name.endsWith('.json')) out.push(child);
  }
  return out;
}

// 문자열·주석을 대충 걷어 낸다 — 분기 수와 중복 비교가 주석 문구에 흔들리지 않게.
function stripNoise(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

// 함수 안의 require(지연 로드)는 순환을 깨려고 일부러 쓴 것이라 로드 순서 위험이 없다.
// 중괄호 깊이 0에서 부르는 것만 eager로 본다 — 문자열 속 중괄호는 드물어 근사로 충분하다.
function requiresOf(src) {
  const out = [];
  const re = /require\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  const depthAt = [];
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    depthAt[i] = depth;
  }
  let m;
  while ((m = re.exec(src))) out.push({ spec: m[1], eager: (depthAt[m.index] || 0) === 0 });
  return out;
}

function resolveRequire(fromRel, spec, known) {
  if (!spec.startsWith('.')) return null; // 패키지·node: 내장은 그래프 밖
  const base = posix(path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec)));
  for (const c of [base, `${base}.js`, `${base}.cjs`, `${base}.json`, `${base}/index.js`]) if (known.has(c)) return c;
  return null;
}

function complexityOf(code) {
  const m = code.match(/\b(if|for|while|case|catch)\b|&&|\|\||\?\?|\?(?![.:])/g);
  return 1 + (m ? m.length : 0);
}

function exportsOf(code) {
  const m = code.match(/module\.exports\s*=\s*\{([^}]*)\}/);
  if (!m) return /module\.exports\s*=/.test(code) ? 1 : 0;
  return m[1].split(',').map((s) => s.trim()).filter(Boolean).length;
}

// Tarjan SCC — 크기 2 이상이 순환 의존이다.
function cycles(nodes, edges) {
  let index = 0;
  const idx = new Map(), low = new Map(), stack = [], on = new Set(), out = [];
  const visit = (v) => {
    idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
    for (const w of edges.get(v) || []) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) out.push(comp.sort());
    }
  };
  for (const v of nodes) if (!idx.has(v)) visit(v);
  return out;
}

function duplicates(files) {
  const seen = new Map();
  for (const f of files) {
    const lines = stripNoise(f.text).split('\n').map((l) => l.trim().replace(/\s+/g, ' '))
      .map((l, i) => ({ l, n: i + 1 })).filter((x) => x.l.length > 3 && !/^[}\])]+;?,?$/.test(x.l));
    for (let i = 0; i + SHINGLE <= lines.length; i++) {
      const key = crypto.createHash('sha1').update(lines.slice(i, i + SHINGLE).map((x) => x.l).join('\n')).digest('hex');
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push({ path: f.path, line: lines[i].n });
    }
  }
  const clusters = [];
  const dupLines = new Map();
  for (const [key, hits] of seen) {
    const filesHit = new Set(hits.map((h) => h.path));
    if (filesHit.size < 2) continue;
    clusters.push({ key: key.slice(0, 12), sites: hits.slice(0, 6) });
    for (const h of hits) dupLines.set(h.path, (dupLines.get(h.path) || 0) + 1);
  }
  // 겹치는 shingle은 같은 블록이라 첫 지점이 연속인 것끼리 하나로 묶는다.
  clusters.sort((a, b) => a.sites[0].path.localeCompare(b.sites[0].path) || a.sites[0].line - b.sites[0].line);
  const merged = [];
  for (const c of clusters) {
    const last = merged[merged.length - 1];
    if (last && last.sites[0].path === c.sites[0].path && c.sites[0].line - last.end <= 2 && last.sites.length === c.sites.length) {
      last.end = c.sites[0].line; last.lines++;
    } else merged.push({ ...c, end: c.sites[0].line, lines: SHINGLE });
  }
  return { clusters: merged.sort((a, b) => b.lines - a.lines), dupLines };
}

function domainOf(rel, map) {
  for (const [name, globs] of Object.entries(map.domains)) {
    for (const g of globs) if (g.endsWith('/') ? rel.startsWith(g) : rel === g) return name;
  }
  return null;
}

async function loadMap(file = MAP_FILE) {
  return JSON.parse((await fs.promises.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

/** 감사 본체. root는 앱 루트(package.json이 있는 곳). */
async function audit(root, { map } = {}) {
  map = map || await loadMap();
  const rels = [];
  for (const d of SCAN_DIRS) await walk(root, d, rels);
  const known = new Set(rels);
  const files = [];
  for (const rel of rels) {
    if (!CODE.test(rel)) continue;
    const text = await fs.promises.readFile(path.join(root, rel), 'utf8');
    files.push({ path: rel, text });
  }
  const edges = new Map();
  const eagerEdges = new Map();
  const fanIn = new Map();
  const violations = [];
  for (const f of files) {
    const outs = [];
    const eager = [];
    for (const { spec, eager: isEager } of requiresOf(stripNoise(f.text))) {
      const target = resolveRequire(f.path, spec, known);
      if (!target) continue;
      outs.push(target);
      if (isEager) eager.push(target);
      fanIn.set(target, (fanIn.get(target) || 0) + 1);
      for (const [prefix, rule] of Object.entries(map.layers || {})) {
        if (!f.path.startsWith(prefix)) continue;
        for (const bad of rule.mayNotRequire || []) {
          if (target.startsWith(bad)) violations.push({ from: f.path, to: target, rule: `${prefix} → ${bad}` });
        }
      }
    }
    edges.set(f.path, [...new Set(outs)]);
    eagerEdges.set(f.path, [...new Set(eager)]);
  }
  const { clusters, dupLines } = duplicates(files);
  const corpus = files.map((f) => f.text).join('\n');
  const entry = new Set(map.entrypoints || []);
  const staged = new Set(map.staged || []);
  const rows = files.map((f) => {
    const code = stripNoise(f.text);
    const lines = f.text.split('\n').length;
    const cx = complexityOf(code);
    const inn = fanIn.get(f.path) || 0;
    const base = path.posix.basename(f.path).replace(/\.c?js$/, '');
    // ui/는 <script> 전역이라 require가 없다 — index.html의 로드 목록이 진입점 역할을 한다.
    // 문자열 목록으로 불러오는 모듈(조립 루트의 연산 목록 등)은 확장자 없는 이름이 다른 파일에 있으면 쓰이는 것으로 본다.
    const weakRef = f.path.startsWith('ui/') || corpus.split(`/${base}'`).length > 1 || corpus.split(base + '.js').length > 2;
    return {
      path: f.path, domain: domainOf(f.path, map), lines, complexity: cx, fanIn: inn,
      fanOut: (edges.get(f.path) || []).length, exports: exportsOf(code),
      duplicateShingles: dupLines.get(f.path) || 0, overBudget: lines > LINE_BUDGET,
      orphan: inn === 0 && !entry.has(f.path) && !staged.has(f.path) && !weakRef && !f.path.startsWith('electron/ipc/'),
    };
  });
  // 아래 도메인이 위 도메인을 부르는 의존(지연 require 포함) — 결합 덩어리를 만드는 주범이다.
  const order = map.order || [];
  const upward = [];
  const domainByPath = new Map(rows.map((r) => [r.path, r.domain]));
  for (const [from, outs] of edges) {
    for (const to of outs) {
      const a = order.indexOf(domainByPath.get(from)), b = order.indexOf(domainByPath.get(to));
      if (a >= 0 && b >= 0 && a < b) upward.push({ from, to, fromDomain: domainByPath.get(from), toDomain: domainByPath.get(to) });
    }
  }
  // eager 순환은 require 순서에 따라 한쪽이 빈 exports를 받는 실제 결함, 전체 순환은 결합도 지표다.
  // 한 도메인 안의 상호 의존은 응집된 모듈이고, 도메인을 가로지르는 묶음만 정리 대상이다.
  const scc = cycles(files.map((f) => f.path), eagerEdges);
  const coupled = cycles(files.map((f) => f.path), edges).map((c) => {
    const ds = [...new Set(c.map((p) => domainByPath.get(p) || '(unclassified)'))].sort();
    return { files: c, domains: ds, crossDomain: ds.length > 1 };
  });
  const hotspots = rows.map((r) => ({ path: r.path, score: Math.round(r.complexity * Math.log2(2 + r.fanIn) * (r.lines / 100)) }))
    .sort((a, b) => b.score - a.score).slice(0, 15);
  const domains = {};
  for (const r of rows) {
    const d = r.domain || '(unclassified)';
    domains[d] = domains[d] || { files: 0, lines: 0 };
    domains[d].files++; domains[d].lines += r.lines;
  }
  const totalLines = rows.reduce((s, r) => s + r.lines, 0);
  const dupTotal = rows.reduce((s, r) => s + r.duplicateShingles, 0);
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    totals: {
      files: rows.length, lines: totalLines, edges: [...edges.values()].reduce((s, e) => s + e.length, 0),
      cycles: scc.length, coupledFiles: coupled.filter((c) => c.crossDomain).reduce((s, c) => s + c.files.length, 0),
      cohesiveClusters: coupled.filter((c) => !c.crossDomain).length,
      duplicateClusters: clusters.length, duplicateRatio: +(dupTotal / Math.max(1, totalLines)).toFixed(4),
      layerViolations: violations.length, upwardDependencies: upward.length, orphans: rows.filter((r) => r.orphan).length,
      unclassified: rows.filter((r) => !r.domain).length, overBudget: rows.filter((r) => r.overBudget).length,
    },
    domains, cycles: scc, coupled, upward, staged: [...staged], violations, hotspots,
    duplicates: clusters.slice(0, 40).map((c) => ({ lines: c.lines, sites: c.sites })),
    orphans: rows.filter((r) => r.orphan).map((r) => r.path),
    unclassified: rows.filter((r) => !r.domain).map((r) => r.path),
    files: rows,
  };
}

/** 0~1 구조 점수. 평가 1계층이 같은 공식을 쓴다 — 가중치를 바꾸면 기준선이 바뀐다. */
function structureScore(report) {
  const t = report.totals;
  const parts = {
    cycles: t.cycles === 0 ? 1 : Math.max(0, 1 - t.cycles / 5),
    coupling: Math.max(0, 1 - (t.coupledFiles || 0) / Math.max(1, t.files)),
    layers: t.layerViolations === 0 ? 1 : Math.max(0, 1 - t.layerViolations / 10),
    direction: Math.max(0, 1 - (t.upwardDependencies || 0) / 20),
    duplication: Math.max(0, 1 - t.duplicateRatio * 10),
    budget: t.overBudget === 0 ? 1 : 0,
    classified: 1 - t.unclassified / Math.max(1, t.files),
    orphans: Math.max(0, 1 - t.orphans / 20),
  };
  const score = Object.values(parts).reduce((s, v) => s + v, 0) / Object.keys(parts).length;
  return { score: +score.toFixed(4), parts };
}

module.exports = { audit, structureScore, loadMap, cycles, requiresOf, resolveRequire, complexityOf, duplicates };

if (require.main === module) {
  const root = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../..');
  audit(root).then((r) => {
    if (process.argv.includes('--json')) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); return; }
    const s = structureScore(r);
    console.log(`files ${r.totals.files} · lines ${r.totals.lines} · cycles ${r.totals.cycles} (coupled ${r.totals.coupledFiles}) · dup ${(r.totals.duplicateRatio * 100).toFixed(1)}% · layer ${r.totals.layerViolations} · orphans ${r.totals.orphans} · unclassified ${r.totals.unclassified} · score ${s.score}`);
    for (const h of r.hotspots.slice(0, 8)) console.log(`  hotspot ${h.score}\t${h.path}`);
    for (const c of r.cycles) console.log(`  cycle ${c.join(' → ')}`);
    for (const c of r.coupled.filter((x) => x.crossDomain)) console.log(`  coupled [${c.domains.join(', ')}] ${c.files.join(' ')}`);
    for (const v of r.violations) console.log(`  layer ${v.from} → ${v.to}`);
    for (const u of r.upward) console.log(`  upward ${u.from} [${u.fromDomain}] → ${u.to} [${u.toDomain}]`);
    for (const d of r.duplicates.slice(0, 8)) console.log(`  dup ${d.lines}+ lines: ${d.sites.map((x) => `${x.path}:${x.line}`).join(', ')}`);
    for (const o of r.orphans) console.log(`  orphan ${o}`);
    for (const u of r.unclassified) console.log(`  unclassified ${u}`);
  }).catch((e) => { console.error(e); process.exitCode = 1; });
}

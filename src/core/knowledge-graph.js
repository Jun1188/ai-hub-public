'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const computerId = os.hostname();
const io = fs.promises;
const { within } = require('./repository-skills');
const { isSensitivePath, readCheckedFile } = require('./harness-bridge/virtual-workspace');
const id = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
const slash = value => String(value).split(path.sep).join('/');
const clean = text => String(text).replace(/^\uFEFF/, '');
const base = () => path.join(require('./paths').hubDataDir(), 'knowledge-graph');
const limits = { nodes: 60000, edges: 180000, files: 30000, bytes: 32 * 1024 ** 2, text: 1000000, body: 3000 };
const skip = new Set(['.git','.obsidian','node_modules','Intermediate','Binaries','DerivedDataCache','ThirdParty','knowledge-graph','vaults']);
const sensitive = name => /^(?:\.env(?:\..*)?|.*\.local\.json|.*\.(?:pem|key|pfx|p12)|credentials.*|token.*)$/i.test(name);
const running = new Map();
const cache = new Map();
async function readJson(file) {
  const st = await io.stat(file);
  if (st.size > 128 * 1024 ** 2) throw new Error('인덱스가 너무 큽니다. 범위를 좁혀 주세요.');
  return JSON.parse(clean(await io.readFile(file, 'utf8')));
}
async function atomic(file, value) {
  await io.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + crypto.randomUUID();
  try { await io.writeFile(tmp, '\uFEFF' + JSON.stringify(value), 'utf8'); await io.rename(tmp, file); }
  finally { await io.rm(tmp, { force: true }); }
}
function collectionKey(kind, name) { return `${kind}:${name}`; }
function graphFile(key) { return path.join(base(), 'collections', id(key) + '.json'); }

function builder(key, root, label) {
  const nodes = new Map(), edges = new Map(), warnings = new Set();
  const observedAt = new Date().toISOString();
  let textBytes = 0;
  function node(kind, relative, extra = {}) {
    const identity = `${extra.computerId || computerId}:${kind}:${path.resolve(root || '.', relative)}`, nid = id(identity);
    if (!nodes.has(nid)) {
      if (nodes.size >= limits.nodes) { warnings.add('노드 상한에 도달했습니다. 범위를 좁혀 새로 수집하세요.'); return null; }
      let body = String(extra.body || '').slice(0, limits.body);
      if (textBytes + Buffer.byteLength(body) > limits.bytes) { body = ''; warnings.add('본문 색인 상한: 일부 본문은 포함하지 않았습니다.'); }
      textBytes += Buffer.byteLength(body);
      nodes.set(nid, { id: nid, kind, path: relative, label: extra.label || path.posix.basename(relative) || label, evidence: 'EXTRACTED', computerId, scope: key, status: 'collected', observedAt, ...extra, body });
    }
    return nid;
  }
  function edge(source, target, relation, evidence = 'EXTRACTED', location = '') {
    if (!source || !target || !nodes.has(source) || !nodes.has(target)) return;
    if (edges.size >= limits.edges) { warnings.add('관계 상한에 도달했습니다.'); return; }
    const eid = `${source}|${target}|${relation}`;
    edges.set(eid, { source, target, relation, evidence, location, computerId, scope: key,
      targetComputerId: nodes.get(target).computerId, targetScope: nodes.get(target).scope, status: nodes.get(target).status, observedAt: nodes.get(target).observedAt });
  }
  function file(relative, extra = {}) {
    relative = slash(relative);
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return null;
    const parts = relative.split('/');
    let parent = node('directory', '.', { label });
    for (let i = 1; i < parts.length; i++) {
      const dir = node('directory', parts.slice(0, i).join('/'));
      edge(parent, dir, 'contains'); parent = dir;
    }
    const nid = node('file', relative, { file: path.resolve(root, relative), ...extra });
    edge(parent, nid, 'contains'); return nid;
  }
  return { node, edge, file, nodes, warnings, finish: () => ({ version: 2, key, root, label, computerId,
    updatedAt: new Date().toISOString(), nodes: [...nodes.values()], edges: [...edges.values()], warnings: [...warnings] }) };
}

async function scan(rootInput, key, label, progress = () => {}, cancelled = () => false, options = {}) {
  if (isSensitivePath(rootInput)) throw new Error('민감 디렉터리는 수집할 수 없습니다.');
  const root = await io.realpath(rootInput), b = builder(key, root, label);
  if (isSensitivePath(root)) throw new Error('민감 디렉터리는 수집할 수 없습니다.');
  const files = new Map(), texts = new Map(), stack = [path.join(root, options.start || '.')];
  const restoredEdges = [], typedSources = new Set();
  let count = 0, visited = 0, totalBytes = 0;
  while (stack.length) {
    if (cancelled()) throw new Error('수집을 취소했습니다. 이전 그래프는 보존했습니다.');
    const dir = stack.pop();
    let entries;
    try { entries = await io.readdir(dir, { withFileTypes: true }); }
    catch (e) { b.warnings.add(`읽기 실패: ${slash(path.relative(root, dir))} (${e.code})`); continue; }
    for (const e of entries) {
      if (e.isSymbolicLink() || e.name.startsWith('.') || skip.has(e.name) || sensitive(e.name) || isSensitivePath(e.name)) continue;
      if (++visited > limits.files * 4) { b.warnings.add('디렉터리 항목 상한에 도달했습니다.'); stack.length = 0; break; }
      const abs = path.join(dir, e.name), relative = slash(path.relative(root, abs));
      if (e.isDirectory()) { b.file(relative + '/.directory', { virtual: true }); stack.push(abs); continue; }
      if (!e.isFile()) continue;
      if (++count > limits.files) { b.warnings.add('파일 상한에 도달했습니다. 일부 파일은 미수집입니다.'); stack.length = 0; break; }
      const stat = await io.stat(abs);
      if (stat.nlink !== 1) continue;
      const nid = b.file(relative, { bytes: stat.size, mtimeMs: stat.mtimeMs });
      files.set(relative.toLocaleLowerCase(), nid);
      if (/\.(md|markdown)$/i.test(e.name) && stat.size <= limits.text && totalBytes + stat.size <= limits.bytes) {
        const text = clean((await readCheckedFile(root, abs, abs, limits.text)).toString('utf8')); totalBytes += stat.size;
        texts.set(relative, text);
        if (nid) {
          const n = b.nodes.get(nid), meta = require('./obsidian/vault-notes').metadata(text);
          n.body = text;
          n.aliases = Array.isArray(meta.aliases) ? meta.aliases.filter(a => typeof a === 'string') : [];
          n.label = String(meta.title || n.aliases[0] || /^#\s+(.+)$/m.exec(text)?.[1] || n.label);
          if (options.vault && /^[a-f0-9]{32}$/.test(meta.hub_id || '')) {
            n.originalId = meta.hub_id;
            n.hubImported = true;
            if (/^[a-z][\w-]{0,40}$/.test(meta.kind || '')) n.kind = meta.kind;
            if (/^[a-z][\w-]{0,40}$/.test(meta.role || '')) n.role = meta.role;
            n.sourceLocation = typeof meta.source_path === 'string' ? meta.source_path : relative;
            n.computerId = typeof meta.computer_id === 'string' ? meta.computer_id : computerId;
            n.scope = typeof meta.source_scope === 'string' ? meta.source_scope : key;
            if (['EXTRACTED','INFERRED','AMBIGUOUS'].includes(meta.evidence)) n.evidence = meta.evidence;
            if (typeof meta.observed_at === 'string' && Number.isFinite(Date.parse(meta.observed_at))) n.observedAt = meta.observed_at;
            if (['collected','reported','location-unknown'].includes(meta.location_status)) n.status = meta.location_status;
            if (typeof meta.purpose === 'string') n.purpose = meta.purpose;
            if (Number.isSafeInteger(meta.source_line) && meta.source_line > 0) n.line = meta.source_line;
            if (Array.isArray(meta.hub_edges)) {
              typedSources.add(meta.hub_id);
              for (const e of meta.hub_edges) {
                if (restoredEdges.length >= limits.edges) { b.warnings.add('가져온 관계 상한에 도달했습니다.'); break; }
                if (e && /^[a-f0-9]{32}$/.test(e.target || '') && /^[\w-]{1,60}$/.test(e.relation || ''))
                  restoredEdges.push({ ...e, source: meta.hub_id });
              }
            }
          }
        }
      }
    }
    progress({ phase: 'scanning', files: count });
    await new Promise(resolve => setImmediate(resolve));
  }
  const names = new Map();
  for (const [relative, nid] of files) {
    const stem = path.posix.basename(relative).replace(/\.(md|markdown)$/i, '');
    names.set(stem, [...(names.get(stem) || []), nid]);
    for (const alias of b.nodes.get(nid)?.aliases || []) {
      const name = alias.toLocaleLowerCase();
      names.set(name, [...new Set([...(names.get(name) || []), nid])]);
    }
  }
  for (const [relative, text] of texts) {
    if (cancelled()) throw new Error('수집을 취소했습니다.');
    const source = files.get(relative.toLocaleLowerCase());
    // Fenced and inline code are examples, not file links.
    const prose = text.replace(/```[^]*?```|~~~[^]*?~~~/g, '').replace(/`[^`\n]*`/g, '');
    const links = [...prose.matchAll(/\[\[([^\]\n]+)\]\]|\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g)];
    for (const match of links) {
      const wiki = Boolean(match[1]);
      let target = (match[1] || match[2]).replace(/^<|>$/g, '').split('|')[0].split('#')[0];
      if (!target || /^(?:[a-z]+:|\/\/)/i.test(target)) continue;
      try { target = decodeURIComponent(target); } catch { continue; }
      target = target.replace(/\\/g, '/');
      const candidates = wiki ? [target, path.posix.join(path.posix.dirname(relative), target)] : [path.posix.join(path.posix.dirname(relative), target)];
      let destination;
      for (const candidate of candidates) {
        destination = files.get(path.posix.normalize(candidate).toLocaleLowerCase()) || files.get((path.posix.normalize(candidate) + '.md').toLocaleLowerCase());
        if (destination) break;
      }
      if (!destination && wiki && !target.includes('/')) {
        const found = names.get(target.replace(/\.md$/i, '').toLocaleLowerCase()) || [];
        if (found.length === 1) destination = found[0];
        else if (found.length > 1) b.warnings.add(`동명 링크 미해결: ${relative} → ${target}`);
      }
      // A skills-only walk may link to contracts elsewhere in the same repository.
      if (!destination && options.start) {
        for (const candidate of candidates) {
          const normalized = path.posix.normalize(candidate);
          if (normalized.split('/').some(p => p.startsWith('.') || skip.has(p) || sensitive(p))) continue;
          const absolute = path.resolve(root, normalized);
          if (!within(root, absolute) || count >= limits.files) continue;
          try {
            const real = await io.realpath(absolute);
            if (!within(root, real) || slash(path.relative(root, real)).split('/').some(p => p.startsWith('.') || skip.has(p) || sensitive(p))) continue;
            const stat = await io.stat(real);
            if (!stat.isFile() || stat.nlink !== 1) continue;
            let body = '';
            if (/\.(md|markdown)$/i.test(real) && stat.size <= limits.text && totalBytes + stat.size <= limits.bytes) {
              body = clean((await readCheckedFile(root, absolute, real, limits.text)).toString('utf8')); totalBytes += stat.size;
            }
            destination = b.file(normalized, { bytes: stat.size, mtimeMs: stat.mtimeMs, body });
            files.set(normalized.toLocaleLowerCase(), destination); count++;
            break;
          } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes(e.code)) b.warnings.add(`참조 읽기 실패: ${normalized} (${e.code})`); }
        }
      }
      if (destination) b.edge(source, destination, 'links', 'EXTRACTED', relative);
      else {
        const reference = path.posix.normalize(candidates[0]);
        const record = (options.locations || []).find(r => r?.path === reference);
        const locations = (Array.isArray(record?.locations) ? record.locations : []).filter(l => l && typeof l.computerId === 'string' && l.computerId.trim() &&
          typeof l.scope === 'string' && l.scope.trim() && typeof l.path === 'string' && l.path.trim() &&
          !path.win32.isAbsolute(l.path) && !path.posix.isAbsolute(l.path) && !l.path.split(/[\\/]/).includes('..') && typeof l.evidence === 'string' && l.evidence.trim() &&
          typeof l.observedAt === 'string' && Number.isFinite(Date.parse(l.observedAt)));
        // A report from another PC is a dated observation, never proof of current local availability.
        for (const loc of locations.length ? locations : [null]) {
          const status = loc ? 'reported' : 'location-unknown';
          const ref = b.node('reference', `references/${id(reference + ':' + (loc ? JSON.stringify(loc) : 'unknown'))}`, {
            label: path.posix.basename(reference), sourceLocation: reference, evidence: 'AMBIGUOUS',
            computerId: loc?.computerId || 'unknown', scope: loc?.scope || key, status, observedAt: loc?.observedAt || new Date().toISOString(),
            body: loc ? JSON.stringify(loc, null, 2) : '위치 미확인: 다른 PC의 존재 근거도 아직 없습니다.'
          });
          b.edge(source, ref, 'links', 'EXTRACTED', relative);
          b.warnings.add(`${loc ? 'PC 위치 기록 (현재 상태 미확인)' : '위치 미확인'}: ${relative} → ${target}` +
            ` [수집 PC: ${computerId}; 대상 PC: ${loc?.computerId || 'unknown'}; 범위: ${loc?.scope || key}]`);
        }
      }
    }
  }
  const g = b.finish();
  // Virtual directory markers are replaced by their parent directory nodes.
  const markers = new Set(g.nodes.filter(n => n.virtual).map(n => n.id));
  g.nodes = g.nodes.filter(n => !markers.has(n.id)); g.edges = g.edges.filter(e => !markers.has(e.target));
  if (options.vault) {
    const remap = new Map(g.nodes.map(n => [n.id, n.originalId || n.id]));
    g.nodes = [...new Map(g.nodes.map(n => [remap.get(n.id), { ...n, id: remap.get(n.id) }])).values()];
    const restoredIds = new Set(g.nodes.map(n => n.id));
    g.edges = [...new Map(g.edges.map(e => {
      const next = { ...e, source: remap.get(e.source), target: remap.get(e.target) };
      return [`${next.source}|${next.target}|${next.relation}`, next];
    }).filter(([, e]) => !(e.relation === 'links' && typedSources.has(e.source))).concat(
      restoredEdges.filter(e => restoredIds.has(e.target)).map(e => [`${e.source}|${e.target}|${e.relation}`, e])
    )).values()];
  }
  g.files = count;
  return g;
}

async function sources() {
  const rows = [{ key: 'all:knowledge', kind: 'all', name: 'knowledge', label: '통합 그래프 · 수집한 모든 원본' },
    { key: 'skills:repository', kind: 'skills', name: 'repository', label: '저장소 스킬 · CATALOG.md' },
    { key: 'repository:documents', kind: 'repository', name: 'documents', label: '공유 저장소 · 문서·메모리·로그' },
    { key: 'memory:notes', kind: 'memory', name: 'notes', label: 'Hub 학습 메모리' },
    { key: 'hub:data', kind: 'hub', name: 'data', label: 'Hub 데이터 · 지표·캐시·DB·설정' }], warnings = [];
  try {
    for (const p of require('./projects').list()) if (p.id && p.path)
      rows.push({ key: 'project:' + p.id, kind: 'project', name: p.name || p.id, label: '프로젝트 · ' + (p.name || p.id), root: p.path });
  } catch (e) { warnings.push('프로젝트 목록: ' + e.message); }
  try {
    const dir = path.join(require('./paths').hubDataDir(), 'rea-evidence.local');
    for (const f of await io.readdir(dir)) if (/^ev_[a-f0-9]{64}\.input\.json$/.test(f)) {
      const record = await readJson(path.join(dir, f));
      rows.push({ key: 'rea:' + record.evidenceId, kind: 'rea', name: record.evidenceId, label: 'REA · ' + path.basename(record.target), root: record.projectDir });
    }
  } catch (e) { if (e.code !== 'ENOENT') warnings.push('REA 목록: ' + e.message); }
  const providers = [ ['symbols', './symbolmap', 'list'], ['index', './codeindex', 'listIndexes'],
    ['render', './renderpipe', 'list'], ['analysis', './analysis-graph', 'list'] ];
  for (const [kind, mod, fn] of providers) {
    try {
      for (const row of await require(mod)[fn]()) if (row.name && row.state !== 'running') rows.push({ key: collectionKey(kind, row.name), kind, name: row.name, label: `${kind} · ${row.name}`, root: row.root });
    } catch (e) { warnings.push(`${kind}: ${e.message}`); }
  }
  const saved = path.join(base(), 'collections');
  try {
    for (const file of await io.readdir(saved)) {
      if (!/^[a-f0-9]{32}\.json$/.test(file)) continue;
      const g = await readJson(path.join(saved, file));
      // Re-ingesting our exports into the combined graph recursively duplicates every source.
      if (g.root && (within(base(), path.resolve(g.root)) && !g.vault || path.basename(g.root).toLowerCase() === '.obsidian')) continue;
      if (g.key.startsWith('directory:') && !rows.some(r => r.key === g.key)) rows.push({ key: g.key, kind: 'directory', name: g.label, root: g.root, label: g.label });
    }
  } catch (e) { if (e.code !== 'ENOENT') warnings.push(`저장된 그래프 읽기 실패: ${e.message}`); }
  return { sources: rows, warnings, running: [...running.keys()] };
}

async function repositoryLocations(root) {
  try {
    const data = await readJson(path.join(root, 'integrations', 'ai-hub', 'graph-locations.json'));
    if (data.version !== 1 || !Array.isArray(data.references)) throw new Error('잘못된 그래프 위치 기록 형식입니다.');
    return data.references;
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

async function adapt(key) {
  if (key === 'all:knowledge') {
    const inventory = await sources(), nodes = new Map(), edges = new Map(), warnings = new Set(inventory.warnings);
    for (const row of inventory.sources) {
      // Whole project/repository walks are explicit operations; merge their collected views only.
      if (row.kind === 'all') continue;
      if (row.root && within(base(), path.resolve(row.root))) continue;
      try {
        let g;
        if (['project','repository'].includes(row.kind)) {
          try { g = cache.get(row.key) || await readJson(graphFile(row.key)); }
          catch (e) { if (e.code === 'ENOENT') { warnings.add(`${row.label}: 아직 수집하지 않았습니다. 원본별 보기에서 수집하세요.`); continue; } throw e; }
        } else g = await load(row.key);
        if (g.version !== 2 || g.computerId !== computerId) {
          warnings.add(`${row.label}: PC 또는 색인 버전 미확인. 해당 PC에서 원본을 다시 수집하세요.`); continue;
        }
        for (const n of g.nodes) {
          if (nodes.size >= limits.nodes && !nodes.has(n.id)) { warnings.add('통합 그래프 노드 상한: 원본별 보기로 범위를 좁히세요.'); break; }
          const previous = nodes.get(n.id);
          const preferred = previous && !previous.hubImported && n.hubImported ? previous : n;
          nodes.set(n.id, { ...previous, ...preferred, kind: previous?.kind === 'skill' ? 'skill' : preferred.kind, scope: preferred.kind === 'reference' ? preferred.scope : [...new Set([...(previous?.sourceKeys || []), row.key])].join(', '), sourceKeys: [...new Set([...(previous?.sourceKeys || []), row.key])] });
        }
        for (const e of g.edges) {
          if (edges.size >= limits.edges) { warnings.add('통합 그래프 관계 상한에 도달했습니다.'); break; }
          if (nodes.has(e.source) && nodes.has(e.target)) {
            const eid = `${e.source}|${e.target}|${e.relation}`, previous = edges.get(eid);
            const sourceKeys = [...new Set([...(previous?.sourceKeys || []), row.key])];
            edges.set(eid, { ...e, sourceKeys, scope: sourceKeys.join(', ') });
          }
        }
        for (const w of g.warnings || []) warnings.add(`${g.label}: ${w}`);
      } catch (e) { warnings.add(`${row.label}: ${e.message}`); }
    }
    return { version: 2, key, computerId, root: '', label: '통합 지식 그래프', updatedAt: new Date().toISOString(), nodes: [...nodes.values()], edges: [...edges.values()], warnings: [...warnings] };
  }
  if (key === 'memory:notes') {
    const notes = require('./memory').list({ limit: 5000 }), b = builder(key, base(), 'Hub 학습 메모리');
    const tags = new Map();
    for (const n of notes) {
      const nid = b.node('note', n.id, { label: String(n.text).split('\n')[0].slice(0, 100), body: n.text, sourceLocation: n.source || 'memory', recordedAt: n.ts });
      for (const tag of n.tags || []) {
        if (!tags.has(tag)) tags.set(tag, b.node('tag', tag, { label: tag }));
        b.edge(nid, tags.get(tag), 'tagged');
      }
    }
    return b.finish();
  }
  if (key === 'repository:documents') {
    const repo = await require('./repository-skills').repository();
    return scan(repo.root, key, '공유 저장소', undefined, undefined, { locations: await repositoryLocations(repo.root) });
  }
  if (key === 'skills:repository') {
    const repo = await require('./repository-skills').list();
    const g = await scan(repo.root, key, 'CATALOG.md → 분류 → 스킬', undefined, undefined,
      { start: 'skills', locations: await repositoryLocations(repo.root) });
    g.repositoryRoot = repo.root;
    for (const s of repo.skills) {
      const n = g.nodes.find(n => n.path === s.path);
      if (n) Object.assign(n, { kind: 'skill', label: s.name, description: s.description, repositoryPath: s.path, body: `${s.description}\n${n.body}` });
    }
    // 카탈로그와의 일치(최신 여부), 캐시된 스킬 색인·사용 기록 노드와 간선. 실패해도 스킬 그래프는 그대로 보인다.
    try { await require('./knowledge-roles').enrichSkills(g, { repoRoot: repo.root, dataDir: require('./paths').hubDataDir() }); }
    catch (e) { g.warnings.push('캐시·사용 기록 노드: ' + e.message); }
    return g;
  }
  if (key === 'hub:data') return require('./knowledge-roles').hubDataGraph(key, require('./paths').hubDataDir());
  const { sources: rows } = await sources(), source = rows.find(s => s.key === key);
  if (!source) throw new Error('그래프 원본을 찾을 수 없습니다. 목록을 갱신하세요.');
  if (source.kind === 'directory') return readJson(graphFile(key));
  if (source.kind === 'project') return scan(source.root, key, source.label);
  if (source.kind === 'rea') {
    const { evidence, record } = require('./rea-analysis').load(source.name);
    const b = builder(key, record.projectDir, source.label);
    const root = b.node('artifact', record.target, { label: path.basename(record.target), file: record.target,
      evidence: 'EXTRACTED', body: JSON.stringify(evidence.normalized_result?.summary || evidence.subject), evidenceId: record.evidenceId });
    for (const [i, loc] of (evidence.locations || []).entries()) {
      const n = b.node('location', String(i), { label: String(loc.symbol || loc.address || loc.file || i), evidence: 'AMBIGUOUS', body: JSON.stringify(loc) });
      b.edge(root, n, 'reports', 'EXTRACTED');
    }
    for (const limitation of evidence.limitations || []) b.warnings.add(String(limitation));
    return b.finish();
  }
  let raw, root = source.root || '';
  if (source.kind === 'symbols') raw = require('./symbolmap').load(source.name);
  if (source.kind === 'render') raw = require('./renderpipe').load(source.name);
  if (source.kind === 'analysis') raw = await require('./analysis-graph').read(source.name);
  if (source.kind === 'index') {
    const dir = path.join(require('./codeindex').INDEX_ROOT, source.name);
    raw = await readJson(path.join(dir, 'meta.json'));
    raw.classes = await readJson(path.join(dir, 'classes.json'));
  }
  root = raw.root || raw.projectDir || root || path.dirname(raw.file || '.');
  const b = builder(key, root, source.label), symbols = new Map();
  const addSymbol = (s, i, type = 'symbol') => {
    const file = s.f || s.file || s.source_file;
    const locationLine = String(s.source_location || '').match(/(?:^L?|:L?)(\d+)(?:[-:]\d+)?$/)?.[1];
    const line = s.l || s.line || s.start_line || (locationLine ? Number(locationLine) : null);
    const label = s.n || s.name || s.label || s.id || String(i);
    const nid = b.node(type, `${file || ''}#${label}:${line}`, { label, line,
      file: file && within(path.resolve(root), path.resolve(root, file)) ? path.resolve(root, file) : undefined,
      body: s.description || '', evidence: s.evidence || 'EXTRACTED', originalId: s.id, symbolType: s.type || s.k || s.kind });
    const fid = file ? b.file(file) : null; b.edge(fid, nid, 'declares');
    if (nid) symbols.set(label, [...(symbols.get(label) || []), nid]);
    return nid;
  };
  if (source.kind === 'analysis') {
    const translate = new Map();
    for (const [i, n] of (raw.nodes || []).entries()) translate.set(n.id, addSymbol(n, i, ['class','struct','enum','function','method','namespace'].includes(n.type) ? 'symbol' : n.type || 'symbol'));
    for (const e of raw.edges || []) b.edge(translate.get(e.source), translate.get(e.target), e.relation || e.type || 'references', e.evidence || 'EXTRACTED', e.source_location || '');
    for (const w of raw.warnings || []) b.warnings.add(w);
  } else {
    const rows = source.kind === 'symbols' ? raw.symbols : source.kind === 'index' ? raw.classes : [];
    const ids = rows.map((s, i) => addSymbol(s, i));
    rows.forEach((s, i) => {
      for (const parent of s.parents || s.p || []) {
        const targets = symbols.get(parent) || [];
        if (targets.length === 1) b.edge(ids[i], targets[0], 'inherits');
        else b.warnings.add(`상속 대상 미해결: ${s.n || s.name} → ${parent}`);
      }
    });
    for (const [i, c] of (raw.cvars || []).entries()) addSymbol(c, 'cvar-' + i, 'cvar');
    if (source.kind === 'render') for (const cat of require('./renderpipe').CATEGORIES)
      for (const [i, r] of (raw[cat] || []).entries()) addSymbol(r, `${cat}-${i}`, cat);
    if (source.kind === 'index') for (const f of Object.keys(raw.files || {})) b.file(f);
    // Notes roots are distinct sources; retain their real paths instead of rebasing onto engine source.
    if (source.kind === 'symbols') for (const [i, note] of (raw.notes || []).entries()) {
      const nid = b.node('note', `notes/${note.f}#${note.l || i}`, { label: note.t || note.title || note.n || note.f, body: note.text || '', line: note.l,
        evidence: 'EXTRACTED', sourceLocation: note.f });
      for (const name of note.s || note.symbols || note.refs || []) for (const sid of symbols.get(name) || []) b.edge(nid, sid, 'mentions');
    }
  }
  return b.finish();
}

async function load(key) {
  if (typeof key !== 'string' || key.length > 200) throw new Error('잘못된 그래프 키입니다.');
  if (cache.has(key)) return cache.get(key);
  let g;
  // Legacy indices remain authoritative. Adapt them on first use rather than replacing them.
  if (!key.startsWith('directory:')) g = await adapt(key);
  else g = await readJson(graphFile(key));
  require('./knowledge-roles').annotate(g); // 역할(카탈로그·스킬·캐시·데이터…)과 용도 한 줄 — 예전에 저장한 그래프에도 붙는다
  if (key === 'repository:documents' || key.startsWith('project:')) await atomic(graphFile(key), g);
  cache.set(key, g); if (cache.size > 3) cache.delete(cache.keys().next().value);
  return g;
}
function invalidate() { cache.clear(); }
require('./change-signals').onChanged(invalidate);
async function refresh(key) {
  cache.delete('all:knowledge');
  cache.delete(key);
  if (String(key).startsWith('directory:')) {
    const previous = await readJson(graphFile(key));
    if (previous.vault) return importVault(previous.root);
    return buildDirectory({ root: previous.root, name: previous.label });
  }
  return summary(await load(key));
}
function summary(g) { return { key: g.key, label: g.label, root: g.root, computerId: g.computerId || 'unknown', nodes: g.nodes.length, edges: g.edges.length, updatedAt: g.updatedAt, warnings: g.warnings }; }
async function buildDirectory({ root, name }, progress = () => {}) {
  if (!String(root || '').trim()) throw new Error('수집할 폴더를 선택하세요.');
  const key = 'directory:' + id(await io.realpath(root));
  if (running.has(key)) throw new Error('이미 수집 중인 폴더입니다.');
  const job = { cancelled: false }; running.set(key, job);
  try {
    const g = await scan(root, key, String(name || path.basename(root)).slice(0, 120), p => progress({ ...p, key }), () => job.cancelled);
    if (job.cancelled) throw new Error('수집을 취소했습니다.');
    await atomic(graphFile(key), g); invalidate(); return summary(g);
  } finally { running.delete(key); }
}
function cancel(key) { const job = running.get(key); if (job) job.cancelled = true; return { requested: Boolean(job) }; }
async function query({ key, query = '', focus = '', depth = 1, kinds = [], roles = [], limit = 180 }) {
  const g = await load(key), cap = Math.max(20, Math.min(500, Number(limit) || 180));
  const terms = String(query).toLocaleLowerCase().split(/\s+/).filter(Boolean), byId = new Map(g.nodes.map(n => [n.id, n]));
  let candidates = g.nodes.filter(n => (!kinds.length || kinds.includes(n.kind)) && (!roles.length || roles.includes(n.role)) && terms.every(t => `${n.label} ${n.path} ${n.computerId || ''} ${n.scope || ''} ${n.status || ''} ${n.purpose || ''} ${n.description || ''} ${n.body || ''}`.toLocaleLowerCase().includes(t)));
  if (focus && byId.has(focus)) {
    let frontier = new Set([focus]); const selected = new Set(frontier);
    for (let d = 0; d < Math.max(1, Math.min(3, depth)); d++) {
      const next = new Set();
      for (const e of g.edges) {
        if (frontier.has(e.source)) next.add(e.target);
        if (frontier.has(e.target)) next.add(e.source);
      }
      for (const n of next) selected.add(n); frontier = next;
    }
    candidates = candidates.filter(n => selected.has(n.id));
  }
  const priority = n => /^(?:skills\/)?CATALOG\.md$/.test(n.path) || n.path === '.' ? 0 : n.kind === 'directory' ? 1 + n.path.split('/').length * 0.01 : n.kind === 'skill' ? 2 : 3;
  candidates.sort((a, b) => (a.id === focus ? -1 : b.id === focus ? 1 : priority(a) - priority(b)) || a.path.localeCompare(b.path));
  const nodes = candidates.slice(0, cap).map(({ body, ...n }) => n), visible = new Set(nodes.map(n => n.id));
  return { ...summary(g), totalMatches: candidates.length, truncated: candidates.length > cap,
    nodes, edges: g.edges.filter(e => visible.has(e.source) && visible.has(e.target)), kinds: [...new Set(g.nodes.map(n => n.kind))], roles: [...new Set(g.nodes.map(n => n.role))], roleInfo: require('./knowledge-roles').ROLES };
}
async function detail(key, nodeId) {
  const g = await load(key), n = g.nodes.find(n => n.id === nodeId);
  if (!n) throw new Error('노드를 찾을 수 없습니다.');
  const outgoing = g.edges.filter(e => e.source === n.id), backlinks = g.edges.filter(e => e.target === n.id);
  const related = new Set([...outgoing.map(e => e.target), ...backlinks.map(e => e.source)]);
  return { ...n, body: n.body?.slice(0, 12000), outgoing, backlinks,
    related: g.nodes.filter(x => related.has(x.id)).map(({ body, ...x }) => x).slice(0, 200) };
}
async function original(key, nodeId) {
  const n = await detail(key, nodeId), g = await load(key);
  if (key === 'all:knowledge') {
    if (!n.sourceKeys?.length) throw new Error('원본 그래프 정보가 없습니다.');
    return original(n.sourceKeys[0], nodeId);
  }
  if (n.computerId !== computerId) throw new Error('이 PC에서 수집한 원본만 열 수 있습니다. 원본을 다시 수집하세요.');
  if (!n.file || !within(path.resolve(g.root), path.resolve(n.file))) throw new Error('열 수 있는 원본 파일이 없습니다.');
  const real = await io.realpath(n.file);
  if (!within(await io.realpath(g.root), real)) throw new Error('원본이 수집 루트 밖을 가리킵니다.');
  return real;
}

// Each immutable export is a vault. Original source and existing user notes are never rewritten.
async function exportVault(key) {
  const g = await load(key), folder = path.join(base(), 'vaults', id(key), new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8));
  try {
    for (const [relative, text] of Object.entries(require('./obsidian/vault-notes').render(g))) {
      const target = path.join(folder, relative);
      await io.mkdir(path.dirname(target), { recursive: true });
      await io.writeFile(target, text, 'utf8');
    }
    await io.writeFile(path.join(folder, '.hub-vault.json'), '\uFEFF' + JSON.stringify({ key, generated: true, createdAt: new Date().toISOString(), nodes: g.nodes.length }), 'utf8');
    return { folder, nodes: g.nodes.length, edges: g.edges.length, warnings: g.warnings };
  } catch (e) { await io.rm(folder, { recursive: true, force: true }); throw e; }
}
async function importVault(folder, progress) {
  if (isSensitivePath(folder)) throw new Error('민감 디렉터리는 수집할 수 없습니다.');
  let root = await io.realpath(String(folder)), candidate = root;
  while (true) {
    const found = await io.access(path.join(candidate, '.obsidian')).then(() => true, () => false) ||
      await io.access(path.join(candidate, '.hub-vault.json')).then(() => true, () => false);
    if (found) { root = candidate; break; }
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error('볼트 루트를 선택하세요. .obsidian 또는 .hub-vault.json이 있는 폴더가 필요합니다.');
    candidate = parent;
  }
  const key = 'directory:' + id(root);
  if (running.has(key)) throw new Error('이미 수집 중인 볼트입니다.');
  const job = { cancelled: false }; running.set(key, job);
  try {
    const g = await scan(root, key, 'Obsidian · ' + path.basename(root), p => progress?.({ ...p, key }), () => job.cancelled, { vault: true });
    if (job.cancelled) throw new Error('수집을 취소했습니다. 이전 그래프는 보존했습니다.');
    g.vault = true;
    await atomic(graphFile(key), g); invalidate(); return summary(g);
  } finally { running.delete(key); }
}
module.exports = { sources, query, detail, original, refresh, invalidate, buildDirectory, cancel, exportVault, importVault, load };

'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');
const { hubDataDir } = require('../paths');
const { decode } = require('../console-text');
const { scrub } = require('../secret-scrub');
const safety = require('./script-safety');
const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

function defaults(deps = {}) {
  return { fs, now: Date.now, ...deps, dataDir: deps.dataDir || hubDataDir(), execFile: deps.execFile || runProcess };
}

function runProcess(file, args, opts) {
  return new Promise((resolve, reject) => execFile(file, args, opts, (error, stdout, stderr) => {
    if (error && (typeof error.code !== 'number' || error.killed)) return reject(error);
    resolve({ stdout, stderr, code: error ? error.code : 0 });
  }));
}

function validateEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') return { ok: false, errors: ['entry must be an object'] };
  if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry.id)) errors.push('invalid id');
  if (!['skill', 'plugin', 'mcp', 'other'].includes(entry.kind)) errors.push('invalid kind');
  try {
    const rawUrl = entry.upstream && entry.upstream.url;
    if (typeof rawUrl !== 'string' || !/^https:\/\//i.test(rawUrl) || /[\s\\\x00-\x1f]/.test(rawUrl)) errors.push('invalid HTTPS URL');
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) errors.push('upstream requires HTTPS without credentials');
  } catch { errors.push('invalid upstream URL'); }
  const ref = entry.upstream && entry.upstream.ref;
  if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /[\s\x00-\x1f~^:?*\[\\]/.test(ref) || ref.includes('..') || ref.includes('@{')) errors.push('invalid ref');
  if (typeof entry.localPath !== 'string' || !path.isAbsolute(entry.localPath) || entry.localPath.includes('\0')) errors.push('localPath must be absolute');
  if (entry.adoptedRevision && (typeof entry.adoptedRevision !== 'string' || !revisionPattern.test(entry.adoptedRevision))) errors.push('invalid adoptedRevision');
  if (entry.intervalDays !== undefined && (!Number.isFinite(entry.intervalDays) || entry.intervalDays <= 0)) errors.push('invalid intervalDays');
  if (entry.lastCheckedAt != null && !Number.isFinite(Date.parse(entry.lastCheckedAt))) errors.push('invalid lastCheckedAt');
  return { ok: errors.length === 0, errors };
}

function requireEntry(entry) {
  const validation = validateEntry(entry);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
}

function registryPath(d) { return path.join(d.dataDir, 'upstream-sync', 'forks.local.json'); }

function validateRegistry(reg) {
  if (!reg || reg.schemaVersion !== 1 || !Array.isArray(reg.forks)) throw new Error('Invalid registry');
  const ids = new Set();
  for (const entry of reg.forks) {
    requireEntry(entry);
    if (ids.has(entry.id)) throw new Error('Duplicate registry id');
    ids.add(entry.id);
  }
}

async function atomic(file, data, d) {
  await d.fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid;
  const handle = await d.fs.open(temp, 'wx');
  try {
    await handle.writeFile(data);
    await handle.close();
    await d.fs.rename(temp, file);
  } catch (error) {
    await handle.close().catch(() => {});
    await d.fs.unlink(temp).catch(() => {});
    throw error;
  }
}

async function loadRegistry(deps) {
  const d = defaults(deps);
  let text;
  try { text = await d.fs.readFile(registryPath(d), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, forks: [] }; throw error; }
  const reg = JSON.parse(text);
  validateRegistry(reg);
  return reg;
}

async function saveRegistry(reg, deps) {
  const d = defaults(deps);
  validateRegistry(reg);
  // A corrupt or unreadable registry must not be replaced by an empty caller snapshot.
  await loadRegistry(d);
  await atomic(registryPath(d), JSON.stringify(reg, null, 2) + '\n', d);
}

function due(entry, nowMs) {
  const last = Date.parse(entry.lastCheckedAt);
  return !Number.isFinite(last) || nowMs - last >= (entry.intervalDays ?? 7) * 86400000;
}

async function git(args, timeout, d, cwd, allowConflict = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  // Windows의 os.devNull(\\.\nul)은 Git for Windows가 설정 파일로 열지 못한다("unable to access") — 빈 설정 파일을 쓴다(2026-10-23 실측).
  let globalConfig = os.devNull;
  if (process.platform === 'win32') {
    globalConfig = path.join(d.dataDir, 'upstream-sync', 'empty.gitconfig');
    await d.fs.mkdir(path.dirname(globalConfig), { recursive: true });
    await d.fs.writeFile(globalConfig, '', { flag: 'a' });
  }
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: '0' });
  const result = await d.execFile('git', ['-c', 'core.hooksPath=' + path.join(d.dataDir, 'upstream-sync', 'disabled-hooks'),
    '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'credential.helper=',
    '-c', 'http.followRedirects=false', ...args], { encoding: 'buffer', windowsHide: true, timeout, cwd, env, maxBuffer: 16 * 1024 * 1024 });
  if (result.code && !(allowConflict && result.code > 0 && result.code < 128)) {
    throw new Error(scrub(decode(result.stderr) || 'git failed (' + result.code + ')'));
  }
  return { ...result, stdout: decode(result.stdout), stderr: decode(result.stderr) };
}

async function check(entry, deps) {
  const result = { id: entry && entry.id, upstreamRevision: null, adoptedRevision: entry && entry.adoptedRevision || null, behind: false };
  try {
    requireEntry(entry);
    const d = defaults(deps);
    const output = await git(['ls-remote', '--', entry.upstream.url, entry.upstream.ref, entry.upstream.ref + '^{}'], 30000, d);
    const lines = output.stdout.trim().split(/\r?\n/).map(line => line.split(/\s+/));
    const wanted = entry.upstream.ref;
    const selected = lines.find(([, ref]) => ref === wanted + '^{}' || ref === 'refs/tags/' + wanted + '^{}')
      || lines.find(([, ref]) => ref === wanted || ref === 'refs/heads/' + wanted || ref === 'refs/tags/' + wanted); 
    if (!selected || !revisionPattern.test(selected[0])) throw new Error('Upstream ref did not resolve');
    result.upstreamRevision = selected[0].toLowerCase();
    result.behind = result.upstreamRevision !== String(entry.adoptedRevision || '').toLowerCase();
  } catch (error) { result.error = scrub(error.message); }
  return result;
}

function safeRelative(rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || path.win32.isAbsolute(rel) || /[\\:\x00-\x1f]/.test(rel)) throw new Error('Unsafe file path');
  const parts = rel.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) || p.toLowerCase() === '.git' || p.toLowerCase() === 'node_modules')) throw new Error('Unsafe file path');
  return parts;
}

async function contained(root, rel, d) {
  const parts = safeRelative(rel);
  const base = path.resolve(root);
  const full = path.resolve(base, ...parts);
  if (!full.startsWith(base + path.sep)) throw new Error('File outside root');
  // Reject existing links in every component, including the root's ancestors.
  const parsed = path.parse(full);
  let cursor = parsed.root;
  for (const part of full.slice(parsed.root.length).split(path.sep)) {
    cursor = path.join(cursor, part);
    try { if ((await d.fs.lstat(cursor)).isSymbolicLink()) throw new Error('Symlink path refused'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return full;
}

async function tree(root, d) {
  const result = new Map();
  async function visit(dir, prefix) {
    for (const entry of await d.fs.readdir(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules'].includes(entry.name.toLowerCase())) continue;
      const rel = prefix + entry.name;
      const full = await contained(root, rel, d);
      if (entry.isSymbolicLink()) throw new Error('Symlink in tree refused');
      if (entry.isDirectory()) await visit(full, rel + '/');
      else if (entry.isFile()) result.set(rel, await d.fs.readFile(full));
      else throw new Error('Non-regular file refused');
    }
  }
  await contained(root, '.supply-path-check', d);
  await visit(root, '');
  return result;
}

async function snapshot(entry, revision, d) {
  revision = revision.toLowerCase();
  const parent = path.join(d.dataDir, 'upstream-sync', 'cache', entry.id);
  await d.fs.mkdir(parent, { recursive: true });
  const target = path.join(parent, revision.slice(0, 12));
  const stage = await d.fs.mkdtemp(path.join(parent, 'fetch-'));
  try {
    await git(['init', '--', stage], 120000, d);
    await git(['fetch', '--depth', '1', '--', entry.upstream.url, revision], 120000, d, stage);
    await git(['checkout', '--detach', 'FETCH_HEAD'], 120000, d, stage);
    const head = (await git(['rev-parse', 'HEAD'], 30000, d, stage)).stdout.trim();
    if (head !== revision) throw new Error('Fetched revision mismatch');
    const files = await tree(stage, d);
    try { await d.fs.rename(stage, target); }
    catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error; }
    return { root: await d.fs.stat(stage).then(() => stage, () => target), files, stage };
  } catch (error) { await d.fs.rm(stage, { recursive: true, force: true }); throw error; }
}

const equal = (a, b) => a === undefined ? b === undefined : b !== undefined && a.equals(b);
const digest = data => data === undefined ? null : hash(data);

async function compatibility(entry, files) {
  const checks = [];
  const add = (check, ok, detail) => checks.push({ check, ok, detail });
  for (const [rel, data] of files) {
    if (entry.kind === 'skill') {
      if (path.basename(rel) === 'SKILL.md') {
        const text = data.toString('utf8');
        const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        const name = front && front[1].match(/^name:[ \t]*["']?([a-z0-9]+(?:-[a-z0-9]+)*)["']?[ \t]*$/m);
        const description = front && front[1].match(/^description:[ \t]*(\S.*)$/m);
        const desc = description && description[1].replace(/^["']|["']$/g, '').trim();
        const hasDescription = desc && !/^(?:#|null$|~$)/i.test(desc) && (!/^[>|][-+]?$/.test(desc) || /\n[ \t]+\S/.test(front[1].slice(description.index)));
        add('skill-frontmatter', !!(name && hasDescription && rel.split('/').length === 2 && name[1] === rel.split('/')[0]), rel);
      } else if (!rel.includes('/') && /\.md$/i.test(rel) && !/^(?:README|CHANGELOG|LICENSE)\.md$/i.test(rel)) add('skill-directory', false, rel);
    }
    if ((entry.kind === 'plugin' && ['plugin.json', 'marketplace.json'].includes(path.basename(rel))) || path.basename(rel) === 'package.json') {
      try {
        const json = JSON.parse(data.toString('utf8'));
        add('json-parse', !!json && typeof json === 'object' && !Array.isArray(json), rel);
        if (path.basename(rel) === 'package.json' && ['preinstall', 'install', 'postinstall', 'prepare'].some(key => Object.prototype.hasOwnProperty.call(json.scripts || {}, key))) add('npm-lifecycle', true, rel + ': review lifecycle scripts');
      } catch { add('json-parse', false, rel); }
    }
  }
  if (entry.kind === 'skill' && ![...files.keys()].some(p => p.endsWith('/SKILL.md'))) add('skill-directory', false, 'No <name>/SKILL.md found');
  return checks;
}

async function mergeContents(local, base, incoming, d) {
  if ([local, base, incoming].some(b => !b || b.subarray(0, 8192).includes(0))) return { merge: 'needs-review' };
  const dir = await d.fs.mkdtemp(path.join(d.dataDir, 'upstream-sync', 'merge-'));
  try {
    const names = ['local', 'ancestor', 'upstream'].map(n => path.join(dir, n));
    for (let i = 0; i < names.length; i++) await d.fs.writeFile(names[i], [local, base, incoming][i]);
    const result = await git(['merge-file', '-p', ...names], 30000, d, undefined, true);
    return { merge: result.code ? 'conflict' : 'clean', content: Buffer.from(result.stdout) };
  } catch { return { merge: 'needs-review' }; }
  finally { await d.fs.rm(dir, { recursive: true, force: true }); }
}

async function prepare(entry, deps) {
  requireEntry(entry);
  const d = defaults(deps);
  const status = await check(entry, d);
  if (status.error) throw new Error(status.error);
  const upstream = await snapshot(entry, status.upstreamRevision, d);
  let ancestor;
  try { if (entry.adoptedRevision) ancestor = await snapshot(entry, entry.adoptedRevision, d); }
  catch { /* A missing ancestor prevents automatic merges, not the entire proposal. */ }
  try {
    const local = await tree(entry.localPath, d);
    const files = [];
    const incomingPaths = [];
    for (const rel of [...new Set([...upstream.files.keys(), ...local.keys(), ...(ancestor ? ancestor.files.keys() : [])])].sort()) {
      const u = upstream.files.get(rel), l = local.get(rel), a = ancestor && ancestor.files.get(rel);
      if (equal(l, u)) continue;
      let change, merge = 'clean', content;
      if (ancestor && equal(u, a)) change = 'local-only';
      else if (u === undefined) {
        if (ancestor && a !== undefined && !equal(l, a)) { change = 'both-changed'; merge = 'needs-review'; }
        else change = ancestor && a !== undefined ? 'upstream-removed' : 'local-only';
      }
      else if (ancestor && equal(l, a) || !ancestor && l === undefined) {
        change = a === undefined ? 'upstream-added' : 'upstream-changed'; content = u;
      } else {
        change = 'both-changed';
        const merged = ancestor ? await mergeContents(l, a, u, d) : { merge: 'needs-review' };
        merge = merged.merge; content = merged.content;
      }
      if (u !== undefined && change !== 'local-only') incomingPaths.push(rel);
      files.push({ path: rel, change, merge, safety: { verdict: 'pass', findings: [] }, localSha256: digest(l),
        ...(content !== undefined ? { contentBase64: content.toString('base64') } : {}) });
    }
    const scanned = await safety.scanFiles(upstream.root, incomingPaths, { deps: d });
    for (const file of files) {
      const found = scanned.files.find(f => f.path === file.path);
      const skipped = scanned.skipped.find(f => f.path === file.path);
      if (found) file.safety = { verdict: found.verdict, findings: found.findings };
      if (skipped) file.safety = { verdict: 'review', findings: [], skipped: skipped.reason };
      if (file.contentBase64 && file.merge === 'clean') {
        const planned = safety.scanText(Buffer.from(file.contentBase64, 'base64').toString('utf8'), { path: file.path });
        if (planned.verdict === 'block' || planned.verdict === 'review' && file.safety.verdict === 'pass') file.safety = planned;
      }
    }
    const effective = new Map(local);
    for (const file of files) if (file.contentBase64 !== undefined && file.merge === 'clean') effective.set(file.path, Buffer.from(file.contentBase64, 'base64'));
    const compat = [...await compatibility(entry, upstream.files),
      ...(await compatibility(entry, effective)).map(c => ({ ...c, detail: 'planned: ' + c.detail }))];
    const blocked = files.some(f => f.safety.verdict === 'block') || compat.some(c => !c.ok);
    const review = files.some(f => f.merge !== 'clean' || f.safety.verdict === 'review') || compat.some(c => c.check === 'npm-lifecycle');
    const proposal = { schemaVersion: 1, id: entry.id, fromRevision: entry.adoptedRevision || null,
      toRevision: status.upstreamRevision, createdAt: new Date(d.now()).toISOString(), localPath: entry.localPath,
      files, compatibility: compat, verdict: blocked ? 'blocked' : review ? 'review' : 'ready' };
    const file = path.join(d.dataDir, 'upstream-sync', 'proposals', entry.id + '-' + status.upstreamRevision.slice(0, 12) + '.json');
    const bytes = Buffer.from(JSON.stringify(proposal, null, 2) + '\n');
    await atomic(file, bytes, d);
    return { ...proposal, path: file, sha256: hash(bytes) };
  } finally {
    for (const snap of [upstream, ancestor].filter(Boolean)) await d.fs.rm(snap.stage, { recursive: true, force: true });
  }
}

async function apply(proposalPath, { confirmed, expectSha256 } = {}, deps) {
  if (confirmed !== true) throw new Error('Explicit confirmed: true required');
  const d = defaults(deps);
  const bytes = await d.fs.readFile(proposalPath);
  if (typeof expectSha256 !== 'string' || hash(bytes) !== expectSha256) throw new Error('Proposal sha256 mismatch');
  const proposal = JSON.parse(bytes.toString('utf8'));
  if (proposal.schemaVersion !== 1 || !['ready', 'review'].includes(proposal.verdict) || !Array.isArray(proposal.files) || !Array.isArray(proposal.compatibility)) throw new Error('Blocked or invalid proposal');
  if (!revisionPattern.test(proposal.toRevision) || proposal.compatibility.some(c => !c.ok)) throw new Error('Invalid proposal compatibility or revision');
  if (proposal.files.some(f => f.merge === 'conflict' || f.safety && f.safety.verdict === 'block')) throw new Error('Conflicted or blocked files');
  const reg = await loadRegistry(d);
  const entry = reg.forks.find(f => f.id === proposal.id);
  if (!entry || entry.localPath !== proposal.localPath || (entry.adoptedRevision || null) !== proposal.fromRevision) throw new Error('Registry changed since proposal');
  const applied = [], skipped = [], planned = [], created = [];
  const names = new Set();
  for (const file of proposal.files) {
    const full = await contained(entry.localPath, file.path, d);
    if (names.has(full.toLowerCase())) throw new Error('Duplicate destination path');
    names.add(full.toLowerCase());
    if (['local-only', 'upstream-removed'].includes(file.change) || file.merge === 'needs-review') {
      skipped.push({ path: file.path, reason: file.change === 'upstream-removed' ? 'deletion_not_propagated' : file.merge === 'needs-review' ? 'needs-review' : 'local-only' }); continue;
    }
    if (!['upstream-added', 'upstream-changed', 'both-changed'].includes(file.change) || file.merge !== 'clean' || typeof file.contentBase64 !== 'string') throw new Error('Invalid planned file');
    let old;
    try { old = await d.fs.readFile(full); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (digest(old) !== file.localSha256) throw new Error('Local file changed since proposal: ' + file.path);
    const content = Buffer.from(file.contentBase64, 'base64');
    if (safety.scanText(content.toString('utf8'), { path: file.path }).verdict === 'block') throw new Error('Blocked planned contents');
    planned.push({ ...file, full, old, content });
  }
  const backup = path.join(d.dataDir, 'upstream-sync', 'backups', entry.id + '-' + d.now() + '-' + crypto.randomBytes(4).toString('hex'));
  await d.fs.mkdir(backup, { recursive: true });
  // Complete backups and stale-file checks before changing any destination.
  for (const file of planned) {
    if (file.old !== undefined) {
      const dest = await contained(backup, file.path, d);
      await d.fs.mkdir(path.dirname(dest), { recursive: true });
      await d.fs.writeFile(dest, file.old, { flag: 'wx' });
    }
  }
  for (const file of planned) {
    await contained(entry.localPath, file.path, d);
    let current;
    try { current = await d.fs.readFile(file.full); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (digest(current) !== file.localSha256) throw new Error('Local file changed during apply: ' + file.path);
    await atomic(file.full, file.content, d);
    applied.push(file.path);
    if (file.old === undefined) created.push(file.path);
  }
  // Unresolved files must not become the ancestor of the next sync.
  if (!skipped.some(f => f.reason === 'needs-review')) entry.adoptedRevision = proposal.toRevision;
  await saveRegistry(reg, d);
  return { applied, skipped, backup, created, fromRevision: proposal.fromRevision };
}

/** apply()를 되돌린다: 바꾼 파일은 백업에서, 새로 만든 파일은 지운다. 적용 뒤 확인에 실패했을 때(원본 갱신 정책). */
async function restore(id, result, deps) {
  const d = defaults(deps);
  const reg = await loadRegistry(d);
  const entry = reg.forks.find(f => f.id === id);
  if (!entry) throw new Error('Unknown fork: ' + id);
  for (const rel of result.applied) {
    const full = await contained(entry.localPath, rel, d);
    if (result.created.includes(rel)) await d.fs.rm(full, { force: true });
    else await atomic(full, await d.fs.readFile(await contained(result.backup, rel, d)), d);
  }
  entry.adoptedRevision = result.fromRevision || null;
  await saveRegistry(reg, d);
}

/** 적용 뒤 확인: 지금 로컬 트리가 호환성 검사를 모두 통과하는가. */
async function verifyLocal(id, deps) {
  const d = defaults(deps);
  const entry = (await loadRegistry(d)).forks.find(f => f.id === id);
  return !!entry && (await compatibility(entry, await tree(entry.localPath, d))).every(c => c.ok);
}

// 원본 쪽 내용만 검토 글에 싣는다 — 양쪽이 바뀐 파일의 병합 결과에는 우리 사본이 섞여 있다(규칙 10: 외부 AI에는 공개 자료만).
function reviewText(entry, p) {
  const lines = [`원본: ${entry.upstream.url} (${entry.upstream.ref}) ${p.fromRevision || '처음'} → ${p.toRevision}`, `종류: ${entry.kind}`, '', '## 바뀐 파일'];
  for (const f of p.files) lines.push(`- ${f.path}: ${f.change}, 병합 ${f.merge}, 안전 ${f.safety ? f.safety.verdict : '-'}`);
  for (const f of p.files.filter(x => ['upstream-added', 'upstream-changed'].includes(x.change) && x.contentBase64).slice(0, 6)) {
    lines.push('', `### ${f.path}`, Buffer.from(f.contentBase64, 'base64').toString('utf8').slice(0, 1500));
  }
  return lines.join('\n');
}

/** 원본 갱신 정책(1.32.27): 만든 제안을 종류(entry.policy, 기본 K3)대로 — 위험이 없고 AI 검토가 "위험 없음"이면 적용·확인, 아니면 승인 대기. */
async function route(entry, proposal, d) {
  const policy = require('./update-policy');
  const risks = [...policy.proposalRisks(proposal, { appRoot: d.appRoot || require('../paths').appRoot() }), ...(proposal.verdict === 'blocked' ? ['blocked'] : [])];
  const short = r => String(r || '처음').slice(0, 10);
  const r = await policy.handle({ source: 'fork', target: entry.id, kind: entry.policy || 'K3', from: proposal.fromRevision, to: proposal.toRevision,
    title: `${entry.id} ${short(proposal.fromRevision)} → ${short(proposal.toRevision)}`, risks, publicText: reviewText(entry, proposal) },
  { apply: () => apply(proposal.path, { confirmed: true, expectSha256: proposal.sha256 }, d), check: () => verifyLocal(entry.id, d),
    rollback: result => restore(entry.id, result, d) }, d);
  return { decision: r.decision, ...(r.approval ? { approval: r.approval.id } : {}) };
}

// 사람이 승인한 대기 항목: 마지막 제안이 그 버전이면 적용하고 확인한다(실패하면 되돌림).
require('./update-policy').registerExecutor('fork', async (row, deps) => {
  const d = defaults(deps);
  const entry = (await loadRegistry(d)).forks.find(f => f.id === row.target);
  const p = entry && entry.lastResult && entry.lastResult.proposal;
  if (!p || p.toRevision !== row.to) throw new Error('대기 항목의 제안이 더 이상 최신이 아닙니다 — 다시 점검하세요');
  const result = await apply(p.path, { confirmed: true, expectSha256: p.sha256 }, d);
  if (!(await verifyLocal(entry.id, d))) { await restore(entry.id, result, d); throw new Error('적용 뒤 호환성 검사 실패 — 되돌림'); }
  return { applied: result.applied.length };
});

async function syncDue(deps) {
  const d = defaults(deps);
  const reg = await loadRegistry(d);
  const results = [];
  for (const entry of reg.forks) {
    if (!due(entry, d.now())) continue;
    const result = await check(entry, d);
    entry.lastCheckedAt = new Date(d.now()).toISOString();
    try { if (result.behind && !result.error) result.proposal = await prepare(entry, d); }
    catch (error) { result.error = scrub(error.message); }
    try { if (result.proposal) result.policy = await route(entry, result.proposal, d); }
    catch (error) { result.policyError = scrub(error.message); }
    // 레지스트리에는 제안 요약만 둔다 — 제안 전체(바뀐 파일 내용 base64)는 proposals/ 파일에 이미 있고, 여기 넣으면 검사마다 레지스트리가 자란다.
    const p = result.proposal;
    // route()의 자동 적용이 adoptedRevision을 저장했을 수 있다 — 처음 읽은 사본으로 덮지 않게 다시 읽은 항목에 점검 결과만 얹는다.
    results.push(result);
    const fresh = await loadRegistry(d), current = fresh.forks.find(f => f.id === entry.id);
    if (!current) continue; // 점검 중에 등록이 지워졌다
    current.lastCheckedAt = entry.lastCheckedAt;
    current.lastResult = { ...result, ...(p ? { proposal: { path: p.path, sha256: p.sha256, verdict: p.verdict, fromRevision: p.fromRevision, toRevision: p.toRevision, createdAt: p.createdAt, files: p.files.length } } : {}) };
    await saveRegistry(fresh, d);
  }
  return results;
}

module.exports = { loadRegistry, saveRegistry, validateEntry, due, check, prepare, apply, restore, verifyLocal, syncDue };

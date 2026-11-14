// Skill installer: takes a local file/folder or a GitHub URL and installs it
// as a skill into the chosen AI tools (Claude Code, Antigravity, Gemini CLI, Codex).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { detectTargets } = require('./paths');

const MAX_SKILL_BYTES = 50 * 1024 * 1024; // refuse to copy more than 50 MB

function sanitizeName(name) {
  const clean = String(name)
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!clean) throw new Error(`Cannot derive a valid skill name from "${name}"`);
  return clean;
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    if (total > MAX_SKILL_BYTES) throw new Error('Skill source exceeds 50 MB limit.');
  }
  return total;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isSymbolicLink()) continue; // never follow symlinks out of the tree
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Repair only an unambiguous layout defect: a loose markdown file directly
 * under a skills root. Conflicts are reported and never overwritten.
 */
function repairTargetLayout(target) {
  const repairs = [];
  let entries = [];
  try { entries = fs.readdirSync(target.skillsDir, { withFileTypes: true }); }
  catch { return repairs; }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(md|markdown)$/i.test(entry.name) || /^readme\./i.test(entry.name)) continue;
    const source = path.join(target.skillsDir, entry.name);
    const name = sanitizeName(entry.name);
    const destinationDir = path.join(target.skillsDir, name);
    const destination = path.join(destinationDir, 'SKILL.md');
    if (fs.existsSync(destination)) {
      const same = fs.readFileSync(source).equals(fs.readFileSync(destination));
      if (same) {
        fs.unlinkSync(source);
        repairs.push({ from: source, to: destination, action: 'removed-duplicate' });
      } else {
        repairs.push({ from: source, to: destination, action: 'conflict-skipped' });
      }
      continue;
    }
    fs.mkdirSync(destinationDir, { recursive: true });
    fs.renameSync(source, destination);
    repairs.push({ from: source, to: destination, action: 'moved-to-skill-directory' });
  }
  return repairs;
}

/**
 * Resolve a source (local path or GitHub URL) into one or more skill folders/files.
 * @returns {{ kind:'dir'|'file', name:string, path:string }[]} plus optional cleanup dir
 */
function resolveSource(source) {
  source = String(source).trim().replace(/^["']|["']$/g, '');
  require('./prompt-safety').assertNoSecrets(source);
  // A UNC/device path can contact a remote SMB server during the first file probe.
  if (/^[\\/]{2}/.test(source)) throw new Error('Choose a local skill path or HTTPS GitHub URL.');
  if (/^https?:\/\//i.test(source)) return resolveGithub(source);

  const p = path.resolve(source);
  if (!fs.existsSync(p)) throw new Error(`Path not found: ${p}`);
  const stat = fs.lstatSync(p);
  if (stat.isSymbolicLink()) throw new Error('Open the original skill path, not a link.');
  if (stat.isFile()) {
    if (!/\.(md|markdown)$/i.test(p)) throw new Error('Single-file skills must be markdown (.md).');
    if (/^(catalog|readme)\./i.test(path.basename(p))) throw new Error('카탈로그·README는 설치할 스킬이 아닙니다. SKILL.md를 선택하세요.');
    if (stat.size > MAX_SKILL_BYTES) throw new Error('Skill source exceeds 50 MB limit.');
    const name = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').match(/^---\r?\n[^]*?^name:\s*['"]?([\w-]+)/m)?.[1];
    return { items: [{ kind: 'file', name: sanitizeName(name || path.basename(p)), path: p }] };
  }
  return { items: collectSkillDirs(p) };
}

/** Preserve category layouts; a catalog or README is never an installable skill. */
function collectSkillDirs(dir, visited = new Set()) {
  const real = fs.realpathSync(dir);
  if (visited.has(real)) return [];
  visited.add(real);
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
    return [{ kind: 'dir', name: sanitizeName(path.basename(dir)), path: dir }];
  }
  const found = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.')) continue;
    const sub = path.join(dir, e.name);
    found.push(...collectSkillDirs(sub, visited));
  }
  return found;
}

/** Clone a GitHub URL (optionally /tree/<ref>/<subdir>) and collect skills from it. */
function resolveGithub(url) {
  const u = new URL(url);
  if (u.origin !== 'https://github.com' || u.username || u.password) {
    throw new Error('Only github.com URLs are supported for remote skills.');
  }
  const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < 2) throw new Error('GitHub URL must include owner/repo.');
  const [owner, repoRaw] = parts;
  const repo = repoRaw.replace(/\.git$/i, '');
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new Error('Invalid GitHub owner/repo.');
  let ref = null;
  let subdir = '';
  if (parts[2] === 'tree' && parts.length >= 4) {
    ref = parts[3];
    subdir = parts.slice(4).join('/');
  }
  // A ref starting with "-" could be parsed as a git option; refuse it.
  if (ref && (!/^[\w./-]+$/.test(ref) || ref.startsWith('-'))) throw new Error('Invalid branch/ref name.');
  if (parts.length > 2 && (parts[2] !== 'tree' || !ref)) throw new Error('Invalid GitHub tree URL.');
  const segments = require('./skill-git').githubSubdirectory(subdir ? subdir.split('/') : []);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-skill-'));
  const cloneArgs = ['-c', 'core.hooksPath=' + os.devNull, '-c','protocol.ext.allow=never','-c','protocol.file.allow=never',
    'clone','--no-checkout','--template=', '--depth', '1', '--no-tags','--no-recurse-submodules'];
  if (ref) cloneArgs.push('--branch', ref);
  cloneArgs.push(`https://github.com/${owner}/${repo}.git`, tmp);
  try {
    const options = {stdio:'pipe',timeout:120000,windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}};
    execFileSync('git', cloneArgs, options);
    const checkout=require('./skill-git').checkoutOptions(tmp);
    try { execFileSync('git',[...checkout.args,'checkout','--detach','HEAD'],{...options,env:checkout.env}); }
    finally { checkout.close(); }
    const root = path.join(tmp, ...segments);
    const resolved = path.resolve(root);
    if (!require('./repository-skills').within(tmp, resolved)) throw new Error('Invalid subdirectory.');
    if (!fs.existsSync(resolved) || !require('./repository-skills').within(tmp, fs.realpathSync(resolved))) throw new Error('Subdirectory unavailable.');
    return { items: collectSkillDirs(resolved), cleanup: tmp };
  } catch (error) { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); throw error; }
}

/** Install one resolved skill item into one target AI. */
function installItem(item, target) {
  const skillsDir = target.skillsDir;
  fs.mkdirSync(skillsDir, { recursive: true });

  const dstDir = path.join(skillsDir, item.name);
  const resolvedDst = path.resolve(dstDir);
  if (!resolvedDst.startsWith(path.resolve(skillsDir))) throw new Error('Path traversal blocked.');
  let exists = false;
  try { fs.lstatSync(dstDir); exists = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (exists) throw new Error('conflict-skipped: 기존 스킬 또는 연결이 있습니다. 덮어쓰지 않았습니다.');
  if (item.kind === 'dir') dirSize(item.path);
  const temporary = path.join(skillsDir, '.' + item.name + '-' + crypto.randomUUID());
  try {
    if (item.kind === 'file') {
      if (fs.statSync(item.path).size > MAX_SKILL_BYTES) throw new Error('Skill source exceeds 50 MB limit.');
      fs.mkdirSync(temporary);
      fs.copyFileSync(item.path, path.join(temporary, 'SKILL.md'));
    } else copyDir(item.path, temporary);
    if (!fs.existsSync(path.join(temporary, 'SKILL.md'))) throw new Error('Installed skill is missing SKILL.md.');
    fs.renameSync(temporary, dstDir);
  } finally { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 }); }
  return dstDir;
}

/**
 * Install skills from a source into multiple AI targets.
 * @param {string} source local path or GitHub URL
 * @param {string[]} targetIds ids from detectTargets()
 */
function install(source, targetIds) {
  const targets = detectTargets().filter((t) => targetIds.includes(t.id));
  if (!targets.length) throw new Error('No valid install targets selected.');
  const { items, cleanup } = resolveSource(source);
  const results = [];
  const installed = listInstalled();
  const repairs = new Map(targets.map((target) => [target.id, []]));
  try {
    if (!items.length) throw new Error('선택한 경로에서 SKILL.md를 찾지 못했습니다.');
    for (const item of items) {
      for (const target of targets) {
        try {
          if (installed.find(t => t.id === target.id)?.skills.some(s => path.posix.basename(s).toLowerCase() === item.name.toLowerCase()))
            throw new Error('conflict-skipped: 같은 이름의 스킬이 다른 분류 또는 연결로 이미 등록돼 있습니다.');
          results.push({
            skill: item.name,
            target: target.name,
            installedTo: installItem(item, target),
            layoutRepairs: repairs.get(target.id),
            ok: true,
          });
        } catch (err) {
          results.push({ skill: item.name, target: target.name, ok: false, error: String(err.message || err) });
        }
      }
    }
  } finally {
    if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true, maxRetries: 3 });
  }
  return results;
}

/** List installed skills per target. */
function listInstalled() {
  const out = [];
  for (const t of detectTargets()) {
    let skills = [];
    try {
      const visited = new Set();
      function walk(dir, prefix = '', depth = 0) {
        if (depth > 12) return;
        const real = fs.realpathSync(dir);
        if (visited.has(real)) return;
        visited.add(real);
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          const p = path.join(dir, entry.name), relative = prefix ? prefix + '/' + entry.name : entry.name;
          try {
            if (!fs.statSync(p).isDirectory()) continue;
            if (fs.existsSync(path.join(p, 'SKILL.md'))) skills.push(relative);
            else walk(p, relative, depth + 1);
          } catch { /* Broken link is not an installed skill. */ }
        }
      }
      walk(t.skillsDir);
    } catch { /* dir absent */ }
    out.push({ target: t.name, id: t.id, skillsDir: t.skillsDir, skills });
  }
  return out;
}

/** Resolve an installed skill's path safely inside the target's skills dir. */
function installedSkillPath(targetId, skillName) {
  const target = detectTargets().find((t) => t.id === targetId);
  if (!target) throw new Error(`Unknown target: ${targetId}`);
  if (!/^[\w][\w./-]{0,240}$/.test(skillName) || skillName.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid skill name.');
  const p = path.resolve(target.skillsDir, skillName);
  if (!p.startsWith(path.resolve(target.skillsDir) + path.sep)) throw new Error('Path traversal blocked.');
  if (!fs.existsSync(p)) throw new Error(`Skill not found: ${skillName}`);
  return { target, path: p };
}

/** Delete an installed skill (folder or .md file) from one AI target. */
function removeSkill(targetId, skillName) {
  const { target, path: p } = installedSkillPath(targetId, skillName);
  const realRoot = fs.realpathSync(target.skillsDir), parent = fs.realpathSync(path.dirname(p));
  if (fs.lstatSync(target.skillsDir).isSymbolicLink()) throw new Error('공유 스킬 루트의 원본은 삭제하지 않습니다.');
  if (!require('./repository-skills').within(realRoot, parent)) throw new Error('공유 폴더 내부의 스킬은 여기서 삭제할 수 없습니다. 등록 연결을 관리하세요.');
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
  return { target: target.name, removed: skillName };
}

/** First ~4000 chars of a skill's main markdown, for GUI preview. */
function previewSkill(targetId, skillName) {
  const { target, path: entry } = installedSkillPath(targetId, skillName);
  const isDirectory = fs.statSync(entry).isDirectory();
  // Shared installations can point at a skill directory outside this target using a junction.
  // Only the directory's own main Markdown is eligible. Loose files must belong to the target.
  const file = isDirectory ? ['SKILL.md','README.md'].map(name => path.join(entry,name)).find(fs.existsSync) : entry;
  if (!file) return '(미리보기할 SKILL.md가 없습니다)';
  const root = fs.realpathSync(isDirectory ? entry : target.skillsDir);
  const actual = fs.realpathSync(file);
  if (!/\.(?:md|markdown)$/i.test(file) || !fs.lstatSync(file).isFile()
      || !require('./repository-skills').within(root, actual)) throw new Error('Invalid skill preview path.');
  const fd = fs.openSync(file, 'r');
  try {
    // 16 KiB covers 4,000 UTF-8 characters without loading an entire file.
    const buffer = Buffer.alloc(16 * 1024);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString('utf8', 0, read);
    require('./prompt-safety').assertNoSecrets(text);
    return text.slice(0, 4000);
  } finally { fs.closeSync(fd); }
}

module.exports = {
  install, listInstalled, resolveSource, sanitizeName, removeSkill, previewSkill, repairTargetLayout,
};

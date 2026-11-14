'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const io = fs.promises;
const clean = text => String(text).replace(/^\uFEFF/, '');
const within = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
const busy = new Set();

async function repository() {
  const cfg = require('./config').load();
  const configured = cfg.sharedContext?.repoPath;
  const candidates = configured ? [configured] : require('./public-profile').enabled ? [] : [
    path.join(os.homedir(), 'Documents', 'Codex', 'codex-shared-context'),
    path.join(os.homedir(), 'Documents', 'GitHub', 'codex-shared-context'),
  ];
  for (const candidate of candidates) {
    try {
      const root = await io.realpath(candidate);
      const catalog = path.join(root, 'skills', 'CATALOG.md');
      await io.access(catalog);
      return { root, catalog, skillsRoot: path.join(root, 'skills') };
    } catch (error) { if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new Error('공유 저장소를 찾지 못했습니다. 메모리 탭에서 codex-shared-context clone 경로를 설정하세요.');
}

// 스킬 색인과 같은 앞머리 읽기를 쓴다 — 이전 정규식은 `description: >`(접은 여러 줄)를 빈 설명으로 읽어 그래프의 스킬 용도가 비었다.
function frontmatter(text, fallback) {
  const fm = require('./markdown-frontmatter').frontmatter(clean(text)) || {};
  const name = String(fm.name || '').replace(/^['"]|['"]$/g, '').trim() || fallback;
  const description = String(fm.description || '').replace(/^[>|-]+\s*/, '').replace(/\s+/g, ' ').replace(/^['"]|['"]$/g, '').trim();
  return { name, description };
}

async function list(query = '') {
  const repo = await repository(), skills = [];
  async function walk(dir) {
    const entries = await io.readdir(dir, { withFileTypes: true });
    const main = entries.find(e => e.isFile() && e.name.toLowerCase() === 'skill.md');
    if (main) {
      const file = path.join(dir, main.name), text = clean(await io.readFile(file, 'utf8'));
      const relative = path.relative(repo.root, file).split(path.sep).join('/');
      skills.push({ ...frontmatter(text, path.basename(dir)), path: relative,
        category: path.relative(repo.skillsRoot, dir).split(path.sep)[0], text });
      return;
    }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) await walk(path.join(dir, e.name));
  }
  await walk(repo.skillsRoot);
  const terms = String(query).toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return { ...repo, skills: skills.filter(s => terms.every(t => `${s.name} ${s.path} ${s.description} ${s.text}`.toLocaleLowerCase().includes(t))).map(({ text, ...s }) => s) };
}

async function selected(relative) {
  const repo = await repository();
  if (typeof relative !== 'string' || !/^skills\//.test(relative)) throw new Error('저장소 스킬 경로가 필요합니다.');
  const file = await io.realpath(path.resolve(repo.root, relative));
  if (!within(repo.skillsRoot, file) || path.basename(file).toLowerCase() !== 'skill.md') throw new Error('저장소 밖의 스킬 경로입니다.');
  return { ...repo, file };
}
async function preview(relative) { const s = await selected(relative); return clean(await io.readFile(s.file, 'utf8')); }
async function install(relative, targets) {
  const s = await selected(relative);
  return require('./skills').install(path.dirname(s.file), targets);
}

// Older preload clients passed a path. External material goes through the same add/review flow as the current UI.
async function installExisting(source, targets) {
  if (typeof source !== 'string' || /^https?:\/\//i.test(source)) throw new Error('새 URL 또는 파일은 스킬 추가 미리보기에서 검토하세요.');
  const repo = await repository();
  const candidate = path.resolve(repo.root, source);
  if (!within(repo.skillsRoot, candidate)) throw new Error('새 URL 또는 파일은 스킬 추가 미리보기에서 검토하세요.');
  const file = path.basename(candidate).toLowerCase() === 'skill.md' ? candidate : path.join(candidate,'SKILL.md');
  return install(path.relative(repo.root,file).split(path.sep).join('/'), targets);
}

// Import into the existing clone only. Publishing is an explicit separate Git operation.
async function add({ source, category, reviewId }) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(category)) throw new Error('분류는 영문 소문자·숫자·하이픈으로 입력하세요.');
  const repo = await repository();
  if (busy.has(repo.root)) throw new Error('다른 스킬 추가 작업이 진행 중입니다.');
  busy.add(repo.root);
  let resolved, temporary, destination, clone, moved = false, committed = false;
  try {
    const intake = require('./skill-intake');
    const prompt = intake.parse(source);
    let input = prompt.input.replace(/^["']|["']$/g, ''), origin = input;
    if (/^https?:\/\//i.test(input)) {
      const url = new URL(input), parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
      if (url.origin !== 'https://github.com' || url.username || url.password || !/^[\w.-]+$/.test(parts[0] || '') || !/^[\w.-]+$/.test(parts[1] || '')) throw new Error('https://github.com/owner/repo 형식의 URL을 사용하세요.');
      const args = ['clone','--no-checkout','--template=','--depth','1','--no-tags','--no-recurse-submodules'];
      const remote = `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/i, '')}.git`;
      const pinned = /^[0-9a-f]{40}$/i.test(parts[3] || '');
      if (['tree','blob'].includes(parts[2])) {
        if (!/^[\w.-]+$/.test(parts[3] || '') || parts[3].startsWith('-')) throw new Error('유효한 Git ref가 필요합니다. 슬래시가 있는 브랜치는 로컬 clone에서 선택하세요.');
        if (!pinned) args.push('--branch', parts[3]);
      } else if (parts.length > 2) throw new Error('지원하지 않는 GitHub URL입니다.');
      const segments = require('./skill-git').githubSubdirectory(parts.slice(4));
      clone = await io.mkdtemp(path.join(os.tmpdir(), 'aihub-repo-skill-'));
      const git = (a, env = {...process.env,GIT_TERMINAL_PROMPT:'0'}) => new Promise((resolve,reject) => execFile('git',['-c','core.hooksPath=' + os.devNull,'-c','submodule.recurse=false','-c','protocol.ext.allow=never','-c','protocol.file.allow=never',...a],
        {windowsHide:true,timeout:120000,maxBuffer:1024**2,env},
        (e,stdout)=>e ? reject(new Error('GitHub 소스를 가져오지 못했습니다. URL·인증·연결 상태를 확인하세요.')) : resolve(stdout.trim())));
      if (pinned) {
        await git(['init','-q','--template=',clone]);
        await git(['-C',clone,'fetch','--no-recurse-submodules','--no-tags','--depth=1',remote,parts[3]]);
      } else await git([...args,remote,clone]);
      const checkout = require('./skill-git').checkoutOptions(clone);
      try { await git([...checkout.args,'checkout','--detach', pinned ? 'FETCH_HEAD' : 'HEAD'], checkout.env); }
      finally { checkout.close(); }
      origin = remote + '@' + await git(['-C',clone,'rev-parse','HEAD']);
      input = path.resolve(clone, ...segments);
      if (!within(clone, input) || !within(clone, await io.realpath(input))) throw new Error('저장소 밖의 스킬 경로입니다.');
    }
    resolved = require('./skills').resolveSource(input);
    if (prompt.select) resolved.items = resolved.items.filter(item => item.name === prompt.select);
    if (resolved.items.length !== 1) throw new Error('추가할 스킬 폴더 한 개를 선택하세요. --skill 이름 또는 GitHub 하위 폴더 URL을 사용하세요.');
    const item = resolved.items[0];
    let name = item.name;
    if (clone && item.path === clone) {
      name = require('./skills').sanitizeName(frontmatter(await io.readFile(path.join(clone,'SKILL.md'),'utf8'), name).name);
    }
    const existing = await list();
    if (existing.skills.some(s => s.name.toLowerCase() === name.toLowerCase() || path.basename(path.dirname(s.path)).toLowerCase() === name.toLowerCase())) throw new Error('동일 이름의 스킬이 저장소에 있습니다. 기존 내용을 덮어쓰지 않습니다.');
    const categoryDir = path.join(repo.skillsRoot, category);
    if (!within(repo.skillsRoot, await io.realpath(categoryDir))) throw new Error('기존 저장소 분류를 선택하세요.');
    destination = path.join(categoryDir, name);
    try { await io.lstat(destination); throw new Error('목적지 폴더가 이미 있습니다.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    temporary = path.join(categoryDir, '.' + name + '-' + crypto.randomUUID());
    await io.mkdir(temporary);
    let bytes = 0;
    if (item.kind === 'file') {
      if ((await io.stat(item.path)).size > 50 * 1024 ** 2) throw new Error('스킬 크기가 50 MB를 초과합니다.');
      await io.copyFile(item.path, path.join(temporary, 'SKILL.md'));
    } else await io.cp(item.path, temporary, { recursive: true, filter: async p => {
      const stat = await io.lstat(p);
      if (stat.isSymbolicLink() || path.basename(p).toLowerCase() === '.git') return false;
      if (stat.isFile()) bytes += stat.size;
      if (bytes > 50 * 1024 ** 2) throw new Error('스킬 크기가 50 MB를 초과합니다.');
      return true;
    } });
    const skillFile = path.join(temporary, 'SKILL.md');
    if (clone && item.path !== clone) {
      for (const entry of await io.readdir(clone,{withFileTypes:true})) {
        if (entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(entry.name)) {
          try { await io.copyFile(path.join(clone,entry.name),path.join(temporary,entry.name),fs.constants.COPYFILE_EXCL); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
      }
    }
    const text = clean(await io.readFile(skillFile, 'utf8')), fields = frontmatter(text, name);
    if (fields.name !== name) throw new Error('SKILL.md의 name과 폴더 이름이 다릅니다. 일치시킨 뒤 추가하세요.');
    await io.writeFile(skillFile, text, 'utf8');
    const before = await io.readFile(repo.catalog);
    const relative = `skills/${category}/${name}/SKILL.md`;
    const description = fields.description.replace(/[|\r\n]/g, ' ');
    const next = clean(before.toString('utf8')).trimEnd() + `\n\n### Hub 추가: ${name}\n\n| 분류 | 스킬 | 설명 | 원본 |\n|---|---|---|---|\n| ${category} | ${name} | ${description} | [SKILL.md](${category}/${name}/SKILL.md) |\n`;
    const reviewed = await intake.inspect(temporary, path.posix.dirname(relative), next.slice(clean(before.toString('utf8')).trimEnd().length),origin,existing.skills);
    if (!reviewId) return { preview:reviewed };
    if (reviewId !== reviewed.reviewId) throw new Error('미리보기 이후 입력이 달라졌습니다. 다시 미리보세요.');
    await io.rename(temporary, destination); temporary = null; moved = true;
    const catalogTemp = repo.catalog + '.tmp-' + crypto.randomUUID();
    try {
      await io.writeFile(catalogTemp, next, 'utf8');
      if (!(await io.readFile(repo.catalog)).equals(before)) throw new Error('카탈로그가 변경되었습니다. 다시 시도하세요.');
      await io.rename(catalogTemp, repo.catalog);
    } finally { await io.rm(catalogTemp, { force: true }); }
    committed = true;
    return { path: relative, root: repo.root, published: false };
  } finally {
    busy.delete(repo.root);
    if (temporary) await io.rm(temporary, { recursive: true, force: true });
    if (moved && !committed) await io.rm(destination, { recursive: true, force: true });
    if (resolved?.cleanup) await io.rm(resolved.cleanup, { recursive: true, force: true });
    if (clone) await io.rm(clone, { recursive: true, force: true });
  }
}
function update() {
  return repository().then(repo => new Promise((resolve, reject) => {
    execFile('git', ['-C', repo.root, 'status', '--porcelain'], { windowsHide: true, timeout: 15000 }, (error, stdout) => {
      if (error) return reject(error);
      if (String(stdout).trim()) return reject(new Error('로컬 변경이 있어 갱신을 보류했습니다. 먼저 저장소 변경을 정리하세요.'));
      execFile('git', ['-C', repo.root, 'pull', '--ff-only', '--no-tags', '--no-recurse-submodules'],
        { windowsHide: true, timeout: 90000 }, (e) => e ? reject(new Error('저장소 갱신 실패. 인증·연결·분기 상태를 확인하세요.')) : resolve({ updated: true }));
    });
  }));
}
module.exports = { repository, list, selected, preview, install, installExisting, add, update, within, frontmatter };

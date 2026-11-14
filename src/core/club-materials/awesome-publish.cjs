'use strict';
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const {spawn} = require('node:child_process');
const remote = 'https://github.com/your-org/your-site.git';
const branch = 'automation/discord-awesome', file = 'exhibition/discord/feed.json';
const linksFile = 'exhibition/discord/public-links.json';
const publicFeed = require('./awesome-public-links.cjs');

async function publish(snapshot, {claimDispatch,publicLinks} = {}) {
  if(publicLinks)publicFeed.validate(publicLinks,snapshot.observedAt);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-hub-awesome-'));
  const env = {...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
    GIT_INDEX_FILE: path.join(root, 'snapshot.index'),
    GIT_AUTHOR_NAME: 'ai-hub', GIT_COMMITTER_NAME: 'ai-hub',
    GIT_AUTHOR_EMAIL: 'ai-hub@users.noreply.github.com', GIT_COMMITTER_EMAIL: 'ai-hub@users.noreply.github.com'};
  const git = (args, input) => new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      '-c', 'submodule.recurse=false', '-c', 'credential.interactive=false', ...args],
    {cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    let output = '', outputBytes = 0, errorBytes = 0, timedOut = false, overLimit = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 45000);
    child.stdout.on('data', x => {
      if (overLimit) return;
      outputBytes += Buffer.byteLength(x);
      if (outputBytes > 1048576) { overLimit = true; child.kill(); return; }
      output += x;
    });
    child.stderr.on('data', x => {
      if (overLimit) return;
      errorBytes += Buffer.byteLength(x);
      if (errorBytes > 1048576) { overLimit = true; child.kill(); }
    });
    child.on('error', () => { clearTimeout(timer); reject(Error('snapshot_git_unavailable')); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal || timedOut || overLimit) reject(Error('snapshot_git_failed')); else resolve(output.trim());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
  try {
    await git(['init', '--bare', '--quiet']);
    await git(['remote', 'add', 'origin', remote]);
    const refs = await git(['ls-remote', '--heads', 'origin', 'refs/heads/main', 'refs/heads/' + branch]);
    const rows = new Map(refs.split('\n').filter(Boolean).map(x => { const [sha, ref] = x.split(/\s+/); return [ref, sha]; }));
    if (!/^[a-f0-9]{40,64}$/.test(rows.get('refs/heads/main') || '')) throw Error('snapshot_main_unavailable');
    const ref = rows.has('refs/heads/' + branch) ? branch : 'main';
    await git(['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', 'refs/heads/' + ref]);
    const parent = await git(['rev-parse', 'FETCH_HEAD']);
    if (parent !== rows.get('refs/heads/' + ref)) throw Error('snapshot_head_changed');
    let previous, previousLinks, unchanged=false;
    if (ref === branch) {
      try { previous = JSON.parse(await git(['show', parent + ':' + file])); }
      catch { throw Error('snapshot_remote_invalid'); }
      try { require('./awesome-journal.cjs').snapshot(previous); }
      catch { throw Error('snapshot_remote_invalid'); }
      if (Date.parse(previous.observedAt) > Date.parse(snapshot.observedAt)) throw Error('snapshot_remote_newer');
      if(await git(['ls-tree','--name-only',parent,'--',linksFile])){
        try {
          const prior=JSON.parse(await git(['show',parent+':'+linksFile]));
          previousLinks=publicFeed.validate(prior,prior.observedAt,{prior:true});
          if(Date.parse(prior.observedAt)>Date.parse(previous.observedAt))throw Error('future');
        }
        catch {throw Error('snapshot_remote_invalid');}
      }
    }
    // Legacy journals might have only aggregates. Preserve any already published cards at that boundary.
    let paired=publicLinks || (previousLinks && {...previousLinks,observedAt:snapshot.observedAt});
    if(paired && previousLinks){
      const prior=new Map(previousLinks.items.map(row=>[publicFeed.identity(row),row]));
      paired={...paired,items:paired.items.map(row=>{
        const saved=prior.get(publicFeed.identity(row));
        return saved?{...row,id:saved.id,publishedAt:saved.publishedAt}:row;
      })};
      publicFeed.validate(paired,snapshot.observedAt,{prior:true});
      const core = categories=>['news','info'].map(k=>[categories[k].messageCount,categories[k].lastMessageAt]);
      const values = rows=>rows.map(r=>[r.id,r.category,r.title,r.summary,r.url,r.publishedAt]).sort((a,b)=>a[0].localeCompare(b[0]));
      unchanged=previous.observedAt!==snapshot.observedAt && JSON.stringify(core(previous.categories))===JSON.stringify(core(snapshot.categories)) &&
          JSON.stringify(values(previousLinks.items))===JSON.stringify(values(paired.items));
    }
    if(previous && !previousLinks && !paired && previous.observedAt!==snapshot.observedAt){
      unchanged=['news','info'].every(k=>previous.categories[k].messageCount===snapshot.categories[k].messageCount &&
        previous.categories[k].lastMessageAt===snapshot.categories[k].lastMessageAt);
    }
    await git(['read-tree', parent]);
    for(const [name,value] of [[file,snapshot],...(paired?[[linksFile,paired]]:[])]){
      const blob = await git(['hash-object', '-w', '--stdin'], JSON.stringify(value, null, 2) + '\n');
      await git(['update-index', '--add', '--cacheinfo', '100644,' + blob + ',' + name]);
    }
    const tree = await git(['write-tree']);
    const parentTree = await git(['rev-parse', parent + '^{tree}']);
    let commit = parent;
    if (ref !== branch || tree !== parentTree) {
      commit = await git(['commit-tree', tree, '-p', parent], 'Update Discord Awesome aggregates\n');
      // A competing writer makes this fast-forward push fail. Never force or silently retry.
      await git(['push', '--quiet', 'origin', commit + ':refs/heads/' + branch]);
    }
    if(unchanged)return {commit,dispatch:'unchanged'};
    // Dispatch the fixed main-branch workflow after publication; the cron is a recovery path.
    // Credential-helper output stays inside this call and is never written or logged.
    let dispatch = 'deferred';
    if (claimDispatch && !await claimDispatch(commit)) return {commit, dispatch};
    try {
      const fields = Object.fromEntries((await git(['credential', 'fill'], 'protocol=https\nhost=github.com\n\n'))
        .split('\n').filter(x => x.includes('=')).map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
      if (!fields.password) throw Error('github_credential_unavailable');
      const response = await fetch('https://api.github.com/repos/your-org/your-site/actions/workflows/deploy-game-exhibition.yml/dispatches', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: {Authorization: 'Bearer ' + fields.password, 'User-Agent': 'ai-hub-awesome',
          Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'},
        body: JSON.stringify({ref: 'main', inputs: {awesome_auto: true}}) });
      if (response.status === 204) dispatch = 'accepted';
      // The response body is neither needed nor safe to log.
      await response.body?.cancel();
    } catch { /* A failed/unknown dispatch is not replayed; the fixed cron will import the branch. */ }
    return {commit, dispatch};
  } finally {
    // This is the isolated bare repository created above; no credentials or user files are stored here.
    await fs.rm(root, {recursive: true, force: true});
  }
}
module.exports = {publish};

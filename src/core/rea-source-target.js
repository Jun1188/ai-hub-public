'use strict';
// Reuse the source graph's selection, exclusions and budgets for preview and immutable copies.
const fs = process.versions.electron ? require('original-fs') : require('fs');
const path = require('path');
const crypto = require('crypto');
const {isSupportedSource:sourceFile,sourceExclusions:SKIP,isExcludedSourceFolder} = require('./analysis-graph');
const BINARY = new Set(['.exe','.dll','.sys','.ocx','.cpl','.scr','.drv','.efi','.node','.pyd','.winmd','.netmodule','.asar','.lnk']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function validateText(body) {
  try { if (body.includes(0)) throw Error(); new TextDecoder('utf-8',{fatal:true}).decode(body); }
  catch { throw new Error('소스 파일은 UTF-8 텍스트로 선택하세요.'); }
  return body;
}
async function readSource(root,file) {
  // A local, read-only snapshot allows hard-linked source and ordinary folder names.
  // Check the opened file identity and path before/after a bounded read; never follow a changed link.
  const realRoot=await fs.promises.realpath(root), realFile=await fs.promises.realpath(file);
  const relative=path.relative(realRoot,realFile);
  if (!relative || relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) throw new Error('소스 경로가 선택한 폴더 밖입니다.');
  const handle=await fs.promises.open(realFile,'r');
  try {
    const initial=await handle.stat({bigint:true});
    if (!initial.isFile() || initial.size>BigInt(1024**2)) throw new Error('소스 파일은 1 MiB 이하로 선택하세요.');
    const verify=async()=>{
      const now=await fs.promises.stat(realFile,{bigint:true});
      if (await fs.promises.realpath(root)!==realRoot || await fs.promises.realpath(file)!==realFile ||
        now.dev!==initial.dev || now.ino!==initial.ino || now.ctimeNs!==initial.ctimeNs || now.size!==initial.size)
        throw new Error('읽는 동안 소스가 바뀌었습니다. 다시 선택하세요.');
    };
    await verify();
    const parts=[];let bytes=0;
    for await (const chunk of handle.createReadStream({autoClose:false,end:1024**2,signal:AbortSignal.timeout(15000)})) {
      bytes+=chunk.length;if(bytes>1024**2)throw new Error('소스 파일은 1 MiB 이하로 선택하세요.');parts.push(chunk);
    }
    await verify();return Buffer.concat(parts,bytes);
  } finally {await handle.close();}
}

async function codebaseInfo(root) {
  let scoped;
  try { scoped = await require('./analysis-graph').selection(root, ['.']); }
  catch (error) {
    const messages = {scope_too_large_narrow_selection:'코드베이스 범위가 큽니다. 소스 200개·합계 20 MiB 이하의 하위 폴더를 선택하세요.',
      source_file_too_large:'코드베이스에 1 MiB를 넘는 소스가 있습니다. 더 작은 소스 폴더를 선택하세요.',
      no_supported_source_files:'C/C++·C#·JS/TS·Python 소스가 있는 폴더를 선택하세요.'};
    throw new Error(messages[error.message] || error.message);
  }
  const files = [];
  for (const file of scoped.files) {
    const relative=path.relative(scoped.root,file).split(path.sep).join('/');
    try {files.push({file:relative,sha256:hash(validateText(await readSource(scoped.root,file)))});}
    catch(error) {throw new Error('소스 확인 실패 ('+relative+'): '+error.message);}
  }
  return { path:scoped.root, format:'source', bytes:scoped.bytes, sha256:hash(JSON.stringify(files)),
    structure:{ kind:'codebase', sourceFiles:files.length, files, exclusions:[...SKIP],
      limits:{files:200,fileBytes:1024**2,totalBytes:20*1024**2} } };
}

async function directoryInfo(root) {
  const candidates = [], queue = [{dir:root,excluded:false}], deferred = [], excludedFolders = [];
  let visited = 0, truncated = false, candidatesTruncated = false, sources = 0, sourceBytes = 0, sourceTooLarge = false,
    skipped = 0, unreadable = 0, sourceUnreadable = 0, headerUnreadable = 0, probes = 0, sourceTruncated = false,
    excludedSourcesObserved = 0;
  while ((queue.length||deferred.length) && !truncated) {
    // Finish the selected source tree before spending the remaining budget on generated/engine folders.
    const {dir,excluded} = (queue.length?queue:deferred).shift();
    // opendir is incremental: a large installation must not allocate an unbounded listing.
    let entries;
    try { entries = await fs.promises.opendir(dir); }
    catch { unreadable++; if(!excluded)sourceUnreadable++; continue; }
    for await (const entry of entries) {
      if (++visited > 4000) { truncated = true; sourceTruncated=!excluded; break; }
      const file = path.join(dir,entry.name);
      const stat = await fs.promises.lstat(file).catch(()=>null);
      if (!stat) { unreadable++;if(!excluded&&(entry.isDirectory()||sourceFile(file)))sourceUnreadable++;continue; }
      if (stat.isSymbolicLink()) { skipped++; continue; }
      if (stat.isDirectory()) {
        if (['node_modules','.git','graphify-out'].includes(entry.name)) { excludedFolders.push(path.relative(root,file)); continue; }
        const omit=excluded||isExcludedSourceFolder(entry.name);
        if(omit&&!excluded)excludedFolders.push(path.relative(root,file));
        (omit?deferred:queue).push({dir:file,excluded:omit});continue;
      }
      if (!stat.isFile()) { skipped++; continue; }
      const source = sourceFile(file);
      if (source && !excluded) { sources++; sourceBytes+=stat.size; sourceTooLarge ||= stat.size>1024**2; }
      if(source&&excluded)excludedSourcesObserved++;
      let binary = BINARY.has(path.extname(file).toLowerCase());
      if (!source && !binary && probes < 256) {
        probes++;
        let handle;
        try { handle=await fs.promises.open(file,'r'); const magic=Buffer.alloc(2);
          binary=(await handle.read(magic,0,2,0)).bytesRead===2 && magic.readUInt16LE()===0x5a4d; }
        catch { headerUnreadable++; }
        finally { if (handle) await handle.close(); }
      }
      if (source || binary) {
        if(candidates.length<200)candidates.push({path:file,relative:path.relative(root,file),bytes:stat.size,kind:'file',type:source?'소스':'바이너리·앱'});
        else candidatesTruncated=true;
      }
    }
  }
  candidates.sort((a,b) => a.relative.localeCompare(b.relative));
  const reason = sourceTruncated||sourceUnreadable ? '전체 소스 목록을 확인하지 못했습니다. 더 작은 하위 폴더를 선택하세요.' :
    sourceTooLarge ? '1 MiB를 넘는 소스가 있습니다. 더 작은 하위 폴더를 선택하세요.' :
    sources>200||sourceBytes>20*1024**2 ? '소스 200개·합계 20 MiB 한도를 넘습니다. 하위 폴더를 선택하세요.' : '';
  if (sources) candidates.unshift({path:root,relative:'이 폴더의 코드베이스 · 소스 '+sources+'개'+(reason?' · '+reason:''),
    kind:'codebase',type:'소스 묶음',disabled:!!reason});
  return { path:root, candidates, visited, truncated, candidatesTruncated, skipped, unreadable, headerUnreadable,
    codebaseReason:reason,excludedFolders,excludedSourcesObserved,excludedSourcesTotal:null,headerProbeLimitReached:probes===256,
    message:truncated||candidatesTruncated?'일부 파일 후보만 표시했습니다. 목록에 없는 파일은 하위 폴더나 파일 선택으로 확인하세요.':
      '분석할 파일 또는 코드베이스를 선택하세요. 폴더를 놓는 것만으로 분석하거나 실행하지 않습니다.' };
}

async function snapshotCodebase(target, dir) {
  const copy = path.join(dir,'input'), pending = path.join(dir,crypto.randomUUID()+'.partial');
  await fs.promises.mkdir(pending);
  try {
    for (const row of target.structure.files) {
      const from = path.resolve(target.path,row.file), to = path.resolve(pending,row.file);
      for (const [root,file] of [[target.path,from],[pending,to]]) {
        const rel = path.relative(root,file);
        if (!rel || rel === '..' || rel.startsWith('..'+path.sep) || path.isAbsolute(rel)) throw new Error('source_scope_outside_root');
      }
      const stat = await fs.promises.lstat(from);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024**2) throw new Error('소스 파일이 바뀌었습니다. 다시 선택하세요.');
      let body;
      try {body=validateText(await readSource(target.path,from));}
      catch(error){throw new Error('소스 확인 실패 ('+row.file+'): '+error.message);}
      if (hash(body) !== row.sha256) throw new Error('소스 파일이 바뀌었습니다. 다시 선택하세요.');
      await fs.promises.mkdir(path.dirname(to),{recursive:true});
      await fs.promises.writeFile(to,body,{flag:'wx',mode:0o600});
    }
    if ((await codebaseInfo(target.path)).sha256 !== target.sha256) throw new Error('코드베이스가 바뀌었습니다. 다시 선택하세요.');
    if ((await codebaseInfo(pending)).sha256 !== target.sha256) throw new Error('검증 사본의 지문이 달라졌습니다.');
    try { await fs.promises.rename(pending,copy); }
    catch (error) {
      if (!['EEXIST','ENOTEMPTY','EPERM'].includes(error.code)) throw error;
      const existing = await codebaseInfo(copy).catch(()=>null);
      if (existing?.sha256 !== target.sha256) throw error;
    }
    return copy;
  } finally {
    // Only the freshly allocated, content-addressed partial directory belongs to this operation.
    await fs.promises.rm(pending,{recursive:true,force:true});
  }
}
module.exports = { sourceFile, validateText, readSource, directoryInfo, codebaseInfo, snapshotCodebase };

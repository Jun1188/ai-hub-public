'use strict';
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { keyOf } = require('../evaluation/eval-store');
const { componentOf } = require('./harness-surface');

function revision(runId, base, decision, candidates) {
  return keyOf('reviewed-rsi-export/1',runId,base,decision,candidates);
}

function safeEntry(rel) {
  const parts=rel.split('/');
  return rel.length<=1000 && parts.every(part=>part && part!=='.' && part!=='..' && !/[\\<>:"|?*\x00-\x1f]/.test(part) &&
    !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) && !!componentOf(rel);
}

async function identical(folder, entries) {
  const expected=new Map(entries.filter(([,text])=>text!==null));
  let seen=0;
  async function walk(dir,prefix) {
    for (const file of await fs.readdir(dir,{withFileTypes:true})) {
      const rel=prefix+file.name, absolute=path.join(dir,file.name);
      if (file.isSymbolicLink()) return false;
      if (file.isDirectory()) { if(!await walk(absolute,rel+'/'))return false; continue; }
      if (!file.isFile() || !expected.has(rel))return false;
      const text=expected.get(rel);
      if ((await fs.stat(absolute)).size!==Buffer.byteLength(text) || await fs.readFile(absolute,'utf8')!==text)return false;
      seen++;
    }
    return true;
  }
  return await walk(folder,'') && seen===expected.size;
}

async function publish(dir,patch,digest) {
  const entries=Object.entries(patch), names=new Set();
  for (const [rel,text] of entries) {
    const name=os.platform()==='win32'?rel.toLowerCase():rel;
    if (!safeEntry(rel) || names.has(name) || (text!==null && typeof text!=='string'))throw Error('Invalid RSI export entry');
    names.add(name);
  }
  const final=path.join(dir,'adopted-'+digest);
  const staging=await fs.mkdtemp(path.join(dir,'review-export-'));
  try {
    for(const [rel,text] of entries) {
      if(text===null)continue;
      const file=path.join(staging,...rel.split('/'));
      await fs.mkdir(path.dirname(file),{recursive:true});
      await fs.writeFile(file,text,{flag:'wx'});
    }
    const existing = await fs.lstat(final).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
    if(existing) {
      if(!existing.isDirectory() || existing.isSymbolicLink() || !await identical(final,entries))throw Error('Existing RSI review export differs');
      return final;
    }
    try {await fs.rename(staging,final);}
    catch(error) {
      if(!['EEXIST','ENOTEMPTY','EPERM','EACCES'].includes(error.code))throw error;
      const existing=await fs.lstat(final).catch(()=>null);
      if (!existing?.isDirectory() || existing.isSymbolicLink() || !await identical(final,entries))throw error;
    }
    return final;
  } finally {
    // Only this call's private, mkdtemp-created staging directory.
    await fs.rm(staging,{recursive:true,force:true});
  }
}
module.exports={revision,publish};

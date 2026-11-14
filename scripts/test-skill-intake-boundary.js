'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const Module=require('node:module');
const child=require('node:child_process');
const {execFileSync}=child;
const work=fs.mkdtempSync(path.join(os.tmpdir(),'hub-intake-boundary-'));
const clone=path.join(work,'git');
const repo=path.join(work,'shared');
const source=path.join(work,'sample');
const skillsDir=path.join(repo,'skills','general');
const targetDir=path.join(work,'target');
for(const dir of [clone,source,skillsDir,targetDir]) fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(repo,'skills','CATALOG.md'),'# Catalog\n');
const skill=path.join(source,'SKILL.md');
const body='---\nname: sample\ndescription: fixture\n---\nReview this local example.\n';
fs.writeFileSync(skill,body);
const {checkoutOptions}=require('../src/core/skill-git');
const originalLoad=Module._load;
Module._load=function(request,parent,...rest){
  if(request==='./config' && parent.filename.endsWith('repository-skills.js')) return {load:()=>({sharedContext:{repoPath:repo}})};
  if(request==='./paths' && parent.filename.endsWith('skills.js')) return {detectTargets:()=>[{id:'fixture',name:'fixture',skillsDir:targetDir}]};
  if(request==='child_process' && parent.filename.endsWith('repository-skills.js')) return {...child,execFile:fixtureGit};
  return originalLoad.call(this,request,parent,...rest);
};
const {resolveSource,previewSkill}=require('../src/core/skills');
const repository=require('../src/core/repository-skills');
const scan=require('../src/core/supply/script-safety');
const gitEnv={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_GLOBAL:path.join(work,'global.config')};
fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL,'');
const git=(args,env=gitEnv)=>execFileSync('git',['-C',clone,...args],{env,encoding:'utf8',stdio:'pipe',windowsHide:true});
// Replace the one synthetic GitHub URL with a local repository at the child-process boundary.
// A URL that differs is a failed test, so these paths never contact a network or credentials.
const fixtureUrl='https://github.com/example/fixture.git';
function fixtureGit(program,args,opts,callback){
  assert.equal(program,'git');
  const translated=args.slice();
  if(translated.includes('clone') || translated.includes('fetch')){
    const remoteIndex=translated.indexOf(fixtureUrl);
    assert.notEqual(remoteIndex,-1);
    translated[remoteIndex]=require('node:url').pathToFileURL(clone).href;
    translated[translated.indexOf('protocol.file.allow=never')]='protocol.file.allow=always';
    opts={...opts,env:gitEnv};
  }
  return child.execFile(program,translated,opts,callback);
}
function gitFilterReproduction(){
  git(['init','--template=','-q']);
  fs.writeFileSync(path.join(clone,'.gitattributes'),'sample.txt filter=fixture\n');
  fs.writeFileSync(path.join(clone,'sample.txt'),'original\n');
  fs.mkdirSync(path.join(clone,'sample'));
  fs.writeFileSync(path.join(clone,'sample','SKILL.md'),body);
  fs.appendFileSync(path.join(clone,'.gitattributes'),'sample/SKILL.md filter=fixture\n');
  git(['add','--','.gitattributes','sample.txt','sample/SKILL.md']);
  git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--no-gpg-sign','-qm','sample']);
  // This benign local filter only turns the literal fixture text to upper case.
  const helper=path.join(work,'uppercase.cjs');
  fs.writeFileSync(helper,"let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>process.stdout.write(text.toUpperCase()));");
  git(['config','--file',gitEnv.GIT_CONFIG_GLOBAL,'filter.fixture.smudge',
    '"'+process.execPath.replaceAll('\\','/')+'" "'+helper.replaceAll('\\','/')+'"']);
  function reset(options,env){
    fs.unlinkSync(path.join(clone,'sample.txt'));
    git([...options,'checkout','-q','--','sample.txt'],env);
    return fs.readFileSync(path.join(clone,'sample.txt'),'utf8').trim();
  }
  assert.equal(reset([],gitEnv),'ORIGINAL');
  const isolated=checkoutOptions(clone);
  try{assert.equal(reset(isolated.args,isolated.env),'original');}
  finally{isolated.close();}
}
async function main(){
  gitFilterReproduction();
  const branch=git(['branch','--show-current']).trim(), commit=git(['rev-parse','HEAD']).trim();
  for(const ref of [branch,commit]){
    const {preview}=await repository.add({source:'https://github.com/example/fixture/tree/'+ref+'/sample',category:'general'});
    assert.equal(preview.origin,fixtureUrl+'@'+commit);
    assert.ok(preview.diff.includes(body));
  }
  const add=reviewId=>repository.add({source,category:'general',reviewId});
  const preview=await add();
  assert.ok(preview.preview.reviewId);
  assert.equal(fs.existsSync(path.join(skillsDir,'sample')),false);
  fs.appendFileSync(skill,'new bytes\n');
  await assert.rejects(()=>add(preview.preview.reviewId),/다시 미리/);
  fs.writeFileSync(skill,body);
  const dummy='sk-'+ 'x'.repeat(32);
  const unread='//fixture.invalid/placeholder';
  // Guard the filesystem boundary so even a regressed check cannot contact SMB.
  const exists=fs.existsSync;
  try{
    fs.existsSync=function(input){assert.notEqual(input,unread);return exists.call(this,input);};
    assert.throws(()=>resolveSource(unread),/local skill path/);
    await assert.rejects(()=>repository.add({source:unread,category:'general'}),/local skill path/);
    await assert.rejects(()=>repository.add({source:dummy,category:'general'}),err=>/credential/.test(err.message) && !err.message.includes(dummy));
  }finally{fs.existsSync=exists;}
  fs.appendFileSync(skill,dummy);
  await assert.rejects(()=>add(),err=>/credential/.test(err.message) && !err.message.includes(dummy));
  fs.writeFileSync(skill,body);
  fs.writeFileSync(path.join(source,'.gitattributes'),'sample.txt filter=fixture\n');
  await assert.rejects(()=>add(),/Git control/);
  fs.unlinkSync(path.join(source,'.gitattributes'));
  const targetPath=['credentials.local','example.json'].join('/');
  // Describe a local read to the scanner. No file at this path is opened.
  assert.equal(scan.scanText('open('+targetPath+')',{path:'note.md'}).verdict,'block');
  fs.appendFileSync(skill,['You are','now','an example reviewer.'].join(' '));
  const risky=await add();
  assert.ok(risky.preview.warnings.some(w=>w.includes('prompt-injection')));
  fs.writeFileSync(skill,body);
  const archive=path.join(work,'sample.zip');
  fs.writeFileSync(archive,'synthetic fixture');
  assert.throws(()=>resolveSource(archive),/markdown/);
  const deep='https://github.com/example/fixture/tree/main/normal%2f..%2f.git';
  assert.throws(()=>resolveSource(deep),/Invalid skill subdirectory/);
  await assert.rejects(()=>repository.add({source:deep,category:'general'}),/Invalid skill subdirectory/);
  const linked=path.join(work,'linked');
  fs.symlinkSync(source,linked,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>resolveSource(linked),/original skill path/);
  fs.unlinkSync(linked);
  const outside=path.join(work,'outside'), alias=path.join(targetDir,'shared');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside,'SKILL.md'),body);
  fs.writeFileSync(path.join(outside,'note.md'),'unrelated fixture');
  fs.writeFileSync(path.join(outside,'key-table.v2.json'),'dummy fixture');
  fs.symlinkSync(outside,alias,process.platform==='win32'?'junction':'dir');
  assert.equal(previewSkill('fixture','shared'),body);
  for(const file of ['note.md','key-table.v2.json']) assert.throws(()=>previewSkill('fixture','shared/'+file),/Invalid skill preview path/);
  fs.writeFileSync(path.join(outside,'SKILL.md'),dummy);
  assert.throws(()=>previewSkill('fixture','shared'),/credential/);
  await assert.rejects(()=>repository.installExisting(source,[]),/미리보기/);
  await assert.rejects(()=>repository.installExisting('https://github.com/example/fixture',[]),/미리보기/);
  const verified=await add(preview.preview.reviewId);
  assert.equal(verified.published,false);
  assert.equal(fs.readFileSync(path.join(skillsDir,'sample','SKILL.md'),'utf8'),body);
  console.log('PASS Git filter baseline and isolated checkout, branch and pinned URL (local transport), reviewed add and drift, secret and vault guards, Git metadata, warnings, ZIP, URL traversal, junction preview and legacy install.');
}
main().finally(()=>{Module._load=originalLoad;fs.rmSync(work,{recursive:true,force:true});})
  .catch(error=>{console.error(error.message);process.exitCode=1;});

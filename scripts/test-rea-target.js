'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {makeTargetService, analysisScope, snapshot, imageInfo} = require('../src/core/rea-target');

async function main() {
  if (process.platform !== 'win32') return console.log('REA Windows target test skipped on this platform');
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(),'rea-test-'));
  const source = path.join(root,'--옵션 모양 & %fixture%.exe'), shortcut = path.join(root,'fixture.lnk');
  const scope = {focus:'memory',include:'image',exclude:'settings',change:'report',acceptance:'digest'};
  const seen = [];
  let started = '133000000000000000', hwnd = '55';
  const svc = makeTargetService({readLink: () => ({target:source, args:'--never-run'}), probeSystem:async (mode,args) => {
    seen.push(mode);
    if (mode === 'file') {
      await fs.promises.access(args[1]);
      return {version:null};
    }
    return [{pid:12,started,path:source,name:'fixture',windows:[{Handle:hwnd,Title:'fixture'}]}];
  }});
  await fs.promises.copyFile(path.join(process.env.SystemRoot,'System32','whoami.exe'), source);
  await fs.promises.writeFile(shortcut,'test link');
  const input = {kind:'process',pid:12,started,hwnd};
  try {
    const initial = await svc.preview(input);
    assert.equal(initial.format,'native');
    assert.equal((await svc.preview({kind:'file',path:shortcut})).ignoredArguments,true);
    assert.deepEqual(await svc.verify(input,initial),initial);
    const copy = await snapshot(initial,root);
    assert.equal(path.relative(root,copy),path.join(initial.sha256,'input.exe'));
    assert.equal((await imageInfo(copy)).sha256,initial.sha256);
    assert.deepEqual(analysisScope(scope),scope);
    // The extension does not decide whether a module is a valid Windows PE.
    for (const name of ['driver.sys','control.ocx','plugin.node','renamed.module']) {
      const file = path.join(root,name);
      await fs.promises.copyFile(source,file);
      assert.equal((await svc.preview({kind:'file',path:file})).format,'native');
    }
    const app = path.join(root,'installed-app'), binaries = path.join(app,'Binaries');
    await fs.promises.mkdir(binaries,{recursive:true});
    await fs.promises.copyFile(source,path.join(binaries,'game.exe'));
    await fs.promises.copyFile(source,path.join(app,'launcher.exe'));
    const folder = await svc.preview({kind:'file',path:app});
    assert(!folder.sha256, 'Dropping a folder must not choose the first executable');
    assert.deepEqual(folder.folder.candidates.map(row=>row.relative).sort(),[path.join('Binaries','game.exe'),'launcher.exe'].sort());
    const codebase = path.join(root,'codebase');
    await fs.promises.mkdir(path.join(codebase,'node_modules'),{recursive:true});
    const samples = {'main.js':'function add(a,b) { return a+b; }', 'game.cs':'class Game { int Run() { return 1; } }',
      'main.py':'def run():\n    return 1\n'};
    for (const [name,body] of Object.entries(samples)) {
      const file = path.join(codebase,name);
      await fs.promises.writeFile(file,body);
      const selected = await svc.preview({kind:'file',path:file});
      assert.equal(selected.format,'source');
      assert.equal((await imageInfo(await snapshot(selected,root))).sha256,selected.sha256);
    }
    await fs.promises.writeFile(path.join(codebase,'node_modules','ignored.js'),'throw Error("dependency")');
    assert((await svc.preview({kind:'file',path:codebase})).folder.candidates.some(row=>row.kind==='codebase'));
    const project = {kind:'codebase',path:codebase}, selectedProject = await svc.preview(project);
    assert.equal(selectedProject.structure.sourceFiles,3);
    assert(selectedProject.structure.files.every(row=>!row.file.startsWith('node_modules')));
    const projectCopy = await snapshot(selectedProject,root);
    assert.equal((await imageInfo(projectCopy)).sha256,selectedProject.sha256);
    // A changed source and a newly added source each invalidate the complete selected set.
    await fs.promises.appendFile(path.join(codebase,'main.py'),'\n# edited');
    await assert.rejects(svc.verify(project,selectedProject));
    await assert.rejects(snapshot(selectedProject,root));
    const revised = await svc.preview(project);
    await fs.promises.writeFile(path.join(codebase,'new.cs'),'class New {}');
    await assert.rejects(svc.verify(project,revised));
    const tooLarge = path.join(root,'large.py');
    await fs.promises.writeFile(tooLarge,Buffer.alloc(1024**2+1,32));
    await assert.rejects(imageInfo(tooLarge),/1 MiB/);
    const limitsFolder = path.join(root,'oversize-codebase');
    await fs.promises.mkdir(limitsFolder);
    await fs.promises.copyFile(tooLarge,path.join(limitsFolder,'bundle.js'));
    const limited = (await svc.preview({kind:'file',path:limitsFolder})).folder;
    assert(limited.candidates.find(row=>row.kind==='codebase').disabled);
    await assert.rejects(svc.preview({kind:'codebase',path:limitsFolder}),/1 MiB/);
    await fs.promises.writeFile(path.join(binaries,'embedded.py'),'def run(): pass');
    assert(!(await svc.preview({kind:'file',path:app})).folder.candidates.some(row=>row.kind==='codebase'));
    await fs.promises.copyFile(source,path.join(app,'extensionless'));
    await fs.promises.writeFile(path.join(app,'unsupported.so'),'not a Windows module');
    const discovered = (await svc.preview({kind:'file',path:app})).folder;
    assert(discovered.candidates.some(row=>row.relative==='extensionless'));
    assert(!discovered.candidates.some(row=>row.relative==='unsupported.so'));
    const utf16 = path.join(root,'utf16'); await fs.promises.mkdir(utf16);
    await fs.promises.writeFile(path.join(utf16,'utf16.py'),Buffer.from('def run(): pass','utf16le'));
    await assert.rejects(imageInfo(path.join(utf16,'utf16.py')),/UTF-8/);
    await assert.rejects(svc.preview({kind:'codebase',path:utf16}),/UTF-8/);
    await assert.rejects(svc.preview({kind:'codebase',path:utf16}),/utf16\.py/);
    const mixed = path.join(root,'mixed-large');await fs.promises.mkdir(mixed);
    for(let i=0;i<150;i++) await fs.promises.writeFile(path.join(mixed,'source-'+i+'.py'),'def run(): pass');
    for(let i=0;i<60;i++) await fs.promises.writeFile(path.join(mixed,'module-'+i+'.dll'),'candidate only');
    let mixedFolder=(await svc.preview({kind:'file',path:mixed})).folder;
    assert(mixedFolder.candidatesTruncated);
    assert.equal(mixedFolder.candidates.find(row=>row.kind==='codebase').disabled,false);
    const special=path.join(root,'source-names');await fs.promises.mkdir(path.join(special,'credentials'),{recursive:true});
    await fs.promises.writeFile(path.join(special,'credentials','id_client.py'),'def run(): pass');
    await fs.promises.link(path.join(special,'credentials','id_client.py'),path.join(special,'linked.py'));
    assert.equal((await svc.preview({kind:'codebase',path:special})).structure.sourceFiles,2);
    const generated=path.join(root,'large-generated'), generatedEnv=path.join(generated,'.venv');
    await fs.promises.mkdir(generatedEnv,{recursive:true});
    for(let i=0;i<3;i++)await fs.promises.writeFile(path.join(generated,'selected-'+i+'.py'),'def run(): pass');
    for(let i=0;i<5000;i++)await fs.promises.writeFile(path.join(generatedEnv,'generated-'+i+'.py'),'pass');
    const generatedFolder=(await svc.preview({kind:'file',path:generated})).folder;
    assert(generatedFolder.truncated);
    assert.equal(generatedFolder.candidates.find(row=>row.kind==='codebase').disabled,false);
    assert.equal((await svc.preview({kind:'codebase',path:generated})).structure.sourceFiles,3);
    const openFile=fs.promises.open;
    await fs.promises.writeFile(path.join(special,'locked.dat'),'locked non-source');
    try {
      fs.promises.open=async(file,...args)=>{if(path.basename(file)==='locked.dat')throw Object.assign(Error('locked'),{code:'EACCES'});return openFile.call(fs.promises,file,...args);};
      const locked=(await svc.preview({kind:'file',path:special})).folder;
      assert.equal(locked.headerUnreadable,1);
      assert.equal(locked.candidates.find(row=>row.kind==='codebase').disabled,false);
    } finally {fs.promises.open=openFile;}
    await fs.promises.mkdir(path.join(special,'.venv'));
    await fs.promises.writeFile(path.join(special,'.venv','ignored.py'),'pass');
    assert.equal((await svc.preview({kind:'codebase',path:special})).structure.sourceFiles,2);
    assert.throws(() => analysisScope({...scope,include:''}));
    started = '133000000000000001';
    await assert.rejects(svc.verify(input,initial));
    started = input.started; hwnd = '56';
    await assert.rejects(svc.verify(input,initial));
    hwnd = input.hwnd;
    const before = seen.length;
    for (const bad of ['relative.exe','\\\\host\\share\\app.exe','C:\\x.exe:stream','C:\\x\\..\\app.exe']) await assert.rejects(svc.preview({kind:'file',path:bad}));
    assert.equal(seen.length,before);
    const asar=path.join(root,'fixture.asar'), json=Buffer.from(JSON.stringify({files:{'main.js':{size:0,offset:'0'}}}));
    const header=Buffer.alloc(16), aligned=Math.ceil(json.length/4)*4;
    header.writeUInt32LE(4,0);header.writeUInt32LE(aligned+8,4);header.writeUInt32LE(aligned+4,8);header.writeUInt32LE(json.length,12);
    await fs.promises.writeFile(asar,Buffer.concat([header,json,Buffer.alloc(aligned-json.length)]));
    assert.deepEqual((await imageInfo(asar)).structure.topLevel,['main.js']);
    await fs.promises.writeFile(asar,Buffer.concat([header,Buffer.from(json.toString().replace('"size":0','"size":9')),Buffer.alloc(aligned-json.length)]));
    await assert.rejects(imageInfo(asar),/입력 파일 범위/);
    await fs.promises.writeFile(asar,Buffer.concat([header,json.subarray(0,4)]));
    await assert.rejects(imageInfo(asar),/ASAR 헤더/);
    await fs.promises.writeFile(asar,'not an archive');
    await assert.rejects(imageInfo(asar));
    const malformed = path.join(root,'damaged.exe');
    const bytes = await fs.promises.readFile(source);
    await fs.promises.writeFile(malformed,bytes.subarray(0,40));
    await assert.rejects(imageInfo(malformed));
    await fs.promises.truncate(malformed,512*1024**2+1);
    await assert.rejects(imageInfo(malformed),/512 MiB/);
    const damaged = path.join(root,'invalid-section.exe'), pe = await fs.promises.readFile(source);
    const peStart = pe.readUInt32LE(60), sections = peStart + 24 + pe.readUInt16LE(peStart + 20);
    pe.writeUInt32LE(2048, sections + 16);
    pe.writeUInt32LE(pe.length - 1, sections + 20);
    await fs.promises.writeFile(damaged,pe);
    await assert.rejects(imageInfo(damaged),/PE 섹션이 입력 파일 범위/);
    await fs.promises.appendFile(source,'X');
    await assert.rejects(svc.verify(input,initial));
    await assert.rejects(snapshot(initial,root));
    console.log('REA target identity, scope, snapshot, shortcut, path, HWND and PID regression passed.');
  } finally {
    // All files in this freshly created directory are fixtures of this invocation.
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('rea-test-')) {
      await fs.promises.rm(root,{recursive:true,force:true});
    }
  }
}
main().catch(err => { console.error(err);process.exitCode=1; });

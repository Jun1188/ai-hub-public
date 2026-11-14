'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {register,isTrustedFrame,withTrustedFrame}=require('../electron/ipc/device-key-delivery');

(async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-key-dialogs-'));
  try {
    const request=path.join(dir,'card.hubrequest'),envelope=path.join(dir,'package.hubkey');
    const recipientFingerprint='B'.repeat(64),senderFingerprint='A'.repeat(64);
    const info={provider:'gemini',recipientFingerprint,origin:'https://generativelanguage.googleapis.com',recipientLabel:'Device',
      reference:'credential:api-gemini',requestId:'fixture',expiresAt:Date.now()+60000};
    let nextFile, nextAnswer=0, storeCalls=0, exports=0, revision='revision-a',sourceRevision='source-a';
    const dialog={
      showOpenDialog:async()=>nextFile?{canceled:false,filePaths:[nextFile]}:{canceled:true},
      showSaveDialog:async()=>nextFile?{canceled:false,filePath:nextFile}:{canceled:true},
      showMessageBox:async(_parent,options)=>{
        assert.equal(options.defaultId,0);assert.equal(options.cancelId,0);
        assert(options.detail.includes(recipientFingerprint));
        return {response:nextAnswer};
      }
    };
    const service={
      identity:()=>({fingerprint:recipientFingerprint,deviceLabel:'Device'}),
      createRequest:()=>({type:'request'}),inspectRequest:r=>{assert.equal(r.type,'request');return info;},
      sourceAliases:({expectedRecipientFingerprint})=>{
        assert.equal(expectedRecipientFingerprint,recipientFingerprint);
        return [{id:'gemini-jr',bound:false,revision:sourceRevision}];
      },
      seal:input=>{
        assert.equal(input.expectedRecipientFingerprint,recipientFingerprint);
        if(input.sourceAlias){assert.equal(input.sourceAlias,'gemini-jr');assert.equal(input.confirmBindAlias,true);assert.equal(input.expectedSourceRevision,sourceRevision);assert(!('secret' in input));}
        else assert.equal(input.secret,'synthetic-value');
        exports++; return {type:'envelope',ciphertext:'synthetic-ciphertext'};
      },
      inspectEnvelope:obj=>{assert.equal(obj.type,'envelope');return {...info,senderFingerprint,senderLabel:'Sender',
        alreadyStored:true,targetRevision:revision};},
      receive:input=>{
        assert.equal(input.expectedSenderFingerprint,senderFingerprint);
        assert.equal(input.expectedTargetRevision,revision);assert.equal(input.confirmReplace,true);
        storeCalls++;return {stored:true,provider:'gemini',alreadyReceived:false};
      }
    };
    const indexUrl='file:///C:/app/ui/index.html',frame={url:indexUrl+'#settings'};
    const contents=Object.assign(new EventEmitter(),{mainFrame:frame});
    const win={isDestroyed:()=>false,webContents:contents}, event={sender:contents,senderFrame:frame};
    const handlers={};
    register({handle:(name,fn)=>{handlers[name]=fn;},window:()=>win},{dialog,service:()=>service});
    const run=(name,...args)=>withTrustedFrame(event,()=>win,indexUrl,()=>handlers['deviceKey:'+name](...args));
    await assert.rejects(handlers['deviceKey:identity'](),/기기 키/);
    nextFile=request;await run('request','gemini');
    const first=await run('openRequest'),second=await run('openRequest');
    const args={provider:'gemini',expectedRecipientFingerprint:recipientFingerprint,ticket:second.ticket};
    await assert.rejects(run('export',{...args,ticket:first.ticket,secret:'synthetic-value'}));
    assert.deepEqual(await run('sources',args),[{id:'gemini-jr',bound:false}]);
    sourceRevision='source-b';
    await assert.rejects(run('export',{...args,sourceAlias:'gemini-jr'}),/키가 바뀌/);
    await run('sources',args);
    nextFile=envelope;
    assert.deepEqual(await run('export',{...args,sourceAlias:'gemini-jr'}),{canceled:true});
    assert.equal(exports,0);
    nextAnswer=1;await run('export',{...args,sourceAlias:'gemini-jr'});
    assert.equal(exports,1);
    nextFile=request;
    const direct=await run('openRequest');
    nextFile=envelope;await run('export',{...args,ticket:direct.ticket,secret:'synthetic-value'});
    assert.equal(exports,2);assert(!(await fs.readFile(envelope,'utf8')).includes('synthetic-value'));
    const stale=await run('openEnvelope');
    revision='revision-b';
    await assert.rejects(run('receive',{provider:'gemini',ticket:stale.ticket,expectedSenderFingerprint:senderFingerprint}),/바뀌었/);
    assert.equal(storeCalls,0);
    const opened=await run('openEnvelope');
    assert(!JSON.stringify(opened).includes('synthetic-ciphertext'));
    assert(!Object.hasOwn(opened.info,'targetRevision'));
    const receive={provider:'gemini',ticket:opened.ticket,expectedSenderFingerprint:senderFingerprint};
    await assert.rejects(run('receive',{...receive,expectedSenderFingerprint:recipientFingerprint}),/지문/);
    nextAnswer=0;assert.deepEqual(await run('receive',receive),{canceled:true});assert.equal(storeCalls,0);
    nextAnswer=1;assert.equal((await run('receive',receive)).stored,true);assert.equal(storeCalls,1);
    await assert.rejects(run('receive',receive));
    const long=path.join(dir,'oversize.hubrequest');await fs.writeFile(long,Buffer.alloc(65537));
    nextFile=long;await assert.rejects(run('openRequest'),/요청 카드/);
    let sealRan=false;
    dialog.showSaveDialog=async()=>{
      contents.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false});
      return {canceled:false,filePath:request};
    };
    service.createRequest=()=>{sealRan=true;return {};};
    await assert.rejects(run('request','gemini'));
    assert.equal(sealRan,false);
    assert.equal(contents.listenerCount('did-start-navigation'),0);
    assert(isTrustedFrame({sender:contents,senderFrame:frame},win,indexUrl));
    assert(!isTrustedFrame({sender:{mainFrame:frame},senderFrame:frame},win,indexUrl));
    assert(!isTrustedFrame({sender:contents,senderFrame:{url:indexUrl}},win,indexUrl));
    frame.url=indexUrl+'?untrusted';assert(!isTrustedFrame({sender:contents,senderFrame:frame},win,indexUrl));
    console.log('Device key dialogs: cancel, stale preview, alias binding, explicit recipient/sender, atomic revision, private responses, bounded file and trusted frame passed.');
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
// 1.29.0에서 뺀 Gemini 작업자의 키가 API 연결(api-gemini)로 옮겨지는지, TypeSafe는 옮기지 않는지,
// 공급자로는 계속 막히는지 본다.
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {createVault}=require('../src/core/credential-vault'),{createStore}=require('../src/core/api-connections');
const {run,LEGACY_API}=require('../src/core/credential-migration');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-vault-legacy-test-'));
process.env.APPDATA=path.join(root,'roaming');
const storage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('fixture-os:'+s),decryptString:b=>b.toString().slice(11)};
const vault=createVault({root,storage:()=>storage,binding:()=>'http://127.0.0.1:1234'});
const store=createStore({root,vault,isBusy:()=>false});
const dir=path.join(root,'credentials.local'),secret='fixture-legacy-key-never-real';
// 1.29.0 이전 Hub가 남긴 모양 그대로 쓴다(공급자 이름으로 된 v2 레코드 + 같은 키 표).
function writeLegacy(provider,origin){
  const tableFile=path.join(dir,'key-table.v2.json');
  const table=JSON.parse(storage.decryptString(Buffer.from(JSON.parse(fs.readFileSync(tableFile,'utf8')).encrypted,'base64')));
  const key=crypto.randomBytes(32),r={version:2,provider,reference:'credential:'+provider,origin,keyId:crypto.randomUUID(),nonce:crypto.randomBytes(12).toString('base64')};
  table.keys[r.keyId]=key.toString('base64');
  fs.writeFileSync(tableFile,JSON.stringify({version:2,encrypted:storage.encryptString(JSON.stringify(table)).toString('base64')}));
  const c=crypto.createCipheriv('aes-256-gcm',key,Buffer.from(r.nonce,'base64'));c.setAAD(Buffer.from(JSON.stringify([2,r.provider,r.reference,r.origin,r.keyId]),'utf8'));
  r.ciphertext=Buffer.concat([c.update(secret,'utf8'),c.final()]).toString('base64');r.tag=c.getAuthTag().toString('base64');
  fs.writeFileSync(path.join(dir,provider+'.json'),JSON.stringify(r));
}
try{
  vault.put('lmstudio','fixture-seed');// 키 표를 만든다
  writeLegacy('gemini','https://evil.example');
  const mismatch=run({vault,store:()=>store});
  assert.deepEqual(mismatch.failed,['legacy-gemini']);
  assert.equal(vault.statusFor('api-gemini').stored,false);
  writeLegacy('gemini',LEGACY_API.gemini.origin);writeLegacy('typesafe','https://api.typesafe.ai');
  const first=run({vault,store:()=>store,connections:()=>store.list()});
  assert.deepEqual(first.failed,[],JSON.stringify(first));assert.deepEqual(first.migrated.slice(0,1),['api-gemini']);
  const gemini=store.get('gemini');
  assert.equal(gemini.auth,'header');assert.equal(gemini.authHeader,'x-goog-api-key');assert.deepEqual(gemini.allowedRoutes,['/v1beta/','/v1/']);
  assert.equal(vault.use('api-gemini',LEGACY_API.gemini.origin,x=>x),secret);
  assert.deepEqual(store.list().map(p=>p.id),['gemini']);assert(store.list().every(p=>p.keyStored));
  assert.equal(vault.statusFor('api-typesafe').stored,false);assert.throws(()=>vault.adoptLegacy('typesafe','https://api.typesafe.ai'),/Unknown legacy/);
  assert(fs.existsSync(path.join(dir,'gemini.json')),'옛 파일은 지우지 않는다');
  for(const p of ['gemini','typesafe'])assert.throws(()=>vault.put(p,secret),/Unknown credential provider/);// 공급자로는 계속 막힌다
  // 두 번째 실행은 아무것도 다시 옮기지 않는다
  const again=run({vault,store:()=>store,connections:()=>store.list()});assert.deepEqual(again,{migrated:[],failed:[]});
  // A profile write failure after vault removal is retryable and leaves no usable credential.
  const profileFile=path.join(root,'api-connections.local.json');
  fs.mkdirSync(profileFile+'.tmp');
  assert.throws(()=>store.remove('gemini'));
  fs.rmdirSync(profileFile+'.tmp');
  assert.equal(store.get('gemini').origin,LEGACY_API.gemini.origin);
  assert.equal(vault.statusFor('api-gemini').stored,false);
  assert.deepEqual(store.remove('gemini'),{removed:true});
  const reopenedVault=createVault({root,storage:()=>storage,binding:()=>'http://127.0.0.1:1234'});
  const reopenedStore=createStore({root,vault:reopenedVault,isBusy:()=>false});
  assert.deepEqual(run({vault:reopenedVault,store:()=>reopenedStore}),{migrated:[],failed:[]});
  assert.deepEqual(reopenedStore.list(),[]);
  assert(fs.existsSync(path.join(dir,'gemini.json')));
  reopenedStore.save({id:'gemini',...LEGACY_API.gemini},'fixture-new-key');
  assert.equal(reopenedStore.withCredential('gemini',LEGACY_API.gemini.origin,x=>x==='fixture-new-key'),true);
  reopenedStore.remove('gemini');
  assert.deepEqual(run({vault:reopenedVault,store:()=>reopenedStore}),{migrated:[],failed:[]});
  assert.deepEqual(reopenedStore.list(),[]);
  assert.throws(()=>vault.adoptLegacy('omniroute','https://example.com'),/Unknown legacy/);
  // 시작 경로는 인스턴스가 아니라 모듈 기본값을 쓴다(2026-10-18 이것이 빠져 실제 시작에서 조용히 건너뛰었다)
  assert.equal(typeof require('../src/core/credential-vault').adoptLegacy,'function');
  console.log('Legacy API keys: gemini adopted into a scoped API connection once, typesafe not adopted, old files kept, providers stay blocked, origin mismatch refused');
}finally{fs.rmSync(root,{recursive:true,force:true});}

'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {create}=require('../src/core/device-key-delivery');
const {createVault}=require('../src/core/credential-vault');
const {createStore,PRESETS}=require('../src/core/api-connections');
const {createBroker}=require('../src/core/credential-broker');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-device-keys-'));
const profiles=new Map(),secrets=[];
const discord='https://discord.com',gemini='https://generativelanguage.googleapis.com';
let now=Date.parse('2026-11-14T00:00:00Z');
function fixtureSecret(){const s='fixture_'+crypto.randomUUID();secrets.push(s);return s;}
function osKey(){
  const key=crypto.randomBytes(32);
  return {encryptString(text){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);
    return Buffer.concat([iv,c.update(text,'utf8'),c.final(),c.getAuthTag()]);},
  decryptString(b){const c=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(-16));
    return Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString('utf8');}};
}
function open(label,overrides={}){
  const dir=path.join(root,label);
  if(!profiles.has(label))profiles.set(label,osKey());
  const storage=()=>profiles.get(label);
  const vault=createVault({root:dir,storage});
  const connections=createStore({root:dir,vault,isBusy:()=>false});
  return {service:create({root:dir,label,storage,vault,connections,now:()=>now,...overrides}),vault,connections,dir};
}
function register(profile,provider,id,secret,opts={}){
  profile.connections.save({...PRESETS.find(x=>x.id===provider),id,...opts},secret);
}
const changed=s=>(s[0]==='A'?'B':'A')+s.slice(1);
let passed=0;
function run(name,f){f();passed++;console.log('PASS '+name);}
async function main() {
  const h=open('H7'),r=open('JR'),l=open('Laptop');
  const [H,R,L]=[h,r,l].map(p=>p.service.identity().fingerprint);
  assert.equal(new Set([H,R,L]).size,3);
  const req=r.service.createRequest('discord'),reqL=l.service.createRequest('gemini');
  const opts={request:req,provider:'discord',expectedRecipientFingerprint:R};
  const secret=fixtureSecret();
  const env=h.service.seal({...opts,secret});
  const input=(dest,e,fp,provider,replace=false)=>({envelope:e,provider,expectedSenderFingerprint:H,expectedRecipientFingerprint:fp,
    confirmReplace:replace,expectedTargetRevision:dest.service.inspectEnvelope(e).targetRevision});
  run('public identities and requests survive restart',()=>{
    assert.equal(open('JR').service.identity().fingerprint,R);assert.equal(h.service.inspectRequest(req).recipientFingerprint,R);
    assert.equal(l.service.inspectRequest(req).expiresAt,now+48*3600000);
    assert.throws(()=>r.service.createRequest('unknown'),/unsupported/);
  });
  run('invalid recipient, self assignment, provider and unsigned request rejected',()=>{
    assert.throws(()=>h.service.seal({...opts,secret,expectedRecipientFingerprint:L}),/fingerprint/);
    assert.throws(()=>r.service.seal({...opts,secret}),/self_delivery/);
    assert.throws(()=>h.service.seal({...opts,secret,provider:'gemini'}),/provider_mismatch/);
    for(const patch of [{purpose:'new'},{origin:gemini},{reference:'x'},{recipientLabel:'Laptop'},{signature:changed(req.signature)}])
      assert.throws(()=>h.service.seal({...opts,request:{...req,...patch},secret}));
    assert.throws(()=>h.service.seal({...opts,secret:secret+'\n'}),/invalid_device_credential/);
  });
  run('tampering gets rejected before any vault write',()=>{
    for(const prop of ['tag','iv','ephemeral','ciphertext','signature','senderSigningKey']){
      const dirty={...env,[prop]:changed(env[prop])};assert.throws(()=>r.service.inspectEnvelope(dirty));
    }
    assert.throws(()=>r.service.inspectEnvelope({...env,senderLabel:'Impostor'}));
    assert.throws(()=>r.service.inspectEnvelope({...env,purpose:'other'}));
    assert.throws(()=>r.service.inspectEnvelope({...env,content:'invalid'}));
    assert.throws(()=>l.service.inspectEnvelope(env),/wrong_recipient/);
    assert.equal(r.vault.statusFor('api-discord').stored,false);
  });
  run('new key bound only to named destination, reference and origin',()=>{
    const pre=input(r,env,R,'discord');
    assert.throws(()=>r.service.receive({...pre,expectedSenderFingerprint:L}),/fingerprint/);
    assert.throws(()=>r.service.receive({...pre,expectedTargetRevision:'old'}),/target_changed/);
    assert.throws(()=>r.service.receive({...pre,provider:'gemini'}),/provider_mismatch/);
    assert.equal(r.service.receive(pre).alreadyReceived,false);
    assert.equal(r.vault.use('api-discord',discord,s=>s===secret),true);
    assert.equal(r.connections.get('discord').allowWrite,false);
    assert.equal(h.vault.statusFor('api-discord').stored,false);
    assert.equal(l.vault.statusFor('api-discord').stored,false);
  });
  run('replay after key rotation or deletion does not restore old credentials',()=>{
    const rotation=fixtureSecret();register(r,'discord','discord',rotation);
    const restarted=open('JR');
    assert.equal(restarted.service.receive(input(restarted,env,R,'discord')).alreadyReceived,true);
    assert.equal(restarted.vault.use('api-discord',discord,v=>v===rotation),true);
    assert.throws(()=>r.service.inspectEnvelope(h.service.seal({...opts,secret:fixtureSecret()})),/request_replaced/);
    r.connections.remove('discord');
    const receipt=r.service.receive(input(r,env,R,'discord'));
    assert.equal(receipt.alreadyReceived,true);
    assert.equal(receipt.stored,false);
    assert.equal(r.vault.statusFor('api-discord').stored,false);
  });
  const fresh=r.service.createRequest('discord');
  const o={...opts,request:fresh},assignment=fixtureSecret(),active=fixtureSecret();
  register(h,'discord','discord',active);
  register(h,'discord','discord-jr',assignment);
  register(h,'discord','discord-wrong',fixtureSecret(),{origin:'https://other.example.org'});
  const g=fixtureSecret();register(h,'gemini','gemini-laptop',g);
  const aliasInput=(opt,id,confirmBindAlias=false)=>({...opt,sourceAlias:id,confirmBindAlias,
    expectedSourceRevision:h.service.sourceAliases(opt).find(x=>x.id===id)?.revision});
  run('alias origin, provider and operating ID restrictions; first pin requires confirmation',()=>{
    assert.deepEqual(h.service.sourceAliases(o).map(({id,bound})=>({id,bound})),[{id:'discord-jr',bound:false}]);
    assert.throws(()=>h.service.seal({...o,sourceAlias:'discord'}),/invalid_device_key_source_alias/);
    assert.throws(()=>h.service.seal({...o,sourceAlias:'gemini-laptop'}),/invalid_device_key_source_alias/);
    assert.throws(()=>h.service.seal({...o,sourceAlias:'discord-wrong'}),/invalid_device_key_source_alias/);
    assert.throws(()=>h.service.seal({...o,sourceAlias:'discord-jr',secret:assignment}),/invalid_device_key_source_alias/);
    assert.throws(()=>h.service.seal(aliasInput(o,'discord-jr')),/alias_binding_required/);
    assert.throws(()=>h.service.seal({...aliasInput(o,'discord-jr',true),expectedSourceRevision:'stale'}),/source_changed/);
  });
  const fromAlias=h.service.seal(aliasInput(o,'discord-jr',true));
  run('a stored source alias stays pinned to one recipient across sender restarts',()=>{
    assert.deepEqual(open('H7').service.sourceAliases(o).map(({id,bound})=>({id,bound})),[{id:'discord-jr',bound:true}]);
    const other={request:l.service.createRequest('discord'),expectedRecipientFingerprint:L,provider:'discord'};
    assert.deepEqual(h.service.sourceAliases(other),[]);
    assert.throws(()=>h.service.seal({...other,sourceAlias:'discord-jr',confirmBindAlias:true}),/source_alias/);
    assert.equal(r.service.receive(input(r,fromAlias,R,'discord')).stored,true);
    assert.equal(r.vault.use('api-discord',discord,s=>s===assignment),true);
    assert.equal(h.vault.use('api-discord',discord,s=>s===active),true);
  });
  const lOpts={request:reqL,expectedRecipientFingerprint:L,provider:'gemini'};
  const forLaptop=h.service.seal(aliasInput(lOpts,'gemini-laptop',true));
  run('active H7 key and existing device assignments cannot be bypassed by renaming or pasting', () => {
    assert.throws(() => h.service.seal({ ...o, secret: active }), /primary_forbidden/);
    register(h, 'discord', 'discord-duplicate', active);
    assert.throws(() => h.service.seal(aliasInput(o, 'discord-duplicate', true)), /primary_forbidden/);
    const request = l.service.createRequest('discord');
    const target = { request, expectedRecipientFingerprint: L, provider: 'discord' };
    assert.throws(() => open('H7').service.seal({ ...target, secret: assignment }), /assigned_elsewhere/);
    register(h, 'discord', 'discord-duplicate', assignment);
    assert.throws(() => h.service.seal(aliasInput(target, 'discord-duplicate', true)), /assigned_elsewhere/);
    assert.doesNotThrow(() => open('H7').service.seal({ ...o, secret: assignment }));
  });
  run('existing key needs confirmation; stale dialog cannot overwrite a newly changed key',()=>{
    register(l,'gemini','gemini',fixtureSecret(),{maxCallsPerRun:3,allowWrite:false});
    assert.throws(()=>l.service.receive(input(l,forLaptop,L,'gemini')),/replacement_required/);
    const old=input(l,forLaptop,L,'gemini',true);
    register(l,'gemini','gemini',fixtureSecret(),{maxCallsPerRun:4,allowWrite:false});
    assert.throws(()=>l.service.receive(old),/target_changed/);
    const ok=l.service.receive(input(l,forLaptop,L,'gemini',true));assert.equal(ok.stored,true);
    assert.equal(l.connections.get('gemini').maxCallsPerRun,4);
    assert.equal(l.vault.use('api-gemini',gemini,s=>s===g),true);
    assert.equal(r.vault.statusFor('api-gemini').stored,false);
  });
  run('partial write recovers without rotating twice or accepting a different envelope',()=>{
    const target=r.service.createRequest('gemini'),newSecret=fixtureSecret();
    const sealed=h.service.seal({request:target,expectedRecipientFingerprint:R,provider:'gemini',secret:newSecret});
    const failing=open('JR',{connections:{list:()=>r.connections.list(),save:(settings,s)=>{
      r.vault.put('api-gemini',s,gemini);throw Error('injected metadata write failure');
    }}});
    assert.throws(()=>failing.service.receive(input(failing,sealed,R,'gemini')),/injected/);
    const record=fs.readFileSync(path.join(r.dir,'credentials.local','api-gemini.json'));
    const reloaded=open('JR');
    assert.equal(reloaded.service.receive(input(reloaded,sealed,R,'gemini',true)).stored,true);
    assert.deepEqual(fs.readFileSync(path.join(r.dir,'credentials.local','api-gemini.json')),record);
    assert.equal(reloaded.connections.get('gemini').authHeader.toLowerCase(),'x-goog-api-key');
  });
  run('an older envelope cannot displace a later accepted request even if both were created in the same instant', () => {
    function assignmentForRequest() {
      const request = r.service.createRequest('discord');
      return h.service.seal({ ...opts, request, secret: fixtureSecret() });
    }
    const older = assignmentForRequest();
    const newer = assignmentForRequest();
    r.service.receive(input(r, newer, R, 'discord', true));
    assert.throws(() => open('JR').service.inspectEnvelope(older), /superseded/);
  });
  run('a revoked partial import cannot restore the key on retry or permit an older request', () => {
    const request = r.service.createRequest('discord');
    const old = h.service.seal({ ...opts, request, secret: fixtureSecret() });
    const recent = h.service.seal({ ...opts, request: r.service.createRequest('discord'), secret: fixtureSecret() });
    const interrupted = open('JR', { connections: {
      list: () => r.connections.list(),
      save(settings, secret) {
        r.vault.put('api-discord', secret, discord);
        throw Error('synthetic crash');
      }
    }});
    assert.throws(() => interrupted.service.receive(input(interrupted, recent, R, 'discord', true)), /synthetic crash/);
    assert.throws(() => open('JR').service.inspectEnvelope(old), /superseded/);
    r.connections.remove('discord');
    assert.throws(() => open('JR').service.receive(input(r, recent, R, 'discord')), /target_changed/);
    assert.equal(r.vault.statusFor('api-discord').stored, false);
  });
  const legacyToken = fixtureSecret();
  const legacy = { auth: 'header', authHeader: 'Authorization' };
  register(h, 'discord', 'discord-legacy', 'Bot ' + legacyToken, legacy);
  register(r, 'discord', 'discord', 'Bot ' + fixtureSecret(), { ...legacy, maxCallsPerRun: 5 });
  const target = { ...opts, request: r.service.createRequest('discord') };
  const migrated = h.service.seal(aliasInput(target, 'discord-legacy', true));
  r.service.receive(input(r, migrated, R, 'discord', true));
  const broker = createBroker({
    vault: r.vault, connections: () => r.connections,
    fetchFn: async (url, init) => {
      assert.equal(new URL(url).origin, discord);
      assert.equal(init.headers.Authorization === 'Bot ' + legacyToken, true);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  await broker.request({ credentialRef: 'credential:api-discord', operationId: 'api.request', jobId: 'fixture',
    payload: { route: '/api/v10/users/@me' } });
  run('existing Discord Authorization profiles work through the broker and keep their local scope', () => {
    assert.equal(r.connections.get('discord').auth, 'header');
    assert.equal(r.connections.get('discord').maxCallsPerRun, 5);
  });
  run('a missing key table with existing v2 records cannot be replaced by a new delivery', () => {
    const request = l.service.createRequest('discord');
    const envelope = h.service.seal({ request, provider: 'discord', expectedRecipientFingerprint: L, secret: fixtureSecret() });
    const before = input(l, envelope, L, 'discord');
    const table = path.join(l.dir, 'credentials.local', 'key-table.v2.json');
    const hold = table + '.fixture';
    fs.renameSync(table, hold);
    try {
      assert.throws(() => l.service.receive(before), /storage_unavailable/);
      assert.equal(fs.existsSync(table), false);
      assert.equal(l.vault.statusFor('api-discord').stored, false);
    } finally {
      fs.renameSync(hold, table);
    }
    assert.equal(l.service.receive(before).stored, true);
    assert.equal(l.vault.use('api-gemini', gemini, value => value === g), true);
  });
  run('expiry, request tampering, and damaged OS wrapping fail closed',()=>{
    const stale=r.service.createRequest('discord');now+=48*3600000;
    assert.throws(()=>h.service.inspectRequest(stale),/expired/);
    assert.throws(()=>l.service.inspectEnvelope(forLaptop),/expired/);
    const stranger=open('NewProfile',{storage:()=>({encryptString(){throw Error('OS unavailable');}})});
    assert.throws(()=>stranger.service.identity());assert.equal(fs.existsSync(path.join(stranger.dir,'device-key-delivery.local','profile.json')),false);
    const bad=open('JR',{storage:()=>profiles.get('Laptop')});assert.throws(()=>bad.service.identity(),/storage_unavailable/);
  });
  run('no plaintext secret on disk or in exported card/envelope',()=>{
    function scan(file){for(const e of fs.readdirSync(file,{withFileTypes:true})){const p=path.join(file,e.name);
      if(e.isDirectory())scan(p);else{const b=fs.readFileSync(p);for(const s of secrets)assert.ok(!b.includes(s));}}}
    scan(root);
    for(const value of [req,env,forLaptop,fromAlias])for(const s of secrets)assert.ok(!JSON.stringify(value).includes(s));
  });
  console.log('Device key delivery: '+passed+' fixture groups passed with isolated profiles');
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => fs.rmSync(root, { recursive: true, force: true }));

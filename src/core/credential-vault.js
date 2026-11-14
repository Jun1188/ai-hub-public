'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const PROVIDERS = ['lmstudio', 'llamacpp'];
// 1.29.0에서 작업자를 뺄 때 남은 키. 공급자로는 계속 막고(put·use 불가), API 연결 api-<id>로 옮기는 데만 읽는다.
const LEGACY_API = ['gemini'];
function defaultOrigin(provider) {
  if (PROVIDERS.includes(provider)) return require('./local-endpoints').origin(provider);
  throw new Error('Register an explicit credential origin');
}
function secureStorage() {
  const s = require('electron').safeStorage;
  if (!s?.isEncryptionAvailable() || s.getSelectedStorageBackend?.() === 'basic_text') throw new Error('OS encryption unavailable; plaintext fallback is disabled');
  return s;
}
function createVault({ root, storage = secureStorage, binding = defaultOrigin } = {}) {
  root = path.join(root || require('./paths').hubDataDir(), 'credentials.local');
  const tableFile = path.join(root, 'key-table.v2.json');
  const fileFor = provider => {
    if (provider === 'omniroute') throw new Error('OmniRoute is retired; credentials must not be imported or used');
    if (!PROVIDERS.includes(provider) && !/^api-[a-z][a-z0-9-]{0,47}$/.test(provider || '')) throw new Error('Unknown credential provider');
    return path.join(root, provider + '.json');
  };
  const atomic = (file, value) => {
    fs.mkdirSync(root, { recursive: true });
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temp, JSON.stringify(value), {encoding:'utf8',mode:0o600}); fs.renameSync(temp, file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  };
  const origin = value => {
    const u = new URL(value);
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname)))) throw new Error('Invalid credential origin');
    return u.origin;
  };
  const table = () => {
    try {
      const r = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
      if (r.version !== 2 || typeof r.encrypted !== 'string') throw new Error('Invalid key table');
      const value = JSON.parse(storage().decryptString(Buffer.from(r.encrypted, 'base64')));
      if (value.version !== 2 || !value.keys || typeof value.keys !== 'object') throw new Error('Invalid key table');
      return value;
    } catch (e) { if (e.code === 'ENOENT') return {version:2,keys:{}}; throw new Error('Encrypted key table unavailable or invalid'); }
  };
  const saveTable = value => atomic(tableFile, {version:2,encrypted:storage().encryptString(JSON.stringify(value)).toString('base64')});
  const aad = r => Buffer.from(JSON.stringify([2,r.provider,r.reference,r.origin,r.keyId]), 'utf8');
  const decrypt = r => {
    if (r.version !== 2 || typeof r.keyId !== 'string' || !/^[0-9a-f-]{36}$/.test(r.keyId)) throw new Error('Invalid credential record');
    const encoded = table().keys[r.keyId];
    if (typeof encoded !== 'string') throw new Error('Credential key missing');
    const key = Buffer.from(encoded, 'base64');
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(r.nonce, 'base64'));
      d.setAAD(aad(r)); d.setAuthTag(Buffer.from(r.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(r.ciphertext,'base64')),d.final()]).toString('utf8');
    } catch { throw new Error('Credential authentication failed'); }
    finally { key.fill(0); }
  };
  function put(provider, secret, boundOrigin) {
    const file = fileFor(provider);
    if (typeof secret !== 'string' || !secret.trim() || secret.length > 8192 || /[\r\n]/.test(secret)) throw new Error('Invalid credential');
    const selectedOrigin = origin(boundOrigin || binding(provider));
    fs.mkdirSync(root,{recursive:true});
    const lockFile = path.join(root,'key-table.lock'), fd = fs.openSync(lockFile,'wx');
    try {
      const keys = table(), key = crypto.randomBytes(32);
      const r = {version:2,provider,reference:'credential:'+provider,origin:selectedOrigin,keyId:crypto.randomUUID(),nonce:crypto.randomBytes(12).toString('base64')};
      keys.keys[r.keyId] = key.toString('base64');
      const cipher = crypto.createCipheriv('aes-256-gcm',key,Buffer.from(r.nonce,'base64')); cipher.setAAD(aad(r));
      r.ciphertext = Buffer.concat([cipher.update(secret.trim(),'utf8'),cipher.final()]).toString('base64'); r.tag=cipher.getAuthTag().toString('base64'); key.fill(0);
      saveTable(keys); atomic(file,r);
      if (decrypt(r) !== secret.trim()) throw new Error('Credential verification failed');
      return {reference:r.reference,stored:true,version:2,origin:r.origin};
    } finally { fs.closeSync(fd); fs.unlinkSync(lockFile); }
  }
  function use(provider, boundOrigin, fn) {
    const file=fileFor(provider), expected=origin(boundOrigin), r=JSON.parse(fs.readFileSync(file,'utf8'));
    if (r.version === 1) {
      if (typeof r.encrypted !== 'string') throw new Error('Invalid legacy credential');
      if (!provider.startsWith('api-') && origin(binding(provider)) !== expected) throw new Error('Legacy credential origin mismatch');
      const secret=storage().decryptString(Buffer.from(r.encrypted,'base64'));
      const backup=file+'.v1.encrypted-backup';
      if (!fs.existsSync(backup)) fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);
      put(provider,secret,expected);
      const migrated=JSON.parse(fs.readFileSync(file,'utf8'));
      if (decrypt(migrated)!==secret) throw new Error('Credential migration verification failed');
      return fn(secret);
    }
    if (r.provider !== provider || r.reference !== 'credential:'+provider || r.origin !== expected) throw new Error('Credential origin or reference mismatch');
    return fn(decrypt(r));
  }
  function statusFor(provider) {
    const file=fileFor(provider); if (!fs.existsSync(file)) return {provider,reference:'credential:'+provider,stored:false};
    try { const r=JSON.parse(fs.readFileSync(file,'utf8')); return {provider,reference:'credential:'+provider,stored:true,version:r.version,origin:r.origin||null}; }
    catch { return {provider,reference:'credential:'+provider,stored:true,invalid:true}; }
  }
  const retiredLegacyFile = id => path.join(root, 'legacy-' + id + '.disabled.json');
  function remove(provider) {
    const file = fileFor(provider);
    const legacy = LEGACY_API.find(id => provider === 'api-' + id);
    // Keep the encrypted backup, but remember an explicit local unlink before startup can adopt it again.
    if (legacy) atomic(retiredLegacyFile(legacy), {version:1,adopt:false});
    try { fs.unlinkSync(file); } catch(e) {if(e.code!=='ENOENT')throw e;}
    return {reference:'credential:'+provider,stored:false};
  }
  // 값은 이 함수 밖으로 나가지 않는다. 옛 파일은 지우지 않는다 — 옮긴 사본이 검증된 뒤에도 되돌릴 길을 남긴다.
  function adoptLegacy(legacy, expectedOrigin) {
    if (!LEGACY_API.includes(legacy)) throw new Error('Unknown legacy credential');
    try { fs.statSync(retiredLegacyFile(legacy)); return null; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    let r;
    try { r = JSON.parse(fs.readFileSync(path.join(root, legacy + '.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw new Error('Legacy credential unreadable'); }
    if (r.provider !== legacy || r.reference !== 'credential:' + legacy || r.origin !== origin(expectedOrigin)) throw new Error('Legacy credential reference or origin mismatch');
    return put('api-' + legacy, decrypt(r), r.origin);
  }
  return {put,use,statusFor,status:()=>PROVIDERS.map(statusFor),remove,adoptLegacy};
}
let singleton;
const instance=()=>singleton||(singleton=createVault());
module.exports={createVault,put:(...a)=>instance().put(...a),use:(...a)=>instance().use(...a),statusFor:(...a)=>instance().statusFor(...a),status:()=>instance().status(),remove:(...a)=>instance().remove(...a),adoptLegacy:(...a)=>instance().adoptLegacy(...a)};

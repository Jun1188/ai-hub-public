'use strict';
// 1.29.0에서 Gemini 작업자를 뺄 때 키는 남았는데 API 연결은 비어 있어 어디서도 쓸 수 없었다.
// 같은 서비스의 API 연결로 옮겨 파이프라인 api-request 단계에서 쓰게 한다. 경로는 API 접두사로만 연다.
// TypeSafe(Jev) 키는 옮기지 않는다 — 재활성화하지 않기로 했고 사용자가 삭제해도 된다고 했다(2026-10-18).
const LEGACY_API={
  gemini:{name:'Gemini API',origin:'https://generativelanguage.googleapis.com',auth:'header',authHeader:'x-goog-api-key',allowedRoutes:['/v1beta/','/v1/']},
};
function adoptLegacyApiKeys(vault,store){
  const adopted=[],failed=[];
  for(const [id,spec] of Object.entries(LEGACY_API)){
    try{
      if(store().list().some(p=>p.id===id))continue;
      if(!vault.adoptLegacy?.(id,spec.origin))continue;
      store().save({id,...spec});adopted.push('api-'+id);
    }catch{failed.push('legacy-'+id);}
  }
  return {adopted,failed};
}
// API 연결 저장소는 조립 루트(Electron main)가 넘긴다 — platform이 integration을 부르지 않는다.
function run({vault=require('./credential-vault'),store,connections=()=>store().list()}={}) {
  if(typeof store!=='function')throw Error('Credential migration needs the API connection store from the caller');
  const {adopted,failed}=adoptLegacyApiKeys(vault,store),migrated=[...adopted];
  const endpoints=require('./local-endpoints'),known={lmstudio:endpoints.origin('lmstudio'),llamacpp:endpoints.origin('llamacpp')};
  try {for(const profile of connections())known['api-'+profile.id]=profile.origin;}catch {failed.push('api-connections');}
  for(const [provider,origin] of Object.entries(known)) {
    const status=vault.statusFor(provider);
    if(!status.stored)continue;
    try {vault.use(provider,origin,()=>undefined);if(status.version===1)migrated.push(provider);}
    catch {failed.push(provider);}
  }
  return {migrated,failed};
}
module.exports={run,LEGACY_API};

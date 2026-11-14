// 외부 AI·공유 산출물로 나가는 텍스트에서 토큰·키·사용자 경로를 가린다.
// 값이 아니라 모양만 본다(규칙 11) — 실수 방지용이지 완벽한 방어가 아니다.
'use strict';

function scrub(text) {
  return String(text)
    .replace(/[0-9a-f]{32,}/gi, '<redacted-token>')
    .replace(/(authToken|apiKey|api_key|password|secret)\s*[:=]\s*["']?[^"'\s,}]+/gi, '$1: <redacted>')
    .replace(/C:\\Users\\[^\\\s"']+/gi, 'C:\\Users\\<user>')
    .replace(/G:\\[^\s"']+/g, '<synced-folder>');
}

// API·로컬 런타임 응답과 분석 산출물의 가림 정책은 이것 하나다(credential-broker도 이것을 쓴다). 브로커의 것(알려진 비밀의
// 원문·URL 인코딩·base64, 키=값 모양)과 옛 pipeline-api-request의 것(알려진 키 모양)을 합쳤고, 둘이 다르던 곳은 더 많이
// 가리는 쪽을 따른다(사용자 결정 2026-10-23). 인증 필드 이름은 지우고, 깊이·배열 상한도 둘 중 작은 쪽(10·256)이다.
const sensitiveKey=k=>/^(authorization|proxyauthorization|cookie|setcookie|apikey|authtoken|controltoken|accesstoken|refreshtoken|password|secret|proto|__proto__|prototype|constructor)$/i.test(k.replace(/[-_]/g,''));
const KEY_VALUE=/((?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret)["']?\s*[:=]\s*)(?:["'][^"'\r\n]*["']|[^\s,;}]+)/gi;
const KEY_SHAPE=/(?:apikey_[a-z0-9_]{20,}|sk-[a-z0-9_-]{20,}|AIza[a-z0-9_-]{25,}|AQ\.[a-z0-9_-]{25,}|Bearer\s+[a-z0-9_.-]{20,}|gh[pousr]_[a-z0-9]{30,}|github_pat_[a-z0-9_]{30,}|(?<![a-z0-9_-])[a-z0-9_-]{23,}\.[a-z0-9_-]{6,7}\.[a-z0-9_-]{27,})/ig;
const MAX_DEPTH=10,MAX_ITEMS=256;
function redactCredentials(text,secret=''){
 let s=String(text);if(secret)for(const v of new Set([secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64')]))s=s.split(v).join('[redacted]');
 // 두 모양을 같은 글에서 찾아 겹친 구간을 합쳐 가린다. 하나를 먼저 바꾸면 다른 쪽이 못 찾는 곳이 생긴다
 // ("Authorization: Bearer <토큰>"에서 키=값이 Bearer만 가리면 토큰이 남는다).
 const spans=[...[...s.matchAll(KEY_VALUE)].map(m=>[m.index+m[1].length,m.index+m[0].length]),...[...s.matchAll(KEY_SHAPE)].map(m=>[m.index,m.index+m[0].length])].sort((a,b)=>a[0]-b[0]);
 const merged=[];for(const span of spans){const last=merged[merged.length-1];if(last&&span[0]<=last[1])last[1]=Math.max(last[1],span[1]);else merged.push(span);}
 let out='',at=0;for(const [start,end] of merged){out+=s.slice(at,start)+'[redacted]';at=end;}
 return out+s.slice(at);
}
function sanitize(v,secret='',depth=0){
 if(depth>MAX_DEPTH)return '[depth limit]';
 if(typeof v==='string')return redactCredentials(v,secret);
 if(Array.isArray(v))return v.slice(0,MAX_ITEMS).map(x=>sanitize(x,secret,depth+1));
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>!sensitiveKey(k)).map(([k,x])=>[redactCredentials(k,secret),sanitize(x,secret,depth+1)]));
 return v;
}

module.exports = { scrub, sensitiveKey, redactCredentials, sanitize };

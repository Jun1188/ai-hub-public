'use strict';

function scrub(text) {
  return String(text)
    .replace(/[0-9a-f]{32,}/gi, '<redacted-token>')
    .replace(/(authToken|apiKey|api_key|password|secret)\s*[:=]\s*["']?[^"'\s,}]+/gi, '$1: <redacted>')
    .replace(/C:\\Users\\[^\\\s"']+/gi, 'C:\\Users\\<user>')
    .replace(/G:\\[^\s"']+/g, '<synced-folder>');
}

const sensitiveKey=k=>/^(authorization|proxyauthorization|cookie|setcookie|apikey|authtoken|controltoken|accesstoken|refreshtoken|password|secret|proto|__proto__|prototype|constructor)$/i.test(k.replace(/[-_]/g,''));
const KEY_VALUE=/((?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret)["']?\s*[:=]\s*)(?:["'][^"'\r\n]*["']|[^\s,;}]+)/gi;
const KEY_SHAPE=/(?:apikey_[a-z0-9_]{20,}|sk-[a-z0-9_-]{20,}|AIza[a-z0-9_-]{25,}|AQ\.[a-z0-9_-]{25,}|Bearer\s+[a-z0-9_.-]{20,}|gh[pousr]_[a-z0-9]{30,}|github_pat_[a-z0-9_]{30,}|(?<![a-z0-9_-])[a-z0-9_-]{23,}\.[a-z0-9_-]{6,7}\.[a-z0-9_-]{27,})/ig;
const MAX_DEPTH=10,MAX_ITEMS=256;
function redactCredentials(text,secret=''){
 let s=String(text);if(secret)for(const v of new Set([secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64')]))s=s.split(v).join('[redacted]');
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

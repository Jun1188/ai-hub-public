'use strict';
const https = require('node:https');
const dns = require('node:dns/promises');
const {isIPv4} = require('node:net');

// IPv4-only on purpose. No mapped IPv6, multicast, link-local, test or transition ranges.
function publicAddress(value) {
  if (!isIPv4(value)) return false;
  const [a,b,c] = value.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
    a === 192 && (b === 0 || b === 168 || b === 88 && c === 99) ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}

// Each connection uses the validated address verbatim. TLS SNI and certificate validation still use the original hostname.
async function readPublic(url, {signal,lookup=dns.lookup,request=https.request}={}) {
  const parsed = new URL(url);
  const timeout = AbortSignal.timeout(7000);
  const stopped = signal ? AbortSignal.any([timeout,signal]) : timeout;
  stopped.throwIfAborted();
  // DNS lookup is not cancellable on all supported Node versions. Give the caller a bounded wait.
  let abort;
  const stop = new Promise((_,reject) => {
    abort = () => reject(Error('snapshot_public_timeout'));
    stopped.addEventListener('abort',abort,{once:true});
  });
  let rows;
  try { rows = await Promise.race([lookup(parsed.hostname,{family:4,all:true,verbatim:true}),stop]); }
  finally { stopped.removeEventListener('abort',abort); }
  if (!rows.length || rows.some(r=>r.family!==4 || !publicAddress(r.address))) return null;
  const address = rows[0].address;
  return new Promise((resolve,reject)=>{
    const req=request(parsed,{method:'GET',agent:false,family:4,servername:parsed.hostname,rejectUnauthorized:true,signal:stopped,
      lookup:(_host,opts,done)=>opts.all?done(null,[{address,family:4}]):done(null,address,4),
      headers:{Accept:'text/html, application/json','Accept-Encoding':'identity','User-Agent':'ai-hub-public-links/1'}},res=>{
      const status=res.statusCode;
      // A public repository's anonymous HTML may be marked "private" for cache purposes.
      // Its dedicated adapter separately checks the public API and canonical repository identity.
      const separatePublicRepo=parsed.hostname==='github.com'&&/^\/[\w.-]+\/[\w.-]+$/.test(parsed.pathname);
      if(/noindex|none|nosnippet/i.test(String(res.headers['x-robots-tag']||'')) ||
          !separatePublicRepo && /\bprivate\b/i.test(String(res.headers['cache-control']||'')) ||
          res.headers['www-authenticate']){res.destroy();resolve(null);return;}
      // Redirects are never followed. No cookies, auth, service credentials or private referrers are attached.
      if (status===429 || status>=500 || status===403 && (res.headers['retry-after']||res.headers['x-ratelimit-remaining']==='0')) {
        res.destroy(); reject(Error('snapshot_public_unavailable'));return;
      }
      if (status!==200 || res.headers['content-encoding'] && res.headers['content-encoding']!=='identity') {
        res.destroy();resolve(null);return;
      }
      const type=String(res.headers['content-type']||'').split(';')[0].toLowerCase();
      if (!['text/html','application/json','application/vnd.github+json'].includes(type)) {res.destroy();resolve(null);return;}
      const chunks=[]; let size=0;
      res.on('error',reject);res.on('aborted',()=>reject(Error('snapshot_public_unavailable')));
      res.on('data',chunk=>{
        size+=chunk.length;
        if (size>524288) {
          if(type==='text/html'){resolve({body:Buffer.concat(chunks).toString('utf8'),type});}
          else reject(Error('snapshot_public_size'));
          res.destroy();return;
        }
        chunks.push(chunk);
        if(type==='text/html' && /<\/head\s*>/i.test(chunk.toString('utf8'))){
          resolve({body:Buffer.concat(chunks).toString('utf8'),type});res.destroy();
        }
      });
      res.on('end',()=>resolve({body:Buffer.concat(chunks).toString('utf8'),type}));
    });
    req.on('error',reject);req.end();
  });
}
module.exports={readPublic,publicAddress};

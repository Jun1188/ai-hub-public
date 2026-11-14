'use strict';
const {createHash} = require('node:crypto');
const {readPublic} = require('./awesome-public-http.cjs');
const {assertNoSecrets} = require('../prompt-safety.js');
const {scanText} = require('../supply/script-safety.js');
const digest = url => 'web-' + createHash('sha256').update(url).digest('hex').slice(0,24);
const identity = row=>row.category+'\n'+row.url;
const exact = (v,keys) => v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).sort().join(',')===keys.sort().join(',');
const iso = v=>typeof v==='string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString()===v;
const providers = [
  ['github.com',/^\/[\w.-]{1,39}\/[\w.-]{1,100}\/?$/,'repo'],
  ['arxiv.org',/^\/abs\/\d{4}\.\d{4,5}(?:v\d+)?\/?$/,'paper'],
  ['developer.mozilla.org',/^\/(?:en-US|ko)\/docs\/(?:Web|Games|Learn_web_development)\/[\w/-]+\/?$/,'doc'],
  ['openai.com',/^\/index\/[a-z0-9-]+\/?$/,'article'],
  ['www.anthropic.com',/^\/(?:news|engineering|research)\/[a-z0-9-]+\/?$/,'article'],
  ['deepmind.google',/^\/blog\/[a-z0-9-]+\/?$/,'article'],
  ['blog.google',/^\/(?:technology|products|innovation-and-ai)\/[a-z0-9/-]+\/?$/,'article'],
  ['huggingface.co',/^\/papers\/\d{4}\.\d{4,5}\/?$/,'paper']
];
const excludedHosts=['local','internal','localhost','test','invalid','onion','home.arpa','discord.com','discord.gg','discordapp.com','discordapp.net',
  'googleusercontent.com','docs.google.com','drive.google.com','accounts.google.com','dropbox.com','1drv.ms','onedrive.live.com','sharepoint.com',
  'bit.ly','t.co','goo.gl','tinyurl.com','notion.so','notion.site','pastebin.com','youtube.com','youtu.be','youtube-nocookie.com','storage.googleapis.com',
  'amazonaws.com','blob.core.windows.net','githubusercontent.com','gitlab.com','figma.com','slack.com'];
function source(raw) {
  if (typeof raw!=='string' || raw.length>1200 || /[\s\\\x00-\x1f]/.test(raw) || !raw.startsWith('https://')) return null;
  let u;
  try {u=new URL(raw);} catch {return null;}
  if (u.username || u.password || u.port || u.hash || u.search || u.pathname.includes('//') || !/^https:\/\/[a-z0-9.-]+\//.test(raw)) return null;
  const host=u.hostname;
  if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(host) ||
     excludedHosts.some(h=>host===h||host.endsWith('.'+h)))return null;
  let decoded;try{decoded=decodeURIComponent(u.pathname);}catch{return null;}
  const parts=decoded.split('/').filter(Boolean);
  if(!parts.length||/%(?:[0-7][a-f\d])/i.test(raw)||!parts.every(p=>/^[\p{L}\p{N}._~-]{1,120}$/u.test(p))||
    parts.some(p=>p.startsWith('.')||/^(?:login|log-in|sign-in|signin|auth|oauth|invite|token|private|profile|users?|account|reset-password|share|shared|attachment[s]?|admin|preview|api|download)$/i.test(p)||
      /[a-f0-9]{24,}|^[a-z0-9]{24,}$|^.{8}-.{4}-.{4}-.{4}-.{12}$/i.test(p)))return null;
  // Reject spellings URL would silently normalize, e.g. dot-segments, default ports or empty credentials.
  if (u.href!==raw && decodeURI(u.href)!==raw || /\/(?:\.{1,2})(?:\/|$)/.test(raw)) return null;
  const p=providers.find(([host,route])=>u.hostname===host && route.test(u.pathname));
  if (!p){
    if(providers.some(([h])=>h===host)||host==='api.github.com'||/^(?:cdn|assets|auth|login|accounts|mail|files|internal|api)\./.test(host)||
       parts.length<2||/\.(?:zip|pdf|png|jpe?g|gif|svg|js|json|xml|exe|msi|mp[34])$/i.test(decoded))return null;
    return {url:u.href,kind:'public-page'};
  }
  if (p[2]==='repo' && /\.git\/?$/i.test(u.pathname)) return null;
  return {url:p[2]==='repo'?u.href.replace(/\/$/,''):u.href,kind:p[2]};
}
function text(value,max) {
  if (typeof value!=='string' || value.length>4096) return null;
  const s=value.replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&nbsp;/gi,m=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'",'&apos;':"'",'&nbsp;':' '}[m.toLowerCase()]))
    .replace(/\s+/gu,' ').trim();
  if (!s || s.length>max || /[<>\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]|(?:https?:\/\/|www\.)|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:^|\s)@[\w.-]+|(?:\+?\d[ ().-]*){9,}|(?:이전|기존)\s*지시.{0,12}무시|(?:시스템|개발자)\s*프롬프트/i.test(s)) return null;
  try {assertNoSecrets(s);} catch {return null;}
  return scanText(s,{path:'public-source.md'}).verdict==='pass'?s:null;
}
function meta(html) {
  // Treat HTML as data only; script, template and comment text cannot supply metadata.
  const head=html.split(/<\/head\s*>/i,1)[0].slice(0,131072)
    .replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,'');
  const found={},canonical=[];
  for(const match of head.matchAll(/<(?:meta|link)\s+[^<>]{1,4096}>/gi)){
    const attrs={};
    for(const a of match[0].matchAll(/\s([\w:-]+)\s*=\s*(["'])(.*?)\2/gs))attrs[a[1].toLowerCase()]=a[3];
    const key=(attrs.property||attrs.name||'').toLowerCase();
    if (attrs.rel?.toLowerCase().split(/\s+/).includes('canonical'))canonical.push(attrs.href);
    if (['og:type','og:url','og:title','description','og:description','citation_title','article:published_time','robots'].includes(key))found[key]=attrs.content;
  }
  return {title:found['citation_title']||found['og:title']||/<title\b[^>]*>([^<>]+)<\/title>/i.exec(head)?.[1],
    summary:found.description||found['og:description'],published:found['article:published_time'],robots:found.robots,
    canonical,openGraphUrl:found['og:url'],type:found['og:type'],openGraphTitle:found['og:title']};
}
function candidates() {
  const items=new Map();
  return {observe(category,at,message){
    // Inspect only to select canonical URLs. Never copy Discord prose, titles, descriptions, IDs or attachments.
    const lines=[typeof message.content==='string'?message.content.slice(0,4000):'',...(Array.isArray(message.embeds)?message.embeds.slice(0,10).map(e=>typeof e?.url==='string'?e.url:''):[])];
    for(const line of lines)for(const m of line.matchAll(/https:\/\/[^\s<>"'\x00-\x1f]+/g)){
      const item=source(m[0].replace(/[.,;!\])]+$/,''));
      if(!item)continue;
      const prior=items.get(item.url);
      if(prior){prior.categories.add(category);prior.at=Math.max(prior.at,at);}
      else items.set(item.url,{...item,categories:new Set([category]),at});
    }
  },async verify(observedAt,read=readPublic){
    const selected=[...items.values()].sort((a,b)=>b.at-a.at||a.url.localeCompare(b.url));
    // Max 160 items in the consumer contract. Reject overflow rather than silently dropping previous valid cards.
    if(selected.length>160)throw Error('snapshot_public_budget');
    const controller=new AbortController(),output=[],signal=AbortSignal.any([AbortSignal.timeout(90000),controller.signal]);
    let cursor=0;
    async function verifyNext(){
      while(cursor<selected.length){
        signal.throwIfAborted();
        const s=selected[cursor++];
        let repo;
        if(s.kind==='repo'){
          const slug=new URL(s.url).pathname.slice(1);
          const api=await read('https://api.github.com/repos/'+slug,{signal});
          if(!api||!['application/json','application/vnd.github+json'].includes(api.type))continue;
          repo=JSON.parse(api.body);
          if(repo.private!==false||repo.visibility!=='public'||repo.full_name?.toLowerCase()!==slug.toLowerCase()||
              repo.html_url?.toLowerCase()!==s.url.toLowerCase())continue;
        }
        const page=await read(s.url,{signal});
        if(!page||page.type!=='text/html')continue;
        const m=meta(page.body);
        if(/noindex|none/i.test(m.robots||'')||!text(m.title,300))continue;
        if(s.kind==='public-page'){
          // Only a self-canonical, anonymous article or documentation page with affirmative public metadata.
          const isDocs=/\/(?:manual|docs?|documentation|reference|scripting|api-reference|userguide|guides?)(?:\/|$)/i.test(new URL(s.url).pathname);
          if(/"isAccessibleForFree"\s*:\s*"?false\b|<input\b[^>]*\btype\s*=\s*["']password["']/i.test(page.body)||
              /nosnippet/i.test(m.robots||'')||m.canonical.length!==1||m.canonical[0]!==s.url||m.openGraphUrl && m.openGraphUrl!==s.url||
              !m.openGraphTitle||(!/^article$/i.test(m.type||'') && !(isDocs&&/^(?:website|documentation|article)$/i.test(m.type||'')))||
              /\b(?:sign[ -]?in|log[ -]?in|permission denied|access denied|members only|private link)\b|로그인(?:이 필요|하여|하세요)|접근 권한/i.test(m.title+' '+m.summary))continue;
        }
        let title=repo?repo.name:m.title,summary=repo?repo.description:m.summary;
        if(repo)m.published=repo.created_at;
        title=text(title,160);summary=text(summary,500);
        if(!title||!summary||title===summary)continue;
        // Without a source date, first public verification supplies the timestamp; the publisher preserves it on later scans.
        const when=Date.parse(m.published);
        const publishedAt=Number.isFinite(when)&&when<=Date.parse(observedAt)?new Date(when).toISOString():observedAt;
        for(const category of s.categories){
          const row={category,title,summary,url:s.url,publishedAt};
          output.push({id:digest(identity(row)),...row});
        }
      }
    }
    try{await Promise.all(Array.from({length:Math.min(4,selected.length)},verifyNext));}
    finally{controller.abort();}
    return validate({schemaVersion:1,source:'public-web',observedAt,items:output.sort((a,b)=>a.id.localeCompare(b.id))},observedAt);
  }};
}
function validate(v,observedAt,{prior=false}={}){
  if(!exact(v,['schemaVersion','source','observedAt','items'])||v.schemaVersion!==1||v.source!=='public-web'||v.observedAt!==observedAt||
      !iso(observedAt)||!Array.isArray(v.items)||v.items.length>160||Buffer.byteLength(JSON.stringify(v,null,2)+'\n')>512*1024)throw Error('snapshot_public_invalid');
  const ids=new Set(),urls=new Set();
  for(const r of v.items){
    if(!exact(r,['id','category','url','title','summary','publishedAt'])||!source(r.url)||!/^[a-z][a-z0-9-]{1,63}$/.test(r.id)||
       !prior&&r.id!==digest(identity(r))&&r.id!==digest(r.url)||ids.has(r.id)||urls.has(identity(r))||!['news','info'].includes(r.category)||text(r.title,160)!==r.title||!r.title||
       text(r.summary,500)!==r.summary||!r.summary||!iso(r.publishedAt)||r.publishedAt>observedAt)throw Error('snapshot_public_invalid');
    ids.add(r.id);urls.add(identity(r));
  }
  return v;
}
module.exports={candidates,validate,source,meta,identity};

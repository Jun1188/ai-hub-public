'use strict';
function address(input){
 const u=new URL(input);
 if(u.protocol!=='https:'||!u.hostname.endsWith('.github.io')||u.username||u.password||u.port||u.search||u.hash)throw Error('공개 GitHub Pages의 HTTPS 페이지 주소를 입력하세요.');return u;
}
async function request(url){
 const response=await fetch(url,{signal:AbortSignal.timeout(15000),redirect:'error',credentials:'omit'});
 if(!response.ok)throw Error('페이지를 가져오지 못했습니다: HTTP '+response.status);
 const chunks=[];let size=0;
 for await(const chunk of response.body){size+=chunk.length;if(size>3*1024*1024)throw Error('페이지 리소스가 3 MiB를 넘습니다.');chunks.push(chunk);}
 return Buffer.concat(chunks).toString('utf8');
}
function cssUrls(css,base){
 return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi,(all,quote,value)=>{
  if(value.startsWith('data:image/'))return all;
  let u;try{u=new URL(value,base);}catch{return 'none';}
  return u.protocol==='https:'&&!u.username&&!u.password?'url("'+u.href.replace(/"/g,'%22')+'")':'none';
 });
}
async function load(input){
 const u=address(input),html=await request(u),styles=[];let total=html.length;
 const attr=(tag,name)=>tag.match(new RegExp('\\b'+name+'\\s*=\\s*["\\\']([^"\\\']+)["\\\']','i'))?.[1];
 const tags=html.match(/<link\b[^>]{0,2000}>/gi)||[];
 for(const tag of tags){
  if(attr(tag,'rel')!=='stylesheet')continue;if(styles.length>=8)throw Error('스타일시트는 최대 8개까지 가져올 수 있습니다.');
  const href=attr(tag,'href');if(!href)continue;const cssUrl=new URL(href,u);
  if(cssUrl.origin!==u.origin)continue;
  const css=cssUrls(await request(cssUrl),cssUrl);total+=css.length;if(total>6*1024*1024)throw Error('전체 페이지가 6 MiB를 넘습니다.');styles.push(css);
 }
 return{url:u.href,name:u.hostname+u.pathname,html,css:styles.join('\n'),notice:'스크립트와 게임 실행 코드를 제외한 디자인을 가져옵니다. 공개 사이트는 변경하지 않습니다.'};
}
module.exports={address,cssUrls,load};

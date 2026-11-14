'use strict';
const MAX_BYTES=4*1024*1024;
const blocked=new Set(['script','iframe','frame','object','embed','base','link','meta','svg','math','form']);
const badKey=new Set(['__proto__','prototype','constructor']);
function clone(value){
 const text=JSON.stringify(value);
 if(!text||Buffer.byteLength(text)>MAX_BYTES)throw Error('제작 문서는 4 MiB 이하여야 합니다.');
 const result=JSON.parse(text);
 function walk(v,d=0){
  if(d>50)throw Error('문서 중첩이 너무 깊습니다.');
  if(v&&typeof v==='object')for(const [k,x]of Object.entries(v)){
   if(badKey.has(k)||/^script(?:-export|Export)?$/i.test(k))throw Error('실행 코드 또는 잘못된 필드를 포함합니다.');
   walk(x,d+1);
  }
 }
 walk(result);return result;
}
function url(value){
 if(typeof value!=='string')throw Error('주소는 문자열이어야 합니다.');
 if(/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(value)||/^#[\w-]*$/.test(value))return value;
 let u;try{u=new URL(value);}catch{throw Error('이미지·링크에는 HTTPS 주소를 사용하세요.');}
 if(u.protocol!=='https:'||u.username||u.password)throw Error('이미지·링크에는 HTTPS 주소를 사용하세요.');
 return u.href;
}
function style(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('스타일 객체가 필요합니다.');
 for(const [k,v]of Object.entries(value)){
  let remaining=String(v).replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi,(_all,_quote,address)=>{url(address);return '';});
  if(/url\s*\(/i.test(remaining))throw Error('CSS 이미지 주소를 확인하세요.');
  if(!/^--[\w-]+$|^-?[a-z][a-z0-9-]*$/i.test(k)||typeof v!=='string'||v.length>2000||/[<>]|@import|expression\s*\(|javascript\s*:|behavior\s*:/i.test(v))throw Error('허용되지 않는 스타일입니다: '+k);
 }
 return value;
}
function attributes(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('속성 객체가 필요합니다.');
 for(const [k,v]of Object.entries(value)){
  if(!/^[\w-]+$/.test(k)||/^on|^(srcdoc|style|formaction|action|srcset|xmlns|is)$/i.test(k)||!(typeof v==='string'||typeof v==='boolean'&&['hidden','disabled','checked','selected','multiple','readonly','required','autofocus','muted','loop','controls','open','reversed','novalidate'].includes(k.toLowerCase())||typeof v==='number'&&Number.isFinite(v)&&['width','height','tabindex','colspan','rowspan'].includes(k.toLowerCase())))throw Error('허용되지 않는 속성: '+k);
  if(['src','href','poster','background','xlink:href'].includes(k.toLowerCase()))url(v);
 }
 return value;
}
function component(v){
 if(typeof v==='string')throw Error('HTML 문자열 대신 구조화된 구성요소가 필요합니다.');
 if(!v||typeof v!=='object'||Array.isArray(v))throw Error('구성요소 객체가 필요합니다.');
 if(blocked.has(String(v.tagName||'').toLowerCase())||!['','default','wrapper','text','textnode','image','link','label','button','table','thead','tbody','tfoot','row','cell','caption','input','checkbox','textarea','select','option','comment'].includes(v.type||''))throw Error('실행 가능한 구성요소는 편집기에 넣을 수 없습니다.');
 if(v.tagName&&!/^[a-z][a-z0-9-]*$/i.test(v.tagName))throw Error('잘못된 태그입니다.');
 if(v.content!==undefined&&(typeof v.content!=='string'||!/^(?:[^<>]|<\/?(?:b|strong|em|i|u|s|br|span|p|div|code|sup|sub)\s*\/?>)*$/i.test(v.content)))throw Error('텍스트에는 HTML 대신 일반 글자를 사용하세요.');
 if(v.attributes){attributes(v.attributes);if(v.attributes.id&&!/^[a-zA-Z][\w:-]{0,119}$/.test(v.attributes.id))throw Error('구성요소 ID를 확인하세요.');}
 if(v.style)style(v.style);
 for(const key of ['src','href'])if(v[key])url(v[key]);
 if(v.components!==undefined){if(!Array.isArray(v.components))throw Error('하위 구성요소는 배열이어야 합니다.');v.components.forEach(component);}
 return v;
}
function project(input){
 const source=clone(input),p={pages:source.pages,styles:source.styles||[],assets:source.assets||[]};
 if(!Array.isArray(p.pages)||!p.pages.length||p.pages.length>20)throw Error('1–20개 페이지가 필요합니다.');
 for(const page of p.pages){
  if(page.component)component(page.component);
  if(page.frames)for(const frame of page.frames){component(frame.component);for(const key of Object.keys(frame))if(key!=='component')delete frame[key];}
  for(const key of Object.keys(page))if(!['id','name','component','frames'].includes(key))delete page[key];
 }

 for(const s of p.styles||[]){
  style(s.style||{});
  for(const selector of s.selectors||[]){const name=typeof selector==='string'?selector:selector.name;if(typeof name!=='string'||/[<{};\\]/.test(name))throw Error('CSS 선택자를 확인하세요.');}
  for(const key of ['mediaText','atRuleType','selectorsAdd'])if(s[key]!==undefined&&(typeof s[key]!=='string'||/[<{};\\]/.test(s[key])))throw Error('CSS 규칙을 확인하세요.');
 }

 for(const a of p.assets||[])url(typeof a==='string'?a:a.src);
 return p;
}
function proposal(input){
 const p=clone(input);
 if(typeof p.summary!=='string'||p.summary.length>2000||!Array.isArray(p.operations)||!p.operations.length||p.operations.length>80)throw Error('변경 설명과 1–80개 변경이 필요합니다.');
 for(const op of p.operations){
  if(!['style','text','attributes','append','remove','move'].includes(op.op)||typeof op.target!=='string'||!op.target||op.target.length>120)throw Error('변경 종류와 대상 ID를 확인하세요.');
  if(op.op==='style'){style(op.value);if(op.device!==undefined&&!['desktop','tablet','mobile'].includes(op.device))throw Error('대상 화면 크기를 확인하세요.');}
  if(op.op==='attributes'){attributes(op.value);if('id'in op.value)throw Error('AI가 요소 ID를 바꿀 수 없습니다.');}
  if(op.op==='text'&&(typeof op.value!=='string'||op.value.length>8000))throw Error('텍스트 변경을 확인하세요.');
  if(op.op==='append')component(op.value);
  if(op.op==='move'&&(typeof op.parent!=='string'||!Number.isInteger(op.index)||op.index<0||op.index>1000))throw Error('이동 위치를 확인하세요.');
 }
 return p;
}

function selected(project,selection){
 const roots=[];
 function visit(c){if(selection.includes(c.attributes?.id))roots.push(c);else for(const child of c.components||[])visit(child);}
 for(const page of project.pages){if(page.component)visit(page.component);for(const frame of page.frames||[])visit(frame.component);}
 return roots;
}
function scope(project,selection){const result=new Set();function visit(c){if(c.attributes?.id)result.add(c.attributes.id);for(const child of c.components||[])visit(child);}selected(project,selection).forEach(visit);return result;}
module.exports={selected,scope,clone,project,proposal,component,style,attributes,url,MAX_BYTES};

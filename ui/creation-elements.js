'use strict';
window.creationElements=(()=>{
 function all(editor){const out=[];function visit(c){out.push(c);c.components().forEach(visit);}visit(editor.getWrapper());return out;}
 const id=c=>c.getAttributes().id;
 function identify(editor){let changed=false;const seen=new Set();for(const c of all(editor)){let key=id(c);if(!key||seen.has(key)){key='el-'+crypto.randomUUID();changed=true;c.addAttributes({id:key});}seen.add(key);}return changed;}
 function label(c){const text=String(c.get('content')||'').replace(/<[^>]*>/g,'').trim().slice(0,40);const parents=[];for(let p=c.parent();p&&parents.length<2;p=p.parent())parents.unshift(p.getName());return [...parents,text||c.getName()].join(' › ');}
 function target(c){return{id:id(c),label:label(c),component:c.toJSON()};}
 function scope(editor,roots){const allowed=new Set();function add(c){allowed.add(id(c));c.components().forEach(add);}for(const c of all(editor))if(roots.includes(id(c)))add(c);return allowed;}
 function apply(editor,proposal){
  const map=new Map(all(editor).map(c=>[id(c),c])),allowed=scope(editor,proposal.scope||[]);
  const before=editor.getProjectData();
  try{
   for(const op of proposal.operations){
    const c=map.get(op.target);if(!c||!allowed.has(op.target))throw Error('선택 범위 밖의 변경입니다: '+op.target);
    if(op.op==='style'){if(op.device&&op.device!=='desktop')editor.Css.setRule('#'+CSS.escape(id(c)),op.value,{atRuleType:'media',atRuleParams:'(max-width: '+(op.device==='tablet'?'992':'480')+'px)',addStyles:true});else c.addStyle(op.value);}
    else if(op.op==='attributes')c.addAttributes(op.value);
    else if(op.op==='text'){
     if(c.components().length&&c.components().some(x=>x.get('type')!=='textnode'))throw Error('하위 레이아웃을 가진 요소의 글자는 개별 텍스트를 선택하세요.');
     const node=document.createElement('span');node.textContent=op.value;c.components(node.innerHTML);
    }else if(op.op==='append')c.append(op.value);
    else if(op.op==='remove'){if(c===editor.getWrapper())throw Error('페이지 전체는 제거할 수 없습니다.');c.remove();}
    else if(op.op==='move'){
     const parent=map.get(op.parent);if(!parent||!allowed.has(op.parent)||c===editor.getWrapper())throw Error('이동할 부모가 선택 범위 밖입니다.');
     for(let a=parent;a;a=a.parent())if(a===c)throw Error('자기 하위 요소로 이동할 수 없습니다.');
     c.move(parent,{at:op.index});
    }else throw Error('지원하지 않는 변경입니다.');
   }
   identify(editor);return before;
  }catch(e){editor.loadProjectData(before);throw e;}
 }
 function fromHtml(text,base){
  const d=new DOMParser().parseFromString(text,'text/html');
  d.querySelectorAll('script,iframe,frame,object,embed,base,link,meta,svg,math,form').forEach(e=>e.remove());
  let css=[...d.querySelectorAll('style')].map(e=>e.textContent).join('\n');d.querySelectorAll('style').forEach(e=>e.remove());

  const resolveCss=value=>!base?value:value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi,(all,quote,source)=>{
   if(source.startsWith('data:image/'))return all;
   try{const u=new URL(source,base);return u.protocol==='https:'&&!u.username&&!u.password?'url("'+u.href.replace(/"/g,'%22')+'")':'none';}catch{return 'none';}
  });
  css=resolveCss(css);
  if(/@import|expression\s*\(|javascript\s*:|<\//i.test(css))throw Error('CSS의 외부 참조·실행 코드를 먼저 제거하세요.');
  for(const e of d.body.querySelectorAll('*'))for(const a of [...e.attributes]){
   if(/^on|^(srcdoc|srcset|is|formaction|action)$/i.test(a.name))e.removeAttribute(a.name);
   if(base&&/^(src|href|poster|background)$/i.test(a.name)&&!a.value.startsWith('#')){try{e.setAttribute(a.name,new URL(a.value,base).href);}catch{e.removeAttribute(a.name);}}
   const current=e.getAttribute(a.name)||'';
   if(/^(src|href|poster|background)$/i.test(a.name)&&!/^https:\/\/|^#|^data:image\/(png|jpeg|webp|gif);base64,/i.test(current))e.removeAttribute(a.name);
   if(a.name==='style')e.setAttribute('style',resolveCss(a.value));
   if(a.name==='style'&&/expression\s*\(|javascript\s*:|@import/i.test(a.value))e.removeAttribute(a.name);
  }
  return{html:d.body.innerHTML,css};
 }
 return{all,id,identify,label,target,scope,apply,fromHtml};
})();

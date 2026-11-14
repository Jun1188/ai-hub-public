'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const document=require('./creation-document');
function createStore(root=path.join(require('./paths').hubDataDir(),'creation-studio.local')){
 const id=v=>{if(typeof v!=='string'||!/^[a-f0-9-]{36}$/.test(v))throw Error('제작 문서 ID가 잘못되었습니다.');return v;};
 const file=v=>path.join(root,id(v)+'.json');
 const read=v=>{const p=JSON.parse(fs.readFileSync(file(v),'utf8'));if(p.schemaVersion!==1||p.id!==v||!Number.isInteger(p.revision))throw Error('제작 문서를 읽지 못했습니다. 원본을 보존합니다.');return p;};
 function write(p){
  fs.mkdirSync(root,{recursive:true});const target=file(p.id),tmp=target+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(p,null,2),'utf8');fs.renameSync(tmp,target);return p;
 }
 function locked(v,fn){
  fs.mkdirSync(root,{recursive:true});const lock=file(v)+'.lock';let fd;
  try{fd=fs.openSync(lock,'wx');}catch(e){if(e.code==='EEXIST')throw Error('다른 편집이 저장 중입니다. 잠시 후 다시 저장하세요.');throw e;}
  try{return fn();}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
 }
 function list(){
  let names;try{names=fs.readdirSync(root);}catch(e){if(e.code==='ENOENT')return[];throw e;}
  return names.filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).map(n=>{const p=read(n.slice(0,-5));return{id:p.id,name:p.name,revision:p.revision,updatedAt:p.updatedAt};});
 }
 function create(name='새 웹 디자인',project){
  const p={schemaVersion:1,id:crypto.randomUUID(),name:String(name).trim().slice(0,100)||'새 웹 디자인',revision:0,updatedAt:new Date().toISOString(),selection:[],proposals:[],project:document.project(project)};
  return locked(p.id,()=>write(p));
 }
 function save(input){
  return locked(input.id,()=>{
   const p=read(input.id);
   if(input.revision!==p.revision)throw Error('다른 편집이 먼저 저장되었습니다. 현재 편집을 JSON으로 내려받은 후 새로 불러오세요.');
   const project=document.project(input.project),selection=document.clone(input.selection||[]);
   if(!Array.isArray(selection)||selection.length>100||selection.some(s=>typeof s!=='string'||s.length>120))throw Error('선택 요소를 확인하세요.');
   const name=String(input.name||p.name).trim().slice(0,100);
   if(name===p.name&&JSON.stringify(project)===JSON.stringify(p.project)&&JSON.stringify(selection)===JSON.stringify(p.selection))return p;
   if(fs.existsSync(file(p.id)))fs.copyFileSync(file(p.id),file(p.id)+'.previous');
   return write({...p,name:String(input.name||p.name).trim().slice(0,100),project,selection,revision:p.revision+1,updatedAt:new Date().toISOString()});
  });
 }
 function propose(input){
  return locked(input.id,()=>{
   const p=read(input.id);if(input.baseRevision!==p.revision)throw Error('문서가 변경되었습니다. 최신 선택 요소를 다시 읽어 변경안을 만드세요.');
   if(p.proposals.length>=30)throw Error('변경안이 30개입니다. 기존 변경안을 검토하거나 새 문서로 저장하세요.');
   const allowed=document.scope(p.project,p.selection);
   const value=document.proposal(input);
   if(!allowed.size||value.operations.some(op=>!allowed.has(op.target)||op.op==='move'&&!allowed.has(op.parent)))throw Error('사용자가 선택한 범위 안에만 변경안을 만들 수 있습니다.');
   const proposal={...value,scope:p.selection,id:crypto.randomUUID(),baseRevision:p.revision,createdAt:new Date().toISOString()};
   p.proposals.push(proposal);write(p);return proposal;
  });
 }
 function dismiss(v,proposalId){return locked(v,()=>{const p=read(v);p.proposals=p.proposals.filter(x=>x.id!==proposalId);return write(p);});}
 return{list,read,create,save,propose,dismiss};
}
let singleton;const instance=()=>singleton||(singleton=createStore());
module.exports={createStore,instance};

'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
function register(ctx){
 const store=()=>require('../../src/core/creation-studio').instance();
 const assistant=()=>require('../../src/core/creation-assistant');
 ctx.handle('studio:fetchPage',url=>require('../../src/core/creation-page-import').load(url));
 ctx.handle('studio:list',()=>store().list());
 ctx.handle('studio:read',id=>store().read(id));
 ctx.handle('studio:create',(name,project)=>store().create(name,project));
 ctx.handle('studio:save',input=>store().save(input));
 ctx.handle('studio:dismiss',(id,proposalId)=>store().dismiss(id,proposalId));
 ctx.handle('studio:aiStart',input=>assistant().start(input));
 ctx.handle('studio:aiPoll',id=>assistant().poll(id));
 ctx.handle('studio:aiCancel',id=>assistant().cancel(id));
 ctx.handle('studio:import',async kind=>{
  const {dialog}=require('electron');
  const extensions=kind==='image'?['png','jpg','jpeg','webp','gif']:['json','html','htm'];
  const r=await dialog.showOpenDialog(ctx.window(),{title:'편집할 리소스 선택',properties:['openFile'],filters:[{name:'Resource',extensions}]});
  if(r.canceled)return null;
  const file=r.filePaths[0],stat=await fs.stat(file);
  if(stat.size>3*1024*1024)throw Error('3 MiB 이하의 파일을 선택하세요.');
  const data=await fs.readFile(file),ext=path.extname(file).slice(1).toLowerCase();
  if(!extensions.includes(ext))throw Error('지원하지 않는 형식입니다.');
  return kind==='image'?{name:path.basename(file),src:'data:image/'+(ext==='jpg'?'jpeg':ext)+';base64,'+data.toString('base64')}:{name:path.basename(file),ext,text:data.toString('utf8').replace(/^\uFEFF/,'')};
 });
 ctx.handle('studio:export',async input=>{
  if(!['json','html'].includes(input.kind)||typeof input.text!=='string'||Buffer.byteLength(input.text)>8*1024*1024)throw Error('내보낼 문서를 확인하세요.');
  const r=await require('electron').dialog.showSaveDialog(ctx.window(),{title:'제작 문서 내보내기',defaultPath:'design.'+input.kind,filters:[{name:input.kind,extensions:[input.kind]}]});
  if(r.canceled)return{cancelled:true};
  require('./device-key-delivery').assertFrame();
  await fs.writeFile(r.filePath,input.text,'utf8');return{saved:true};
 });
 ctx.handle('studio:figma',input=>{
  const u=new URL(input);
  if(u.protocol!=='https:'||!['www.figma.com','figma.com','embed.figma.com'].includes(u.hostname)||u.username||u.password||!/^\/(design|file|board|proto)\/[a-z0-9]+(?:\/|$)/i.test(u.pathname))throw Error('Figma 파일 주소를 입력하세요.');
  const embed=new URL(u.href);embed.hostname='embed.figma.com';embed.pathname=embed.pathname.replace(/^\/file\//,'/design/');embed.search='';embed.hash='';embed.searchParams.set('embed-host','ai-hub');
  if(u.searchParams.get('node-id'))embed.searchParams.set('node-id',u.searchParams.get('node-id'));
  return embed.href;
 });
}
module.exports={register};

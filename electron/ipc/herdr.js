'use strict';
function register(ctx){
 let confirming=false;
 const herdr=()=>require('../../src/core/herdr');
 ctx.handle('herdr:inspect',p=>herdr().inspect(p));
 ctx.handle('herdr:status',id=>herdr().status(id));
 ctx.handle('herdr:control',async p=>{
  if(confirming)throw Error('열린 Herdr 확인 창을 먼저 처리하세요.');confirming=true;try{
  if(p.action!=='session')herdr().command(p);else herdr().session(p.session);
  const choice=await require('electron').dialog.showMessageBox(ctx.window(),{type:'question',title:'Herdr 작업',message:'Herdr '+p.session+' 세션에 '+p.action+' 작업을 요청합니다.',detail:JSON.stringify(p,null,2).slice(0,14000),buttons:['취소','확인하고 실행'],defaultId:0,cancelId:0,noLink:true});
  if(choice.response!==1)return{cancelled:true};require('./device-key-delivery').assertFrame();return p.action==='session'?herdr().startSession(p.session):herdr().submit(p);
  }finally{confirming=false;}
 });
}
module.exports={register};

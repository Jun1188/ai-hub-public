'use strict';
const crypto=require('crypto');
const path=require('path');
const {z}=require('zod');
const VIEWS={dashboard:['dashboard','resource-snapshot'],models:['aider','local-runtime-status'],
 memory:['memory',''],skills:['skills',''],rag:['source',''],sharing:['settings','share-dir-now'],
 credentials:['dashboard','vault-provider'],connections:['aider','mcp-http-box'],pipelines:['pipelines',''],settings:['settings','']};
const handle=(provider,id)=>crypto.createHash('sha256').update(provider+'\0'+id).digest('hex');
function modelProjection(provider,m){return {handle:handle(provider,m.id),name:path.win32.basename(m.id),loaded:Boolean(m.loaded),sizeBytes:m.sizeBytes||null,maxContext:m.maxContext||null};}
async function details(){
 const providers=await Promise.all(['lmstudio','llamacpp'].map(async provider=>{
  try{return {provider,available:true,models:(await require('../core/model-control').catalog(provider)).map(m=>modelProjection(provider,m))};}
  catch{return {provider,available:false,models:[]};}
 }));
 const s=require('../core/share').status();
 return {version:require('../../package.json').version,providers,
  research:await require('../core/research-review').summary(),
  sharing:{enabled:s.enabled,syncing:s.syncing,paused:s.paused,lastSyncAt:s.lastSyncAt,hasError:Boolean(s.lastError),items:s.items,copiedIn:s.copiedIn,copiedOut:s.copiedOut},
  policy:{loopbackOnly:true,modelPreparation:true,downloads:false,keysInPanel:false,automaticRetries:false,
   panelControls:{pipelines:'user-confirmed',hardwarePolicy:'device-only'}}};
}
function operationProjection(r){return {requestId:r.requestId,state:r.state,provider:r.provider,placement:r.placement,startedAt:r.startedAt,finishedAt:r.finishedAt,
 pollAfterMs:r.pollAfterMs||5000,phase:r.phase,admission:r.admission||null,reconcileBeforeRetry:Boolean(r.reconcileBeforeRetry),hasError:Boolean(r.error)};}
async function prepare(a){
 if(a.confirmed!==true)throw new Error('Explicit model preparation confirmation required');
 const models=require('../core/model-control');
 const selected=(await models.catalog(a.provider)).find(m=>handle(a.provider,m.id)===a.model_handle);
 if(!selected)throw new Error('Refresh the local catalog before preparing a model');
 return operationProjection(models.start({provider:a.provider,model:selected.id,placement:a.placement,contextLength:a.context_length}));
}
async function open(view){
 const target=VIEWS[view];if(!target)throw new Error('Unknown Hub view');
 const {BrowserWindow}=require('electron');
 const win=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed()&&w.webContents.getURL().startsWith('file:'));
 if(!win)throw new Error('Open the desktop Hub application first');
 if(win.isMinimized())win.restore();win.show();win.focus();
 win.webContents.send('panel-navigate',{tab:target[0],section:target[1]});
 return {opened:true,view};
}
const definitions={
 harness_panel_details:{title:'모델·공유·연구 상태 조회',inputSchema:{},readOnly:true,run:details},
 harness_panel_open:{title:'Hub 관리 화면 열기',inputSchema:{view:z.enum(Object.keys(VIEWS))},run:a=>open(a.view)},
 harness_panel_prepare:{title:'선택한 로컬 모델 준비',inputSchema:{provider:z.enum(['lmstudio','llamacpp']),model_handle:z.string().regex(/^[a-f0-9]{64}$/),placement:z.enum(['auto','cpu']),context_length:z.number().int().min(512).max(32768),confirmed:z.literal(true)},run:prepare},
 harness_panel_operation:{title:'모델 준비 진행 조회',inputSchema:{request_id:z.string().uuid()},readOnly:true,run:a=>operationProjection(require('../core/model-control').result(a.request_id))},
 ...require('./harness-panel-control').definitions,
};
function register(server,forward){for(const [name,d]of Object.entries(definitions))server.registerTool(name,{
 title:d.title,description:d.description||d.title+'; app UI only; no keys, private paths, task text or automatic retries.',inputSchema:d.inputSchema,
 annotations:{readOnlyHint:Boolean(d.readOnly),destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['app']}},
},async a=>{try{const value=forward?await forward(name,a):await d.run(a);return forward?value:{structuredContent:value,content:[{type:'text',text:JSON.stringify(value)}]};}
 catch(e){return {isError:true,content:[{type:'text',text:e&&e.panelSafe?e.message:'Hub 작업을 완료하지 못했습니다. 연결·모델 상태와 Hub 관리 화면을 확인하세요.'}]};}});}
module.exports={register,details,prepare,operationProjection,modelProjection,VIEWS,handle};

'use strict';
const http=require('http'),broker=require('./credential-broker');
async function open({provider,model,jobId=broker.jobId('local-client'),signal}) {
  if(!['lmstudio','llamacpp'].includes(provider)||!model)throw Error('Local credential proxy requires an exact provider/model');
  const active=new AbortController();
  const server=http.createServer(async(req,res)=>{
    try {
      if(!['127.0.0.1','::ffff:127.0.0.1','::1'].includes(req.socket.remoteAddress)||req.headers.origin)throw Error('Loopback client required');
      const u=new URL(req.url,'http://localhost');let operationId,payload={};
      if(req.method==='GET'&&u.pathname==='/v1/models'&&!u.search)operationId=provider+'.models';
      else if(req.method==='POST'&&u.pathname==='/v1/chat/completions'&&!u.search){
        operationId=provider+'.chat';let size=0;const parts=[];
        for await(const part of req){size+=part.length;if(size>65536)throw Error('Client request too large');parts.push(part);}
        const body=JSON.parse(Buffer.concat(parts).toString('utf8'));if(body.model!==model)throw Error('Client model is outside job scope');
        payload={body};
      }else throw Error('Unsupported local client operation');
      const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});
      const requestSignal=AbortSignal.any([active.signal,abort.signal]);
      // Aider 요청 사이에 거버너가 모델을 내렸으면 JIT(GPU 최대) 대신 입장 판정으로 다시 올린다.
      if(operationId==='lmstudio.chat')await require('./model-control').ready({model,signal:requestSignal});
      const response=await broker.requestResponse({credentialRef:'credential:'+provider,operationId,jobId,payload},{signal:requestSignal,timeoutMs:1800000});
      res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')||'application/json','Cache-Control':'no-store'});
      if(response.body)for await(const chunk of response.body){if(res.destroyed)break;if(!res.write(Buffer.from(chunk)))await new Promise(resolve=>res.once('drain',resolve));}res.end();
    }catch(error){if(!res.headersSent)res.writeHead(error.status||403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Local credential broker rejected or did not complete this request',type:'broker_error'}}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const close=()=>{active.abort();server.close();server.closeAllConnections();};
  signal?.addEventListener('abort',close,{once:true});server.unref();
  return {apiBase:'http://127.0.0.1:'+server.address().port+'/v1',apiKey:'local-broker',close:()=>{signal?.removeEventListener('abort',close);close();}};
}
module.exports={open};

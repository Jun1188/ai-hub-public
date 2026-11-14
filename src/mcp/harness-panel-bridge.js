'use strict';
const {McpServer}=require('@modelcontextprotocol/server');
const {serveStdio}=require('@modelcontextprotocol/server/stdio');
const {Client,StreamableHTTPClientTransport}=require('@modelcontextprotocol/client');
const {URI,MIME}= {URI:'ui://ai-hub/harness.html',MIME:'text/html;profile=mcp-app'};
async function upstream(fn) {
  const cfg=require('../core/config').load();
  if(cfg.hub.bindHost!=='127.0.0.1'||!cfg.hub.authToken)throw new Error('Authenticated loopback Hub required');
  const client=new Client({name:'ai-hub-panel-observer',version:require('../../package.json').version});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+cfg.hub.httpPort+'/mcp'),{
      requestInit:{headers:{Authorization:'Bearer '+cfg.hub.authToken}}, fetch:(url,options)=>fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(10000)}),
    }));
    return await fn(client);
  }finally{await client.close();}
}
function server() {
  const todoQueue=require('./shared-todo-queue');
  const s=new McpServer({name:'ai-hub-panel',version:require('../../package.json').version},{instructions:todoQueue.INSTRUCTIONS});
  todoQueue.register(s);
  require('./app-lifecycle-tools').register(s, (name, args) => upstream(c => c.callTool({ name, arguments: args })));
  require('./harness-panel-actions').register(s,(name,args)=>upstream(c=>c.callTool({name,arguments:args})));
  s.registerResource('ai-hub-harness-panel',URI,{mimeType:MIME},async()=>({contents:[{uri:URI,mimeType:MIME,text:require('fs').readFileSync(require('path').join(__dirname,'harness-panel.html'),'utf8'),_meta:{ui:{csp:{connectDomains:[],resourceDomains:[],frameDomains:[]},prefersBorder:true}}}]}));
  for(const name of ['harness_panel','harness_panel_refresh'])s.registerTool(name,{
    title:name==='harness_panel'?'ai-hub · 통합 흐름과 자원':'Hub 상태 새로고침',
    description:'Opens the ai-hub panel through the authenticated loopback Hub. This call is read-only; panel controls act only after the user confirms them in the panel. No keys or file paths.',
    inputSchema:{},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    _meta:name==='harness_panel'?{ui:{resourceUri:URI},'openai/ui':{entrypoints:[{type:'thread'},{type:'global'}]}}:{ui:{visibility:['app']}},
  },async()=>{try{return await upstream(c=>c.callTool({name,arguments:{}}));}catch{
      const value={contractVersion:'1.0.0',connectionAvailable:false,sampledAt:Date.now(),pollAfterMs:5000,
        resources:{cpu:{usagePercent:null},ram:{usagePercent:null},gpu:{available:false,devices:[]},hub:{rssBytes:null},scope:'Hub unavailable; measurements unknown'},offloadJobs:null};
      return {structuredContent:value,content:[{type:'text',text:JSON.stringify(value)}]};
    }});
  return s;
}
async function main() {await serveStdio(server);}
module.exports={main,server};

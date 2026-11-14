'use strict';
const readline=require('readline'),fs=require('fs');
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
let waiting=false,prompt='';
function completed(status='completed'){send({method:'item/completed',params:{threadId:'owned-fixture-thread',item:{type:'agentMessage',text:'Fixture review completed; no actual LLM inference'}}});send({method:'turn/completed',params:{threadId:'owned-fixture-thread',turn:{id:'fixture-turn',status}}});waiting=false;}
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')return send({id:m.id,result:{userAgent:'fixture'}});if(m.method==='initialized')return;
  if(['thread/start','thread/resume'].includes(m.method))return send({id:m.id,result:{thread:{id:'owned-fixture-thread'}}});
  if(m.method==='turn/start'){prompt=m.params.input[0].text;send({id:m.id,result:{turn:{id:'fixture-turn'}}});send({method:'turn/started',params:{threadId:'owned-fixture-thread',turn:{id:'fixture-turn'}}});
    if(prompt==='crash')return process.exit(1);if(prompt==='wait'){waiting=true;return;}
    if(prompt==='approval'){send({id:100,method:'item/commandExecution/requestApproval',params:{threadId:'owned-fixture-thread',turnId:'fixture-turn',command:'echo fixture',cwd:process.cwd()}});return;}
    if(prompt==='edit')fs.writeFileSync('소스.txt','수정된 테스트 내용  \n','utf8');return setTimeout(()=>completed(),10);
  }
  if(m.method==='turn/interrupt'){send({id:m.id,result:{}});if(waiting)completed('interrupted');return;}
  if(m.id===100&&!m.method)return completed(m.result?.decision==='accept'?'completed':'interrupted');
  if(m.id!==undefined)send({id:m.id,error:{code:-32601,message:'Unsupported fixture request'}});
});

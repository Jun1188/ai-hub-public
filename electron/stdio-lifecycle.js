'use strict';
const guarded=new WeakSet();
function guard(streams=[process.stdout,process.stderr]){
 for(const stream of streams){
  if(!stream?.on||guarded.has(stream))continue;
  // A launcher may close its console while this GUI continues running.
  stream.on('error',error=>{if(error.code!=='EPIPE')throw error;});
  guarded.add(stream);
 }
}
module.exports={guard};

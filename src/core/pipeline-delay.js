'use strict';
function execute(step,run){
 const ms=step.ms;if(!Number.isInteger(ms)||ms<1||ms>60000)throw Error('대기 시간은 1–60000ms입니다.');
 return new Promise(resolve=>{
  if(run.abort.signal.aborted){resolve(-1);return;}
  const stop=()=>{clearTimeout(timer);run.abort.signal.removeEventListener('abort',stop);resolve(-1);};
  const timer=setTimeout(()=>{run.abort.signal.removeEventListener('abort',stop);resolve(0);},ms);
  run.abort.signal.addEventListener('abort',stop,{once:true});
 });
}
module.exports={execute};

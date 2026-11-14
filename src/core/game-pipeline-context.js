'use strict';
async function prepare(node){
 const step=node.step;if(!node.game||!['offload','herdr-agent','ai'].includes(step.type))return step;
 const {goal,skills}=node.game;let text='Game development goal: '+goal;
 for(const skill of skills){
  const source=await require('./repository-skills').preview(skill);
  if(text.length+source.length>8000)throw Error('선택한 게임 스킬이 너무 큽니다. 이 단계에 필요한 스킬만 연결하세요.');
  text+='\n\n### '+skill+'\n'+source;
 }
 text=require('./secret-scrub').scrub(text);require('./prompt-safety').assertExternal(text);
 if(step.type==='offload')return{...step,text:(step.text||'')+'\n\n'+text};
 if(step.type==='herdr-agent')return{...step,prompt:step.prompt+'\n\n'+text};
 return{...step,promptTemplate:step.promptTemplate+'\n\n'+text};
}
module.exports={prepare};

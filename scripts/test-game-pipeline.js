'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const graph=require('../src/core/pipeline-state-graph'),window={};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../ui/tabs/game-pipeline.js'),'utf8'),{window,$:()=>({addEventListener(){}})});
(async()=>{
 let checks=0;
 for(const engine of ['Unity','Unreal','기타']){
  const p=JSON.parse(JSON.stringify(window.gamePipeline.template(engine)));assert.equal(p.auto.enabled,false);checks++;
  graph.validate(p.graph);checks++;
  let result=await graph.execute(p.graph),reviews=0;
  while(result.status==='paused'){reviews++;result=await graph.execute(p.graph,{checkpoint:result.checkpoint});}
  assert.equal(result.status,'succeeded');assert.equal(result.checkpoint.data.iteration,3);assert.equal(reviews,13);checks+=3;
  result=await graph.execute(p.graph);for(let i=0;i<3;i++)result=await graph.execute(p.graph,{checkpoint:result.checkpoint});
  assert.equal(result.status,'paused');checks++;
  result=await graph.execute(p.graph,{checkpoint:result.checkpoint,stateOverride:{...result.checkpoint.data,accepted:true}});
  assert.equal(result.status,'succeeded');assert.equal(result.checkpoint.data.iteration,0);checks+=2;
 }
 console.log('Game development loop: '+checks+' checks passed; no engines or agents executed');
})().catch(e=>{console.error(e);process.exitCode=1;});

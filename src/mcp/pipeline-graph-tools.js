'use strict';
const {z}=require('zod');
const graph=require('../core/pipeline-state-graph'),pipeline=require('../core/pipeline');
const text=v=>({content:[{type:'text',text:JSON.stringify(v,null,2)}]});
function register(server){
 server.registerTool('devpipeline_cancel',{description:'Cancel an authorized pipeline run or paused review. Does not restart or retry work. Running API steps stop at their existing cancellation/deadline boundary.',inputSchema:{run_id:z.string().uuid()}},async a=>text(pipeline.cancel(a.run_id)));
 server.registerTool('dev_pipeline_graph_validate',{description:'Validate bounded state/conditional/loop/review graph. No execution.',inputSchema:{graph:z.record(z.string(),z.any())}},async a=>text({graph:graph.validate(a.graph)}));
 server.registerTool('dev_pipeline_graph_simulate',{description:'Simulate graph transitions with successful mock step results. Calls no commands, models or MCP tools; this does not validate task output quality.',inputSchema:{graph:z.record(z.string(),z.any()),mock_results:z.record(z.string(),z.any()).optional()}},async a=>text(await graph.simulate(a.graph,a.mock_results)));
 server.registerTool('dev_pipeline_graph_save',{description:'Save a validated manual-only state graph using the existing step types. Saving never executes.',inputSchema:{pipeline:z.record(z.string(),z.any())}},async a=>{if(!a.pipeline.graph)throw Error('graph required');return text(pipeline.save(a.pipeline));});
 server.registerTool('dev_pipeline_graph_resume',{description:'Explicitly resume one paused review checkpoint with the same run ID. Optional state replaces checkpoint data. Refuses changed graph. May execute downstream steps; review their effects before calling.',inputSchema:{run_id:z.string().uuid(),state:z.record(z.string(),z.any()).optional()}},async a=>text(pipeline.resume(a.run_id,a.state)));
}
module.exports={register};

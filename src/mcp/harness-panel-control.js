'use strict';
// 패널 제어 버튼용 앱 전용 도구. 바꾸는 도구는 모두 패널의 허용 체크 뒤 confirmed:true로만 실행된다.
const {z}=require('zod');
const control=()=>require('../core/panel-control').instance();
const uuid=z.string().uuid();
const definitions={
 harness_panel_hardware:{title:'하드웨어 상태와 로컬 실행 판단 조회',inputSchema:{refresh:z.boolean().optional()},readOnly:true,
  run:a=>control().hardwareStatus({refresh:a.refresh===true})},
 harness_panel_hardware_set:{title:'이 PC 하드웨어 정책 변경',inputSchema:{require_ac_power:z.boolean().optional(),heavy_app_policy:z.enum(['defer','cpu-only']).optional(),
  max_concurrent:z.number().int().min(1).max(3).optional(),reset:z.boolean().optional(),confirmed:z.literal(true)},run:a=>control().hardwareSet(a)},
 harness_panel_pipelines:{title:'파이프라인 목록과 최근 실행 조회',inputSchema:{},readOnly:true,run:()=>control().pipelines()},
 harness_panel_pipeline:{title:'파이프라인 시작·재개·중지',inputSchema:{action:z.enum(['start','resume','cancel']),pipeline_id:z.string().min(1).max(128).optional(),run_id:uuid.optional(),confirmed:z.literal(true)},
  run:a=>control().pipelineAction(a)},
};
module.exports={definitions};

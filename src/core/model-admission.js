'use strict';
const GIB=1024**3,MIB=1024**2;
const positive=x=>Number.isFinite(x)&&x>0;
// local-runtime이 'moe'에 넘기는 --fit-target 1536 MiB. MoE에서 비전문가 몫은 보통 수~15%라 모를 때는 30%로 넉넉히 잡는다.
const MOE_FIT_TARGET=1536*MIB,MOE_UNVERIFIED_DENSE=0.3;
function assess({snapshot,environment,policy={},target,contextLength=4096,now=Date.now(),placement='auto'}){
  const defer=(reason,expected=null)=>({admitted:false,state:'deferred',reason,expected,sampledAt:snapshot?.sampledAt||null});
  if(!snapshot || !Number.isFinite(snapshot.sampledAt) || now-snapshot.sampledAt>10000 || snapshot.sampledAt>now+1000)return defer('resource_sample_stale');
  if(!environment || !Number.isFinite(environment.at) || now-environment.at>15000 || environment.at>now+1000 || environment.failures || environment.retryAt>now ||
    !Array.isArray(environment.heavyApps))return defer('environment_probe_unavailable');
  if(!target||!Number.isInteger(contextLength)||contextLength<512||contextLength>32768)return defer('invalid_model_context');
  const adm=policy.admission||{};
  const ram=policy.ram||{},vram=policy.vram||{};
  // The panel and shared policy write requireAcPowerForLocal; requireAcPower is the older key.
  if((adm.requireAcPowerForLocal??adm.requireAcPower)!==false && environment.onAcPower!==true)return defer('ac_power_unconfirmed');
  if(environment.heavyApps.length && adm.heavyAppPolicy==='cpu-only')placement='cpu'; // same answer as hardware-advisor
  else if(environment.heavyApps.length && adm.heavyAppPolicy!=='allow')return defer('heavy_application_active');
  const cpu=snapshot.cpu?.usagePercent;
  if(!Number.isFinite(cpu)||cpu<0||cpu>100)return defer('cpu_sample_unavailable');
  if(cpu>100*(adm.maxCpuUtilForBackground??adm.maxCpuUtilBackground??0.85))return defer('cpu_busy');
  const total=snapshot.ram?.totalBytes,used=snapshot.ram?.usedBytes;
  if(!positive(total)||!Number.isFinite(used)||used<0||used>total)return defer('ram_sample_unavailable');
  const reserveRam=Math.max(3*GIB,Number(ram.reserveBytes)||0);
  const limit=Math.min(0.9,Number(ram.maxUsedFraction)||0.9);
  if(used/total>=limit)return defer('ram_pressure');
  const devices=(snapshot.gpu?.devices||[]).filter(d=>positive(d.totalMiB)&&Number.isFinite(d.usedMiB)&&d.usedMiB>=0&&d.usedMiB<=d.totalMiB&&Number.isFinite(d.usagePercent)&&d.usagePercent>=0&&d.usagePercent<=100);
  const gpu=devices.sort((a,b)=>(b.totalMiB-b.usedMiB)-(a.totalMiB-a.usedMiB))[0];
  const gpuFree=gpu?(gpu.totalMiB-gpu.usedMiB)*MIB:0;
  const gpuReserve=gpu?Math.max(768*MIB,Number(vram.reserveBytes)||0,(Number(vram.reserveFraction)||0.08)*gpu.totalMiB*MIB):0;
  const architecture=target.arch;
  const bytesPerToken=architecture?.layers>0&&architecture?.kvHeads>0&&architecture?.headDim>0
    ? Math.ceil(2*architecture.layers*architecture.kvHeads*architecture.headDim*(architecture.kvBits||16)/8)
    : 131072;
  const allocated=target.loaded && target.kvAllocation==='full' && Number.isFinite(target.allocatedContextTokens) ? target.allocatedContextTokens : 0;
  // Full requested KV is reserved unless allocation metadata proves otherwise; an allocation that already covers the request needs none.
  const kv=allocated>=contextLength?0:Math.max(256*MIB,Math.max(0,contextLength-allocated)*bytesPerToken);
  const kvBasis=allocated?'confirmed-allocated-context-delta':architecture?'architecture-kv':'conservative-unverified-kv';
  let selected=placement,extraRam,extraVram,basis='weight-plus-context-budget',gpuRatio;
  if(!target.loaded && !positive(target.sizeBytes))return defer('model_footprint_unknown');
  const weights=target.sizeBytes||0;
  // --cpu-moe(local-runtime의 'moe')는 전문가 텐서를 mmap 그대로 RAM에 두고 나머지와 KV만 GPU에 올린다. llama.cpp만 이
  // 배치를 띄우므로 GGUF를 직접 기동하는 대상(startup)에만 쓴다. 비율을 모르면 VRAM은 MOE_UNVERIFIED_DENSE만큼,
  // RAM은 파일 전체가 상주한다고 잡는다.
  const expert=Number.isFinite(target.moe?.expertBytes)?Math.min(weights,target.moe.expertBytes):null;
  const moeVram=(expert==null?weights*MOE_UNVERIFIED_DENSE:weights-expert)*1.15+kv;
  const moeRam=2*GIB+(expert==null?weights*1.15:expert);
  const moeReserve=Math.max(gpuReserve,MOE_FIT_TARGET);
  let vramReserve=gpuReserve;
  if(target.loaded){selected='loaded';extraRam=kv;extraVram=gpu?kv:0;basis='loaded-model-plus-requested-kv';}
  else if(placement!=='cpu' && gpu && weights*1.15+kv<=gpuFree-gpuReserve){
    selected='gpu';extraRam=2*GIB+kv;extraVram=weights*1.15+kv;
  }else if(placement!=='cpu' && gpu && target.moe?.expertCount>0 && target.startup && moeVram<=gpuFree-moeReserve){
    selected='moe';extraVram=moeVram;extraRam=moeRam;vramReserve=moeReserve;
    basis=target.moe.expertBytes==null?'moe-cpu-experts-unverified-split':'moe-cpu-experts';
  }else if(placement!=='cpu' && gpu && weights*(Number(vram.minPartialFraction)||0.6)<=gpuFree-gpuReserve){
    // 전부 안 들어가도 들어가는 층만 VRAM에 올리면 CPU 전용보다 훨씬 빠르다(규칙 13: 2.4 → 4.5 tok/s. 2026-10-18 이 PC
    // gemma-4-12b 70% 오프로드는 offload 8건 119초, CPU 전용은 512토큰에 106초). llama.cpp는 --fit, LM Studio는
    // --gpu <gpuRatio>로 올린다. 남은 VRAM을 다 쓴다고 보고 넘치는 몫은 RAM으로 잡는다.
    const part=gpuFree-gpuReserve;
    selected='gpu';extraVram=part;extraRam=2*GIB+Math.max(0,weights*1.15+kv-part);basis='partial-gpu-offload';
    gpuRatio=Math.max(0.05,Math.floor(Math.min(1,Math.max(0,part-kv)/(weights*1.15))*100)/100);
  }else{selected='cpu';extraRam=weights*1.15+kv;extraVram=0;}
  const expected={ramBytes:Math.ceil(extraRam),vramBytes:Math.ceil(extraVram),contextLength,placement:selected,basis,kvBytes:kv,kvBasis,verified:false,
    ...(gpuRatio?{gpuRatio}:{})};
  if(total-used<extraRam+reserveRam || (used+extraRam)/total>limit)return defer('projected_ram_exceeds_budget',expected);
  if(extraVram && (!gpu || gpuFree<extraVram+vramReserve))return defer('projected_vram_exceeds_budget',expected);
  const gpuBusy=Number.isFinite(gpu?.busyPercent)?gpu.busyPercent:gpu?.usagePercent; // busyPercent ignores wallpaper/dwm/Hub jobs
  if(extraVram && gpuBusy>100*(adm.maxGpuUtilForBackground??adm.maxGpuUtilBackground??0.35))return defer('gpu_busy',expected);
  return {admitted:true,state:'admitted',reason:'current_and_projected_usage_fit',expected,sampledAt:snapshot.sampledAt};
}
module.exports={assess};

'use strict';
const fs=require('fs').promises,path=require('path');
const GGUF_SCALAR={0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:1,10:8,11:8,12:8},HEADER_BUDGET=64*1024**2;
// llama.cpp --cpu-moe가 CPU(mmap)에 두는 텐서와 같은 식(LLM_FFN_EXPS_REGEX). 안 걸리는 텐서는 GPU에 남으니 비전문가로 센다.
const EXPERT_TENSOR=/\.ffn_(up|down|gate)_(ch|)exps/;
// MoE 승인(model-admission의 'moe')에 쓸 전문가 가중치 바이트를 GGUF 헤더에서 잰다. 텐서 크기는 형식별 블록 표 대신
// 데이터 오프셋 차이로 구한다. expert_count는 첫 샤드에만 있으므로 나머지 샤드는 always로 텐서만 센다.
async function moeSplit(file,size,always=false){
  const h=await fs.open(file,'r');let buf=Buffer.alloc(0),base=0,pos=0;
  const need=async n=>{
    if(pos+n<=base+buf.length)return;
    if(pos+n>HEADER_BUDGET)throw new Error('GGUF header exceeds read budget');
    buf=buf.subarray(Math.min(buf.length,pos-base));base=pos;
    const more=Buffer.alloc(Math.max(n-buf.length,1<<20)),{bytesRead}=await h.read(more,0,more.length,base+buf.length);
    buf=Buffer.concat([buf,more.subarray(0,bytesRead)]);
    if(buf.length<n)throw new Error('Truncated GGUF header');
  };
  const u32=async()=>{await need(4);pos+=4;return buf.readUInt32LE(pos-4-base);};
  const u64=async()=>{await need(8);pos+=8;return Number(buf.readBigUInt64LE(pos-8-base));};
  const str=async()=>{const n=await u64();if(n>256){pos+=n;return '';}await need(n);pos+=n;return buf.toString('utf8',pos-n-base,pos-base);};
  const value=async type=>{
    if(type===8)return str();
    if(type===9){const t=await u32(),n=await u64();if(t===8||t===9)for(let i=0;i<n;i++)await value(t);else if(GGUF_SCALAR[t])pos+=n*GGUF_SCALAR[t];else throw new Error('Unknown GGUF array type');return null;}
    const bytes=GGUF_SCALAR[type];if(!bytes)throw new Error('Unknown GGUF value type');
    await need(bytes);pos+=bytes;return type===4?buf.readUInt32LE(pos-4-base):null;
  };
  try{
    if((await u32())!==0x46554747||(await u32())<2)throw new Error('Unsupported GGUF version');
    const tensors=await u64(),kvs=await u64(),kv={};
    for(let i=0;i<kvs;i++){const key=await str(),v=await value(await u32());if(v!=null)kv[key]=v;}
    const expertCount=kv[kv['general.architecture']+'.expert_count']||0;
    if(!expertCount&&!always)return {expertCount:0,expertBytes:0};
    try{
      const rows=[];
      for(let i=0;i<tensors;i++){const name=await str(),dims=await u32();pos+=8*dims;await u32();rows.push({name,offset:await u64()});}
      const align=kv['general.alignment']||32,data=size-Math.ceil(pos/align)*align;let expertBytes=0;
      rows.sort((a,b)=>a.offset-b.offset).forEach((r,i)=>{if(EXPERT_TENSOR.test(r.name))expertBytes+=(i+1<rows.length?rows[i+1].offset:data)-r.offset;});
      if(!(data>0)||expertBytes>data)throw new Error('Inconsistent GGUF tensor offsets');
      return {expertCount,expertBytes};
    }catch{return {expertCount,expertBytes:null};} // MoE인 건 알지만 비율을 모른다: 승인이 보수적으로 잡는다
  }finally{await h.close();}
}
async function moeOf(parts){
  const first=await moeSplit(parts[0].file,parts[0].size).catch(()=>null);
  if(!first?.expertCount)return null;
  let expertBytes=first.expertBytes;
  for(const p of parts.slice(1)){if(expertBytes==null)break;expertBytes+=(await moeSplit(p.file,p.size,true).catch(()=>({expertBytes:null}))).expertBytes??NaN;}
  return {expertCount:first.expertCount,expertBytes:Number.isFinite(expertBytes)?expertBytes:null};
}
const moeCache=new Map();
async function describe(file,id='configured-local') {
  const match=/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i.exec(path.basename(file));
  const count=match?Number(match[3]):1;
  if(count>32 || (match && Number(match[2])!==1))throw new Error('Select the first GGUF shard');
  let sizeBytes=0;const parts=[];
  for(let i=1;i<=count;i++){
    const part=match?path.join(path.dirname(file),match[1]+'-'+String(i).padStart(5,'0')+'-of-'+match[3]+'.gguf'):file;
    const stat=await fs.stat(part);
    if(!stat.isFile() || stat.size<1024)throw new Error('Local GGUF shard is missing or incomplete');
    const handle=await fs.open(part,'r');
    try{const b=Buffer.alloc(4);await handle.read(b,0,4,0);if(b.toString()!=='GGUF')throw new Error('Invalid local GGUF header');}
    finally{await handle.close();}
    sizeBytes+=stat.size;parts.push({file:part,size:stat.size,mtime:stat.mtimeMs});
  }
  // 비전 모델(PaddleOCR-VL 등)은 같은 폴더의 mmproj 없이 띄우면 이미지를 못 받는다. 입장 판정도 그 크기까지 센다.
  const mmproj=(await list(path.dirname(file))).find(n=>/mmproj.*\.gguf$/i.test(n));
  const mmprojPath=mmproj?path.join(path.dirname(file),mmproj):null;
  if(mmprojPath)sizeBytes+=(await fs.stat(mmprojPath)).size;
  // 카탈로그는 고를 때마다 다시 읽히므로 같은 파일(크기·시각)의 헤더는 한 번만 연다.
  const key=parts.map(p=>p.file+'|'+p.size+'|'+p.mtime).join(';');
  if(!moeCache.has(key)){if(moeCache.size>64)moeCache.clear();moeCache.set(key,await moeOf(parts));}
  const moe=moeCache.get(key);
  return {id,label:path.basename(file),sizeBytes,shards:count,modelPath:file,startup:true,loaded:false,...(moe?{moe}:{}),...(mmprojPath?{mmprojPath}:{})};
}
function hfHubRoot(){
  if(process.env.HF_HUB_CACHE)return process.env.HF_HUB_CACHE;
  return path.join(process.env.HF_HOME||path.join(require('os').homedir(),'.cache','huggingface'),'hub');
}
const list=async dir=>{try{return await fs.readdir(dir);}catch{return [];}};
// hf.exe로 이미 받아 둔 GGUF도 자동 준비 후보로 둔다. 다운로드는 하지 않고, 설정된 모델과 같은 파일은 빼고,
// 둘째 이후 샤드·비전 프로젝터(mmproj)는 모델이 아니므로 뺀다. 받다 만 파일은 describe가 걸러낸다.
async function cached({root=hfHubRoot(),exclude=[]}={}){
  const skip=new Set(exclude.filter(Boolean).map(p=>path.resolve(p).toLowerCase())),out=[];
  for(const repo of (await list(root)).filter(n=>n.startsWith('models--'))){
    for(const snap of await list(path.join(root,repo,'snapshots'))){
      for(const name of await list(path.join(root,repo,'snapshots',snap))){
        const shard=/-(\d{5})-of-\d{5}\.gguf$/i.exec(name);
        if(!/\.gguf$/i.test(name)||/mmproj/i.test(name)||(shard&&shard[1]!=='00001'))continue;
        const file=path.join(root,repo,'snapshots',snap,name);
        if(skip.has(path.resolve(file).toLowerCase()))continue;
        try{out.push(await describe(file,name.replace(/\.gguf$/i,'')));}catch{/* 불완전한 파일은 후보가 아니다 */}
      }
    }
  }
  return out;
}
module.exports={describe,cached,hfHubRoot};

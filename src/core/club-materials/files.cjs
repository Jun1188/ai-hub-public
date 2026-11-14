'use strict';
const {createHash}=require('node:crypto');
const {inflateSync,deflateSync,crc32}=require('node:zlib');
const MAX=4*1024*1024;
const sha=data=>createHash('sha256').update(data).digest('hex');
const signature=Buffer.from('89504e470d0a1a0a','hex');
function chunk(type,data){
  const out=Buffer.alloc(12+data.length);
  out.writeUInt32BE(data.length);out.write(type,4,4,'ascii');data.copy(out,8);
  out.writeUInt32BE(crc32(out.subarray(4,-4)),out.length-4);return out;
}
function normalizePng(bytes){
  if(!bytes.subarray(0,8).equals(signature))throw Error('bad_png');
  let pos=8, header, ended=false;
  const blocks=[];
  while(pos+12<=bytes.length){
    const size=bytes.readUInt32BE(pos), end=pos+12+size;
    if(end>bytes.length)throw Error('bad_png');
    const type=bytes.toString('ascii',pos+4,pos+8), data=bytes.subarray(pos+8,end-4);
    if(crc32(bytes.subarray(pos+4,end-4))!==bytes.readUInt32BE(end-4))throw Error('bad_png');
    if(!header&&type!=='IHDR')throw Error('bad_png');
    if(type==='IHDR'){
      if(header||size!==13||data[8]!==8||![2,6].includes(data[9])||data[10]||data[11]||data[12])throw Error('unsupported_png');
      header=data;
    }else if(type==='IDAT')blocks.push(data);
    else if(type==='IEND'){if(size||end!==bytes.length)throw Error('bad_png');ended=true;break;}
    else if(!/^[a-z]/.test(type))throw Error('unsupported_png');
    pos=end;
  }
  if(!header||!ended||!blocks.length)throw Error('bad_png');
  const width=header.readUInt32BE(0),height=header.readUInt32BE(4);
  if(!width||!height||width*height>2000000)throw Error('png_dimensions');
  const stride=1+width*(header[9]===2?3:4), pixels=inflateSync(Buffer.concat(blocks),{maxOutputLength:height*stride});
  if(pixels.length!==height*stride)throw Error('bad_png');
  for(let row=0;row<height;row++)if(pixels[row*stride]>4)throw Error('bad_png');
  return Buffer.concat([signature,chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
function inspect(raw,name){
  if(!raw.length||raw.length>MAX||typeof name!=='string'||/[\\/:\u0000-\u001f]/.test(name))throw Error('invalid_attachment');
  let bytes,ext;
  if(/\.png$/i.test(name)){ext='png';bytes=normalizePng(raw);}
  else if(/\.pdf$/i.test(name)){
    if(!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n)/.test(raw.subarray(0,16).toString('latin1'))||
      !/%%EOF[\t\r\n ]*$/.test(raw.subarray(-1024).toString('latin1')))throw Error('bad_pdf');
    ext='pdf';bytes=raw;
  }
  else if(/\.txt$/i.test(name)){
    const text=new TextDecoder('utf-8',{fatal:true}).decode(raw);
    if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))throw Error('bad_text');
    ext='txt';bytes=Buffer.from(text);
  }else throw Error('unsupported_attachment');
  if(!bytes.length||bytes.length>MAX)throw Error('invalid_attachment');
  return {name:'file.'+ext,sha256:sha(bytes),bytes:bytes.length,sourceSha256:sha(raw),sourceBytes:raw.length,data:bytes};
}
async function readAttachment(a,channelId,fetchCdn=fetch){
  if(!Number.isInteger(a.size)||a.size<1||a.size>MAX||!/^[0-9]{16,20}$/.test(a.id))throw Error('invalid_attachment');
  const u=new URL(a.url);
  const [,kind,owner,attachmentId,segment,...extra]=u.pathname.split('/');
  if(u.origin!=='https://cdn.discordapp.com'||u.username||u.password||u.hash||extra.length||attachmentId!==a.id)throw Error('bad_cdn');
  if(!(kind==='attachments'&&owner===channelId)&&!(kind==='ephemeral-attachments'&&/^\d{16,20}$/.test(owner)))throw Error('bad_cdn');
  if(!segment||segment.includes('/')||/[\\/\u0000]/.test(decodeURIComponent(segment)))throw Error('bad_cdn');
  // Public CDN fetch has its own request. Neither Discord bot nor GitHub credentials are attached.
  const res=await fetchCdn(u,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!res.ok||!res.body)throw Error('attachment_unavailable');
  const chunks=[];let length=0;
  for await(const part of res.body){
    length+=part.byteLength;if(length>a.size||length>MAX)throw Error('attachment_length');
    chunks.push(Buffer.from(part));
  }
  if(length!==a.size)throw Error('attachment_length');
  return inspect(Buffer.concat(chunks),a.name);
}
module.exports={MAX,sha,inspect,readAttachment};

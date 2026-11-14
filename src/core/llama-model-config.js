'use strict';
const fs=require('fs'),path=require('path');
async function select(modelFile) {
  if(typeof modelFile!=='string'||!path.isAbsolute(modelFile)||modelFile.startsWith('\\\\')||!modelFile.toLowerCase().endsWith('.gguf'))throw new Error('Existing local GGUF absolute path required');
  if(require('./model-control').busy()||require('./change-signals').busy('offload','aider').length)throw new Error('Wait for active offload/Aider/model operations');
  const file=await fs.promises.realpath(modelFile),stat=await fs.promises.stat(file);
  if(!stat.isFile()||stat.size<24)throw new Error('GGUF file missing or incomplete');
  const handle=await fs.promises.open(file,'r');
  try {const header=Buffer.alloc(4);await handle.read(header,0,4,0);if(header.toString('ascii')!=='GGUF')throw new Error('Invalid GGUF header');}finally{await handle.close();}
  require('./config').update({localRuntimes:{llamaModelPath:file}});
  return {configured:true,modelName:path.basename(file),sizeBytes:stat.size,scope:'device-only',started:false};
}
module.exports={select};

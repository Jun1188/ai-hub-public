'use strict';
const net = require('node:net');
// A local kernel lock is released automatically on process exit, including a crash.
async function acquireWriter() {
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({host:'127.0.0.1',port:47631,exclusive:true}, resolve);
  }).catch(err => { if(err.code==='EADDRINUSE') throw Error('material_writer_already_running'); throw err; });
  server.unref();
  return () => server.close();
}
module.exports={acquireWriter};

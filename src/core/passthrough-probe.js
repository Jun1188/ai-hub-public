'use strict';
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const protocol = require('./passthrough-contract');
let active = false;
function lines(socket, receive, fail) {
  let bytes = Buffer.alloc(0);
  socket.on('data', chunk => {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length > protocol.contract.maxFrameBytes * 4) { fail(new Error('bridge_buffer_limit')); socket.destroy(); return; }
    let end;
    while ((end = bytes.indexOf(10)) >= 0) {
      const line = bytes.subarray(0, end); bytes = bytes.subarray(end + 1);
      try { if (line.length > protocol.contract.maxFrameBytes) throw new Error('bridge_frame_size'); receive(JSON.parse(line.toString('utf8'))); }
      catch (error) { fail(error); socket.destroy(); return; }
    }
  });
  socket.on('error', fail);
}
async function run() {
  if (active) throw new Error('bridge_probe_active');
  active = true;
  const id = protocol.epoch(), endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\hub-passthrough-' + id : path.join(os.tmpdir(), 'hub-passthrough-' + id + '.sock');
  const childFile = path.join(require('./paths').appRoot(), 'scripts', 'fixtures', 'passthrough-guest.cjs');
  const checks = [], peers = new Set();
  let child, timer, server;
  try {
    return await new Promise((resolve, reject) => {
      let complete = false, currentEpoch = protocol.epoch(), receiver = protocol.receiver('guest', currentEpoch), phase = 'hello';
      const finish = (error, result) => { if (complete) return; complete = true; error ? reject(error) : resolve(result); };
      timer = setTimeout(() => finish(new Error('bridge_probe_timeout')), 10000);
      server = net.createServer(socket => {
        peers.add(socket); socket.on('close', () => peers.delete(socket));
        const send = value => socket.write(JSON.stringify(value) + '\n');
        send({ command: 'welcome', epoch: currentEpoch });
        lines(socket, frame => {
          if (phase === 'hello') {
            receiver.accept(frame); checks.push('version_units_ownership_handshake'); phase = 'state'; send({ command: 'state' });
          } else if (phase === 'state') {
            receiver.accept(frame); checks.push('guest_motion_state'); phase = 'owner'; send({ command: 'invalid-owner' });
          } else if (phase === 'owner') {
            try { receiver.accept(frame); throw new Error('probe_expected_ownership_rejection'); }
            catch (e) { if (e.message !== 'bridge_ownership_violation') throw e; }
            checks.push('ownership_rejected'); const priorEpoch = currentEpoch; currentEpoch = protocol.epoch(); receiver = protocol.receiver('guest', currentEpoch);
            phase = 'stale'; send({ command: 'restart', epoch: currentEpoch, priorEpoch });
          } else if (phase === 'stale') {
            try { receiver.accept(frame); throw new Error('probe_expected_epoch_rejection'); }
            catch (e) { if (e.message !== 'bridge_stale_epoch') throw e; }
            checks.push('previous_epoch_rejected'); phase = 'restart'; send({ command: 'reconnect' });
          } else if (phase === 'restart') {
            receiver.accept(frame); checks.push('restart_handshake'); phase = 'heartbeat'; send({ command: 'heartbeat' });
          } else if (phase === 'heartbeat') {
            receiver.accept(frame); checks.push('heartbeat_received');
            const observed = receiver.status();
            send({ command: 'done' });
            finish(null, { ok: true, schemaVersion: 1, transport: process.platform === 'win32' ? 'windows-native-named-pipe' : 'unix-local-socket',
              childProcess: true, gameInjection: false, checks, observed });
          }
        }, error => finish(error));
      });
      server.on('error', error => finish(error));
      server.listen(endpoint, () => {
        child = spawn(process.execPath, [childFile, endpoint], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
        child.on('error', error => finish(error));
        child.on('exit', code => { if (!complete) finish(new Error('bridge_guest_exited_' + code)); });
      });
    });
  } finally {
    clearTimeout(timer); for (const peer of peers) peer.destroy();
    if (child && child.exitCode === null) child.kill();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (process.platform !== 'win32') await fs.promises.unlink(endpoint).catch(e => { if (e.code !== 'ENOENT') throw e; });
    active = false;
  }
}
module.exports = { run, lines };

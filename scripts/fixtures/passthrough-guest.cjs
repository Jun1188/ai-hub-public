'use strict';
const net = require('net');
const protocol = require('../../src/core/passthrough-contract');
const endpoint = process.argv[2];
if (!endpoint || !(endpoint.startsWith('\\\\.\\pipe\\hub-passthrough-') || /hub-passthrough-[\w-]+\.sock$/.test(endpoint))) throw new Error('probe_endpoint_required');
let epoch, seq = 0;
const socket = net.connect(endpoint);
const send = frame => socket.write(JSON.stringify(frame) + '\n');
const frame = (kind, extra = {}) => ({ version: 1, epoch, role: 'guest', seq: ++seq, timeMs: protocol.nowMs(), kind, ...extra });
require('../../src/core/passthrough-probe').lines(socket, message => {
  if (message.command === 'welcome') { epoch = message.epoch; send(protocol.hello('guest', epoch)); }
  else if (message.command === 'state') send(frame('state', { topic: 'motion', position: [1, 2, 3] }));
  else if (message.command === 'invalid-owner') send(frame('state', { topic: 'world', position: [1, 2, 3] }));
  else if (message.command === 'restart') { send(frame('heartbeat')); epoch = message.epoch; seq = 0; }
  else if (message.command === 'reconnect') send(protocol.hello('guest', epoch));
  else if (message.command === 'heartbeat') send(frame('heartbeat'));
  else if (message.command === 'done') socket.end();
}, () => { socket.destroy(); process.exitCode = 1; });

'use strict';
const crypto = require('crypto');
const contract = require('./passthrough-contract.json');
const nowMs = () => Number(process.hrtime.bigint() / 1000000n);
const epoch = () => crypto.randomUUID();
function hello(role, sessionEpoch, seq = 0, timeMs = nowMs()) {
  return { version: contract.version, epoch: sessionEpoch, role, seq, timeMs, kind: 'hello',
    coordinates: contract.coordinates, time: contract.time, ownership: contract.ownership };
}
function receiver(peerRole, sessionEpoch, clock = nowMs) {
  if (!['host', 'guest'].includes(peerRole) || typeof sessionEpoch !== 'string') throw new Error('invalid_bridge_peer');
  let ready = false, lastSeq = -1, lastHeartbeat = null;
  function accept(frame) {
    if (!frame || Buffer.byteLength(JSON.stringify(frame)) > contract.maxFrameBytes) throw new Error('bridge_frame_size');
    if (frame.version !== contract.version) throw new Error('bridge_version_mismatch');
    if (frame.epoch !== sessionEpoch) throw new Error('bridge_stale_epoch');
    if (frame.role !== peerRole) throw new Error('bridge_peer_role_mismatch');
    if (!Number.isSafeInteger(frame.seq) || frame.seq <= lastSeq) throw new Error('bridge_stale_sequence');
    const now = clock();
    if (!Number.isFinite(frame.timeMs) || frame.timeMs < 0 || frame.timeMs > now + 200 || now - frame.timeMs > contract.heartbeatTimeoutMs) throw new Error('bridge_stale_time');
    if (frame.kind === 'hello') {
      for (const key of ['coordinates', 'time', 'ownership']) if (JSON.stringify(frame[key]) !== JSON.stringify(contract[key])) throw new Error('bridge_contract_mismatch');
      ready = true;
    } else {
      if (!ready || now - lastHeartbeat > contract.heartbeatTimeoutMs) throw new Error('bridge_handshake_required');
      if (frame.kind === 'state') {
        if (contract.ownership[frame.topic] !== peerRole) throw new Error('bridge_ownership_violation');
        if (!Array.isArray(frame.position) || frame.position.length !== 3 || frame.position.some(v => !Number.isFinite(v) || Math.abs(v) > 1e9)) throw new Error('bridge_invalid_coordinates');
      } else if (frame.kind !== 'heartbeat') throw new Error('bridge_invalid_kind');
    }
    lastSeq = frame.seq; lastHeartbeat = now;
    return { accepted: true, kind: frame.kind, seq: frame.seq, epoch: sessionEpoch };
  }
  return { accept, status: () => ({ ready, connected: ready && clock() - lastHeartbeat <= contract.heartbeatTimeoutMs,
    epoch: sessionEpoch, lastSeq, lastHeartbeat }) };
}
function toCanonical(position, { unitsPerMeter, axes }) {
  if (!Array.isArray(position) || position.length !== 3 || position.some(v => !Number.isFinite(v)) || !Number.isFinite(unitsPerMeter) || unitsPerMeter <= 0 ||
    !Array.isArray(axes) || axes.length !== 3 || axes.some(a => !/^-?[xyz]$/.test(a)) || new Set(axes.map(a => a.replace('-', ''))).size !== 3) throw new Error('bridge_coordinate_mapping_required');
  return axes.map(axis => position['xyz'.indexOf(axis.slice(-1))] * (axis[0] === '-' ? -1 : 1) / unitsPerMeter);
}
module.exports = { contract, hello, receiver, toCanonical, epoch, nowMs };

'use strict';

const crypto = require('crypto');
const path = require('path');
const { readJson, writeAtomic } = require('./atomic-file');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const ACTIONS = new Set(['check', 'apply', 'restart']);
const STATES = new Set(['prepared', 'checking', 'scheduled', 'exiting', 'complete', 'blocked']);
const TERMINAL_WORKER = new Set(['verified', 'blocked', 'failed', 'cancelled', 'rolled-back']);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
const safeError = code => Object.assign(new Error(code), { code });
const fingerprint = (action, commit) => crypto.createHash('sha256')
  .update(JSON.stringify([action, commit])).digest('hex');
const label = value => typeof value === 'string' && /^[a-z0-9_.+-]{1,80}$/i.test(value) ? value : null;

function create(options) {
  const { root, instanceId, authorized, busy, snapshot, check, arm, consent, quit, relaunch, delivery,
    schedule = fn => setTimeout(fn, 300) } = options || {};
  if (!root || !path.isAbsolute(root) || !label(instanceId) ||
      [authorized, busy, snapshot, check, arm, consent, quit, relaunch, schedule].some(fn => typeof fn !== 'function') ||
      (delivery !== undefined && typeof delivery !== 'function')) {
    throw safeError('invalid_configuration');
  }
  const activeFile = path.join(root, 'lifecycle-active.json');
  const receiptFile = id => path.join(root, 'lifecycle-requests', `${id}.json`);
  let inFlight = false;
  const isAuthorized = () => { try { return authorized() === true; } catch { return false; } };
  const isBusy = () => { try { return busy() !== false; } catch { return true; } };

  function state(saved) {
    let raw = saved;
    if (raw === undefined) {
      try { raw = snapshot(); } catch { throw safeError('snapshot_unavailable'); }
    }
    if (!raw || typeof raw !== 'object' || typeof raw.then === 'function') throw safeError('snapshot_unavailable');
    const source = raw.delivery;
    const delivery = source && typeof source === 'object' ? {
      id: UUID.test(source.id || '') ? source.id.toLowerCase() : null,
      commit: COMMIT.test(source.commit || '') ? source.commit.toLowerCase() : null,
      status: label(source.status), needsRecovery: source.needsRecovery === true
    } : null;
    return {
      version: label(raw.version), policy: ['standard', 'manual'].includes(raw.policy) ? raw.policy : 'invalid',
      approval: ['approved', 'disabled', 'blocked', 'not-checked'].includes(raw.approval) ? raw.approval : 'blocked',
      commit: COMMIT.test(raw.commit || '') ? raw.commit.toLowerCase() : null,
      status: label(raw.status), delivery
    };
  }

  async function load(id) {
    let record;
    try { record = await readJson(receiptFile(id), undefined); } catch { throw safeError('receipt_unavailable'); }
    if (record === undefined) return null;
    if (!record || record.schemaVersion !== 1 || record.requestId !== id || !label(record.instanceId) ||
        !ACTIONS.has(record.action) || !STATES.has(record.status) ||
        !(record.expectedCommit === null || COMMIT.test(record.expectedCommit || '')) ||
        (record.action === 'apply' && !record.expectedCommit) ||
        record.fingerprint !== fingerprint(record.action, record.expectedCommit) ||
        !(record.workerId === null || UUID.test(record.workerId || '')) ||
        typeof record.armAttempted !== 'boolean' || typeof record.needsRecovery !== 'boolean' ||
        !timestamp(record.createdAt) || !timestamp(record.updatedAt) ||
        (record.action !== 'apply' && (record.armAttempted || record.workerId !== null)) ||
        !(record.reason === null || label(record.reason))) throw safeError('receipt_invalid');
    return record;
  }

  async function active() {
    let marker;
    try { marker = await readJson(activeFile, undefined); } catch { throw safeError('active_unavailable'); }
    if (marker === undefined) return null;
    if (!marker || marker.schemaVersion !== 1 || !UUID.test(marker.requestId || '')) throw safeError('active_invalid');
    return marker.requestId.toLowerCase();
  }

  async function save(record, patch = {}) {
    const previous = await load(record.requestId);
    if (previous && (previous.fingerprint !== record.fingerprint || previous.instanceId !== instanceId)) {
      throw safeError('receipt_conflict');
    }
    const next = { ...record, ...patch, updatedAt: new Date().toISOString() };
    try { await writeAtomic(receiptFile(record.requestId), JSON.stringify(next, null, 2)); }
    catch { throw safeError('receipt_write_failed'); }
    Object.assign(record, next);
  }

  function workerReceipt(record) {
    if (!record.workerId) return null;
    if (!delivery) return state().delivery;
    let receipt;
    try { receipt = delivery(record.workerId); } catch { throw safeError('worker_receipt_unavailable'); }
    if (receipt && typeof receipt.then === 'function') throw safeError('worker_receipt_unavailable');
    return state({ delivery: receipt }).delivery;
  }

  function requireArmedWorker(record) {
    const worker = workerReceipt(record);
    if (!worker || worker.id !== record.workerId || worker.commit !== record.expectedCommit ||
        worker.status !== 'armed' || worker.needsRecovery) throw safeError('worker_not_armed');
  }

  function project(record) {
    const out = {
      available: true, requestId: record.requestId, action: record.action, expectedCommit: record.expectedCommit,
      workerId: record.workerId, status: record.status, reason: label(record.reason),
      needsRecovery: record.needsRecovery, needsAcceptance: false,
      createdAt: record.createdAt, updatedAt: record.updatedAt,
      summary: record.action === 'check' && record.summary ? state(record.summary) : null
    };
    if (record.action === 'apply' && record.armAttempted) {
      const delivery = workerReceipt(record);
      if (delivery && delivery.id === record.workerId && delivery.commit === record.expectedCommit) {
        if (delivery.needsRecovery || TERMINAL_WORKER.has(delivery.status)) {
          out.status = delivery.status === 'verified' && !delivery.needsRecovery ? 'worker-verified' : 'blocked';
          out.needsAcceptance = out.status === 'worker-verified';
          out.needsRecovery = delivery.needsRecovery;
          out.reason = out.needsAcceptance ? null : 'worker_blocked';
        } else if (record.instanceId !== instanceId) out.status = 'unknown';
      } else if (record.instanceId !== instanceId) out.status = 'unknown';
    } else if (record.instanceId !== instanceId && !['complete', 'blocked'].includes(record.status)) {
      out.status = record.action === 'restart' && record.status === 'exiting' ? 'restart-observed' : 'interrupted';
      out.needsAcceptance = out.status === 'restart-observed';
    }
    return out;
  }

  function resolved(record) {
    const view = project(record);
    // The old instance cannot run its pending callback. Never release an attempted worker.
    if (view.status === 'interrupted' && record.instanceId !== instanceId && !record.needsRecovery &&
        !record.armAttempted && record.workerId === null && (record.status === 'prepared' ||
        (record.action === 'check' && record.status === 'checking') ||
        (record.action === 'restart' && record.status === 'scheduled'))) return true;
    if (record.armAttempted) {
      const delivery = workerReceipt(record);
      return !!delivery && delivery.id === record.workerId && delivery.commit === record.expectedCommit &&
        TERMINAL_WORKER.has(delivery.status) && !delivery.needsRecovery;
    }
    return ['complete', 'blocked', 'restart-observed'].includes(view.status);
  }

  function preflight(record) {
    if (!isAuthorized()) throw safeError('unauthorized');
    const current = state();
    if (record.action !== 'restart' && current.approval !== 'approved') throw safeError('approval_required');
    if (isBusy()) throw safeError('app_busy');
    if (current.delivery && (current.delivery.needsRecovery ||
        !TERMINAL_WORKER.has(current.delivery.status))) throw safeError('worker_pending');
    if (record.action === 'apply') {
      if (!['standard', 'manual'].includes(current.policy)) throw safeError('update_policy_invalid');
      if (current.commit !== record.expectedCommit) throw safeError('commit_changed');
    }
  }

  async function block(record, reason) {
    let uncertain = record.armAttempted && !record.workerId;
    if (record.workerId) {
      try { await consent(record.workerId, record.expectedCommit, false); }
      catch { uncertain = true; reason = 'cancel_unconfirmed'; }
    }
    await save(record, { status: 'blocked', reason, needsRecovery: uncertain });
    return project(record);
  }

  async function finish(record) {
    try {
      if (!isAuthorized() || isBusy()) return await block(record, 'exit_blocked');
      await save(record, { status: 'exiting' });
      if (record.action === 'apply') {
        requireArmedWorker(record);
        await consent(record.workerId, record.expectedCommit, true);
      }
      if (!isAuthorized() || isBusy()) return await block(record, 'exit_blocked');
      if (record.action === 'apply') {
        requireArmedWorker(record);
        quit();
      }
      else relaunch();
    } catch {
      try { await block(record, 'exit_failed'); } catch { /* Keep the unresolved reservation on storage failure. */ }
    }
  }

  async function request(args = {}) {
    if (inFlight) throw safeError('request_pending');
    inFlight = true;
    let record;
    try {
      if (!isAuthorized()) throw safeError('unauthorized');
      const id = typeof args.request_id === 'string' ? args.request_id.toLowerCase() : '';
      const commit = typeof args.expected_commit === 'string' ? args.expected_commit.toLowerCase() : null;
      if (!UUID.test(id) || !ACTIONS.has(args.action) || args.confirmed !== true ||
          (args.expected_commit != null && !COMMIT.test(commit || '')) ||
          (args.action === 'apply' && !commit)) throw safeError('invalid_request');
      const existing = await load(id);
      if (existing) {
        if (existing.fingerprint !== fingerprint(args.action, commit)) throw safeError('request_id_conflict');
        return project(existing);
      }
      const activeId = await active();
      if (activeId) {
        const previous = await load(activeId);
        if (!previous || !resolved(previous)) throw safeError('request_pending');
      }
      record = {
        schemaVersion: 1, requestId: id, instanceId, action: args.action, expectedCommit: commit,
        fingerprint: fingerprint(args.action, commit), status: 'prepared', reason: null,
        workerId: null, armAttempted: false, needsRecovery: false, createdAt: new Date().toISOString()
      };
      await save(record);
      try { await writeAtomic(activeFile, JSON.stringify({ schemaVersion: 1, requestId: id })); }
      catch { throw safeError('active_write_failed'); }
      preflight(record);
      if (record.action === 'check') {
        await save(record, { status: 'checking' });
        await check();
        await save(record, { status: 'complete', summary: state() });
      } else {
        if (record.action === 'apply') {
          await check(record.expectedCommit);
          preflight(record);
          if (state().status !== 'pending') throw safeError('no_pending_update');
          await save(record, { armAttempted: true });
          try { preflight(record); }
          catch (error) { record.armAttempted = false; throw error; }
          const worker = await arm(record.expectedCommit);
          if (worker && UUID.test(worker.id || '')) record.workerId = worker.id.toLowerCase();
          if (!record.workerId || worker.status !== 'armed') throw safeError('arm_unconfirmed');
        }
        await save(record, { status: 'scheduled' });
        schedule(() => { void finish(record); });
      }
      return project(record);
    } catch (error) {
      if (record) return await block(record, label(error && error.code) || 'operation_failed');
      throw safeError(label(error && error.code) || 'operation_failed');
    } finally { inFlight = false; }
  }

  return {
    async status() {
      const current = state();
      const id = isAuthorized() ? await active() : null;
      const record = id ? await load(id) : null;
      return { available: true, authorized: isAuthorized(), busy: isBusy(), ...current,
        active: record ? project(record) : null, unresolved: !!id && (!record || !resolved(record)) };
    },
    request,
    async result(id) {
      if (!isAuthorized()) throw safeError('unauthorized');
      if (typeof id !== 'string' || !UUID.test(id)) throw safeError('invalid_request');
      const record = await load(id.toLowerCase());
      return record ? project(record) : { available: true, status: 'not-found' };
    }
  };
}

let configured = null;
const unavailable = () => ({ available: false, status: 'unavailable', reason: 'electron_unavailable' });
module.exports = {
  create,
  configure(options) {
    if (configured) throw safeError('already_configured');
    configured = create(options);
    return configured;
  },
  status: () => configured ? configured.status() : Promise.resolve(unavailable()),
  request: args => configured ? configured.request(args) : Promise.resolve(unavailable()),
  result: id => configured ? configured.result(id) : Promise.resolve(unavailable())
};

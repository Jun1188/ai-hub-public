'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const MIB = 1024 ** 2, GIB = 1024 ** 3;
function assessWorker({ snapshot, environment, agent, now = Date.now(), expectedRamBytes, resourceProfile = {}, policy = {} }) {
  const local = ['local', 'aider'].includes(agent);
  const expected = { ramBytes: resourceProfile.ramBytes ?? expectedRamBytes ?? 512 * MIB,
    vramBytes: resourceProfile.vramBytes ?? 0, cpuCores: resourceProfile.cpuCores ?? 1,
    basis: resourceProfile.ramBytes != null ? 'declared-worker-resource-profile' : 'conservative-worker-process-budget', verified: false };
  const result = { schema: 'delegation-diagnostic/1', sampledAt: snapshot?.sampledAt || null,
    environmentAt: environment?.at || null, agent, expected,
    scenario: agent === 'remote-static' ? 'local-static-analysis' : local ? 'local-pending-model-admission' : 'selected-cli',
    measurements: { cpuPercent: snapshot?.cpu?.usagePercent ?? null, ramTotalBytes: snapshot?.ram?.totalBytes ?? null,
      ramUsedBytes: snapshot?.ram?.usedBytes ?? null, gpu: snapshot?.gpu?.devices || [], storage: snapshot?.storage || null,
      onAcPower: environment?.onAcPower ?? null, heavyApps: environment?.heavyApps || [], activeLocal: environment?.slot?.active ?? null },
    admitted: true, reason: 'current_and_projected_worker_usage_fit' };
  const deny = reason => ({ ...result, admitted: false, scenario: 'defer', reason });
  if (![expected.ramBytes, expected.vramBytes, expected.cpuCores].every(x => Number.isFinite(x) && x >= 0)) return deny('invalid_worker_resource_profile');
  if (!snapshot || !Number.isFinite(snapshot.sampledAt) || now - snapshot.sampledAt > 10000 || snapshot.sampledAt > now + 1000) return deny('resource_sample_stale');
  if (!Number.isFinite(snapshot.cpu?.usagePercent) || snapshot.cpu.usagePercent < 0 || snapshot.cpu.usagePercent > 100) return deny('cpu_sample_unavailable');
  const total = snapshot.ram?.totalBytes, used = snapshot.ram?.usedBytes;
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(used) || used < 0 || used > total) return deny('ram_sample_unavailable');
  if (used + expected.ramBytes + 3 * GIB > total || (used + expected.ramBytes) / total > 0.9) return deny('projected_worker_ram_exceeds_budget');
  if (snapshot.cpu.usagePercent > (local ? 85 : 95)) return deny('cpu_busy');
  if (expected.cpuCores > (snapshot.cpu.logicalCores || require('os').cpus().length)) return deny('worker_cpu_cores_exceed_machine');
  if (expected.vramBytes) {
    const adm = policy.admission || {}, vram = policy.vram || {};
    const maxBusy = 100 * (adm.maxGpuUtilForBackground ?? 0.35), reserve = Math.max(768 * MIB, Number(vram.reserveBytes) || 0);
    const fits = (snapshot.gpu?.devices || []).some(g => {
      const busy = Number.isFinite(g.busyPercent) ? g.busyPercent : g.usagePercent;
      return Number.isFinite(g.totalMiB) && Number.isFinite(g.usedMiB) && Number.isFinite(busy) && busy <= maxBusy &&
        (g.totalMiB - g.usedMiB) * MIB >= expected.vramBytes + reserve;
    });
    if (!fits) return deny('projected_worker_vram_exceeds_budget');
  }
  if (!environment || !Number.isFinite(environment.at) || now - environment.at > 15000 || environment.at > now + 1000 ||
    environment.failures || environment.retryAt > now || !Array.isArray(environment.heavyApps)) return deny('environment_probe_unavailable');
  return result;
}
function createDiagnostics(options = {}) {
  const monitor = options.monitor || require('./resource-monitor'), hw = options.hardware || require('./hardware-optimizer');
  const telemetry = options.telemetry === undefined ? require('./telemetry') : options.telemetry;
  const now = options.now || Date.now, records = new Map(), timers = new Map();
  const directory = options.directory || path.join(require('./paths').hubDataDir(), 'delegation-diagnostics.local');
  function observe(result, snapshot) {
    if (!snapshot) return;
    const sample = { sampledAt: snapshot.sampledAt, ramUsedBytes: snapshot.ram?.usedBytes ?? null, cpuPercent: snapshot.cpu?.usagePercent ?? null,
      vramUsedBytes: (snapshot.gpu?.devices || []).reduce((sum, g) => sum + (g.usedMiB || 0) * MIB, 0) };
    result.observed = { samples: (result.observed?.samples || 0) + 1,
      peakRamBytes: Math.max(result.observed?.peakRamBytes || 0, sample.ramUsedBytes || 0),
      peakVramBytes: Math.max(result.observed?.peakVramBytes || 0, sample.vramUsedBytes),
      maxCpuPercent: Math.max(result.observed?.maxCpuPercent || 0, sample.cpuPercent || 0), last: sample };
  }
  async function capture(node, session = {}, signal) {
    signal?.throwIfAborted(); await hw.refresh();
    let snapshot = await monitor.snapshot({ force: true });
    if (snapshot.cpu?.usagePercent == null) { await new Promise(resolve => setTimeout(resolve, 150)); snapshot = await monitor.snapshot({ force: true }); }
    signal?.throwIfAborted();
    const environment = hw.status();
    const result = assessWorker({ snapshot, environment, agent: node.agent, resourceProfile: node.resourceProfile, now: now(),
      policy: typeof hw.policy === 'function' ? hw.policy() : {} });
    result.id = crypto.randomUUID(); result.jobId = `${session.id || 'direct'}/${node.id || 'node'}`.slice(0, 160);
    result.model = String(node.model || '').slice(0, 512); result.startedAt = now();
    if (result.admitted && telemetry) telemetry.beginJob(result.id, { kind: node.agent || 'job', label: result.jobId });
    Object.defineProperties(result, { snapshot: { value: snapshot }, environment: { value: environment } });
    node.hardwareDiagnostic = result;
    records.set(result.id, result); while (records.size > 200) records.delete(records.keys().next().value);
    observe(result, snapshot); persist(result);
    if (!result.admitted) { const error = new Error(`Delegation deferred: ${result.reason}`); error.code = 'HARDWARE_DEFERRED'; error.diagnosticId = result.id; throw error; }
    if (!options.manual) {
      const timer = setInterval(() => monitor.snapshot({ force: true }).then(sample => observe(result, sample)).catch(() => {}), 5000);
      timer.unref(); timers.set(result.id, timer);
    }
    return result;
  }
  function persist(result) {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'last.json'), temp = `${file}.${process.pid}.${result.id}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(result), 'utf8'); fs.renameSync(temp, file);
  }
  function select(result, trace) {
    if (!result) return;
    result.scenario = trace.scenario; result.selected = trace.selected; result.expected = trace.expected || result.expected;
    result.selectionAt = now(); persist(result);
  }
  function finish(result, outcome) {
    if (!result) return;
    clearInterval(timers.get(result.id)); timers.delete(result.id);
    result.finishedAt = now(); result.elapsedMs = result.finishedAt - result.startedAt; result.outcome = outcome;
    observe(result, monitor.peek?.());
    // observed.* are machine totals; processUsage is the job's own process tree when its pids were tracked.
    if (telemetry) result.processUsage = telemetry.endJob(result.id, outcome);
    persist(result);
  }
  /** Attribute a spawned worker process (and its children) to this diagnostic's job. */
  function trackPid(result, pid) { if (result && telemetry) telemetry.trackProcess(pid, { jobId: result.id, kind: result.agent, label: result.jobId }); }
  return { capture, finish, select, trackPid, list: () => [...records.values()].map(r => JSON.parse(JSON.stringify(r))),
    dispose: () => { for (const timer of timers.values()) clearInterval(timer); timers.clear(); } };
}
let singleton;
const instance = () => singleton || (singleton = createDiagnostics());
module.exports = { assessWorker, createDiagnostics, instance };

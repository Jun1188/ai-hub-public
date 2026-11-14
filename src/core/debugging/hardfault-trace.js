// Debugging: what backed the hard faults of a paging episode. The telemetry counters say which process faulted, not
// what it read back in; that needs a kernel trace, which only an elevated shell may record. The user records one and
// turns it into text (scripts/analyze-hardfaults.js); this module only reads that text. Nothing here starts a trace.
//
//   xperf -on PROC_THREAD+LOADER+HARD_FAULTS   →  reproduce  →  xperf -d hf.etl  →  xperf -i hf.etl -o hf.txt -a dumper
//
// The dumper prints one header line per event type (name, then column names) before the events. Columns are found by
// that header, so a WPT build that adds or reorders columns still parses; a build without a column reports it as missing.
'use strict';

const cells = (line) => line.split(',').map((c) => c.trim());
const IMAGE = /\.(exe|dll|sys|node|ocx|cpl|drv|scr|efi|mui|pyd|winmd)$/i;
const PAGEFILE = /(^|\\)(pagefile|swapfile)\.sys$/i;

/** Pure: which kind of file a fault was read from. `basis` is the file name; a DLL mapped as data still reads as image. */
function sourceOf(file) {
  const name = String(file || '').replace(/^"|"$/g, '').trim();
  if (!name || /^unknown$/i.test(name)) return 'unknown';
  if (PAGEFILE.test(name)) return 'pagefile';
  return IMAGE.test(name) ? 'image' : 'mapped';
}

/** "chrome.exe (1234)" → { name, pid }. */
function processOf(text) {
  const m = /^(.*?)\s*\(\s*(\d+)\s*\)$/.exec(String(text || ''));
  return m ? { name: m[1].trim() || null, pid: Number(m[2]) } : { name: String(text || '').trim() || null, pid: null };
}

/** Pure: dumper text → { faults, starts, missing }. `missing` lists expected columns this dump does not have. */
function parse(text) {
  // A pid names one process only until it exits: each P-Start opens a new instance of that pid, and the faults that
  // follow belong to it (the dump is in time order). Faults before any start event of a pid stay 'pid-only'.
  const head = {}, faults = [], starts = new Map(), instance = new Map();
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  for (const line of String(text).split(/\r?\n/)) {
    const c = cells(line), type = c[0];
    if (type !== 'HardFault' && type !== 'P-Start' && type !== 'P-DCStart') continue;
    if (c[1] === 'TimeStamp') { head[type] = c; continue; } // the header row of this event type
    const h = head[type];
    if (!h) continue;
    const at = (...names) => { const i = h.findIndex((n) => names.includes(n)); return i < 0 ? undefined : c[i]; };
    const p = processOf(at('Process Name ( PID)'));
    if (type === 'HardFault') {
      // File names may contain commas: the name is the last column, so it takes the rest of the line.
      const fi = h.indexOf('FileName');
      faults.push({ t: num(at('TimeStamp')), ...p, key: `${p.pid ?? p.name}#${instance.get(p.pid) || 0}`, bytes: num(at('IOSize')), ioUs: num(at('ElapsedTime', 'IOTime')),
        file: fi < 0 ? null : line.split(',').slice(fi).join(',').trim().replace(/^"|"$/g, '') || null });
    } else if (p.pid !== null) {
      // P-DCStart lists processes already running when the trace began; both give the identity the pid alone lacks.
      // A rundown line for a pid that already has an instance (the end-of-trace rundown repeats them) opens nothing.
      if (type === 'P-DCStart' && instance.has(p.pid)) continue;
      instance.set(p.pid, (instance.get(p.pid) || 0) + 1);
      starts.set(`${p.pid}#${instance.get(p.pid)}`, { name: p.name, startUs: type === 'P-Start' ? num(at('TimeStamp')) : null, runningAtStart: type === 'P-DCStart' });
    }
  }
  const missing = !head.HardFault ? ['HardFault'] : ['Process Name ( PID)', 'IOSize', 'FileName'].filter((n) => !head.HardFault.includes(n))
    .concat(head.HardFault.some((n) => n === 'ElapsedTime' || n === 'IOTime') ? [] : ['ElapsedTime']);
  return { faults, starts, missing };
}

/** Pure: totals per process instance split by backing source, heaviest first. Bytes and I/O time are null when the dump lacks them. */
function summarize({ faults, starts, missing }, { top = 8, files = 3 } = {}) {
  const per = new Map();
  for (const f of faults) {
    const key = f.key;
    const row = per.get(key) || { key, pid: f.pid, name: f.name, faults: 0, bytes: 0, ioMs: 0, sources: {}, files: new Map() };
    const source = sourceOf(f.file);
    const s = row.sources[source] || (row.sources[source] = { faults: 0, bytes: 0 });
    row.faults++; s.faults++;
    row.bytes += f.bytes || 0; s.bytes += f.bytes || 0; row.ioMs += (f.ioUs || 0) / 1000;
    if (f.file) row.files.set(f.file, (row.files.get(f.file) || 0) + (f.bytes || 1));
    per.set(key, row);
  }
  const noBytes = missing.includes('IOSize'), noTime = missing.includes('ElapsedTime');
  const pids = new Map();
  for (const r of per.values()) pids.set(r.pid, (pids.get(r.pid) || 0) + 1);
  const total = { faults: faults.length, bytes: noBytes ? null : faults.reduce((a, f) => a + (f.bytes || 0), 0), sources: {} };
  for (const f of faults) total.sources[sourceOf(f.file)] = (total.sources[sourceOf(f.file)] || 0) + 1;
  const processes = [...per.values()].sort((a, b) => (b.bytes - a.bytes) || (b.faults - a.faults)).slice(0, top).map((r) => {
    const id = starts.get(r.key);
    return { pid: r.pid, name: r.name,
      // pid + start time names one process; a pid alone can be reused, and a process that began before the trace has no start event time.
      identity: id ? (id.runningAtStart ? 'running-before-trace' : 'started-in-trace') : 'pid-only', startUs: id?.startUs ?? null,
      pidReused: pids.get(r.pid) > 1, // the same pid named more than one process in this trace: rows are per instance
      faults: r.faults, bytes: noBytes ? null : r.bytes, ioMs: noTime ? null : Math.round(r.ioMs * 10) / 10, sources: r.sources,
      dominant: Object.entries(r.sources).sort((a, b) => (b[1].bytes - a[1].bytes) || (b[1].faults - a[1].faults))[0][0],
      topFiles: [...r.files].sort((a, b) => b[1] - a[1]).slice(0, files).map(([file]) => ({ file, source: sourceOf(file) })) };
  });
  return { basis: 'xperf-dumper', classifiedBy: 'file-name', missing, total, processes };
}

const analyze = (text, options) => summarize(parse(text), options);

module.exports = { parse, summarize, analyze, sourceOf };

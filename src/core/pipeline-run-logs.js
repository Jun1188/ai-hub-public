// Pipeline run logs: one file per step (logs/<runId>/<step>.log), bounded tail reads, and the GUI live log
// (chunks merged per step+stream and flushed every LOG_FLUSH_MS). Moved out of pipeline.js, which owns run state.
'use strict';

const fs = require('fs');
const path = require('path');

const LOG_FLUSH_MS = 30;
/** cap for readLog — Unity/UAT logs can reach hundreds of MB */
const MAX_LOG_READ_BYTES = 2 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A step whose log file failed keeps this in fileStreams: later chunks still reach the GUI, and run cleanup ends it like a stream.
const DROPPED = { write() {}, end() {} };

/** root: logs folder · emit(channel, payload): GUI stream · onChunk(runId, chunk): graph step output capture · onWarning(runId, text): record why */
function createRunLogs({ root, emit, onChunk, onWarning = () => {} }) {
  function logDir(runId) {
    return path.join(root, runId);
  }

  function readLog(runId, stepIndex) {
    // caller input is untrusted — never join it into a path unchecked
    if (!UUID_RE.test(runId)) throw new Error(`잘못된 runId입니다: ${runId}`);
    stepIndex = Number(stepIndex);
    if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 999) {
      throw new Error(`잘못된 stepIndex입니다: ${stepIndex}`);
    }
    const file = path.join(logDir(runId), `${stepIndex}.log`);
    if (!fs.existsSync(file)) return '';
    const size = fs.statSync(file).size;
    if (size <= MAX_LOG_READ_BYTES) return fs.readFileSync(file, 'utf8');
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(MAX_LOG_READ_BYTES);
      fs.readSync(fd, buf, 0, MAX_LOG_READ_BYTES, size - MAX_LOG_READ_BYTES);
      return `[hub] 로그가 커서 마지막 ${Math.round(MAX_LOG_READ_BYTES / 1024 / 1024)}MB만 표시합니다\r\n` + buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  // ---- log buffering (merge chunks, flush every LOG_FLUSH_MS) --------------

  const logBuffers = new Map(); // runId -> { entries, timer }
  const fileStreams = new Map(); // `${runId}:${stepIndex}` -> WriteStream

  async function readStepInput(runId, stepIndex) {
    const writer = fileStreams.get(`${runId}:${stepIndex}`);
    if (writer === DROPPED) throw new Error('이전 단계의 로그 파일을 기록하지 못했습니다.');
    // Write callbacks run in order. Wait for earlier chunks without closing a stream owned by the run.
    if (writer) await new Promise((resolve, reject) => writer.write('', error => error ? reject(error) : resolve()));
    return readLog(runId, stepIndex);
  }

  // A log file failure (EACCES, ENOSPC) is a warning, not a step failure: the run keeps going and the GUI still shows the output.
  // Without an 'error' listener the WriteStream error would be uncaught and take down the Electron main process.
  function logFailed(runId, stepIndex, key, e) {
    if (fileStreams.get(key) === DROPPED) return;
    fileStreams.set(key, DROPPED);
    const reason = `${e.code || 'error'} ${String(e.message || e)}`.slice(0, 200);
    onWarning(runId, `step ${stepIndex} log file not written: ${reason}`);
    queue(runId, stepIndex, `\r\n[hub] 로그 파일 쓰기 실패 — 실행은 계속하고 화면에만 표시합니다 (${reason})\r\n`, 'stderr');
  }

  function appendLog(runId, stepIndex, chunk, stream) {
    onChunk(runId, chunk);
    const key = `${runId}:${stepIndex}`;
    try {
      let ws = fileStreams.get(key);
      if (!ws) {
        const dir = logDir(runId);
        fs.mkdirSync(dir, { recursive: true });
        ws = fs.createWriteStream(path.join(dir, `${stepIndex}.log`), { flags: 'a' });
        ws.on('error', (e) => logFailed(runId, stepIndex, key, e));
        fileStreams.set(key, ws);
      }
      ws.write(chunk);
    } catch (e) { logFailed(runId, stepIndex, key, e); }
    queue(runId, stepIndex, chunk, stream);
  }

  function queue(runId, stepIndex, chunk, stream) {
    let buf = logBuffers.get(runId);
    if (!buf) {
      buf = { entries: [] };
      logBuffers.set(runId, buf);
    }
    buf.entries.push({ stepIndex, chunk, stream });
    if (!buf.timer) buf.timer = setTimeout(() => flushLogBuffer(runId), LOG_FLUSH_MS);
  }

  function flushLogBuffer(runId) {
    const buf = logBuffers.get(runId);
    if (!buf) return;
    if (buf.timer) {
      clearTimeout(buf.timer);
      buf.timer = undefined;
    }
    // merge consecutive chunks of same step+stream to reduce IPC messages
    const merged = [];
    for (const e of buf.entries) {
      const last = merged[merged.length - 1];
      if (last && last.stepIndex === e.stepIndex && last.stream === e.stream) last.chunk += e.chunk;
      else merged.push({ ...e });
    }
    for (const entry of merged) emit('pipeline:log', { runId, ...entry });
    buf.entries = [];
  }

  return { logDir, readLog, readStepInput, appendLog, flushLogBuffer, logBuffers, fileStreams };
}

module.exports = { createRunLogs, UUID_RE };

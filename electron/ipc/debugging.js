// IPC: debugging tab — render-stage monitor, single-process inspection and frame-capture analysis (src/core/debugging/).
// All take seconds or minutes, so they answer {started:true} at once and deliver the result on a *Done event.
'use strict';
const { dialog } = require('electron');
const renderMonitor = require('../../src/core/debugging/render-monitor');
const processInspect = require('../../src/core/debugging/process-inspect');
const frameCapture = require('../../src/core/debugging/frame-capture');

const pidOf = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const clamp = (v, lo, hi, dflt) => Math.max(lo, Math.min(hi, Number(v) || dflt));
function optionalStart(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) throw new Error('프로세스 생성 시각이 잘못되었습니다.');
  return value;
}

/** @param {import('./register-handlers').IpcContext} ctx */
function register(ctx) {
  const { handle, send, window } = ctx;
  handle('dbg:rsiRuns', () => require('../../src/core/rsi/run-diagnostics').list());
  const background = (work, done) => {
    work().then(done, (e) => done({ error: e.message }));
    return { started: true };
  };
  handle('dbg:render', (pid, seconds, start) => background(() => renderMonitor.monitor({ pid: pidOf(pid), seconds: clamp(seconds, 5, 60, 15), expectedStart: optionalStart(start) }),
    (r) => send('dbg:renderDone', r)));
  handle('dbg:inspect', (pid, seconds, start) => {
    if (!pidOf(pid)) throw new Error('PID를 입력하세요.');
    return background(() => processInspect.inspect({ pid: pidOf(pid), seconds: clamp(seconds, 2, 30, 5), expectedStart: optionalStart(start) }), (r) => send('dbg:inspectDone', r));
  });
  handle('dbg:pickCapture', async () => {
    const res = await dialog.showOpenDialog(window(), { title: '분석할 RenderDoc 캡처', properties: ['openFile'], filters: [{ name: 'RenderDoc capture / XML export', extensions: ['rdc', 'xml'] }] });
    return res.canceled ? '' : res.filePaths[0];
  });
  handle('dbg:capture', (file) => background(() => frameCapture.analyze({ path: file }), (r) => send('dbg:captureDone', r)));
}

module.exports = { register };

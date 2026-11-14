'use strict';
// 웹 샌드박스 computer use(web:sandbox)와 경로 실행기 연결. 실제 Electron 창은 띄우지 않는다(openPage 주입).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-websb-'));
let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); } }

const sb = require('../src/core/toolroute/web-sandbox');
const executor = require('../src/core/toolroute/route-executor');
const table = require('../src/core/toolroute/route-table');

/** 가짜 페이지: 요청한 동작과 허용 판정을 기록한다. */
function fakePage(log, { elements = {}, text = 'hello', redirectTo = null } = {}) {
  return async ({ partition, allow, onBlocked }) => {
    log.partition = partition;
    let url = 'about:blank';
    return {
      load: async (u) => {
        if (redirectTo && !allow(redirectTo)) { onBlocked(redirectTo); throw Object.assign(new Error('ERR_BLOCKED_BY_CLIENT'), { code: 'ERR_BLOCKED_BY_CLIENT' }); }
        url = u; log.push(['load', u]);
      },
      capture: async () => ({ png: Buffer.from([0x89, 0x50, 0x4e, 0x47]), width: 1280, height: 800 }),
      eval: async (js) => {
        if (js.includes('innerText')) return text;
        const sel = Object.keys(elements).find((s) => js.includes(JSON.stringify(s)));
        if (js.includes('getBoundingClientRect')) return sel ? { ...elements[sel], tag: 'button' } : null;
        return Boolean(sel); // focus
      },
      mouseClick: (x, y) => log.push(['click', x, y]),
      insertText: (t) => log.push(['type', t]),
      key: (k) => log.push(['key', k]),
      url: () => url,
      close: async () => { log.closed = true; },
    };
  };
}

(async () => {
  const deps = { dataDir: scratch, config: { load: () => ({ computerUse: { allowedOrigins: ['https://docs.example.com', 'http://plain.example.com', 'file:///c:/x'] } }) } };

  await check('origins: loopback yes, configured https yes, others and file: no', () => {
    const extra = ['https://docs.example.com'];
    assert(sb.originAllowed('http://127.0.0.1:8188/x', extra) && sb.originAllowed('http://localhost:3000', extra) && sb.originAllowed('http://[::1]:5173/', extra));
    assert(sb.originAllowed('https://docs.example.com/page', extra));
    assert(!sb.originAllowed('https://evil.example.com', extra) && !sb.originAllowed('file:///C:/Windows/win.ini', extra) && !sb.originAllowed('http://127.0.0.1.evil.com', extra));
    assert(sb.originAllowed('data:image/png;base64,AA', extra)); // 페이지 안 자원
  });
  await check('validate: every bad step reported at once', () => {
    assert.throws(() => sb.validate([{ action: 'navigate' }, { action: 'click' }, { action: 'key', key: 'F13' }, { action: 'rm' }]), (e) => e.code === 'web_bad_steps' && /url/.test(e.message) && /selector/.test(e.message) && /key/.test(e.message) && /action/.test(e.message));
    assert.throws(() => sb.validate(Array.from({ length: 21 }, () => ({ action: 'text' }))), /at most 20/);
  });
  await check('confirmation: read-only runs freely, input needs confirmed', async () => {
    const log = [];
    const r = await sb.run({ steps: [{ action: 'click', selector: '#go' }] }, { ...deps, openPage: fakePage(log) });
    assert.strictEqual(r.needsConfirmation, true); assert.strictEqual(log.length, 0);
  });
  await check('origin refused before any window opens; only https configured origins count', async () => {
    let opened = false;
    const r = await sb.run({ steps: [{ action: 'navigate', url: 'http://plain.example.com/' }] }, { ...deps, openPage: async () => { opened = true; } });
    assert.strictEqual(r.ok, false); assert.deepStrictEqual(r.data.refused, ['http://plain.example.com/']); assert(!opened);
    assert.deepStrictEqual(r.data.allowed, ['loopback', 'https://docs.example.com']);
  });

  const log = [];
  const res = await sb.run({ confirmed: true, steps: [
    { action: 'navigate', url: 'http://127.0.0.1:9/form' }, { action: 'type', selector: '#name', text: 'hub' },
    { action: 'click', selector: '#go' }, { action: 'key', key: 'Enter' }, { action: 'text' }, { action: 'screenshot' },
  ] }, { ...deps, openPage: fakePage(log, { elements: { '#name': { x: 10, y: 20 }, '#go': { x: 40, y: 50 } }, text: 'token sk-' + 'a'.repeat(40) + ' done' }) });
  await check('run: real input sequence (type → click at element center → key) in order', () => {
    assert(res.ok, JSON.stringify(res.data));
    assert.deepStrictEqual(log.slice(0, 4), [['load', 'http://127.0.0.1:9/form'], ['type', 'hub'], ['click', 40, 50], ['key', 'Enter']]);
    assert(log.closed && /^cu-/.test(log.partition) && !log.partition.startsWith('persist:'));
  });
  await check('run: page text is secret-scrubbed; screenshot is a logical rsi: path on disk', () => {
    const t = res.data.steps.find((s) => s.action === 'text').text;
    assert(!t.includes('a'.repeat(40)) && t.includes('done'), t);
    const shot = res.data.steps.find((s) => s.action === 'screenshot');
    assert(/^rsi:computer-use\/cu-[^/]+\/step-5\.png$/.test(shot.screenshot), shot.screenshot);
    assert(fs.existsSync(path.join(scratch, 'rsi', ...shot.screenshot.slice(4).split('/'))));
  });
  await check('run: missing element stops the run, window still closed', async () => {
    const l = [];
    const r = await sb.run({ confirmed: true, steps: [{ action: 'navigate', url: 'http://localhost:1/' }, { action: 'click', selector: '#nope' }] }, { ...deps, openPage: fakePage(l) });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.data.reason, 'web_no_element'); assert(l.closed);
  });
  await check('run: a redirect to a disallowed origin is blocked and reported', async () => {
    const l = [];
    const r = await sb.run({ steps: [{ action: 'navigate', url: 'http://127.0.0.1:2/' }] }, { ...deps, openPage: fakePage(l, { redirectTo: 'https://tracker.example.net/p' }) });
    assert.strictEqual(r.ok, false); assert.deepStrictEqual(r.data.blocked, ['https://tracker.example.net/p']);
  });
  await check('run: outside Electron without a page factory the sandbox says so', async () => {
    const r = await sb.run({ steps: [{ action: 'navigate', url: 'http://127.0.0.1:3/' }] }, deps).catch((e) => ({ thrown: e.code }));
    assert.strictEqual(r.thrown, 'web_sandbox_unavailable');
  });

  await check('executor: web-gui route resolves for a web intent and runs through the sandbox', async () => {
    const r0 = await table.resolve('로컬 웹 페이지 화면 캡처', {}, { dataDir: scratch });
    assert.strictEqual(r0.best.id, 'web-gui');
    assert.deepStrictEqual(table.allowed(r0.best), []);
    const l = [];
    const r = await executor.run({ routeId: 'web-gui', args: { steps: [{ action: 'navigate', url: 'http://127.0.0.1:4/' }, { action: 'screenshot' }] } }, { ...deps, openPage: fakePage(l) });
    assert(r.ok && r.kind === 'computer-use' && r.target === 'web:sandbox', JSON.stringify(r));
  });
  await check('executor: input through the route without confirmation is not run or recorded as failure', async () => {
    const r = await executor.run({ routeId: 'web-gui', args: { steps: [{ action: 'click', x: 1, y: 1 }] } }, { ...deps, openPage: fakePage([]) });
    assert.strictEqual(r.needsConfirmation, true);
  });
  await check('executor: secret-like typed text is refused before the browser opens', async () => {
    let opened = false;
    const r = await executor.run({ routeId: 'web-gui', confirmed: true, args: { steps: [{ action: 'type', text: 'Authorization: Bearer ' + 'f'.repeat(40) }] } }, { ...deps, openPage: async () => { opened = true; } });
    assert.strictEqual(r.ok, false); assert(/secret/.test(r.data.reason)); assert(!opened);
  });

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`웹 샌드박스 computer use: 통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exitCode = 1;
})();

// 웹 샌드박스 computer use(`web:` 경로): Hub 안의 보이지 않는 브라우저 창에서 화면을 보고(스크린샷·글) 실제 입력을 보낸다
// (요소 중심 좌표 클릭·타이핑·키). 다른 하네스에 넘기지 않고 Hub가 직접 하는 유일한 GUI 경로라 가상화를 겹으로 둔다:
//   - 실행마다 새 메모리 전용 세션 — 쿠키·저장소가 Hub 화면과 섞이지 않고 끝나면 지운다. 노드 접근 없음(sandbox·contextIsolation).
//   - 모든 요청(문서·하위 자원·리디렉션)을 출처 허용 목록으로 거른다: 기본은 이 PC의 loopback만, 바깥은 설정
//     `computerUse.allowedOrigins`에 사용자가 적은 https 출처만. 막힌 요청은 결과의 `blocked`에 남는다.
//   - 내려받기·권한 요청·새 창은 거부. 클릭·타이핑·키가 든 실행은 confirmed:true가 있어야 한다(되돌릴 수 없을 수 있다).
//   - 스크린샷은 rsi:computer-use/<id>/ 논리 경로로만, 페이지 글은 시크릿을 가린 뒤 돌려준다.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LIMITS = { steps: 20, totalMs: 60000, stepMs: 15000, textChars: 20000, typeChars: 2000, waitMs: 5000, blocked: 50 };
const ACTIONS = new Set(['navigate', 'screenshot', 'text', 'accessibility', 'click', 'type', 'key', 'wait']);
const INPUT = new Set(['click', 'type', 'key']);
const KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const PASS = new Set(['data:', 'blob:', 'about:', 'devtools:', 'chrome-error:']); // 페이지 안 자원·빈 문서·오류 화면

const coded = (code, message) => Object.assign(new Error(message), { code });

function extraOrigins(deps = {}) {
  let list = [];
  try { list = ((deps.config || require('../config')).load().computerUse || {}).allowedOrigins || []; } catch { /* 설정 없음 = loopback만 */ }
  return list.map((o) => String(o).toLowerCase().replace(/\/+$/, '')).filter((o) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(o));
}

function originAllowed(url, extra = []) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (PASS.has(u.protocol)) return true;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false; // file:·ftp: 등은 언제나 거부
  return LOOPBACK.test(u.origin) || extra.includes(u.origin.toLowerCase());
}

function validate(steps) {
  if (!Array.isArray(steps) || !steps.length) throw coded('web_bad_steps', 'args.steps must be a non-empty array');
  if (steps.length > LIMITS.steps) throw coded('web_bad_steps', `at most ${LIMITS.steps} steps`);
  const problems = [];
  steps.forEach((s, i) => {
    const a = s && s.action;
    if (!ACTIONS.has(a)) return problems.push(`steps[${i}].action must be one of ${[...ACTIONS].join('|')}`);
    if (a === 'navigate' && typeof s.url !== 'string') problems.push(`steps[${i}].url is required`);
    if (a === 'click' && typeof s.selector !== 'string' && !(Number.isFinite(s.x) && Number.isFinite(s.y))) problems.push(`steps[${i}] needs selector or x,y`);
    if (a === 'type' && (typeof s.text !== 'string' || s.text.length > LIMITS.typeChars)) problems.push(`steps[${i}].text is required (≤ ${LIMITS.typeChars} chars)`);
    if (a === 'key' && !KEYS.has(s.key)) problems.push(`steps[${i}].key must be one of ${[...KEYS].join('|')}`);
    if (a === 'wait' && !(Number.isFinite(s.ms) && s.ms >= 0 && s.ms <= LIMITS.waitMs)) problems.push(`steps[${i}].ms must be 0..${LIMITS.waitMs}`);
  });
  if (problems.length) throw coded('web_bad_steps', problems.join('; '));
}

const needsConfirmation = (steps) => steps.some((s) => INPUT.has(s.action));

// Only publish names and structure. Editable contents can also appear as descendant text nodes.
function accessibleOutline(nodes) {
  const { scrub, redactCredentials } = require('../secret-scrub');
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const root = nodes.find(node => node.role?.value === 'RootWebArea');
  if (!root) return { nodes: [], truncated: false };
  const queue = [{ id: root.nodeId, parent: null }];
  const seen = new Set();
  const outline = [];
  let truncated = false;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const { id, parent } = queue[cursor];
    const node = byId.get(id);
    if (!node || seen.has(id)) continue;
    seen.add(id);
    let nextParent = parent;
    const role = String(node.role?.value || '');
    const editable = ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(role)
      || (node.properties || []).some(p => p.name === 'editable' && p.value?.value);
    if (!node.ignored && role !== 'InlineTextBox') {
      if (outline.length >= 200) { truncated = true; break; }
      nextParent = outline.length;
      const name = editable ? '' : redactCredentials(scrub(node.name?.value || '')).slice(0, 160);
      outline.push({ role, name, parent });
    }
    if (!editable) {
      for (const child of node.childIds || []) queue.push({ id: child, parent: nextParent });
    }
  }
  return { nodes: outline, truncated };
}

/** Electron 구현. 테스트는 deps.openPage로 같은 모양의 가짜를 넣는다. */
async function electronPage({ partition, allow, onBlocked }) {
  if (!process.versions.electron) throw coded('web_sandbox_unavailable', 'the web sandbox runs only inside the Hub app (Electron main process)');
  const { BrowserWindow, session } = require('electron');
  const ses = session.fromPartition(partition, { cache: false }); // persist: 접두사 없음 = 메모리 전용
  ses.webRequest.onBeforeRequest((d, cb) => { const ok = allow(d.url); if (!ok) onBlocked(d.url); cb({ cancel: !ok }); });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (e, item) => { e.preventDefault(); onBlocked('download:' + item.getURL()); });
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: {
    partition, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false, spellcheck: false } });
  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => { onBlocked('popup:' + url); return { action: 'deny' }; });
  return {
    load: (url) => wc.loadURL(url),
    capture: async () => { wc.invalidate(); const img = await wc.capturePage(); return { png: img.toPNG(), ...img.getSize() }; },
    eval: (js) => wc.executeJavaScript(js, true),
    accessibility: async () => {
      const debug = wc.debugger;
      debug.attach('1.3');
      try {
        const tree = await debug.sendCommand('Accessibility.getFullAXTree');
        return accessibleOutline(tree.nodes);
      } finally {
        if (!wc.isDestroyed() && debug.isAttached()) debug.detach();
      }
    },
    mouseClick: (x, y) => { for (const type of ['mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 }); },
    insertText: (t) => wc.insertText(t),
    key: (k) => { wc.focus(); wc.sendInputEvent({ type: 'keyDown', keyCode: k }); wc.sendInputEvent({ type: 'keyUp', keyCode: k }); },
    url: () => wc.getURL(),
    close: async () => { if (!win.isDestroyed()) win.destroy(); await ses.clearStorageData().catch(() => {}); },
  };
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => require('../promise-timeout').withTimeout(p, ms, () => coded('web_step_timeout', `step took over ${ms} ms`));
const center = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase() }; })()`;

async function step(page, s, i, id, deps) {
  if (s.action === 'navigate') { await page.load(s.url); return { url: page.url() }; }
  if (s.action === 'wait') { await settle(s.ms); return {}; }
  if (s.action === 'accessibility') return page.accessibility();
  if (s.action === 'text') {
    const raw = String(await page.eval('document.body ? document.body.innerText : ""') || '');
    return { text: require('../secret-scrub').scrub(raw.slice(0, LIMITS.textChars)), truncated: raw.length > LIMITS.textChars };
  }
  if (s.action === 'screenshot') {
    const shot = await page.capture();
    const dir = path.join(deps.dataDir || require('../paths').hubDataDir(), 'rsi', 'computer-use', id);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, `step-${i}.png`), shot.png);
    return { screenshot: `rsi:computer-use/${id}/step-${i}.png`, width: shot.width, height: shot.height, bytes: shot.png.length };
  }
  if (s.action === 'click') {
    const at = typeof s.selector === 'string' ? await page.eval(center(s.selector)) : { x: s.x, y: s.y };
    if (!at) throw coded('web_no_element', `no element matches ${s.selector}`);
    page.mouseClick(at.x, at.y);
    await settle(150); // 클릭이 만든 화면 변화가 그려질 틈
    return { x: at.x, y: at.y, ...(at.tag ? { tag: at.tag } : {}) };
  }
  if (s.action === 'type') {
    if (typeof s.selector === 'string') {
      const ok = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(s.selector)}); if (!el) return false; el.focus(); return true; })()`);
      if (!ok) throw coded('web_no_element', `no element matches ${s.selector}`);
    }
    page.insertText(s.text);
    return { chars: s.text.length };
  }
  page.key(s.key); // key
  await settle(150);
  return { key: s.key };
}

/**
 * run({ steps, confirmed }) → { ok, needsConfirmation?, data: { id, url, steps, blocked, reason? } }
 * steps: navigate{url} · screenshot · text · accessibility · click{selector | x,y} · type{text, selector?} · key{key} · wait{ms}
 */
async function run({ steps, confirmed } = {}, deps = {}) {
  validate(steps);
  if (needsConfirmation(steps) && confirmed !== true) {
    return { ok: false, needsConfirmation: true, data: { reason: 'click/type/key steps need confirmed:true (input may not be reversible)' } };
  }
  const extra = extraOrigins(deps);
  const refused = steps.filter((s) => s.action === 'navigate' && !originAllowed(s.url, extra)).map((s) => s.url);
  if (refused.length) return { ok: false, data: { reason: 'origin not allowed', refused, allowed: ['loopback', ...extra] } };
  const id = `cu-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const blocked = [];
  const page = await (deps.openPage || electronPage)({ partition: id, allow: (u) => originAllowed(u, extra), onBlocked: (u) => { if (blocked.length < LIMITS.blocked) blocked.push(String(u).slice(0, 200)); } });
  const log = [];
  const started = Date.now();
  try {
    for (const [i, s] of steps.entries()) {
      if (Date.now() - started > LIMITS.totalMs) throw coded('web_timeout', `run took over ${LIMITS.totalMs} ms`);
      log.push({ i, action: s.action, ...(await within(step(page, s, i, id, deps), LIMITS.stepMs)) });
    }
    return { ok: true, data: { id, url: page.url(), steps: log, blocked } };
  } catch (e) {
    let url = null;
    try { url = page.url(); } catch { /* 창이 이미 닫힘 */ }
    return { ok: false, data: { id, url, steps: log, blocked, reason: e.code || String(e.message || e).slice(0, 200) } };
  } finally {
    await page.close().catch(() => {});
  }
}

/** 실행별 스크린샷 폴더는 14일 보관한다(배경 작업이 하루 한 번). 결과에는 논리 경로만 남으므로 지난 실행을 다시 열 일은 드물다. */
const prune = (deps = {}) => require('../data-retention').pruneOlderThan(path.join(deps.dataDir || require('../paths').hubDataDir(), 'rsi', 'computer-use'), 14);

module.exports = { run, validate, originAllowed, needsConfirmation, prune, LIMITS };

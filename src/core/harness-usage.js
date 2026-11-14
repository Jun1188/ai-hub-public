// 하네스별 Hub 사용: MCP 클라이언트 이름을 하네스 id(harness-registry와 같은 이름)로 바꾸고, tool-usage.local의 일별 도구 호출을
// 하네스별로 합친다. harness_compat·도구 경로 장부·버스 통계·지식 그래프 지표가 "어느 하네스가 Hub를 얼마나 쓰는지"를 같은 이름으로 보인다.
// 기기 전용 파일만 읽고 쓰지 않는다. 이름만 다룬다 — 토큰·경로는 없다. id는 agy 최상위 대화 id 하나다(어느 대화가 무엇을 불렀나, tool-usage.js).
'use strict';
const fs = require('fs');
const path = require('path');

const CLIENTS = [
  [/claude[-_ ]?code/i, 'claude-code'], [/codex/i, 'codex'], [/antigravity|(^|\W)agy(\W|$)/i, 'antigravity'], [/gemini/i, 'gemini-cli'],
  [/claude[-_ ]?(ai|desktop)|^claude$/i, 'claude-desktop'], [/cursor/i, 'cursor'], [/vs ?code|visual studio code|copilot/i, 'vscode'],
];
const DAY_MS = 86400000;

/** MCP clientInfo 이름(또는 User-Agent 'ua:...') → 하네스 id. 이름이 없거나 UA뿐이면 'unknown'. */
function harnessOfClient(client) {
  if (!client || /^ua:/.test(client)) return 'unknown';
  for (const [re, id] of CLIENTS) if (re.test(client)) return id;
  return 'other';
}

/** 지금 호출의 하네스: MCP면 클라이언트, Hub 화면·타이머면 'ai-hub', 스크립트면 'script'. */
function harnessOfCaller(c = require('./caller').current()) {
  if (c.via === 'mcp') return harnessOfClient(c.client);
  return c.via === 'gui' || c.via === 'hub' || c.via === 'pipeline' ? 'ai-hub' : c.via || 'unknown';
}

/** 최근 days일 MCP 도구 호출을 하네스별로: 호출·오류·응답 바이트·도구별 호출·마지막 날. 1.32.x 이전 파일(클라이언트 없음)은 'unknown'. */
async function hubCalls({ days = 30 } = {}, deps = {}) {
  const dir = path.join(deps.dataDir || require('./paths').hubDataDir(), 'tool-usage.local');
  const now = deps.now ? deps.now() : Date.now();
  const since = new Date(now - (Math.max(1, days) - 1) * DAY_MS).toISOString().slice(0, 10);
  let entries = [];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const files = [];
  for (const e of entries) {
    const day = e.name.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < since) continue;
    if (e.isFile() && e.name.endsWith('.json')) files.push([day, path.join(dir, e.name)]);
    else if (e.isDirectory()) for (const f of await fs.promises.readdir(path.join(dir, e.name)).catch(() => [])) if (f.endsWith('.json')) files.push([day, path.join(dir, e.name, f)]);
  }
  const out = {}, convs = {};
  const row = (h) => out[h] || (out[h] = { calls: 0, errors: 0, bytes: 0, tools: {}, lastDay: null });
  for (const [day, file] of files) {
    let v;
    try { v = JSON.parse((await fs.promises.readFile(file, 'utf8')).replace(/^﻿/, '')); } catch { continue; } // 쓰는 중인 파일은 다음에
    // 같은 대화가 여러 날·여러 Hub 프로세스 파일에 나뉘어 있을 수 있다 — id로 합친다.
    for (const [id, c] of Object.entries(v.conversations || {})) {
      // 키가 Antigravity 이름공간(antigravity.google/...)이라 이름을 안 밝힌 클라이언트(옛 무상태 HTTP는 User-Agent뿐)도 Antigravity다.
      const named = harnessOfClient(c.client), h = named === 'unknown' ? 'antigravity' : named, key = `${h}\n${id}`;
      const first = String(c.first || ''), last = String(c.last || '');
      const m = convs[key] || (convs[key] = { harness: h, id, calls: 0, errors: 0, tools: {}, first, last });
      m.calls += c.calls || 0; m.errors += c.errors || 0;
      for (const [tool, n] of Object.entries(c.tools || {})) m.tools[tool] = (m.tools[tool] || 0) + n;
      if (first < m.first) m.first = first;
      if (last > m.last) m.last = last;
    }
    for (const [tool, s] of Object.entries(v.tools || {})) {
      const clients = s.clients && Object.keys(s.clients).length ? s.clients : { '': s.calls || 0 };
      for (const [client, n] of Object.entries(clients)) {
        const r = row(harnessOfClient(client));
        r.calls += n; r.tools[tool] = (r.tools[tool] || 0) + n;
        if (!r.lastDay || day > r.lastDay) r.lastDay = day;
      }
      // 오류·바이트는 클라이언트별로 나뉘어 있지 않다 — 그 도구를 가장 많이 부른 하네스에 둔다.
      const top = harnessOfClient(Object.entries(clients).sort((a, b) => b[1] - a[1])[0][0]);
      row(top).errors += s.errors || 0; row(top).bytes += s.bytes || 0;
    }
  }
  const topOf = (tools, n) => Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, n).map(([tool, calls]) => ({ tool, calls }));
  // 대화별(agy): 최근 것부터 하네스당 20개. 도구 이름·횟수·처음·마지막 시각만. 호출은 'unknown'에 있고 대화만 있는 하네스 행도 생기므로 top보다 먼저.
  for (const m of Object.values(convs).sort((a, b) => b.last.localeCompare(a.last))) {
    const r = row(m.harness);
    if (!r.conversations) r.conversations = [];
    if (r.conversations.length < 20) r.conversations.push({ id: m.id, calls: m.calls, errors: m.errors, first: m.first, last: m.last, top: topOf(m.tools, 5) });
  }
  for (const r of Object.values(out)) r.top = topOf(r.tools, 8);
  return { days, since, total: Object.values(out).reduce((s, r) => s + r.calls, 0), harnesses: out };
}

module.exports = { harnessOfClient, harnessOfCaller, hubCalls };

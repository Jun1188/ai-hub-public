// IPC: 자가개선 탭 — 평가 3계층·RSI 루프·제안 승인·하네스 버스·캐시 GC·거버너·Obsidian 자동 색인.
// 오래 걸리는 작업(평가·탐침·색인)은 {started:true}로 바로 답하고 si:done 이벤트로 결과를 보낸다.
'use strict';

/** @param {import('./register-handlers').IpcContext} ctx */
function register(ctx) {
  const { handle, send } = ctx;
  const background = (name, work) => {
    work().then((r) => send('si:done', { name, result: r }), (e) => send('si:done', { name, error: e.message }));
    return { started: true };
  };
  handle('si:overview', () => require('../../src/core/rsi/overview').overview());
  handle('si:evaluate', (subject, tier, worker) => background('evaluate', async () => {
    require('../../src/core/rsi/hub-operations').registerAll();
    const ops = require('../../src/core/rsi/hub-operations').operations();
    const name = tier === 'agent' ? 'eval.agent' : tier === 'meta' ? 'eval.meta' : 'eval.deterministic';
    return ops[name].fn({ subject: String(subject || 'hub-source'), worker: worker ? String(worker) : undefined }, {});
  }));
  // 그래프 설치·제안 결정은 사람이 화면에서 누른 것이므로 confirmed:true를 여기서만 붙인다.
  handle('si:installLoops', () => require('../../src/core/rsi/triple-loop').install({ confirmed: true }));
  handle('si:propose', () => background('propose', async () => {
    require('../../src/core/rsi/hub-operations').registerAll();
    const research = require('../../src/core/rsi/research-agents');
    const added = await research.propose();
    const reviewed = await research.review(null, {});
    return { added: added.added, reviewed: reviewed.reviewed.length, unavailable: added.unavailable };
  }));
  handle('si:decide', (id, decision, note) => require('../../src/core/rsi/research-agents').decide(String(id), { decision: String(decision), note: String(note || ''), confirmed: true }));
  handle('si:harnessProbe', () => background('harnessProbe', () => require('../../src/core/harness-bridge/harness-registry').probeAll()));
  handle('si:cacheGc', (dryRun) => background('cacheGc', () => require('../../src/core/cache/cache-operations').runGc({ dryRun: !!dryRun })));
  handle('si:obsidianIndex', () => background('obsidianIndex', () => require('../../src/core/obsidian/obsidian-link').autoIndex()));
  handle('si:governorTick', () => require('../../src/core/governor/governor').tick());
  // 원본 갱신(1.32.27): 대기 목록·최근 장부를 보이고, 승인·반려는 이 화면에서만 받는다(MCP에는 결정 도구가 없다).
  const supply = () => { require('../../src/core/supply/upstream-sync'); require('../../src/core/supply/tool-updates'); return require('../../src/core/supply/update-policy'); };
  handle('si:upstream', async () => ({ items: (await supply().list()).slice(-30).reverse() }));
  handle('si:upstreamDecide', (id, decision) => supply().resolve(String(id), { decision: String(decision), confirmed: true }));
  handle('si:upstreamCheck', () => background('upstreamCheck', async () => ({
    forks: (await require('../../src/core/supply/upstream-sync').syncDue()).length,
    tools: await require('../../src/core/supply/tool-updates').syncTools({ force: true }),
  })));
  // 승인이 필요해지면 사용자가 알 수 있게 Windows 알림을 띄운다(창이 트레이에 숨어 있어도 보인다). 누르면 창과 자가개선 탭을 연다.
  require('../../src/core/change-signals').onChanged((w) => {
    if (!w || w.kind !== 'upstream-approval') return;
    send('si:upstreamApproval', w);
    try {
      const { Notification } = require('electron');
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: 'ai-hub: 원본 갱신 승인 필요', body: `${w.title}${w.risks && w.risks.length ? ` — ${w.risks.slice(0, 3).join(', ')}` : ''}` });
      n.on('click', () => { const win = ctx.window(); if (win) { win.show(); win.focus(); } send('si:upstreamApproval', { ...w, open: true }); });
      n.show();
    } catch { /* 알림이 안 돼도 탭의 대기 목록에는 남는다 */ }
  });
}

module.exports = { register };

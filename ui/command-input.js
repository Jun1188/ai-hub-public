'use strict';
// AI에게 보내는 입력창의 @태그 자동 완성과 /명령 실행. 명령은 hub-commands.js(MCP hub_command와 같은 해석기)가 실행하고,
// 결과를 그 줄 자리에 맥락으로 넣는다. 쓰기 명령은 확인 창에서 승인한 뒤에만 confirm=true로 다시 보낸다.
// 대상: 에이전트 작업실 작업 지시, 파이프라인 AI 작업, 소스 분석의 외부 AI 질문. 문서 단위 위임이라 탭이 나중에 만든 입력창에도 붙는다.
(() => {
  const FIELDS = '#aider-prompt, #pbf-prompt, #idx-cloud-question';
  const MAX_INSERT = 6000;
  let catalog = null, loadedAt = 0, box = null, items = [], pick = 0, token = null;

  async function load() {
    if (!catalog || Date.now() - loadedAt > 30000) { catalog = await call(window.hub.cmdCatalog); loadedAt = Date.now(); }
    return catalog;
  }
  // 커서 앞 토큰: 줄 첫머리의 /명령, 또는 어디서나 @태그.
  function tokenAt(el) {
    const before = el.value.slice(0, el.selectionStart), line = before.slice(before.lastIndexOf('\n') + 1);
    if (/^\/\S*( \S*)?$/.test(line)) return { kind: '/', text: line, start: before.length - line.length };
    const m = /(^|\s)(@[\w.-]*)$/.exec(before);
    return m ? { kind: '@', text: m[2], start: before.length - m[2].length } : null;
  }
  function close() { if (box) box.remove(); box = null; items = []; token = null; }
  function render(el) {
    if (!box) { box = document.createElement('div'); box.className = 'cmd-suggest'; box.setAttribute('role', 'listbox'); document.body.appendChild(box); }
    const r = el.getBoundingClientRect();
    box.style.left = `${Math.round(r.left)}px`; box.style.top = `${Math.round(r.bottom + 2)}px`; box.style.width = `${Math.round(Math.min(r.width, 560))}px`;
    box.innerHTML = items.map((x, i) => `<div class="cmd-item${i === pick ? ' active' : ''}" role="option" data-cmd-pick="${i}"><b>${esc(x.label)}</b> <span class="hint">${esc(x.hint)}</span></div>`).join('')
      + '<div class="hint">Tab 넣기 · Enter(명령 줄) 실행 · Esc 닫기</div>';
    box.querySelectorAll('[data-cmd-pick]').forEach((d) => d.addEventListener('mousedown', (e) => { e.preventDefault(); accept(el, Number(d.dataset.cmdPick)); }));
  }
  async function suggest(el) {
    const t = tokenAt(el);
    if (!t) return close();
    let c;
    try { c = await load(); } catch { return close(); }
    const q = t.text.toLowerCase();
    const commands = el.id === 'aider-prompt' ? [...c.commands, { name: 'graph attach', usage: '/graph attach', about: '지식 그래프에서 선택한 관계 주소 첨부' }] : c.commands;
    const list = t.kind === '@'
      ? c.tags.filter((x) => x.tag.toLowerCase().startsWith(q)).map((x) => ({ insert: `${x.tag} `, label: x.tag, hint: x.kind === 'mcp' ? 'MCP 서버' : `API 연결 · ${x.name}` }))
      : commands.filter((x) => `/${x.name}`.startsWith(q) || x.usage.toLowerCase().startsWith(q)).map((x) => ({ insert: `/${x.name} `, label: x.usage, hint: x.about + (x.write ? ' · 쓰기(확인 필요)' : '') }));
    items = list.filter((x) => x.insert.trim() !== t.text.trim()).slice(0, 8);
    if (!items.length) return close();
    token = t; pick = Math.min(pick, items.length - 1);
    render(el);
  }
  function accept(el, i) {
    const x = items[i], t = token;
    if (!x || !t) return close();
    const end = el.selectionStart;
    el.value = el.value.slice(0, t.start) + x.insert + el.value.slice(end);
    el.selectionStart = el.selectionEnd = t.start + x.insert.length;
    close();
    el.focus();
  }
  /** 커서가 있는 줄이 /명령·@태그면 실행하고 그 줄을 결과 블록으로 바꾼다. 실행했으면 true. */
  async function runLine(el) {
    const v = el.value, caret = el.selectionStart, from = v.lastIndexOf('\n', caret - 1) + 1;
    const to = v.indexOf('\n', caret) < 0 ? v.length : v.indexOf('\n', caret), line = v.slice(from, to).trim();
    if (!/^[/@]\S/.test(line)) return false;
    el.readOnly = true;
    try {
      if (line === '/graph attach' && el.id === 'aider-prompt') {
        const project = document.getElementById('aider-project');
        const selectedProject = project.value;
        const block = await window.HubKnowledgeGraph.addresses(selectedProject);
        if (el.value !== v || project.value !== selectedProject) throw new Error('입력이 변경되었습니다. 주소를 다시 첨부하세요.');
        el.setRangeText(block + '\n', from, to, 'end');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      let r = await call(window.hub.cmdRun, line, false);
      if (r.confirmRequired) {
        if (!confirm(`${r.summary}\n\n실행할까요? 되돌릴 수 없는 작업일 수 있습니다.`)) { toast('실행하지 않았습니다.'); return true; }
        r = await call(window.hub.cmdRun, line, true);
      }
      // 글자 수 상한이 있는 입력창(외부 AI 질문 4000자)은 남은 자리만큼만 넣는다.
      const room = el.maxLength > 0 ? Math.max(0, el.maxLength - (el.value.length - (to - from)) - 120) : MAX_INSERT;
      let body = JSON.stringify(r.result, null, 2);
      if (body.length > Math.min(MAX_INSERT, room)) body = `${body.slice(0, Math.min(MAX_INSERT, room))}\n… (${body.length.toLocaleString()}자 중 앞부분만)`;
      const block = `[${line} 결과 · ${new Date().toLocaleString('ko-KR')}]\n${body}\n`;
      el.value = el.value.slice(0, from) + block + el.value.slice(to);
      el.selectionStart = el.selectionEnd = from + block.length;
    } catch (e) { toast(e.message, true); }
    finally { el.readOnly = false; }
    return true;
  }

  document.addEventListener('input', (e) => { if (e.target.matches && e.target.matches(FIELDS)) suggest(e.target); });
  document.addEventListener('focusout', (e) => { if (e.target.matches && e.target.matches(FIELDS)) setTimeout(close, 150); });
  document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!el.matches || !el.matches(FIELDS) || e.isComposing) return;
    if (box && items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pick = (pick + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; render(el); return; }
      if (e.key === 'Tab') { e.preventDefault(); accept(el, pick); return; }
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !el.readOnly) {
      const v = el.value, caret = el.selectionStart, from = v.lastIndexOf('\n', caret - 1) + 1;
      const to = v.indexOf('\n', caret) < 0 ? v.length : v.indexOf('\n', caret);
      if (/^[/@]\S/.test(v.slice(from, to).trim())) { e.preventDefault(); close(); runLine(el); }
    }
  });
})();

// MCP 연결 탭 — 허브를 AI 도구에 등록(서버 역할) + 다운스트림 서버 관리(호스트 역할).
'use strict';

async function copyMcpText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('클립보드에 복사되었습니다.');
  } catch {
    toast('클립보드에 복사하지 못했습니다. 클립보드 사용 권한을 확인하세요.', true);
  }
}

// ---- CLI 커넥터 (Unity CLI / Antigravity CLI) --------------------------------

// 등록 상태를 사람 말로. state는 브리지를 어디서 실행하느냐를 뜻한다.
const CONN_STATE = {
  installed: '<span class="ok">앱 내장 브리지</span>',
  legacy: '<span class="warn">예전 경로 (~/.mcp-connectors)</span>',
  'app-source': '<span class="warn">동기화 폴더 직접 지목</span>',
  other: '<span class="hint">외부 설정</span>',
};

async function refreshConnectors() {
  const targets = await call(window.hub.connStatus);
  const install = await call(window.hub.connInstall);
  $('conn-dir').textContent = install.dir;

  const rows = [];
  for (const t of targets) {
    if (!t.exists) continue;
    if (t.unsupported) continue; // Codex는 TOML 포맷 — CLI 커넥터 등록 대상 아님
    const cells = t.unreadable
      ? '<td class="bad" colspan="2">설정 파일을 읽을 수 없습니다 (JSON 오류) — 건드리지 않았습니다</td>'
      : `<td>${t.connectors.length
        ? t.connectors.map((c) => `${esc(c.name)} ${CONN_STATE[c.state] || ''}`).join('<br>')
        : '<span class="hint">없음</span>'}</td>
         <td>
           <button class="small" data-conn-add="${esc(t.id)}" data-cli="unity">unity 등록</button>
           ${t.connectors.map((c) => `<button class="small danger" data-conn-del="${esc(t.id)}" data-cli="${esc(c.name)}">${esc(c.name)} 해제</button>`).join(' ')}
         </td>`;
    rows.push(`<tr><td>${esc(t.name)}</td>${cells}</tr>`);
  }
  $('conn-targets').innerHTML = rows.length
    ? `<tr><th>AI 도구</th><th>등록된 CLI 커넥터</th><th>동작</th></tr>${rows.join('')}`
    : '<tr><td class="hint">감지된 AI 도구가 없습니다.</td></tr>';

  // 옮길 게 있으면 눈에 띄게 알린다.
  const plan = await call(window.hub.connMigrate, true);
  const box = $('conn-migrate-box');
  if (plan.planned.length) {
    box.style.display = '';
    $('conn-migrate-text').textContent =
      `옛 경로를 가리키는 커넥터 ${plan.planned.length}개: `
      + plan.planned.map((p) => `${p.targetName}/${p.name}`).join(', ');
  } else {
    box.style.display = 'none';
  }

  document.querySelectorAll('[data-conn-add]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await call(window.hub.connRegister, b.dataset.connAdd, b.dataset.cli);
      toast(`${r.target}에 ${r.cli} 커넥터를 등록했습니다. 해당 도구를 재시작하세요.`);
      refreshConnectors();
    } catch (e) { toast(e.message, true); }
  }));
  document.querySelectorAll('[data-conn-del]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await call(window.hub.connUnregister, b.dataset.connDel, b.dataset.cli);
      toast('해제했습니다. 해당 도구를 재시작하세요.');
      refreshConnectors();
    } catch (e) { toast(e.message, true); }
  }));
}

$('conn-migrate').addEventListener('click', async () => {
  $('conn-migrate').disabled = true;
  try {
    const r = await call(window.hub.connMigrate, false);
    const ok = r.migrated.filter((m) => m.ok).length;
    const bad = r.migrated.filter((m) => !m.ok);
    toast(bad.length
      ? `${ok}개 이전, ${bad.length}개 실패: ${bad[0].error}`
      : `${ok}개를 앱 내장 브리지로 옮겼습니다. 해당 AI 도구를 재시작하세요.`, bad.length > 0);
    refreshConnectors();
  } catch (e) { toast(e.message, true); } finally {
    $('conn-migrate').disabled = false;
  }
});

// ---- MCP tab ----------------------------------------------------------------

/** 등록 상태 칸. 방식(HTTP/stdio)까지 보여야 무엇을 옮길지 판단할 수 있다. */
function mcpStatusCell(t) {
  if (t.mode === 'http') return '<span class="ok">등록됨</span> <span class="hint">(HTTP)</span>';
  if (t.mode === 'stdio') return '<span class="ok">등록됨</span> <span class="warn">(stdio)</span>';
  if (t.mode === 'unreadable') return '<span class="bad">설정 파일을 읽을 수 없습니다</span>';
  return t.exists ? '미등록' : '<span class="bad">미감지</span>';
}

$('mcp-http-migrate').addEventListener('click', async () => {
  $('mcp-http-migrate').disabled = true;
  try {
    const r = await call(window.hub.migrateHttp, false);
    const ok = r.migrated.filter((m) => m.ok).length;
    const bad = r.migrated.filter((m) => !m.ok);
    toast(bad.length
      ? `${ok}개 이전, ${bad.length}개 실패: ${bad[0].error}`
      : `${ok}개를 HTTP로 옮겼습니다. 해당 AI 도구를 재시작하세요.`, bad.length > 0);
    refreshMcp();
  } catch (e) { toast(e.message, true); } finally {
    $('mcp-http-migrate').disabled = false;
  }
});

// agy는 로컬 모델이 아니라 offload_run(MCP)으로 부르는 클라우드 작업자라 MCP 탭과 대시보드의 허브 칸에 둔다.
async function refreshAgyStatus() {
  const AGY_STATE = { succeeded: '성공', declined: '거절', failed: '실패', cancelled: '취소', running: '실행 중' };
  const targets = ['mcp-agy-status', 'dash-agy-status'].map((id) => $(id)).filter(Boolean);
  try {
    const a = await call(window.hub.offloadAgyStatus);
    const html = `CLI ${a.installed ? `<span class="ok">${esc(a.version || '설치됨')}</span>` : '<span class="bad">없음</span>'}`
      + ` · 최근 작업 ${a.last ? `<span class="${a.last.state === 'succeeded' ? 'ok' : 'warn'}">${esc(AGY_STATE[a.last.state] || a.last.state)}</span> ${esc(a.last.model || a.last.reason)} <span class="hint">${esc(new Date(a.last.at).toLocaleString())}</span>` : '<span class="hint">없음</span>'}`
      + ` · 성공 ${a.succeeded} · 거절 ${a.declined} · 실패 ${a.failed}`;
    for (const el of targets) el.innerHTML = html;
  } catch (e) { for (const el of targets) el.textContent = 'agy 상태를 읽지 못했습니다: ' + e.message; }
}

async function refreshMcp() {
  refreshAgyStatus();
  try {
    const st = await call(window.hub.status);
    $('mcp-targets').innerHTML =
      '<tr><th>AI 도구</th><th>설정 파일</th><th>상태</th><th>동작</th></tr>' +
      st.targets.map((t) => `
        <tr>
          <td>${esc(t.name)}</td>
          <td class="hint">${esc(t.configPath)}</td>
          <td>${mcpStatusCell(t)}</td>
          <td>
            <button class="small" data-reg="${esc(t.id)}" data-mode="stdio">stdio 등록</button>
            ${t.stdioOnly ? '' : `<button class="small" data-reg="${esc(t.id)}" data-mode="http">HTTP 등록</button>`}
            ${t.registered ? `<button class="small danger" data-unreg="${esc(t.id)}">해제</button>` : ''}
          </td>
        </tr>`).join('');
    document.querySelectorAll('[data-reg]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const r = await call(window.hub.register, b.dataset.reg, b.dataset.mode);
        toast(`${r.target}에 ${r.mode} 방식으로 등록했습니다. (백업 생성됨)`);
        refreshMcp();
      } catch (e) { toast(e.message, true); }
    }));
    document.querySelectorAll('[data-unreg]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const r = await call(window.hub.unregister, b.dataset.unreg);
        toast(`${r.target}에서 등록 해제했습니다.`);
        refreshMcp();
      } catch (e) { toast(e.message, true); }
    }));

    // stdio로 등록된 게 남아 있으면 한 번에 옮길 수 있게 안내한다.
    const stdioTargets = st.targets.filter((t) => t.mode === 'stdio' && !t.stdioOnly); // Claude 데스크톱은 stdio만 받는다
    $('mcp-http-box').style.display = stdioTargets.length ? '' : 'none';
    $('mcp-http-text').textContent = stdioTargets.length
      ? `stdio로 등록된 도구 ${stdioTargets.length}개: ${stdioTargets.map((t) => t.name).join(', ')}`
      : '';

    await refreshConnectors();

    const net = await call(window.hub.netUrls);
    $('mcp-urls').innerHTML = net.urls.map((u) => `
      <div class="row" style="margin:4px 0">
        <span class="badge">${esc(u.label)}</span>
        <code style="flex:1">${esc(u.url)}</code>
        <button class="small" data-copy-text="${esc(u.url)}">URL 복사</button>
      </div>`).join('') +
      `<div class="hint">${net.requireAuth ? `인증 헤더: <code>Authorization: Bearer ${esc(net.token)}</code> <button class="small" data-copy-text="Authorization: Bearer ${esc(net.token)}">헤더 복사</button>` : '인증 꺼짐'}${net.lanAccess ? '' : ' · LAN 공개는 설정 탭에서 켤 수 있습니다.'}</div>`;
    document.querySelectorAll('[data-copy-text]').forEach((b) => b.addEventListener('click', () => copyMcpText(b.dataset.copyText)));

    const snips = await call(window.hub.snippets);
    $('snippet-stdio').textContent = JSON.stringify(snips.stdio, null, 2);
    $('snippet-http').textContent = JSON.stringify(snips.http, null, 2);

    const presets = await call(window.hub.dsPresets);
    $('ds-presets').innerHTML = '<h3>빠른 추가 (자동 감지됨)</h3>' + presets.map((p, i) =>
      `<button class="small" data-preset="${i}" title="${esc(p.note)}">＋ ${esc(p.label)}</button>`).join('');
    document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', async () => {
      const p = presets[Number(b.dataset.preset)];
      try {
        await call(window.hub.dsAdd, p.name, p.spec);
        toast(`${p.name} 서버를 추가했습니다. ${p.note}`);
        refreshDsList();
      } catch (e) { toast(e.message, true); }
    }));
    refreshDsList();
  } catch (e) {
    toast(e.message, true);
  }
}

async function refreshDsList() {
  const ds = await call(window.hub.dsList);
  $('ds-list').innerHTML = ds.length
    ? '<tr><th>이름</th><th>유형</th><th>상태</th><th>동작</th></tr>' +
      ds.map((s) => `
        <tr>
          <td>${esc(s.name)}<div class="hint">${esc(s.url || s.command || '')}</div></td>
          <td>${esc(s.type)}<div class="hint">${esc(s.protocolMode || 'auto')}${s.protocolEra ? ` → ${esc(s.protocolEra)}` : ''}</div></td>
          <td>${s.connected ? '<span class="ok">연결됨</span>' : '대기'}${s.missingLocal
            ? `<div class="warn">이 컴퓨터에 ${esc(Object.entries(s.missingLocal).map(([f, k]) => `${f}(${k.join(', ')})`).join(' · '))} 없음</div>`
            : ''}</td>
          <td>
            <button class="small" data-ds-test="${esc(s.name)}">연결 테스트</button>
            <button class="small danger" data-ds-del="${esc(s.name)}">삭제</button>
          </td>
        </tr>
        <tr class="hidden" id="ds-tools-${esc(s.name)}"><td colspan="4"></td></tr>`).join('')
    : '<tr><td class="hint">없음</td></tr>';
  document.querySelectorAll('[data-ds-test]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const tools = await call(window.hub.dsTools, b.dataset.dsTest);
      const row = $('ds-tools-' + b.dataset.dsTest);
      row.classList.remove('hidden');
      row.firstElementChild.innerHTML =
        `<span class="ok">연결 성공 — 툴 ${tools.length}개:</span> <span class="hint">${tools.map((t) => esc(t.name)).join(', ')}</span>`;
      refreshDsList();
    } catch (e) { toast('연결 실패: ' + e.message, true); } finally { b.disabled = false; }
  }));
  document.querySelectorAll('[data-ds-del]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await call(window.hub.dsRemove, b.dataset.dsDel);
      refreshDsList();
    } catch (e) { toast(e.message, true); }
  }));
}

$('ds-autofill').addEventListener('click', async () => {
  $('ds-autofill').disabled = true;
  try {
    const r = await call(window.hub.dsAutofill);
    if (r.filled.length) {
      toast(`${r.filled.map((f) => `${f.server}.${f.field}`).join(', ')} — ${r.filled[0].from} 설정에서 가져왔습니다.`);
    } else if (r.missing.length) {
      toast(`자동 감지 실패 — ${r.missing.map((m) => `${m.server}.${m.field}(${m.keys.join(', ')})`).join(', ')}는 직접 입력해야 합니다.`, true);
    } else {
      toast('채울 값이 없습니다 (모두 설정되어 있습니다).');
    }
    refreshDsList();
  } catch (e) { toast(e.message, true); } finally { $('ds-autofill').disabled = false; }
});

$('ds-type').addEventListener('change', () => {
  const isHttp = $('ds-type').value === 'http';
  $('ds-http-fields').classList.toggle('hidden', !isHttp);
  $('ds-stdio-fields').classList.toggle('hidden', isHttp);
});
$('ds-add').addEventListener('click', async () => {
  try {
    const type = $('ds-type').value;
    const protocolMode = $('ds-protocol').value;
    const spec = type === 'http'
      ? { type, url: $('ds-url').value.trim(), protocolMode }
      : { type, command: $('ds-command').value.trim(), args: $('ds-args').value.split('\n').map((s) => s.trim()).filter(Boolean), protocolMode };
    await call(window.hub.dsAdd, $('ds-name').value.trim(), spec);
    toast('서버가 추가되었습니다.');
    $('ds-name').value = ''; $('ds-url').value = ''; $('ds-command').value = ''; $('ds-args').value = '';
    refreshDsList();
  } catch (e) { toast(e.message, true); }
});

document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyMcpText($(b.dataset.copy).textContent)));

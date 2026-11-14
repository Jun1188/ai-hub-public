// 이력 탭 — 통합 활동 기록(로컬 모델 호출·offload·Aider·파이프라인)과 모델별 호출 통계.
// 활동은 각 기록 저장소를 읽기만 한다(src/core/activity.js). 기록은 PC마다 따로 있다.
'use strict';

// ---- history tab ---------------------------------------------------------------

const HIST_KIND = { delegation: '로컬 모델 호출', offload: 'offload', aider: 'Aider', pipeline: '파이프라인', command: '채팅 명령' };
const HIST_STATUS = {
  ok: ['ok', '성공'], failed: ['bad', '실패'], escalated: ['warn', '에스컬레이션'], skipped: ['warn', '건너뜀'],
  running: ['warn', '실행 중'], paused: ['warn', '일시정지'], cancelled: ['hint', '중지됨'],
};

function histTime(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function histDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  if (ms < 3600000) return Math.round(ms / 60000) + '분';
  return (ms / 3600000).toFixed(1) + '시간';
}

function histStatus(status) {
  const [cls, label] = HIST_STATUS[status] || ['hint', status || '-'];
  return `<span class="${cls}">${esc(label)}</span>`;
}

let historyRefresh = 0;

async function refreshHistory() {
  const refresh = ++historyRefresh;
  const kind = $('act-kind').value;
  const [activity, summary] = await Promise.allSettled([
    call(window.hub.activityList, kind, 150),
    call(window.hub.historySummary),
  ]);
  if (refresh !== historyRefresh) return;
  if (activity.status === 'fulfilled') {
    const act = activity.value;
    const sourceFailed = kind ? act.summary[kind]?.error : Object.values(act.summary).some(s => s.error);
    $('act-summary').innerHTML = '<tr><th>종류</th><th>기록</th><th>마지막 활동</th></tr>' +
      Object.entries(HIST_KIND).map(([k, label]) => {
        const s = act.summary[k] || {};
        return `<tr><td>${esc(label)}</td><td>${s.error ? '<span class="bad">읽기 실패</span>' : (s.count || 0)}</td>` +
          `<td class="hint">${s.error ? '—' : s.last ? esc(histTime(s.last)) : '없음'}</td></tr>`;
      }).join('');
    $('act-table').innerHTML = act.items.length
      ? '<tr><th>시각</th><th>종류</th><th>내용</th><th>실행</th><th>소요</th><th>결과</th></tr>' +
        act.items.map((r) => `<tr>
          <td class="hint">${esc(histTime(r.at))}</td>
          <td>${esc(HIST_KIND[r.kind] || r.kind)}<div class="hint">${esc(r.detail || '')}</div></td>
          <td class="hint">${esc((r.title || '').slice(0, 80))}</td>
          <td class="hint">${esc((r.actor || '').split('/').pop())}</td>
          <td>${histDuration(r.durationMs)}</td>
          <td title="${esc(r.error || '')}">${histStatus(r.status)}</td>
        </tr>`).join('')
      : sourceFailed ? '<tr><td class="bad">활동 이력 일부를 읽을 수 없습니다.</td></tr>'
        : '<tr><td class="hint">기록 없음</td></tr>';
  } else {
    $('act-summary').innerHTML = '<tr><td class="bad">활동 이력을 읽지 못했습니다. 새로고침으로 다시 시도하세요.</td></tr>';
    $('act-table').replaceChildren();
  }

  const sum = summary.status === 'fulfilled' ? summary.value : null;
  if (sum && sum.totalDelegations != null) {
    const totalLabel = sum.skippedHistoryRows ? '읽은 기록' : '총';
    $('hist-summary').innerHTML =
      `${totalLabel} <b>${sum.totalDelegations}</b>건 · 성공 <span class="ok">${sum.okCount}</span> · ` +
      `실패 <span class="bad">${sum.totalDelegations - sum.okCount}</span> · 에스컬레이션 <span class="warn">${sum.escalations}</span>` +
      (sum.background ? ` · <span class="hint">배경 보조 호출 ${sum.background}건 별도(이전 버전의 자동 기억 추출·세션 압축)</span>` : '') +
      (sum.skippedHistoryRows ? ` · <span class="warn">읽지 못한 기록 ${sum.skippedHistoryRows}건</span>` : '');
  } else {
    $('hist-summary').textContent = '위임 이력을 읽지 못했습니다. 새로고침으로 다시 시도하세요.';
  }
  if (sum && sum.models != null) {
    const models = Object.entries(sum.models);
    $('hist-models').innerHTML = models.length
      ? '<tr><th>모델</th><th>사용 횟수</th><th>평균 응답</th><th>누적 토큰</th><th>마지막 사용</th></tr>' +
        models.map(([id, m]) => `<tr><td>${esc(id)}</td><td>${Number.isFinite(m.count) ? m.count : '—'}</td><td>${Number.isFinite(m.emaMs) ? (m.emaMs / 1000).toFixed(1) + 's' : '—'}</td><td>${Number.isFinite(m.totalTokens) ? m.totalTokens.toLocaleString() : '—'}</td><td class="hint">${esc(histTime(m.lastUsed))}</td></tr>`).join('')
      : '<tr><td class="hint">아직 모델별 통계가 없습니다.</td></tr>';
  } else {
    $('hist-models').innerHTML = '<tr><td class="bad">모델별 통계를 읽지 못했습니다. 새로고침으로 다시 시도하세요.</td></tr>';
  }
}
$('hist-refresh') && $('hist-refresh').addEventListener('click', refreshHistory);
$('act-kind').addEventListener('change', refreshHistory);

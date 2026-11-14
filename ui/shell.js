// 렌더러 공통 기반 — DOM 헬퍼, 토스트, IPC 호출 래퍼, 탭 전환.
// 이 파일이 가장 먼저 로드된다(index.html의 스크립트 순서). 나머지 탭 파일은
// 여기 정의된 $ / toast / esc / call 을 전역으로 사용한다.
'use strict';

const $ = (id) => document.getElementById(id);

function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.className = ''), 4000);
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

async function call(fn, ...args) {
  const res = await fn(...args);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

// ---- tabs -----------------------------------------------------------------
// 화면 단추(#tabs [data-tab])는 묶음(.tab-group) 안에 있고 묶음 줄(#tab-groups)이 묶음을 고른다.
// 화면이 열리면(다른 화면의 링크로 열려도) 묶음 줄이 따라간다. 화면이 하나뿐인 묶음은 화면 줄을 접는다.

const lastTabOf = {};
function showGroup(group) {
  document.querySelectorAll('#tab-groups [data-group]').forEach((b) => b.classList.toggle('active', b.dataset.group === group));
  let visible = 0;
  document.querySelectorAll('#tabs .tab-group').forEach((g) => {
    g.hidden = g.dataset.group !== group;
    if (!g.hidden) visible = g.querySelectorAll('button:not([hidden])').length;
  });
  $('tabs').classList.toggle('single', visible <= 1);
}
document.querySelectorAll('#tab-groups [data-group]').forEach((g) => g.addEventListener('click', () => {
  const buttons = [...document.querySelectorAll(`#tabs .tab-group[data-group="${g.dataset.group}"] button:not([hidden])`)];
  (buttons.find((b) => b.dataset.tab === lastTabOf[g.dataset.group]) || buttons[0])?.click();
}));

/** 지금 화면의 요소로 스크롤해 잠깐 강조한다(탭을 다시 누르지 않는다 — 누르면 다시 그려져 요소가 바뀐다). */
function hubFlash(el) {
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('hub-flash');
  setTimeout(() => el.classList.remove('hub-flash'), 1800);
}
/** 다른 화면으로 가는 링크: 탭을 열고(이미 열려 있으면 새로 그리지 않는다), target(id 또는 요소)으로 스크롤해 강조한다. */
function destinationTab(tab, target) {
  const el = typeof target === 'string' ? $(target) : target;
  return tab === 'source' && el?.closest('#tab-learning') ? 'learning' : tab;
}
function hubGo(tab, target) {
  tab = destinationTab(tab, target);
  const button = document.querySelector(`#tabs button[data-tab="${tab}"]`);
  if (tab === 'learning' && button?.hidden) return;
  if (button && !button.classList.contains('active')) button.click();
  if (target) setTimeout(() => hubFlash(typeof target === 'string' ? $(target) : target), 200);
}

// 기기 프로필: 경량 기기는 끈 기능의 단추와 [data-feature] 칸만 숨긴다 — 화면·처리기는 그대로(src/core/feature-profile.js).
async function applyFeatureProfile() {
  try {
    const v = await call(window.hub.profileFeatures);
    const off = new Set(v.features.filter((f) => !f.enabled).map((f) => f.id));
    document.querySelectorAll('#tabs button[data-tab]').forEach((b) => { b.hidden = v.hiddenTabs.includes(b.dataset.tab); });
    document.querySelectorAll('[data-feature]').forEach((el) => { el.hidden = off.has(el.dataset.feature); });
    document.querySelectorAll('#tab-groups [data-group]').forEach((g) => {
      g.hidden = !document.querySelector(`#tabs .tab-group[data-group="${g.dataset.group}"] button:not([hidden])`);
    });
    document.body.dataset.profile = v.profile;
    const active = document.querySelector('#tabs button.active');
    if (!active || active.hidden) document.querySelector('#tabs button[data-tab]:not([hidden])')?.click();
    else showGroup(active.closest('.tab-group').dataset.group);
  } catch { /* 프로필을 못 읽으면 전부 보인다 */ }
}

document.querySelectorAll('#tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
    const group = btn.closest('.tab-group')?.dataset.group;
    if (group) { lastTabOf[group] = btn.dataset.tab; showGroup(group); }
    if (btn.dataset.tab === 'dashboard') { refreshDashboard(); refreshAutopilot(); }
    if (btn.dataset.tab === 'debugging') refreshDebugging();
    if (btn.dataset.tab === 'mcp') refreshMcp();
    if (btn.dataset.tab === 'skills') refreshSkills();
    if (btn.dataset.tab === 'settings') refreshSettings();
    if (btn.dataset.tab === 'delegate') refreshDelegate();
    if (btn.dataset.tab === 'aider') refreshAiderStudio();
    if (btn.dataset.tab === 'history') refreshHistory();
    if (btn.dataset.tab === 'source') { refreshSource(); window.analysisGraphUI?.refresh(); }
    if (btn.dataset.tab === 'learning') refreshLearning();
    if (btn.dataset.tab === 'memory') refreshMemory();
    if (btn.dataset.tab === 'projects') refreshProjects();
    if (btn.dataset.tab === 'pipelines') refreshPipelines();
    if (btn.dataset.tab === 'creation') window.creationStudio?.open();
    if (btn.dataset.tab === 'orchestration') window.herdrUI?.refresh();
  });
});

function bindDataAction(attr, fn) {
  document.querySelectorAll(`[data-${attr}]`).forEach((b) =>
    b.addEventListener('click', () => fn(b.dataset[attr.replace(/-([a-z])/g, (_m, c) => c.toUpperCase())])));
}

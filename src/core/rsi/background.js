// 데스크톱 Hub의 배경 작업(경량 프로필은 거버너를 돌리지 않는다): 거버너 30초 주기, RSI 제안·검토(하루), Obsidian 설치 감시·자동 색인,
// 지역성 캐시 GC(하루, 별도 프로세스), 버스 작업 폴더·웹 샌드박스 스크린샷·게이머 관점 캐시 보관 기간, 포크 동기화 점검(하루),
// 하네스 로그의 스킬 사용 수집(30분).
// 각각 실패해도 다른 것과 앱을 멈추지 않는다. 시작 1분 뒤부터 돈다 — 창 표시와 첫 연결을 늦추지 않게.
'use strict';

const DAY = 24 * 3600 * 1000;
let started = false;

function every(ms, fn) { const t = setInterval(() => { Promise.resolve().then(fn).catch(() => {}); }, ms); t.unref?.(); return t; }
function later(ms, fn) { const t = setTimeout(() => { Promise.resolve().then(fn).catch(() => {}); }, ms); t.unref?.(); return t; }

function start({ lite = false } = {}) {
  if (started) return;
  started = true;
  require('../shared-todo-queue').start();
  require('./hub-operations').registerAll();
  later(60 * 1000, () => require('../cache/cache-operations').runGc());
  every(DAY, () => require('../cache/cache-operations').runGc());
  every(DAY, () => require('../harness-bridge/virtual-workspace').prune({ olderThanDays: 7 }));
  every(DAY, () => require('../toolroute/web-sandbox').prune());
  every(DAY, () => require('../gamer-lens/steam-source').prune());
  later(5 * 60 * 1000, () => require('../supply/upstream-sync').syncDue());
  every(DAY, () => require('../supply/upstream-sync').syncDue());
  // 외부 도구(uv tool, Aider 등) 갱신도 같은 원본 갱신 정책으로(1.32.27). 도구마다 하루 한 번만 PyPI를 본다.
  later(7 * 60 * 1000, () => require('../supply/tool-updates').syncTools());
  every(6 * 3600 * 1000, () => require('../supply/tool-updates').syncTools());
  // RSI 3번 루프의 제안·검토 에이전트를 하루 한 번 돌린다(모델 없이 결정적). 승인은 사람이 탭에서 한다.
  const proposeAndReview = async () => { const r = require('./research-agents'); await r.propose(); await r.review(null, {}); };
  later(10 * 60 * 1000, proposeAndReview);
  every(DAY, proposeAndReview);
  require('../obsidian/obsidian-link').watch();
  // 하네스가 Hub를 거치지 않고 쓴 스킬(Claude Code·Codex 로그)을 이어 읽어 사용 수에 더한다 — 새 줄만 읽어 몇 ms(첫 실행만 전체).
  const collectSkills = () => require('../harness-skill-log').collect();
  later(2 * 60 * 1000, collectSkills);
  every(30 * 60 * 1000, collectSkills);
  if (!lite) {
    require('../governor/governor').start();
    // L2는 사건으로만 깨운다(새 평가 지문·Hub 버전 변경). 점검은 장부만 읽는다 — 경량 프로필은 자동 로컬 추론을 하지 않으므로 뺀다.
    const wakeL2 = () => require('../evaluation/meta-wake').wake();
    later(15 * 60 * 1000, wakeL2);
    every(6 * 3600 * 1000, wakeL2);
  }
}

/** 종료 직전: 아직 파일에 안 쓴 캐시 계수를 남긴다. */
async function stop() {
  try { require('../governor/governor').stop(); } catch { /* 없음 */ }
  try { await require('../cache/locality-cache').instance().flush(); } catch { /* 5초치 계수만 빠진다 */ }
}

module.exports = { start, stop };

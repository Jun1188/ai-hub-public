'use strict';

const ASPECTS = Object.freeze({
  gameplay: ['gameplay', 'combat', 'controls', 'mechanic', '조작', '전투', '게임플레이', '타격', '타격감', '조작감', '패링', '회피', '보스', '손맛', '액션'],
  story: ['story', 'narrative', 'plot', '스토리', '서사', '이야기', '세계관', '연출', '엔딩', '캐릭터'],
  graphics: ['graphics', 'visual', 'artwork', '그래픽', '비주얼', '아트', '분위기', '디자인'],
  performance: ['performance', 'optimization', 'fps', 'frame', 'bug', 'crash', '최적화', '프레임', '버그', '튕김', '렉', '끊김', '발적화'],
  price: ['price', 'value', 'expensive', '가격', '가성비', '비싸', '할인', '정가'],
  difficulty: ['difficulty', 'challenging', 'hard', 'easy', '난이도', '어렵', '쉬운', '고인물', '소울라이크', '빡세'],
  content: ['content', 'replay', 'length', '볼륨', '콘텐츠', '컨텐츠', '분량', '반복', '회차', '플레이타임', '시간'],
  multiplayer: ['multiplayer', 'co-op', 'coop', 'pvp', '멀티', '협동', '매칭'],
  sound: ['sound', 'music', 'audio', '사운드', '음악', '음향'],
  ui: ['ui', 'interface', 'menu', 'hud', '인터페이스', '메뉴', '가독성', '한글', '번역', '자막']
});

function aspectsOf(text) {
  const s = String(text || '').toLowerCase();
  return Object.keys(ASPECTS).filter(id => ASPECTS[id].some(word => {
    if (/^[a-z -]+$/.test(word)) return new RegExp('\\b' + word + '\\b', 'i').test(s);
    return s.includes(word);
  }));
}

function tokens(text) {
  const s = String(text).toLowerCase();
  const result = new Set(s.match(/[a-z]+/g) || []);
  for (const run of s.match(/[가-힣]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) result.add(run.slice(i, i + 2));
  }
  return result;
}

function similar(a, b) {
  if (!a.size && !b.size) return false;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap++;
  return overlap / (a.size + b.size - overlap) > 0.6;
}

function representative(reviews, { k = 8, summary } = {}) {
  const limit = Math.min(200, Math.max(0, Number.isFinite(k) ? Math.floor(k) : 8));
  const candidates = (Array.isArray(reviews) ? reviews : [])
    .filter(r => typeof r.text === 'string' && r.text.trim().length >= 40)
    .map((review, index) => ({ review, index, aspects: aspectsOf(review.text), tokens: tokens(review.text) }))
    .sort((a, b) => (Number(b.review.weightedScore) || 0) - (Number(a.review.weightedScore) || 0)
      || (Number(b.review.votesUp) || 0) - (Number(a.review.votesUp) || 0)
      || String(a.review.id).localeCompare(String(b.review.id), 'en') || a.index - b.index);
  const positives = candidates.filter(c => c.review.votedUp).length;
  const negatives = candidates.length - positives;
  const total = Number(summary?.totalPositive) + Number(summary?.totalNegative);
  const ratio = total > 0 ? Math.max(0, Math.min(1, Number(summary.totalPositive) / total)) : positives / (candidates.length || 1);
  let positiveGoal = Math.round(limit * ratio);
  if (positives && negatives && limit >= 2) positiveGoal = Math.max(1, Math.min(limit - 1, positiveGoal));
  if (!positives) positiveGoal = 0;
  if (!negatives) positiveGoal = limit;
  const goals = [limit - positiveGoal, positiveGoal];
  const counts = [0, 0];
  const selected = [];
  const covered = new Set();
  const usedIds = new Set();
  while (selected.length < limit) {
    const available = candidates.filter(c => !usedIds.has(String(c.review.id)) && !selected.some(s =>
      c.review.text === s.review.text || similar(c.tokens, s.tokens)));
    if (!available.length) break;
    const needed = available.filter(c => counts[Number(Boolean(c.review.votedUp))] < goals[Number(Boolean(c.review.votedUp))]);
    const pool = needed.length ? needed : available;
    let best = pool[0];
    let gain = -1;
    for (const candidate of pool) {
      const newCount = candidate.aspects.filter(a => !covered.has(a)).length;
      if (newCount > gain) { best = candidate; gain = newCount; }
    }
    selected.push({ ...best, reason: gain > 0 ? '새 관점: ' + best.aspects.filter(a => !covered.has(a)).join(', ') : '도움이 된 평가 및 긍정/부정 균형' });
    usedIds.add(String(best.review.id));
    counts[Number(Boolean(best.review.votedUp))]++;
    best.aspects.forEach(a => covered.add(a));
  }
  return selected.map(c => ({ ...c.review, aspects: c.aspects, reason: c.reason }));
}

module.exports = { ASPECTS, aspectsOf, representative };

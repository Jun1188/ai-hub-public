// 모델 없는 텍스트 표현: 한글 음절 2-gram + ASCII 단어 토큰, 해시 기능 TF-IDF 벡터(512차원), 코사인.
// 스킬 색인·도구 경로 표·멀티에이전트 다양성이 같은 표현을 써야 서로의 점수가 비교된다. find_context.py와 같은 토큰화.
'use strict';
const crypto = require('crypto');

const DIM = 512;

function tokens(text) {
  const out = [];
  const s = String(text || '').toLowerCase();
  for (const w of s.match(/[a-z0-9][a-z0-9_-]*/g) || []) if (w.length > 1) out.push(w);
  for (const run of s.match(/[가-힣]+/g) || []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

function hashVector(toks, idf = new Map()) {
  const v = new Float32Array(DIM);
  for (const t of toks) {
    const h = crypto.createHash('md5').update(t).digest();
    const i = h.readUInt16LE(0) % DIM, sign = h[2] & 1 ? 1 : -1;
    v[i] += sign * (idf.get(t) || 1);
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => +(x / n).toFixed(5));
}

const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

module.exports = { tokens, hashVector, cosine, DIM };

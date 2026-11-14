// 비동기 원자적 쓰기: 임시 파일에 다 쓴 뒤 rename. 읽는 쪽은 옛 파일 아니면 새 파일만 본다(규칙 6).
// 새 모듈들이 각자 같은 세 줄을 들고 있던 것을 한 곳으로 모았다(1.32.0 구조 감사). 읽기 짝(readJson)도 같은 이유로 여기 둔다.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

async function writeAtomic(file, text) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fs.promises.writeFile(tmp, text, 'utf8');
  await fs.promises.rename(tmp, file);
}

/** 없는 파일만 fallback이다. 깨진 파일·읽기 오류는 던진다 — 기본값으로 덮어쓰지 않게(규칙 6). */
async function readJson(file, fallback) {
  try { return JSON.parse((await fs.promises.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

/** readJson과 같되 깨진 파일은 .corrupt-<시각>으로 옮기고 fallback — 다음 쓰기가 원본을 덮지 않게. 읽기 오류(EBUSY 등)는 던진다. */
async function readJsonOrQuarantine(file, fallback) {
  let text;
  try { text = await fs.promises.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { await fs.promises.rename(file, `${file}.corrupt-${Date.now()}`); return fallback; }
}

/** 기록 파일에 한 줄 덧붙인다. maxBytes를 넘으면 .1로 굴린다(이전 .1은 버린다) — 끝없이 자라지 않게. */
async function appendLine(file, line, { maxBytes = 8 * 1024 * 1024 } = {}) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const st = await fs.promises.stat(file).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
  if (st && st.size > maxBytes) await fs.promises.rename(file, `${file}.1`);
  await fs.promises.appendFile(file, line + '\n', 'utf8');
}

module.exports = { writeAtomic, readJson, readJsonOrQuarantine, appendLine };

// SKILL.md 등의 YAML 앞머리에서 단순 키: 값(여러 줄 이어짐 포함)만 읽는다. 스킬 색인과 하네스 표면 검사가 함께 쓴다.
'use strict';

function frontmatter(text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return null;
  const out = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) { key = kv[1]; out[key] = kv[2].replace(/^["'>|-]\s*|["']$/g, '').trim(); }
    else if (key && /^\s+\S/.test(line)) out[key] = `${out[key]} ${line.trim()}`.trim();
  }
  return out;
}

module.exports = { frontmatter };

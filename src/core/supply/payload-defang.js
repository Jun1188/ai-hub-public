// 다른 하네스로 넘기는 글의 위험 명령 예시를 무력화한다(LOG 13).
// agy는 지시를 -p 인자로, Codex notify 훅은 턴 내용을 인자로 받는다 — 글이 명령줄에 실리면 Defender가
// ClickFix형 한 줄 명령을 악성 실행으로 보고 프로세스를 막는다. 차단 수준으로 판정된 줄에서만 핵심 낱말 가운데에
// 가운뎃점(U+00B7)을 끼운다: 사람·모델은 그대로 읽고, 실행도 시그니처 일치도 되지 않는다.
'use strict';

const MARK = '·';
// 낱말 단위라 이 파일 자체에는 실행 가능한 명령 형태가 없다.
const TOKENS = /\b(iex|invoke-expression|invoke-webrequest|iwr|curl|wget|downloadstring|downloadfile|webclient|encodedcommand|frombase64string|mshta|rundll32|regsvr32|certutil|bitsadmin|schtasks|cmdkey|set-mppreference|add-mppreference|set-executionpolicy|powershell|pwsh)\b/gi;

function insertMark(word) { return word.length < 2 ? word : word[0] + MARK + word.slice(1); }

/** @returns {{ text: string, defanged: number }} */
function defang(text) {
  const safety = require('./script-safety');
  let defanged = 0;
  const lines = String(text ?? '').split('\n').map((line) => {
    if (!TOKENS.test(line)) { TOKENS.lastIndex = 0; return line; }
    TOKENS.lastIndex = 0;
    const verdict = safety.scanText(line, { path: 'payload.ps1' }).verdict;
    if (verdict === 'pass') return line;
    defanged++;
    return line.replace(TOKENS, insertMark);
  });
  return { text: lines.join('\n'), defanged };
}

const restore = (text) => String(text ?? '').split(MARK).join('');

module.exports = { defang, restore, MARK };

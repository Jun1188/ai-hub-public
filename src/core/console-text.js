// Windows 콘솔 프로그램의 출력을 올바른 문자로 읽는다.
//
// 왜 필요한가 (2026-07-30 실측): 한국어 Windows의 콘솔 코드페이지는 949(CP949)다.
// `reg`·`where.exe`·`cmd`·Unity Hub CLI는 전부 그 코드페이지로 바이트를 낸다. Node의
// execFile은 기본이 utf8 디코딩이라 한글이 U+FFFD로 뭉개진다:
//
//   "다른 컴퓨터"  →  bytes b4d9 b8a5 20 c4c4 c7bb c5cd  →  utf8 디코드  →  "��..."
//
// 이게 조용한 이유는 **경로에 한글이 없으면 멀쩡하기 때문**이다. ASCII 경로만 쓰는
// 컴퓨터에서는 영원히 안 보이다가, 한글 경로에 UE/Unity를 깔면 그때 감지가 실패한다
// (존재하지 않는 디렉터리를 가리키게 된다). cli-bridge는 더 나쁘다 — 깨진 문자열이
// 그대로 AI 모델의 컨텍스트로 들어간다.
//
// 왜 "그냥 CP949로 읽으면 된다"가 아닌가: 같은 경로로 UTF-8을 내는 도구도 있다
// (vswhere의 JSON, lms의 --json). 그래서 **UTF-8을 먼저 시도하고 실패했을 때만**
// 콘솔 코드페이지로 다시 읽는다. 정상 UTF-8은 U+FFFD를 만들지 않으므로 이 신호는
// 믿을 수 있고, 반대로 CP949 바이트를 UTF-8로 읽으면 거의 확실히 U+FFFD가 생긴다.
'use strict';

const { execFileSync } = require('child_process');

// 콘솔 코드페이지 → TextDecoder 라벨. Node는 'cp949'를 모르고 'euc-kr'을 안다.
const DECODER_LABELS = {
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  65001: 'utf-8',
};

// 코드페이지를 못 알아냈을 때. 서유럽 단일바이트라 어떤 바이트도 예외 없이 읽히므로
// "깨진 채 조용히 통과"하지 않고 최소한 원본 바이트가 보존된다.
const FALLBACK_LABEL = 'windows-1252';

let legacyDecoder; // undefined = 아직 안 찾음

/**
 * 이 컴퓨터의 콘솔 코드페이지에 맞는 디코더. **처음 필요할 때 한 번만** 찾는다.
 *
 * chcp를 모듈 로드 시점에 부르지 않는 이유: 출력이 전부 ASCII면(대부분의 컴퓨터가
 * 그렇다) 이 경로에 아예 들어오지 않는다. 실패가 관측된 뒤에 한 번 재는 편이,
 * 쓰지도 않을 프로세스를 앱 시작마다 띄우는 것보다 낫다.
 */
function legacy() {
  if (legacyDecoder !== undefined) return legacyDecoder;
  let label = FALLBACK_LABEL;
  try {
    // chcp의 안내 문구 자체도 그 코드페이지로 나온다 — 그래서 문구는 읽지 않고
    // latin1로 바이트를 그대로 본 뒤 숫자만 뽑는다.
    const out = execFileSync('cmd', ['/c', 'chcp'], { timeout: 5000, windowsHide: true }).toString('latin1');
    const m = out.match(/(\d{3,5})\s*$/m);
    const cp = m ? parseInt(m[1], 10) : 0;
    if (DECODER_LABELS[cp]) label = DECODER_LABELS[cp];
  } catch { /* 못 재면 폴백 라벨로 간다 */ }
  try {
    legacyDecoder = new TextDecoder(label);
  } catch {
    legacyDecoder = new TextDecoder(FALLBACK_LABEL);
  }
  return legacyDecoder;
}

const utf8 = new TextDecoder('utf-8');

/**
 * 자식 프로세스 출력 버퍼를 문자열로. 문자열이 들어오면 그대로 돌려준다
 * (호출자가 아직 encoding을 안 바꾼 경우에도 안전하게).
 * @param {Buffer|string|null|undefined} buf
 * @returns {string}
 */
function decode(buf) {
  if (buf === null || buf === undefined) return '';
  if (typeof buf === 'string') return buf;
  if (!Buffer.isBuffer(buf)) return String(buf);
  const asUtf8 = utf8.decode(buf);
  if (!asUtf8.includes('�')) return asUtf8;
  return legacy().decode(buf);
}

/** execFile 계열에 넘길 옵션. 버퍼로 받아야 decode가 판단할 수 있다. */
const RAW_OUTPUT = { encoding: 'buffer' };

module.exports = { decode, RAW_OUTPUT, DECODER_LABELS, FALLBACK_LABEL };

// 로컬 런타임(LM Studio·llama.cpp) 주소의 주인은 config다. 자격 증명 묶음(platform)이 이 주소에 키를 묶을 때
// local-models 모듈(lmstudio)을 거꾸로 부르지 않도록 여기서 읽는다.
'use strict';
const settings = () => require('./config').load(); // 부를 때마다 찾는다 — 설정 모듈을 다시 읽는 시험이 옛 값을 보지 않게

const lmstudioBaseUrl = () => settings().lmstudio.baseUrl.replace(/\/+$/, '');
const llamaUrl = () => settings().localRuntimes?.llamaUrl || 'http://127.0.0.1:8080';

function origin(kind) {
  if (kind === 'lmstudio') return new URL(lmstudioBaseUrl()).origin;
  if (kind === 'llamacpp') return new URL(llamaUrl()).origin;
  throw new Error('Unknown local runtime: ' + kind);
}

module.exports = { lmstudioBaseUrl, llamaUrl, origin };

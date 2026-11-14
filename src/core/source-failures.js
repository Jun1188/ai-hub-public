'use strict';
// 진단에는 코드·상태만 남긴다. 서버 오류 본문에는 소스나 인증정보가 섞일 수 있다.
const path = require('path');
const { readJson, writeAtomic } = require('./atomic-file');
const hints = {
  connection_refused: '임베딩 서버를 시작하고 주소·포트를 확인하세요.',
  connect_timeout: '서버 주소와 네트워크 연결을 확인하세요.',
  response_timeout: '모델 로딩 상태를 확인하고 범위를 줄여 다시 시도하세요.',
  connection_closed: '서버 종료·모델 로딩 실패 여부를 확인하세요.',
  dns_failure: '서버 호스트 이름을 확인하세요.',
  authentication: '선택한 서비스의 로그인·인증 설정을 확인하세요.',
  model_missing: '임베딩 모델을 준비하고 설정의 모델 ID를 확인하세요.',
  rate_limit: '서비스의 재시도 안내에 따라 잠시 후 다시 시도하세요.',
  quota_exhausted: '사용 한도를 확인하거나 다른 실행 대상을 선택하세요.',
  server_error: '서버 로그를 확인하세요.',
  endpoint_missing: '서버 주소와 embeddings API 지원 여부를 확인하세요.',
  invalid_response: '응답 형식을 확인하세요. 임베딩은 벡터 개수·차원도 확인하세요.',
  file_access: '소스 경로와 읽기 권한을 확인하세요.',
  cancelled: '사용자가 작업을 취소했습니다.',
  worker_missing: '선택한 CLI를 설치하고 Hub가 실행 파일을 찾는지 확인하세요.',
  worker_error: 'CLI 실행 결과와 서비스 상태를 확인하세요.',
  permission: '서비스의 도구 사용 권한을 확인하세요.',
  invalid_request: '입력 범위와 요청 내용을 확인하세요.',
  unknown: '상세 진단의 단계·원인 코드와 서비스 로그를 확인하세요.',
};
const safeCode = value => /^[A-Za-z0-9_.-]{1,100}$/.test(String(value || '')) ? String(value) : null;
function describe(error) {
  const causes = [], seen = new Set();
  function visit(e) {
    if (!e || typeof e !== 'object' || seen.has(e) || causes.length >= 8) return;
    seen.add(e);
    causes.push({ name: safeCode(e.name), code: safeCode(e.code) });
    visit(e.cause);
    if (Array.isArray(e.errors)) e.errors.forEach(visit);
  }
  visit(error);
  const codes = causes.map(c => c.code).filter(Boolean);
  const reason = safeCode(error?.offloadReason || error?.declined || error?.reason);
  const text = `${reason || ''} ${error?.message || ''}`;
  const status = Number.isInteger(error?.status) ? error.status : null;
  let category = 'unknown';
  if (error?.category && hints[error.category]) category = error.category;
  else if (/^cancelled$/i.test(text.trim()) || error?.name === 'AbortError') category = 'cancelled';
  else if (codes.includes('ECONNREFUSED')) category = 'connection_refused';
  else if (codes.some(c => /CONNECT_TIMEOUT|ETIMEDOUT/.test(c))) category = 'connect_timeout';
  else if (codes.some(c => /HEADERS_TIMEOUT|BODY_TIMEOUT/.test(c)) || /timeout|deadline_exceeded/i.test(text)) category = 'response_timeout';
  else if (codes.some(c => /ECONNRESET|EPIPE|UND_ERR_SOCKET/.test(c))) category = 'connection_closed';
  else if (codes.some(c => /ENOTFOUND|EAI_AGAIN/.test(c))) category = 'dns_failure';
  else if (status === 401 || status === 403 || /agy_auth|unauthenticated/.test(reason || '')) category = 'authentication';
  else if (/quota_exhausted/.test(reason || '')) category = 'quota_exhausted';
  else if (status === 429 || /throttled|resource_exhausted/.test(reason || '')) category = 'rate_limit';
  else if (/model_unavailable/.test(reason || '')) category = 'model_missing';
  else if (/tool_denied|permission_denied/.test(reason || '')) category = 'permission';
  else if (/not_installed|cli_not_found/.test(reason || '') || /CLI not found/.test(text)) category = 'worker_missing';
  else if (/^codex_exit_\d+$|^agy_api_|^worker_failed$/.test(reason || '')) category = 'worker_error';
  else if (status >= 500) category = 'server_error';
  else if (status === 404) category = 'endpoint_missing';
  else if (status >= 400 && status < 500) category = 'invalid_request';
  else if (error instanceof SyntaxError || /schema_invalid|empty_or_truncated|empty_answer/.test(reason || '')) category = 'invalid_response';
  else if (codes.some(c => /^(ENOENT|EACCES|EPERM|ENOTDIR|EISDIR)$/.test(c)) || /Root not found/.test(text)) category = 'file_access';
  else if (codes.includes('ERR_INVALID_URL') || /Index name must|already building/.test(text)) category = 'invalid_request';
  return { category, hint: error?.userMessage ? `${error.userMessage} · ${hints[category]}` : hints[category], status, reason, causes,
    retryable: ['connect_timeout', 'response_timeout', 'connection_closed', 'rate_limit', 'server_error'].includes(category) };
}
function failure(category, message, fields = {}) {
  return Object.assign(new Error(message), fields, { category, userMessage: message });
}
const file = () => path.join(require('./paths').hubDataDir(), 'source-analysis', 'diagnostics.json');
let pending = Promise.resolve();
function record(entry) {
  // 색인·클라우드 작업이 동시에 끝나도 서로의 진단을 덮어쓰지 않도록 직렬화한다.
  const write = pending.then(async () => {
    const rows = await readJson(file(), []);
    if (!Array.isArray(rows)) throw new Error('Invalid source diagnostics store');
    await writeAtomic(file(), '\uFEFF' + JSON.stringify([...rows, { at: new Date().toISOString(), ...entry }].slice(-200), null, 2));
  });
  pending = write.catch(() => {});
  return write;
}
async function list() {
  await pending;
  const rows = await readJson(file(), []);
  if (!Array.isArray(rows)) throw new Error('Invalid source diagnostics store');
  return rows.slice().reverse();
}
module.exports = { describe, failure, record, list };

'use strict';

function mediaResult(row, result) {
  $('media-' + row + '-id').textContent = result.id || (result.status === 'cancelled' ? '취소됨' : '실패');
  $('media-' + row + '-time').textContent = Number.isFinite(result.elapsedMs) ? result.elapsedMs + ' ms' : '—';
}

$('goto-media-comfy').onclick = () => {
  $('media-panel').open = true;
  hubGo('dashboard', 'local-comfy-workflow');
};
$('media-kind').onchange = () => {
  const clone = $('media-kind').value === 'clone';
  $('media-profile-label').textContent = clone ? '새 프로필 이름' : '음성 프로필 ID';
  $('media-text-label').hidden = clone;
  $('media-authority').value = '';
  $('media-profile').value = '';
};
$('media-discover').onclick = async () => {
  try {
    const found = await call(window.hub.mediaRun, { kind: 'discover' });
    $('media-tools').textContent = found.endpoint + ' · ' + (found.tools.join(', ') || '지원 도구 없음');
  } catch (e) { $('media-tools').textContent = '연결 확인 실패 · ' + e.message; }
};
$('media-voice-run').onclick = async () => {
  const button = $('media-voice-run');
  button.disabled = true;
  const output = $('media-voice-output');
  try {
    const result = await call(window.hub.mediaRun, {
      kind: $('media-kind').value, profile: $('media-profile').value,
      purpose: $('media-purpose').value, text: $('media-text').value, authority: $('media-authority').value,
    });
    mediaResult('voice', result);
    output.textContent = result.status === 'cancelled' ? '취소됨' : (result.audio || '새 프로필 ID · ' + result.id);
  } catch (e) { output.textContent = e.message; mediaResult('voice', { status: 'failed' }); }
  finally { button.disabled = false; $('media-authority').value = ''; }
};

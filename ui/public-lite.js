'use strict';

// The public dashboard reports local state without probing model servers or discovering user accounts.
document.title = 'AI Hub Lite';
document.querySelector('.logo').textContent = 'AI Hub Lite';
const banner = document.createElement('p');
banner.className = 'hint';
banner.style.cssText = 'margin:12px 20px;padding:12px;border:1px solid #343b4b;border-radius:8px';
banner.textContent = '공개 경량판 · 기기 상태, 로컬 메모리와 소스 분석을 사용합니다. 외부 연결·MCP 서버·동기화는 기본으로 꺼져 있습니다.';
document.querySelector('main').before(banner);

for (const id of ['lm-status','hub-status','dash-downstream','auto-enabled','update-status','media-panel']) {
  const element = document.getElementById(id);
  if (element) (element.closest('.card') || element).hidden = true;
}
document.getElementById('vault-secret')?.closest('details')?.setAttribute('hidden','');
for (const id of ['set-repo-update','share-dir']) document.getElementById(id)?.closest('.card')?.setAttribute('hidden','');

const statusCard = document.createElement('div');
statusCard.className = 'card';
const heading = document.createElement('h2');
heading.textContent = '이 기기의 공개 경량판';
const state = document.createElement('p');
state.setAttribute('role','status');
const refresh = document.createElement('button');
refresh.textContent = '상태 새로고침';
const folder = document.createElement('button');
folder.textContent = '이 앱의 데이터 폴더';
let publicDataDir = '';
folder.addEventListener('click', async () => {
  if (publicDataDir) await call(window.hub.openPath, publicDataDir);
});
statusCard.append(heading,state,refresh,folder);
document.getElementById('tab-dashboard').prepend(statusCard);

async function publicDashboard() {
  try {
    const result = await call(window.hub.status);
    publicDataDir = result.dataDir;
    state.textContent = `버전 ${result.version} · 독립 프로필 · MCP ${result.hub.running ? '실행 중' : '꺼짐'} · 자동 공유 꺼짐`;
    await refreshResourceSnapshot();
  } catch (error) { state.textContent = '상태 조회 실패: ' + error.message; }
}
refresh.addEventListener('click',publicDashboard);
window.refreshDashboard = publicDashboard;
window.refreshAutopilot = async () => {};

const connectionCard = document.createElement('div');
connectionCard.className = 'card';
const connectionTitle = document.createElement('h2');
connectionTitle.textContent = '로컬 MCP 연결';
const connectionHelp = document.createElement('p');
connectionHelp.className = 'hint';
connectionHelp.textContent = '원할 때만 이 앱의 별도 로컬 서버를 켭니다. 다른 AI 도구의 설정은 자동으로 읽거나 수정하지 않습니다.';
const connectionLabel = document.createElement('label');
connectionLabel.className = 'row';
const connectionToggle = document.createElement('input');
connectionToggle.type = 'checkbox';
connectionToggle.id = 'public-mcp-enabled';
connectionLabel.append(connectionToggle,document.createTextNode('이 컴퓨터의 MCP 서버 켜기'));
const connectionApply = document.createElement('button');
connectionApply.textContent = '선택 적용';
const connectionState = document.createElement('p');
connectionState.className = 'hint';
connectionState.setAttribute('role','status');
connectionApply.addEventListener('click',async()=>{
  connectionApply.disabled = true;
  try {
    await call(window.hub.configUpdate,{hub:{enabled:connectionToggle.checked,requireAuth:true,lanAccess:false}});
    const result = await call(window.hub.hubRestart);
    connectionState.textContent = result.running ? '로컬 MCP 서버를 켰습니다. 연결 주소와 인증 정보는 이 앱의 허브 설정에서 확인하세요.' : '로컬 MCP 서버를 껐습니다.';
    await publicDashboard();
  } catch(error) { connectionState.textContent = '적용하지 못했습니다: ' + error.message; }
  finally { connectionApply.disabled = false; }
});
call(window.hub.configGet).then(cfg=>{connectionToggle.checked=cfg.hub.enabled===true;}).catch(()=>{});
connectionCard.append(connectionTitle,connectionHelp,connectionLabel,connectionApply,connectionState);
document.getElementById('tab-settings').prepend(connectionCard);

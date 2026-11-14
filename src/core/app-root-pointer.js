// 이 PC에서 Hub가 어디서 실행되는지 기록한다(%APPDATA%\ai-hub\app-root.json).
//
// 왜: Codex 패널 플러그인(ai-hub-panel)은 공유 저장소에서 모든 PC에 같은 내용으로 설치되지만,
// Hub는 PC마다 설치본(%LOCALAPPDATA%\Programs) 또는 소스(Drive 미러)에서 돈다. 플러그인이
// 고정 경로를 가정하면 소스로 실행하는 PC에서 패널이 뜨지 않았다. Hub가 시작할 때 자기
// 위치를 남기면 플러그인은 경로 설정 없이 찾는다. 기기 전용 파일이며 share.js 공유 대상이 아니다.
'use strict';

const fs = require('fs');
const path = require('path');
const { hubDataDir } = require('./paths');

const FILE = 'app-root.json';

function file() { return path.join(hubDataDir(), FILE); }

/** 원자적 기록(임시 파일 → rename). 실패는 앱 동작에 영향을 주지 않는다. */
function record({ appRoot, version, packaged }) {
  const target = file();
  const tmp = `${target}.${process.pid}.tmp`;
  const profileIdentity = require('./profile-identity').current();
  const value = { schemaVersion: 2, appRoot, version, packaged: !!packaged, pid: process.pid,
    recordedAt: new Date().toISOString(), profileIdentity: {
      schemaVersion: profileIdentity.schemaVersion, status: profileIdentity.status,
      ...(profileIdentity.fingerprint ? { fingerprint: profileIdentity.fingerprint } : { reason: 'profile_identity_unavailable' })
    } };
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, target);
    return value;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    return null;
  }
}

/** 기록된 위치가 실제 Hub 앱 루트일 때만 돌려준다. */
function read() {
  try {
    const value = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (value && typeof value.appRoot === 'string' && fs.existsSync(path.join(value.appRoot, 'src', 'mcp', 'harness-panel-bridge.js'))) return value;
  } catch { /* 없음 */ }
  return null;
}

module.exports = { record, read, FILE };

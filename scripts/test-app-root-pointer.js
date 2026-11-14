#!/usr/bin/env node
// Hub 실행 위치 기록(app-root.json): 원자적 기록, 실제 앱 루트만 읽기, 공유 대상 아님.
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-approot-'));
process.env.APPDATA = SANDBOX;
const pointer = require('../src/core/app-root-pointer');
const share = require('../src/core/share');

try {
  const appRoot = path.resolve(__dirname, '..');
  assert.equal(pointer.read(), null);
  const written = pointer.record({ appRoot, version: '1.23.1', packaged: false });
  assert.equal(written.appRoot, appRoot);
  assert.equal(pointer.read().version, '1.23.1');
  // 앱 루트가 아니면 읽지 않는다(플러그인이 엉뚱한 폴더를 require하지 않게).
  pointer.record({ appRoot: SANDBOX, version: 'x', packaged: false });
  assert.equal(pointer.read(), null);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'share.js'), 'utf8');
  assert(!src.includes(pointer.FILE), 'app-root.json must stay device-only');
  assert(typeof share.syncNow === 'function');
  console.log('Passed: atomic app-root record, validated read, device-only (not shared)');
} finally {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
}

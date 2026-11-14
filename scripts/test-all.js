#!/usr/bin/env node
// 전체 테스트 러너.
//
//   node scripts/test-all.js         -- 오프라인 테스트만 (LM Studio 불필요, 빠름)
//   node scripts/test-all.js --all   -- LM Studio가 필요한 통합 테스트까지
//
// 지금까지는 scripts/test-*.js 를 하나씩 손으로 돌려야 해서 리팩터 뒤에
// 뭐가 깨졌는지 알기 어려웠다. 한 번에 돌리고 요약을 낸다.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const appRoot = path.resolve(__dirname, '..');
const runAll = process.argv.includes('--all');

// LM Studio(또는 실제 UE 소스)가 있어야 의미 있는 테스트.
const NEEDS_LMSTUDIO = new Set([
  'test-memory.js',
  'test-shared-memory.js',
  'test-autopilot.js',
  'test-pipeline.js',
  'test-renderpipe.js',
  'test-ue-queries.js',
  'test-index.js',
  'build-ue-index.js',
]);

// 러너 자신과 테스트가 아닌 스크립트.
const NOT_A_TEST = new Set(['test-all.js', 'release.js', 'build-ue-index.js', 'sync-installer.js', 'device-config-metrics.js', 'analyze-hardfaults.js']);

/**
 * 파일이 너무 커지면 책임이 섞였다는 신호다(orca의 max-lines 규칙과 같은 취지).
 * 상한을 올리지 말고 파일을 쪼갤 것. 예외를 두게 되면 왜 두는지 여기 적는다.
 */
const LINE_BUDGET = { default: 700 };

function budgetFor(rel) {
  return LINE_BUDGET[rel.replace(/\\/g, '/')] || LINE_BUDGET.default;
}

function sourceFiles() {
  const out = [];
  for (const dir of ['src', 'electron', 'ui']) {
    const base = path.join(appRoot, dir);
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|cjs)$/.test(e.name)) out.push(path.relative(appRoot, p));
      }
    };
    if (fs.existsSync(base)) walk(base);
  }
  return out;
}

// Every test gets throwaway app-data folders: one test once wrote a fake "completed" model operation into the
// real %APPDATA%, and the live Hub then reported it as a real load.
const isolated = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hub-tests-'));
process.on('exit', () => fs.rmSync(isolated, { recursive: true, force: true }));

function run(script) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [path.join(appRoot, 'scripts', script)], {
    cwd: appRoot,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    env: { ...process.env, APPDATA: path.join(isolated, 'Roaming'), LOCALAPPDATA: path.join(isolated, 'Local') },
  });
  const ms = Date.now() - started;
  const ok = res.status === 0;
  const tail = String(res.stdout || '').trim().split('\n').slice(-1)[0] || '';
  return { script, ok, ms, tail, stderr: String(res.stderr || '').trim() };
}

function main() {
  console.log('=== 파일 크기 점검 (책임이 섞이는 신호) ===');
  let oversize = 0;
  for (const rel of sourceFiles()) {
    const lines = fs.readFileSync(path.join(appRoot, rel), 'utf8').split('\n').length;
    const budget = budgetFor(rel);
    if (lines > budget) {
      console.log(`  ✗ ${rel} — ${lines}줄 (상한 ${budget})`);
      oversize++;
    }
  }
  if (!oversize) console.log('  ✓ 상한을 넘는 파일 없음');

  console.log('');
  console.log('=== 구문 검사 ===');
  let syntaxBad = 0;
  for (const rel of sourceFiles()) {
    const res = spawnSync(process.execPath, ['--check', path.join(appRoot, rel)], { encoding: 'utf8' });
    if (res.status !== 0) {
      console.log(`  ✗ ${rel}\n${res.stderr}`);
      syntaxBad++;
    }
  }
  if (!syntaxBad) console.log(`  ✓ ${sourceFiles().length}개 파일 구문 정상`);

  const scripts = fs.readdirSync(path.join(appRoot, 'scripts'))
    .filter((n) => n.endsWith('.js') && !NOT_A_TEST.has(n))
    .filter((n) => runAll || !NEEDS_LMSTUDIO.has(n))
    .sort();

  console.log('');
  console.log(`=== 테스트 ${scripts.length}개 ${runAll ? '(LM Studio 통합 포함)' : '(오프라인만)'} ===`);
  const results = scripts.map((s) => {
    const r = run(s);
    console.log(`  ${r.ok ? '✓' : '✗'} ${s.padEnd(26)} ${String(r.ms).padStart(6)}ms  ${r.tail}`);
    if (!r.ok && r.stderr) console.log(`      ${r.stderr.split('\n').slice(0, 4).join('\n      ')}`);
    return r;
  });

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`파일크기 위반 ${oversize} · 구문오류 ${syntaxBad} · 테스트 실패 ${failed.length}/${results.length}`);
  if (!runAll) console.log('(LM Studio 통합 테스트는 --all 로 실행)');
  process.exit(oversize + syntaxBad + failed.length === 0 ? 0 : 1);
}

main();
